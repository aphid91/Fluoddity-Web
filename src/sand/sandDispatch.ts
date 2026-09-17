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
