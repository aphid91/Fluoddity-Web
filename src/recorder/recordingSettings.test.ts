/**
 * Recording settings, and the blur slider's rescale rule.
 *
 * The rescale is this module's `blurSchedule`: the one piece of the recording
 * path that is arithmetic rather than perceptual. A wrong answer is a slider
 * that creeps a little every time the physics rate is touched -- invisible in
 * any one move, and by the tenth the handle is somewhere the user never put it.
 * That is precisely the failure no amount of looking at the UI would catch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RECORDING_SETTINGS,
  MAX_PHYSICS_STEPS,
  RECORDING_FPS,
  RESOLUTIONS,
  driverAction,
  frameCount,
  rescaleSamples,
  withDuration,
  withMotionBlurSamples,
  withPhysicsSteps,
  withResolution,
} from './recordingSettings.ts';

/** The ceilings the sweeps below walk. */
const CEILINGS = [1, 2, 5, 10, 15, 60, 120, 480];

test('the specified example: 10/5 -> ceiling 15 puts the handle at 7', () => {
  // The worked case from the specification, pinned verbatim. The handle sits at
  // 4/9 of the way up a range of 10; on a range of 15 that is 1 + floor(4/9*14)
  // = 7, and the slider has not appeared to move.
  assert.equal(rescaleSamples(5, 10, 15), 7);
});

test('the handle holds its POSITION, never drifting upward', () => {
  // The drift this whole function exists to prevent. Walking a ceiling up and
  // back down repeatedly must not ratchet the handle toward the top -- `floor`
  // is what guarantees it, and rounding would not.
  let samples = 5;
  let ceiling = 10;
  for (let i = 0; i < 50; i++) {
    for (const next of [15, 60, 15, 10]) {
      samples = rescaleSamples(samples, ceiling, next);
      ceiling = next;
      assert.ok(
        samples >= 1 && samples <= ceiling,
        `escaped its range: ${samples} not in [1, ${ceiling}]`,
      );
    }
  }
  // Back at the ceiling it started on, and no higher than it started.
  assert.equal(ceiling, 10);
  assert.ok(samples <= 5, `drifted upward to ${samples}`);
});

test('the endpoints are exact: bottom stays bottom, top stays top', () => {
  // The two positions a user can identify by eye, so an off-by-one at either is
  // the most visible failure available. A handle at the top means "as good as
  // this rate allows" and must keep meaning that when the rate changes.
  // `from` EXCLUDES 1, and that is not a gap in the sweep. At a ceiling of 1 the
  // single legal value is both the bottom AND the top of the range, so "bottom
  // stays bottom" and "top stays top" ask for different answers from the same
  // input and cannot both hold. The collapsed range is governed by its own rule
  // -- return to the ceiling -- and the test below is what pins it.
  for (const from of CEILINGS.filter((c) => c > 1)) {
    for (const to of CEILINGS) {
      assert.equal(rescaleSamples(1, from, to), 1, `bottom ${from} -> ${to}`);
      assert.equal(rescaleSamples(from, from, to), to, `top ${from} -> ${to}`);
    }
  }
});

test('the result is always within [1, ceiling], for any input at all', () => {
  // The invariant the rest of the module is allowed to assume: `physicsSteps`
  // is a loop bound and `motionBlurSamples` is divided BY, so a value outside
  // this range is a hang or a dim frame rather than a wrong pixel.
  const wild = [-100, -1, 0, 1, 3, 7, 1000, NaN, Infinity, -Infinity];
  for (const from of CEILINGS) {
    for (const to of CEILINGS) {
      for (const value of wild) {
        const got = rescaleSamples(value, from, to);
        assert.ok(
          Number.isInteger(got) && got >= 1 && got <= to,
          `rescale(${value}, ${from}, ${to}) = ${got}`,
        );
      }
    }
  }
});

test('a ceiling of 1 collapses to 1, and leaving it returns to the ceiling', () => {
  // With one legal value the handle IS at that value. Coming back out, the old
  // fraction is gone, so the documented answer is the ceiling rather than some
  // stale pre-collapse number.
  for (const from of CEILINGS) assert.equal(rescaleSamples(5, from, 1), 1);
  for (const to of CEILINGS) assert.equal(rescaleSamples(1, 1, to), to);
});

test('withPhysicsSteps keeps the ceiling invariant by construction', () => {
  // The reason `physicsSteps` has no plain setter: every write must carry the
  // sample count with it, or the pair silently disagrees.
  let settings = DEFAULT_RECORDING_SETTINGS;
  for (const steps of [1, 480, 7, 60, 2, 1000, -5]) {
    settings = withPhysicsSteps(settings, steps);
    assert.ok(
      settings.motionBlurSamples >= 1 &&
        settings.motionBlurSamples <= settings.physicsSteps,
      `${settings.motionBlurSamples} not in [1, ${settings.physicsSteps}]`,
    );
    assert.ok(settings.physicsSteps >= 1 && settings.physicsSteps <= MAX_PHYSICS_STEPS);
  }
});

test('withMotionBlurSamples clamps to the current ceiling', () => {
  const settings = withPhysicsSteps(DEFAULT_RECORDING_SETTINGS, 10);
  assert.equal(withMotionBlurSamples(settings, 1000).motionBlurSamples, 10);
  assert.equal(withMotionBlurSamples(settings, 0).motionBlurSamples, 1);
  assert.equal(withMotionBlurSamples(settings, 4).motionBlurSamples, 4);
  assert.equal(withMotionBlurSamples(settings, NaN).motionBlurSamples, 1);
});

test('the blur default is the ceiling, unlike the live editor default of 1', () => {
  // Deliberately opposite to `DEFAULT_PREFERENCES.motionBlurSamples`. An offline
  // render has no latency to protect, so the default is the best picture the
  // chosen rate can produce. See the module header.
  assert.equal(
    DEFAULT_RECORDING_SETTINGS.motionBlurSamples,
    DEFAULT_RECORDING_SETTINGS.physicsSteps,
  );
});

test('duration and resolution are clamped and looked up by label', () => {
  assert.equal(withDuration(DEFAULT_RECORDING_SETTINGS, 1000).duration, 120);
  assert.equal(withDuration(DEFAULT_RECORDING_SETTINGS, 0).duration, 1);

  const uhd = withResolution(DEFAULT_RECORDING_SETTINGS, '4K');
  assert.equal(uhd.resolution.width, 3840);
  // An unknown label leaves the record alone rather than throwing -- a dropdown
  // that does nothing beats a crashed export. See `withResolution`.
  assert.equal(withResolution(uhd, 'nope').resolution.label, '4K');
});

test('frameCount is duration times the output rate', () => {
  assert.equal(frameCount(DEFAULT_RECORDING_SETTINGS), 5 * RECORDING_FPS);
  assert.equal(frameCount(withDuration(DEFAULT_RECORDING_SETTINGS, 1)), RECORDING_FPS);
});

test('pausing suspends the recording rather than encoding a still', () => {
  // THE PAUSE RULE. A paused frame is a still -- `orchestrator.frame()` skips
  // `runFrame` and re-renders the frozen state -- so encoding it would append a
  // duplicate. Doing that for the length of the pause is the "dead space in the
  // middle of the video" the feature must not produce.
  assert.equal(driverAction({ finished: false, paused: true }), 'suspend');
  assert.equal(driverAction({ finished: false, paused: false }), 'encode');
});

test('finishing OUTRANKS pausing, so a paused export can still complete', () => {
  // The precedence that is invisible from reading either condition alone, and
  // the reason this is a named function rather than an `if` in a callback.
  //
  // Both reachable in practice: the final frame can land on the very frame the
  // user pauses, and Cancel is clickable while paused. If `suspend` won, either
  // would strand the export -- no file written, and the only way out would be to
  // unpause a recording the user had already ended.
  assert.equal(driverAction({ finished: true, paused: true }), 'finalize');
  assert.equal(driverAction({ finished: true, paused: false }), 'finalize');
});

test('only encoding advances progress, so the frame count is pause-invariant', () => {
  // The property the pause rule exists to guarantee, stated as the specification
  // states it: however many times the user pauses, the finished clip holds
  // exactly `duration * fps` frames of real motion.
  //
  // Simulated over a run that pauses repeatedly. `encode` is the ONLY action
  // that advances the counter, so the total is invariant under any pause
  // pattern -- which is what makes pausing safe to use as an inspection tool
  // mid-export.
  const total = frameCount(DEFAULT_RECORDING_SETTINGS);
  for (const pausePattern of [3, 5, 7, 11]) {
    let encoded = 0;
    let tick = 0;
    // Generous bound: every tick either encodes or is a pause, and the pause
    // pattern never blocks forever, so this terminates well inside it.
    while (encoded < total && tick < total * 10) {
      const action = driverAction({
        finished: encoded >= total,
        paused: tick % pausePattern === 0,
      });
      if (action === 'encode') encoded++;
      tick++;
    }
    assert.equal(
      encoded,
      total,
      `pausing every ${pausePattern} ticks changed the frame count`,
    );
  }
});

test('every offered resolution is even-dimensioned', () => {
  // H.264 with 4:2:0 chroma subsampling requires even dimensions; an odd one is
  // rejected by the encoder at `configure` time, which is a failure the user
  // meets only after choosing to export.
  for (const r of RESOLUTIONS) {
    assert.equal(r.width % 2, 0, `${r.label} width`);
    assert.equal(r.height % 2, 0, `${r.label} height`);
  }
});
