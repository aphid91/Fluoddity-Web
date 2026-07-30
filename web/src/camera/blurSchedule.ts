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
 */

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
