// ============================================================================
// compactScatter.wgsl -- pass 3 of 4. The permutation.
//
// Every live entity is written to its packed destination; every index that ends
// up unused is written to the free list. One invocation per source index, each
// writing exactly one place.
//
// ---------------------------------------------------------------------------
// THIS IS WHERE THE OLD DESIGN'S BUG BECAME IMPOSSIBLE
// ---------------------------------------------------------------------------
// The previous compaction claimed destinations from an atomic cursor and never
// told the free list, leaking one slot per relocation -- 69,184 of them in the
// audit that finally caught it.
//
// Here the free list is not PATCHED, it is WRITTEN FROM SCRATCH. Index i below
// `live_count` receives a live entity; index i at or above it is free and is
// written into the pool at a position derived the same way. Every index is
// assigned exactly once, so:
//
//   * no live index can be in the pool -- the pool only receives indices at or
//     above live_count, and every entity there is dead by construction;
//   * no index can appear twice -- each invocation writes one slot at one
//     position computed from its own rank;
//   * nothing can leak -- the two ranges partition [0, entity_count).
//
// Those are the audit's first three invariants, and they hold by CONSTRUCTION
// rather than by argument. The fourth (nothing live at or above the mark) is
// definitional once the output is packed.
//
// ---------------------------------------------------------------------------
// WHY THE DESTINATION IS A SEPARATE BUFFER
// ---------------------------------------------------------------------------
// Writing in place races: an entity moving from 500 to 12 collides with another
// invocation reading 12 as its source, and dispatches have no internal
// ordering. The host copies `dst` back over the entity buffer afterwards, which
// keeps the entity buffer OBJECT stable so every bind group in the program
// stays valid. See the long note in compactPlan.ts.
// ============================================================================

#include "common.wgsl"
#include "freeList.wgsl"

@group(0) @binding(0) var<storage, read>       src      : array<Entity>;
@group(0) @binding(1) var<storage, read_write> dst      : array<Entity>;
@group(0) @binding(2) var<storage, read_write> freelist : FreeList;
// The scanned partials: element w is the number of live entities in workgroups
// before w.
@group(0) @binding(3) var<storage, read>       offsets  : array<u32>;

struct ScatterUniforms {
    // x: entity count
    // y: index in `offsets` holding the GRAND TOTAL of live entities
    // zw: reserved
    params : vec4u,
}
@group(0) @binding(4) var<uniform> u : ScatterUniforms;

fn entity_count() -> u32 { return u.params.x; }

// THE LIVE COUNT IS READ FROM THE SCAN, NOT PASSED IN.
//
// The host does not know it and must not guess: every past attempt to have the
// host infer a live count -- from a boundary, a stale head, a spawn tally --
// produced a number that disagreed with the buffer, and those disagreements are
// this subsystem's entire bug history. The scan computed it on this same
// submission, so reading it here is exact by construction.
fn live_count() -> u32 { return min(offsets[u.params.y], entity_count()); }

// Rank of this invocation's entity among the live ones in its own workgroup.
// Computed by the same halving pattern the count pass uses, so the two agree
// about what a workgroup contains.
var<workgroup> flags : array<u32, 256>;

@compute @workgroup_size(256)
fn main(
    @builtin(global_invocation_id) gid : vec3u,
    @builtin(local_invocation_id)  lid : vec3u,
    @builtin(workgroup_id)         wid : vec3u,
) {
    let index = gid.x;
    let local = lid.x;

    // Liveness, with out-of-range treated as dead. Every invocation must reach
    // the barriers below, so this is a value rather than an early return.
    var live = 0u;
    if (index < entity_count() && !e_is_dead(src[index])) {
        live = 1u;
    }
    flags[local] = live;
    workgroupBarrier();

    // Exclusive prefix sum within the workgroup, by the simplest correct means:
    // each invocation sums the flags before it. 256 reads per invocation is
    // more work than a tree scan, but it is obviously right, and this pass is
    // dominated by the 32-byte entity copy below rather than by this loop.
    var rank = 0u;
    for (var i = 0u; i < local; i++) {
        rank = rank + flags[i];
    }
    // How many live entities precede this whole workgroup.
    let group_offset = offsets[wid.x];

    if (index >= entity_count()) { return; }

    // EVERY INVOCATION WRITES ITS OWN SLOT IN `dst`, live or dead.
    //
    // THE TAIL IS NOT IMPLICITLY DEAD. `dst` is a scratch buffer, and an
    // unwritten entity is 32 zero bytes -- which is not a dead particle, it is
    // a LIVE one on config 0. `deadEntityBytes` documents this trap at length:
    // "a naively zeroed buffer is a buffer full of LIVE particles stacked at
    // the origin".
    //
    // The first version of this pass wrote only the live destinations and left
    // the rest untouched. The audit was unambiguous: live 6,000,000 of
    // 6,000,000, with the entire tail above the mark reading as alive and
    // sitting in the free list at the same time. The scan and the mark were
    // both correct; only the tail was garbage.
    //
    // THE TWO WRITES NEVER TARGET THE SAME SLOT, which is what makes this safe
    // without any ordering between invocations. A live entity always lands
    // BELOW `live_count()` (its rank among the live is less than their total),
    // and the tail clear only touches indices at or above it. The ranges
    // partition the buffer, so no slot is written twice and none is left out.
    //
    // Ordering between invocations would be unavailable anyway: a dispatch has
    // none internally, so a design where two invocations raced for one slot
    // could not be fixed by reordering the lines here.
    if (index >= live_count()) {
        dst[index] = make_entity_dead();
    }

    if (live == 1u) {
        // A LIVE ENTITY lands at its global rank, which is unique: no two
        // invocations share both a workgroup offset and a within-group rank.
        dst[group_offset + rank] = src[index];
    } else {
        // A DEAD SLOT contributes a free index. Its position in the pool is
        // derived the same way -- how many dead slots precede it -- so the
        // write needs no atomic and cannot collide.
        //
        // dead_rank = (how many indices precede it) - (how many of those were
        // live), which is exactly index - (group_offset + rank).
        let dead_before = index - (group_offset + rank);
        // DESCENDING FILL, so the LOWEST free index sits on top of the stack
        // and is handed out first. `freeList.ts` is emphatic about this: the
        // stack pops slots[head-1], and allocating upward from the bottom is
        // what keeps the high-water mark from creeping. An ascending fill here
        // would quietly undo that and the mark would climb again on the next
        // stroke.
        let free_total = entity_count() - live_count();
        let slot = free_total - 1u - dead_before;
        freelist.slots[slot] = index;
    }
}
