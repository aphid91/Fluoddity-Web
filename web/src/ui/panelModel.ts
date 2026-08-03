/**
 * Which sections the panel shows, and in what order.
 *
 * ## Why this is a module and not four lines inside `panel.ts`
 *
 * `ARCHITECTURE.md`'s "Toolbar and the planned side-panel" names an endpoint the
 * desktop has not reached: **the active tool selects which controls are
 * visible** -- physics sliders while selecting, drawing controls while drawing
 * -- all hosted in one docked side-panel rather than in separate floating
 * windows. It also says what the migration should look like: "keep each
 * `_*_window()` body as a panel-*section* function, and have the panel call the
 * sections the current tool asks for."
 *
 * The desktop cannot do that cheaply because five independent window mixins each
 * own their own `imgui.begin`/`end`. The port is writing those bodies for the
 * first time, so it can be shaped for the endpoint from the start at no cost --
 * and that is exactly what this file is. `sectionsFor` is the decision, as data,
 * with no Tweakpane and no DOM anywhere near it.
 *
 * **Today it ignores `mode` and returns everything**, which is the desktop's
 * current behaviour and therefore the correct starting point: the tool-selection
 * endpoint is a UI-design decision that has not been taken, and inventing one
 * here would be inventing product. When it is taken, this one function changes
 * and `panel.ts` does not -- which is the whole reason the `mode` parameter is
 * already in the signature rather than being added later.
 *
 * `panelModel.test.ts` pins the current behaviour, so making that change is a
 * deliberate edit to a test rather than a silent drift.
 */

import { type MouseMode } from '../orchestrator/commands.ts';

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

export type SectionId =
  | typeof TRANSPORT
  | typeof PROJECT
  | typeof PREFERENCES
  | typeof DRAWING
  | typeof DEBUG;

export interface PanelSection {
  readonly id: SectionId;
  /** The folder title. */
  readonly title: string;
  /** Whether the folder starts open. */
  readonly expanded: boolean;
}

/**
 * Every section, in display order.
 *
 * The order mirrors `ui.py:_build_ui`'s window order -- toolbar/transport first,
 * then the Project window, then Preferences, then Drawing Controls, then Debug.
 * Debug is collapsed because it is a developer tool; Drawing is collapsed
 * because it only matters while the Draw or Shove tool is active, which is the
 * seed of the tool-selection endpoint above.
 */
const ALL_SECTIONS: readonly PanelSection[] = [
  { id: TRANSPORT, title: 'Transport', expanded: true },
  { id: PROJECT, title: 'Project', expanded: true },
  { id: PREFERENCES, title: 'Preferences', expanded: false },
  { id: DRAWING, title: 'Drawing', expanded: false },
  { id: DEBUG, title: 'Debug', expanded: false },
];

/**
 * The sections to build for the current tool and tier.
 *
 * `mode` is accepted and deliberately unused -- see the file header. `tier` is
 * likewise not a filter here: a section whose every control is Advanced empties
 * itself through `grouped()`, which already omits empty groups, so the tier
 * decision belongs to the registry rather than to this list.
 */
export function sectionsFor(
  _mode: MouseMode,
  _tierAdvanced: boolean,
): readonly PanelSection[] {
  return ALL_SECTIONS;
}
