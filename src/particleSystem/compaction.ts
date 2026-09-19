/**
 * Host-side arithmetic for keeping the dead-index pool ORDERED.
 *
 * This is Tier 1 of compaction, and it moves NO PARTICLES. The high-water mark
 * (`activeEntityCount`) is an upper bound on the highest live index, and it only
 * creeps upward when the free list hands out a HIGH index while low ones are
 * still available. Keeping the pool ordered so the lowest free index always pops
 * first is therefore a way to stop the mark creeping in the first place, without
 * ever touching an entity.
 *
 * `freeListAfterMigration` already establishes exactly this ordering after a
 * Max Particles resize, and says why: it "keeps a freshly-migrated world
 * allocating contiguously upward from the live block, rather than scattering new
 * particles across the tail". This module is that same idea applied to a pool
 * that has been churned by the eraser rather than rebuilt by a migration.
 *
 * ## Why the order decays at all
 *
 * `initialFreeList` fills descending, so a fresh world hands out 0, 1, 2, ... in
 * order. The ERASER is what breaks it: `free_list_give` pushes freed indices at
 * whatever order the GPU happens to retire them in, so after a few erase strokes
 * the top of the stack is an arbitrary scatter. Paint again and the brush takes
 * those scattered indices -- live particles spread across the whole range, and
 * the mark can no longer come down even though most of the buffer is dead.
 *
 * ## A LEAF, like `freeList.ts`
 *
 * Imports nothing and touches no GPU resource, so it runs under `node --test`
 * without a browser. The GPU-side partial sort lives in `freeListSort.wgsl`; the
 * exact sort here is the host's, used behind the Dev panel's manual button where
 * a pipeline stall is acceptable.
 */

/**
 * Sort the live region of a free-list image so the LOWEST index pops first.
 *
 * `image` is the buffer as read back: `image[0]` is the head, `image[1..]` are
 * the slots. Only `slots[0 .. head)` carries meaning -- everything from `head`
 * upward is stale residue from indices that have since been taken, and sorting
 * it in would resurrect dead entries as available ones. That is a DOUBLE-ALLOC
 * bug, not a cosmetic one, which is why the region is bounded rather than the
 * whole array being sorted.
 *
 * DESCENDING, because the stack pops from the top (`slots[head - 1]`). Sorting
 * descending puts the smallest index at the top, so it is handed out next. This
 * is the same direction, and for the same reason, as `freeListAfterMigration`.
 *
 * Returns a NEW array rather than sorting in place: the caller's copy is a
 * mapped-range slice, and leaving the input untouched keeps this pure and
 * testable.
 */
export function sortedFreeList(image: Uint32Array): Uint32Array<ArrayBuffer> {
  const out = new Uint32Array(new ArrayBuffer(image.length * 4));
  out.set(image);
  const head = image[0] ?? 0;
  // A head past the array is corruption or a torn read. Return the image
  // unchanged rather than sorting a region that does not exist -- the same
  // "discard rather than believe it" stance `pollFreeListRead` takes.
  if (head === 0 || head > image.length - 1) return out;

  const live = out.subarray(1, 1 + head);
  live.sort();      // ascending
  live.reverse();   // -> descending, so slots[head-1] is the lowest index
  return out;
}

/**
 * How many slots the per-frame GPU pass should touch this frame.
 *
 * THE WHOLE POINT OF TIER 1 IS THAT IT NEVER STUTTERS, so the work is a flat
 * budget rather than a fraction of the pool: a 3M-slot pool and a 30k-slot pool
 * cost the same per frame, and only the number of frames to converge differs.
 *
 * Clamped to the head because slots at or above it are not ours to touch.
 */
export function sortBudgetFor(head: number, budget: number): number {
  if (head <= 1 || budget <= 0) return 0;
  return Math.min(Math.max(0, Math.trunc(budget)), head);
}

/**
 * Whether the mark can be dropped to zero.
 *
 * ## The one provably safe mark reduction
 *
 * `activeEntityCount` documents why the mark is never lowered: a freed slot
 * below it gets reused before it grows, so shrinking it risks skipping a live
 * particle. There is exactly one exception -- if EVERY slot is free, there are
 * no live particles at all, so no index can be skipped. The mark can go to zero.
 *
 * That case is not a curiosity: "paint a lot, then erase all of it" is ordinary
 * use, and without this the world keeps paying the full mark forever afterwards.
 *
 * ## WHY A FULL HEAD ALONE IS NOT ENOUGH
 *
 * `availableSlots` is a readback and is a frame or two STALE (see
 * `recordFreeListRead`). A head captured before a spawn still reads full after
 * it, so acting on the head alone could zero the mark while a particle painted
 * in the interim sits above it -- present in memory, skipped by the physics,
 * drawn by nothing. Exactly the failure `restoreHighWaterMark` exists to avoid.
 *
 * `spawnedSinceRead` is the host's count of spawns the readback does not yet
 * know about, and requiring it to be zero is what makes the head TRUSTWORTHY
 * rather than merely full. Both conditions together mean: the pool was empty as
 * of the read, and nothing has been created since.
 */
export function canDropMarkToZero(
  head: number,
  entityCount: number,
  spawnedSinceRead: number,
): boolean {
  return entityCount > 0 && head === entityCount && spawnedSinceRead === 0;
}

/**
 * Live particle count implied by a head, for the Dev panel's readout.
 *
 * Stale by the same frame or two the head is, and clamped because a torn read
 * could otherwise report a negative population.
 */
export function liveCountFrom(head: number, entityCount: number): number {
  return Math.max(0, Math.min(entityCount, entityCount - head));
}

// ===========================================================================
// TIER 2 -- the sweep that actually moves particles.
//
// Tier 1 stops the mark CREEPING. It cannot bring a mark down that has already
// risen, because lowering the bound is only safe once you know where the
// highest live particle is -- and the only way to know that is to put it
// somewhere. Tier 2 relocates live particles into the dead holes below them,
// which is what makes a lower bound provable rather than hopeful.
//
// ## WHY IT IS A SWEEP AND NOT ONE PASS
//
// A whole-buffer compaction at a 3M cap is exactly the stutter this work exists
// to avoid. So the range is walked in BUDGETED CHUNKS, one per frame, and the
// budget is flat: cost per frame is independent of world size, and only the
// number of frames to finish varies.
//
// ## WHY A PARTIAL SWEEP IS SAFE TO ABANDON
//
// Every chunk leaves a VALID WORLD. Relocating a particle changes which index
// holds it, and nothing outside the free list attaches meaning to an entity's
// index -- no pass, no render, no config lookup. A sweep stopped halfway has
// simply moved some particles and not others, which is a legal arrangement
// that happens not to be packed yet.
//
// That is the whole reason abort is free, and it is what makes this
// stutter-proof in practice: the sweep never has to finish. It only lowers the
// mark on COMPLETION, so an abandoned sweep costs nothing but the work already
// done, and that work is kept.
// ===========================================================================

/**
 * A sweep in progress.
 *
 * `hi` walks DOWNWARD from the mark; everything at or above it has been dealt
 * with. `target` is where the live particles are being packed below. The sweep
 * is finished when `hi` reaches `target`, at which point nothing live remains
 * above it and the mark can become `target`.
 */
export interface SweepState {
  /** Exclusive upper bound of the range still to examine. Walks down. */
  readonly hi: number;
  /** The packed size being aimed at. Fixed for the life of the sweep. */
  readonly target: number;
}

/**
 * Where a sweep should aim, given what is live now.
 *
 * ## THE HEADROOM IS NOT OPTIONAL
 *
 * Aiming at exactly `live` would be correct only if `live` were exact, and it
 * is not: it comes from a head readback that is a frame or two stale, and the
 * sweep itself takes many frames during which the eraser may run. A target
 * below the true live count cannot be reached -- the sweep would walk `hi` all
 * the way down to `target` with live particles still above it, and completing
 * on that would set a mark that SKIPS them.
 *
 * The margin makes the target reachable under a live count that moved after it
 * was chosen. It costs a little unpacked space and buys the invariant that
 * completion means what it says.
 *
 * Rounded up to a multiple of the budget so the final chunk is a whole one
 * rather than a ragged remainder.
 */
export function sweepTargetFor(live: number, mark: number, budget: number): number {
  if (mark <= 0) return 0;
  // 12.5% headroom, floored at one budget's worth so a nearly-empty world still
  // gets a sane target rather than zero.
  const margin = Math.max(budget, Math.ceil(live * 0.125));
  const target = Math.min(mark, live + margin);
  return Math.max(0, Math.min(mark, Math.ceil(target / budget) * budget));
}

/**
 * Whether a sweep is worth starting.
 *
 * A packed world has nothing to gain and a sweep over it is pure cost, so the
 * trigger is the occupancy ratio rather than the live count: what matters is
 * how much of the swept range is wasted, not how big the world is.
 *
 * The mark floor keeps this from firing on worlds too small for the saving to
 * be measurable -- at a 20k mark the passes are cheap whatever the occupancy.
 */
export function sweepWorthwhile(
  live: number,
  mark: number,
  minMark = 65536,
  maxOccupancy = 0.6,
): boolean {
  if (mark < minMark) return false;
  return occupancy(live, mark) < maxOccupancy;
}

/**
 * The next chunk of a sweep, or null when it is finished.
 *
 * Returns the half-open range `[lo, hi)` to examine and the state to carry to
 * the next frame. The range is clamped at `target`: the sweep examines only the
 * region ABOVE where it is packing, because a live particle already below the
 * target is already where it belongs.
 */
export function nextSweepChunk(
  state: SweepState,
  budget: number,
): { lo: number; hi: number; next: SweepState } | null {
  if (state.hi <= state.target) return null;
  const size = Math.max(1, Math.trunc(budget));
  const lo = Math.max(state.target, state.hi - size);
  return { lo, hi: state.hi, next: { hi: lo, target: state.target } };
}

/** Whether a sweep has examined everything above its target. */
export function sweepComplete(state: SweepState): boolean {
  return state.hi <= state.target;
}

/**
 * How far along a sweep is, 0..1 -- for the Dev panel's readout.
 *
 * Measured over the range the sweep actually walks (`mark` down to `target`),
 * not over the whole buffer, so it reaches 1.0 exactly when the sweep ends.
 */
export function sweepProgress(state: SweepState, mark: number): number {
  const span = mark - state.target;
  if (span <= 0) return 1;
  return Math.max(0, Math.min(1, (mark - state.hi) / span));
}

/**
 * Occupancy below the mark: what fraction of the swept range is actually live.
 *
 * THE NUMBER THAT SAYS WHETHER COMPACTION IS WORTH DOING. Every pass visits
 * `mark` entities; only `live` of them do any work. At 1.0 the buffer is packed
 * and Tier 2 has nothing to gain; at 0.05 the world is paying twenty invocations
 * per particle that exists.
 *
 * A zero mark is reported as fully packed rather than as a division by zero --
 * an empty world is not fragmented, and showing 0% for it would read as the
 * worst possible state when it is in fact the best.
 */
export function occupancy(live: number, mark: number): number {
  if (mark <= 0) return 1;
  return Math.max(0, Math.min(1, live / mark));
}
