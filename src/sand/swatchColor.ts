/**
 * A colour per swatch, for the Color By Swatch render mode.
 *
 * ## What this is and is not
 *
 * A DISPLAY property of a palette slot: "particles painted from swatch 7 render
 * pink". It is not a simulation input -- nothing in `entityUpdate.wgsl` reads
 * it, no force depends on it, and changing it cannot alter where a particle
 * goes. That is what lets it be edited while paused and take effect on the next
 * rendered frame rather than on the next physics step.
 *
 * ## WHY HSV AND NOT RGB
 *
 * The renderer's other two colour modes both produce a HUE and hand it to
 * `hsv2rgb` with saturation and value fixed (`camBrush.wgsl`). Storing a swatch
 * colour as HSV puts it in the same space, so Color By Swatch is the same final
 * expression with the numbers coming from a table instead of from a signal --
 * rather than a second, parallel colour path that could drift from the first.
 *
 * It also gives saturation directly, which was the explicit ask: the other two
 * modes pin saturation at 0.8, and a swatch colour that can be desaturated
 * toward white is something neither of them can express.
 *
 * VALUE IS NOT STORED. The particle camera fixes it at 1.0 and modulates
 * brightness through the gaussian kernel and `PARTICLE_ALPHA` instead, so a
 * per-swatch value would fight the accumulator's exposure rather than dim one
 * material -- the thing a user would reach for it expecting. Brightness stays a
 * property of the frame, which is where the assembler already owns it.
 *
 * ## A LEAF
 *
 * Imports nothing. The format's tolerances are testable under `node --test`,
 * which is the same argument `worldFormat.ts` and `tool.ts` make.
 */

/**
 * One swatch's colour, as hue and saturation.
 *
 * Both 0..1. Hue is periodic, so 0 and 1 are the same red; saturation runs from
 * white at 0 to fully saturated at 1.
 */
export interface SwatchColor {
  readonly hue: number;
  readonly saturation: number;
}

/**
 * The saturation the other two colour modes pin, and therefore the default.
 *
 * `camBrush.wgsl` writes `0.8 * wash` for Behavior and Cohort. A new swatch
 * matching that is what makes switching INTO Color By Swatch a change of which
 * hues appear rather than a change of how saturated the world suddenly is.
 */
export const DEFAULT_SATURATION = 0.8;

/**
 * How far apart consecutive swatches land on the hue wheel, by default.
 *
 * The golden-angle conjugate. Successive multiples of it never revisit a hue
 * until the wheel is densely covered, so the first handful of swatches come out
 * maximally distinct and the fortieth is still distinguishable from its
 * neighbours -- which an even `i / SLOT_COUNT` spacing does not achieve (there,
 * adjacent swatches differ by 1/40th of a turn and read as the same colour).
 *
 * These are only DEFAULTS. Every world hand-authors its palette from here on,
 * and the picker overwrites whatever this produced.
 */
const GOLDEN_RATIO_CONJUGATE = 0.618_033_988_749_895;

/** The colour a swatch starts with, before anyone picks one. */
export function defaultSwatchColor(slot: number): SwatchColor {
  return {
    // `% 1` rather than `fract`: slot is a non-negative integer, so the two
    // agree, and this needs no helper.
    hue: (slot * GOLDEN_RATIO_CONJUGATE) % 1,
    saturation: DEFAULT_SATURATION,
  };
}

/** A full palette of defaults, one per slot. */
export function defaultSwatchColors(count: number): SwatchColor[] {
  return Array.from({ length: Math.max(0, Math.trunc(count)) }, (_, slot) =>
    defaultSwatchColor(slot),
  );
}

/**
 * Coerce a stored value into a colour, or null if it is not one.
 *
 * ## Tolerant about the WRAPPER, strict about the NUMBERS
 *
 * A missing or malformed entry returns null and the caller substitutes a
 * default -- one unreadable colour should not cost the user the other
 * thirty-nine, the stance `readWorld` takes on a malformed slot.
 *
 * But a PRESENT number that is not finite is rejected rather than clamped: a
 * NaN hue reaching the uniform renders the material black with no indication
 * why, which looks like the colour feature being broken rather than like a
 * malformed save. Out-of-range finite values ARE clamped, because those have an
 * obvious intended meaning (hue wraps, saturation pins) and rejecting them
 * would discard a hand-edited palette over an off-by-one.
 */
export function readSwatchColor(raw: unknown): SwatchColor | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const hue = o['hue'];
  const saturation = o['saturation'];
  if (typeof hue !== 'number' || !Number.isFinite(hue)) return null;
  if (typeof saturation !== 'number' || !Number.isFinite(saturation)) return null;
  return {
    // WRAPPED, not clamped. Hue is periodic, so 1.25 means the same colour as
    // 0.25 and clamping it to 1.0 would silently move it to red.
    hue: ((hue % 1) + 1) % 1,
    saturation: Math.max(0, Math.min(1, saturation)),
  };
}

/**
 * Hue and saturation as a `#rrggbb` string, for the DOM.
 *
 * ## The swatch button's tint, and why it is computed here
 *
 * The button and the particle must agree about what the colour is, so the
 * conversion lives beside the model rather than in the UI -- and this mirrors
 * `hsv2rgb` in `camBrush.wgsl` at value 1.0. The two are different languages
 * expressing the same function; the test pins them against each other.
 *
 * VALUE IS 1.0 here, matching the renderer. A tint darker than the particles it
 * describes would misreport the material.
 */
export function swatchColorToCss(color: SwatchColor): string {
  const [r, g, b] = hsvToRgb(color.hue, color.saturation, 1);
  const hex = (v: number): string =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * Parse a `#rrggbb` string back to hue and saturation.
 *
 * The inverse of `swatchColorToCss`, for `<input type="color">` -- which is the
 * only colour picker a browser offers without a dependency, and which speaks
 * hex exclusively.
 *
 * ## VALUE IS DISCARDED, deliberately
 *
 * The picker lets a user choose a dark colour, and there is no per-swatch value
 * to store it in (see the header). Rather than silently ignore the choice, the
 * hue and saturation are kept and the value is dropped -- so picking a dark red
 * yields a bright red rather than nothing at all. The picker is then refreshed
 * from the stored colour, which shows the user what was actually kept.
 *
 * Returns null for anything that is not a six-digit hex colour.
 */
export function swatchColorFromCss(css: string): SwatchColor | null {
  const match = /^#([0-9a-f]{6})$/i.exec(css.trim());
  if (match === null) return null;
  const n = Number.parseInt(match[1] as string, 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const span = max - min;

  // GREY HAS NO HUE. Every hue is equally correct at zero saturation, so the
  // stored one is kept by the caller rather than being reset to red -- this
  // returns 0 and the caller decides. Saturation 0 is the meaningful half.
  if (span === 0) return { hue: 0, saturation: 0 };

  let hue: number;
  if (max === r) hue = ((g - b) / span) % 6;
  else if (max === g) hue = (b - r) / span + 2;
  else hue = (r - g) / span + 4;
  hue /= 6;
  if (hue < 0) hue += 1;

  // Saturation against the MAX, which is the V in HSV -- so a dark saturated
  // red reads as fully saturated rather than as dim, which is what makes
  // discarding the value non-destructive to the hue/saturation pair.
  return { hue, saturation: span / max };
}

/**
 * HSV to RGB, each 0..1.
 *
 * A transcription of `hsv2rgb` in `camBrush.wgsl` (which is itself the standard
 * one-liner the GLSL used). Kept in step with it by `swatchColor.test.ts`, which
 * evaluates both forms across the wheel -- the shader cannot be run under
 * `node --test`, so the test pins this against the same algebra rather than
 * against the GPU.
 */
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number): number => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(Math.min(k, 4 - k), 1));
  };
  return [f(5), f(3), f(1)];
}
