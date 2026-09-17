// ============================================================================
// kill.wgsl -- the eraser.
//
// Every live particle inside the brush radius is marked dead and its index
// returned to the pool. Runs ONCE PER RENDERED FRAME, after the sub-steps, and
// in its own pass so that the free list's head moves monotonically UP while it
// runs -- see the header of freeList.wgsl for why that separation is what makes
// the atomic reservation safe rather than merely atomic.
//
// ---------------------------------------------------------------------------
// WHY THIS DISPATCHES OVER EVERY PARTICLE
// ---------------------------------------------------------------------------
// Unlike spawning, the CPU cannot know how many particles are in the brush --
// that is a property of where they have drifted to, which only the GPU knows.
// So the dispatch covers the whole buffer and each invocation tests its own
// particle. Dead particles return on the first branch, so an empty world costs
// one read each, exactly as in the entity update.
//
// This is the same shape `entityPick` uses to find the nearest particle, and it
// is why erasing is a once-per-frame act rather than a per-sub-step one.
// ============================================================================

#include "common.wgsl"
// THE STRUCT ONLY -- its operations name the binding below, so they follow it.
#include "freeList.wgsl"

@group(0) @binding(0) var<storage, read_write> entities : array<Entity>;
@group(0) @binding(1) var<storage, read_write> freelist : FreeList;

#include "freeListOps.wgsl"

struct KillUniforms {
    world : WorldData,
    // xy: stroke start (world)   zw: stroke end (world). A SEGMENT, matching the
    // spawn brush, so a fast right-drag erases a continuous swathe rather than
    // leaving untouched gaps between frames.
    stroke : vec4f,
    // x: radius (world)   yzw: reserved
    params : vec4f,
}
@group(0) @binding(2) var<uniform> u : KillUniforms;

fn brush_radius() -> f32 { return u.params.x; }

// Distance from p to the segment ab -- the same measure `strafe_draw` erases
// with, so the eraser's reach matches the reticle exactly at any drag speed.
fn distance_to_segment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
    let ab = b - a;
    let denom = dot(ab, ab);
    // A zero-length segment is a point, which is the common case: a click that
    // has not moved yet. Guarded rather than divided, because 0/0 is NaN and a
    // NaN distance compares false against every radius -- the eraser would
    // silently do nothing on a stationary click.
    if (denom <= 0.0) { return length(p - a); }
    let t = clamp(dot(p - a, ab) / denom, 0.0, 1.0);
    return length(p - (a + ab * t));
}

// WORKGROUP SIZE 256 -- matches the entity update, because this dispatches over
// the same buffer at the same scale. `KILL_WORKGROUP_SIZE` in sandPasses.ts must
// match; sandShaders.test.ts asserts it.
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let index = gid.x;
    if (index >= arrayLength(&entities)) { return; }

    let e = entities[index];
    // Already dead: nothing to erase, and pushing its index again would be a
    // DOUBLE FREE -- the same slot handed to two future brushes. This branch is
    // the only thing preventing that, since the eraser is dragged over the same
    // ground repeatedly by nature.
    if (e_is_dead(e)) { return; }

    if (distance_to_segment(e_pos(e), u.stroke.xy, u.stroke.zw) > brush_radius()) {
        return;
    }

    // Push BEFORE zeroing, matching the BC_KILL branch in entityUpdate: a reader
    // racing this sees either a live particle or a dead one, never a live index
    // sitting on the free list.
    free_list_give(index);
    entities[index] = make_entity_dead();
}
