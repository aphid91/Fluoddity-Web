/**
 * Invariant checking for the entity pool -- the free list and the entity buffer
 * read together.
 *
 * ## Why this exists
 *
 * Compaction bugs are silent, delayed, and present as something other than
 * themselves. A pool that hands out a live index does not fail at the moment it
 * does so; it fails minutes later as a particle the user cannot erase, or a
 * canvas that goes black when the mark drops past something still alive. By
 * then the operation that broke it is long gone.
 *
 * Every compaction bug so far has been a violation of one of the four
 * invariants below, and every one of them was found by a person noticing
 * something odd on screen and reporting it after the fact. That is not a
 * feedback loop that converges: the symptom does not name the cause, and the
 * causes are concurrency between a host that reads asynchronously and a GPU
 * that writes continuously.
 *
 * This module turns "something is wrong with the particles" into "invariant 2
 * violated: 47 live indices are in the free list, first at 1032". That is the
 * difference between guessing and knowing.
 *
 * ## A LEAF
 *
 * Takes plain arrays and returns a plain report. It touches no GPU resource, so
 * the checking logic is unit-testable under `node --test`; the readback that
 * feeds it lives on `ParticleSystem`, which owns the buffers.
 */

/** One broken invariant, with enough detail to act on. */
export interface PoolViolation {
  /** Which invariant, for grouping and for the headline. */
  readonly kind:
    | 'live-in-pool'
    | 'duplicate-in-pool'
    | 'unaccounted'
    | 'mark-too-low'
    | 'head-mismatch'
    | 'out-of-range';
  /** One line naming what is wrong and how big it is. */
  readonly detail: string;
  /** Example offenders, capped. Enough to grep for, not a data dump. */
  readonly samples: readonly number[];
  /** How many indices are affected in total. */
  readonly count: number;
}

export interface PoolAudit {
  readonly ok: boolean;
  readonly violations: readonly PoolViolation[];
  /** Live particles found by scanning the entity buffer. The GROUND TRUTH. */
  readonly liveCount: number;
  /** Free slots the pool claims, i.e. its head. */
  readonly poolCount: number;
  readonly mark: number;
  readonly capacity: number;
  /** Highest index holding a live particle, or -1 for an empty world. */
  readonly highestLive: number;
  /**
   * How far the host's cached head is from the pool's real one, or null when
   * no cached head was supplied.
   *
   * Reported separately from the violations because a small drift is the
   * NORMAL state of a running world: the head is a readback, and BC_KILL
   * returns indices to the pool every physics sub-step. See the tolerance in
   * `auditPool`.
   */
  readonly headDrift: number | null;
}

/** Cap on `samples`, so a wholly corrupt pool still prints something readable. */
const MAX_SAMPLES = 8;

/**
 * Check the pool against the entity buffer.
 *
 * `liveFlags[i]` is true when entity `i` is alive (`config_index >= 0`).
 * `poolSlots` is `slots[0 .. head)` -- the region the free list claims is
 * available, and ONLY that region: entries at or above the head are stale
 * residue from indices that have since been taken, and treating them as
 * available is itself one of the bugs this catches.
 *
 * ## The four invariants
 *
 * 1. NO LIVE INDEX IS IN THE POOL. A brush taking one overwrites a particle
 *    that exists. This is the most severe: it destroys user work silently.
 *
 * 2. NO INDEX APPEARS TWICE IN THE POOL. A double-free hands the same slot to
 *    two brushes, so one particle overwrites the other on creation.
 *
 * 3. EVERY INDEX IS ACCOUNTED FOR -- each is either live or in the pool. An
 *    index that is neither is LEAKED: dead memory that can never be reused, and
 *    the direct cause of the "phantom particles" reading, because the live
 *    estimate is derived from the pool's head rather than from the truth.
 *
 * 4. THE MARK BOUNDS EVERY LIVE PARTICLE. A live index at or above the mark is
 *    skipped by every pass and drawn by nothing -- present in memory, invisible
 *    on screen. This is what makes a canvas go black.
 *
 * `head-mismatch` is NOT one of the four. It is a property of the host's BELIEF
 * about the pool rather than of the pool, and the cached head is a readback that
 * lags by design -- so a small divergence is the normal state of a running
 * world, not a defect. It is reported only past a tolerance; the raw figure is
 * always available as `headDrift`.
 */
export function auditPool(args: {
  liveFlags: readonly boolean[];
  poolSlots: readonly number[];
  mark: number;
  capacity: number;
  /** The host's cached head, if it is worth cross-checking. */
  cachedHead?: number;
}): PoolAudit {
  const { liveFlags, poolSlots, mark, capacity } = args;
  const violations: PoolViolation[] = [];

  let liveCount = 0;
  let highestLive = -1;
  for (let i = 0; i < capacity; i++) {
    if (liveFlags[i] === true) {
      liveCount++;
      highestLive = i;
    }
  }

  // --- range, first: everything below assumes the indices are usable --------
  const outOfRange = poolSlots.filter((i) => !Number.isInteger(i) || i < 0 || i >= capacity);
  if (outOfRange.length > 0) {
    violations.push({
      kind: 'out-of-range',
      detail:
        `${outOfRange.length} pool entries are not valid indices into a ` +
        `${capacity}-slot buffer`,
      samples: outOfRange.slice(0, MAX_SAMPLES),
      count: outOfRange.length,
    });
  }

  // --- 2: duplicates --------------------------------------------------------
  const seen = new Set<number>();
  const duplicates: number[] = [];
  for (const slot of poolSlots) {
    if (seen.has(slot)) duplicates.push(slot);
    else seen.add(slot);
  }
  if (duplicates.length > 0) {
    violations.push({
      kind: 'duplicate-in-pool',
      detail:
        `${duplicates.length} indices appear more than once in the pool -- a ` +
        'double free, so two brushes can be handed the same slot',
      samples: duplicates.slice(0, MAX_SAMPLES),
      count: duplicates.length,
    });
  }

  // --- 1: live indices offered as free -- THE MOST SEVERE -------------------
  const liveInPool: number[] = [];
  for (const slot of seen) {
    if (liveFlags[slot] === true) liveInPool.push(slot);
  }
  if (liveInPool.length > 0) {
    liveInPool.sort((a, b) => a - b);
    violations.push({
      kind: 'live-in-pool',
      detail:
        `${liveInPool.length} LIVE indices are in the free list -- the next ` +
        'spawns will overwrite existing particles',
      samples: liveInPool.slice(0, MAX_SAMPLES),
      count: liveInPool.length,
    });
  }

  // --- 3: leaked indices ----------------------------------------------------
  const unaccounted: number[] = [];
  for (let i = 0; i < capacity; i++) {
    if (liveFlags[i] !== true && !seen.has(i)) unaccounted.push(i);
  }
  if (unaccounted.length > 0) {
    violations.push({
      kind: 'unaccounted',
      detail:
        `${unaccounted.length} dead slots are missing from the pool -- leaked ` +
        'capacity, and the live count reads high by this amount',
      samples: unaccounted.slice(0, MAX_SAMPLES),
      count: unaccounted.length,
    });
  }

  // --- 4: the mark must bound every live particle ---------------------------
  if (highestLive >= mark) {
    const above: number[] = [];
    for (let i = mark; i < capacity && above.length < MAX_SAMPLES; i++) {
      if (liveFlags[i] === true) above.push(i);
    }
    let count = 0;
    for (let i = mark; i < capacity; i++) if (liveFlags[i] === true) count++;
    violations.push({
      kind: 'mark-too-low',
      detail:
        `${count} live particles sit at or above the mark (${mark}) -- they are ` +
        'skipped by every pass and drawn by nothing',
      samples: above,
      count,
    });
  }

  // --- the host's belief, cross-checked -------------------------------------
  //
  // NOT A POOL VIOLATION, and deliberately held to a different standard.
  //
  // The cached head is a READBACK, a frame or two stale by construction, and
  // BC_KILL returns an index to the pool on every physics sub-step. So a small
  // disagreement is the normal, healthy state of a running world -- it is the
  // lag, not a defect, and reporting it as broken drowns the real invariants in
  // noise. That happened: a compaction that satisfied all four invariants was
  // reported as BROKEN purely because the cache had not caught up.
  //
  // A LARGE disagreement is still worth knowing about, because it means the
  // host is budgeting the brush against a number the pool does not recognise.
  // The threshold is what separates "a few frames of edge deaths" from "these
  // two describe different worlds".
  const HEAD_LAG_TOLERANCE = 4096;
  let headDrift: number | null = null;
  if (args.cachedHead !== undefined) {
    const drift = Math.abs(args.cachedHead - poolSlots.length);
    headDrift = drift;
    if (drift > HEAD_LAG_TOLERANCE) {
      violations.push({
        kind: 'head-mismatch',
        detail:
          `the host believes ${args.cachedHead} slots are free but the pool ` +
          `holds ${poolSlots.length} -- too far apart to be readback lag, so ` +
          "the UI's live count is genuinely wrong",
        samples: [],
        count: drift,
      });
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    liveCount,
    poolCount: poolSlots.length,
    mark,
    capacity,
    highestLive,
    headDrift,
  };
}

/**
 * One-line summary, for a status line or a console.
 *
 * Leads with the counts, because "live 10,432 / pool 2,989,568 / mark 100,000"
 * is often enough on its own to see that the mark is absurd for the population.
 */
export function summarizeAudit(audit: PoolAudit): string {
  const head =
    `live ${audit.liveCount.toLocaleString()} · ` +
    `pool ${audit.poolCount.toLocaleString()} · ` +
    `mark ${audit.mark.toLocaleString()} / ${audit.capacity.toLocaleString()}`;
  if (audit.ok) return `POOL OK — ${head}`;
  const worst = audit.violations[0];
  return `POOL BROKEN (${audit.violations.length}) — ${head} — ${worst?.detail ?? ''}`;
}

/** Full multi-line report, for the console where space is not scarce. */
export function formatAudit(audit: PoolAudit): string {
  const lines = [summarizeAudit(audit)];
  if (audit.highestLive >= 0) {
    lines.push(`  highest live index: ${audit.highestLive.toLocaleString()}`);
  }
  // The identity every healthy pool satisfies. Printed always, because seeing
  // it hold is how a reader learns to trust the rest of the report.
  const accounted = audit.liveCount + audit.poolCount;
  lines.push(
    `  live + pool = ${accounted.toLocaleString()} ` +
      `(capacity ${audit.capacity.toLocaleString()})` +
      (accounted === audit.capacity ? ' ✓' : ' ✗ MISMATCH'),
  );
  // Shown even when it is within tolerance, because a drift that grows across
  // successive audits is a signal even while each one passes -- and hiding it
  // entirely would make the tolerance itself invisible.
  if (audit.headDrift !== null) {
    lines.push(`  cached head drift: ${audit.headDrift.toLocaleString()} (readback lag)`);
  }
  for (const v of audit.violations) {
    lines.push(`  [${v.kind}] ${v.detail}`);
    if (v.samples.length > 0) {
      const shown = v.samples.join(', ');
      const more = v.count > v.samples.length ? `, … (${v.count} total)` : '';
      lines.push(`      e.g. ${shown}${more}`);
    }
  }
  return lines.join('\n');
}
