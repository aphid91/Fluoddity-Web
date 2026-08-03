/**
 * Slider arithmetic: curved travel, inverted display, and the gated off-zone.
 *
 * The port of `ui/gated_controls.py:49-95` and `settings_window.py:348-370`.
 * Pure functions of a `Setting` and a number, so `node --test` covers all of it
 * with no DOM -- which matters more here than anywhere else in the UI, because
 * **these functions decide what value a given slider position produces**, and
 * getting one wrong changes what every affected config means without changing
 * anything visible.
 *
 * ## Two mappings, and the rule that keeps them safe
 *
 * A stored value passes through up to two transforms on its way to a widget:
 *
 *     stored --[inverted]--> display --[curve]--> position   (0..1, what you drag)
 *     position --[curve]--> display --[inverted]--> stored
 *
 * **Only the POSITION curves, and only the DISPLAY inverts. The stored value
 * never does either.** What is dispatched, saved and shown in the readout is the
 * real number, so adding or retuning a curve cannot change what a config means
 * (`ARCHITECTURE.md`, "Settings, and the three kinds of state").
 *
 * The dangerous failure is applying one direction and not the other -- a slider
 * that reads inverted and writes uninverted silently rewrites the value every
 * time it is touched. `thinPanel.ts` avoided that by applying NEITHER, which was
 * the honest degradation for Step 7. Here both are applied, and
 * `gating.test.ts` asserts the round trip for every entry rather than for the
 * two that happen to use them today.
 *
 * ## Why `shown`/`stored` are two names for one function
 *
 * The inversion `(lo + hi) - value` is its own inverse. They are kept apart
 * because the call sites read as DIRECTIONS, and a later non-symmetric mapping
 * would only have to change one of them (`settings_window.py:362-370`).
 */

import { type Setting, GATED, GATED_INT } from './settingsSpec.ts';

/** True for a slider that hides itself behind a checkbox. */
export function isGated(setting: Setting): boolean {
  return setting.kind === GATED || setting.kind === GATED_INT;
}

/**
 * Where `value` sits along the slider's travel, as 0..1.
 *
 * **The position is clamped, not the value.** A config may legitimately hold a
 * value outside the slider's bounds -- the desktop types one with ctrl+click --
 * so the handle pins to the end while the readout still tells the truth
 * (`curved_slider.py:57-61`).
 */
export function position(setting: Setting, value: number): number {
  const lo = setting.lo;
  const span = setting.hi - setting.lo;
  // A degenerate registry entry would otherwise produce Infinity or NaN and a
  // slider that cannot be moved at all.
  if (span === 0) return 0;
  const norm = Math.min(1, Math.max(0, (value - lo) / span));
  return setting.curve === 1 ? norm : norm ** (1 / setting.curve);
}

/** Inverse of `position`: the value at 0..1 along the travel. */
export function valueAt(setting: Setting, pos: number): number {
  const lo = setting.lo;
  const span = setting.hi - setting.lo;
  const clamped = Math.min(1, Math.max(0, pos));
  return lo + span * (setting.curve === 1 ? clamped : clamped ** setting.curve);
}

/**
 * Stored value -> what the widget displays. Identity unless `inverted`.
 *
 * `inverted` settings are named for the opposite of what the simulation stores
 * (Trail Stiffness vs. trail diffusion), so the flip lives here and in `stored`
 * alone: everything downstream of the dispatch, and every saved config, still
 * speaks the stored quantity.
 */
export function shown(setting: Setting, value: number): number {
  if (!setting.inverted) return value;
  return setting.lo + setting.hi - value;
}

/** What the widget displays -> the value to store. Inverse of `shown`. */
export function stored(setting: Setting, value: number): number {
  return shown(setting, value);
}

/**
 * True if `value` is close enough to base to count as switched off.
 *
 * **THE OFF ZONE IS MEASURED IN SLIDER POSITION, NOT VALUE.** Hazard Rate is
 * cubed, so 0.01% along its bar is 1e-12 in value; a zone defined in value would
 * swallow half the visible slider. Position is what the user manipulates and
 * what "sitting at zero" means to the eye (`gated_controls.py:36-39`).
 *
 * Integers compare exactly -- there is no "nearly 1 sample".
 */
export function isOff(setting: Setting, value: number): boolean {
  if (setting.kind === GATED_INT) {
    return Math.round(value) === Math.round(setting.gateBase);
  }
  const offset = Math.abs(
    position(setting, value) - position(setting, setting.gateBase),
  );
  return offset <= setting.gateEpsilon;
}

/**
 * The value ticking the checkbox sets: one epsilon of position off base.
 *
 * **Must land strictly outside the off zone** (`isOff` tests `<=`), or the
 * control would re-derive as off in the same frame and never open. Steps away
 * from whichever end the base sits at, so a base of `hi` steps DOWN -- which is
 * exactly the Trail Stiffness case, whose `gateBase` is 1.0
 * (`gated_controls.py:84-95`).
 */
export function nudged(setting: Setting): number {
  if (setting.kind === GATED_INT) {
    return Math.trunc(setting.gateBase) + 1;
  }
  const basePos = position(setting, setting.gateBase);
  const step = setting.gateEpsilon * 2;
  return valueAt(setting, basePos + (basePos <= 0.5 ? step : -step));
}
