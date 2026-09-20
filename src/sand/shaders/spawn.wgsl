// ============================================================================
// spawn.wgsl -- the particle-creation brush.
//
// Runs ONCE PER RENDERED FRAME, never per physics sub-step. That is the same
// cadence `strafe_draw` paints at, and for the same reason: at the default
// physics rate a per-sub-step brush would deposit 30x the material and the
// Physics Rate slider would silently become a density slider. See
// ARCHITECTURE.md's brush section.
//
// ---------------------------------------------------------------------------
// HOW MANY, AND WHICH
// ---------------------------------------------------------------------------
// These are two different questions with two different answers, and conflating
// them is what makes this design want an atomic it does not need:
//
//   HOW MANY   the CPU decides. `spawnCountFor()` turns brush radius, rate and
//              dt into a count, and the dispatch is sized to cover it. One
//              invocation per particle to create, so the test below is a plain
//              bounds check -- no atomic, no contention.
//
//   WHICH      the free list decides, via one atomicSub per invocation. This is
//              the only place contention exists, and it is unavoidable: the
//              dead indices are scattered and only the pool knows where.
//
// The head moves MONOTONICALLY DOWN across this pass, which is what makes the
// reservation safe to act on. Nothing may return a slot while this runs -- see
// the header of freeList.wgsl.
// ============================================================================

#include "common.wgsl"
// `hash` -- the project's own generator, so spawn scatter is drawn from the same
// family as every other random decision in the simulation. NOT `rule.wgsl`,
// which also holds an 80-call center generator this pass has no use for.
#include "hash.wgsl"
// THE STRUCT ONLY -- its operations name the binding below, so they follow it.
#include "freeList.wgsl"

@group(0) @binding(0) var<storage, read_write> entities : array<Entity>;
@group(0) @binding(1) var<storage, read_write> freelist : FreeList;

#include "freeListOps.wgsl"

// ---------------------------------------------------------------------------
// THE HIGHEST SLOT THIS PASS TOOK, plus one. The host reads it back and raises
// the mark to it.
//
// ## Why the host cannot compute this from the spawn count
//
// It used to try: `noteSpawned(count)` did `mark = mark + count`, which is
// correct only if the brush takes CONTIGUOUS indices starting at the mark.
// That holds in a fresh world -- `initialFreeList` fills descending, so the
// pool hands out 0, 1, 2, ... -- and it stops holding the moment the eraser
// runs. `free_list_give` pushes freed indices in whatever order the GPU retires
// them, so an erased pool is an arbitrary scatter and the next stroke takes
// high indices while the mark rises by a mere count.
//
// The symptom is live particles sitting ABOVE the mark: skipped by every pass,
// drawn by nothing, still occupying their slots. The audit names it exactly --
// "179 live particles sit at or above the mark (451076)" with the highest live
// index at 451,254.
//
// `freeListSort.wgsl` exists to slow this down and explicitly cannot prevent
// it: it is a budgeted PARTIAL sort that converges over many frames, and the
// host skips it entirely on any frame that spawned -- which is every frame of
// a drag, precisely when the scatter is being consumed.
//
// So the bound has to be measured rather than inferred. Only the GPU learns
// which slot the reservation handed out, so only the GPU can report it.
// ---------------------------------------------------------------------------
@group(0) @binding(3) var<storage, read_write> high_water : atomic<u32>;

struct SpawnUniforms {
    world : WorldData,
    // xy: stroke start (world)   zw: stroke end (world)
    //
    // A SEGMENT, NOT A POINT. Each frame paints from last frame's cursor to this
    // one, so a fast drag lays a continuous stream rather than one clump per
    // frame. This is the same fix `strafe_draw` makes with distance-to-segment;
    // the reference splats a single point per frame and visibly breaks into dots.
    stroke : vec4f,
    // x: spawn_count(i)   y: radius (world)   z: config_index(i)   w: frame(i)
    params : vec4f,
}
@group(0) @binding(2) var<uniform> u : SpawnUniforms;

fn spawn_count() -> u32 { return u32(max(0, bitcast<i32>(u.params.x))); }
fn brush_radius() -> f32 { return u.params.y; }
fn spawn_config() -> i32 { return bitcast<i32>(u.params.z); }
fn frame() -> f32 { return f32(bitcast<i32>(u.params.w)); }

// WORKGROUP SIZE 64, not the entity update's 256.
//
// This dispatch is sized to the SPAWN COUNT, which is typically a few hundred --
// at 256 a 100-particle brush would launch one workgroup with 156 invocations
// returning immediately. 64 wastes less on the small dispatches that are the
// common case here. `SPAWN_WORKGROUP_SIZE` in sandPasses.ts must match;
// sandShaders.test.ts asserts it.
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let i = gid.x;
    // The whole of "how many": everything past the CPU's count returns.
    if (i >= spawn_count()) { return; }

    // Reserve a dead index. Empty pool is NORMAL -- a full world with a brush
    // still down hits it every frame -- so this fails quietly rather than
    // clamping onto a live particle.
    let index = free_list_take();
    if (index == NO_SLOT) { return; }

    // --- where ------------------------------------------------------------
    // Three independent draws per particle, decorrelated by offsetting the hash
    // input rather than by chaining: `hash` is pcg-based, so nearby seeds give
    // unrelated outputs and there is no need to feed one result into the next.
    let seed = vec2f(f32(i), frame());
    let t = hash(seed);                       // where along the stroke
    let angle = hash(seed + 11.0) * 2.0 * PI; // direction within the disc
    // sqrt() IS LOAD-BEARING: sampling radius uniformly would pile two thirds of
    // the particles into the middle third of the disc, because area grows as r^2.
    // The sqrt makes the scatter uniform over the AREA, which is what "paint a
    // disc of material" means.
    let r = sqrt(hash(seed + 23.0)) * brush_radius();

    let center = mix(u.stroke.xy, u.stroke.zw, t);
    let pos = center + vec2f(cos(angle), sin(angle)) * r;

    // --- what -------------------------------------------------------------
    // Size matches `reset()` in entityUpdate.wgsl, including its 1/sqrt_world_size
    // scaling, so a painted particle is the same size as a studio-spawned one at
    // the same world size. Duplicated rather than shared because `reset` writes
    // the entity buffer itself and takes a ConfigData this pass has no reason to
    // read.
    let size = 0.0015 / world_sqrt_world_size(u.world);

    // Born at rest. A spawn velocity would be an arbitrary choice the brush has
    // no basis for, and the physics gives them motion on the very next step --
    // the sensors read the canvas regardless of how fast the particle is moving.
    entities[index] = make_entity_reset(pos, vec2f(0.0), size, spawn_config());

    // RECORD HOW FAR UP THE BUFFER THIS WENT -- see the binding's note.
    //
    // `index + 1` because the mark is an EXCLUSIVE bound: every pass covers
    // [0, mark), so a particle at `index` needs a mark of at least `index + 1`.
    // Recording the bare index would leave the topmost particle just outside the
    // bound, which is worse than being wildly wrong: one invisible particle
    // looks like nothing is wrong at all.
    //
    // AFTER the entity write, so any observer of this value is guaranteed the
    // particle it describes already exists.
    atomicMax(&high_water, index + 1u);
}
