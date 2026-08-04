/**
 * The right-hand panel: Preferences and Drawing Controls, as two tabs.
 *
 * ## Why a hand-rolled strip and not `pane.addTab`
 *
 * Tweakpane has tabs, and they were the obvious first choice. Two things rule
 * them out: the active page can only be driven through the pages' `selected`
 * flags, which is awkward to reconcile with a tab that must also follow the
 * active TOOL, and the tab buttons carry minified class names with nowhere to
 * hang the `data-*` hooks `tools/uiCheck.mjs` selects on. Two buttons over two
 * folders whose `display` toggles is less machinery than working around either,
 * and it matches what `menuBar.ts` already does a few pixels away.
 *
 * ## The tabs follow the tool, but do not fight the user
 *
 * Entering a brush tool (Shove or Draw) from a non-brush tool brings Drawing
 * Controls forward; leaving for a non-brush tool brings Preferences back.
 * Switching BETWEEN the two brush tools changes nothing, because both want the
 * same tab and re-asserting it would undo a manual choice for no reason.
 *
 * **That decision is a TRANSITION, and it is made in `panel.ts`** -- this file
 * only exposes `setActiveTab`. The distinction matters: a level rule ("brush
 * tool implies Drawing tab") re-asserted every frame would make the tab buttons
 * dead while a brush tool is active, since every manual click would be undone
 * on the next frame. The user must always be able to click.
 */

import type { FolderApi } from 'tweakpane';
import type { Status } from '../../orchestrator/commands.ts';
import type { ControlBinding } from '../controls.ts';
import { type SectionContext, type SectionHandle } from './section.ts';
import { buildDrawingSection } from './drawingSection.ts';
import { buildPreferencesSection } from './preferencesSection.ts';

export const PREFS_TAB = 'preferences';
export const DRAWING_TAB = 'drawing';
export type SettingsTab = typeof PREFS_TAB | typeof DRAWING_TAB;

/** A settings section, plus the tab control the panel drives. */
export interface SettingsSectionHandle extends SectionHandle {
  readonly setActiveTab: (tab: SettingsTab) => void;
  readonly activeTab: () => SettingsTab;
}

export function buildSettingsSection(
  folder: FolderApi,
  status: Status,
  ctx: SectionContext,
  initialTab: SettingsTab,
): SettingsSectionHandle {
  // The host folder's own header goes too: the tab strip sits directly beneath
  // it and names both pages, so a "Settings" bar above them is a third label for
  // something already labelled twice -- and one the user could collapse, hiding
  // the tabs with no clue why.
  hideFolderTitle(folder);

  // Two sub-folders, built in tab order. Their TITLES are suppressed: the tab
  // button already names each one, and a folder header directly under its own
  // tab would say the same word twice and cost a row of vertical space.
  const prefsFolder = folder.addFolder({ title: 'Preferences', expanded: true });
  const drawingFolder = folder.addFolder({ title: 'Drawing Controls', expanded: true });
  hideFolderTitle(prefsFolder);
  hideFolderTitle(drawingFolder);

  (prefsFolder.element as HTMLElement).dataset['section'] = PREFS_TAB;
  (drawingFolder.element as HTMLElement).dataset['section'] = DRAWING_TAB;

  const prefs = buildPreferencesSection(prefsFolder, status, ctx);
  const drawing = buildDrawingSection(drawingFolder, status, ctx);

  // --- the strip ----------------------------------------------------------
  // Built after the folders (Tweakpane needs to own its own children) and then
  // moved to the front, so it renders above them.
  const strip = document.createElement('div');
  strip.style.cssText = STRIP_CSS;

  let active: SettingsTab = initialTab;

  const buttons = new Map<SettingsTab, HTMLButtonElement>();
  for (const [tab, title] of [
    [PREFS_TAB, 'Preferences'],
    [DRAWING_TAB, 'Drawing Controls'],
  ] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = title;
    button.dataset['tab'] = tab;
    button.addEventListener('click', () => {
      // A manual choice, and it stands until the next qualifying tool
      // transition. Nothing re-asserts a tab on a timer.
      setActiveTab(tab);
    });
    strip.append(button);
    buttons.set(tab, button);
  }

  // Insert the strip directly ABOVE the first sub-folder, rather than
  // prepending to a container guessed by position.
  //
  // `host.firstElementChild` was the obvious choice and is wrong: the folder's
  // first child is its own TITLE BUTTON, so prepending put the tab strip inside
  // a header that this function had just set to `display:none` -- the tabs
  // vanished completely, and the panel looked as if it had never had any.
  // Anchoring on the element we actually placed cannot drift that way.
  const prefsEl = prefsFolder.element as HTMLElement;
  prefsEl.parentElement?.insertBefore(strip, prefsEl);

  function setActiveTab(tab: SettingsTab): void {
    active = tab;
    (prefsFolder.element as HTMLElement).style.display = tab === PREFS_TAB ? '' : 'none';
    (drawingFolder.element as HTMLElement).style.display =
      tab === DRAWING_TAB ? '' : 'none';
    for (const [id, button] of buttons) {
      button.style.cssText = id === tab ? TAB_ACTIVE_CSS : TAB_IDLE_CSS;
    }
  }
  setActiveTab(active);

  return {
    // Both children's, concatenated. The panel resolves reveals across the
    // WHOLE registry rather than per folder, so a binding on the hidden tab
    // still has to be in this list -- it is hidden by its tab, not by its
    // reveal, and the two must not be confused.
    bindings: [...prefs.bindings, ...drawing.bindings] as readonly ControlBinding[],
    refresh: (s, input) => {
      // BOTH tabs, including the one nobody can see. Refreshing only the active
      // tab would mean switching to the other showed one frame of stale values,
      // and the cost is a handful of proxy writes.
      prefs.refresh(s, input);
      drawing.refresh(s, input);
    },
    setActiveTab,
    activeTab: () => active,
  };
}

/**
 * Suppress a folder's own title row.
 *
 * The tab button above it already names it. Tweakpane has no option for a
 * title-less folder, and `addFolder` with an empty title still renders the
 * clickable header (and its expand arrow), which would let a user collapse a
 * tab's entire contents with no way to tell why the panel went blank.
 *
 * **`:scope > button`, and NO deeper fallback.** A bare `querySelector('button')`
 * is a descendant search, so it finds the first button ANYWHERE inside -- a tab
 * button, or a section's own Clear Field button, depending on what has been
 * appended by the time this runs. A `:scope > * > button` fallback is no safer:
 * it reaches one level into the folder's CONTENTS and hides whatever button
 * happens to be first there.
 *
 * A folder's title is always its own direct child, so if that selector misses
 * there is nothing to hide and doing nothing is correct.
 */
function hideFolderTitle(folder: FolderApi): void {
  const title = (folder.element as HTMLElement).querySelector(':scope > button');
  if (title !== null) (title as HTMLElement).style.display = 'none';
}

// -- styling ----------------------------------------------------------------
// Mirrors `menuBar.ts`'s vocabulary, so the two strips read as one interface.

const STRIP_CSS =
  'display:flex;gap:2px;padding:6px 4px 2px 4px;' +
  'border-bottom:1px solid rgba(255,255,255,0.10);margin-bottom:4px;';

const TAB_BASE_CSS =
  'flex:1;border:0;border-radius:4px 4px 0 0;cursor:pointer;' +
  'font:11px system-ui,sans-serif;padding:6px 8px;white-space:nowrap;';

const TAB_IDLE_CSS = `${TAB_BASE_CSS}background:transparent;color:rgba(232,232,234,0.6);`;

const TAB_ACTIVE_CSS =
  `${TAB_BASE_CSS}background:rgba(255,255,255,0.10);color:#e8e8ea;` +
  'box-shadow:inset 0 -2px 0 #8ab4f8;';
