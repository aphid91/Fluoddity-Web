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
  DEFAULT_QUALITY,
  DEFAULT_RECORDING_SETTINGS,
  EXPORT_SHOWN_STORAGE_KEY,
  FULL_FRAME,
  MAX_PHYSICS_STEPS,
  MIN_RECORDING_DIM,
  QUALITY_LABELS,
  QUALITY_PRESETS,
  RECORDING_FPS,
  RECORDING_STORAGE_KEY,
  type RecordingStorage,
  clampResolution,
  cropRect,
  driverAction,
  frameCount,
  isFullFrame,
  loadExportVideoShown,
  loadRecordingSettings,
  physicsFrameCount,
  rescaleSamples,
  saveExportVideoShown,
  saveRecordingSettings,
  withDuration,
  withHeight,
  withMotionBlurSamples,
  withPhysicsSteps,
  withQuality,
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

test('the quality default is unchanged from before the control existed', () => {
  // Adding the dropdown must not silently re-encode everyone's exports at a
  // different level. `high` is what was hardcoded before it, and the request was
  // for access to something HIGHER rather than a new default.
  assert.equal(DEFAULT_RECORDING_SETTINGS.quality, 'high');
  assert.equal(DEFAULT_QUALITY, 'high');
});

test('there is a level ABOVE the default, which is the point of the control', () => {
  // If `high` were the top of the list this whole feature would be decorative.
  const above = QUALITY_PRESETS.slice(QUALITY_PRESETS.indexOf(DEFAULT_QUALITY) + 1);
  assert.ok(above.length > 0, 'nothing above the default');
  assert.deepEqual(above, ['very-high']);
});

test('the presets run worst to best and every one has a label', () => {
  // Ordering is load-bearing: the dropdown is built from this array, and a
  // quality list that does not ascend reads as broken. A missing label would
  // render as `undefined` in the menu.
  assert.deepEqual(QUALITY_PRESETS, ['very-low', 'low', 'medium', 'high', 'very-high']);
  for (const preset of QUALITY_PRESETS) {
    assert.equal(typeof QUALITY_LABELS[preset], 'string', `no label for ${preset}`);
    assert.ok(QUALITY_LABELS[preset].length > 0, `empty label for ${preset}`);
  }
});

test('withQuality accepts the presets and REFUSES anything else', () => {
  // The validation matters because the failure it prevents is remote from its
  // cause: an unknown level reaches `new Quality(...)` and the encoder refuses
  // to configure -- after the user has pressed Export and chosen a file.
  for (const preset of QUALITY_PRESETS) {
    assert.equal(withQuality(DEFAULT_RECORDING_SETTINGS, preset).quality, preset);
  }
  for (const junk of ['', 'ultra', 'HIGH', 'very high', '0.9']) {
    assert.equal(
      withQuality(DEFAULT_RECORDING_SETTINGS, junk).quality,
      DEFAULT_QUALITY,
      `"${junk}" must not be adopted`,
    );
  }
});

test('quality is independent of everything else in the record', () => {
  // It affects the FILE, not the render. Changing it must not disturb the
  // resolution, the duration or the physics pair -- and in particular must not
  // trip the blur ceiling, which is the one coupled invariant here.
  const before = withPhysicsSteps(DEFAULT_RECORDING_SETTINGS, 120);
  const after = withQuality(before, 'very-high');
  assert.equal(after.quality, 'very-high');
  assert.deepEqual(after.resolution, before.resolution);
  assert.equal(after.duration, before.duration);
  assert.equal(after.physicsSteps, before.physicsSteps);
  assert.equal(after.motionBlurSamples, before.motionBlurSamples);
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


// ---------------------------------------------------------------------------
// Persistence
//
// Faked storage rather than a mocked-out module, for `preferences.test.ts`'s
// reason: `localStorage` does not exist under `node --test`, which is exactly
// why these functions take a storage object. It also makes the two failure
// modes testable rather than merely asserted -- a store that THROWS (Safari
// private mode) and one holding CORRUPT text (a hand-edited entry).
//
// The corrupt case is the one that matters. A bad entry in `localStorage`
// OUTLIVES A PAGE RELOAD, so a `load` that threw would make the recording tab
// permanently unopenable until the user cleared site data by hand.
// ---------------------------------------------------------------------------

/** A `localStorage` stand-in over a plain map. */
function fakeStorage(initial: Record<string, string> = {}): RecordingStorage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string): string | null => map.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      map.set(key, value);
    },
  };
}

/** A store that throws from both methods, as a disabled one does. */
const hostileStorage: RecordingStorage = {
  getItem(): string | null {
    throw new Error('SecurityError: storage is disabled');
  },
  setItem(): void {
    throw new Error('QuotaExceededError');
  },
};

test('settings survive a round trip unchanged', () => {
  // The whole point of the feature: set something up, reload, find it as you
  // left it. Every field is moved off its default so a load that silently
  // returned the defaults could not pass.
  const storage = fakeStorage();
  const chosen = withQuality(
    withDuration(
      withMotionBlurSamples(withPhysicsSteps(DEFAULT_RECORDING_SETTINGS, 240), 37),
      42,
    ),
    'very-high',
  );
  saveRecordingSettings(chosen, storage);
  assert.deepEqual(loadRecordingSettings(storage), chosen);
});

test('the full-frame default round-trips as full frame, not as a fixed crop', () => {
  // The regression this sentinel is named for. `FULL_FRAME` means "the whole
  // window, whatever it is today", and it has to survive storage as itself --
  // if loading rejected or clamped it, a user who never touched the sliders
  // would come back cropped to whatever window they last had.
  const storage = fakeStorage();
  saveRecordingSettings(DEFAULT_RECORDING_SETTINGS, storage);
  const loaded = loadRecordingSettings(storage);
  assert.equal(loaded.resolution.width, FULL_FRAME);
  assert.equal(loaded.resolution.height, FULL_FRAME);
  // And still reads as full frame against a real window, which is what the
  // crop overlay asks. A stored sentinel that loaded but no longer satisfied
  // this would put a crop box on screen for someone who never cropped.
  assert.ok(isFullFrame(loaded.resolution, [1920, 1080]));
});

test('an empty store yields the defaults', () => {
  assert.deepEqual(loadRecordingSettings(fakeStorage()), DEFAULT_RECORDING_SETTINGS);
});

test('loading never throws, whatever the store holds', () => {
  // The contract. Each of these is a plausible real entry: a half-written
  // string, a hand edit, a value of the wrong shape, or a newer version's
  // record met after a downgrade.
  const corrupt = [
    '',
    '{',
    'null',
    'true',
    '[]',
    '"a string"',
    '{"duration":"long"}',
    '{"resolution":null}',
    '{"resolution":[1,2]}',
    '{"resolution":{"width":"wide"}}',
    '{"physicsSteps":NaN}',
    '{"unknownFutureKey":1}',
  ];
  for (const raw of corrupt) {
    const got = loadRecordingSettings(fakeStorage({ [RECORDING_STORAGE_KEY]: raw }));
    // Not merely "did not throw": every field must be usable, because these
    // feed loop bounds and texture sizes downstream.
    assert.ok(Number.isInteger(got.duration) && got.duration >= 1, raw);
    assert.ok(Number.isInteger(got.physicsSteps) && got.physicsSteps >= 1, raw);
    assert.ok(
      (QUALITY_PRESETS as readonly string[]).includes(got.quality),
      `quality escaped the preset list: ${raw}`,
    );
  }
});

test('a storage that throws is survivable in both directions', () => {
  // Safari in private mode. Losing the ability to PERSIST a setting must not
  // lose the ability to SET one, so neither call may propagate.
  assert.deepEqual(loadRecordingSettings(hostileStorage), DEFAULT_RECORDING_SETTINGS);
  assert.doesNotThrow(() => {
    saveRecordingSettings(DEFAULT_RECORDING_SETTINGS, hostileStorage);
  });
  // The same for the visibility flag, which is read at Panel construction --
  // a throw there would take the whole editor down, not just the tab.
  assert.equal(loadExportVideoShown(hostileStorage), false);
  assert.doesNotThrow(() => {
    saveExportVideoShown(true, hostileStorage);
  });
});

test('a null storage is survivable: no browser, no crash', () => {
  // The embedded/no-localStorage case, which is how these run under the DOM
  // tests. `null` is a legal argument and means "do not persist".
  assert.deepEqual(loadRecordingSettings(null), DEFAULT_RECORDING_SETTINGS);
  assert.equal(loadExportVideoShown(null), false);
  assert.doesNotThrow(() => {
    saveRecordingSettings(DEFAULT_RECORDING_SETTINGS, null);
    saveExportVideoShown(true, null);
  });
});

test('the blur ceiling invariant is re-established on load, not trusted', () => {
  // A stored record can hold a pair that violates `samples <= steps` -- a hand
  // edit, or a downgrade from a version with a higher ceiling. This is a
  // BOUNDARY, so the invariant the rest of the module assumes is restored here
  // rather than assumed: `motionBlurSamples` is divided by and `physicsSteps`
  // is a loop bound, so a bad pair is a dim frame or a hang, not a wrong pixel.
  const loaded = loadRecordingSettings(
    fakeStorage({
      [RECORDING_STORAGE_KEY]: '{"physicsSteps":10,"motionBlurSamples":400}',
    }),
  );
  assert.equal(loaded.physicsSteps, 10);
  assert.equal(loaded.motionBlurSamples, 10);
});

test('a rejected physics rate does not leave the sample count inconsistent', () => {
  // The subtle half of the invariant: the sample count is clamped against the
  // rate that was ACTUALLY LOADED, not the one that was stored. Here the rate
  // is out of range and falls back to the default, and the samples must follow
  // that default rather than the number beside them in the record.
  const loaded = loadRecordingSettings(
    fakeStorage({
      [RECORDING_STORAGE_KEY]: '{"physicsSteps":99999,"motionBlurSamples":5000}',
    }),
  );
  assert.equal(loaded.physicsSteps, DEFAULT_RECORDING_SETTINGS.physicsSteps);
  assert.ok(loaded.motionBlurSamples <= loaded.physicsSteps);
});

test('out-of-range and unknown values fall back per field, not wholesale', () => {
  // One bad field must not discard the record. Someone who hand-edited the
  // duration should keep the quality they chose through the UI.
  const loaded = loadRecordingSettings(
    fakeStorage({
      [RECORDING_STORAGE_KEY]: '{"duration":9999,"quality":"very-high"}',
    }),
  );
  assert.equal(loaded.duration, DEFAULT_RECORDING_SETTINGS.duration);
  assert.equal(loaded.quality, 'very-high');
});

test('an unknown quality falls back rather than reaching the encoder', () => {
  // A value outside the preset list would fail at `configure` time -- after the
  // user pressed Begin Recording, which is the worst moment to find out. Same
  // reasoning as `withQuality`'s validation, applied at the storage boundary.
  const loaded = loadRecordingSettings(
    fakeStorage({ [RECORDING_STORAGE_KEY]: '{"quality":"insane"}' }),
  );
  assert.equal(loaded.quality, DEFAULT_QUALITY);
});

test('a dimension below the floor falls back rather than becoming degenerate', () => {
  // `MIN_RECORDING_DIM` exists because an encoder configured for a 2px frame is
  // legal and useless. A stored value under it is not clamped up to the floor
  // but rejected, so the user gets the default back rather than a 128px sliver
  // they never asked for.
  const loaded = loadRecordingSettings(
    fakeStorage({
      [RECORDING_STORAGE_KEY]: `{"resolution":{"width":2,"height":${MIN_RECORDING_DIM}}}`,
    }),
  );
  assert.equal(loaded.resolution.width, DEFAULT_RECORDING_SETTINGS.resolution.width);
  // The legal one beside it is kept: per-field fallback, as above.
  assert.equal(loaded.resolution.height, MIN_RECORDING_DIM);
});

test('the visibility flag round-trips and defaults to hidden', () => {
  // Defaults to false on anything unexpected: the cost of wrongly hiding is a
  // menu item to re-tick, while wrongly showing puts a tab in front of someone
  // who never asked for one.
  const storage = fakeStorage();
  assert.equal(loadExportVideoShown(storage), false);
  saveExportVideoShown(true, storage);
  assert.equal(loadExportVideoShown(storage), true);
  saveExportVideoShown(false, storage);
  assert.equal(loadExportVideoShown(storage), false);
  for (const junk of ['', 'yes', '1', 'TRUE', '{}']) {
    assert.equal(
      loadExportVideoShown(fakeStorage({ [EXPORT_SHOWN_STORAGE_KEY]: junk })),
      false,
      `treated ${junk} as shown`,
    );
  }
});

test('the two records are stored under separate keys', () => {
  // The visibility flag is deliberately not a sixth `RecordingSettings` field
  // -- that record is handed WHOLE to the recorder, and whether a panel tab is
  // on screen is nothing the encoder should receive. Separate keys are what
  // let `Panel` read the flag at construction, before any settings exist.
  assert.notEqual(RECORDING_STORAGE_KEY, EXPORT_SHOWN_STORAGE_KEY);
  const storage = fakeStorage();
  saveRecordingSettings(DEFAULT_RECORDING_SETTINGS, storage);
  saveExportVideoShown(true, storage);
  // Neither clobbered the other.
  assert.equal(loadExportVideoShown(storage), true);
  assert.deepEqual(loadRecordingSettings(storage), DEFAULT_RECORDING_SETTINGS);
});
