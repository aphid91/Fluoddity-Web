// ============================================================================
// compact.wgsl -- TIER 2. Relocating live particles down into dead holes.
//
// Tier 1 orders the free list so the mark stops CREEPING. It cannot bring a
// mark down that has already risen, because lowering the bound is only safe
// once you know where the highest live particle is -- and the only way to know
// that is to put it somewhere. This pass is that.
//
// Dispatched over a bounded window near the top of the live range. Every live
// particle found there is moved into a dead slot below the sweep's target, and
// its old slot is marked dead. When the sweep has walked the whole range above
// the target, nothing live remains above it and the mark can become the target.
//
// ---------------------------------------------------------------------------
// THIS PASS DOES NOT USE THE FREE LIST, AND THAT IS THE WHOLE DESIGN
// ---------------------------------------------------------------------------
// The obvious implementation calls `free_list_take` for each destination. It is
// wrong, and the reason is the invariant in `freeList.wgsl`: within a pass the
// head must move in ONE direction. This pass runs alongside the eraser, which
// GIVES. If it also TOOK, the head would move both ways while invocations held
// reserved indices -- the exact interleaving that hands one slot to two
// particles.
//
// So destinations come from a SEPARATE CURSOR that this pass owns outright. It
// scans upward from zero, hands out candidate indices, and each invocation
// tests whether the candidate is actually dead before claiming it. The free
// list is never read and never written here; the head is not touched.
//
// The free list is rebuilt WHOLESALE by the host when the sweep completes,
// which is the only moment it changes -- one write, no pass in flight, from a
// state the host knows exactly. `freeListAfterMigration` already does precisely
// this after a Max Particles resize.
//
// ---------------------------------------------------------------------------
// WHY THE HOST DISABLES SPAWNING WHILE A SWEEP RUNS
// ---------------------------------------------------------------------------
// Mid-sweep the free list is STALE in one specific way: it may still list slots
// that this pass has just filled with relocated particles. A brush taking one
// of those would overwrite a live particle.
//
// That staleness is harmless as long as nothing takes from the pool, so the
// host refuses to spawn while a sweep is in flight -- and painting aborts the
// sweep anyway, which rebuilds the list before the next spawn. See
// `sandOrchestrator.ts`.
//
// ---------------------------------------------------------------------------
// WHY A PARTIAL RUN IS SAFE TO ABANDON
// ---------------------------------------------------------------------------
// Relocating a particle changes which index holds it, and NOTHING outside the
// free list attaches meaning to an entity's index -- not the physics, not the
// render, not the config lookup. A sweep stopped halfway has moved some
// particles and not others, which is a legal world that simply is not packed.
//
// The mark is lowered only on COMPLETION, so an abandoned sweep costs nothing
// but keeps the work it did.
// ============================================================================

#include "common.wgsl"

@group(0) @binding(0) var<storage, read_write> entities : array<Entity>;

// THE SWEEP'S OWN ALLOCATOR -- deliberately not the free list. See the header.
//
// `next` is a monotonically rising candidate index. Invocations claim
// candidates with atomicAdd and test each for deadness; `moved` counts
// successful relocations, for the host's progress readout.
struct CompactCursor {
    next  : atomic<u32>,
    moved : atomic<u32>,
}
@group(0) @binding(1) var<storage, read_write> cursor : CompactCursor;

struct CompactUniforms {
    // x: lo    y: hi    -- the half-open window of source indices to examine
    // z: target         -- destinations must land strictly below this
    // w: max_probes     -- give-up limit per particle, see `claim_slot`
    params : vec4u,
}
@group(0) @binding(2) var<uniform> u : CompactUniforms;

fn window_lo() -> u32 { return u.params.x; }
fn window_hi() -> u32 { return u.params.y; }
// NOT `target()`: `target` is a RESERVED KEYWORD in WGSL, and naming a function
// with it is a parse error rather than a shadowing warning -- which takes the
// whole module out and, because a failed compile leaves the pipeline null, is
// silent at runtime beyond one console line. The host's uniform packer and the
// sweep state still call this value `target`; only the shader spelling differs.
fn pack_to()   -> u32 { return u.params.z; }
fn max_probes() -> u32 { return u.params.w; }

// Claim a dead slot below the target, or NO_DEST if none could be found.
//
// ## Why this probes rather than reading a list of holes
//
// Building an exact hole list needs a prefix sum over the whole range below the
// target -- another full-buffer pass and another buffer the size of the entity
// count. Probing trades that for a few reads per particle, and the trade is
// good precisely BECAUSE the sweep only runs on sparse worlds: at 10% occupancy
// nine of every ten probes hit a hole on the first try.
//
// THE PROBE LIMIT IS NOT OPTIONAL. Without it, a particle that cannot find a
// destination spins until the cursor passes the target -- and every invocation
// doing so at once is a workgroup of unbounded loops, which is a hang rather
// than a slowdown. Giving up is correct: the particle stays where it is, the
// sweep does not complete this pass, and the host simply does not lower the
// mark. A missed relocation costs a wasted chunk, never correctness.
const NO_DEST: u32 = 0xffffffffu;

fn claim_slot() -> u32 {
    for (var probe = 0u; probe < max_probes(); probe++) {
        let candidate = atomicAdd(&cursor.next, 1u);
        // Past the target means there is no room below it left to search.
        if (candidate >= pack_to()) { return NO_DEST; }
        // The candidate is ours alone -- atomicAdd handed it to exactly one
        // invocation -- so testing and writing it needs no further locking.
        if (e_is_dead(entities[candidate])) { return candidate; }
    }
    return NO_DEST;
}

// WORKGROUP SIZE 256, matching the kill pass: this dispatches over a region of
// the entity buffer at the same scale. `COMPACT_WORKGROUP_SIZE` in
// sandDispatch.ts must match; sandShaders.test.ts asserts it.
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let index = window_lo() + gid.x;
    if (index >= window_hi()) { return; }
    if (index >= arrayLength(&entities)) { return; }
    // A source at or below the target is already where it belongs. Moving it
    // would be pure churn, and could pull a particle out from under a
    // destination another invocation has already claimed.
    if (index < pack_to()) { return; }

    let e = entities[index];
    // Dead sources are the common case on a sparse world -- the whole reason
    // the sweep is worth running -- so this returns first and cheaply.
    if (e_is_dead(e)) { return; }

    let dest = claim_slot();
    // No room found within the probe limit. Leave the particle exactly where it
    // is: the sweep will not complete, the host will not lower the mark, and
    // nothing is lost. See the note on the probe limit above.
    if (dest == NO_DEST) { return; }

    // ORDER IS LOAD-BEARING: write the destination BEFORE clearing the source.
    // A reader racing this sees the particle at one index or at both, never at
    // neither. Both-at-once is momentarily a duplicate, which is a cosmetic
    // one-frame artifact; neither-at-once would be a particle that vanished.
    entities[dest] = e;
    entities[index] = make_entity_dead();
    atomicAdd(&cursor.moved, 1u);
}
