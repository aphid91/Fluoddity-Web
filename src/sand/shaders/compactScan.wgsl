// ============================================================================
// compactScan.wgsl -- pass 2 of 4. Exclusive prefix sum over the partials.
//
// Turns "how many live entities each workgroup holds" into "how many live
// entities come BEFORE each workgroup", which is the destination offset the
// scatter pass needs.
//
// ---------------------------------------------------------------------------
// RUN ONCE PER LEVEL, NOT ONCE
// ---------------------------------------------------------------------------
// One workgroup scans 512 elements. A 6M entity cap produces 23,438 partials,
// so a single dispatch cannot see them all -- it would scan the first 512 and
// every particle beyond that would be scattered to an offset computed from a
// truncated total, piling them on top of each other. Silently: no error, just
// most of a large world disappearing the first time it is compacted.
//
// So the host dispatches this repeatedly, each level scanning the previous
// level's per-group totals, until one group covers what remains. `scanLevels()`
// in compactPlan.ts computes how many, and its tests pin the 6M case
// specifically because that is the configuration the arithmetic was wrong for.
//
// Each dispatch does two things:
//   * writes the exclusive prefix sum of its slice back over that slice
//   * writes its slice's TOTAL to the next level's buffer
//
// A later ADD pass folds the higher level's offsets back down. That is
// `compactScanAdd` below -- the same shader with a different entry point, so
// the two cannot disagree about layout.
// ============================================================================

struct ScanUniforms {
    // x: element count at this level
    // y: offset (in u32s) of this level's slice within the scratch buffer
    // z: offset of the NEXT level's slice, where group totals go
    // w: 1 when this is the last level (no next slice to write)
    params : vec4u,
}
@group(0) @binding(0) var<storage, read_write> scratch : array<u32>;
@group(0) @binding(1) var<uniform> u : ScanUniforms;

fn count()       -> u32 { return u.params.x; }
fn base()        -> u32 { return u.params.y; }
fn next_base()   -> u32 { return u.params.z; }
fn is_last()     -> bool { return u.params.w != 0u; }

// 512 = 256 threads x 2 elements. `SCAN_ELEMENTS_PER_GROUP` must match.
var<workgroup> temp : array<u32, 512>;

// Blelloch exclusive scan over 512 elements.
//
// EVERY INVOCATION REACHES EVERY BARRIER. The conditional work is inside the
// `if`, never around the barrier -- a barrier that only some invocations reach
// is undefined behaviour, and on a ragged final group that is the normal case
// rather than a corner.
@compute @workgroup_size(256)
fn main(
    @builtin(local_invocation_id) lid : vec3u,
    @builtin(workgroup_id)        wid : vec3u,
) {
    let local = lid.x;
    let group = wid.x;
    let start = group * 512u;

    // Load two elements each, zero-padding past the end so the scan is exact
    // for a ragged tail rather than summing whatever was in scratch.
    let i0 = start + local * 2u;
    let i1 = i0 + 1u;
    temp[local * 2u]      = select(0u, scratch[base() + i0], i0 < count());
    temp[local * 2u + 1u] = select(0u, scratch[base() + i1], i1 < count());

    // --- up-sweep: build the sum tree in place -----------------------------
    var offset = 1u;
    for (var d = 256u; d > 0u; d >>= 1u) {
        workgroupBarrier();
        if (local < d) {
            let ai = offset * (2u * local + 1u) - 1u;
            let bi = offset * (2u * local + 2u) - 1u;
            temp[bi] = temp[bi] + temp[ai];
        }
        offset = offset * 2u;
    }

    // The total for this group, saved before the root is cleared.
    workgroupBarrier();
    let total = temp[511];

    // --- down-sweep: turn the sum tree into an exclusive scan --------------
    if (local == 0u) { temp[511] = 0u; }
    for (var d = 1u; d < 512u; d = d * 2u) {
        offset = offset >> 1u;
        workgroupBarrier();
        if (local < d) {
            let ai = offset * (2u * local + 1u) - 1u;
            let bi = offset * (2u * local + 2u) - 1u;
            let t = temp[ai];
            temp[ai] = temp[bi];
            temp[bi] = temp[bi] + t;
        }
    }
    workgroupBarrier();

    // Write the scanned slice back. Out-of-range lanes are dropped rather than
    // clamped: writing them would corrupt the next level's slice, which lives
    // immediately after this one in the same buffer.
    if (i0 < count()) { scratch[base() + i0] = temp[local * 2u]; }
    if (i1 < count()) { scratch[base() + i1] = temp[local * 2u + 1u]; }

    // This group's total feeds the next level.
    //
    // THE LAST LEVEL WRITES THE GRAND TOTAL TO ITS OWN DEDICATED SLOT. An
    // exclusive scan DISCARDS the total -- the last element's output is the sum
    // of everything before it, not including itself -- so without this the live
    // count would simply not exist anywhere, and the scatter and finalize
    // passes both need it. `total` was saved before the down-sweep cleared the
    // root, which is the only moment it is available.
    //
    // The slot is `next_base()` on the last level, which the host points at a
    // reserved word past every level's slice. See `scanScratchSlots`, whose
    // "+1" is exactly this word.
    if (local == 0u) {
        if (is_last()) {
            scratch[next_base()] = total;
        } else {
            scratch[next_base() + group] = total;
        }
    }
}

// ---------------------------------------------------------------------------
// The fold-down. Adds a level's scanned group offsets back into the level
// below it, completing the multi-level scan.
//
// Dispatched over the LOWER level's elements, one invocation each. Separate
// entry point rather than a separate file so the two cannot drift about which
// slice is which.
// ---------------------------------------------------------------------------
@compute @workgroup_size(256)
fn add_offsets(@builtin(global_invocation_id) gid : vec3u) {
    let i = gid.x;
    if (i >= count()) { return; }
    // Which group of 512 this element fell into -- the same partition the scan
    // used, so the offset it adds is the one computed for exactly this slice.
    let group = i / 512u;
    scratch[base() + i] = scratch[base() + i] + scratch[next_base() + group];
}
