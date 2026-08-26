/**
 * Motion blur's sample schedule. A port of `orchestrator/orchestrator.py:71-103`.
 *
 * Motion blur here is a TEMPORAL SUPERSAMPLE: the frame shown is the average of
 * several renders taken at different points in the simulation's advance, which
 * is why a fast particle smears instead of stepping.
 *
 * Its own module, and a leaf, for the reason `dispatch.ts` gives: `camera.ts`
 * imports `.wgsl`, which only resolves through the Vite plugin, so nothing under
 * `node --test` can import it. This is the one piece of the render path that is
 * pure arithmetic, and it is also the piece where a wrong answer is a *dim
 * image at some slider positions only* -- so it is exactly what wants a test.
 *
 * `cameraState.ts` is imported for `CameraMode` alone, and only because that
 * module is itself a leaf (it reaches no further than `coords.ts`, and never to
 * a `.wgsl`). The type-only import keeps this file runnable under `node --test`.
 */

import type { CameraMode } from './cameraState.ts';

/** The resolved schedule for one displayed frame. */
export interface BlurSchedule {
  /**
   * The ACHIEVED sample count -- how many renders will actually happen.
   *
   * This is what `1/samples` must be computed from. Weighting by the count the
   * user REQUESTED instead darkens the image by the ratio between them, and
   * only at slider positions where the two disagree.
   */
  readonly samples: number;
  /** Sub-steps between consecutive samples. Always >= 1. */
  readonly stride: number;
}

/**
 * `(samples, stride)` for one displayed frame of motion blur.
 *
 * THE SAMPLE COUNT IS A TARGET, NOT A PROMISE. The user asks for X samples;
 * what is achievable is set by the stride, which must be a whole number of
 * physics steps. At 120 steps X=10 lands exactly (stride 12); at 100 steps X=8
 * gives stride 12 and so 9 samples. Returning the count that will ACTUALLY
 * occur is the entire point of this function.
 *
 * The count of steps satisfying `step % stride === sampleAt` over `[0, n)` is
 * exactly `ceil(n / stride)`. That is an identity, not an approximation, so the
 * accumulator always receives precisely the number of samples it divided by. It
 * depends on the loop starting at zero and the test being `=== 0`; the
 * un-blurred path below deliberately uses a different test and does not share
 * this guarantee (it does not need to -- it takes one sample).
 */
export function blurSchedule(
  physicsSteps: number,
  motionBlurSamples: number,
): BlurSchedule {
  // `Math.trunc`, not `Math.round`, for Python's `int()` -- the substitution
  // `sizing.ts` pinned in Step 2. NaN truncates to NaN, which `Math.max` then
  // propagates, so the `|| 1` guards the degenerate input the desktop never
  // sees (its preference is typed `int`).
  const steps = Math.max(1, Math.trunc(physicsSteps)) || 1;
  const requested = Math.max(1, Math.trunc(motionBlurSamples)) || 1;

  if (requested <= 1) {
    // A sample count of 1 IS motion blur off; there is no separate flag. One
    // sample, taken on the LAST sub-step, so the un-blurred image shows the
    // newest state -- which is what rendering after the loop used to do.
    return { samples: 1, stride: steps };
  }

  const stride = Math.max(1, Math.trunc(steps / requested));
  // Python's `-(-steps // stride)` is floor-div negation trickery for ceil.
  return { samples: Math.ceil(steps / stride), stride };
}

/**
 * Which step within each group of `stride` gets rendered.
 * `orchestrator.py:307-315`.
 *
 * Blurring samples the FIRST, because that is what makes the sample count come
 * out to exactly `ceil(steps/stride)` -- see `blurSchedule`. The single
 * un-blurred sample takes the LAST instead, so a still image shows the newest
 * state rather than a stale one.
 *
 * Keyed on the RESOLVED count rather than the preference, so the paused case
 * and a sample count of 1 take the same branch without restating either
 * condition.
 *
 * A named function rather than an inline expression in the frame loop, because
 * it is half of the identity `blurSchedule`'s docstring claims: the test counts
 * `{s in [0,steps) : s % stride === sampleAt(sched)}` and asserts it equals
 * `sched.samples`. That is not checkable if this line lives inside a callback.
 */
export function sampleAt(schedule: BlurSchedule): number {
  return schedule.samples > 1 ? 0 : schedule.stride - 1;
}

/**
 * How much extra simulation a queued pause runs, in RENDER FRAMES.
 *
 * THE ONE NUMBER FOR THIS FEATURE. It sets three things at once, which is why
 * it is a single constant rather than three:
 *
 *   - the extra physics is `physicsSteps * PAUSE_SETTLE_FRAMES` sub-steps
 *     (i.e. this many render frames' worth of simulation);
 *   - `1/PAUSE_SETTLE_FRAMES` of those sub-steps become blur samples, which
 *     works out to exactly `physicsSteps` samples;
 *   - so the still is built from one render frame's worth of samples spread
 *     over this many frames of motion.
 *
 * Change it here and the arithmetic, the tests and the docs all follow --
 * nothing else hardcodes it, and no test asserts a number derived from it by
 * hand. 4 renders a pleasantly smeared still without stalling a weak machine.
 */
export const PAUSE_SETTLE_FRAMES = 1;

/**
 * The schedule for the single frame a queued pause resolves on.
 *
 * WHY THE PAUSED FRAME IS THE BLURRY ONE. An ordinary pause freezes on whatever
 * sub-step the loop happened to stop at -- a hard, aliased still, and the one
 * frame a user is most likely to sit and stare at (or screenshot). This runs the
 * simulation on for `PAUSE_SETTLE_FRAMES` render frames' worth of sub-steps and
 * averages every `PAUSE_SETTLE_FRAMES`-th one into a single image, so the freeze
 * lands on a properly motion-blurred still REGARDLESS of the blur preference --
 * including with blur switched off entirely, which is the case it exists for.
 *
 * The sample count is `steps`, not the user's `motionBlurSamples`: the whole
 * point is that this frame ignores the preference. Deriving it as
 * `steps * PAUSE_SETTLE_FRAMES / PAUSE_SETTLE_FRAMES` rather than writing
 * `steps` keeps the relationship visible -- it is "one frame's worth of
 * samples", not a coincidence.
 *
 * Returns the TOTAL sub-steps to advance alongside the schedule, because the
 * caller must run `steps * PAUSE_SETTLE_FRAMES` of them rather than its usual
 * `steps`. The stride is exactly `PAUSE_SETTLE_FRAMES`, and `ceil(total/stride)`
 * is then `steps` -- the identity `blurSchedule` documents, preserved here so
 * the accumulator still divides by the count it actually receives.
 */
export function pauseSettleSchedule(physicsSteps: number): {
  readonly steps: number;
  readonly schedule: BlurSchedule;
} {
  const steps = Math.max(1, Math.trunc(physicsSteps)) || 1;
  const total = steps * PAUSE_SETTLE_FRAMES;
  return {
    steps: total,
    // Not via `blurSchedule(total, steps)`: that would floor the stride to
    // `trunc(total/steps)`, which is the same number here but only because the
    // division is exact. Stating the stride directly says what it means -- one
    // sample per render frame's worth of motion -- and stays correct if the
    // constant ever becomes something that does not divide evenly.
    schedule: { samples: Math.ceil(total / PAUSE_SETTLE_FRAMES), stride: PAUSE_SETTLE_FRAMES },
  };
}

/**
 * The viewpoint a settled still was rendered from.
 *
 * A flat VALUE, deliberately: `CameraState` is a class mutated in place by
 * panning and zooming, so a held reference would compare the live camera
 * against itself and never detect a move.
 */
export interface SettledView {
  readonly pan: readonly [number, number];
  readonly zoom: number;
  readonly mode: CameraMode;
}

/**
 * Whether a settled still is still a picture of what the user is looking at.
 *
 * WHY ANY CHANGE INVALIDATES IT. The still is `physicsSteps` samples averaged
 * from a simulation state that no longer exists -- the physics ran past it
 * during the settle and cannot be re-rendered from a new angle. So the image is
 * only valid from the exact viewpoint it was taken at; pan, zoom or a mode flip
 * makes it a picture of the wrong place, and the frame loop must fall back to
 * rendering the frozen entities live.
 *
 * EXACT EQUALITY, NO EPSILON. Both floats come from the same arithmetic that
 * produced the snapshot, so an unmoved camera compares bit-identical. A
 * tolerance would instead let a slow drag creep the view while the stale still
 * stayed on screen -- the exact artefact this guards against.
 */
export function settledViewMatches(a: SettledView | null, b: SettledView): boolean {
  return (
    a !== null &&
    a.pan[0] === b.pan[0] &&
    a.pan[1] === b.pan[1] &&
    a.zoom === b.zoom &&
    a.mode === b.mode
  );
}

