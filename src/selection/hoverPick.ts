/**
 * The cohort highlight: which cohort the mouse is resting on.
 *
 * A read-only pick fires on a timer while Select is the active tool, and the
 * last two results decide the answer. TWO AGREEING HITS HIGHLIGHT THEIR COHORT;
 * anything else highlights nothing. Every particle outside a highlighted cohort
 * is then dimmed by `camBrush.wgsl`, and a click adopts the highlighted cohort
 * directly rather than firing a pick of its own.
 *
 * ## Why two picks and not one
 *
 * One pick would make the highlight flicker: the mouse sits between two
 * particles, the pick alternates between their cohorts, and the screen strobes
 * between two dim/bright arrangements. Requiring two consecutive picks to agree
 * is a one-sample debounce -- the highlight appears only once the answer has
 * held still for a full interval, and disappears the moment it stops holding.
 *
 * That also means a highlight costs one interval of latency before it appears.
 * That is the point, not a shortcoming: the alternative is a highlight that
 * chases the cursor through every particle it passes over.
 *
 * ## Why this is its own module
 *
 * It is pure -- no GPU, no timer, no DOM -- so it is testable under
 * `node --test`, the same split `selection.ts` draws and for the same reason.
 * The Orchestrator owns the clock and the dispatch; this owns only the decision.
 *
 * ## Read-only, and what that means
 *
 * These picks never set the target rule. They share the ONE pick slot with
 * click-to-select (`particleSystem.ts`'s phase machine has a single result
 * buffer), so the Orchestrator only fires one when that slot is idle and no
 * click is waiting -- hover yields to click, always. A dropped hover tick costs
 * nothing but a late highlight; a dropped click loses the user's actual intent.
 */

/**
 * What a hover pick has to report for the highlight to be decidable.
 *
 * Structural, matching `PickResult`'s own spelling of both facts rather than
 * introducing a second one: `index < 0` is how a miss is expressed everywhere
 * else in picking (`pick.ts`'s `MISS` and `isHit`), and a `hit: boolean`
 * alongside it would be a second source of truth that could disagree. Kept as an
 * interface anyway -- not `PickResult` itself -- so this module stays pure and
 * `hoverPick.test.ts` can drive it with two-field literals under `node --test`.
 */
export interface HoverSample {
  /** Negative when nothing was in range. A miss breaks the agreement. */
  readonly index: number;
  /** The cohort, already floored by the shader. Meaningless on a miss. */
  readonly cohort: number;
}

/** No cohort is highlighted. Not a cohort any entity can have. */
export const NO_COHORT = -1;

/**
 * The last two hover picks, and the cohort they agree on.
 *
 * Holds the last RESULT as well as the last cohort, because a click while a
 * cohort is highlighted adopts that result's rule directly instead of
 * dispatching its own pick -- which is what stops a click near the edge of a
 * particle from missing, or from selecting a neighbour, after the user has
 * already been shown which cohort they are about to get.
 */
export class CohortHighlight<R extends HoverSample> {
  private previous: R | null = null;
  private latest: R | null = null;

  /**
   * Record one hover pick.
   *
   * A MISS IS RECORDED, NOT DISCARDED. Moving off the particles must clear the
   * highlight, and it can only do that by being remembered: dropping misses
   * would leave the last two hits agreeing forever, so the highlight would
   * stick to whatever the mouse last passed over.
   */
  observe(sample: R): void {
    this.previous = this.latest;
    this.latest = sample;
  }

  /**
   * The highlighted cohort, or `NO_COHORT`.
   *
   * Both picks must be HITS and must agree. A miss on either side is not a
   * disagreement to be resolved -- it is the absence of an answer, and the spec
   * treats it exactly as it treats two hits on different cohorts.
   */
  get cohort(): number {
    const a = this.previous;
    const b = this.latest;
    if (a === null || b === null) return NO_COHORT;
    if (a.index < 0 || b.index < 0) return NO_COHORT;
    return a.cohort === b.cohort ? b.cohort : NO_COHORT;
  }

  /** Whether a cohort is currently highlighted. */
  get isHighlighted(): boolean {
    return this.cohort !== NO_COHORT;
  }

  /**
   * The most recent pick, for a click to adopt. `null` before the first one.
   *
   * A CLICK SHOULD ONLY USE THIS WHILE `isHighlighted`. On its own it is just
   * the last thing the mouse passed over, which may be a miss or a cohort that
   * never held still long enough to be shown -- adopting that would select
   * something the user was never told they were about to get.
   */
  get lastResult(): R | null {
    return this.latest;
  }

  /**
   * Forget both samples. The highlight goes out until two new picks agree.
   *
   * Called when the premise changes rather than the answer: leaving the Select
   * tool, or a click that adopts a rule. Adoption is the interesting one --
   * every particle's rule has just changed, so the cohort under the mouse is no
   * longer the thing that was highlighted, and keeping the old samples would
   * dim the screen against an answer that is now historical.
   */
  clear(): void {
    this.previous = null;
    this.latest = null;
  }
}

/**
 * Whether `elapsedMs` since the last hover pick means another is due.
 *
 * Split out so the interval is testable without a clock, and named so the call
 * site reads as a policy rather than as a comparison.
 */
export const HOVER_PICK_INTERVAL_MS = 500;

export function hoverPickDue(nowMs: number, lastMs: number): boolean {
  return nowMs - lastMs >= HOVER_PICK_INTERVAL_MS;
}
