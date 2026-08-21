/**
 * The physics-rate search: what to probe next, given what has been measured.
 *
 * A pure leaf -- no DOM, no GPU, no clock. The whole point is that the decision
 * rule can be tested against synthetic machines (a fast one, a slow one, a
 * vsync-capped one, a noisy one) without a browser, because a search that
 * misbehaves on real hardware is very hard to debug after the fact.
 *
 * ## The measurement is FRAME TIME, not frame rate
 *
 * This is the single decision the rest of the file rests on, so it comes first.
 *
 * Frame time is very nearly LINEAR in physics rate: the rate is a sub-step
 * count, each sub-step costs about the same, so doubling the rate roughly
 * doubles the simulation's share of the frame. Frame RATE is `1/x` of that --
 * a hyperbola, whose slope changes by an order of magnitude across the range we
 * care about.
 *
 * Working in milliseconds therefore turns the search into simple proportion:
 *
 *     want = current * (budget / measured)
 *
 * Measured 25 ms at rate 20 with a 16.7 ms budget? Then 20 * (16.7/25) ~= 13.
 * One step, no damping constant, no tuning. That is Newton's method on a nearly
 * straight line, and it lands within a rung or two from anywhere.
 *
 * ## The plateau, and why this is not a binary search
 *
 * A binary search wants a clean monotonic boundary to bisect. Above the display
 * refresh rate there isn't one: `requestAnimationFrame` is vsync-paced, so every
 * rate the machine can comfortably afford measures the SAME 16.7 ms. The upper
 * region is a flat plateau with no gradient, and bisecting into a plateau is
 * exactly where subtle, hard-to-reproduce failures live.
 *
 * So the plateau gets its own move. A measurement at or under budget teaches
 * only "at least this much is affordable", and the response is to climb
 * multiplicatively (`CLIMB_FACTOR`) until something finally costs more than a
 * frame -- at which point there is a real number to estimate from. No assumption
 * about where the edge is; the machine is asked.
 *
 * ## Everything is clamped
 *
 * A single bad measurement -- a GC pause, a background tab waking up -- must not
 * be able to fling the rate to an extreme. `MAX_STEP` bounds how far one
 * estimate may move, so a wild reading costs an extra probe rather than a wrong
 * answer.
 */

/**
 * The frame budget the search aims at, in milliseconds.
 *
 * 60 fps, matching `calibration/progression.ts`'s `TARGET_FRAME_MS` and
 * `perf/fpsBand.ts` -- the app is budgeted for 60 whatever the display does.
 */
export const TARGET_MS = 16.7;

/**
 * A measurement at or under this is "the meter is maxed out".
 *
 * Slightly ABOVE `TARGET_MS`, and that matters: a machine holding vsync
 * perfectly reports 16.5-17.5 ms depending on how the browser rounds its
 * callback times, so a threshold at exactly 16.7 would read normal jitter as
 * "over budget" and walk the rate down for no reason.
 */
const PLATEAU_MS = 17.6;

/**
 * How much to multiply the rate by when the measurement is on the plateau.
 *
 * 1.7, which crosses the useful range (1..120) in about a dozen steps from the
 * bottom and usually far fewer, since the search starts from wherever the user
 * already is rather than from 1.
 */
const CLIMB_FACTOR = 1.7;

/**
 * The most one estimate may multiply or divide the rate by.
 *
 * 2.5 in either direction. Wide enough that a genuine misjudgement is corrected
 * in one step, narrow enough that a single pathological frame cannot send the
 * search to a bound.
 */
const MAX_STEP = 2.5;

/**
 * The safety margin applied to the final answer.
 *
 * 0.9 -- the committed rate is 10% below the one that exactly filled the budget.
 * A setting tuned to precisely 60 fps stops holding it the moment the GPU warms
 * up or another window takes a slice, and the counter this feeds would then sit
 * in yellow while the user watched. Being one rung conservative is invisible;
 * being one rung optimistic is a stutter.
 */
const SAFETY = 0.9;

/** How many probes the search may spend before committing what it has. */
export const MAX_PROBES = 8;

/** One measurement: the rate that was probed, and what a frame then cost. */
export interface Probe {
  readonly rate: number;
  readonly frameMs: number;
}

/** What the search wants next: another probe, or a final answer. */
export type SearchStep =
  | { readonly kind: 'probe'; readonly rate: number }
  | { readonly kind: 'done'; readonly rate: number };

/**
 * Decide the next move from the probes taken so far.
 *
 * PURE and total: every path returns, and `history` may be empty (the first
 * call) or as long as `MAX_PROBES`. `lo`/`hi` are the slider's own bounds, so
 * the search can never propose a rate the user could not also have dialled in.
 *
 * The rules, in the order they are tried:
 *
 *   1. **Out of probes** -> commit the best affordable rate seen.
 *   2. **No probes yet** -> measure where the user already is. Their current
 *      setting is as good a starting guess as any, and often the answer.
 *   3. **On the plateau** -> climb, because a capped measurement carries no
 *      gradient to estimate from. If the climb is already at the ceiling, stop:
 *      the machine affords the maximum.
 *   4. **Over budget** -> estimate directly, clamped.
 *   5. **Converged** -> the estimate is not moving; commit.
 */
export function nextStep(
  history: readonly Probe[],
  lo: number,
  hi: number,
): SearchStep {
  const clamp = (rate: number): number =>
    Math.max(lo, Math.min(hi, Math.round(rate)));

  if (history.length === 0) {
    // Nothing measured yet -- the caller supplies the starting rate, so this is
    // only reached when it wants one chosen. The midpoint is a safe neutral.
    return { kind: 'probe', rate: clamp((lo + hi) / 2) };
  }

  const last = history[history.length - 1]!;

  if (history.length >= MAX_PROBES) {
    return { kind: 'done', rate: bestAffordable(history, lo, hi) };
  }

  // --- the plateau ---------------------------------------------------------
  //
  // At or under budget: affordable, but we have learned only a lower bound.
  // Climb until something costs more than a frame.
  if (last.frameMs <= PLATEAU_MS) {
    const climbed = clamp(last.rate * CLIMB_FACTOR);
    // Already at the ceiling and still affordable: the machine can hold the
    // maximum the slider offers, and there is nothing further to ask.
    if (climbed <= last.rate || last.rate >= hi) {
      return { kind: 'done', rate: clamp(last.rate) };
    }
    // Do not re-probe a rate already measured -- a climb that rounds back onto
    // an existing sample would loop until the probe budget ran out.
    if (history.some((p) => p.rate === climbed)) {
      return { kind: 'done', rate: bestAffordable(history, lo, hi) };
    }
    return { kind: 'probe', rate: climbed };
  }

  // --- over budget: estimate ----------------------------------------------
  //
  // Frame time is linear in rate, so this is a straight proportion. Clamped so
  // one bad reading costs a probe rather than the answer.
  const ratio = Math.max(1 / MAX_STEP, Math.min(MAX_STEP, TARGET_MS / last.frameMs));
  const estimate = clamp(last.rate * ratio);

  // Converged, or about to repeat a measurement: commit what is known. Both
  // conditions mean another probe would spend 20 frames to learn nothing.
  if (estimate === last.rate || history.some((p) => p.rate === estimate)) {
    return { kind: 'done', rate: bestAffordable(history, lo, hi) };
  }

  return { kind: 'probe', rate: estimate };
}

/**
 * The rate to commit, given everything measured.
 *
 * **THE HIGHEST RATE THAT MEASURED WITHIN BUDGET**, with `SAFETY` applied. That
 * is a RATCHET rather than a last-estimate: whatever passed was measured on this
 * machine running this project, which is a stronger claim than any arithmetic
 * about what should pass.
 *
 * When nothing measured within budget -- a machine that cannot hold 60 fps even
 * at the slider's floor -- the answer is the floor. Returning the last estimate
 * instead could commit a rate that was never probed and is known to be too slow.
 */
function bestAffordable(history: readonly Probe[], lo: number, hi: number): number {
  let best = 0;
  for (const probe of history) {
    if (probe.frameMs <= PLATEAU_MS && probe.rate > best) best = probe.rate;
  }
  if (best === 0) return lo;
  return Math.max(lo, Math.min(hi, Math.round(best * SAFETY)));
}
