// ============================================================================
// entityUpdate.wgsl -- the physics. The WGSL translation of
// `particle_system/shaders/entity_update.glsl` (581 lines).
//
// Structure, order and comments follow that file deliberately, so the two stay
// diff-comparable and an `entity_update.glsl:NNN` reference still lands near
// the right place. This is the file the port's fidelity is decided in.
//
// ---------------------------------------------------------------------------
// THE PROMOTION AUDIT
// ---------------------------------------------------------------------------
// GLSL promotes int to float implicitly; WGSL has NO implicit conversions at
// all. Every site below needed an explicit cast, and EVERY ONE IS
// VALUE-PRESERVING -- that is the point of having enumerated them. After this
// audit, a behavioural difference between the two apps is *not* a cast error,
// which is most of the search space gone.
//
//   :68-70   co*-1+5, co.yx-100, co.yx*-1+25   float literals
//   :85      2*float(i)                        2.0 * f32(i)
//   :111-122 float(i*8+n)                      f32(i*8+n), arithmetic kept i32
//   :209     float(index)/float(len)           f32(u32), f32(arrayLength)
//   :234     cohort_val+index+2.142            + f32(index); vec2(x) is a SPLAT
//   :254     cohort_val/float(cohorts)         cohorts is i32
//   :273     hash(vec2(cohort_val,index))      f32(index); *2-1 -> *2.0-1.0
//   :285     hash4(-.5+vec2(-i+seed,i))        -f32(i); operand order kept
//   :287     1 + amount*0.5*(...)              leading 1.0; f32(i) in the hash
//   :389     hash(vec2(..., frame_count))      f32(frame_count)
//   :439     frequency==vec4(0)                all(...) -- SEE BELOW
//
// TWO TRANSLATIONS THAT ARE NOT CASTS:
//
//  1. GLSL's `==` on a vector returns a SCALAR bool (whole-vector equality).
//     WGSL's returns a vec4<bool>, so `:439` needs `all()` on each side. The
//     compiler catches this one (`&&` on vec4<bool> is an error), but it is a
//     genuine semantic difference and not merely a cast.
//
//  2. WGSL function parameters are IMMUTABLE. GLSL's are mutable copies, and
//     `calculate_entity_behavior` reassigns L and R (`:344-345`). Those become
//     `var` locals here.
//
// ---------------------------------------------------------------------------
// WHAT IS DELIBERATELY NOT PORTED
// ---------------------------------------------------------------------------
//  * `normalized_fourier_noise` (:133) and `random_fourier_noise` (:128) have
//    no callers -- `generate_random_centers` is invoked directly at :452.
//  * The `#ifdef HARD_FENCE` branch (:552-556). WGSL has no preprocessor, and
//    the macro is never defined by any host path (it is a commented-out
//    `//#define` at :551), so the `#else` soft fence is the live code. See the
//    fence block below, which keeps the original comment.
//
// ---------------------------------------------------------------------------
// ON BIT-EXACTNESS
// ---------------------------------------------------------------------------
// Do not expect it, and do not chase it. WGSL permits the same FMA contraction
// GLSL does (PORT_AUDIT.md:743), and the browser's compiler need not fuse the
// same multiply-adds the desktop driver does. `hash()` is chaotic, so a 1-ULP
// difference in one generated coefficient produces a COMPLETELY DIFFERENT rule
// -- the same trap :446-451 documents for the host-side mirror. Two runs of the
// same preset therefore diverge into different-but-statistically-identical
// behaviour. That is expected. The verification is emergent character, judged
// by eye (docs/WEB_PORT_PLAN.md:41-45), which is exactly why.
// ============================================================================

#include "common.wgsl"

// --- bindings --------------------------------------------------------------
// Group 0 is the simulation state; group 1 is the textures. They are split
// because the TEXTURE group is what swaps: the canvas is double-buffered, and
// the sampler's address mode follows the boundary mode (WebGPU samplers are
// immutable, so switching Wrap/Bounce means switching bind groups). Keeping the
// buffers out of that group means they are bound once.
//
// Bindings 0 and 1 are fixed project-wide -- see the table in common.wgsl.

@group(0) @binding(0) var<storage, read_write> entities : array<Entity>;
@group(0) @binding(1) var<storage, read>       configs  : array<ConfigData>;

// The desktop's loose uniforms, gathered into one struct. `canvas_res` is the
// `textureSize()` hoist -- see uniforms.ts.
struct EntityUpdateUniforms {
    world      : WorldData,
    // xy: canvas resolution   zw: strafe field resolution
    canvas_res : vec4f,
    // xy: shove center (world)   z: strength (signed; 0 is off)   w: size
    shove      : vec4f,
    // x: frame_count(i)   y: strafe_field_active(i)   zw: reserved
    flags      : vec4f,
}
@group(0) @binding(2) var<uniform> u : EntityUpdateUniforms;

@group(1) @binding(0) var canvas_texture       : texture_2d<f32>;
@group(1) @binding(1) var canvas_sampler       : sampler;
// The painted Strafe Field (see strafe_field/). Displaces particles directly,
// bypassing velocity. Inactive until the module binds a texture -- the sample
// is skipped entirely rather than reading an unbound one. Step 4 always binds a
// 1x1 dummy with the flag off (WebGPU validates bind groups regardless of
// whether the shader reads them, unlike GL).
@group(1) @binding(2) var strafe_field_texture : texture_2d<f32>;
@group(1) @binding(3) var strafe_field_sampler : sampler;

fn frame_count() -> i32 { return bitcast<i32>(u.flags.x); }
fn strafe_field_active() -> bool { return bitcast<i32>(u.flags.y) != 0; }
fn canvas_res() -> vec2f { return u.canvas_res.xy; }

//=========================================================================================
//------------------------------------RANDOM / HASH / NOISE--------------------------------
//====================================VVVVVVVVVVVVVVVVVVVVV================================

// PCG hash - bit-exact across all platforms.
// The u32 multiplies wrap in WGSL exactly as they do in GLSL, so this is a
// verbatim translation. (JavaScript would have needed Math.imul; the GPU does
// not -- which is part of why Step 6 moves rule derivation onto the GPU.)
fn pcg_hash(seed: u32) -> u32 {
    let state = seed * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

fn hash(co: vec2f) -> f32 {
    let u_bits = vec2u(bitcast<u32>(co.x), bitcast<u32>(co.y));
    let h = pcg_hash(u_bits.x ^ pcg_hash(u_bits.y));
    return f32(h) / f32(0xffffffffu);
}

// Three implicit promotions in four lines on the GLSL side (:68-70); the int
// literals are written as floats here and the values are identical.
fn hash4(co: vec2f) -> vec4f {
    return vec4f(
        hash(co),
        hash(co * -1.0 + 5.0),
        hash(co.yx - 100.0),
        hash(co.yx * -1.0 + 25.0)
    );
}

// Fourier basis evaluation.
// This is how the entities evaluate their Rule.
fn fourier_noise(centers: array<FourierCenter, 10>, signals: vec4f) -> vec4f {
    var result = vec4f(0.0);

    for (var i = 0; i < 10; i++) {
        // Compute phase from dot product of input with frequency vector
        let phase = dot(signals, centers[i].frequency);

        // Add per-center phase offset to break degeneracy at origin
        // Use a deterministic offset based on center index and amplitude values
        let phase_offset = 2.0 * f32(i) * 0.6283 + centers[i].amplitude.w * 3.14159;

        // Create basis functions from phase with offset
        // Using sin/cos pairs at fundamental and first harmonic for richer representation
        let basis = vec4f(
            sin(phase + phase_offset),
            cos(phase + phase_offset * 0.7),  // Different offsets for variety
            sin(phase * 2.0 + phase_offset * 1.3),
            cos(phase * 2.0 + phase_offset * 0.5)
        );

        // Weight and accumulate
        result += centers[i].amplitude * basis;
    }

    return result;
}

// Given a seed, return 10 random FourierCenters: enough for a Rule.
//
// DO NOT REWRITE `pow(h, 2.0)` AS `h*h`. `freq_scale` and `frequency.x` draw
// from the SAME hash lane (`i*8+0`), so frequency.x is `(h*2-1) * (1+2*pow(h,2))`.
// pow(h,2) and h*h differ by 1 ULP, and the chaotic hash amplifies that into a
// completely different rule -- measured on the desktop as seed 0.3088 vs 0.2605
// (see the comment at mutation.py:149, and entity_update.glsl:446-451).
fn generate_random_centers(seed: f32) -> array<FourierCenter, 10> {
    var centers : array<FourierCenter, 10>;

    for (var i = 0; i < 10; i++) {
        // Generate frequency vectors
        // Bias towards lower frequencies for smoother base behaviors
        // Range: [-2, 2] with bias towards [-1, 1]
        let freq_scale = 1.0 + 2.0 * pow(hash(vec2f(seed, f32(i * 8 + 0))), 2.0);
        centers[i].frequency.x = (hash(vec2f(seed, f32(i * 8 + 0))) * 2.0 - 1.0) * freq_scale;
        centers[i].frequency.y = (hash(vec2f(seed, f32(i * 8 + 1))) * 2.0 - 1.0) * freq_scale;
        centers[i].frequency.z = (hash(vec2f(seed, f32(i * 8 + 2))) * 2.0 - 1.0) * freq_scale;
        centers[i].frequency.w = (hash(vec2f(seed, f32(i * 8 + 3))) * 2.0 - 1.0) * freq_scale;

        // Generate amplitude vectors
        // Range: [-1, 1]
        centers[i].amplitude.x = hash(vec2f(seed, f32(i * 8 + 4))) * 2.0 - 1.0;
        centers[i].amplitude.y = hash(vec2f(seed, f32(i * 8 + 5))) * 2.0 - 1.0;
        centers[i].amplitude.z = hash(vec2f(seed, f32(i * 8 + 6))) * 2.0 - 1.0;
        centers[i].amplitude.w = hash(vec2f(seed, f32(i * 8 + 7))) * 2.0 - 1.0;
    }

    return centers;
}

//=====================================^^^^^^^^^^^^^^^^^^==================================
//------------------------------------RANDOM / HASH / NOISE--------------------------------
//=========================================================================================

// Rotate p around origin by angle a.
// GLSL took `inout vec2 p`; WGSL has no inout, so this returns the rotated
// vector and the two call sites assign it back.
fn pR(p: vec2f, a: f32) -> vec2f {
    return cos(a) * p + sin(a) * vec2f(p.y, -p.x);
}

// Convert p from worldspace to texture coords and retrieve canvas.
// The boundary mode decides what a sensor reaching past the edge sees: in
// BC_WRAP the sampler repeats and it reads the far side; otherwise it clamps
// and reads the edge, because in those modes the far side is not adjacent.
fn get_can(p: vec2f, bc: i32) -> vec4f {
    // The GLSL calls textureSize() here, twice per invocation. Hoisted to the
    // uniform -- see the header of uniforms.ts.
    let res = canvas_res();
    // Stored values ride CANVAS_VALUE_SCALE above their physical meaning (an
    // fp16 range fix -- see common.wgsl); divide it back out so the sensors
    // see the same magnitudes they always did. The clamp guards against a
    // transient inf texel (a splat pile-up the canvas pass has not scrubbed
    // yet): sensing inf would NaN the particle's position permanently.
    //
    // textureSampleLevel, not textureSample: a compute entry point has no
    // implicit derivatives, so the sampling level must be given explicitly.
    // Identical here -- there are no mips.
    let canv = textureSampleLevel(canvas_texture, canvas_sampler,
                                  world_to_uv_bc(p, res, bc), 0.0);
    return clamp(canv, vec4f(-CANVAS_VALUE_MAX), vec4f(CANVAS_VALUE_MAX))
           / CANVAS_VALUE_SCALE;
}

// Read the painted strafe field at a world position, honoring the boundary mode
// for the same reason get_can does: past the edge, wrap reads the far side and
// every other mode reads the edge.
fn get_strafe_field(p: vec2f, bc: i32) -> vec2f {
    if (!strafe_field_active()) { return vec2f(0.0); }
    let res = u.canvas_res.zw;
    return textureSampleLevel(strafe_field_texture, strafe_field_sampler,
                              world_to_uv_bc(p, res, bc), 0.0).rg;
}

// The Shove tool: a displacement away from (or toward) the cursor while the
// mouse is held. Unlike the painted field this leaves NOTHING behind -- it acts
// only on the frames the button is down, which is what makes it feel like
// pushing the particles rather than painting something that pushes them.
//
// Measured in world space directly. That space is area-preserving, so a circle
// in it is a circle on screen and no aspect correction is needed here (see the
// coordinate convention in common.wgsl).
//
// Deliberately NOT boundary-aware, unlike the two readers above. Those sample a
// texture, where past the edge has to mean something; this is a distance to a
// point the user is pointing at. In BC_WRAP a shove near the edge does not
// reach around to the far side, because the cursor is not there.
const SHOVE_MULTIPLIER: f32 = 8.0;
fn get_shove(p: vec2f) -> vec2f {
    let shove_strength = u.shove.z;
    if (shove_strength == 0.0) { return vec2f(0.0); }
    let away = p - u.shove.xy;
    let d = length(away);
    // Exactly on the cursor the direction is undefined. Contributing nothing is
    // also what keeps ATTRACT stable: the kernel peaks here, so without this
    // guard the strongest pull would be the one with no direction to pull in.
    if (d <= 0.0) { return vec2f(0.0); }

    // Same gaussian the brush paints with, so the reticle shows the real reach
    // of both tools. No cutoff radius: a distant particle gets a denormal rather
    // than a branch, and every invocation pays for the exp() either way.
    let shove_size = u.shove.w;
    let kernel = exp(-d * d / (2.0 * shove_size * shove_size));
    return SHOVE_MULTIPLIER * (away / d) * shove_strength * kernel;
}

// Normalize vector that tolerates vec2(0).
//
// AN `if`, NOT `select()`. GLSL's `?:` evaluates only the taken branch, but
// WGSL's `select(f, t, cond)` is an ordinary function call: BOTH arguments are
// evaluated first. `normalize(vec2f(0.0))` is 0/0 -- NaN -- so a select() here
// would compute the NaN and then discard it, which is fine on paper and a
// coin-flip in practice once a compiler is allowed to contract or reassociate
// around it. The whole point of this function is that vec2(0) is a value it
// must survive, so the branch stays a branch.
fn safenorm(p: vec2f) -> vec2f {
    if (length(p) == 0.0) { return vec2f(0.0); }
    return normalize(p);
}

// Simply assigns each to a cohort based on its index.
// floor(get_cohort(index)) should be used for cohort equality tests.
fn get_cohort(index: u32, config: ConfigData) -> f32 {
    return f32(cfg_cohorts(config)) * f32(index) / f32(arrayLength(&entities));
}

// Decide which ConfigData slot an entity uses. Phase 1 puts everyone on slot 0,
// which is behavior-identical to the old single-uniform setup. To split the
// population across configs, this is the one place to change: assign by index
// (cohort-style), by position, or however the feature calls for.
fn assign_config_index(index: u32) -> i32 {
    return 0;
}

// Where an entity starts, per the config's initial-conditions mode.
//
// PURE, and deliberately so: Cohort Fences needs to know where a particle's
// home is on every frame, and recomputing it here is cheaper than widening
// Entity to store it. Because both the fence and reset() call this, they can
// never disagree about where home is.
//
// Every mode starts from the same small per-cohort jitter, then places it.
// Grid and Ring are expressed in world extent rather than the reference's
// inline aspect fudge, so they stay correct on a non-square canvas.
fn initial_position(index: u32, config: ConfigData) -> vec2f {
    let cohort_val = get_cohort(index, config);
    let extent = world_half_extent_from_res(canvas_res());

    // vec2(x) in GLSL is a SPLAT, not a (x, 0) constructor -- vec2f(x) here
    // means the same thing. `index` is a u32 promoted to float by GLSL.
    var pos = 0.019 * vec2f(hash(vec2f(cohort_val)),
                            hash(vec2f(cohort_val + f32(index) + 2.142)));

    let mode = cfg_initial_conditions(config);
    let cohorts = max(1, cfg_cohorts(config));

    if (mode == IC_GRID) {
        // One cell per cohort, laid out so the cells come out roughly SQUARE:
        // for n cohorts in a box of aspect a, that wants sqrt(n*a) columns.
        // (Using n*a rather than sqrt(n)*a is the difference between a grid and
        // a single wide strip on a wide canvas.)
        let cols = max(1.0, round(sqrt(f32(cohorts) * extent.x / extent.y)));
        let cells = vec2f(cols, ceil(f32(cohorts) / cols));
        // GLSL's mod() is floored and WGSL's `%` is truncated, so they are NOT
        // interchangeable in general. They agree here because floor(cohort_val)
        // is non-negative BY CONSTRUCTION -- cohort_val is cohorts*index/N, a
        // quotient of non-negatives -- and cols >= 1.0. That is what makes `%`
        // safe; if cohort_val could go negative this would need a floored mod.
        // (Same reasoning, same wording, as edge_fold in common.wgsl.)
        let cell = vec2f(floor(cohort_val) % cols, floor(floor(cohort_val) / cols));
        pos += (cell + 0.5) / cells * 2.0 * extent - extent;
    }
    else if (mode == IC_RANDOM) {
        // Scattered across the whole world. Note this ASSIGNS rather than adds:
        // the jitter above is discarded in this mode.
        pos = (vec2f(hash(vec2f(cohort_val, 1.0)), hash(vec2f(cohort_val, 2.0))) * 2.0 - 1.0) * extent;
    }
    else if (mode == IC_RING) {
        let angle = cohort_val / f32(cohorts) * 2.0 * PI;
        pos += vec2f(cos(angle), sin(angle)) * 0.5 * min(extent.x, extent.y);
    }
    // IC_CENTER: the bare jitter, which is what this app did before the mode
    // was selectable. Kept as a real mode so that look stays reachable.

    return pos;
}

// Return an entity to its initialization state.
//
// NOTE: this writes the entity buffer ITSELF, so every caller must return
// immediately after -- a later `entities[index]=...` would clobber it.
fn reset(index: u32, config: ConfigData) {
    let size = select(0.0, 0.0015 / world_sqrt_world_size(u.world),
                      index < arrayLength(&entities));
    let cohort_val = get_cohort(index, config);

    let pos = initial_position(index, config);
    let vel = 0.00005 * (vec2f(hash(vec2f(cohort_val, f32(index))),
                               hash(vec2f(cohort_val, pos.y))) * 2.0 - 1.0);

    // store to persistent entity buffer
    entities[index] = make_entity_reset(pos, vel, size, assign_config_index(index));
}

// Randomly change noise function parameters, scaled by parameter 'amount'.
// Each cohort gets a unique mutation for any given rule.
//
// GLSL took `inout Rule`; WGSL has no inout, so the mutated rule comes back as
// a return value and the call site assigns it.
fn mutate_rule(current_rule: Rule, amount: f32, cohort: f32) -> Rule {
    var rule = current_rule;
    let seed = hash(rule.centers[4].frequency.xy
                    + rule.centers[7].amplitude.yx
                    + rule.centers[1].frequency.zw) + cohort;

    for (var i = 0; i < 10; i++) {
        // Operand order kept as the GLSL writes it (`-.5 + vec2(...)`), since
        // reassociating a float add is not required to be value-preserving.
        let amp_mutation = amount * (-1.0 + 2.0 * hash4(-0.5 + vec2f(-f32(i) + seed, f32(i))));
        rule.centers[i].amplitude += amp_mutation;
        rule.centers[i].frequency *= 1.0 + amount * 0.5 * (hash(vec2f(seed, f32(i))) - 0.5);
    }
    return rule;
}

// Gravity-like force expansion: maps a linear -1..1 slider (gravity_force /
// gravity_strafe) to a logarithmic physical force, so a small knob covers a
// wide range. Odd-symmetric, with a linear dead-zone near centre so it reaches
// exactly 0.
//
//   physical = sign(c) * MAXV * 10^(DECADES*(|c|-1))   for |c| > KNEE
//   physical = sign(c) * V_KNEE * (|c|/KNEE)           for |c| <= KNEE
//
// The two pieces meet at |c| == KNEE, so the curve is continuous there.
const GRAVITY_MAXV: f32    = 0.5;   // physical value at |control| = 1
const GRAVITY_DECADES: f32 = 4.0;   // log span: MAXV .. MAXV/10^DECADES
const GRAVITY_KNEE: f32    = 0.05;  // |control| below this ramps linearly to 0
fn gravity_expand(c: f32) -> f32 {
    let a = abs(c);
    let s = sign(c);
    let v_knee = GRAVITY_MAXV * pow(10.0, GRAVITY_DECADES * (GRAVITY_KNEE - 1.0));
    if (a <= GRAVITY_KNEE) {
        return s * v_knee * (a / GRAVITY_KNEE);
    }
    return s * GRAVITY_MAXV * pow(10.0, GRAVITY_DECADES * (a - 1.0));
}

// Used to enforce left-right symmetry in the local coordinates vec2(forward, left).
fn y_reflect(p: vec2f) -> vec2f {
    return p * vec2f(1.0, -1.0);
}

// Somewhat arbitrary generator of functions with 4 float inputs and 4 float outputs,
// varying rule should smoothly change the behavior of black box. Here, we use fourier noise.
fn black_box(L: vec2f, R: vec2f, rule: Rule) -> vec4f {
    return fourier_noise(rule.centers, vec4f(L, R));
}

// What calculate_entity_behavior returns. GLSL used three `out` parameters;
// WGSL has none, so they come back as a struct.
struct Behavior {
    // A "push" vector that will be added to entity.vel
    force: vec2f,
    // A "hop" vector that will be added to entity.pos and have no effect on velocity
    strafe: vec2f,
    // Raw signal kept for rendering only -- never fed back into the physics
    color: vec2f,
}

// This function determines entity output by plugging sensor values into a noise function called black_box()
// The calculation is performed twice, once in mirrored coordinates, and the two values are averaged.
// This keeps entities from displaying clockwise/counterclockwise bias.
// PARAMETERS:
// --L and R: velocity field measurements from left sensor and right sensor.
// --axis: forward vector that defines our orientation.
// --rule: coefficients for the noise function that dictates entity behavior.
fn calculate_entity_behavior(L_in: vec2f, R_in: vec2f, axis: vec2f, rule: Rule,
                             config: ConfigData) -> Behavior {
    // Build a local coordinate frame where "axis" is forward.
    let forward = safenorm(axis);
    let left = vec2f(forward.y, -forward.x);

    // Convert L and R to local coordinates.
    // Ie. decompose each into an axial component and a lateral component.
    //
    // WGSL parameters are immutable, so these are locals. Each is computed from
    // its OWN pre-decomposition value on a single line, exactly as the GLSL
    // does -- dot(L, left) must see the original L, not the rewritten one.
    let L = vec2f(dot(L_in, forward), dot(L_in, left));
    let R = vec2f(dot(R_in, forward), dot(R_in, left));

    // Calculate black box noise values.
    // Note the L/R SWAP in the mirror term, not merely a reflection.
    let baseterm = black_box(L, R, rule);
    let mirrorterm = black_box(y_reflect(R), y_reflect(L), rule);

    // Combine base and mirror terms to cancel bias
    var force = baseterm.xy + y_reflect(mirrorterm.xy);
    var strafe = baseterm.zw + y_reflect(mirrorterm.zw);

    // Convert force and strafe back to world coordinates
    force = (forward * force.x * cfg_axial_force(config)) + (left * force.y * cfg_lateral_force(config));
    strafe = (forward * strafe.x * cfg_axial_force(config)) + (left * strafe.y * cfg_lateral_force(config));

    // An arbitrary function of the black box output, reusing the force terms.
    // NOT y_reflect'd, unlike force above: cancelling the mirror bias is what
    // keeps motion free of a clockwise preference, but colour WANTS that
    // asymmetry -- it is what makes the signal something other than a recoloured
    // copy of where the particle is already going.
    //
    // Stays in local coordinates. Nothing downstream treats it as a direction.
    let color = baseterm.xy + mirrorterm.xy;

    return Behavior(force, strafe, color);
}

// WORKGROUP SIZE 256 -- must match WORKGROUP_SIZE in particleSystem.ts. These
// live in different files and drifting them under-dispatches silently, leaving
// a tail of entities frozen; shaders.test.ts asserts they agree.
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let index = gid.x;
    if (index >= arrayLength(&entities)) { return; }

    let e = entities[index];

    // Select this entity's config. On a reset frame the entity's stored
    // config_index is not yet meaningful (nothing has been written), so ask
    // assign_config_index() directly rather than reading it back.
    let fc = frame_count();
    let config_index = select(e_config_index(e), assign_config_index(index), fc == 0);
    let config = configs[clamp(config_index, 0, world_config_count(u.world) - 1)];

    let sqrt_world_size = world_sqrt_world_size(u.world);
    let canvas_resolution = canvas_res();

    let cohort = get_cohort(index, config);
    var rule = config.rule;
    // Hazard Rate == probability each frame to reset this particle
    let hazard_reset = cfg_hazard_rate(config)
        > hash(vec2f(f32(index) / f32(arrayLength(&entities)), f32(fc)));

    // frame_count == 0 signals a simulation reset
    if (fc == 0 || hazard_reset) { reset(index, config); return; }

    var pos = e_pos(e);
    var vel = e_vel(e);

    // Sensor jitter: a random wobble on where this particle looks, resampled
    // EVERY STEP rather than fixed per particle -- so it reads as a shimmer that
    // softens structure, not as a population of individuals with different eyes.
    //
    // Each slider is 0..1 and scaled so that 1.0 spans the whole range of the
    // parameter it perturbs: angle is a -1..1 half-turn control so it needs no
    // scaling, distance is 0..SENSOR_DISTANCE_SPAN so it takes that factor.
    // Both offsets are the SAME draw, applied to both sensors together, so the
    // pair stays symmetric about the heading and jitter never introduces the
    // left/right bias that y_reflect exists to cancel.
    var angle = cfg_sensor_angle(config);
    var distance = cfg_sensor_distance(config);

    let angle_jitter = cfg_sensor_angle_jitter(config);
    if (angle_jitter != 0.0) {
        angle += angle_jitter * (2.0 * hash(vec2f(f32(index), f32(fc))) - 1.0);
    }
    let distance_jitter = cfg_sensor_distance_jitter(config);
    if (distance_jitter != 0.0) {
        // Deliberately UNCLAMPED: a negative distance puts both sensors behind
        // the particle (and swaps which is left), which is a genuinely different
        // look that no combination of the other sliders can reach.
        distance += SENSOR_DISTANCE_SPAN * distance_jitter
                  * (2.0 * hash(vec2f(f32(index) + 0.5, f32(fc))) - 1.0);
    }

    // Calculate position offsets for the two sensors.
    let sample_dist = 1.0 / sqrt_world_size * 0.005 * distance;
    // Vector facing the same direction as velocity, with length==sample_dist
    let orientation = safenorm(vel);

    // Rotate them opposite directions.
    let left_sensor_offset = pR(orientation * sample_dist, angle * PI);
    let right_sensor_offset = pR(orientation * sample_dist, -angle * PI);

    // Read the trails from canvas.
    let bc = world_boundary_conditions(u.world);
    var ltap = get_can(pos + left_sensor_offset, bc);
    var rtap = get_can(pos + right_sensor_offset, bc);

    // If a few arbitrary coefficients are exactly 0, then assume target_rule is
    // all 0s (no target) and generate a random rule instead.
    //
    // GLSL's `==` on a vector is whole-vector equality returning a scalar bool;
    // WGSL's is componentwise and returns vec4<bool>, hence all().
    let rule_seed = cfg_mutation_seed(config) + floor(cohort);
    if (all(rule.centers[0].frequency == vec4f(0.0))
        && all(rule.centers[5].amplitude == vec4f(0.0))) {
        // A GENERATED RULE IS ALREADY RANDOM, so it is NOT mutated on top.
        // The seed alone decides it, and rerolling the seed rerolls the whole
        // rule -- there is nothing for Mutation Scale to add that the seed does
        // not already do, and mutating here would mean Mutation Scale silently
        // changed a rule the user never authored.
        //
        // It also keeps the rule REPRODUCIBLE ON THE HOST. mutate_rule derives
        // its own seed by hashing the rule's coefficients, and hash() is
        // chaotic, so a 1-ULP difference in a generated coefficient (the GPU
        // fuses a multiply-add here that numpy cannot) would send the mutation
        // somewhere else entirely. Skipping it means particle selection can
        // reproduce exactly what a particle obeys -- see particle_system/mutation.py.
        rule = Rule(generate_random_centers(rule_seed));
    }
    else {
        // Each cohort gets a random mutation
        rule = mutate_rule(rule, cfg_mutation_scale(config), rule_seed);
    }

    // Rescale sensor values.
    let sensor_scaling = sqrt_world_size * 38.855 * cfg_sensor_gain(config);
    ltap *= sensor_scaling;
    rtap *= sensor_scaling;

    // Compute entity action.
    let behavior = calculate_entity_behavior(ltap.xy, rtap.xy, orientation, rule, config);
    var force = behavior.force;
    var strafe = behavior.strafe;
    var col_params = behavior.color;

    // The particle's cohort, carried alongside the brain's signal so the
    // RENDERER can choose between them. This shader transmits both and decides
    // nothing: Color By Cohort is a display choice, and deciding it here would
    // mean the checkbox did nothing until the next physics step -- so it would
    // appear broken while paused, which is exactly when you want to compare.
    //
    // Sent raw. What a cohort index looks like as a colour is the renderer's
    // business (see cam_brush.frag).
    col_params.y = floor(cohort);

    // Rescale output forces.
    force *= 1.0 / sqrt_world_size * cfg_global_force_mult(config) / 400.0;
    strafe *= 1.0 / sqrt_world_size * cfg_global_force_mult(config) / 20.0;

    // Accelerate: Apply drag and add force to e.vel.
    vel = vel * cfg_drag(config) + force;

    // Uniform pull on the whole population, in the same two channels: _force
    // feeds velocity (after drag, so drag does not damp it away the same frame),
    // _strafe displaces position directly. Negated so a positive slider pulls
    // DOWN the screen. Scaled by 1/sqrt_world_size like every other force here,
    // so the feel survives a World Size change.
    //
    // Which way is "down" is one direction shared by both channels, taken once
    // here so Force and Strafe can never disagree about it. Radial Gravity
    // swings it from the fixed screen axis to the particle's own position
    // vector, which points AWAY from the origin -- so with the same negation a
    // positive slider still falls "down", now meaning inwards. A particle
    // sitting exactly on the origin has no direction to fall in; normalize()
    // would hand back NaN there and poison the position for good, so that one
    // case gets no pull rather than an arbitrary one.
    var gravity_dir = vec2f(0.0, 1.0);
    if (cfg_radial_gravity(config)) {
        let r = length(pos);
        // An `if`, not select() -- same reason as safenorm above: select()
        // evaluates both arms, and `pos / r` at r == 0 is the NaN this guard
        // exists to prevent.
        if (r > 0.0) { gravity_dir = pos / r; } else { gravity_dir = vec2f(0.0); }
    }

    vel += 0.01 / sqrt_world_size * -gravity_expand(cfg_gravity_force(config)) * gravity_dir;

    // Move: add vel and strafe to pos.
    pos += vel;
    pos += strafe * cfg_strafe_power(config);
    pos += 0.01 / sqrt_world_size * -gravity_expand(cfg_gravity_strafe(config)) * gravity_dir;

    // The painted Strafe Field, in the strafe channel: a displacement, not a
    // force, so no rule can resist it and drag never damps it. Applied before
    // the fence and the boundary so containment still gets the last word --
    // you can paint a particle against a wall, not through it.
    //
    // Deliberately NOT scaled by 1/sqrt_world_size, unlike every force above
    // it. Those are tuned in world units and must shrink as the world grows;
    // this is painted in uv space and read in uv space, so it already tracks
    // canvas size. Dividing again would make an identical stroke weaker in a
    // bigger world for no reason the user could see.
    pos += STRAFE_FIELD_GAIN * get_strafe_field(pos, bc);

    // The Shove tool, in the same channel and for the same reasons: a
    // displacement, so drag cannot damp it and no rule can resist a direct push.
    // Also before the fence and the boundary, so containment still gets the last
    // word -- you can shove a particle against a wall, not through it.
    //
    // Already divided by the physics rate on the host, so holding the button for
    // one frame moves a particle the same distance at 30 sub-steps as at 120.
    // Without that, the Physics Rate slider would silently be a strength slider
    // too -- the trap the Draw brush's once-per-frame cadence exists to avoid.
    pos += get_shove(pos);

    // Cohort Fences: hold each particle near its own spawn point, so cohorts
    // stay legible instead of dispersing into each other. A soft wall -- it
    // pushes back in both motion channels rather than hard-clamping, so a
    // particle can still lean on the fence and be shaped by it.
    // Slider is 0=off .. 1=tightest; the radius mapping is here, not in the UI.
    let fences = cfg_cohort_fences(config);
    if (fences > 0.0) {
        let radius = mix(0.5, 0.02, fences);
        let to_home = initial_position(index, config) - pos;
        let excess = length(to_home) - radius;
        if (excess > 0.0) {
            let dir = safenorm(to_home);
            // The GLSL guards a HARD_FENCE variant here -- `reset(); return;`,
            // "leaving the fence is fatal" -- behind an `#ifdef` whose `#define`
            // is commented out at entity_update.glsl:551 and is defined by no
            // host path. WGSL has no preprocessor, so only the live `#else`
            // branch is translated. The hard version is kept in the GLSL because
            // it is a genuinely different look, not because it is a fallback;
            // see entity_update.glsl:552-556 to restore it.
            vel += 0.001 * excess * dir;   // force: accelerate toward home
            pos += 0.51 * excess * dir;    // strafe: hop most of the way back
        }
    }

    // Boundary conditions, applied last: after every force, both integrations,
    // and the fence. A world property, so it comes from WorldData.
    if (bc == BC_WRAP) {
        pos = world_wrap(pos, canvas_resolution);
    }
    else if (bc == BC_BOUNCE) {
        // world_bounce took `inout` p and v in GLSL; common.wgsl returns the
        // pair as a struct. The velocity flips are decided against the PRE-FOLD
        // position inside it -- see the note on its ordering there.
        let bounced = world_bounce(pos, vel, canvas_resolution);
        pos = bounced.pos;
        vel = bounced.vel;
    }
    else if (bc == BC_RESET) {
        if (any(abs(pos) > world_half_extent_from_res(canvas_resolution))) {
            reset(index, config);
            return; // reset writes the entity buffer itself
        }
    }

    // Commit new entity state to buffers.
    entities[index] = make_entity(pos, vel, e_size(e), config_index, col_params);
}
