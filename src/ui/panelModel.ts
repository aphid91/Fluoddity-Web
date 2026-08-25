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
 * from the Simulation and View menus, the tool from Editor > Tools and the
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
  // A PLACEHOLDER, replaced during the build: `projectSection.ts` retitles this
  // folder to `Project: <name>` and keeps it current, because the name changes
  // under the panel and a static title cannot follow it. What is here is only
  // what shows in the instant between `addFolder` and the section building
  // into it.
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

/**
 * The left panel's sections, in display order.
 *
 * **EMPTY ON TOUCH, and that is the whole of the mobile panel change here.**
 * Two 320px columns need 640px plus gutters; a phone is 390px, so the two
 * overlapped almost completely -- the Project panel sat on top of the settings
 * panel and neither could be read. There is no arrangement of two side-by-side
 * columns that fits, so the touch layout has ONE panel and Project becomes a tab
 * inside it (see `sections/settingsSection.ts`).
 *
 * Returning an empty list rather than never calling this is deliberate: the
 * panel's build loop, refresh, dispose and hidden-state handling all stay
 * exactly as they are and simply iterate nothing. The alternative -- a `null`
 * side threaded through every one of those -- would put a branch in each.
 */
export function leftSections(mobile = false): readonly PanelSection[] {
  return mobile ? [] : LEFT_SECTIONS;
}

/**
 * The right panel's sections, in display order.
 *
 * The same single tabbed host either way. What CHANGES on touch is how many
 * tabs it builds -- Project joins the strip -- and that is decided inside the
 * section, where the tab list already lives, rather than here.
 */
export function rightSections(): readonly PanelSection[] {
  return RIGHT_SECTIONS;
}
