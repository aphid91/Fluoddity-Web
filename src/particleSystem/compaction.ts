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
 * The mark after a spawn pass reports how far up the buffer it reached.
 *
 * ## The bug this exists to make testable
 *
 * The mark used to be raised by a COUNT: `mark = mark + spawned`. That silently
 * assumes the brush took CONTIGUOUS indices starting at the mark, which is true
 * in a fresh world -- `initialFreeList` fills descending, so the pool hands out
 * 0, 1, 2, ... -- and false as soon as the eraser has run. `free_list_give`
 * returns freed indices in whatever order the GPU retires them, so an erased
 * pool is a scatter, and the next stroke takes high indices while the mark rises
 * by a few hundred.
 *
 * Every particle above the bound is then skipped by every pass and drawn by
 * nothing. The audit reported it as "179 live particles sit at or above the mark
 * (451076)" with the highest live index at 451,254 -- and the same shape at
 * 113,531 particles once a restore churned the whole pool at once.
 *
 * `freeListSort.wgsl` mitigates and cannot fix it: a budgeted partial sort that
 * the host skips on every frame that spawned, which is every frame of a drag.
 *
 * ## RAISE-ONLY, which is what makes the readback lag safe
 *
 * `reach` is measured on the GPU and arrives a frame or two later, so it may
 * describe a stroke older than the mark already reflects. Lowering to it would
 * undo a later stroke's accounting and hide its particles -- the same failure
 * from the other direction. A late arrival must therefore be a no-op, not a
 * correction.
 *
 * Lowering is the sole business of `noteCompactedMark`, which relocates
 * particles and can prove where the highest live one is, and of
 * `canDropMarkToZero` when the pool is provably empty.
 *
 * Pure and here rather than on `ParticleSystem` because that class needs a GPU
 * device to construct, so nothing about it runs under `node --test` -- which is
 * precisely why the count-based version survived as long as it did.
 */
export function markAfterSpawnReach(
  mark: number,
  reach: number,
  entityCount: number,
): number {
  const capacity = Math.max(0, Math.trunc(entityCount));
  const current = Math.max(0, Math.min(capacity, Math.trunc(mark)));
  if (!Number.isFinite(reach)) return current;
  const want = Math.max(0, Math.min(capacity, Math.trunc(reach)));
  return Math.max(current, want);
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

// The Tier 2 sweep's arithmetic lived here -- target, chunk cursor, progress,
// and an auto-trigger with quiet and cooldown windows. ALL OF IT IS GONE.
//
// Every one of those existed to describe a compaction that ran across many
// frames while the world changed underneath it: how far had it got, was its
// answer still valid, had the brush invalidated it, when was it safe to start
// another. GPU compaction runs in a single frame, so none of those questions
// can be asked, let alone answered wrongly.
//
// `compactPlan.ts` has what replaced it: dispatch sizing, and one predicate for
// whether compacting is worth the frame.

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
