/**
 * The UI looks, as data.
 *
 * ## What a theme is allowed to change
 *
 * Colours, edges, corners and type -- nothing structural. `sand.html` styles
 * everything through custom properties (`--bg`, `--edge`, ...) and each look is
 * one block of values, so switching is an attribute swap on `<html>` with no
 * rebuild and no reflow logic.
 *
 * The layout itself (sidebar, band, swatch bar) is the layout bench's and is
 * the same under every look -- see `docs/comps/sandLayout.html`.
 *
 * ## Why this is a module and not three stylesheets
 *
 * The dev panel needs the list to build its dropdown, `sandUi` needs the id to
 * set the attribute, and the session needs it to persist a choice. One exported
 * array is the only shape where those three cannot disagree about which looks
 * exist.
 */

export interface SandTheme {
  /** Stable id -- stored in the session and set as `data-theme`. */
  readonly id: string;
  /** What the dropdown shows. */
  readonly label: string;
  /** One line on what the look is going for, for the dropdown's tooltip. */
  readonly note: string;
}

/**
 * The looks, in the order the dropdown lists them.
 *
 * `darkroom` is first and is the default: it is the look the layout bench was
 * tuned in.
 */
export const THEMES: readonly SandTheme[] = [
  {
    id: 'darkroom',
    label: 'Darkroom',
    note: 'Near-black ground, cool neutrals, a single amber accent. Photo-software calm.',
  },
  {
    id: 'system7',
    label: 'System 7',
    note: '1-bit monochrome, hard square edges, inverted selection. The literal MacPaint reading.',
  },
  {
    id: 'blueprint',
    label: 'Blueprint',
    note: 'Indigo drafting paper, cyan hairlines, monospace labels.',
  },
];

/** The look a fresh session opens with. */
export const DEFAULT_THEME = THEMES[0]!;

/** A stored id resolved to a look, falling back to the default. */
export function themeById(id: string): SandTheme {
  return THEMES.find((t) => t.id === id) ?? DEFAULT_THEME;
}
