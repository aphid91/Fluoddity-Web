/**
 * Recording settings: the value type behind the Recording Controls tab.
 *
 * A LEAF, and a pure one -- no GPU handles, no `.wgsl` imports, nothing that
 * needs a device. Exactly the split `camera/blurSchedule.ts` documents: the one
 * piece of the recording path that is arithmetic is also the piece where a wrong
 * answer is invisible (a slider that drifts off its own position, a sample count
 * silently above its ceiling), so it is the piece that wants a test. Everything
 * that touches WebGPU or mediabunny lives in `recorder.ts`, which cannot be
 * imported under `node --test`.
 *
 * These are PREFERENCES in the sense `prefs/preferences.ts` draws: how your
 * editor is set up, never part of a saved config and never in history. They are
 * kept in their own record rather than folded into `Preferences` because the
 * whole recording feature is lazily loaded -- see `recorder.ts` -- and a field
 * in the shared preferences record would be read by code that runs whether or
 * not the user ever opens the tab.
 *
 * ## The two coupled numbers
 *
 * `physicsSteps` and `motionBlurSamples` here are the RECORDING's own values,
 * deliberately separate from the live `Preferences` pair of the same name. The
 * point of the feature is to render at rates the interactive editor cannot
 * sustain: 240 physics steps and 64 blur samples is a perfectly reasonable
 * export and a slideshow to work in. Sharing one pair would mean the act of
 * setting up an export wrecked the editor you were setting it up from.
 *
 * Their coupling -- the blur ceiling tracking the physics rate, and the slider
 * holding its POSITION rather than its VALUE when that ceiling moves -- is
 * `rescaleSamples` below, and is the only real rule in this file.
 */

/** A recording size in pixels. */
export interface Resolution {
  readonly width: number;
  readonly height: number;
}

/**
 * The smallest recording either dimension may be.
 *
 * Not 1: an encoder configured for a 2px-wide frame is legal and useless, and a
 * crop box that small is impossible to see or aim. 128 is comfortably below any
 * real use and comfortably above degenerate.
 */
export const MIN_RECORDING_DIM = 128;

/**
 * Snap a dimension to an even number, rounding DOWN.
 *
 * H.264 with 4:2:0 chroma subsampling requires even dimensions -- an odd one is
 * rejected at `configure` time, which the user would meet only after choosing to
 * export. Down rather than up so the result can never exceed the window bound
 * the caller just clamped to; growing past it would put the crop box off screen
 * by a pixel at full width.
 */
export function evenDim(value: number): number {
  return Math.max(MIN_RECORDING_DIM, Math.trunc(value) - (Math.trunc(value) % 2));
}

/**
 * "The whole window, whatever that is today" -- the resolution sentinel.
 *
 * A dimension this large is never a real window, and every read of the
 * resolution goes through `clampResolution`, so it collapses to the current
 * window size at the point of use. That is what lets this file express "full
 * frame" without knowing the window size.
 *
 * **NAMED RATHER THAN INLINE BECAUSE IT MUST SURVIVE PERSISTENCE.** It is the
 * upper bound `loadRecordingSettings` validates a stored dimension against; a
 * tighter bound would reject the DEFAULT record and quietly turn "full frame"
 * into a fixed crop at whatever size the window happened to be when it was
 * saved -- so someone who never touched the sliders would find their next
 * session cropped to their last one's window.
 */
export const FULL_FRAME = 1 << 20;

/** Frames per second of the OUTPUT file. Not a rate the renderer must keep up with. */
export const RECORDING_FPS = 60;

/**
 * The encoder quality presets, worst to best.
 *
 * These are mediabunny's five named `QualityLevel`s, which map to 0, 0.25, 0.5,
 * 0.75 and 1 on its internal scale. The names are passed straight through --
 * NOT reinterpreted into bitrates here -- because mediabunny picks bitrate- or
 * quantizer-driven encoding per codec and per system from that level, and a
 * hardcoded bitrate would throw away that adaptation and be wrong at some
 * resolutions.
 *
 * ## Why the two extremes are offered at all
 *
 * `very-high` is the point of this control: this app renders particle fields
 * with fine bright filaments over near-black, which is exactly the content
 * H.264 spends its bits worst on -- banding in the dark and mush in the
 * filaments. Someone exporting a piece they care about should be able to ask
 * for more.
 *
 * `low` and `very-low` are kept for the opposite case rather than for
 * completeness: a long 4K export at `very-high` produces a very large file, and
 * a rough take for review does not need one.
 *
 * ## Ordering is load-bearing
 *
 * Worst first, so the dropdown reads bottom-to-top like every quality control,
 * and so `QUALITY_PRESETS.indexOf` is a meaningful comparison. `DEFAULT_QUALITY`
 * names its entry rather than indexing, so reordering cannot silently move the
 * default.
 */
export const QUALITY_PRESETS = [
  'very-low',
  'low',
  'medium',
  'high',
  'very-high',
] as const;

export type QualityPreset = (typeof QUALITY_PRESETS)[number];

/**
 * The shipped default.
 *
 * `high`, which is what this feature used before the control existed -- so
 * adding the dropdown changes nobody's output until they choose to change it.
 * That is deliberate: the user called the current quality "an excellent
 * default" and wanted access to something HIGHER, not a different default.
 */
export const DEFAULT_QUALITY: QualityPreset = 'high';

/** Human labels for the dropdown. Separate from the wire values, which are mediabunny's. */
export const QUALITY_LABELS: Readonly<Record<QualityPreset, string>> = {
  'very-low': 'Very Low (smallest file)',
  low: 'Low',
  medium: 'Medium',
  high: 'High (default)',
  'very-high': 'Very High (largest file)',
};

/** Bounds on the recording's physics rate. The live editor's is a preference; this is not. */
export const MIN_PHYSICS_STEPS = 1;
export const MAX_PHYSICS_STEPS = 480;

/** Bounds on the clip length, in seconds. */
export const MIN_DURATION = 1;
export const MAX_DURATION = 120;

/**
 * What the Recording Controls tab edits.
 *
 * Immutable, like `Preferences`, and edited through the helpers below rather
 * than by assignment -- `motionBlurSamples` can never be set independently of
 * `physicsSteps` without breaking the ceiling invariant, so there is no
 * general-purpose `withValue` here on purpose.
 */
export interface RecordingSettings {
  /**
   * The recording size in pixels, which is also the CROP BOX on screen.
   *
   * **Never larger than the window**, and that is the whole design: the exported
   * pixels are a sub-rectangle of the pixels already being rendered, taken 1:1
   * at native resolution. There is no upscaling and no second render -- which is
   * why this is cheap, and why it is strictly more honest than choosing a size
   * larger than the window and stretching to reach it.
   *
   * `clampResolution` is the only thing that should write it, because the window
   * can shrink underneath a chosen size and the invariant has to be restored
   * when it does.
   */
  readonly resolution: Resolution;
  /** Clip length in seconds. Frame count is this times `RECORDING_FPS`. */
  readonly duration: number;
  /**
   * Encoder quality. Passed to mediabunny's `Quality` as a named level.
   *
   * Affects FILE SIZE and compression artefacts only -- never the render. The
   * frames handed to the encoder are identical at every setting; this decides
   * how many bits are spent describing them.
   */
  readonly quality: QualityPreset;
  /**
   * Physics sub-steps per RECORDED frame. The recording's own rate, independent
   * of the live editor's -- see the file header.
   */
  readonly physicsSteps: number;
  /**
   * Temporal supersamples per recorded frame. INVARIANT: always within
   * `[1, physicsSteps]`. Nothing outside this module may write it; see
   * `rescaleSamples`.
   */
  readonly motionBlurSamples: number;
}

/**
 * Defaults: 1080p, five seconds, and a physics rate well above the interactive
 * one with blur pinned to its ceiling.
 *
 * **Blur starts at maximum, which is the opposite of the live default.** The
 * live `motionBlurSamples` defaults to 1 because every sample costs a frame of
 * latency in an editor you are dragging sliders in. A recording has no latency
 * to protect -- it is an offline render whose whole selling point is buying
 * quality with time -- so the default that serves the user is the best picture
 * the chosen physics rate can produce.
 */
export const DEFAULT_RECORDING_SETTINGS: RecordingSettings = Object.freeze({
  // Deliberately huge, and immediately clamped: every read goes through
  // `clampResolution`, so this means "the whole window, whatever that is today"
  // without this file needing to know the window size. Starting at full frame is
  // right because cropping is the exception -- the common export is what is on
  // screen -- and it means the crop overlay is hidden until the user asks for it.
  resolution: { width: FULL_FRAME, height: FULL_FRAME },
  duration: 5,
  quality: DEFAULT_QUALITY,
  physicsSteps: 60,
  motionBlurSamples: 60,
});

/** Total VIDEO frames the export will produce. */
export function frameCount(settings: RecordingSettings): number {
  return Math.max(1, Math.round(settings.duration * RECORDING_FPS));
}

/**
 * Total PHYSICS steps the export will simulate.
 *
 * The quantity that answers "will this recording reach the structure I am
 * looking at?". `ParticleSystem.frameCount` counts physics sub-steps, not
 * rendered frames (`particleSystem.ts` advances it by `steps` per frame), so
 * this is directly comparable to it: park the simulation on something good, read
 * its physics frame, and set duration and rate until this number clears it.
 *
 * DISTINCT FROM `frameCount` ABOVE, and the difference is the whole point.
 * A five-second clip is 300 video frames however the physics is set, but 300
 * frames at 60 steps each is 18,000 physics steps and at 240 is 72,000. The
 * video length is what the viewer sees; this is how far the simulation actually
 * travels, and only the second one says whether a structure will have formed.
 */
export function physicsFrameCount(settings: RecordingSettings): number {
  return frameCount(settings) * settings.physicsSteps;
}

/** What the driver loop knows about the recording when it decides what to do. */
export interface DriverState {
  /** True once every frame is submitted, or the user cancelled. */
  readonly finished: boolean;
  /** True while the simulation is paused, by any route. */
  readonly paused: boolean;
}

/**
 * What the frame loop should do with the recorder this frame.
 *
 * A PURE FUNCTION IN THE LEAF, rather than two conditions inline in `main.ts`'s
 * rAF callback, because the rule it encodes is the specified pause behaviour and
 * is exactly the kind of thing that looks obviously right and is not:
 *
 *   `encode`    A real frame of motion. The only outcome that advances the
 *               counter, which is what makes the physics frame count INVARIANT
 *               under pausing -- pause as often as you like and the finished
 *               clip still holds `duration * fps` frames of motion, with no dead
 *               space where the pauses were.
 *
 *   `suspend`   Paused mid-export. `orchestrator.frame()` renders a STILL when
 *               paused, so encoding it would append a duplicate of the previous
 *               frame; doing that for the length of the pause is precisely the
 *               dead space this must not produce.
 *
 *   `finalize`  Done, or cancelled. **Outranks `suspend`, and must**: the last
 *               frame can land on the very frame the user pauses, and Cancel is
 *               reachable while paused. If suspension won, either would strand
 *               the export -- the file never written, and the only way out being
 *               to unpause a recording the user had already ended.
 *
 * The precedence is the whole content of this function, and it is not visible
 * from reading either condition alone. That is what makes it worth a name and a
 * test rather than an `if` in a callback.
 */
export function driverAction(state: DriverState): 'encode' | 'suspend' | 'finalize' {
  if (state.finished) return 'finalize';
  return state.paused ? 'suspend' : 'encode';
}

/**
 * Clamp `value` into `[min, max]`, truncating to a whole number.
 *
 * `Math.trunc` rather than `Math.round`, matching `blurSchedule.ts`'s
 * substitution for Python's `int()`; the `|| min` tail is what stops a NaN --
 * which truncates to NaN and survives `Math.min`/`Math.max` untouched -- from
 * reaching a texture size or a loop bound.
 */
function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value))) || min;
}

/**
 * Move the blur slider's POSITION, not its value, onto a new ceiling.
 *
 * ## The rule
 *
 * The slider's range is always `[1, physicsSteps]`. When the physics rate
 * changes, the handle must not appear to move: a slider sitting halfway must
 * still sit halfway, and only the NUMBER under it changes. So what is preserved
 * across the change is the fraction of the range the handle occupies --
 * `(value - 1) / (ceiling - 1)` -- which IS the handle's position, rather than
 * the raw value, which is its label.
 *
 * Worked, from the specification: at a ceiling of 10 with 5 samples the handle
 * is at `(5-1)/(10-1) = 4/9`. Raising the ceiling to 15 puts it at
 * `1 + floor(4/9 * 14) = 1 + 6 = 7`. The handle has not moved; the number has.
 *
 * **`floor`, so the value never exceeds the fraction it came from.** Rounding
 * would let a handle just below a boundary cross it, which over a few changes
 * walks the slider upward -- the drift this function exists to prevent.
 *
 * ## The two degenerate ceilings
 *
 * A ceiling of 1 leaves one legal value, so the fraction is undefined (`0/0`)
 * and the answer is 1 regardless of where the handle was. That is not a special
 * case bolted on: with one position available the handle IS at that position.
 *
 * Coming back OUT of a ceiling of 1 is the case that makes the previous handle
 * position worth carrying: from `physicsSteps` 1 the fraction is unrecoverable,
 * so the slider returns to its ceiling -- the default posture, and the one this
 * feature's users want -- rather than to a stale value from before the collapse.
 */
export function rescaleSamples(
  previousSamples: number,
  previousCeiling: number,
  nextCeiling: number,
): number {
  const ceiling = clampInt(nextCeiling, MIN_PHYSICS_STEPS, MAX_PHYSICS_STEPS);
  if (ceiling <= 1) return 1;

  const oldCeiling = clampInt(previousCeiling, MIN_PHYSICS_STEPS, MAX_PHYSICS_STEPS);
  // The fraction is unrecoverable from a collapsed range -- see the header.
  // Pinning to the ceiling matches the default and is what an offline render
  // wants; carrying a stale pre-collapse value forward would be arbitrary.
  if (oldCeiling <= 1) return ceiling;

  const value = clampInt(previousSamples, 1, oldCeiling);
  const fraction = (value - 1) / (oldCeiling - 1);
  return clampInt(1 + Math.floor(fraction * (ceiling - 1)), 1, ceiling);
}

/**
 * Set the recording's physics rate, carrying the blur slider's position with it.
 *
 * The ONE way `physicsSteps` may be written, which is what keeps the ceiling
 * invariant on `motionBlurSamples` true by construction rather than by everyone
 * who edits the record remembering to re-clamp.
 */
export function withPhysicsSteps(
  settings: RecordingSettings,
  physicsSteps: number,
): RecordingSettings {
  const next = clampInt(physicsSteps, MIN_PHYSICS_STEPS, MAX_PHYSICS_STEPS);
  return {
    ...settings,
    physicsSteps: next,
    motionBlurSamples: rescaleSamples(
      settings.motionBlurSamples,
      settings.physicsSteps,
      next,
    ),
  };
}

/**
 * Set the physics rate WITHOUT rescaling the blur slider, clamping samples.
 *
 * ## Why this exists next to `withPhysicsSteps`
 *
 * `rescaleSamples` is deliberately lossy: it preserves the slider's POSITION
 * and `floor`s the value that falls out, which is correct once per deliberate
 * change and wrong applied repeatedly. Tweakpane fires `change` throughout a
 * drag, so routing every intermediate rate through `withPhysicsSteps` compounds
 * that floor once per event and walks the sample count down for no reason the
 * user can see.
 *
 * So the UI writes the rate live through THIS -- which keeps the invariant
 * (`motionBlurSamples <= physicsSteps`) true at every intermediate value
 * without pretending to preserve a handle position -- and calls
 * `withPhysicsSteps` once on release, against the rate the user settled on.
 * See `recordingSection.ts`'s `scheduleStepsCommit`.
 *
 * **The invariant is still enforced here**, which is what keeps this a legal
 * way to write the field: dragging the rate DOWN past the sample count clamps
 * the count with it. What it does not do is push the count back up on the way
 * out, which is `withPhysicsSteps`'s job and happens at the end of the gesture.
 */
export function withPhysicsStepsRaw(
  settings: RecordingSettings,
  physicsSteps: number,
): RecordingSettings {
  const next = clampInt(physicsSteps, MIN_PHYSICS_STEPS, MAX_PHYSICS_STEPS);
  return {
    ...settings,
    physicsSteps: next,
    motionBlurSamples: clampInt(settings.motionBlurSamples, 1, next),
  };
}

/** Set the blur sample count, clamped to the current ceiling. */
export function withMotionBlurSamples(
  settings: RecordingSettings,
  samples: number,
): RecordingSettings {
  return {
    ...settings,
    motionBlurSamples: clampInt(samples, 1, settings.physicsSteps),
  };
}

/**
 * Set the encoder quality.
 *
 * Validates against the preset list rather than trusting the caller, and leaves
 * the settings untouched on an unknown value. This is a UI boundary -- a
 * Tweakpane list hands back whatever is in its options map -- and the failure a
 * user would see from a bad value is an encoder that refuses to configure AFTER
 * they pressed Export, which is the worst moment to find out.
 */
export function withQuality(
  settings: RecordingSettings,
  quality: string,
): RecordingSettings {
  return (QUALITY_PRESETS as readonly string[]).includes(quality)
    ? { ...settings, quality: quality as QualityPreset }
    : settings;
}

/** Set the clip length in seconds. */
export function withDuration(
  settings: RecordingSettings,
  duration: number,
): RecordingSettings {
  return { ...settings, duration: clampInt(duration, MIN_DURATION, MAX_DURATION) };
}

/**
 * Fit a requested size inside the window, keeping it even and non-degenerate.
 *
 * THE ONE PLACE THE CEILING IS ENFORCED. The window is not a constant -- it
 * changes whenever the user drags the browser edge, and it can shrink BELOW a
 * size that was legal when it was chosen. Every read of the resolution therefore
 * goes through this rather than trusting the stored value, which is what keeps
 * "the crop box is inside the window" true at every instant rather than only at
 * the instant a slider moved.
 *
 * The floor wins over the ceiling when they conflict: a window narrower than
 * `MIN_RECORDING_DIM` would otherwise produce a zero or negative dimension, and
 * a crop box slightly larger than a tiny window is a cosmetic problem where an
 * invalid texture size is a crash.
 */
export function clampResolution(
  requested: Resolution,
  windowSize: readonly [number, number],
): Resolution {
  const [maxW, maxH] = windowSize;
  return {
    width: evenDim(Math.min(requested.width, Math.max(MIN_RECORDING_DIM, maxW))),
    height: evenDim(Math.min(requested.height, Math.max(MIN_RECORDING_DIM, maxH))),
  };
}

/** Set the recording width, clamped to the window. */
export function withWidth(
  settings: RecordingSettings,
  width: number,
  windowSize: readonly [number, number],
): RecordingSettings {
  return {
    ...settings,
    resolution: clampResolution(
      { width, height: settings.resolution.height },
      windowSize,
    ),
  };
}

/** Set the recording height, clamped to the window. */
export function withHeight(
  settings: RecordingSettings,
  height: number,
  windowSize: readonly [number, number],
): RecordingSettings {
  return {
    ...settings,
    resolution: clampResolution(
      { width: settings.resolution.width, height },
      windowSize,
    ),
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Where recording settings live. Namespaced like `preferences.ts`'s key, and
 * SEPARATE from it on purpose.
 *
 * The file header explains why these are not `Preferences` fields: the whole
 * recording feature is lazily loaded, and folding them into the shared record
 * would have code that runs every session reading state for a tab most sessions
 * never open. That argument is about the in-memory record, and it survives
 * persistence -- a second `localStorage` entry is read only by the module that
 * owns it, whereas a wider `Preferences` would be read by everyone.
 *
 * The user-visible contract is nonetheless the SAME as the preferences one:
 * these are editor settings, they follow you across reloads, and they are never
 * part of a saved config. `settingsSection.ts`'s tab tooltip already promises
 * exactly that ("Persistent; not saved/loaded with projects or checkpoints"),
 * which before this was a promise the code did not keep.
 */
export const RECORDING_STORAGE_KEY = 'fluoddity.recording';

/**
 * The `localStorage`-shaped slice this module needs.
 *
 * Injectable for the reason `PreferenceStorage` is: `recordingSettings.test.ts`
 * runs under `node --test`, where there is no `localStorage` at all -- and the
 * "storage throws" path is worth testing rather than merely asserting.
 */
export interface RecordingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The browser's `localStorage`, or `null` where there is none.
 *
 * MERELY TOUCHING `localStorage` CAN THROW -- a sandboxed iframe raises a
 * SecurityError on property access, before any method is called. Hence the
 * try/catch around the read itself rather than around a later `getItem`.
 */
export function browserRecordingStorage(): RecordingStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * A finite whole number within `[min, max]`, or `null` if `value` is not one.
 *
 * The validating half of `clampInt`: that one is for values the UI produced and
 * coerces whatever it is handed, this one is for values that came back out of
 * `localStorage` as untyped JSON a user can hand-edit. Rejecting rather than
 * clamping is what lets `loadRecordingSettings` keep the DEFAULT for a bad key
 * instead of silently substituting a bound -- a hand-edited `"duration": "long"`
 * should restore 5 seconds, not become 1.
 */
function validInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const whole = Math.trunc(value);
  return whole >= min && whole <= max ? whole : null;
}

/**
 * Read stored recording settings, falling back to the defaults.
 *
 * NEVER THROWS, which is `loadPreferences`'s contract and matters here for the
 * same reason: a corrupt entry in `localStorage` outlives a page reload, so an
 * exception would make the recording tab permanently unopenable until the user
 * cleared site data by hand.
 *
 * ## The invariants are re-established, not trusted
 *
 * Everything here arrives as untyped JSON, so this is a BOUNDARY and the two
 * real rules in this file are re-applied rather than assumed:
 *
 *   - `motionBlurSamples <= physicsSteps`. Stored separately, so a hand-edited
 *     (or downgraded) record can hold a pair that violates it. `clampInt`
 *     against the loaded rate restores it -- the same guard `withPhysicsStepsRaw`
 *     applies, for the same reason.
 *   - The resolution is NOT clamped to the window here. It cannot be: this is a
 *     pure leaf with no window to read, and `clampResolution` is applied at
 *     every use site anyway. That is what makes the full-frame sentinel below
 *     survive a round trip.
 *
 * Unknown keys are dropped, so a downgrade survives a newer version's record --
 * the reason `loadPreferences` filters against its known field set.
 */
export function loadRecordingSettings(
  storage: RecordingStorage | null = browserRecordingStorage(),
): RecordingSettings {
  if (storage === null) return DEFAULT_RECORDING_SETTINGS;

  let raw: string | null;
  try {
    raw = storage.getItem(RECORDING_STORAGE_KEY);
  } catch (e) {
    console.warn(`Could not read recording settings (${String(e)}); using defaults`);
    return DEFAULT_RECORDING_SETTINGS;
  }
  if (raw === null) return DEFAULT_RECORDING_SETTINGS;

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.warn(`Could not parse recording settings (${String(e)}); using defaults`);
    return DEFAULT_RECORDING_SETTINGS;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return DEFAULT_RECORDING_SETTINGS;
  }
  const stored = data as Record<string, unknown>;

  const duration =
    validInt(stored['duration'], MIN_DURATION, MAX_DURATION)
    ?? DEFAULT_RECORDING_SETTINGS.duration;

  const quality = (QUALITY_PRESETS as readonly string[]).includes(
    stored['quality'] as string,
  )
    ? (stored['quality'] as QualityPreset)
    : DEFAULT_RECORDING_SETTINGS.quality;

  const physicsSteps =
    validInt(stored['physicsSteps'], MIN_PHYSICS_STEPS, MAX_PHYSICS_STEPS)
    ?? DEFAULT_RECORDING_SETTINGS.physicsSteps;

  // Against the rate just loaded, not against the stored one -- see the header.
  // A rejected `physicsSteps` with an accepted sample count must not leave the
  // pair inconsistent.
  const samples = validInt(stored['motionBlurSamples'], 1, MAX_PHYSICS_STEPS);
  const motionBlurSamples =
    samples === null
      // No usable stored value: pin to the ceiling, which is both the default's
      // posture and what an offline render wants. See `DEFAULT_RECORDING_SETTINGS`.
      ? physicsSteps
      : Math.min(samples, physicsSteps);

  // Each dimension independently: a record with a good width and a corrupt
  // height should keep the width. `MIN_RECORDING_DIM` is the floor and the
  // sentinel is the ceiling, so a stored full-frame value survives verbatim.
  const res = stored['resolution'];
  const storedRes =
    typeof res === 'object' && res !== null && !Array.isArray(res)
      ? (res as Record<string, unknown>)
      : {};
  const resolution: Resolution = {
    width:
      validInt(storedRes['width'], MIN_RECORDING_DIM, FULL_FRAME)
      ?? DEFAULT_RECORDING_SETTINGS.resolution.width,
    height:
      validInt(storedRes['height'], MIN_RECORDING_DIM, FULL_FRAME)
      ?? DEFAULT_RECORDING_SETTINGS.resolution.height,
  };

  return Object.freeze({
    resolution,
    duration,
    quality,
    physicsSteps,
    motionBlurSamples,
  });
}

/**
 * Write recording settings. Failure is reported, never thrown.
 *
 * `setItem` throws on a full or disabled store (Safari private mode being the
 * usual case), and losing the ability to PERSIST a setting must not lose the
 * ability to SET one -- the in-memory value has already been adopted by the
 * time this is called.
 */
export function saveRecordingSettings(
  settings: RecordingSettings,
  storage: RecordingStorage | null = browserRecordingStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(RECORDING_STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn(`Could not write recording settings: ${String(e)}`);
  }
}

/**
 * Whether the Recording Controls tab is shown -- Share > Export Video's tick.
 *
 * ## Why a second key rather than a sixth field
 *
 * It is not a `RecordingSettings` field and must not become one. That record is
 * what gets handed WHOLE to the recorder (`recordingSection.ts`'s header calls
 * that the narrow interface, and it is), and whether a panel tab is on screen is
 * nothing the encoder has any business receiving. Keeping them separate also
 * means the two can be read independently: `Panel` needs this flag at
 * construction, before any recording tab or its settings exist.
 *
 * It lives in this file anyway, rather than in `panel.ts`, so that all the
 * recording feature's persistence -- its key names and its never-throws
 * contract -- sits in one place and is testable under `node --test`.
 */
export const EXPORT_SHOWN_STORAGE_KEY = 'fluoddity.recording.shown';

/**
 * Whether the recording tab was showing when the user last left.
 *
 * DEFAULTS TO FALSE on anything unexpected -- absent, unparseable, or a
 * non-boolean. False is the state a first-run user gets and the conservative
 * answer: the cost of wrongly returning false is a menu item to re-tick, while
 * wrongly returning true puts a tab in front of someone who never asked for it.
 *
 * Never throws, for `loadRecordingSettings`'s reason.
 */
export function loadExportVideoShown(
  storage: RecordingStorage | null = browserRecordingStorage(),
): boolean {
  if (storage === null) return false;
  try {
    return storage.getItem(EXPORT_SHOWN_STORAGE_KEY) === 'true';
  } catch (e) {
    console.warn(`Could not read recording visibility (${String(e)}); hiding`);
    return false;
  }
}

/** Store the tab's visibility. Failure is reported, never thrown. */
export function saveExportVideoShown(
  shown: boolean,
  storage: RecordingStorage | null = browserRecordingStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(EXPORT_SHOWN_STORAGE_KEY, shown ? 'true' : 'false');
  } catch (e) {
    console.warn(`Could not write recording visibility: ${String(e)}`);
  }
}

/**
 * The crop box in pixels: where the recorded rectangle sits within the window.
 *
 * **CENTRED**, as specified, and the offset is floored to a whole pixel. A
 * half-pixel offset would make the recording sample between texels and blur
 * every exported frame very slightly -- invisible in a still, and exactly the
 * kind of softness that is maddening to track down in a finished video.
 *
 * Returned in PIXELS rather than uv because both consumers want pixels: the
 * overlay draws it, and the capture pass converts it once. Doing the division in
 * two places is how the box and the pixels it claims to contain drift apart.
 */
export interface CropRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function cropRect(
  resolution: Resolution,
  windowSize: readonly [number, number],
): CropRect {
  const { width, height } = clampResolution(resolution, windowSize);
  return {
    x: Math.floor((windowSize[0] - width) / 2),
    y: Math.floor((windowSize[1] - height) / 2),
    width,
    height,
  };
}

/**
 * True when the crop box covers the whole window, so no overlay is needed.
 *
 * Takes a `Resolution` rather than the whole settings record, because that is
 * all it reads -- and because the two callers that matter have only that: the
 * Orchestrator's crop preview is a bare size the user is dragging, with no
 * duration or physics rate attached to it.
 */
export function isFullFrame(
  resolution: Resolution,
  windowSize: readonly [number, number],
): boolean {
  const rect = cropRect(resolution, windowSize);
  // Within one pixel: `evenDim` rounds down, so an odd-width window can never be
  // matched exactly and a strict test would dim a one-pixel border forever.
  return windowSize[0] - rect.width <= 1 && windowSize[1] - rect.height <= 1;
}
