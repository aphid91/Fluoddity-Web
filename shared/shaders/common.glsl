// ============================================================================
// common.glsl -- shared struct definitions and coordinate math.
//
// THIS FILE IS THE SINGLE SOURCE OF TRUTH FOR GPU STRUCT LAYOUT.
// particle_system/layout.py parses the struct declarations below to build the
// numpy dtypes used to pack these buffers on the host. Edit a struct here and
// the host packing follows automatically -- there is no second copy to update.
//
// RULES FOR EDITING THIS FILE:
//
//  1. vec4-ONLY. Every member of every struct must be a vec4, a fixed-size
//     array of vec4, or another struct that obeys this rule. No bare float,
//     no int, no vec2/vec3. Scalars ride in vec4 lanes; ints ride in float
//     lanes via intBitsToFloat/floatBitsToInt.
//
//     Why: std430 (GLSL) and WGSL (WebGPU) do NOT agree on how to lay out
//     structs with mixed scalar types. An all-vec4 struct is 16-byte aligned
//     with an unambiguous stride in both, so this codebase translates to
//     WebGPU without a layout audit. layout.py enforces this and will raise
//     on anything else.
//
//  2. ADD A FIELD BY CLAIMING A RESERVED LANE, not by appending a scalar.
//     When the reserved lanes run out, add a whole new vec4.
//
//  3. NO uniforms and NO buffer/binding declarations in this file -- types and
//     pure functions only. Bindings belong to the shader that owns them.
//     (Binding assignments are recorded in the table below for coordination.)
//
//  4. NO #version line here; the including shader owns that.
//
// SSBO BINDING ASSIGNMENTS (project-wide, keep in sync):
//     binding = 0   EntityBuffer
//     binding = 1   ConfigBuffer
// ============================================================================

#define PI 3.1415926

// ---------------------------------------------------------------------------
// Rule -- the Fourier Feature Network coefficients that define particle behavior
// ---------------------------------------------------------------------------

// 4D input -> 4D output basis element.
struct FourierCenter {
    vec4 frequency;
    vec4 amplitude;
};

// 10 FourierCenters makes a Rule. 320 bytes, all vec4.
struct Rule {
    FourierCenter centers[10];
};

// ---------------------------------------------------------------------------
// ConfigData -- everything a particle needs to know about how to behave.
//
// This unifies what used to be two separate systems: the Rule (behavior) and
// the physics parameters. They live together now because they are the same
// kind of thing -- per-particle-population settings -- and separating them is
// what made the reference implementation's parameter handling sprawl.
//
// Lives in ConfigBuffer (binding 1). Each entity selects its ConfigData via
// its own config_index, so different particles can obey different configs.
// ---------------------------------------------------------------------------
struct ConfigData {
    Rule rule;      // 320 B -- behavior coefficients
    vec4 sensor;    // x: gain          y: angle       z: distance    w: mutation_scale
    vec4 force;     // x: global_mult   y: drag        z: strafe      w: axial
    vec4 misc;      // x: lateral       y: hazard_rate z: cohorts(i)  w: reserved
};  // 368 bytes

float cfg_sensor_gain(ConfigData c)     { return c.sensor.x; }
float cfg_sensor_angle(ConfigData c)    { return c.sensor.y; }
float cfg_sensor_distance(ConfigData c) { return c.sensor.z; }
float cfg_mutation_scale(ConfigData c)  { return c.sensor.w; }

float cfg_global_force_mult(ConfigData c) { return c.force.x; }
float cfg_drag(ConfigData c)              { return c.force.y; }
float cfg_strafe_power(ConfigData c)      { return c.force.z; }
float cfg_axial_force(ConfigData c)       { return c.force.w; }

float cfg_lateral_force(ConfigData c) { return c.misc.x; }
float cfg_hazard_rate(ConfigData c)   { return c.misc.y; }
int   cfg_cohorts(ConfigData c)       { return floatBitsToInt(c.misc.z); }

// ---------------------------------------------------------------------------
// WorldData -- settings that are properties of the world, not of a particle.
//
// Set as a uniform, never per-entity. If a setting would be meaningless to
// vary between two particles sharing a canvas (trail decay, world scale), it
// belongs here rather than in ConfigData.
// ---------------------------------------------------------------------------
struct WorldData {
    vec4 trail;  // x: persistence  y: diffusion  z: sqrt_world_size  w: config_count(i)
};

float world_trail_persistence(WorldData w) { return w.trail.x; }
float world_trail_diffusion(WorldData w)   { return w.trail.y; }
float world_sqrt_world_size(WorldData w)   { return w.trail.z; }
int   world_config_count(WorldData w)      { return floatBitsToInt(w.trail.w); }

// ---------------------------------------------------------------------------
// Entity -- one particle. 32 bytes, 16-byte aligned.
//
// Lives in EntityBuffer (binding 0). Mirrored by no one: every shader that
// touches entities includes this file.
// ---------------------------------------------------------------------------
struct Entity {
    vec4 pos_vel;  // xy: pos    zw: vel
    vec4 misc;     // x: size    y: config_index(i)    zw: reserved (color/hue)
};

vec2  e_pos(Entity e)          { return e.pos_vel.xy; }
vec2  e_vel(Entity e)          { return e.pos_vel.zw; }
float e_size(Entity e)         { return e.misc.x; }
int   e_config_index(Entity e) { return floatBitsToInt(e.misc.y); }

Entity make_entity(vec2 pos, vec2 vel, float size, int config_index) {
    return Entity(vec4(pos, vel), vec4(size, intBitsToFloat(config_index), 0.0, 0.0));
}

// ---------------------------------------------------------------------------
// COORDINATE CONVENTION -- the one canonical implementation.
//
// World space is AREA-PRESERVING. With ca = canvas_res.x / canvas_res.y:
//
//     world = [-sqrt(ca), +sqrt(ca)]  x  [-1/sqrt(ca), +1/sqrt(ca)]
//
// so the world always has area 4 regardless of canvas aspect, and a circle in
// world space stays a circle on screen. On a square canvas ca == 1 and this
// reduces exactly to the familiar [-1,1] x [-1,1].
//
// NO OTHER FILE MAY WRITE ASPECT-RATIO MATH. Every world<->uv<->ndc
// conversion goes through the functions below (and their Python mirrors in
// particle_system/coords.py). The reference implementation had six divergent
// copies of this math, at least one of which contradicted the others; that is
// the specific failure this rule exists to prevent.
// ---------------------------------------------------------------------------

// Half-extent of world space on each axis, from canvas aspect ca = res.x/res.y.
vec2 world_half_extent(float ca) {
    float s = sqrt(ca);
    return vec2(s, 1.0 / s);
}

vec2 world_half_extent_from_res(vec2 canvas_res) {
    return world_half_extent(canvas_res.x / canvas_res.y);
}

// World -> texture uv [0,1]. The canvas wraps, so uv is expected to be fract'd
// by the sampler (textures are set to repeat).
vec2 world_to_uv(vec2 p, vec2 canvas_res) {
    return p / (2.0 * world_half_extent_from_res(canvas_res)) + 0.5;
}

vec2 uv_to_world(vec2 uv, vec2 canvas_res) {
    return (uv - 0.5) * 2.0 * world_half_extent_from_res(canvas_res);
}

// World -> normalized device coords [-1,1] for rasterizing into the canvas.
vec2 world_to_ndc(vec2 p, vec2 canvas_res) {
    return p / world_half_extent_from_res(canvas_res);
}

// Wrap a world position into the toroidal world bounds.
vec2 world_wrap(vec2 p, vec2 canvas_res) {
    vec2 extent = world_half_extent_from_res(canvas_res);
    vec2 size = 2.0 * extent;
    return size * (fract(p / size - 0.5) - 0.5);
}

// Shortest offset from a to b across the wrap. The world is a torus, so a
// particle just past the right edge is adjacent to one at the left edge --
// straight-line distance would call them maximally far apart.
vec2 world_delta(vec2 a, vec2 b, vec2 canvas_res) {
    return world_wrap(b - a, canvas_res);
}

// Squared toroidal distance. Squared because callers compare distances, and
// skipping the sqrt in an inner loop over every entity is worth it.
float world_dist_sq(vec2 a, vec2 b, vec2 canvas_res) {
    vec2 d = world_delta(a, b, canvas_res);
    return dot(d, d);
}

// ---------------------------------------------------------------------------
// THE VIEW TRANSFORM -- world to screen, through camera and letterbox.
//
//     world  --/half_extent-->  canvas ndc
//            --(-pan, *zoom)->  view ndc
//            --*letterbox---->  screen ndc [-1,1]
//
// THREE INDEPENDENT ASPECT QUANTITIES, never conflate them:
//   canvas_res  simulation texture size; defines world space
//   window_res  framebuffer size in pixels; changes on resize
//   letterbox   derived fit of one into the other; never stored
//
// ZOOM: bigger = zoomed IN (a magnification factor). zoom=1 fits the world.
// PAN:  world units. pan is the world point at the center of the view.
// ---------------------------------------------------------------------------

// Scale fitting the canvas box into the window, preserving shape. The axis
// that would overflow shrinks; the other stays 1.0, and the slack is the
// letterbox bar. Fit, not fill: the whole canvas is always visible.
vec2 letterbox_scale(vec2 canvas_res, vec2 window_res) {
    if (window_res.x <= 0.0 || window_res.y <= 0.0) return vec2(1.0);
    float canvas_aspect = canvas_res.x / canvas_res.y;
    float window_aspect = window_res.x / window_res.y;
    return window_aspect > canvas_aspect
        ? vec2(canvas_aspect / window_aspect, 1.0)   // bars left/right
        : vec2(1.0, window_aspect / canvas_aspect);  // bars top/bottom
}

vec2 world_to_screen_ndc(vec2 p, vec2 canvas_res, vec2 window_res,
                         vec2 pan, float zoom) {
    vec2 ndc = world_to_ndc(p - pan, canvas_res) * zoom;
    return ndc * letterbox_scale(canvas_res, window_res);
}

vec2 screen_ndc_to_world(vec2 ndc, vec2 canvas_res, vec2 window_res,
                         vec2 pan, float zoom) {
    vec2 v = ndc / letterbox_scale(canvas_res, window_res);
    if (zoom != 0.0) v /= zoom;
    return uv_to_world(v * 0.5 + 0.5, canvas_res) + pan;
}

// Screen ndc -> canvas uv, for the present pass sampling the canvas texture.
// Values outside [0,1] fall in the letterbox bars; the caller decides whether
// to clamp, wrap (tiling) or paint them black.
vec2 screen_ndc_to_canvas_uv(vec2 ndc, vec2 canvas_res, vec2 window_res,
                             vec2 pan, float zoom) {
    return world_to_uv(
        screen_ndc_to_world(ndc, canvas_res, window_res, pan, zoom),
        canvas_res);
}
