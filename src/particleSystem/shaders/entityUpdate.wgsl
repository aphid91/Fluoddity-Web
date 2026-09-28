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
// The hash family and get_cohort, shared with entityPick.wgsl so both agree on
// which cohort a particle is in. The rule derivation in the same file is NOT
// called from here any more: cohortRules.wgsl bakes each slot's rule into the
// config buffer, and this shader reads it (see `fourier_noise`).
#include "rule.wgsl"
// The dead-index pool, for BC_KILL. Shared with the sand modality's spawn and
// kill passes so all three agree about how a slot is taken and returned.
//
// THE STRUCT ONLY. Its operations name the `freelist` binding directly, so they
// are included below it -- see the note in freeList.wgsl.
#include "freeList.wgsl"

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
// How the config buffer is laid out -- see configSlots.ts. On in the studio,
// where slot i is cohort i and a particle's slot follows its index; off in sand,
// where a particle keeps the slot its spawn gave it. A pipeline constant, so the
// branch it guards costs nothing, and set from the same field as
// cohortRules.wgsl's so the two cannot disagree about the layout.
override CONFIG_PER_COHORT: bool = false;
// The dead-index pool. Written ONLY by the BC_KILL branch, which pushes the
// index of a particle that has left the world.
//
// BOUND IN BOTH APPS, because WebGPU validates a bind group against the layout
// whether or not the shader reads it -- unlike GL, where an unused binding is
// simply absent. The studio binds a MINIMAL DUMMY (see `freeListBufferFor` in
// particleSystem.ts): it never selects BC_KILL, so nothing ever touches it. This
// is the same shape `strafe_field_texture` already uses with its 1x1 dummy.
@group(0) @binding(3) var<storage, read_write> freelist : FreeList;
// The operations, which name the binding above. Must follow it.
#include "freeListOps.wgsl"

// The desktop's loose uniforms, gathered into one struct. `canvas_res` is the
// `textureSize()` hoist -- see uniforms.ts.
struct EntityUpdateUniforms {
    world      : WorldData,
    // xy: canvas resolution   zw: strafe field resolution
    canvas_res : vec4f,
    // xy: shove center (world)   z: strength (signed; 0 is off)   w: size
    shove      : vec4f,
    // x: frame_count(i)   y: strafe_field_active(i)
    // z: walls_strength   w: trails_strength
    //
    // The two strengths took the vec4's LAST TWO SPARE LANES rather than a new
    // vec4 -- the "claim reserved lanes" half of invariant 7, the same move the
    // sensor jitters made in `misc2`. They are PREFS, not config, so they are
    // deliberately not in `WorldData`: a downloaded config must not carry someone
    // else's decision to mute the walls they painted and you did not.
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

// --- EXPERIMENT: ablation switches ------------------------------------------
// Temporary, for finding what makes this pass slow on one phone. Pipeline
// constants, so a disabled part is compiled out rather than branched around --
// see particleSystem/entityExperiment.ts. Every default is the real shader.
//
// 0 off; 1 return right after the bounds check (dispatch + pass overhead);
// 2 read, move ballistically, write (the memory traffic floor). Both still run
// the reset frame -- see `main`.
override EXP_EARLY_OUT: u32 = 0u;
// Build `config` from the loose vec4s, leaving its 320-byte Rule zeroed. The
// black box reads the rule straight from the buffer, so behaviour is unchanged.
override EXP_SLIM_CONFIG: bool = false;
// Replace both canvas samples with arithmetic on the sensor position.
override EXP_NO_SENSORS: bool = false;
// Fourier centers evaluated, 0..10. 0 passes the signals through scaled.
override EXP_BB_CENTERS: u32 = 10u;
// Skip hazard, stall rescue, sensor jitter, gravity, walls, shove and fences.
override EXP_NO_EXTRAS: bool = false;
// The pass's workgroup size. The host divides by the same value.
override EXP_WORKGROUP_SIZE: u32 = 256u;

fn frame_count() -> i32 { return bitcast<i32>(u.flags.x); }
fn strafe_field_active() -> bool { return bitcast<i32>(u.flags.y) != 0; }
fn canvas_res() -> vec2f { return u.canvas_res.xy; }
// Already multiplied by the old STRAFE_FIELD_GAIN host-side, so this is the whole
// factor -- do not reapply that constant here. See `get_walls`.
fn walls_strength() -> f32 { return u.flags.z; }
fn trails_strength() -> f32 { return u.flags.w; }

//=========================================================================================
//------------------------------------RANDOM / HASH / NOISE--------------------------------
//====================================VVVVVVVVVVVVVVVVVVVVV================================
//
// pcg_hash, hash and hash4 now live in rule.wgsl, included above -- the picker
// needs the same hash family to derive the same rule. Nothing about them
// changed in the move.

// Fourier basis evaluation.
// This is how the entities evaluate their Rule.
//
// One center's contribution. `i` is the center's index, for its phase offset.
fn fourier_term(center: FourierCenter, i: i32, signals: vec4f) -> vec4f {
    // Compute phase from dot product of input with frequency vector
    let phase = dot(signals, center.frequency);

    // Add per-center phase offset to break degeneracy at origin
    // Use a deterministic offset based on center index and amplitude values
    let phase_offset = 2.0 * f32(i) * 0.6283 + center.amplitude.w * 3.14159;

    // Create basis functions from phase with offset
    // Using sin/cos pairs at fundamental and first harmonic for richer representation
    let basis = vec4f(
        sin(phase + phase_offset),
        cos(phase + phase_offset * 0.7),  // Different offsets for variety
        sin(phase * 2.0 + phase_offset * 1.3),
        cos(phase * 2.0 + phase_offset * 0.5)
    );

    // Weight
    return center.amplitude * basis;
}

// Both black box evaluations -- the base term and the mirror term -- at once.
struct FourierPair {
    base: vec4f,
    mirror: vec4f,
}

// fourier_noise for two signal vectors over the same rule. The GLSL evaluates
// the rule twice, once per signal; this is the same arithmetic in the same
// order, so each result is summed exactly as before.
//
// THREE THINGS HERE ARE PERFORMANCE, AND EACH WAS MEASURED:
//
//  1. IT TAKES A SLOT INDEX, NOT A Rule. Passing the 320-byte Rule by value (as
//     the GLSL does) makes every thread hold it as a local array indexed by the
//     loop counter, which the browser's shader compilers spill to per-thread
//     scratch memory -- ~5x the cost of the entire entity update. Do not
//     "tidy" this back into a Rule parameter.
//
//  2. EACH CENTER IS READ ONCE, FOR BOTH TERMS. Two separate evaluations read
//     all ten centers twice.
//
//  3. THE LOOP IS UNROLLED BY HAND. WGSL has no unroll hint and the translated
//     loop stays a loop, so each iteration waited on its own buffer read before
//     its trig could start. With constant indices the compiler can issue the
//     reads early and overlap them with the arithmetic. The black box was ~4 ms
//     of a ~7 ms entity update before this.
//
// The rule in the slot is already this cohort's mutation -- cohortRules.wgsl
// baked it in when the configs were uploaded.
fn fourier_noise_pair(slot: i32, signals_base: vec4f, signals_mirror: vec4f) -> FourierPair {
    var base = vec4f(0.0);
    var mirror = vec4f(0.0);

    // EXPERIMENT: EXP_BB_CENTERS. At 0 the signals pass through, so the
    // sensor reads that feed them stay live.
    if (EXP_BB_CENTERS == 0u) {
        return FourierPair(signals_base * 0.01, signals_mirror * 0.01);
    }
    let c0 = configs[slot].rule.centers[0];
    base += fourier_term(c0, 0, signals_base);
    mirror += fourier_term(c0, 0, signals_mirror);
    if (EXP_BB_CENTERS > 1u) {
        let c1 = configs[slot].rule.centers[1];
        base += fourier_term(c1, 1, signals_base);
        mirror += fourier_term(c1, 1, signals_mirror);
    }
    if (EXP_BB_CENTERS > 2u) {
        let c2 = configs[slot].rule.centers[2];
        base += fourier_term(c2, 2, signals_base);
        mirror += fourier_term(c2, 2, signals_mirror);
    }
    if (EXP_BB_CENTERS > 3u) {
        let c3 = configs[slot].rule.centers[3];
        base += fourier_term(c3, 3, signals_base);
        mirror += fourier_term(c3, 3, signals_mirror);
    }
    if (EXP_BB_CENTERS > 4u) {
        let c4 = configs[slot].rule.centers[4];
        base += fourier_term(c4, 4, signals_base);
        mirror += fourier_term(c4, 4, signals_mirror);
    }
    if (EXP_BB_CENTERS > 5u) {
        let c5 = configs[slot].rule.centers[5];
        base += fourier_term(c5, 5, signals_base);
        mirror += fourier_term(c5, 5, signals_mirror);
    }
    if (EXP_BB_CENTERS > 6u) {
        let c6 = configs[slot].rule.centers[6];
        base += fourier_term(c6, 6, signals_base);
        mirror += fourier_term(c6, 6, signals_mirror);
    }
    if (EXP_BB_CENTERS > 7u) {
        let c7 = configs[slot].rule.centers[7];
        base += fourier_term(c7, 7, signals_base);
        mirror += fourier_term(c7, 7, signals_mirror);
    }
    if (EXP_BB_CENTERS > 8u) {
        let c8 = configs[slot].rule.centers[8];
        base += fourier_term(c8, 8, signals_base);
        mirror += fourier_term(c8, 8, signals_mirror);
    }
    if (EXP_BB_CENTERS > 9u) {
        let c9 = configs[slot].rule.centers[9];
        base += fourier_term(c9, 9, signals_base);
        mirror += fourier_term(c9, 9, signals_mirror);
    }

    return FourierPair(base, mirror);
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

// Read the user-drawn field at a world position, honoring the boundary mode for
// the same reason get_can does: past the edge, wrap reads the far side and every
// other mode reads the edge.
//
// ONE SAMPLE, BOTH LAYERS. The texture is rgba16float -- walls in rg, trails in
// ba (see `FIELD_FORMAT`) -- and the two callers below take the half they want.
// Sampling it twice would cost a second fetch for data the first one already
// returned.
//
// DECLARED ABOVE `get_can` BECAUSE `get_can` CALLS IT. WGSL requires a function
// to be declared before it is used, unlike GLSL's more forgiving rules -- and the
// error a wrong order produces here names the callee, not the ordering.
fn get_field(p: vec2f, bc: i32) -> vec4f {
    if (!strafe_field_active()) { return vec4f(0.0); }
    let res = u.canvas_res.zw;
    return textureSampleLevel(strafe_field_texture, strafe_field_sampler,
                              world_to_uv_bc(p, res, bc), 0.0);
}

// The WALLS layer: a displacement added straight to position.
//
// `walls_strength` REPLACED THE `STRAFE_FIELD_GAIN` CONSTANT that used to live in
// common.wgsl. The host multiplies the user's 0..4 slider by that same 0.01, so a
// strength of 1.0 reproduces the old constant exactly and nothing about a painted
// field changes on upgrade. What the slider buys is the ability to mute a painted
// set of walls (0.0) or lean on it (4.0) without repainting.
fn get_walls(p: vec2f, bc: i32) -> vec2f {
    return get_field(p, bc).rg * walls_strength();
}

// Which way is "down" for this particle, shared by all three gravity channels.
//
// TAKEN ONCE, IN ONE PLACE, so Force, Strafe and Trails can never disagree about
// it. Radial Gravity swings it from the fixed screen axis to the particle's own
// position vector, which points AWAY from the origin -- the callers negate, so a
// positive slider still falls "down", now meaning inwards.
//
// A particle sitting exactly on the origin has no direction to fall in.
// normalize() would hand back NaN there and poison the position for good, so
// that one case gets vec2(0) -- no pull rather than an arbitrary one.
//
// HOISTED OUT OF `main` when Gravity (Trails) arrived: the trails channel biases
// the SENSOR READ, which happens well before the motion channels are applied, so
// the direction is now needed at two points in the step rather than one. Sharing
// a function rather than recomputing it is what keeps the guarantee above true.
fn gravity_direction(pos: vec2f, config: ConfigData) -> vec2f {
    if (!cfg_radial_gravity(config)) { return vec2f(0.0, 1.0); }
    let r = length(pos);
    // An `if`, not select() -- same reason as safenorm: select() evaluates both
    // arms, and `pos / r` at r == 0 is the NaN this guard exists to prevent.
    if (r > 0.0) { return pos / r; }
    return vec2f(0.0);
}

// Convert p from worldspace to texture coords and retrieve canvas.
// The boundary mode decides what a sensor reaching past the edge sees: in
// BC_WRAP the sampler repeats and it reads the far side; otherwise it clamps
// and reads the edge, because in those modes the far side is not adjacent.
//
// `bias` is Gravity (Trails): a constant vec2 the caller has already expanded and
// aimed, added to the reading exactly where the painted trails layer is added.
// Zero when the slider is centred, which is the whole cost of the feature when
// it is off.
fn get_can(p: vec2f, bc: i32, bias: vec2f) -> vec4f {
    // EXPERIMENT: EXP_NO_SENSORS. No texture traffic at all, painted layer
    // included; still a function of p, so the sensor offsets stay live.
    if (EXP_NO_SENSORS) {
        return vec4f((fract(p * 64.0) - 0.5) * 0.001 + bias, 0.0, 0.0);
    }
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
    let trail = clamp(canv, vec4f(-CANVAS_VALUE_MAX), vec4f(CANVAS_VALUE_MAX))
                / CANVAS_VALUE_SCALE;

    // THE USER-DRAWN TRAILS LAYER, added to what the sensors see.
    //
    // This is the whole difference between the two painted layers: walls are
    // added to POSITION and no rule can resist them, while trails are added to
    // the SENSOR READING, so the particle merely believes something is there and
    // its rule decides what to do about it. Painted trails steer; painted walls
    // shove. A trail the user paints is therefore indistinguishable, to a
    // particle, from one the swarm laid down itself -- which is the point, and
    // the reason this is an addition here rather than a term further down.
    //
    // AFTER THE DESCALE, deliberately. The canvas stores values multiplied by
    // CANVAS_VALUE_SCALE (an fp16 range fix); the painted field does not, because
    // the brush writes it directly. Adding before the divide would shrink the
    // painted contribution by 512x -- not zero, so it would look like the feature
    // works and the slider does nothing.
    //
    // Only xy carry a vector: the canvas is a 2D field (`camera.wgsl:85`
    // colorizes it as atan2(y, x)), so the trails layer is one too and zw stay
    // whatever the canvas put there.
    // GRAVITY (TRAILS) RIDES THE SAME ADDITION, deliberately.
    //
    // It is the painted trails layer with a constant in place of a texture: same
    // channel, same place in the pipeline, same units. Everything the comment
    // above says about painted trails is therefore true of it -- a particle
    // cannot tell this bias from a trail the user drew or one the swarm laid
    // down, and its rule is what decides whether that means fall or climb.
    //
    // Being HERE rather than after `sensor_scaling` means Sensor Gain multiplies
    // it, which is correct for the same reason: gain is how loudly this
    // population hears the canvas, and a bias it cannot distinguish from the
    // canvas must be heard just as loudly. A config with the gain at zero senses
    // nothing at all, and this is nothing at all along with it.
    let painted = get_field(p, bc).ba * trails_strength();
    return trail + vec4f(painted + bias, 0.0, 0.0);
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

// get_cohort now lives in rule.wgsl (the picker needs the same cohort to derive
// the same rule). It takes the entity count as a THIRD ARGUMENT there, because
// a shared function cannot name a binding that the two including shaders
// qualify differently -- so every call below passes arrayLength(&entities).

// Decide which ConfigData slot an entity uses. See configSlots.ts for the layout.
//
// STUDIO (CONFIG_PER_COHORT): the slot IS the particle's cohort. `main` calls
// this EVERY STEP rather than only at reset, because the cohort is a function of
// the index and the live Cohorts count -- a stored slot would go stale the
// moment the slider moved, and particles would keep a rule from the old split.
// Every slot is a copy of one parent, so slot 0's cohort count is everyone's.
//
// SAND: the slot is whatever the spawn pass wrote, and this is only reached on
// a reset frame, which sand never runs (see the dead-particle note in `main`).
fn assign_config_index(index: u32) -> i32 {
    if (!CONFIG_PER_COHORT) { return 0; }
    return i32(floor(get_cohort(index, configs[0], arrayLength(&entities))));
}

// Where an entity starts, per the config's initial-conditions mode.
//
// PURE, and deliberately so: Cohort Fences needs to know where a particle's
// home is on every frame, and recomputing it here is cheaper than widening
// Entity to store it. Because both the fence and reset() call this, they can
// never disagree about where home is.
//
// How IC_GRID divides the world: the number of cells across and down.
//
// Split out of initial_position so COHORT FENCES can size itself from the same
// numbers the layout uses. The fence radius is half a cell (see the fence block
// in entity_update), and "half a cell" is only the right answer if it is half of
// THE cell this function laid out -- so the two must read from one place. Duplicating
// the cols/rows expression would let a future change to the layout silently
// stop the fences from touching.
//
// One cell per cohort, laid out so the cells come out roughly SQUARE: for n
// cohorts in a box of aspect a, that wants sqrt(n*a) columns. (Using n*a rather
// than sqrt(n)*a is the difference between a grid and a single wide strip on a
// wide canvas.)
fn grid_cells(cohorts: i32, extent: vec2f) -> vec2f {
    let cols = max(1.0, round(sqrt(f32(cohorts) * extent.x / extent.y)));
    return vec2f(cols, ceil(f32(cohorts) / cols));
}

// Every mode starts from the same small per-cohort jitter, then places it.
// Grid and Ring are expressed in world extent rather than the reference's
// inline aspect fudge, so they stay correct on a non-square canvas.
fn initial_position(index: u32, config: ConfigData) -> vec2f {
    let cohort_val = get_cohort(index, config, arrayLength(&entities));
    let extent = world_half_extent_from_res(canvas_res());

    // vec2(x) in GLSL is a SPLAT, not a (x, 0) constructor -- vec2f(x) here
    // means the same thing. `index` is a u32 promoted to float by GLSL.
    var pos = 0.019 * vec2f(hash(vec2f(cohort_val)),
                            hash(vec2f(cohort_val + f32(index) + 2.142)));

    let mode = cfg_initial_conditions(config);
    let cohorts = max(1, cfg_cohorts(config));

    if (mode == IC_GRID) {
        let cells = grid_cells(cohorts, extent);
        let cols = cells.x;
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
    let cohort_val = get_cohort(index, config, arrayLength(&entities));

    let pos = initial_position(index, config);
    let vel = 0.00005 * (vec2f(hash(vec2f(cohort_val, f32(index))),
                               hash(vec2f(cohort_val, pos.y))) * 2.0 - 1.0);

    // store to persistent entity buffer
    entities[index] = make_entity_reset(pos, vel, size, assign_config_index(index));
}

// mutate_rule now lives in rule.wgsl, beside the generate-or-mutate branch that
// chooses between it and generate_random_centers.

// Gravity-like force expansion: maps a linear -1..1 slider (gravity_force /
// gravity_strafe) to a logarithmic physical force, so a small knob covers a
// wide range. Odd-symmetric, with a dead zone near centre that means exactly
// no gravity.
//
//   physical = sign(c) * MAXV * 10^(DECADES*(|c|-1))   for |c| > KNEE
//   physical = 0                                       for |c| <= KNEE
//
// ## THE CLAMP IS LOAD-BEARING
//
// A config may legitimately hold a value outside the slider's bounds
// (`gating.ts:46-50` -- `position()` clamps the POSITION, never the value), and
// a hand-edited save file or a typed field can put one there. Unclamped,
// pow(10, DECADES*(a-1)) with a >> 1 overflows to Inf, and Inf * a zeroed
// gravity_dir is NaN -- which poisons that particle's position permanently and
// takes a restart to clear. Clamping the input costs one instruction and closes
// the whole class.
//
// ## THE DEAD ZONE IS A HARD ZERO, not a ramp
//
// It used to ramp linearly from 0 at c == 0 up to the knee value, which reaches
// exactly 0 only at exactly 0.0. Every slider position NEAR zero therefore
// still applied a small pull, which is not what a control sitting visually at
// centre should do. A dead zone that means "no gravity" has to actually be one.
//
// That makes the curve discontinuous at |c| == KNEE, stepping to
// MAXV*10^(DECADES*(KNEE-1)) -- with the constants below, ~6e-5, which is far
// below what is visible in a frame. Widen GRAVITY_DECADES before restoring the
// ramp if that step ever becomes noticeable.
const GRAVITY_MAXV: f32    = 0.5;   // physical value at |control| = 1
const GRAVITY_DECADES: f32 = 4.0;   // log span: MAXV .. MAXV/10^DECADES
const GRAVITY_KNEE: f32    = 0.05;  // |control| at or below this is exactly 0
fn gravity_expand(c: f32) -> f32 {
    let cc = clamp(c, -1.0, 1.0);
    let a = abs(cc);
    if (a <= GRAVITY_KNEE) {
        return 0.0;
    }
    return sign(cc) * GRAVITY_MAXV * pow(10.0, GRAVITY_DECADES * (a - 1.0));
}

// Used to enforce left-right symmetry in the local coordinates vec2(forward, left).
fn y_reflect(p: vec2f) -> vec2f {
    return p * vec2f(1.0, -1.0);
}

// Somewhat arbitrary generator of functions with 4 float inputs and 4 float outputs,
// varying rule should smoothly change the behavior of black box. Here, we use fourier noise.
//
// Evaluated for the base signal (L, R) and the mirrored one together -- see
// fourier_noise_pair for why they share one pass.
fn black_box_pair(L: vec2f, R: vec2f, L_mirror: vec2f, R_mirror: vec2f,
                  slot: i32) -> FourierPair {
    return fourier_noise_pair(slot, vec4f(L, R), vec4f(L_mirror, R_mirror));
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
// --slot: the config slot whose (already mutated) rule dictates entity behavior.
fn calculate_entity_behavior(L_in: vec2f, R_in: vec2f, axis: vec2f, slot: i32,
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
    let terms = black_box_pair(L, R, y_reflect(R), y_reflect(L), slot);
    let baseterm = terms.base;
    let mirrorterm = terms.mirror;

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

// EXPERIMENT: EXP_SLIM_CONFIG. The whole-struct load below copies the 320-byte
// Rule into a local that is then passed by value, which is the shape the
// black box note above measured at ~5x on some compilers. Nothing here reads
// `config.rule`, so a zeroed Rule changes no behaviour.
fn load_config(slot: i32) -> ConfigData {
    if (EXP_SLIM_CONFIG) {
        return ConfigData(Rule(), configs[slot].sensor, configs[slot].force,
                          configs[slot].misc, configs[slot].force2,
                          configs[slot].misc2, configs[slot].misc3);
    }
    return configs[slot];
}

// WORKGROUP SIZE -- EXP_WORKGROUP_SIZE, default 256, which must match
// WORKGROUP_SIZE in dispatch.ts; the host divides by whatever the experiment
// sets. These live in different files and drifting them under-dispatches
// silently, leaving a tail of entities frozen; shaders.test.ts asserts they agree.
@compute @workgroup_size(EXP_WORKGROUP_SIZE)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let index = gid.x;
    if (index >= arrayLength(&entities)) { return; }

    // EXPERIMENT: the early outs. Both still run the RESET FRAME, or every
    // particle stays stacked where the buffer was zeroed -- a pile-up that makes
    // the brush splat pathologically slow and skews every other reading. This
    // whole block returns, so the physics below it is compiled out.
    if (EXP_EARLY_OUT != 0u) {
        if (frame_count() == 0) {
            if (!e_is_dead(entities[index])) {
                let reset_slot = clamp(assign_config_index(index), 0,
                                       world_config_count(u.world) - 1);
                reset(index, load_config(reset_slot));
            }
            return;
        }
        // 1 -- what the pass costs doing nothing.
        if (EXP_EARLY_OUT == 1u) { return; }
        // 2 -- the read and the write, with a move between so the compiler
        // cannot drop the store as rewriting what was loaded.
        let moved = entities[index];
        entities[index] = make_entity(world_wrap(e_pos(moved) + e_vel(moved), canvas_res()),
                                      e_vel(moved), e_size(moved), e_config_index(moved),
                                      e_col_params(moved));
        return;
    }

    let e = entities[index];

    let fc = frame_count();

    // DEAD PARTICLES COST ONE READ AND A BRANCH, and nothing else. This is the
    // whole of "only pay for living particles" in the update path: no sensor
    // taps, no rule derivation, no black box evaluation.
    //
    // ABOVE THE CONFIG LOOKUP DELIBERATELY. That line clamps config_index into
    // range, which would turn a dead particle's -1 into config 0 and run a full
    // physics step on it -- the particle would be invisible (the renderers cull
    // it) while still depositing trails and burning a full step's work. The
    // clamp is right for its own job (a shrunk ConfigBuffer degrades gracefully)
    // so this test goes above it rather than replacing it.
    //
    // NOT GUARDED ON fc == 0. On a reset frame the studio rebuilds every entity
    // below, and a dead particle must NOT be resurrected by that path -- the
    // sand modality restores to frame 1 precisely so it never runs, but a stray
    // frame 0 must leave the dead dead rather than repopulating the world.
    if (e_is_dead(e)) { return; }

    // Select this entity's config. On a reset frame the entity's stored
    // config_index is not yet meaningful (nothing has been written), so ask
    // assign_config_index() directly rather than reading it back.
    //
    // The studio re-assigns on EVERY step, not just this one -- see
    // assign_config_index for why its slot cannot be stored.
    let config_index = select(e_config_index(e), assign_config_index(index),
                              fc == 0 || CONFIG_PER_COHORT);
    let slot = clamp(config_index, 0, world_config_count(u.world) - 1);
    let config = load_config(slot);

    let sqrt_world_size = world_sqrt_world_size(u.world);
    let canvas_resolution = canvas_res();

    let cohort = get_cohort(index, config, arrayLength(&entities));
    // Hazard Rate == probability each frame to reset this particle
    let hazard_reset = !EXP_NO_EXTRAS && cfg_hazard_rate(config)
        > hash(vec2f(f32(index) / f32(arrayLength(&entities)), f32(fc)));

    // frame_count == 0 signals a simulation reset
    if (fc == 0 || hazard_reset) { reset(index, config); return; }

    var pos = e_pos(e);
    var vel = e_vel(e);

    // THE STALLED-PARTICLE RESCUE.
    //
    // A particle's heading IS its velocity: `orientation` below is
    // `safenorm(vel)`, which returns vec2(0) at zero. Both sensor offsets then
    // collapse onto the particle itself, so it samples the same texel twice,
    // `calculate_entity_behavior` gets a zero `axis` and builds a degenerate
    // frame, and the force it produces cannot restore a direction it no longer
    // has. The particle is stuck for good -- it never moves again, and nothing
    // in the simulation can dislodge it.
    //
    // Reachable from two directions. Drag compounds every step, so any particle
    // whose rule stops driving it decays toward zero and eventually underflows;
    // and anything that CREATES a particle at rest starts it there (the sand
    // modality's spawn brush does exactly that, which is how this was found).
    //
    // So: below a floor, give it a random heading at that floor's magnitude.
    // Cheaper than the alternative of special-casing the degenerate frame
    // downstream, and it fixes the cause rather than one of its symptoms.
    //
    // MIN_VELOCITY is `reset()`'s own spawn magnitude, so a rescued particle is
    // indistinguishable from a freshly reset one -- a number this file already
    // chose for the job of "moving enough to have a direction".
    //
    // Seeded on (index, frame) like the sensor jitters, so two particles at the
    // same spot get different headings and one particle re-rolls if it stalls
    // again. Note this runs BEFORE the sensors read, so the rescue takes effect
    // on the very step it fires rather than the next one.
    if (!EXP_NO_EXTRAS && length(vel) < MIN_VELOCITY) {
        let kick = hash(vec2f(f32(index) + 7.77, f32(fc))) * 2.0 * PI;
        vel = MIN_VELOCITY * vec2f(cos(kick), sin(kick));
    }

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
    if (!EXP_NO_EXTRAS && angle_jitter != 0.0) {
        angle += angle_jitter * (2.0 * hash(vec2f(f32(index), f32(fc))) - 1.0);
    }
    let distance_jitter = cfg_sensor_distance_jitter(config);
    if (!EXP_NO_EXTRAS && distance_jitter != 0.0) {
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

    // Which way is "down", for all three gravity channels. Taken here rather than
    // beside the two motion channels below because the trails channel needs it
    // NOW, to bias the reads on the next line.
    let gravity_dir = gravity_direction(pos, config);

    // GRAVITY (TRAILS): a constant added to what the sensors report, negated on
    // the same convention as the other two so a positive slider means "down".
    //
    // ONE BIAS FOR BOTH SENSORS. Left and right get the identical vector, which
    // is what makes it a bias rather than a steer: an asymmetric one would push
    // every particle to one side, reintroducing exactly the handedness that
    // y_reflect in calculate_entity_behavior exists to cancel.
    //
    // DIVIDED BY sqrt_world_size, to CANCEL the multiply in `sensor_scaling`.
    //
    // This is not the same 1/sqrt_world_size the two motion channels apply, and
    // it is not applied for the same reason -- it is the inverse of a term this
    // value is about to be multiplied by, and it exists to make the bias
    // world-invariant like the other two gravity channels.
    //
    // WHY THE MULTIPLY IS RIGHT FOR EVERYTHING ELSE. `sensor_scaling` below is
    // `sqrt_world_size * 38.855 * gain`. The canvas is a DENSITY: the same
    // population spread over a larger world lays fainter trails per texel, so a
    // real reading dilutes as the world grows and the multiply is what undoes
    // that. Sensor readings therefore stay world-invariant.
    //
    // A CONSTANT HAS NOTHING TO DILUTE. `trail_bias` is not sampled from the
    // canvas -- it is a fixed vector added at the same point (see `get_can`), so
    // it never shrank in the first place. Riding the multiply unopposed made
    // Gravity (Trails) grow as sqrt_world_size while Gravity (Force) and Gravity
    // (Strafe) shrank as 1/sqrt_world_size, leaving the trails channel scaling
    // with world size where the other two are invariant.
    //
    // Dividing here rather than moving the addition after `sensor_scaling` keeps
    // Sensor Gain applying to the bias, which is deliberate -- see `get_can`.
    let trail_bias = select(
        -gravity_expand(cfg_gravity_trails(config)) * gravity_dir / sqrt_world_size,
        vec2f(0.0), EXP_NO_EXTRAS);

    // Read the trails from canvas.
    let bc = world_boundary_conditions(u.world);
    var ltap = get_can(pos + left_sensor_offset, bc, trail_bias);
    var rtap = get_can(pos + right_sensor_offset, bc, trail_bias);

    // NO RULE DERIVATION HERE. The generate-or-mutate branch runs once per
    // config slot in cohortRules.wgsl, and the black box below reads the result
    // out of the slot. Calling derive_entity_rule here again would mutate an
    // already-mutated rule; shaders.test.ts asserts it stays out.

    // Rescale sensor values.
    let sensor_scaling = sqrt_world_size * 38.855 * cfg_sensor_gain(config);
    ltap *= sensor_scaling;
    rtap *= sensor_scaling;

    // Compute entity action.
    let behavior = calculate_entity_behavior(ltap.xy, rtap.xy, orientation, slot, config);
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

    // Uniform pull on the whole population, in the two MOTION channels: _force
    // feeds velocity (after drag, so drag does not damp it away the same frame),
    // _strafe displaces position directly. Negated so a positive slider pulls
    // DOWN the screen. Scaled by 1/sqrt_world_size like every other force here,
    // so the feel survives a World Size change.
    //
    // The third channel, _trails, is not here and is not a motion: it biases the
    // sensor read far above, so the particle is persuaded rather than pushed.
    //
    // Which way is "down" is one direction shared by all three channels, taken
    // once by `gravity_direction` so they can never disagree about it. Computed
    // further up, because the third channel (Trails) biases the sensor read and
    // so needs it before this point -- see the call there.
    if (!EXP_NO_EXTRAS) {
        vel += 0.01 / sqrt_world_size * -gravity_expand(cfg_gravity_force(config)) * gravity_dir;
    }

    // Move: add vel and strafe to pos.
    pos += vel;
    pos += strafe * cfg_strafe_power(config);
    if (!EXP_NO_EXTRAS) {
        pos += 0.01 / sqrt_world_size * -gravity_expand(cfg_gravity_strafe(config)) * gravity_dir;
    }

    // The painted WALLS layer, in the strafe channel: a displacement, not a
    // force, so no rule can resist it and drag never damps it. Applied before
    // the fence and the boundary so containment still gets the last word --
    // you can paint a particle against a wall, not through it.
    //
    // Deliberately NOT scaled by 1/sqrt_world_size, unlike every force above
    // it. Those are tuned in world units and must shrink as the world grows;
    // this is painted in uv space and read in uv space, so it already tracks
    // canvas size. Dividing again would make an identical stroke weaker in a
    // bigger world for no reason the user could see.
    //
    // The gain that used to be here is now inside `get_walls`, folded into the
    // Walls Field Strength preference -- see that function.
    if (!EXP_NO_EXTRAS) { pos += get_walls(pos, bc); }

    // The Shove tool, in the same channel and for the same reasons: a
    // displacement, so drag cannot damp it and no rule can resist a direct push.
    // Also before the fence and the boundary, so containment still gets the last
    // word -- you can shove a particle against a wall, not through it.
    //
    // Already scaled down by the physics rate on the host, so raising the rate
    // does not multiply the shove by the sub-step count. Without that, the
    // Physics Rate slider would silently be a strength slider too -- the trap
    // the Draw brush's once-per-frame cadence exists to avoid.
    //
    // The host divides by `steps ** 0.75` rather than `steps`, deliberately
    // leaving the brush relatively stronger at low rates. Nothing here depends
    // on which: this reads one number per sub-step either way. See
    // `shoveCommands.shoveState` for the tuning argument.
    if (!EXP_NO_EXTRAS) { pos += get_shove(pos); }

    // Cohort Fences: hold each particle near its own spawn point, so cohorts
    // stay legible instead of dispersing into each other. A soft wall -- it
    // pushes back in both motion channels rather than hard-clamping, so a
    // particle can still lean on the fence and be shaped by it.
    //
    // ON/OFF ONLY -- the radius is DERIVED, not dialled. It is half of the
    // smaller side of an IC_GRID cell, which is exactly the radius at which
    // neighbouring cohorts' fences just barely touch: cells are 2*extent/cells
    // apart centre to centre, so half of that is the largest circle that does
    // not overlap the next one. The tightness therefore tracks the cohort count
    // on its own -- more cohorts means smaller cells means smaller fences, and
    // they stay touching the whole way. A user-facing radius could only get
    // this wrong (overlapping blobs, or gaps the layout did not intend), which
    // is why the slider became a checkbox.
    //
    // GRID ONLY. The derivation needs a known distance to the next cohort, and
    // only IC_GRID has one: IC_RANDOM scatters cohort centres by hash, IC_CENTER
    // stacks every cohort on the same point (spacing zero), and IC_RING spaces
    // them along a circle rather than in cells. Rather than invent a radius for
    // those, the feature switches off -- and the UI greys the checkbox out in
    // those modes so the reason is visible rather than mysterious.
    let fences = cfg_cohort_fences(config);
    if (!EXP_NO_EXTRAS && fences && cfg_initial_conditions(config) == IC_GRID) {
        let extent = world_half_extent_from_res(canvas_resolution);
        let cells = grid_cells(max(1, cfg_cohorts(config)), extent);
        let cell_size = 2.0 * extent / cells;
        let radius = 0.5 * min(cell_size.x, cell_size.y);
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
    // BC_KILL -- BC_RESET's sibling, differing only in what becomes of the
    // particle that crossed. Rather than being respawned at its initial
    // position, it dies: marked dead and its index returned to the pool.
    //
    // THE ONE PLACE THE FREE LIST IS TOUCHED INSIDE advance(). It only ever
    // PUSHES (atomicAdd), which is the same direction the deletion pass moves
    // the head, so the two compose even though they run at different cadences.
    // Nothing here may take a slot -- see the header of freeList.wgsl.
    //
    // The push happens BEFORE the entity is zeroed, so a reader that races this
    // sees either a live particle or a dead one, never a live index sitting on
    // the free list.
    else if (bc == BC_KILL) {
        if (any(abs(pos) > world_half_extent_from_res(canvas_resolution))) {
            free_list_give(index);
            entities[index] = make_entity_dead();
            return; // the entity buffer is written above
        }
    }

    // Commit new entity state to buffers.
    entities[index] = make_entity(pos, vel, e_size(e), config_index, col_params);
}
