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
import { blurSchedule, sampleAt } from './blurSchedule.ts';

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

test('matches the desktop blur_schedule() on all 64 golden cases', () => {
  // Sourced by CALLING orchestrator.blur_schedule (see _parity_blur in
  // generate_web_data.py), so this cannot drift from the desktop without the
  // regeneration diff showing it. The identity test above checks the port
  // against ITSELF; this checks it against Python.
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
