/**
 * Motion blur's sample schedule.
 *
 * The highest-value unit tests in Step 5, because this is the one piece of the
 * render path that is arithmetic rather than perceptual -- everything else is
 * verified by eye against the desktop, and this cannot be. A wrong answer here
 * is a frame that is dim by a few percent at SOME slider positions and correct
 * at others, which is exactly the failure the visual A/B would not catch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PARITY } from '../testing/parity.ts';
import {
  PAUSE_SETTLE_FRAMES,
  type SettledView,
  blurSchedule,
  pauseSettleSchedule,
  sampleAt,
  settledViewMatches,
} from './blurSchedule.ts';

/** The grid both identity tests sweep. */
const STEPS = [1, 2, 7, 30, 60, 100, 120, 121];
const REQUESTED = [1, 2, 3, 8, 10, 30, 31, 1000];

test('a request of 1 or less is motion blur OFF: one sample, stride = steps', () => {
  // `orchestrator.py:96-100`. There is no separate enable flag, so this branch
  // IS the off switch and it must survive any refactor of the arithmetic below.
  for (const steps of STEPS) {
    for (const requested of [1, 0, -5]) {
      const s = blurSchedule(steps, requested);
      assert.deepEqual(
        s,
        { samples: 1, stride: steps },
        `steps=${steps} requested=${requested}`,
      );
    }
  }
});

test('THE IDENTITY: the achieved count equals the samples actually taken', () => {
  // `blur_schedule`'s entire contract (`orchestrator.py:87-92`): the number of
  // sub-steps satisfying the frame loop's test is EXACTLY the number the
  // accumulator divided by. Rather than re-deriving `ceil(n/stride)`, this runs
  // the frame loop's own predicate and counts. If the two ever disagree the
  // image is mis-weighted -- brighter or dimmer than it should be, by the ratio.
  for (const steps of STEPS) {
    for (const requested of REQUESTED) {
      const schedule = blurSchedule(steps, requested);
      const at = sampleAt(schedule);

      let taken = 0;
      for (let step = 0; step < steps; step++) {
        if (step % schedule.stride === at) taken++;
      }

      assert.equal(
        taken,
        schedule.samples,
        `steps=${steps} requested=${requested} -> ` +
          `samples=${schedule.samples} stride=${schedule.stride} at=${at}, ` +
          `but ${taken} sub-steps match`,
      );
    }
  }
});

test("the docstring's two worked examples", () => {
  // `orchestrator.py:80-83` names both. They are the cases that establish the
  // count is a TARGET, not a promise: the second asks for 8 and gets 9.
  assert.deepEqual(blurSchedule(120, 10), { samples: 10, stride: 12 });
  assert.deepEqual(blurSchedule(100, 8), { samples: 9, stride: 12 });
});

test('sampleAt: blurred takes the first of each group, unblurred the last', () => {
  // `orchestrator.py:307-315`. Blurring samples the FIRST because that is what
  // makes the count come out to ceil(steps/stride); the single un-blurred
  // sample takes the LAST so a still image shows the newest state.
  const blurred = blurSchedule(120, 10);
  assert.ok(blurred.samples > 1);
  assert.equal(sampleAt(blurred), 0);

  const unblurred = blurSchedule(30, 1);
  assert.equal(unblurred.samples, 1);
  assert.equal(sampleAt(unblurred), 29);
  // ...and 29 is the LAST sub-step of a 30-step frame, which is the point.
  assert.equal(sampleAt(unblurred), 30 - 1);
});

test('degenerate inputs never produce a zero stride', () => {
  // A stride of 0 would make the frame loop's `step % stride` a division by
  // zero (NaN in JS, which is never === anything, so NO sample would be taken
  // and the screen would go black). The desktop cannot reach this -- its
  // preferences are typed `int` -- but the port's values come from a URL param
  // and eventually a text input, so the guard has to be real.
  const cases: readonly (readonly [number, number])[] = [
    [0, 10],
    [10, 0],
    [0, 0],
    [-30, -10],
    [Number.NaN, 10],
    [30, Number.NaN],
    [Number.NaN, Number.NaN],
    [0.5, 0.5],
  ];
  for (const [steps, requested] of cases) {
    const s = blurSchedule(steps, requested);
    assert.ok(
      Number.isInteger(s.stride) && s.stride >= 1,
      `steps=${steps} requested=${requested} gave stride ${s.stride}`,
    );
    assert.ok(
      Number.isInteger(s.samples) && s.samples >= 1,
      `steps=${steps} requested=${requested} gave samples ${s.samples}`,
    );
  }
});

test('matches the reference blur_schedule() on all 64 golden cases', () => {
  // Sourced by CALLING the retired Python app's orchestrator.blur_schedule.
  // The identity test above checks the port against ITSELF; this checks it
  // against an independent implementation. See src/testing/parity.ts.
  for (const c of PARITY.blur.cases) {
    const { samples, stride } = blurSchedule(c.physicsSteps, c.motionBlurSamples);
    assert.deepEqual(
      [samples, stride],
      c.out,
      `physicsSteps=${c.physicsSteps} motionBlurSamples=${c.motionBlurSamples}`,
    );
  }
});

test('a request far above the step count still yields one sample per step', () => {
  // stride floors to 1, so every sub-step is a sample -- the maximum the
  // cadence can deliver. Asking for 1000 at 30 steps gives 30, not 1000.
  const s = blurSchedule(30, 1000);
  assert.deepEqual(s, { samples: 30, stride: 1 });
});

// --- the queued pause's settle frame ---------------------------------------
//
// EVERY ASSERTION BELOW IS DERIVED FROM `PAUSE_SETTLE_FRAMES`, never from a
// literal 4. Retuning that constant is expected -- it is the knob the feature
// exists to expose -- and it must not turn this file red.

test('the settle frame advances PAUSE_SETTLE_FRAMES render frames of physics', () => {
  for (const steps of STEPS) {
    const settle = pauseSettleSchedule(steps);
    assert.equal(
      settle.steps,
      steps * PAUSE_SETTLE_FRAMES,
      `steps=${steps}: the settle must run exactly that many frames' worth`,
    );
  }
});

test('the settle frame takes one render frame\'s worth of samples', () => {
  // The headline property: `total / PAUSE_SETTLE_FRAMES` samples, which for an
  // evenly-dividing constant is exactly `steps`. Stated as the division rather
  // than as `steps` so it stays meaningful if the constant changes.
  for (const steps of STEPS) {
    const settle = pauseSettleSchedule(steps);
    assert.equal(
      settle.schedule.samples,
      Math.ceil((steps * PAUSE_SETTLE_FRAMES) / PAUSE_SETTLE_FRAMES),
      `steps=${steps}`,
    );
    assert.equal(settle.schedule.samples, steps, `steps=${steps}: one frame's worth`);
  }
});

test('THE IDENTITY HOLDS FOR THE SETTLE FRAME TOO', () => {
  // Same contract as the main schedule, and it matters more here: this frame is
  // the one the user sits and stares at, so a miscount is a still that is
  // visibly too dim or too bright. Runs the frame loop's own predicate over the
  // settle's step count and counts what it takes.
  for (const steps of STEPS) {
    const { steps: total, schedule } = pauseSettleSchedule(steps);
    const at = sampleAt(schedule);

    let taken = 0;
    for (let step = 0; step < total; step++) {
      if (step % schedule.stride === at) taken++;
    }

    assert.equal(
      taken,
      schedule.samples,
      `steps=${steps} -> total=${total} samples=${schedule.samples} ` +
        `stride=${schedule.stride} at=${at}, but ${taken} sub-steps match`,
    );
  }
});

test('the settle frame IGNORES the motion blur preference', () => {
  // The whole point of the feature: the freeze is blurred even with blur off.
  // `pauseSettleSchedule` takes no sample count at all, which is what makes
  // that structural rather than a value someone could later thread through.
  const settle = pauseSettleSchedule(30);
  assert.ok(settle.schedule.samples > 1, 'the settle still must be a real average');

  // Contrast: the ordinary schedule at the same rate with blur off is one flat
  // sample. That is the picture this feature replaces.
  assert.deepEqual(blurSchedule(30, 1), { samples: 1, stride: 30 });
});

test('the settle frame is blurred, so it samples the FIRST of each group', () => {
  // `sampleAt` keys on the resolved count, so the settle takes the blurred
  // branch without restating the condition -- the same reason the paused case
  // shares it. At one sub-step (rate 1) there is nothing to average and it
  // correctly collapses to the un-blurred branch instead.
  assert.equal(sampleAt(pauseSettleSchedule(30).schedule), 0);
  assert.equal(pauseSettleSchedule(1).schedule.samples, 1);
});

test('degenerate rates cannot break the settle frame', () => {
  // Same guard as the main path: the rate reaches this from a preference that
  // a URL param can write, so 0/NaN/fractional must not produce a zero stride
  // (a `% 0` is NaN, never === anything, and the screen would freeze black).
  for (const steps of [0, -30, Number.NaN, 0.5]) {
    const { steps: total, schedule } = pauseSettleSchedule(steps);
    assert.ok(Number.isInteger(total) && total >= 1, `steps=${steps} gave total ${total}`);
    assert.ok(
      Number.isInteger(schedule.stride) && schedule.stride >= 1,
      `steps=${steps} gave stride ${schedule.stride}`,
    );
    assert.ok(
      Number.isInteger(schedule.samples) && schedule.samples >= 1,
      `steps=${steps} gave samples ${schedule.samples}`,
    );
  }
});

// --- holding the settled still against camera movement ---------------------

const VIEW: SettledView = { pan: [1.5, -2.25], zoom: 3, mode: 'particles' };

test('an unmoved camera keeps the settled still', () => {
  // A fresh object with equal values, because the frame loop rebuilds the
  // snapshot every frame rather than holding the camera's own state.
  assert.ok(settledViewMatches(VIEW, { pan: [1.5, -2.25], zoom: 3, mode: 'particles' }));
});

test('ANY camera movement abandons the settled still', () => {
  // The reason the feature needs this at all: the still is `physicsSteps`
  // samples of a simulation state the settle already ran past, so it is a
  // picture of one viewpoint and cannot be re-rendered from another. Pan, zoom
  // and mode each independently make it a picture of the wrong place.
  const moved: readonly SettledView[] = [
    { pan: [1.5000001, -2.25], zoom: 3, mode: 'particles' },
    { pan: [1.5, -2.2500001], zoom: 3, mode: 'particles' },
    { pan: [1.5, -2.25], zoom: 3.0000001, mode: 'particles' },
    { pan: [1.5, -2.25], zoom: 3, mode: 'trail' },
  ];
  for (const view of moved) {
    assert.equal(
      settledViewMatches(VIEW, view),
      false,
      `${JSON.stringify(view)} should have dropped the still`,
    );
  }
});

test('no still is held before one has been taken', () => {
  // `null` is the "nothing settled" state, and it must never match -- otherwise
  // the first paused frame after startup would hold an empty accumulator.
  assert.equal(settledViewMatches(null, VIEW), false);
});

test('the smallest movement a drag can produce still drops the still', () => {
  // EXACT equality, no epsilon, and this is why: a slow pan moves the view by
  // fractions of a world unit per frame. Any tolerance would let the camera
  // creep away while a stale still stayed frozen on screen -- the precise
  // artefact this guards against, and one that would look like a frozen app.
  const crept: SettledView = { pan: [1.5 + Number.EPSILON, -2.25], zoom: 3, mode: 'particles' };
  assert.equal(settledViewMatches(VIEW, crept), false);
});

test('PAUSE_SETTLE_FRAMES is the single knob, and it is sane', () => {
  // Not an assertion that it equals 4 -- that is the number expected to change.
  // What must hold is that it is a positive whole number of render frames;
  // anything else makes `total` fractional and the stride meaningless.
  assert.ok(Number.isInteger(PAUSE_SETTLE_FRAMES) && PAUSE_SETTLE_FRAMES >= 1);
});
