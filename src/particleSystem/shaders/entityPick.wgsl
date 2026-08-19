// ============================================================================
// entityPick.wgsl -- find the entity nearest a target, and derive its rule.
//
// The WGSL translation of `particle_system/shaders/entity_pick.glsl` (87 lines),
// plus the rule derivation that file does not have. Structure and comments
// follow it so the two stay diff-comparable.
//
// ---------------------------------------------------------------------------
// THE ATOMIC TRICK (unchanged from the GLSL)
// ---------------------------------------------------------------------------
// There is no atomicMin for floats, so distance is packed into the high bits of
// a u32 and the entity index into the low bits:
//
//     key = (quantized_distance << INDEX_BITS) | entity_index
//
// A single atomicMin over that key minimizes distance first and breaks ties by
// lowest index -- deterministic, which matters because otherwise the same click
// could select different particles on different frames.
//
// WHERE THE 32 BITS GO: 24 to the index, 8 to the distance. The index is the
// part that must not overflow -- an entity past INDEX_MASK cannot be encoded,
// so it silently stops being pickable, which reads as "the last cohorts don't
// respond to clicks" rather than as a bug. 24 bits covers 16.7M entities, well
// past any world size the UI offers. pick.test.ts asserts that bound.
//
// The distance gets what is left because its precision barely matters: 256
// buckets across the radius only decides which of two near-equidistant
// particles wins, and a tie is broken by lowest index -- still deterministic,
// which is the property that actually matters.
//
// ---------------------------------------------------------------------------
// WHY TWO ENTRY POINTS, AND WHY TWO SEPARATE PASSES
// ---------------------------------------------------------------------------
// `reduce` finds the winner. `derive` writes its rule and position.
//
// They cannot be one pass. A thread that LOSES the atomicMin still executes its
// next instruction, so if the reducing threads also wrote the rule, a loser
// could overwrite the winner's -- which is exactly why the desktop keeps the
// index authoritative and puts nothing else in the result buffer
// (entity_pick.glsl:43-47). Deriving from a single invocation, after the atomic
// has settled, is what makes writing the rule safe at all.
//
// They also cannot be two dispatches in ONE compute pass: WebGPU orders passes
// within a submission and inserts the barriers between them, but dispatches
// inside a single pass have no ordering guarantee, so `derive` would race the
// reduction it depends on. Two beginComputePass calls. See particleSystem.ts.
//
// ---------------------------------------------------------------------------
// WHY THE RULE IS DERIVED HERE AT ALL
// ---------------------------------------------------------------------------
// The rule is not stored anywhere: Entity is 32 bytes (pos_vel + misc) and
// entityUpdate re-derives the rule every step and discards it. The desktop
// therefore recomputes it HOST-SIDE in float32 (particle_system/mutation.py) to
// avoid a readback. That file is deliberately not ported -- JS has no float32
// arithmetic, and mutation.py:149's pow(h, 2.0) trap has no reliable JS
// equivalent. A wrong adopted rule looks like a legitimate result.
//
// So the GPU derives it, through the SAME derive_entity_rule() that
// entityUpdate.wgsl calls (rule.wgsl). Not a copy -- the same function.
// ============================================================================

#include "common.wgsl"
#include "rule.wgsl"

// --- bindings --------------------------------------------------------------
// Bindings 0 and 1 are fixed project-wide -- see the table in common.wgsl.
// Binding 2 is the pick result, mirroring PICK_RESULT_BINDING in picker.py:41
// and entity_pick.glsl:48.
//
// `entities` is READ-ONLY here, unlike entityUpdate.wgsl's read_write. That is
// not incidental: rule.wgsl is shared between the two shaders, so nothing in it
// may name this binding -- which is why get_cohort takes the entity count as a
// parameter instead of calling arrayLength() itself.

@group(0) @binding(0) var<storage, read> entities : array<Entity>;
@group(0) @binding(1) var<storage, read> configs  : array<ConfigData>;

// The result. 336 bytes; the layout is mirrored in pick.ts, which asserts it.
//
//   key   : atomic<u32>  offset 0
//   pos_x : f32          offset 4    <- both ride in the 12 bytes of padding
//   pos_y : f32          offset 8       that Rule's 16-byte alignment forces,
//   _pad  : u32          offset 12      so the position costs nothing
//   rule  : Rule         offset 16
//
// POSITION IS TWO f32s, NOT A vec2f, AND THAT IS THE WHOLE POINT. `vec2f` has
// ALIGNMENT 8, so it cannot start at offset 4 -- WGSL would push it to 8, the
// cohort to 16 and `rule` to 32, making the struct 352 bytes and the position
// cost a full 16-byte lane after all. Two f32s align to 4 and genuinely fit in
// the hole. (Measured: the driver rejected the 336-byte buffer as "too small,
// the pipeline requires 352" when this was a vec2f.)
//
// `cohort` FILLS WHAT WAS PADDING, at no cost. Offset 12 was `_pad : u32` --
// dead space Rule's 16-byte alignment forces to exist whether or not anything
// is written there. The cohort highlight needs to compare which COHORT two
// successive picks landed on, and the host cannot recompute it: get_cohort
// divides by arrayLength(&entities), and reproducing that host-side is the same
// class of mistake as reproducing the rule (see the header). So the shader
// reports it, and the struct is still 336 bytes.
struct PickResult {
    key    : atomic<u32>,
    pos_x  : f32,
    pos_y  : f32,
    cohort : f32,
    rule   : Rule,
}
@group(0) @binding(2) var<storage, read_write> result : PickResult;

struct PickUniforms {
    world  : WorldData,
    // xy: target (world space)   z: max_dist   w: reserved
    params : vec4f,
}
@group(0) @binding(3) var<uniform> u : PickUniforms;

// `pick_target`, not `target`: TARGET IS A RESERVED KEYWORD IN WGSL. The GLSL
// spells this uniform `target` (entity_pick.glsl:52) and the obvious
// translation does not compile -- a browser-only error, since nothing in
// `npm test` parses WGSL.
fn pick_target() -> vec2f { return u.params.xy; }
fn max_dist() -> f32 { return abs(u.params.z); }

/**
 * CONFIRM MODE: restrict the search to the highlighted cohort.
 *
 * Carried as the SIGN of `max_dist` rather than a new lane, because the two
 * facts are inseparable -- a confirm is always "this cohort, anywhere" and never
 * has a meaningful radius -- and because distance is only ever compared as a
 * magnitude, so the sign bit was doing nothing.
 *
 * ## Why this exists rather than a very large radius
 *
 * The keyboard confirm first tried to reach every member of the cohort by
 * passing a radius that spanned the world, on the theory that the confirmation
 * snap below would then pick one of them. It does not work, and the way it fails
 * is instructive: `dist_norm` is `distance / limit`, so a limit of 100 against
 * distances of ~1 quantizes EVERY particle in the world into bucket 0. The key
 * degenerates to the raw index, `atomicMin` returns the lowest index in the
 * world, and `get_cohort` is monotonic in index -- so the winner was always in a
 * LOW-numbered cohort. Confirming cohort 20 silently re-aimed to cohort 12.
 *
 * The snap could not save it: it sets `dist_norm = 0` for cohort members, but
 * the huge radius had already set everyone to 0. Filtering is the operation that
 * was actually wanted, and distance was the wrong instrument for it.
 */
fn confirm_only() -> bool { return u.params.z < 0.0; }

// The cohort the user is currently aiming at, or negative when none is. Rides
// the lane the GLSL left reserved. Floored host-side, matching `col_params.y`
// and the derive pass below, so `==` between them is exact.
fn highlighted_cohort() -> f32 { return u.params.w; }

// How close a member of the highlighted cohort has to be, as a FRACTION OF THE
// PICK RADIUS, before the reduce pass treats it as a direct hit.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// Confirming a cohort means clicking any of its members a second time. But the
// members are scattered among everything else, so a click aimed at one of them
// often lands with some unrelated particle a few pixels nearer -- and a plain
// nearest-wins reduce hands the pick to that interloper. What the user sees is
// their confirmation silently re-aiming the highlight at a cohort they were not
// pointing at, which is the single most annoying way this feature can fail.
//
// So a highlighted-cohort particle inside this radius gets its distance clamped
// to zero: it enters the atomicMin at the very bottom of the key space and wins
// against anything that is merely closer. Ties among several such particles fall
// through to the index tie-break, which is deterministic (see the header).
//
// ---------------------------------------------------------------------------
// WHY 0.5 AND NOT SOMETHING ELSE
// ---------------------------------------------------------------------------
// The pick radius is 40 screen pixels (DEFAULT_PICK_RADIUS_PX), so this is 20px
// -- roughly a fingertip's worth of aim, and about the distance at which a user
// would say they were "clicking that particle" rather than near it.
//
// The trade is symmetric and worth stating in both directions. Too LARGE and a
// deliberate re-aim at a neighbouring cohort gets swallowed: you click a
// different particle, and a highlighted one half a radius away wins anyway, so
// the highlight appears stuck. Too SMALL and the feature does nothing, because
// the interloper cases it exists for are exactly the ones where a rival is
// within a few pixels. Half the radius keeps a re-aim working everywhere in the
// outer half of the pick circle while covering the near-miss case completely.
//
// PRIORITY IS NOT UNCONDITIONAL, and that is the point of having a radius at
// all: outside it a highlighted particle competes on its true distance like
// everything else, so clicking well away from the cohort still re-aims. A
// version without the radius would make the highlighted cohort win every pick
// anywhere on screen, and the highlight could never be moved by clicking.
const CONFIRM_SNAP_FRACTION: f32 = 0.5;

// The distance that saturates the key's buckets in CONFIRM MODE, in world units.
//
// A FIXED REFERENCE, not the pick radius: confirm mode has no meaningful radius
// (it searches the whole world), and normalising by one is exactly the mistake
// that made every particle land in bucket 0 -- see `confirm_only`.
//
// 2.0 spans world space, whose half-extent is ~1 per axis, so the buckets are
// spread across the range distances actually occupy. Anything beyond saturates
// to the last bucket and ties break on index, which is harmless: every candidate
// here is already a member of the right cohort, so the worst case is adopting
// the rule of a cohort-mate further from the centre than another.
const CONFIRM_DIST_SCALE: f32 = 2.0;

// --- the key ---------------------------------------------------------------
// Mirrored in pick.ts; pick.test.ts parses THIS FILE for the two bit counts and
// asserts they match, as tests/test_async_pick.py:65 does against the GLSL.
const INDEX_BITS: u32 = 24u;
const INDEX_MASK: u32 = (1u << INDEX_BITS) - 1u;
const DIST_BITS:  u32 = 8u;           // 256 distance buckets across the radius
const DIST_MAX:   u32 = (1u << DIST_BITS) - 1u;

// Written by the host before every dispatch. atomicMin only ever LOWERS, so a
// stale winner would beat every candidate forever if this were not reset.
const NO_HIT: u32 = 0xFFFFFFFFu;

//=========================================================================================
// PASS A -- reduce
//=========================================================================================

@compute @workgroup_size(256)
fn reduce(@builtin(global_invocation_id) gid: vec3u) {
    let index = gid.x;
    if (index >= arrayLength(&entities)) { return; }
    if (index > INDEX_MASK) { return; }   // beyond what the key can encode

    let e = entities[index];
    let pos = e_pos(e);

    // Straight-line, deliberately NOT toroidal. Picking is a UI affordance, and
    // the wrap only changes the answer for a click within a particle radius of
    // the seam -- not worth threading the boundary mode down here, and wrong in
    // every mode but BC_WRAP anyway.
    let d = pick_target() - pos;
    let dist_sq = dot(d, d);
    let limit = max_dist();

    // CONFIRM MODE FILTERS BY COHORT AND IGNORES THE RADIUS ENTIRELY. The
    // keyboard confirm has no cursor, so "near the target" is not the question
    // being asked -- "is this the cohort the user is looking at" is. See
    // `confirm_only`.
    //
    // The cohort is derived EXACTLY as the derive pass and entityUpdate do --
    // same `get_cohort`, same config selection, same clamp bound, same floor.
    // Any divergence would select from a different set than the one the shader
    // draws bright, and the two would disagree while both looked internally
    // consistent.
    if (confirm_only()) {
        // The cohort filter applies only when there IS a highlighted cohort.
        // With none -- one-click selection, or a single-cohort config -- every
        // particle is a candidate and the nearest to the target wins, which is
        // what a click at that point would have adopted. Returning early here
        // instead would make Enter find nothing in exactly the configurations
        // that have no other keyboard route.
        if (highlighted_cohort() >= 0.0) {
            let config_index = e_config_index(e);
            let config = configs[clamp(config_index, 0, world_config_count(u.world) - 1)];
            let cohort = floor(get_cohort(index, config, arrayLength(&entities)));
            if (cohort != highlighted_cohort()) { return; }
        }

        // Among the cohort's members, the one NEAREST THE TARGET wins, so the
        // adopted rule comes from a particle near the middle of the view rather
        // than from whichever happens to hold the lowest index. Quantized
        // against a fixed reference -- the radius is meaningless here, and
        // dividing by it is what collapsed every bucket to 0 in the version this
        // replaces.
        let dist_q_confirm = u32(clamp(sqrt(dist_sq) / CONFIRM_DIST_SCALE, 0.0, 1.0)
                                 * f32(DIST_MAX));
        atomicMin(&result.key, (dist_q_confirm << INDEX_BITS) | index);
        return;
    }

    if (dist_sq > limit * limit) { return; }   // outside the radius

    // Quantize distance into the high bits. Using the actual distance (not the
    // square) spreads the buckets evenly in the units the user perceives.
    var dist_norm = sqrt(dist_sq) / limit;               // [0,1]

    // THE CONFIRMATION SNAP. A member of the highlighted cohort, close enough
    // that the click plausibly meant it, is treated as a direct hit so no merely
    // nearer interloper can steal the confirmation. See CONFIRM_SNAP_FRACTION.
    if (highlighted_cohort() >= 0.0 && dist_norm <= CONFIRM_SNAP_FRACTION) {
        let config_index = e_config_index(e);
        let config = configs[clamp(config_index, 0, world_config_count(u.world) - 1)];
        let cohort = floor(get_cohort(index, config, arrayLength(&entities)));
        if (cohort == highlighted_cohort()) { dist_norm = 0.0; }
    }

    let dist_q = u32(clamp(dist_norm, 0.0, 1.0) * f32(DIST_MAX));

    let key = (dist_q << INDEX_BITS) | index;
    atomicMin(&result.key, key);
}

//=========================================================================================
// PASS B -- derive
//=========================================================================================

// ONE INVOCATION. @workgroup_size(1) is load-bearing: at 256 every thread in
// the group would race to write the same rule to the same 320 bytes. It would
// probably even LOOK correct, since they all compute the same value -- which is
// why shaders.test.ts asserts the 1 rather than trusting review.
//
// The host dispatches this only after `reduce` has finished in a separate pass,
// so `result.key` is settled by the time it is read.
@compute @workgroup_size(1)
fn derive() {
    let key = atomicLoad(&result.key);
    // Nothing was in range. Leave pos and rule alone -- the host reads the
    // sentinel first and never looks at them.
    if (key == NO_HIT) { return; }

    let index = key & INDEX_MASK;
    if (index >= arrayLength(&entities)) { return; }   // paranoia; cannot happen

    let e = entities[index];

    // The winner's position, from THE SAME READ of the same record that the
    // rule below comes from. The desktop instead looks the position up
    // host-side from the index (picker.py:142-145), on the argument that the
    // index is authoritative so the two cannot disagree. That argument still
    // holds; this is simply stronger, and it saves a second readback.
    //
    // Note this does NOT reopen the "losers must not write" hazard above: that
    // applies to the reduce pass, where many threads compete. Here there is one
    // invocation and no competitor.
    let winner_pos = e_pos(e);
    result.pos_x = winner_pos.x;
    result.pos_y = winner_pos.y;

    // Select the config exactly as entityUpdate.wgsl:496-497 does, INCLUDING
    // the clamp bound -- a different bound could select a different ConfigData
    // than the physics used, and derive a rule the entity is not obeying.
    //
    // The frame-0 special case there (ask assign_config_index directly, because
    // nothing has been written yet) is not reproduced: a pick on frame 0 has
    // nothing meaningful to select anyway, and the entity's stored index is
    // valid on every frame a user could click.
    let config_index = e_config_index(e);
    let config = configs[clamp(config_index, 0, world_config_count(u.world) - 1)];

    // THE SAME FUNCTION entityUpdate.wgsl calls, from rule.wgsl. Not a copy.
    let cohort = get_cohort(index, config, arrayLength(&entities));
    result.rule = derive_entity_rule(config.rule, cohort, config);

    // FLOORED, because that is what cohort IDENTITY is. get_cohort returns a
    // CONTINUOUS ramp (rule.wgsl:120-122) -- two entities in the same cohort
    // have different raw values, so comparing them raw would say every pick
    // disagrees with every other and no cohort would ever highlight.
    // rule.wgsl:104 says floor() is the equality test, entityUpdate.wgsl:531
    // stores floor(cohort) into col_params.y for the same reason, and the
    // highlight compares this against THAT. All three must floor or the shader
    // dims a different set of particles than the host thinks it highlighted.
    result.cohort = floor(cohort);
}
