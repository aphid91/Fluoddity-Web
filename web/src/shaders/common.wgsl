// ============================================================================
// common.wgsl -- shared struct definitions and coordinate math.
//
// The WGSL translation of `shared/shaders/common.glsl`. Structure, order and
// comments follow that file deliberately, so the two stay diff-comparable and
// so a `common.glsl:NNN` reference in any comment still lands near the right
// place.
//
// THIS FILE IS THE SINGLE SOURCE OF TRUTH FOR GPU STRUCT LAYOUT ON THE WEB.
// Its desktop counterpart is parsed by particle_system/layout.py to build the
// numpy dtypes used to pack these buffers on the host; the port pre-generates
// that answer into `src/particleSystem/layout.generated.json` at build time.
//
// SO THE LAYOUT IS NOW HAND-AUTHORED IN TWO PLACES -- here and in common.glsl,
// which is what the descriptor is generated from. `common.wgsl.test.ts` checks
// the struct declarations below against that descriptor on every `npm test`.
// It is the shader-side counterpart of `assertLaneMap`, which guards host
// packing against the same descriptor; together they close the loop. If that
// test fails, the two files have diverged and the GPU is reinterpreting memory
// that the host packed to a different plan -- which does not crash, it just
// makes the simulation subtly wrong.
//
// RULES FOR EDITING THIS FILE:
//
//  1. vec4-ONLY. Every member of every struct must be a vec4f, a fixed-size
//     array of vec4f, or another struct that obeys this rule. No bare f32,
//     no i32, no vec2f/vec3f. Scalars ride in vec4 lanes; ints ride in float
//     lanes via bitcast.
//
//     Why: std430 (GLSL) and WGSL do NOT agree on how to lay out structs with
//     mixed scalar types. An all-vec4 struct is 16-byte aligned with an
//     unambiguous stride in both, so this codebase translates between them
//     without a layout audit. Both layout.py and common.wgsl.test.ts enforce
//     this and will fail on anything else.
//
//  2. ADD A FIELD BY CLAIMING A RESERVED LANE, not by appending a scalar.
//     When the reserved lanes run out, add a whole new vec4.
//
//  3. NO uniforms and NO buffer/binding declarations in this file -- types and
//     pure functions only. Bindings belong to the shader that owns them.
//     (Binding assignments are recorded in the table below for coordination.)
//
//     This rule is MORE load-bearing on the web than on the desktop. GLSL
//     drivers strip unused uniforms and moderngl's tryset() tolerates the
//     result; WebGPU validates against an explicit bind group layout, so a
//     uniform declared here but unused by an including shader is a hard
//     pipeline-creation error rather than a warning.
//
//  4. NO `#version` line here (WGSL has none) and no entry points. This file is
//     included into compute, vertex AND fragment modules, so it must stay
//     stage-agnostic: no texture sampling, no discard, no derivatives
//     (fwidth/dpdx). It currently has none of those -- keep it that way.
//
// SSBO BINDING ASSIGNMENTS (project-wide, keep in sync):
//     binding = 0   EntityBuffer
//     binding = 1   ConfigBuffer
// ============================================================================

const PI: f32 = 3.1415926;

// How hard the painted Strafe Field displaces a particle, per physics step.
// FIXED BY DESIGN: Draw Power alone sets how strongly a stroke paints, so
// there is no second multiplier for the user to get lost between. Retuning the
// feel of the whole feature is this one number.
const STRAFE_FIELD_GAIN: f32 = 0.01;

// ---------------------------------------------------------------------------
// CANVAS VALUE SCALE -- the canvas is RG16F (see CANVAS_DTYPE in
// particle_system.py), and fp16's usable range starts at ~6.1e-5. At high
// Trail Persistence the splat premultiply (1-P)/P shrinks each deposit to
// ~1e-6, which is SUBNORMAL in fp16: blend units flush it and trails starve
// (measured: 40x dimmer at P=0.999). All stored canvas values therefore ride
// 512x above their physical meaning: the splat multiplies by this, every READER
// divides by it. canvas decay/diffuse is linear and scale-invariant, so it
// neither knows nor cares.
//
// 512 is chosen with both ends in view: it lifts a slow particle's deposit at
// P = 0.999 (~3.6e-6) to ~1.8e-3 -- comfortably normal -- while the largest
// legitimate single splat (fast particle at the P clamp floor) stays around
// 1e4, under fp16's 65504 ceiling. Readers: get_can() in entity_update,
// camera. Writers: brush.
const CANVAS_VALUE_SCALE: f32 = 512.0;

// Saturation ceiling for stored (scaled) canvas values, applied by the canvas
// pass on every write. NEEDED BECAUSE OF fp16: a texel pushed past 65504 rounds
// to inf, and inf survives decay forever (inf * P == inf) -- one extreme splat
// pile-up would permanently poison the texel and NaN any particle that senses
// it. Saturating below the ceiling lets even an absurd pile-up decay back down.
// fp32 never needed this; do not remove it while the canvas is fp16.
const CANVAS_VALUE_MAX: f32 = 60000.0;

// Trail Persistence's legal range inside the shaders. The FLOOR is well below
// the slider (0.5..0.999) and below every known config (observed min 0.312);
// it exists for typed-in extremes. It was 1e-4, but (1-P)/P at 1e-4 is ~1e4,
// which times CANVAS_VALUE_SCALE would overflow fp16 on a single splat --
// 1e-2 caps the premultiply at ~99 and costs nothing anyone uses.
// The brush and canvas passes MUST clamp with the same bounds, or the splat
// premultiply and the decay would disagree about what P means.
const TRAIL_PERSISTENCE_MIN: f32 = 1e-2;
const TRAIL_PERSISTENCE_MAX: f32 = 0.999;

// ---------------------------------------------------------------------------
// MODE ENUMS -- the single definition. ui/settings_spec.py mirrors these BY
// VALUE in its DROPDOWN_MODES tuples, so the order of the options there is the
// order here. Change one, change both.
// ---------------------------------------------------------------------------

// What happens when a particle reaches the edge of the world. A WorldData
// setting: the trail field follows the same rule, so it cannot vary per config.
const BC_BOUNCE: i32 = 0;
const BC_WRAP: i32 = 1;
const BC_RESET: i32 = 2;

// How particles are placed on reset. A ConfigData setting: different
// populations can seed differently.
const IC_GRID: i32 = 0;
const IC_RANDOM: i32 = 1;
// No shader compares against IC_CENTER -- it is the fall-through `else` branch
// of initial_position() in entity_update. It stays defined because it is a real
// mode, mirrored by value in ui/settings_spec.py's dropdown. Do not drop it as
// dead code.
const IC_CENTER: i32 = 2;
const IC_RING: i32 = 3;

// ---------------------------------------------------------------------------
// Rule -- the Fourier Feature Network coefficients that define particle behavior
// ---------------------------------------------------------------------------

// 4D input -> 4D output basis element.
struct FourierCenter {
    frequency: vec4f,
    amplitude: vec4f,
}

// 10 FourierCenters makes a Rule. 320 bytes, all vec4.
//
// This is the only array in the layout, and it is the case that usually bites:
// std430's array-of-struct stride here is 32 bytes, and WGSL's
// array<FourierCenter,10> stride is also 32 (alignment 16, size 32 -- already a
// multiple). No stride divergence. common.wgsl.test.ts asserts it rather than
// trusting this comment.
struct Rule {
    centers: array<FourierCenter, 10>,
}

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
    rule: Rule,      // 320 B -- behavior coefficients
    sensor: vec4f,   // x: gain          y: angle       z: distance    w: mutation_scale
    force: vec4f,    // x: global_mult   y: drag        z: strafe      w: axial
    misc: vec4f,     // x: lateral       y: hazard_rate z: cohorts(i)  w: mutation_seed
    // The first four vec4s filled up (misc.w went to mutation_seed), so this is
    // the "add a whole new vec4" case rule 2 describes rather than a reclaimed
    // lane. Two spares here for the next additions.
    force2: vec4f,   // x: gravity_force y: gravity_strafe z: initial_conditions(i) w: cohort_fences
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
    misc2: vec4f,  // x: color_sensitivity     y: color_by_cohort(i)
                   // z: sensor_angle_jitter   w: sensor_distance_jitter
    // misc2 had no spares left, so Radial Gravity is rule 2's "add a whole new
    // vec4" case again rather than a reclaimed lane. Three spares here for the
    // next additions.
    misc3: vec4f,  // x: radial_gravity(i)     yzw: reserved
}  // 416 bytes

fn cfg_sensor_gain(c: ConfigData) -> f32     { return c.sensor.x; }
fn cfg_sensor_angle(c: ConfigData) -> f32    { return c.sensor.y; }
fn cfg_sensor_distance(c: ConfigData) -> f32 { return c.sensor.z; }
fn cfg_mutation_scale(c: ConfigData) -> f32  { return c.sensor.w; }

fn cfg_global_force_mult(c: ConfigData) -> f32 { return c.force.x; }
fn cfg_drag(c: ConfigData) -> f32              { return c.force.y; }
fn cfg_strafe_power(c: ConfigData) -> f32      { return c.force.z; }
fn cfg_axial_force(c: ConfigData) -> f32       { return c.force.w; }

fn cfg_lateral_force(c: ConfigData) -> f32 { return c.misc.x; }
fn cfg_hazard_rate(c: ConfigData) -> f32   { return c.misc.y; }
fn cfg_cohorts(c: ConfigData) -> i32       { return bitcast<i32>(c.misc.z); }
// Which random variation the rule mutation uses. Per-config rather than a
// uniform, so different particle populations can mutate differently.
fn cfg_mutation_seed(c: ConfigData) -> f32 { return c.misc.w; }

// Uniform pull on the whole population, in the two motion channels the rest of
// the physics uses: _force feeds velocity, _strafe displaces position directly.
// Both are LINEAR -1..1 controls -- run them through gravity_expand() before
// use, never apply them raw.
fn cfg_gravity_force(c: ConfigData) -> f32  { return c.force2.x; }
fn cfg_gravity_strafe(c: ConfigData) -> f32 { return c.force2.y; }

// How this population is arranged on reset -- one of the IC_* modes above.
fn cfg_initial_conditions(c: ConfigData) -> i32 { return bitcast<i32>(c.force2.z); }
// How tightly each particle is held near its own spawn point. 0 is off, 1 is
// tightest -- see the fence block in entity_update for the mapping.
fn cfg_cohort_fences(c: ConfigData) -> f32 { return c.force2.w; }

// How strongly the brain's colour signal swings the hue. Read by the PARTICLE
// CAMERA, not by the physics -- entity_update only decides what raw signal to
// store, so this can be dragged without disturbing the simulation.
//
// NO SHADER CALLS THIS. The camera does not read the config buffer (rule 3);
// the value reaches cam_brush as a loose uniform instead. This accessor is the
// record of which lane holds it -- keep it.
fn cfg_color_sensitivity(c: ConfigData) -> f32 { return c.misc2.x; }
// Colour each population flat by its cohort instead of by its brain's output.
// A DISPLAY choice, read by the particle camera -- entity_update transmits both
// signals (col_params.x is the brain, .y the cohort) and picks neither, so this
// takes effect immediately, even while the simulation is paused.
//
// Also uncalled by any shader, for the same reason as cfg_color_sensitivity.
fn cfg_color_by_cohort(c: ConfigData) -> bool { return bitcast<i32>(c.misc2.y) != 0; }

// Random wobble added to each sensor reading, resampled EVERY PHYSICS STEP --
// a shimmer, not a fixed per-particle trait. Both are 0..1 controls scaled so
// that 1.0 spans the whole range of the parameter they perturb: angle covers
// its own -1..1 slider directly, distance covers SENSOR_DISTANCE_SPAN below.
// Applied in entity_update; 0 is off.
fn cfg_sensor_angle_jitter(c: ConfigData) -> f32    { return c.misc2.z; }
fn cfg_sensor_distance_jitter(c: ConfigData) -> f32 { return c.misc2.w; }

// Which direction the two gravity channels above pull in. False (the default,
// and what every config written before this existed means) is the fixed
// vec2(0,1) screen-down pull; true swings it to the particle's own position
// vector, so positive values fall inwards towards the origin and negative
// values blow outwards. Lives in misc3 rather than beside the gravity values
// because force2 and misc2 were both full -- read the lane comment, not the
// name.
fn cfg_radial_gravity(c: ConfigData) -> bool { return bitcast<i32>(c.misc3.x) != 0; }

// The width of the Sensor Distance slider (0..5), which is what a distance
// jitter of 1.0 spans. It lives here rather than being read from the slider
// bounds because the shader has no access to those -- MUST MATCH the `hi` of
// the sensor_distance entry in ui/settings_spec.py.
const SENSOR_DISTANCE_SPAN: f32 = 5.0;

// ---------------------------------------------------------------------------
// WorldData -- settings that are properties of the world, not of a particle.
//
// Set as a uniform, never per-entity. If a setting would be meaningless to
// vary between two particles sharing a canvas (trail decay, world scale), it
// belongs here rather than in ConfigData.
// ---------------------------------------------------------------------------
struct WorldData {
    trail: vec4f,  // x: persistence  y: diffusion  z: sqrt_world_size  w: config_count(i)
    // trail filled up, so this is rule 2's "add a whole new vec4" case.
    bounds: vec4f, // x: boundary_conditions(i)   yzw: reserved
}

fn world_trail_persistence(w: WorldData) -> f32 { return w.trail.x; }
fn world_trail_diffusion(w: WorldData) -> f32   { return w.trail.y; }
fn world_sqrt_world_size(w: WorldData) -> f32   { return w.trail.z; }
fn world_config_count(w: WorldData) -> i32      { return bitcast<i32>(w.trail.w); }

// What happens at the edge of the world -- one of the BC_* modes above. A
// world property rather than a per-config one: the trail field has to obey the
// same boundary as the particles do, and there is only one trail field.
fn world_boundary_conditions(w: WorldData) -> i32 { return bitcast<i32>(w.bounds.x); }

// ---------------------------------------------------------------------------
// Entity -- one particle. 32 bytes, 16-byte aligned.
//
// Lives in EntityBuffer (binding 0). Mirrored by no one: every shader that
// touches entities includes this file.
// ---------------------------------------------------------------------------
struct Entity {
    pos_vel: vec4f,  // xy: pos    zw: vel
    misc: vec4f,     // x: size    y: config_index(i)    zw: col_params
}

fn e_pos(e: Entity) -> vec2f          { return e.pos_vel.xy; }
fn e_vel(e: Entity) -> vec2f          { return e.pos_vel.zw; }
fn e_size(e: Entity) -> f32           { return e.misc.x; }
fn e_config_index(e: Entity) -> i32   { return bitcast<i32>(e.misc.y); }

// RAW OUTPUT FROM THE PARTICLE'S BRAIN, kept for rendering rather than physics.
// entity_update writes these; the particle camera turns them into a hue.
//
// .x is a raw force term from the black box -- deliberately arbitrary, tuned by
// eye, so nothing downstream should read meaning into its scale.
// .y is the particle's COHORT INDEX, which cam_brush reads when Color By
// Cohort is on.
//
// The RENDERER decides what these look like. Storing the raw signals instead of
// a finished hue is what lets Color Sensitivity be dragged without re-running
// the simulation, which is where the reference put it.
fn e_col_params(e: Entity) -> vec2f { return e.misc.zw; }

fn make_entity(pos: vec2f, vel: vec2f, size: f32, config_index: i32,
               col_params: vec2f) -> Entity {
    return Entity(vec4f(pos, vel),
                  vec4f(size, bitcast<f32>(config_index), col_params));
}

// Same, for the paths that have no colour signal to offer -- reset() runs
// before any behaviour is computed. Zero is a valid hue, so this is not a
// sentinel; the entity simply gets its colour on the next real step.
//
// RENAMED from the GLSL, which overloads `make_entity` on arity -- WGSL has no
// function overloading. The delegation is kept: this is the 5-arg form with a
// zero colour, not a second implementation.
fn make_entity_reset(pos: vec2f, vel: vec2f, size: f32,
                     config_index: i32) -> Entity {
    return make_entity(pos, vel, size, config_index, vec2f(0.0));
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
// conversion goes through the functions below (and their TypeScript mirrors in
// src/particleSystem/coords.ts). The reference implementation had six divergent
// copies of this math, at least one of which contradicted the others; that is
// the specific failure this rule exists to prevent.
//
// THE WORLD IS A TORUS ONLY IN BC_WRAP. The boundary mode decides the world's
// topology, so anything that crosses an edge must ask: world_wrap for wrap,
// world_bounce for bounce, and world_to_uv_bc for every texture read.
//
// SEVERAL FUNCTIONS BELOW HAVE NO EXTERNAL CALLER. world_half_extent,
// world_to_uv, uv_to_world, edge_fold, letterbox_scale and screen_ndc_to_world
// are each an internal composition step of one that does. They are load-bearing,
// not dead. WGSL does not warn about unused module-scope functions.
// ---------------------------------------------------------------------------

// Half-extent of world space on each axis, from canvas aspect ca = res.x/res.y.
fn world_half_extent(ca: f32) -> vec2f {
    let s = sqrt(ca);
    return vec2f(s, 1.0 / s);
}

fn world_half_extent_from_res(canvas_res: vec2f) -> vec2f {
    return world_half_extent(canvas_res.x / canvas_res.y);
}

// Scale a uv-space delta into the aspect-corrected metric -- literally
// world_half_extent applied as a scale, which is why it lives here rather than
// being its own piece of aspect math. World space is area-preserving, so a raw
// uv delta is anisotropic on a non-square canvas; brushes measured in this
// metric stay circular, and a ring drawn in it matches the brush that paints
// in it. Used by strafe_draw (painting) and frame_assembly (the reticle that
// must agree with it).
fn aspect_correct_uv(d: vec2f, canvas_res: vec2f) -> vec2f {
    return d * world_half_extent_from_res(canvas_res);
}

// World -> texture uv [0,1]. In BC_WRAP the canvas textures are sampled with a
// repeating sampler and the sampler does the wrapping, so uv is deliberately
// left unclamped. Every other boundary mode must go through world_to_uv_bc.
fn world_to_uv(p: vec2f, canvas_res: vec2f) -> vec2f {
    return p / (2.0 * world_half_extent_from_res(canvas_res)) + 0.5;
}

// World -> texture uv, honoring the boundary mode. Only BC_WRAP leaves uv free
// for the sampler's repeat to handle; the others clamp, so a sensor reaching
// past the edge reads the edge rather than the far side of the world.
fn world_to_uv_bc(p: vec2f, canvas_res: vec2f, bc: i32) -> vec2f {
    let uv = world_to_uv(p, canvas_res);
    // select(false_value, true_value, condition) -- the argument order is the
    // reverse of GLSL's `cond ? a : b`.
    return select(clamp(uv, vec2f(0.0), vec2f(1.0)), uv, bc == BC_WRAP);
}

fn uv_to_world(uv: vec2f, canvas_res: vec2f) -> vec2f {
    return (uv - 0.5) * 2.0 * world_half_extent_from_res(canvas_res);
}

// World -> normalized device coords [-1,1] for rasterizing into the canvas.
fn world_to_ndc(p: vec2f, canvas_res: vec2f) -> vec2f {
    return p / world_half_extent_from_res(canvas_res);
}

// Wrap a world position into the world bounds. BC_WRAP only -- the world is a
// torus in that mode alone.
//
// DO NOT REWRITE fract() AS `%`. `p` here is freely signed (a world position
// past either edge), so `p / size - 0.5` is routinely negative, and WGSL's `%`
// is truncated where this needs floored behaviour. WGSL defines fract(x) as
// `x - floor(x)`, identical to GLSL, so it translates verbatim and correctly --
// the `%` "cleanup" would break wrap for every particle leaving the left or
// bottom edge.
fn world_wrap(p: vec2f, canvas_res: vec2f) -> vec2f {
    let extent = world_half_extent_from_res(canvas_res);
    let size = 2.0 * extent;
    return size * (fract(p / size - 0.5) - 0.5);
}

// Reflect a coordinate given in edge units back into [-1,1]. A triangle wave,
// so it is correct for ARBITRARY overshoot. The reference's single-fold version
// (sign(x)*(1-abs(1-abs(x)))) silently teleported a particle to the far side
// once it passed 2x the edge in one step, which heavy gravity reaches.
//
// GLSL's mod() is floored and WGSL's `%` is truncated, so they are NOT
// interchangeable in general. They agree here because the dividend is abs(x),
// non-negative BY CONSTRUCTION rather than by caller convention, and the
// divisor is a positive literal. That is what makes `%` safe -- if the abs()
// ever goes away, this needs a floored mod again.
fn edge_fold(x: f32) -> f32 {
    let t = abs(x) % 2.0;
    return sign(x) * (1.0 - abs(1.0 - t));
}

// What world_bounce returns. GLSL passed p and v as `inout`; WGSL has no
// inout, so the pair comes back as a struct. (A ptr<function, vec2f> parameter
// would also work, but a return struct reads better at the one call site.)
struct BounceResult {
    pos: vec2f,
    vel: vec2f,
}

// Reflect a position off the world bounds, flipping the velocity components
// that crossed. Position and velocity move together: reflecting the position
// without reversing the velocity would just re-trigger the bounce every frame,
// pinning the particle to the wall.
//
// THE ORDER BELOW IS LOAD-BEARING: the velocity flips are decided against the
// PRE-FOLD position, and only then is the position folded. Computing the folded
// position first and testing that would silently change the exact-boundary case.
fn world_bounce(p: vec2f, v: vec2f, canvas_res: vec2f) -> BounceResult {
    let extent = world_half_extent_from_res(canvas_res);
    var vel = v;
    if (abs(p.x) > extent.x) { vel.x = -vel.x; }
    if (abs(p.y) > extent.y) { vel.y = -vel.y; }
    let pos = vec2f(edge_fold(p.x / extent.x), edge_fold(p.y / extent.y)) * extent;
    return BounceResult(pos, vel);
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
fn letterbox_scale(canvas_res: vec2f, window_res: vec2f) -> vec2f {
    if (window_res.x <= 0.0 || window_res.y <= 0.0) { return vec2f(1.0); }
    let canvas_aspect = canvas_res.x / canvas_res.y;
    let window_aspect = window_res.x / window_res.y;
    return select(
        vec2f(1.0, window_aspect / canvas_aspect),  // bars top/bottom
        vec2f(canvas_aspect / window_aspect, 1.0),  // bars left/right
        window_aspect > canvas_aspect);
}

fn world_to_screen_ndc(p: vec2f, canvas_res: vec2f, window_res: vec2f,
                       pan: vec2f, zoom: f32) -> vec2f {
    let ndc = world_to_ndc(p - pan, canvas_res) * zoom;
    return ndc * letterbox_scale(canvas_res, window_res);
}

fn screen_ndc_to_world(ndc: vec2f, canvas_res: vec2f, window_res: vec2f,
                       pan: vec2f, zoom: f32) -> vec2f {
    var v = ndc / letterbox_scale(canvas_res, window_res);
    if (zoom != 0.0) { v /= zoom; }
    return uv_to_world(v * 0.5 + 0.5, canvas_res) + pan;
}

// Screen ndc -> canvas uv, for the present pass sampling the canvas texture.
// Values outside [0,1] fall in the letterbox bars; the caller decides whether
// to clamp, wrap (tiling) or paint them black.
fn screen_ndc_to_canvas_uv(ndc: vec2f, canvas_res: vec2f, window_res: vec2f,
                           pan: vec2f, zoom: f32) -> vec2f {
    return world_to_uv(
        screen_ndc_to_world(ndc, canvas_res, window_res, pan, zoom),
        canvas_res);
}
