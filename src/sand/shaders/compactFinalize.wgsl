// ============================================================================
// compactFinalize.wgsl -- pass 4 of 4. Publish the head and the mark.
//
// One invocation. It reads the grand total the scan produced and writes the two
// numbers that describe the compacted world:
//
//   * the free-list HEAD -- how many slots the scatter placed in the pool
//   * the MARK -- how far every pass must sweep, which for a packed buffer is
//     exactly the live count
//
// ---------------------------------------------------------------------------
// WHY THE MARK IS WRITTEN HERE AND READ BACK, RATHER THAN COMPUTED HOST-SIDE
// ---------------------------------------------------------------------------
// The host cannot know the live count without asking the GPU, and every past
// attempt to have it INFER one -- from a boundary, from a stale head, from a
// spawn tally -- produced a number that disagreed with the buffer. Those
// disagreements are the entire bug history of this subsystem.
//
// So the GPU states it. The host reads it back asynchronously, a frame or two
// late, and uses it only to size dispatches. That lag is harmless in one
// direction and dangerous in the other, which is a rule the host enforces and
// this shader cannot: a stale mark that is too HIGH costs wasted invocations,
// while one that is too LOW hides live particles. See `noteCompactedMark` in
// particleSystem.ts for the guard.
//
// ---------------------------------------------------------------------------
// SEPARATE FROM THE SCATTER, AND THAT IS NOT OPTIONAL
// ---------------------------------------------------------------------------
// The head must not change while the scatter is still writing slots, or a
// spawn racing the tail of the compaction could pop an index the scatter has
// not written yet. Passes within a submission are ordered and barriered by
// WebGPU; dispatches inside one pass are not. This is the same reasoning
// `entityPick` gives for splitting its reduce and derive.
// ============================================================================

#include "freeList.wgsl"

@group(0) @binding(0) var<storage, read_write> freelist : FreeList;
@group(0) @binding(1) var<storage, read>       scratch  : array<u32>;
// Two u32: the mark, and a generation counter the host uses to tell a fresh
// readback from a stale one.
@group(0) @binding(2) var<storage, read_write> result   : array<u32>;

struct FinalizeUniforms {
    // x: entity count
    // y: index in `scratch` holding the grand total of live entities
    // z: generation to stamp, so a readback can be matched to its compaction
    // w: reserved
    params : vec4u,
}
@group(0) @binding(3) var<uniform> u : FinalizeUniforms;

@compute @workgroup_size(1)
fn main() {
    let entity_count = u.params.x;
    let live = min(scratch[u.params.y], entity_count);

    // The pool holds every index the scatter did not give to a live entity.
    atomicStore(&freelist.head, entity_count - live);

    // THE MARK IS THE LIVE COUNT, exactly. The scatter packed the live entities
    // into [0, live), so nothing at or above it is alive -- the bound is not an
    // estimate here, which is the whole point of doing this on the GPU.
    result[0] = live;
    result[1] = u.params.z;
}
