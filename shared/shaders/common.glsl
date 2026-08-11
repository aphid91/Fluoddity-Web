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
//     Why: a struct with mixed scalar types has a layout that depends on which
//     packing rules are being applied, so the host's idea of the memory and the
//     GPU's can differ. That does not crash -- it silently reinterprets the
//     buffer and the simulation behaves subtly wrong. An all-vec4 struct is
//     16-byte aligned with an unambiguous stride under every rule set, so there
//     is nothing to disagree about. layout.py enforces this and will raise on
//     anything else.
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

// How hard the painted Strafe Field displaces a particle, per physics step.
// FIXED BY DESIGN: Draw Power alone sets how strongly a stroke paints, so
// there is no second multiplier for the user to get lost between. Retuning the
// feel of the whole feature is this one number.
#define STRAFE_FIELD_GAIN 0.01

// ---------------------------------------------------------------------------
// CANVAS VALUE SCALE -- the canvas is RG16F (see CANVAS_DTYPE in
// particle_system.py), and fp16's usable range starts at ~6.1e-5. At high
// Trail Persistence the splat premultiply (1-P)/P shrinks each deposit to
// ~1e-6, which is SUBNORMAL in fp16: blend units flush it and trails starve
// (measured: 40x dimmer at P=0.999). All stored canvas values therefore ride
// 512x above their physical meaning: the splat multiplies by this, every READER
// divides by it. canvas.frag's decay/diffuse is linear and scale-invariant, so
// it neither knows nor cares.
//
// 512 is chosen with both ends in view: it lifts a slow particle's deposit at
// P = 0.999 (~3.6e-6) to ~1.8e-3 -- comfortably normal -- while the largest
// legitimate single splat (fast particle at the P clamp floor) stays around
// 1e4, under fp16's 65504 ceiling. Readers: get_can() in entity_update.glsl,
// camera.frag. Writers: brush.frag.
#define CANVAS_VALUE_SCALE 512.0

// Saturation ceiling for stored (scaled) canvas values, applied by canvas.frag
// on every write. NEEDED BECAUSE OF fp16: a texel pushed past 65504 rounds to
// inf, and inf survives decay forever (inf * P == inf) -- one extreme splat
// pile-up would permanently poison the texel and NaN any particle that senses
// it. Saturating below the ceiling lets even an absurd pile-up decay back down.
// fp32 never needed this; do not remove it while the canvas is fp16.
#define CANVAS_VALUE_MAX 60000.0

// Trail Persistence's legal range inside the shaders. The FLOOR is well below
// the slider (0.5..0.999) and below every known config (observed min 0.312);
// it exists for typed-in extremes. It was 1e-4, but (1-P)/P at 1e-4 is ~1e4,
// which times CANVAS_VALUE_SCALE would overflow fp16 on a single splat --
// 1e-2 caps the premultiply at ~99 and costs nothing anyone uses.
// brush.frag and canvas.frag MUST clamp with the same bounds, or the splat
// premultiply and the decay would disagree about what P means.
#define TRAIL_PERSISTENCE_MIN 1e-2
#define TRAIL_PERSISTENCE_MAX 0.999

// ---------------------------------------------------------------------------
// MODE ENUMS -- the single definition. ui/settings_spec.py mirrors these BY
// VALUE in its DROPDOWN_MODES tuples, so the order of the options there is the
// order here. Change one, change both.
// ---------------------------------------------------------------------------

// What happens when a particle reaches the edge of the world. A WorldData
// setting: the trail field follows the same rule, so it cannot vary per config.
#define BC_BOUNCE 0
#define BC_WRAP   1
#define BC_RESET  2

// How particles are placed on reset. A ConfigData setting: different
// populations can seed differently.
#define IC_GRID   0
#define IC_RANDOM 1
#define IC_CENTER 2
#define IC_RING   3

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
    vec4 misc;      // x: lateral       y: hazard_rate z: cohorts(i)  w: mutation_seed
    // The first four vec4s filled up (misc.w went to mutation_seed), so this is
    // the "add a whole new vec4" case rule 2 describes rather than a reclaimed
    // lane. Two spares here for the next additions.
    vec4 force2;    // x: gravity_force y: gravity_strafe z: initial_conditions(i) w: cohort_fences
    // force2 filled up the same way misc did, so this is another whole new
    // vec4 rather than a reclaimed lane. This one's zw were the last two spares
    // in the struct, and the sensor jitters claimed them -- rule 2's "claim a
    // reserved lane" case. THERE ARE NO SPARE LANES LEFT: the next addition
    // needs a whole new vec4.
    //
    // NAMED FOR BEING AN OVERFLOW LANE, NOT FOR A THEME -- like `misc` and
    // `force2` above it. It was called `appearance` while it held only the two
    // colour settings; the sensor jitters are physics, so that name had become
    // a lie about half its contents. A lane is a place four floats fit, not a
    // category, and pretending otherwise makes the next addition agonize over
    // whether it belongs. Read the per-lane comment, not the name.
    vec4 misc2;  // x: color_sensitivity     y: color_by_cohort(i)
                 // z: sensor_angle_jitter   w: sensor_distance_jitter
    // misc2 had no spares left, so Radial Gravity is rule 2's "add a whole new
    // vec4" case again rather than a reclaimed lane. Three spares here for the
    // next additions.
    vec4 misc3;  // x: radial_gravity(i)     yzw: reserved
};  // 416 bytes

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
// Which random variation the rule mutation uses. Per-config rather than a
// uniform, so different particle populations can mutate differently.
float cfg_mutation_seed(ConfigData c) { return c.misc.w; }

// Uniform pull on the whole population, in the two motion channels the rest of
// the physics uses: _force feeds velocity, _strafe displaces position directly.
// Both are LINEAR -1..1 controls -- run them through gravity_expand() before
// use, never apply them raw.
float cfg_gravity_force(ConfigData c)  { return c.force2.x; }
float cfg_gravity_strafe(ConfigData c) { return c.force2.y; }

// How this population is arranged on reset -- one of the IC_* modes above.
int cfg_initial_conditions(ConfigData c) { return floatBitsToInt(c.force2.z); }
// How tightly each particle is held near its own spawn point. 0 is off, 1 is
// tightest -- see the fence block in entity_update.glsl for the mapping.
float cfg_cohort_fences(ConfigData c) { return c.force2.w; }

// How strongly the brain's colour signal swings the hue. Read by the PARTICLE
// CAMERA, not by the physics -- entity_update only decides what raw signal to
// store, so this can be dragged without disturbing the simulation.
float cfg_color_sensitivity(ConfigData c) { return c.misc2.x; }
// Colour each population flat by its cohort instead of by its brain's output.
// A DISPLAY choice, read by the particle camera -- entity_update transmits both
// signals (col_params.x is the brain, .y the cohort) and picks neither, so this
// takes effect immediately, even while the simulation is paused.
bool cfg_color_by_cohort(ConfigData c) { return floatBitsToInt(c.misc2.y) != 0; }

// Random wobble added to each sensor reading, resampled EVERY PHYSICS STEP --
// a shimmer, not a fixed per-particle trait. Both are 0..1 controls scaled so
// that 1.0 spans the whole range of the parameter they perturb: angle covers
// its own -1..1 slider directly, distance covers SENSOR_DISTANCE_SPAN below.
// Applied in entity_update.glsl; 0 is off.
float cfg_sensor_angle_jitter(ConfigData c)    { return c.misc2.z; }
float cfg_sensor_distance_jitter(ConfigData c) { return c.misc2.w; }

// Which direction the two gravity channels above pull in. False (the default,
// and what every config written before this existed means) is the fixed
// vec2(0,1) screen-down pull; true swings it to the particle's own position
// vector, so positive values fall inwards towards the origin and negative
// values blow outwards. Lives in misc3 rather than beside the gravity values
// because force2 and misc2 were both full -- read the lane comment, not the
// name.
bool cfg_radial_gravity(ConfigData c) { return floatBitsToInt(c.misc3.x) != 0; }

// The width of the Sensor Distance slider (0..5), which is what a distance
// jitter of 1.0 spans. It lives here rather than being read from the slider
// bounds because the shader has no access to those -- MUST MATCH the `hi` of
// the sensor_distance entry in ui/settings_spec.py.
#define SENSOR_DISTANCE_SPAN 5.0

// ---------------------------------------------------------------------------
// WorldData -- settings that are properties of the world, not of a particle.
//
// Set as a uniform, never per-entity. If a setting would be meaningless to
// vary between two particles sharing a canvas (trail decay, world scale), it
// belongs here rather than in ConfigData.
// ---------------------------------------------------------------------------
struct WorldData {
    vec4 trail;  // x: persistence  y: diffusion  z: sqrt_world_size  w: config_count(i)
    // trail filled up, so this is rule 2's "add a whole new vec4" case.
    vec4 bounds; // x: boundary_conditions(i)   yzw: reserved
};

float world_trail_persistence(WorldData w) { return w.trail.x; }
float world_trail_diffusion(WorldData w)   { return w.trail.y; }
float world_sqrt_world_size(WorldData w)   { return w.trail.z; }
int   world_config_count(WorldData w)      { return floatBitsToInt(w.trail.w); }

// What happens at the edge of the world -- one of the BC_* modes above. A
// world property rather than a per-config one: the trail field has to obey the
// same boundary as the particles do, and there is only one trail field.
int world_boundary_conditions(WorldData w) { return floatBitsToInt(w.bounds.x); }

// ---------------------------------------------------------------------------
// Entity -- one particle. 32 bytes, 16-byte aligned.
//
// Lives in EntityBuffer (binding 0). Mirrored by no one: every shader that
// touches entities includes this file.
// ---------------------------------------------------------------------------
struct Entity {
    vec4 pos_vel;  // xy: pos    zw: vel
    vec4 misc;     // x: size    y: config_index(i)    zw: col_params
};

vec2  e_pos(Entity e)          { return e.pos_vel.xy; }
vec2  e_vel(Entity e)          { return e.pos_vel.zw; }
float e_size(Entity e)         { return e.misc.x; }
int   e_config_index(Entity e) { return floatBitsToInt(e.misc.y); }

// RAW OUTPUT FROM THE PARTICLE'S BRAIN, kept for rendering rather than physics.
// entity_update writes these; the particle camera turns them into a hue.
//
// .x is a raw force term from the black box -- deliberately arbitrary, tuned by
// eye, so nothing downstream should read meaning into its scale.
// .y is the particle's COHORT INDEX, which cam_brush.frag reads when Color By
// Cohort is on (see the mode switch at its line 63).
//
// The RENDERER decides what these look like. Storing the raw signals instead of
// a finished hue is what lets Color Sensitivity be dragged without re-running
// the simulation, which is where the reference put it.
vec2 e_col_params(Entity e) { return e.misc.zw; }

Entity make_entity(vec2 pos, vec2 vel, float size, int config_index,
                   vec2 col_params) {
    return Entity(vec4(pos, vel),
                  vec4(size, intBitsToFloat(config_index), col_params));
}

// Same, for the paths that have no colour signal to offer -- reset() runs
// before any behaviour is computed. Zero is a valid hue, so this is not a
// sentinel; the entity simply gets its colour on the next real step.
Entity make_entity(vec2 pos, vec2 vel, float size, int config_index) {
    return make_entity(pos, vel, size, config_index, vec2(0.0));
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
//
// THE WORLD IS A TORUS ONLY IN BC_WRAP. The boundary mode decides the world's
// topology, so anything that crosses an edge must ask: world_wrap for wrap,
// world_bounce for bounce, and world_to_uv_bc for every texture read.
// ---------------------------------------------------------------------------

// Half-extent of world space on each axis, from canvas aspect ca = res.x/res.y.
vec2 world_half_extent(float ca) {
    float s = sqrt(ca);
    return vec2(s, 1.0 / s);
}

vec2 world_half_extent_from_res(vec2 canvas_res) {
    return world_half_extent(canvas_res.x / canvas_res.y);
}

// Scale a uv-space delta into the aspect-corrected metric -- literally
// world_half_extent applied as a scale, which is why it lives here rather than
// being its own piece of aspect math. World space is area-preserving, so a raw
// uv delta is anisotropic on a non-square canvas; brushes measured in this
// metric stay circular, and a ring drawn in it matches the brush that paints
// in it. Used by strafe_draw.frag (painting) and frame_assembly.frag (the
// reticle that must agree with it).
vec2 aspect_correct_uv(vec2 d, vec2 canvas_res) {
    return d * world_half_extent_from_res(canvas_res);
}

// World -> texture uv [0,1]. In BC_WRAP the canvas textures are set to repeat
// and the sampler does the wrapping, so uv is deliberately left unclamped.
// Every other boundary mode must go through world_to_uv_bc below.
vec2 world_to_uv(vec2 p, vec2 canvas_res) {
    return p / (2.0 * world_half_extent_from_res(canvas_res)) + 0.5;
}

// World -> texture uv, honoring the boundary mode. Only BC_WRAP leaves uv free
// for the sampler's repeat to handle; the others clamp, so a sensor reaching
// past the edge reads the edge rather than the far side of the world.
vec2 world_to_uv_bc(vec2 p, vec2 canvas_res, int bc) {
    vec2 uv = world_to_uv(p, canvas_res);
    return bc == BC_WRAP ? uv : clamp(uv, 0.0, 1.0);
}

vec2 uv_to_world(vec2 uv, vec2 canvas_res) {
    return (uv - 0.5) * 2.0 * world_half_extent_from_res(canvas_res);
}

// World -> normalized device coords [-1,1] for rasterizing into the canvas.
vec2 world_to_ndc(vec2 p, vec2 canvas_res) {
    return p / world_half_extent_from_res(canvas_res);
}

// Wrap a world position into the world bounds. BC_WRAP only -- the world is a
// torus in that mode alone.
vec2 world_wrap(vec2 p, vec2 canvas_res) {
    vec2 extent = world_half_extent_from_res(canvas_res);
    vec2 size = 2.0 * extent;
    return size * (fract(p / size - 0.5) - 0.5);
}

// Reflect a coordinate given in edge units back into [-1,1]. A triangle wave,
// so it is correct for ARBITRARY overshoot. The reference's single-fold version
// (sign(x)*(1-abs(1-abs(x)))) silently teleported a particle to the far side
// once it passed 2x the edge in one step, which heavy gravity reaches.
float edge_fold(float x) {
    float t = mod(abs(x), 2.0);
    return sign(x) * (1.0 - abs(1.0 - t));
}

// Reflect a position off the world bounds, flipping the velocity components
// that crossed. Position and velocity move together: reflecting the position
// without reversing the velocity would just re-trigger the bounce every frame,
// pinning the particle to the wall.
void world_bounce(inout vec2 p, inout vec2 v, vec2 canvas_res) {
    vec2 extent = world_half_extent_from_res(canvas_res);
    if (abs(p.x) > extent.x) v.x = -v.x;
    if (abs(p.y) > extent.y) v.y = -v.y;
    p = vec2(edge_fold(p.x / extent.x), edge_fold(p.y / extent.y)) * extent;
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
