/**
 * The four UI comps, as data.
 *
 * ## What a theme is allowed to change
 *
 * Three of them are PURELY VISUAL: same DOM, same layout regions, different
 * tokens. `sand.html` styles everything through custom properties
 * (`--sand-bg`, `--sand-edge`, ...) and each comp is one block of values, so
 * switching is a class swap on `<html>` with no rebuild and no reflow logic.
 *
 * The fourth, `compact`, moves the furniture: one unified bottom dock instead of
 * a left rail plus a bottom tray. That is why `layout` exists as a field rather
 * than being inferred from the id -- the stylesheet keys its structural rules on
 * `[data-layout='dock']`, and a future comp can adopt either arrangement without
 * the CSS having to learn its name.
 *
 * ## Why this is a module and not four stylesheets
 *
 * The dev panel needs the list to build its dropdown, `sandUi` needs the id to
 * set the attribute, and the session needs it to persist a choice. One exported
 * array is the only shape where those three cannot disagree about which comps
 * exist.
 */

/** Which arrangement of regions a comp uses. See the header. */
export const LAYOUT_RAIL = 'rail';
export const LAYOUT_DOCK = 'dock';
export type SandLayout = typeof LAYOUT_RAIL | typeof LAYOUT_DOCK;

export interface SandTheme {
  /** Stable id -- stored in the session and set as `data-theme`. */
  readonly id: string;
  /** What the dropdown shows. */
  readonly label: string;
  /** One line on what the comp is going for, for the dropdown's tooltip. */
  readonly note: string;
  readonly layout: SandLayout;
}

/**
 * The comps, in the order the dropdown lists them.
 *
 * `system7` is first and is the default: it is the most literal reading of the
 * MacPaint reference the layout is drawn from, so it is the one the other three
 * are departures FROM.
 */
export const THEMES: readonly SandTheme[] = [
  {
    id: 'system7',
    label: 'System 7',
    note: '1-bit monochrome, hard square edges, inverted selection. The literal MacPaint reading.',
    layout: LAYOUT_RAIL,
  },
  {
    id: 'darkroom',
    label: 'Darkroom',
    note: 'Near-black ground, cool neutrals, a single amber accent. Photo-software calm.',
    layout: LAYOUT_RAIL,
  },
  {
    id: 'blueprint',
    label: 'Blueprint',
    note: 'Indigo drafting paper, cyan hairlines, monospace labels.',
    layout: LAYOUT_RAIL,
  },
  {
    id: 'compact',
    label: 'Compact dock',
    note: 'Everything in one bottom dock; the canvas takes the whole remaining area.',
    layout: LAYOUT_DOCK,
  },
];

/** The comp a fresh session opens with. */
export const DEFAULT_THEME = THEMES[0]!;

/** A stored id resolved to a comp, falling back to the default. */
export function themeById(id: string): SandTheme {
  return THEMES.find((t) => t.id === id) ?? DEFAULT_THEME;
}
