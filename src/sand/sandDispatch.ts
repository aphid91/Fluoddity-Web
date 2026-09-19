/**
 * Dispatch arithmetic and workgroup sizes for the brush passes.
 *
 * Its own module, and a leaf, for the same mundane reason `dispatch.ts` is:
 * `sandPasses.ts` imports `.wgsl` files, which only resolve through the Vite
 * plugin -- so nothing under `node --test` can import it. Keeping the numbers
 * here means the one piece of the passes that is pure arithmetic stays testable
 * without a browser, and `sandShaders.test.ts` can assert the shaders agree
 * with them.
 */

/**
 * MUST match `@workgroup_size(64)` in `spawn.wgsl`.
 *
 * 64 rather than the entity update's 256 because this dispatch is sized to the
 * SPAWN COUNT, typically a few hundred: at 256 a 100-particle brush launches one
 * group with 156 invocations returning immediately. Drifting this from the
 * shader under-dispatches silently -- the brush simply paints fewer particles
 * than asked for, which reads as a weak brush rather than as a bug.
 */
export const SPAWN_WORKGROUP_SIZE = 64;

/**
 * MUST match `@workgroup_size(256)` in `kill.wgsl`.
 *
 * 256 because this dispatches over the whole entity buffer, like the entity
 * update. Drifting it leaves a tail of particles the eraser cannot touch.
 */
export const KILL_WORKGROUP_SIZE = 256;

/**
 * MUST match `@workgroup_size(256)` in `freeListSort.wgsl`.
 *
 * 256 for the same reason the kill pass uses it: this dispatches over a region
 * of the pool at entity scale rather than at brush scale.
 */
export const SORT_WORKGROUP_SIZE = 256;

/**
 * How many slots one frame's ordering pass may touch.
 *
 * THE NUMBER THAT MAKES TIER 1 STUTTER-FREE. It is a flat budget rather than a
 * fraction of the pool, so a 3M-slot world and a 30k-slot world cost the same
 * per frame and only the number of frames to converge differs. At 16384 the pass
 * is 64 workgroups -- negligible beside a physics dispatch that covers the whole
 * high-water mark several times per frame.
 *
 * Raising it converges faster and costs more per frame; the point of the budget
 * is that the cost is bounded and predictable, so this should stay small.
 */
export const SORT_SLOT_BUDGET = 16384;

/**
 * MUST match `@workgroup_size(256)` in `compact.wgsl`.
 *
 * 256 because it dispatches over a region of the entity buffer, like the kill
 * pass.
 */
export const COMPACT_WORKGROUP_SIZE = 256;

/**
 * How many source slots one frame's compaction chunk examines.
 *
 * SMALLER THAN THE TIER 1 BUDGET, and deliberately: an ordering invocation is a
 * read, a compare and maybe a swap, while a compaction invocation may probe
 * several slots and copy a whole entity. The budgets are both flat, but they
 * are not the same size of work, so they do not share a number.
 *
 * At 8192 a 1M-slot sweep is ~122 frames, about two seconds at 60fps. That is
 * the intended feel: a compaction is something you notice finishing, not
 * something that hitches.
 */
export const COMPACT_SLOT_BUDGET = 8192;

/**
 * How many candidate slots one particle may test before giving up.
 *
 * THE GUARD AGAINST A HANG, not a tuning knob. A particle that cannot find a
 * destination would otherwise spin until the cursor passed the target, and a
 * whole workgroup doing that at once is a hang rather than a slowdown.
 *
 * 32 is generous for the worlds a sweep actually runs on: the trigger requires
 * occupancy below 60%, where the chance of 32 consecutive probes all hitting
 * live particles is negligible. Giving up costs a wasted chunk, never
 * correctness -- the particle stays put and the mark is simply not lowered.
 */
export const COMPACT_MAX_PROBES = 32;

/**
 * Workgroups covering `n` items at `size` per group. Rounds up, so the last
 * group is partly out of range -- both shaders' bounds checks are what make
 * that safe, and the two must be read together.
 *
 * Zero items is zero groups, not one: the spawn path returns before dispatching
 * when the brush is idle, and a stray group would run 64 invocations that can
 * only fail their bounds check.
 */
export function workgroupsFor(n: number, size: number): number {
  return Math.max(0, Math.ceil(n / size));
}
