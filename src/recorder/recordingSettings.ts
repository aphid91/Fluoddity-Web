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

/** A resolution the exporter offers. Width and height in pixels. */
export interface Resolution {
  readonly label: string;
  readonly width: number;
  readonly height: number;
}

/**
 * The offered resolutions.
 *
 * 16:9 throughout, because that is what a video file is expected to be -- the
 * simulation's own canvas aspect is a separate quantity (`app/surface.ts`'s
 * three-aspect note) and letterboxing is how the two are reconciled, exactly as
 * on screen.
 *
 * Capped at 4K: `maxTextureDimension2D` is 8192 on essentially all WebGPU
 * hardware, but H.264 level limits and encoder memory bite well before that, and
 * an export that fails after twenty minutes of rendering is the worst possible
 * failure mode for this feature.
 */
export const RESOLUTIONS: readonly Resolution[] = Object.freeze([
  { label: '720p', width: 1280, height: 720 },
  { label: '1080p', width: 1920, height: 1080 },
  { label: '1440p', width: 2560, height: 1440 },
  { label: '4K', width: 3840, height: 2160 },
]);

/** Frames per second of the OUTPUT file. Not a rate the renderer must keep up with. */
export const RECORDING_FPS = 60;

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
  readonly resolution: Resolution;
  /** Clip length in seconds. Frame count is this times `RECORDING_FPS`. */
  readonly duration: number;
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
  resolution: RESOLUTIONS[1]!,
  duration: 5,
  physicsSteps: 60,
  motionBlurSamples: 60,
});

/** Total frames the export will produce. */
export function frameCount(settings: RecordingSettings): number {
  return Math.max(1, Math.round(settings.duration * RECORDING_FPS));
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

/** Set the clip length in seconds. */
export function withDuration(
  settings: RecordingSettings,
  duration: number,
): RecordingSettings {
  return { ...settings, duration: clampInt(duration, MIN_DURATION, MAX_DURATION) };
}

/**
 * Set the output resolution by label.
 *
 * By LABEL rather than by index, because the control that drives this is a
 * Tweakpane list whose options are built from `RESOLUTIONS` -- an index would
 * silently repoint at a different resolution if that array were ever reordered.
 * An unknown label leaves the settings alone rather than throwing: this is a UI
 * boundary, and the failure a user would see is a dropdown that does nothing,
 * not a crashed export.
 */
export function withResolution(
  settings: RecordingSettings,
  label: string,
): RecordingSettings {
  const found = RESOLUTIONS.find((r) => r.label === label);
  return found === undefined ? settings : { ...settings, resolution: found };
}
