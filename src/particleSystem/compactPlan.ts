/**
 * Dispatch arithmetic for GPU-only compaction.
 *
 * ## What the compaction is
 *
 * Four passes, one encoder, no host involvement in any write:
 *
 *   1. COUNT    per-workgroup tally of live entities
 *   2. SCAN     exclusive prefix sum over those tallies
 *   3. SCATTER  every live entity to its packed destination, every dead slot
 *               to the free list
 *   4. FINALIZE the free-list head and the mark
 *
 * ## Why this shape rather than the probe-and-relocate one it replaces
 *
 * The previous design relocated particles into dead slots found by probing,
 * and never told the free list that those slots had been consumed. Every
 * relocation leaked one slot. The audit found it immediately -- tens of
 * thousands of dead indices missing from the pool -- and it was unfixable in
 * place, because the host was reconstructing the pool by inference from a
 * boundary while the GPU was the only thing that knew the truth.
 *
 * A prefix-sum scatter removes the inference. The free list is written FROM
 * SCRATCH: every index is assigned exactly once, either as a relocated live
 * particle or as a free slot. Nothing can leak, nothing can be double-offered,
 * and nothing live can end up in the pool -- not because the code argues so,
 * but because the scatter is a permutation.
 *
 * The mark falls out for free. The output is genuinely packed, so the highest
 * live index is the live count minus one, and the bound is exact rather than
 * an upper estimate that can only ever grow.
 *
 * ## A LEAF
 *
 * Imports nothing and touches no GPU resource, so the arithmetic that sizes
 * every dispatch is testable under `node --test`. Same reason `dispatch.ts` and
 * `sizing.ts` are their own modules.
 */

/**
 * ## WHY THE SCATTER WRITES TO SCRATCH AND IS COPIED BACK, RATHER THAN SWAPPED
 *
 * The scatter cannot write the entity buffer in place: a live entity moving
 * from 500 to 12 races another invocation reading 12 as its own source, and
 * within one dispatch there is no ordering between them. So it needs a second
 * buffer.
 *
 * The obvious move is to keep two buffers and swap them. That was rejected
 * because `entityBuffer` is baked into FOUR bind groups inside ParticleSystem
 * (entity-update, brush, pick) and into bind groups owned by OTHER modules --
 * `SandPasses` caches one each for spawn, kill and compaction, and the camera
 * caches one per frame. WebGPU bind groups are immutable, so a swap invalidates
 * every one of them, and a missed rebuild is a pass silently operating on the
 * stale buffer: particles that render but do not simulate, or vice versa.
 *
 * Copying back costs one GPU-local buffer copy -- a few milliseconds at a large
 * cap, against a compaction that is already several passes over the same data.
 * In exchange the entity buffer object NEVER CHANGES, so every bind group
 * anywhere stays valid and no other module needs to know compaction exists.
 *
 * That trade is deliberately weighted toward correctness at the call sites.
 * This subsystem's failures have all been silent ones, and "every bind group
 * stays valid by construction" removes a whole category of them.
 */

/**
 * MUST match `@workgroup_size(256)` in every compaction shader.
 *
 * One size across all four passes, unlike the brush passes which differ: these
 * all sweep the entity buffer at the same scale, and the COUNT and SCATTER
 * passes must agree exactly -- the scatter reads the offset that count's
 * workgroup produced, so a mismatch would index the wrong partial and pack
 * particles on top of each other.
 */
export const COMPACT_WORKGROUP_SIZE = 256;

/**
 * How many entities one workgroup tallies in the COUNT pass.
 *
 * Equal to the workgroup size: one entity per invocation, no serial loop. Kept
 * as its own name because the SCATTER pass must partition the buffer
 * identically, and a reader needs to see that the two are the same number by
 * intent rather than by coincidence.
 */
export const ENTITIES_PER_PARTIAL = COMPACT_WORKGROUP_SIZE;

/**
 * Number of partial sums the COUNT pass produces for `entityCount` entities.
 *
 * This is also the length of the buffer the SCAN pass must cover, and it is the
 * number that decides whether one scan level is enough -- see `scanLevels`.
 */
export function partialCount(entityCount: number): number {
  if (entityCount <= 0) return 0;
  return Math.ceil(entityCount / ENTITIES_PER_PARTIAL);
}

/**
 * How many elements a single scan workgroup can handle.
 *
 * A workgroup of 256 threads scans 512 elements with the standard
 * two-element-per-thread Blelloch pattern. Stated as its own constant because
 * the shader's workgroup array is sized to it and the two must agree.
 */
export const SCAN_ELEMENTS_PER_GROUP = COMPACT_WORKGROUP_SIZE * 2;

/**
 * How many levels of scan are needed to reduce `partials` to a single running
 * total.
 *
 * ## WHY THIS IS NOT ALWAYS ONE
 *
 * The obvious implementation scans the partials in a single workgroup, and that
 * works until the partial count exceeds what one workgroup can cover. At a 6M
 * entity cap there are 23,438 partials -- far past the 512 a single group
 * handles -- so a one-level scan would silently sum only the first 512
 * workgroups' worth and pack every particle beyond that on top of each other.
 *
 * Silently: there is no error, just a world that loses most of its particles
 * the first time it is compacted at a large cap. Hence this is computed rather
 * than assumed.
 *
 * Level 0 scans the partials; level 1 scans the per-group totals level 0
 * produced; and so on until one group covers what remains.
 */
export function scanLevels(partials: number): number {
  if (partials <= 1) return 0;
  let levels = 0;
  let remaining = partials;
  while (remaining > 1) {
    remaining = Math.ceil(remaining / SCAN_ELEMENTS_PER_GROUP);
    levels++;
  }
  return levels;
}

/** Elements at each scan level, outermost first. `[]` for a trivial scan. */
export function scanLevelSizes(partials: number): number[] {
  const sizes: number[] = [];
  let remaining = partials;
  while (remaining > 1) {
    sizes.push(remaining);
    remaining = Math.ceil(remaining / SCAN_ELEMENTS_PER_GROUP);
  }
  return sizes;
}

/**
 * Total u32 slots a scan scratch buffer needs for `entityCount` entities.
 *
 * Every level's partials laid end to end, plus one for the grand total. Sized
 * once with the entity buffer rather than per compaction -- allocating 24 MB in
 * the middle of a frame is exactly the hitch this work exists to avoid.
 */
export function scanScratchSlots(entityCount: number): number {
  const sizes = scanLevelSizes(partialCount(entityCount));
  const total = sizes.reduce((sum, n) => sum + n, 0);
  // At least one slot: a zero-length storage buffer fails WebGPU's minimum
  // binding size, which is the same trap `freeListSize` documents at length.
  return Math.max(1, total + 1);
}

/**
 * The reserved word holding the GRAND TOTAL of live entities.
 *
 * ## Why it needs a slot of its own
 *
 * An exclusive prefix sum DISCARDS the total: the last element's output is the
 * sum of everything before it, not including itself. So after the scan the live
 * count exists nowhere in the scratch buffer -- and both the scatter (to place
 * free slots) and the finalize pass (to set the head and the mark) need it.
 *
 * The last scan level writes it here. It sits past every level's slice, which
 * is what the `+ 1` in `scanScratchSlots` reserves.
 */
export function totalSlot(entityCount: number): number {
  const sizes = scanLevelSizes(partialCount(entityCount));
  return sizes.reduce((sum, n) => sum + n, 0);
}

/** Byte offset of each scan level within the scratch buffer. */
export function scanLevelOffsets(entityCount: number): number[] {
  const sizes = scanLevelSizes(partialCount(entityCount));
  const offsets: number[] = [];
  let at = 0;
  for (const size of sizes) {
    offsets.push(at);
    at += size;
  }
  return offsets;
}

/**
 * Workgroups covering `n` items. Rounds up, so the last group runs partly out
 * of range and the shaders' bounds checks are what make that safe.
 */
export function compactGroups(n: number): number {
  return Math.max(0, Math.ceil(n / COMPACT_WORKGROUP_SIZE));
}

/** Workgroups for one scan level over `n` elements. */
export function scanGroups(n: number): number {
  return Math.max(0, Math.ceil(n / SCAN_ELEMENTS_PER_GROUP));
}

/**
 * Whether compacting is worth the frame it costs.
 *
 * A single-pass compaction is a stutter on a large world, so it should not fire
 * on a world that is already packed. The ratio is what matters, not the count:
 * every pass visits `mark` entities and only `live` of them do any work.
 *
 * The floor keeps it from firing where the saving is unmeasurable -- at a 64k
 * mark the passes are cheap whatever the occupancy, and the compaction would
 * cost more than it returns.
 */
export function compactionWorthwhile(
  live: number,
  mark: number,
  minMark = MIN_COMPACT_MARK,
  maxOccupancy = MAX_COMPACT_OCCUPANCY,
): boolean {
  if (mark < minMark) return false;
  if (mark <= 0) return false;
  return live / mark < maxOccupancy;
}

/**
 * Occupancy at or above which a world is packed enough to leave alone.
 *
 * At 70% the passes are sweeping three dead slots for every seven live ones,
 * which is cheap enough not to be worth a frame. Below it the waste grows fast
 * -- and unlike the old incremental sweep, a compaction here costs one frame
 * whatever the state, so the threshold can be generous without risk.
 */
export const MAX_COMPACT_OCCUPANCY = 0.7;

/**
 * Below this mark, compacting costs more than it saves.
 *
 * Every pass visits `mark` entities, so at 64k the per-frame cost is already
 * negligible however sparse the buffer is -- while a compaction is four passes
 * over the whole buffer plus a full-size copy, and that does not get cheaper
 * just because few particles are live.
 */
export const MIN_COMPACT_MARK = 65536;

/**
 * The shortest gap between automatic compactions.
 *
 * ## Why a floor is needed at all
 *
 * A compaction lowers the mark to the live count exactly, so the world is
 * fully packed the instant it finishes -- occupancy 100%, and the trigger
 * cannot fire again until the mark has risen and particles have died. That is
 * self-limiting, and in a calm world nothing more would be required.
 *
 * It is not self-limiting under a brush. Painting raises the mark on every
 * frame while edge-death and the eraser lower the live count, so a world being
 * actively drawn in can cross below the threshold again within a few frames of
 * being compacted. Without a floor that becomes a compaction every few frames,
 * each one skipping a physics step -- a stutter caused entirely by the thing
 * meant to prevent stutter.
 *
 * Two seconds is long enough that the cost is unnoticeable at any frame rate
 * and short enough that a world being rapidly erased is tidied promptly.
 */
export const COMPACT_COOLDOWN_MS = 2000;

/**
 * Whether an automatic compaction should start now.
 *
 * Pure, so the policy is testable without a device or a clock: every input that
 * varies is a parameter, and the caller supplies the time. The orchestrator
 * only supplies readings and acts on the answer.
 *
 * ## The conditions
 *
 * `enabled`   the user's switch, first because nothing else matters if off.
 * `idle`      no compaction already queued. A second request would be
 *             redundant, and the one queued is about to fix the world anyway.
 * `worth it`  occupancy below the threshold and the mark above the floor.
 * `cooled`    far enough from the last one. See `COMPACT_COOLDOWN_MS`.
 *
 * NO QUIET PERIOD, unlike the incremental sweep this replaces. That design had
 * to wait for the user to stop painting, because a brush stroke would abort a
 * sweep mid-flight and the abort was expensive. A GPU compaction occupies one
 * frame on which the brush passes simply do not run, so painting through it
 * costs a single frame of deposited material and nothing else.
 */
export function shouldAutoCompact(args: {
  enabled: boolean;
  idle: boolean;
  live: number;
  mark: number;
  now: number;
  lastCompactedAt: number;
  cooldownMs?: number;
}): boolean {
  if (!args.enabled || !args.idle) return false;
  if (!compactionWorthwhile(args.live, args.mark)) return false;
  return args.now - args.lastCompactedAt >= (args.cooldownMs ?? COMPACT_COOLDOWN_MS);
}
