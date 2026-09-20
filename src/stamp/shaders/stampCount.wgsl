// ============================================================================
// stampCount.wgsl -- pass 1 of 3. How many particles each workgroup contributes.
//
// The same shape as `compactCount.wgsl`, with ONE DIFFERENCE: the predicate is
// "live AND inside the box" rather than "live". Everything else -- the
// workgroup size, the partition, the reduction -- is identical, because the
// scan that consumes these partials is literally the same shader and the same
// host-side arithmetic (`compactPlan.ts`).
//
// ---------------------------------------------------------------------------
// WHY A COUNT PASS AT ALL, RATHER THAN AN ATOMIC COUNTER
// ---------------------------------------------------------------------------
// An atomic append would be one pass instead of three and would produce the
// particles in NON-DETERMINISTIC ORDER: workgroups finish in whatever order the
// hardware schedules them.
//
// For a stamp that is not a cosmetic concern. The whole-scene capture is meant
// to round-trip bit-identically -- save a world, load it, get the same scene --
// and an order that varies per capture means the same world saved twice
// produces two different files. It also makes a diff between two world saves
// meaningless, and makes the restore path untestable by comparison.
//
// A prefix sum gives each particle a destination determined entirely by its
// source index, so the output is a deterministic function of the input. That is
// worth two extra passes over a buffer the compaction already sweeps four times.
// ============================================================================

#include "common.wgsl"
#include "stampBox.wgsl"

@group(0) @binding(0) var<storage, read>       entities : array<Entity>;
@group(0) @binding(1) var<storage, read_write> partials : array<u32>;
@group(0) @binding(2) var<uniform>             u        : StampUniforms;

fn entity_count() -> u32 { return u.params.x; }

var<workgroup> tally : array<u32, 256>;

@compute @workgroup_size(256)
fn main(
    @builtin(global_invocation_id) gid : vec3u,
    @builtin(local_invocation_id)  lid : vec3u,
    @builtin(workgroup_id)         wid : vec3u,
) {
    let index = gid.x;
    let local = lid.x;

    // A VALUE, NOT AN EARLY RETURN: every invocation must reach the barriers
    // below, and a workgroup whose tail returned early would deadlock on them.
    var hit = 0u;
    if (index < entity_count()) {
        let e = entities[index];
        // DEAD FIRST. `e_is_dead` must be tested before anything reads the
        // particle's position as meaningful -- a dead slot's position is
        // whatever was left there, and could easily fall inside the box.
        if (!e_is_dead(e) && stamp_box_contains(stamp_src_min(u), stamp_src_max(u), e_pos(e))) {
            hit = 1u;
        }
    }
    tally[local] = hit;

    // THE HALVING REDUCTION, byte-for-byte the shape `compactCount.wgsl` uses.
    // Every invocation executes every iteration and every barrier; only the
    // WRITE is conditional, which is what keeps the barriers uniformly reached.
    // A `return` before a `workgroupBarrier` is undefined behaviour in WGSL,
    // and the last workgroup of a ragged buffer hits that path every time.
    for (var stride = 128u; stride > 0u; stride >>= 1u) {
        workgroupBarrier();
        if (local < stride) {
            tally[local] = tally[local] + tally[local + stride];
        }
    }
    workgroupBarrier();

    if (local == 0u) {
        partials[wid.x] = tally[0];
    }
}
