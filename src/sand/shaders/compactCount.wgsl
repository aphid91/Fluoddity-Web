// ============================================================================
// compactCount.wgsl -- pass 1 of 4. How many live entities per workgroup.
//
// Each workgroup tallies its own 256 entities and writes one number. The SCAN
// pass turns those tallies into running offsets, and the SCATTER pass uses an
// offset plus a within-group rank to place each live entity at a unique
// destination.
//
// ---------------------------------------------------------------------------
// WHY A PREFIX SUM AND NOT THE PROBE-AND-CLAIM THIS REPLACES
// ---------------------------------------------------------------------------
// The previous compaction found destinations by probing for dead slots with an
// atomic cursor. It worked, in the sense that particles ended up somewhere -- but
// it consumed free-list slots without ever telling the free list, so every
// relocation leaked one slot. At 158k live particles the audit found 69,184 dead
// indices missing from the pool, which surfaced as particles that could not be
// erased and a mark that would not come down.
//
// That was not a bug in the probing; it was a bug in the DESIGN. The pool had
// two writers -- GPU passes pushing and popping, and a host periodically
// overwriting it from a stale snapshot -- and no way for either to know what the
// other had done.
//
// A prefix sum removes the need to know. The destination of every entity is a
// pure function of how many live entities precede it, so the scatter assigns
// each index exactly once with no shared mutable state, no probing, and no
// coordination. The free list is then whatever is left over, which is exact by
// construction rather than by argument.
// ============================================================================

#include "common.wgsl"

@group(0) @binding(0) var<storage, read>       entities : array<Entity>;
// One u32 per workgroup. Sized by `partialCount()` host-side.
@group(0) @binding(1) var<storage, read_write> partials : array<u32>;

struct CompactUniforms {
    // x: entity count   yzw: reserved
    params : vec4u,
}
@group(0) @binding(2) var<uniform> u : CompactUniforms;

fn entity_count() -> u32 { return u.params.x; }

// Scratch for the reduction. 256 u32 -- one per invocation.
var<workgroup> tally : array<u32, 256>;

// WORKGROUP SIZE 256. `COMPACT_WORKGROUP_SIZE` in compactPlan.ts must match,
// and so must the scatter pass: the scatter reads the offset THIS workgroup
// produced, so a different partition would send it to the wrong partial and
// pack particles on top of each other. compactShaders.test.ts asserts all three.
@compute @workgroup_size(256)
fn main(
    @builtin(global_invocation_id) gid : vec3u,
    @builtin(local_invocation_id)  lid : vec3u,
    @builtin(workgroup_id)         wid : vec3u,
) {
    let index = gid.x;
    let local = lid.x;

    // Out-of-range invocations contribute zero rather than returning: every
    // invocation must reach the barriers below, and a `return` before a
    // `workgroupBarrier` is undefined behaviour in WGSL. The last workgroup of
    // a ragged buffer is exactly this case, so it is not a corner.
    var live = 0u;
    if (index < entity_count() && !e_is_dead(entities[index])) {
        live = 1u;
    }
    tally[local] = live;

    // Standard halving reduction. Every invocation executes every iteration and
    // every barrier; only the WRITE is conditional, which is what keeps the
    // barriers uniformly reached.
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
