/**
 * Number formatting and parsing for the settings controls.
 *
 * Two small pure things that both have a specific failure behind them.
 *
 * ## `decimalsFor`: why a bent slider needs an explicit readout
 *
 * With a curved slider the handle position no longer suggests the magnitude, so
 * the NUMBER has to be legible. imgui's default `%.3f` would render a whole
 * useful range of a rate like Hazard Rate as "0.000" -- the slider would appear
 * broken while working perfectly. The desktop derives a precision from the range
 * instead (`curved_slider.py:63-67`), and this is that formula.
 *
 * ## `parseInput`: why a typo must not reset the simulation
 *
 * INPUT controls are the DISRUPTIVE settings -- World Size and Canvas Aspect --
 * which reallocate GPU buffers and reset the simulation when they commit. So a
 * half-typed or malformed value must be rejected rather than clamped to
 * something plausible: the desktop restores the live value silently
 * (`settings_window.py:448-455`), because the alternative is a stray keystroke
 * costing the user their running simulation.
 */

import type { Setting } from './settingsSpec.ts';

/**
 * How many decimals to show for a range of width `span`.
 *
 * `max(3, min(8, round(-log10(span)) + 4))` -- enough decimals to distinguish
 * adjacent positions at the fine end, where a curve spends most of its travel.
 * Hazard Rate's span of 0.01 gives 6.
 */
export function decimalsFor(span: number): number {
  if (!(span > 0) || !Number.isFinite(span)) return 3;
  return Math.max(3, Math.min(8, Math.round(-Math.log10(span)) + 4));
}

/** The readout for a value, at a precision suited to its setting's range. */
export function formatValue(setting: Setting, value: number): string {
  return value.toFixed(decimalsFor(setting.hi - setting.lo));
}

/**
 * Parse an INPUT control's text, or `null` to reject it.
 *
 * `null` means "restore the live value and change nothing" -- see the file
 * header. A parsed value is clamped into the setting's bounds, which is a real
 * clamp rather than a rejection because a number outside the range is a
 * legitimate thing to type and the bound is what the simulation can take.
 *
 * `Number()` rather than `parseFloat`, deliberately: `parseFloat('4abc')` is 4,
 * which would accept a typo as if it were the number the user meant. `Number()`
 * rejects the whole string. The empty string is rejected explicitly because
 * `Number('')` is 0 -- and 0 is a plausible-looking World Size that would
 * rebuild the simulation at its minimum.
 */
export function parseInput(setting: Setting, text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(setting.lo, Math.min(setting.hi, parsed));
}

/**
 * The seed readout: four decimals, matching `settings_window.py:430`.
 *
 * The seed is an opaque selector into rule-variation space, so a specific value
 * is only ever worth READING -- to note it down or compare two -- never worth
 * typing. Four decimals is enough to tell two seeds apart at a glance.
 */
export function formatSeed(value: number): string {
  return value.toFixed(4);
}
