/**
 * Which sections each panel shows, and in what order.
 *
 * ## Two panels, split by what the state IS
 *
 * `ARCHITECTURE.md`'s "Toolbar and the planned side-panel" named an endpoint the
 * desktop never reached: the active tool selecting which controls are visible,
 * hosted in a docked panel rather than in floating windows. This is that
 * endpoint, arrived at by a different route than "one panel" -- because the
 * controls turn out to divide on something more fundamental than the tool.
 *
 * **Project is a different KIND of state from the rest.** It is the config: the
 * thing you save, load and share. Preferences and Drawing Controls are how your
 * editor is set up, and loading someone else's config must not touch them
 * (`preferences_window.py:12-16`). That split already existed in the registry as
 * `source`; it is now also the split down the middle of the screen. Project on
 * the left, editor state on the right.
 *
 * The tool selection endpoint survives inside that: the right panel's two
 * sections became TABS rather than stacked folders, and the active tab follows
 * the tool. See `sections/settingsSection.ts`. It is a tab decision rather than
 * a section decision, which is why it is not made in this file -- there is no
 * `mode` parameter here any more, and nothing needs one.
 *
 * ## Transport and Debug are PARKED
 *
 * Not deleted: `transportSection.ts` and `debugSection.ts` are untouched, their
 * ids are still exported, `buildSection` still dispatches to them, and their
 * tests still run. They are simply not in either list today. Restoring one is a
 * single line here and nothing else.
 *
 * Everything Transport carried is reachable elsewhere -- Pause and the camera
 * from the Simulation and View menus, the tool from the Tools menu and the
 * `1`/`2`/`3` keys, and the active tool is displayed by the mutation overlay so
 * a modal tool is never invisible. Debug is a developer readout that the
 * `?debug` overlay also covers.
 */

/**
 * A panel section's stable identity.
 *
 * Used as the `data-section` attribute on the folder element, so `uiCheck.mjs`
 * can find a section without depending on its title or on Tweakpane's minified
 * class names.
 */
export const TRANSPORT = 'transport';
export const PROJECT = 'project';
export const PREFERENCES = 'preferences';
export const DRAWING = 'drawing';
export const DEBUG = 'debug';
/** The right panel's tabbed host. Owns PREFERENCES and DRAWING as its pages. */
export const SETTINGS = 'settings';

export type SectionId =
  | typeof TRANSPORT
  | typeof PROJECT
  | typeof PREFERENCES
  | typeof DRAWING
  | typeof DEBUG
  | typeof SETTINGS;

export interface PanelSection {
  readonly id: SectionId;
  /** The folder title. */
  readonly title: string;
  /** Whether the folder starts open. */
  readonly expanded: boolean;
}

/**
 * The left panel: the project.
 *
 * PARKED, and deliberately still written out:
 *   { id: TRANSPORT, title: 'Transport', expanded: true },
 */
const LEFT_SECTIONS: readonly PanelSection[] = [
  { id: PROJECT, title: 'Project', expanded: true },
];

/**
 * The right panel: editor state, behind two tabs.
 *
 * PARKED, and deliberately still written out:
 *   { id: DEBUG, title: 'Debug', expanded: false },
 */
const RIGHT_SECTIONS: readonly PanelSection[] = [
  { id: SETTINGS, title: 'Settings', expanded: true },
];

/** The left panel's sections, in display order. */
export function leftSections(): readonly PanelSection[] {
  return LEFT_SECTIONS;
}

/** The right panel's sections, in display order. */
export function rightSections(): readonly PanelSection[] {
  return RIGHT_SECTIONS;
}
