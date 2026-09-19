// ============================================================================
// freeListSort.wgsl -- keeping the dead-index pool ordered, a little per frame.
//
// TIER 1 COMPACTION. This pass moves NO PARTICLES and changes no particle's
// liveness. It only permutes the free list so that the LOWEST available index
// sits on top of the stack and is handed out next.
//
// ---------------------------------------------------------------------------
// WHY ORDERING THE POOL IS WORTH A PASS
// ---------------------------------------------------------------------------
// The high-water mark is an upper bound on the highest live index, and it only
// creeps up when a brush is handed a HIGH index while low ones are free. A fresh
// pool hands out 0, 1, 2, ... in order (`initialFreeList` fills descending), but
// the ERASER destroys that: `free_list_give` pushes freed indices in whatever
// order the GPU retires them, so after a few erase strokes the top of the stack
// is an arbitrary scatter. Paint again and the live particles spread across the
// whole range -- and the mark can never come down.
//
// Sorting the pool is the cheap half of the fix. It does not compact anything
// that has already scattered (that is Tier 2, which moves entities), but it
// stops the scatter from happening in the first place.
//
// ---------------------------------------------------------------------------
// THE HEAD IS READ, NEVER MOVED -- THIS IS THE WHOLE SAFETY ARGUMENT
// ---------------------------------------------------------------------------
// `freeList.wgsl` builds everything on the head moving MONOTONICALLY within a
// pass: creation only decreases it, deletion only increases it, and mixing the
// two in one pass could hand the same slot to two particles.
//
// This pass sidesteps that invariant rather than joining it. It calls neither
// `free_list_take` nor `free_list_give`, does not touch `head` at all, and only
// permutes `slots[0 .. head)`. A permutation of the available region hands out
// exactly the same set of indices in a different ORDER, so it cannot create or
// destroy a slot no matter how it interleaves.
//
// It is still NOT safe to run alongside the spawn pass: spawn pops
// `slots[head-1]` while this is rewriting that entry, so a particle could be
// created at an index this pass simultaneously moves elsewhere -- a genuine
// double-alloc. The host is what prevents this, by skipping the pass entirely on
// any frame that recorded a spawn. See `sortFreeList` in sandPasses.ts.
//
// Kill IS safe to overlap: it only appends at `slots[head]` and upward, which is
// outside the region this touches.
//
// ---------------------------------------------------------------------------
// ODD-EVEN TRANSPOSITION, AND WHY A PARTIAL RUN IS STILL CORRECT
// ---------------------------------------------------------------------------
// One phase compares disjoint neighbouring pairs and swaps those out of order.
// Every pair is independent, so there is no cross-invocation coordination, no
// shared memory, and no barrier -- which is what lets this dispatch over a
// bounded WINDOW of the pool rather than all of it.
//
// A full sort needs O(n) phases. THIS PASS NEVER RUNS THEM ALL. It does one
// phase per frame over a budgeted window, and that is fine, because a phase that
// is interrupted or never followed up leaves a valid pool that is merely LESS
// SORTED than it could be. There is no half-finished state to clean up: the
// pool is a permutation after every single swap. Ordering improves over frames
// and the cost per frame is flat.
//
// DESCENDING, because the stack pops from the top. Sorting descending puts the
// smallest index at `slots[head-1]`, which is the one taken next. This is the
// same direction `freeListAfterMigration` writes for the same reason.
// ============================================================================

// THE STRUCT ONLY -- its operations name the binding below, so they follow it.
// This pass calls none of them, but the include is what defines `FreeList`.
#include "freeList.wgsl"

@group(0) @binding(0) var<storage, read_write> freelist : FreeList;

struct SortUniforms {
    // x: phase parity (0 = compare pairs starting at even indices, 1 = odd)
    // y: window length in slots -- how much of the pool this dispatch covers
    // zw: reserved
    params : vec4u,
}
@group(0) @binding(1) var<uniform> u : SortUniforms;

fn parity() -> u32 { return u.params.x; }
fn window_len() -> u32 { return u.params.y; }

// WORKGROUP SIZE 256, matching the kill pass: this dispatches over a region of
// the pool at entity scale rather than at brush scale. `SORT_WORKGROUP_SIZE` in
// sandDispatch.ts must match; sandShaders.test.ts asserts it.
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    // One invocation per PAIR, so the slot index is doubled. The parity offset
    // is what alternates which pairs are compared between frames -- without it
    // the same disjoint pairs would be compared forever and elements could never
    // migrate past their neighbour.
    let a = gid.x * 2u + parity();
    let b = a + 1u;

    // The window bounds the work. Reading `head` here rather than trusting the
    // host's stale copy is deliberate: the host's is a frame or two old, and a
    // window computed from it could reach past the real head into slots that are
    // LIVE indices. Those must never be reordered -- see the test in
    // compaction.test.ts about residue above the head.
    let head = atomicLoad(&freelist.head);
    let limit = min(window_len(), head);
    if (b >= limit) { return; }

    // A plain read-compare-write, with no atomics. Safe because the pairs a
    // single dispatch compares are DISJOINT -- invocation i touches only slots
    // 2i and 2i+1 -- so no two invocations in this pass address the same slot.
    let x = freelist.slots[a];
    let y = freelist.slots[b];
    // Descending: the larger index belongs lower in the stack, so the smaller
    // one floats toward the top and pops first.
    if (x < y) {
        freelist.slots[a] = y;
        freelist.slots[b] = x;
    }
}
