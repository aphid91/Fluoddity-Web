// ============================================================================
// stampScatter.wgsl -- pass 3 of 3. Copy the matched particles into the stamp.
//
// One invocation per source index. Each particle inside the box is written to
// its packed destination in the stamp block; everything else writes nothing.
//
// ---------------------------------------------------------------------------
// THIS PASS ONLY READS THE WORLD. IT IS NOT A CUT.
// ---------------------------------------------------------------------------
// `entities` is bound READ-ONLY here, deliberately. A copy must not disturb the
// scene: the free list is untouched, no particle is killed, and the high-water
// mark does not move. A cut is this pass followed by a SEPARATE region clear,
// which is what makes cut/copy/paste three composable operations rather than
// three near-duplicate shaders.
//
// That split is also what makes the initial-conditions capture safe to run on
// the frame the user presses go: capturing the scene cannot perturb the scene
// it is capturing.
//
// ---------------------------------------------------------------------------
// THE DESTINATION IS BOUNDED, AND THE BOUND IS NOT PARANOIA
// ---------------------------------------------------------------------------
// The stamp block is sized from a count the HOST read back, which is a frame or
// more old by the time this runs -- the world may have gained particles since.
// Without the bound, a stamp taken while painting would write past the end of
// its block. WebGPU does bounds-check storage writes, so this would not corrupt
// memory, but the write would be silently dropped and the stamp would be short
// by however many the buffer was over -- a stamp that quietly loses its last
// few particles, which is the kind of thing nobody notices for months.
//
// Clamping here makes the overflow VISIBLE instead: the host compares the
// packed count against the capacity it allocated and can say the stamp was
// truncated. See `StampCopier.copy`.
// ============================================================================

#include "common.wgsl"
#include "stampBox.wgsl"

@group(0) @binding(0) var<storage, read>       src      : array<Entity>;
@group(0) @binding(1) var<storage, read_write> dst      : array<Entity>;
// The scanned partials: element w is the number of matched particles in all
// workgroups before w.
@group(0) @binding(2) var<storage, read>       offsets  : array<u32>;
@group(0) @binding(3) var<uniform>             u        : StampUniforms;

fn entity_count() -> u32 { return u.params.x; }
fn dst_capacity() -> u32 { return u.params.z; }

// THE GRAND TOTAL OF MATCHED PARTICLES, read from the scan rather than passed
// in. The host does not know it: only the GPU has counted, and every past
// attempt in this codebase to have the host infer a live count produced a
// number that disagreed with the buffer. See `compactScatter.wgsl`, which takes
// the identical approach for the identical reason.
fn matched_count() -> u32 { return min(offsets[u.params.y], dst_capacity()); }

var<workgroup> flags : array<u32, 256>;

@compute @workgroup_size(256)
fn main(
    @builtin(global_invocation_id) gid : vec3u,
    @builtin(local_invocation_id)  lid : vec3u,
    @builtin(workgroup_id)         wid : vec3u,
) {
    let index = gid.x;
    let local = lid.x;

    // THE SAME PREDICATE THE COUNT PASS USED, via the same shared function.
    // If these two ever disagreed, the scan would produce offsets for one set of
    // particles while this wrote a different set -- packing them on top of each
    // other with no error anywhere. That is why the test lives in
    // `stampBox.wgsl` rather than being written out twice.
    var hit = 0u;
    if (index < entity_count()) {
        let e = src[index];
        if (!e_is_dead(e) && stamp_box_contains(stamp_src_min(u), stamp_src_max(u), e_pos(e))) {
            hit = 1u;
        }
    }
    flags[local] = hit;
    workgroupBarrier();

    // Exclusive prefix sum within the workgroup: each invocation sums the flags
    // before it. 256 reads per invocation is more work than a tree scan and is
    // obviously right; this pass is dominated by the 32-byte entity copy below.
    // `compactScatter.wgsl` makes the same trade for the same reason.
    var rank = 0u;
    for (var i = 0u; i < local; i++) {
        rank = rank + flags[i];
    }
    let group_offset = offsets[wid.x];

    if (index >= entity_count()) { return; }

    // ---------------------------------------------------------------------
    // THE TAIL IS NOT IMPLICITLY DEAD, AND THAT IS NOT A THEORETICAL CONCERN
    // ---------------------------------------------------------------------
    // The block is REUSED across captures and sized to the whole entity buffer,
    // so whatever the previous capture left above this one's match count is
    // still sitting there. Capture a thousand particles, erase most of them,
    // capture ten: slots 10..999 still hold the first capture's particles.
    //
    // Nothing downstream can tell the difference. The paste dispatches over the
    // whole block and skips dead entries -- so those stale particles are not
    // stale to it, they are live ones to place, and a restore would resurrect a
    // scene the user erased.
    //
    // `compactScatter.wgsl` hit exactly this and documents it: a naively unwritten
    // tail is not empty, it is "a buffer full of LIVE particles". There the
    // symptom was an audit reporting live 6,000,000 of 6,000,000; here it would
    // be a reset key that brings back deleted particles.
    //
    // THE TWO WRITES NEVER TARGET THE SAME SLOT, which is what makes this safe
    // with no ordering between invocations: a matched particle always lands
    // BELOW `matched_count()` (its rank among the matched is less than their
    // total), and the tail clear only touches indices at or above it. The ranges
    // partition the block.
    if (index >= matched_count() && index < dst_capacity()) {
        dst[index] = make_entity_dead();
    }

    if (hit == 0u) { return; }

    let destination = group_offset + rank;
    // See the header: silently dropping the write would make the stamp short.
    if (destination >= dst_capacity()) { return; }

    // VERBATIM. The particle's position is NOT remapped here -- a stamp stores
    // world coordinates exactly as they sat in the entity buffer, and the
    // remap happens on PASTE, where the destination box is known. Doing it here
    // would bake the source box into the stored bytes and make a stamp
    // re-pastable only into the box it came from.
    //
    // It also keeps this a pure 32-byte copy, so a captured scene restored into
    // an unchanged world is bit-identical rather than arithmetically close.
    dst[destination] = src[index];
}
