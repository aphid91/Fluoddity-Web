/**
 * The cohort highlight: a two-stage, click-driven selection.
 *
 * **CLICK ONCE TO AIM, CLICK AGAIN TO COMMIT.** A click picks the entity under
 * the cursor and one of three things happens:
 *
 *   MISS                          the highlight goes out. Nothing is adopted.
 *   HIT, a different cohort       that cohort becomes highlighted (or replaces
 *                                 whatever was). Nothing is adopted.
 *   HIT, the highlighted cohort   THE COMMIT. The rule is adopted, history is
 *                                 recorded, and the highlight goes out.
 *
 * Everything outside a highlighted cohort is dimmed by `camBrush.wgsl`, so the
 * first click SHOWS you what the second one will take.
 *
 * ## Every pick is a click's pick
 *
 * Nothing here is driven by a clock. That is worth stating because the obvious
 * alternative -- sampling under the cursor on a timer and lighting whatever it
 * finds -- costs a debounce to stop the highlight flickering between adjacent
 * particles, contends with click-to-select for the single pick slot in
 * `ParticleSystem`, and burns GPU work answering a question nobody has asked.
 * Driving it from clicks removes all three, and the user's second click is a
 * better confirmation than any debounce: a selection cannot land on a particle
 * you were not shown first.
 *
 * ## Why the commit re-picks instead of reusing the aiming click's result
 *
 * It does not have to hit the SAME PARTICLE -- any particle of the highlighted
 * cohort commits. That is the whole affordance: the cohort is scattered across
 * the screen, and after the first click every one of its members is a valid
 * confirm target. So the second click is a genuine pick whose result is then
 * tested for cohort membership, not a replay of the first.
 *
 * ## Why this is its own module
 *
 * It is pure -- no GPU, no DOM, no Project -- so it is testable under
 * `node --test`, the same split `selection.ts` draws and for the same reason.
 * The Orchestrator owns the dispatch and performs the adoption; this owns only
 * the decision of which of the three outcomes a pick means.
 */

/**
 * What a pick has to report for the outcome to be decidable.
 *
 * Structural, matching `PickResult`'s own spelling of both facts rather than
 * introducing a second one: `index < 0` is how a miss is expressed everywhere
 * else in picking (`pick.ts`'s `MISS` and `isHit`), and a `hit: boolean`
 * alongside it would be a second source of truth that could disagree. Kept as an
 * interface anyway -- not `PickResult` itself -- so this module stays pure and
 * the tests can drive it with two-field literals under `node --test`.
 */
export interface PickSample {
  /** Negative when nothing was in range. */
  readonly index: number;
  /** The cohort, already floored by the shader. Meaningless on a miss. */
  readonly cohort: number;
}

/** No cohort is highlighted. Not a cohort any entity can have. */
export const NO_COHORT = -1;

/**
 * `cohort` brought into `0..count-1` by wrapping.
 *
 * For the stepper under the mutation slider, whose arrows cycle: stopping dead
 * at either end would make the last cohort feel like a wall when the point of
 * the control is to walk through them.
 *
 * **A BARE `%` IS NOT ENOUGH, and that is the whole reason this is a named
 * function with a test.** JavaScript's `%` keeps the sign of the dividend, so
 * stepping down from cohort 0 gives `-1` -- which is `NO_COHORT`, so the arrow
 * would silently put the highlight OUT instead of wrapping to the last cohort.
 * That reads as the button being broken, and it is one character away from
 * looking correct.
 *
 * Returns `NO_COHORT` for a non-positive count, which is the only sensible
 * answer when there are no cohorts to land on.
 */
export function wrapCohort(cohort: number, count: number): number {
  if (!Number.isFinite(cohort) || count <= 0) return NO_COHORT;
  return ((Math.trunc(cohort) % count) + count) % count;
}

/**
 * What a click means, given what is currently highlighted.
 *
 * `'commit'` is the ONLY outcome that changes the project. The other two are
 * pure highlight bookkeeping -- which is what makes the first click of a
 * selection free to be wrong, and the whole point of the two-stage design.
 */
export type ClickOutcome = 'commit' | 'highlight' | 'unhighlight';

/**
 * The highlighted cohort, and what each click does to it.
 *
 * Holds a single cohort rather than a history of picks: with the timer gone
 * there is nothing to debounce, so the state is exactly "which cohort is lit",
 * and every transition is one click.
 */
export class CohortHighlight {
  private highlighted: number = NO_COHORT;

  /**
   * Whether a pick can ever COMMIT, or only ever re-aim.
   *
   * =====================================================================
   * FALSE ON TOUCH, AND IT IS THE POINT OF THIS FLAG
   * =====================================================================
   *
   * On a mouse, "click again inside the cohort to commit" is a good
   * confirmation: the pointer is precise, the first click showed you what the
   * second would take, and clicking the same scattered cohort twice is a
   * deliberate act.
   *
   * A fingertip is about 10mm across and the particles are a few pixels. Tapping
   * to aim at a cohort and landing on a MEMBER OF THE ONE ALREADY LIT is not a
   * confirmation there -- it is a near miss, and under the two-stage rule a near
   * miss silently adopts a rule, resets the simulation and pushes an undo entry.
   * The user asked to look at a different cohort and got a committed edit.
   *
   * So on touch every pick re-aims, and the commit moves to the gold hint-bar
   * button -- a 44px target that says what it will do. That makes the two stages
   * "aim with the canvas" and "confirm with the button" rather than two taps on
   * the same small target, which is the distinction a finger can actually make.
   *
   * **NOT THE SAME AS `oneClickSelection`, and close enough to be worth saying
   * so.** That preference turns the highlight OFF and makes the first click
   * adopt immediately -- fewer clicks, no aiming. This keeps the highlight and
   * removes the commit, which is the opposite trade: more deliberate, not less.
   * The two are independent, and on touch the preference still does what it says.
   */
  private readonly canCommit: boolean;

  /**
   * @param canCommit false to make every pick re-aim. See the field.
   *
   * DEFAULTS TO TRUE, so the desktop behaviour and every existing test are
   * exactly what they were -- this class is constructed with no arguments
   * everywhere except the one touch call site.
   */
  constructor(canCommit = true) {
    this.canCommit = canCommit;
  }

  /** The highlighted cohort, or `NO_COHORT`. */
  get cohort(): number {
    return this.highlighted;
  }

  /** Whether a cohort is currently highlighted. */
  get isHighlighted(): boolean {
    return this.highlighted !== NO_COHORT;
  }

  /**
   * Decide what `sample` means WITHOUT changing anything.
   *
   * Separate from `apply` so the caller can branch on the outcome before
   * committing to it -- the Orchestrator has to adopt the rule and record
   * history on `'commit'`, and those need the pick result, not just the verdict.
   * Pure, so it is also the whole of what the tests have to pin.
   */
  classify(sample: PickSample): ClickOutcome {
    // A miss always clears, whether or not anything was lit. Clicking empty
    // space is how you cancel an aim you have thought better of.
    if (sample.index < 0) return 'unhighlight';
    // THE COMMIT: a hit inside the cohort the user was already shown. Note this
    // is a COHORT test, not an entity test -- any member confirms, which is what
    // makes the scattered highlight a usable target.
    //
    // WITHHELD WHEN `canCommit` IS FALSE, where this same pick falls through to
    // `'highlight'` and merely re-aims at the cohort it is already on -- a
    // no-op, which is exactly right for a fingertip that missed. See the field.
    if (this.canCommit && this.isHighlighted && sample.cohort === this.highlighted) {
      return 'commit';
    }
    // A hit on anything else aims at it, replacing whatever was lit.
    return 'highlight';
  }

  /**
   * Apply `sample`, returning what it meant.
   *
   * **THE HIGHLIGHT GOES OUT ON A COMMIT.** Adoption changes what every particle
   * is chasing, so the cohort that was lit is no longer the thing it named --
   * leaving it lit would dim the field against a historical answer, and would
   * arm a second commit that the user has not aimed.
   */
  apply(sample: PickSample): ClickOutcome {
    const outcome = this.classify(sample);
    this.highlighted = outcome === 'highlight' ? sample.cohort : NO_COHORT;
    return outcome;
  }

  /**
   * Light `cohort` directly, bypassing the pick.
   *
   * For the stepper under the mutation slider: with a cohort already lit, its
   * arrows and text field are an alternative way to move the highlight to a
   * neighbour you may not be able to click -- the members of a cohort are
   * scattered, and some of them are off screen.
   *
   * **RE-AIMS ONLY.** Nothing here adopts a rule, and nothing can: a cohort's
   * rule is derived on the GPU and has no host mirror. So this leaves the state
   * machine exactly where a `'highlight'` outcome would, and the next click
   * inside the cohort still commits through the ordinary pick path.
   *
   * The caller is responsible for the range; `NO_COHORT` is accepted and means
   * the same as `clear()`.
   */
  set(cohort: number): void {
    this.highlighted = cohort;
  }

  /**
   * Put the highlight out.
   *
   * Called when the premise changes rather than when a click decides something:
   * leaving the Select tool, a rebuild that renumbers the cohorts, A CHANGE TO
   * THE COHORT COUNT, and every path that changes the rule from somewhere other
   * than a commit -- the rerolls, and undo or redo of any behaviour change.
   * After any of those the lit cohort names a behaviour that is no longer
   * running.
   *
   * The cohort-count case is worth naming separately because the index does not
   * merely go stale, it can go out of range: dropping from 8 cohorts to 4 leaves
   * a lit cohort 6 that names nothing at all. `Orchestrator.setProject` is where
   * that comparison lives, so every route into it -- the mutation bar's grid
   * buttons, the panel's Cohorts control, a preset load, an undo -- is covered
   * by one check rather than by each handler remembering.
   */
  clear(): void {
    this.highlighted = NO_COHORT;
  }
}
