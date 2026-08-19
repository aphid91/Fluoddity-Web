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
  MIN_RECORDING_DIM,
  RECORDING_FPS,
  clampResolution,
  cropRect,
  driverAction,
  frameCount,
  isFullFrame,
  physicsFrameCount,
  rescaleSamples,
  withDuration,
  withHeight,
  withMotionBlurSamples,
  withPhysicsSteps,
  withWidth,
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

test('duration is clamped to its range', () => {
  assert.equal(withDuration(DEFAULT_RECORDING_SETTINGS, 1000).duration, 120);
  assert.equal(withDuration(DEFAULT_RECORDING_SETTINGS, 0).duration, 1);
});

test('the recording never exceeds the window, at any window size', () => {
  // THE CEILING INVARIANT. The window shrinks under a chosen size whenever the
  // user drags the browser edge, so this is checked on every read rather than
  // only when a slider moves -- a stored size that was legal yesterday is not
  // evidence about today.
  const windows: (readonly [number, number])[] = [
    [1920, 1080], [800, 600], [3840, 2160], [130, 130], [1, 1], [1001, 777],
  ];
  for (const win of windows) {
    for (const req of [{ width: 99999, height: 99999 }, { width: 640, height: 480 }]) {
      const got = clampResolution(req, win);
      assert.ok(got.width <= Math.max(MIN_RECORDING_DIM, win[0]), `w ${got.width} > ${win[0]}`);
      assert.ok(got.height <= Math.max(MIN_RECORDING_DIM, win[1]), `h ${got.height} > ${win[1]}`);
      // Even, for H.264's 4:2:0 chroma -- an odd dimension is rejected by the
      // encoder at configure time, which the user meets only after pressing
      // Export.
      assert.equal(got.width % 2, 0, `odd width ${got.width}`);
      assert.equal(got.height % 2, 0, `odd height ${got.height}`);
      assert.ok(got.width >= MIN_RECORDING_DIM && got.height >= MIN_RECORDING_DIM);
    }
  }
});

test('the crop box is centred and stays inside the window', () => {
  const win: readonly [number, number] = [1920, 1080];
  const settings = withHeight(withWidth(DEFAULT_RECORDING_SETTINGS, 1280, win), 720, win);
  const rect = cropRect(settings.resolution, win);

  assert.deepEqual(rect, { x: 320, y: 180, width: 1280, height: 720 });
  // The margins match on both sides, which is what "centred" means and is the
  // thing a user would notice instantly if it were wrong.
  assert.equal(rect.x, win[0] - rect.width - rect.x);
  assert.equal(rect.y, win[1] - rect.height - rect.y);
  // Whole pixels: a half-pixel offset makes the capture sample between texels
  // and softens every exported frame.
  assert.ok(Number.isInteger(rect.x) && Number.isInteger(rect.y));
});

test('the default is full frame, so the crop overlay starts hidden', () => {
  // Cropping is the exception; the common export is what is on screen. The
  // default therefore asks for the whole window and `isFullFrame` reports it,
  // which is what keeps the grey surround off until the user asks for it.
  for (const win of [[1920, 1080], [800, 600], [1001, 777]] as const) {
    assert.ok(
      isFullFrame(DEFAULT_RECORDING_SETTINGS.resolution, win),
      `not full frame at ${win.join('x')}`,
    );
  }
  const cropped = withWidth(DEFAULT_RECORDING_SETTINGS, 640, [1920, 1080]);
  assert.ok(!isFullFrame(cropped.resolution, [1920, 1080]));
});

test('frameCount is duration times the output rate', () => {
  assert.equal(frameCount(DEFAULT_RECORDING_SETTINGS), 5 * RECORDING_FPS);
  assert.equal(frameCount(withDuration(DEFAULT_RECORDING_SETTINGS, 1)), RECORDING_FPS);
});

test('physicsFrameCount is video frames times the physics rate', () => {
  // The number the user compares against `Status.frameCount` when deciding
  // whether a recording will travel far enough to reach the structure they
  // parked on. Both count physics SUB-STEPS, which is what makes them
  // comparable -- see `physicsFrameCount`.
  const at60 = withPhysicsSteps(withDuration(DEFAULT_RECORDING_SETTINGS, 5), 60);
  assert.equal(frameCount(at60), 300, '5s at 60fps is 300 video frames');
  assert.equal(physicsFrameCount(at60), 18_000, '300 frames x 60 steps');

  // The distinction the readout exists to make visible: the same clip LENGTH
  // travels four times as far when the rate is quadrupled.
  const at240 = withPhysicsSteps(at60, 240);
  assert.equal(frameCount(at240), 300, 'video length is unchanged');
  assert.equal(physicsFrameCount(at240), 72_000, 'but the simulation goes 4x as far');
});

test('physicsFrameCount reaches the ranges the workflow needs', () => {
  // The motivating case: "I am at physics frame 50k and need the recording to
  // get there." That must be expressible within the sliders' bounds, or the
  // readout would only ever report failure.
  const reach = withPhysicsSteps(withDuration(DEFAULT_RECORDING_SETTINGS, 10), 240);
  assert.ok(
    physicsFrameCount(reach) >= 50_000,
    `10s at 240 steps only reaches ${physicsFrameCount(reach)}`,
  );

  // And the floor is sane rather than zero -- a one-second clip at one step per
  // frame is 60 physics steps, not nothing.
  const min = withPhysicsSteps(withDuration(DEFAULT_RECORDING_SETTINGS, 1), 1);
  assert.equal(physicsFrameCount(min), 60);
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

