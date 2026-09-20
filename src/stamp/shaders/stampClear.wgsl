// ============================================================================
// stampClear.wgsl -- kill every particle inside a box and return its slot.
//
// The particle half of a region clear. The texture halves are render passes
// (see `StampClearer`), because a texture region is cleared by drawing over it
// rather than by a compute pass.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS FOR
// ---------------------------------------------------------------------------
// Two things, and having one operation serve both is the point:
//
//   CUT      copy the region, then clear it.
//   REPLACE  clear the region, then paste into it.
//
// The initial-conditions restore is the second: clear the whole world, paste
// the captured stamp. That composition is why `stampPaste.wgsl` has no replace
// mode -- a mode flag there would duplicate this pass's job and the two could
// disagree about which particles are "in" the box.
//
// ---------------------------------------------------------------------------
// THE CADENCE RULE THIS INHERITS FROM kill.wgsl
// ---------------------------------------------------------------------------
// This pass ONLY EVER GIVES SLOTS BACK, so the head moves monotonically UP
// across it -- the same direction edge-death moves it inside `advance()`, which
// is why the two compose. It must NOT be recorded on a frame that also spawns
// or pastes, both of which take: a head moving both ways within one pass is
// precisely the interleaving the free-list protocol forbids.
//
// `StampClearer` enforces that by recording the clear and the paste into
// separate passes on the same encoder, which WebGPU orders and barriers between.
// ============================================================================

#include "common.wgsl"
// THE STRUCT ONLY -- operations follow the binding. See `freeList.wgsl`.
#include "freeList.wgsl"
#include "stampBox.wgsl"

@group(0) @binding(0) var<storage, read_write> entities : array<Entity>;
// MUST be named exactly `freelist` -- see `freeListOps.wgsl`.
@group(0) @binding(1) var<storage, read_write> freelist : FreeList;
@group(0) @binding(2) var<uniform>             u        : StampUniforms;

#include "freeListOps.wgsl"

fn entity_count() -> u32 { return u.params.x; }

// WORKGROUP SIZE 256, matching `kill.wgsl`: this sweeps the whole entity buffer
// rather than a small brush-sized dispatch, so the larger group is the right
// shape. `STAMP_CLEAR_WORKGROUP_SIZE` in stampDispatch.ts must match, and
// `stampShaders.test.ts` asserts it.
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    let index = gid.x;
    if (index >= entity_count()) { return; }

    let e = entities[index];
    // ALREADY DEAD SLOTS ARE LEFT ALONE. Returning one that is already in the
    // pool would be a double-free: the same index offered to two brushes, which
    // is the single worst failure the pool has. `e_is_dead` first, always.
    if (e_is_dead(e)) { return; }

    if (!stamp_box_contains(stamp_src_min(u), stamp_src_max(u), e_pos(e))) { return; }

    // PUSH BEFORE ZEROING, matching `kill.wgsl` and the BC_KILL branch in
    // entityUpdate. A reader racing this sees either a live particle or a dead
    // one, never a live index sitting on the free list. Doing it the other way
    // round opens exactly that window.
    free_list_give(index);
    entities[index] = make_entity_dead();
}
