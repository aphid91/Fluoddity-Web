// ============================================================================
// stampPaste.wgsl -- add a stamp's particles to the world.
//
// One invocation per particle in the stamp. Each takes a slot from the free
// list, remaps its position into the destination box, and writes it live.
//
// ---------------------------------------------------------------------------
// PASTE IS ALWAYS ADDITIVE. REPLACE IS clear-region THEN paste.
// ---------------------------------------------------------------------------
// There is no "replace" mode here and there should not be one. An additive
// paste plus a separate region clear composes into replace, and the same clear
// composes with a copy into cut -- so three operations cover cut, copy, paste
// and replace, where a mode flag on each would have been four shaders that can
// disagree.
//
// The initial-conditions restore is therefore `clearRegion(world)` followed by
// `paste(stamp)`, and it exercises exactly the same code path the stamp tool
// will use. That is deliberate: the reset key runs it every session, so the
// paste path cannot rot between here and the stamp UI landing.
//
// ---------------------------------------------------------------------------
// THE RESERVATION PROTOCOL
// ---------------------------------------------------------------------------
// This pass ONLY TAKES from the free list, which is what makes it safe to run
// beside nothing else that touches the pool. `free_list_take` is the same
// atomic reservation the spawn pass uses, and it refuses to underflow: a paste
// into a world with too few free slots places as many particles as it can and
// silently drops the rest.
//
// SILENTLY IS CORRECT HERE, and it is the same call `spawnCountFor` makes for
// the brush: the alternative is refusing the entire paste because the pool is
// one slot short, which loses the user's whole stamp rather than its tail. The
// HOST reports the shortfall -- it knows the stamp's count and can read the
// pool -- so the outcome is visible without this pass needing to fail.
// ============================================================================

#include "common.wgsl"
// THE STRUCT ONLY -- its operations name the `freelist` binding directly, so
// they must follow it. See the long note in `freeList.wgsl`.
#include "freeList.wgsl"
#include "stampBox.wgsl"

@group(0) @binding(0) var<storage, read_write> entities : array<Entity>;
// MUST be named exactly `freelist`: `freeListOps.wgsl` names it rather than
// taking a pointer, because a storage pointer parameter needs a language
// feature that is not baseline WebGPU.
@group(0) @binding(1) var<storage, read_write> freelist : FreeList;
// The stamp's particles, exactly as they were captured: world-space positions
// in the SOURCE box's frame.
@group(0) @binding(2) var<storage, read>       stamp    : array<Entity>;
@group(0) @binding(3) var<uniform>             u        : StampUniforms;

#include "freeListOps.wgsl"

/// How many particles the stamp holds. Reuses `params.x`, which for this pass
/// counts the STAMP rather than the world -- the world's entity count is
/// irrelevant here, since the free list decides where anything lands.
fn stamp_count() -> u32 { return u.params.x; }

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    let index = gid.x;
    if (index >= stamp_count()) { return; }

    let source = stamp[index];
    // A stamp should hold no dead particles -- the copy pass filtered them --
    // but a hand-edited or truncated file could. Skipping costs one branch and
    // keeps a corrupt save from spawning garbage at the origin.
    if (e_is_dead(source)) { return; }

    // TAKE A SLOT. Refuses to underflow; see the header on why running out is
    // handled by placing fewer rather than by failing.
    let slot = free_list_take();
    if (slot == NO_SLOT) { return; }

    var placed = source;
    // THE REMAP, and the one arithmetic step in the whole paste path. It is the
    // identity when the boxes match -- see `stamp_remap_point`, where that
    // early-out is load-bearing rather than an optimization.
    let pos = stamp_remap_point(u, e_pos(source));
    placed.pos_vel = vec4f(pos, e_vel(source));

    entities[slot] = placed;
}
