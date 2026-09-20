/**
 * How the particle camera assigns hue. One of three, and exactly one.
 *
 * ## WHY A MODE AND NOT TWO CHECKBOXES
 *
 * Color By Cohort was already a boolean, and Color By Swatch arrived as a
 * second one. Two independent checkboxes have four states, of which one --
 * both on -- has no meaning: a particle's hue comes from one source, so the
 * renderer would need a precedence rule, the panel would need to explain it,
 * and the user would have a combination that silently behaves as one of the
 * other three.
 *
 * An enumerated mode has exactly the three states that mean something, and the
 * dropdown says so. The renderer then has no precedence to encode: it switches
 * on one value.
 *
 * ## The three
 *
 *   behavior   hue from the black box's raw output, the original look. The
 *              particle's colour is a readout of what its rule is computing,
 *              which is what makes two materials under the same rule look alike
 *              and a mutation visible as a colour shift.
 *   cohort     hue from the particle's cohort index, for telling the
 *              sub-populations of one config apart.
 *   swatch     hue and saturation from the palette slot the particle was
 *              painted from, for telling MATERIALS apart -- which is what a
 *              sand world is actually made of, and what the other two modes
 *              cannot show.
 *
 * ## A LEAF
 *
 * Imports nothing, so the mapping to the GPU's integer is testable under
 * `node --test`.
 */

export const COLOR_BY_BEHAVIOR = 'behavior';
export const COLOR_BY_COHORT = 'cohort';
export const COLOR_BY_SWATCH = 'swatch';

export type ColorMode =
  | typeof COLOR_BY_BEHAVIOR
  | typeof COLOR_BY_COHORT
  | typeof COLOR_BY_SWATCH;

/** The modes, in the order the dropdown lists them. */
export const COLOR_MODES = [
  COLOR_BY_BEHAVIOR,
  COLOR_BY_COHORT,
  COLOR_BY_SWATCH,
] as const satisfies readonly ColorMode[];

/** What a fresh session renders with: the original look. */
export const DEFAULT_COLOR_MODE: ColorMode = COLOR_BY_BEHAVIOR;

/** Display names for the dropdown. */
export const COLOR_MODE_LABELS: Readonly<Record<ColorMode, string>> = {
  [COLOR_BY_BEHAVIOR]: 'Behavior',
  [COLOR_BY_COHORT]: 'Cohort',
  [COLOR_BY_SWATCH]: 'Swatch',
};

/**
 * The integer the shader switches on.
 *
 * ## The values are load-bearing and must match `camBrush.wgsl`
 *
 * `MODE_BEHAVIOR`, `MODE_COHORT` and `MODE_SWATCH` are declared there as
 * constants with these values, and `shaders.test.ts` asserts the two agree --
 * drifting them would silently render every particle in the wrong mode, which
 * looks like a colour bug rather than like a protocol mismatch.
 *
 * ZERO IS BEHAVIOR deliberately: a uniform buffer that failed to be written
 * reads as zeroes, so the failure mode is "the original look" rather than an
 * unrecognised mode the shader has to have an opinion about.
 */
export function colorModeIndex(mode: ColorMode): number {
  if (mode === COLOR_BY_COHORT) return 1;
  if (mode === COLOR_BY_SWATCH) return 2;
  return 0;
}

/** A stored mode name, or the default for anything unrecognised. */
export function asColorMode(raw: unknown): ColorMode {
  return typeof raw === 'string' && (COLOR_MODES as readonly string[]).includes(raw)
    ? (raw as ColorMode)
    : DEFAULT_COLOR_MODE;
}
