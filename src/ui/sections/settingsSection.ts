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
import { buildProjectSection } from './projectSection.ts';
import {
  type RecordingSectionHandle,
  type RecordingSectionOptions,
  buildRecordingSection,
} from './recordingSection.ts';
import type { RecordingSettings } from '../../recorder/recordingSettings.ts';
import {
  type LinkSectionHandle,
  type LinkSectionOptions,
  buildLinkSection,
} from './linkSection.ts';
import type { LinkSettings } from '../../config/urlOptions.ts';

/**
 * The Project tab. **TOUCH ONLY, and first in the strip when it exists.**
 *
 * On the desktop Project is a PANEL, not a tab -- it lives in its own column on
 * the left, because it is a different kind of state from the other three (see
 * `panelModel.ts`) and the split down the middle of the screen says so. A phone
 * has no middle to split: two 320px columns do not fit in 390px, so the touch
 * layout drops the left panel and Project joins this strip instead.
 *
 * FIRST because it is what the other three are settings ABOUT -- the project is
 * the work, and the rest is how the editor is arranged around it. It is also
 * the tab a user opens the panel to reach most often.
 */
export const PROJECT_TAB = 'project';
export const PREFS_TAB = 'preferences';
export const DRAWING_TAB = 'drawing';
export const RECORDING_TAB = 'recording';
/**
 * Project Link Settings. **A SISTER TO RECORDING CONTROLS**, and built on the
 * same terms: toggled from the Share menu, absent rather than hidden when it is
 * not wanted, and holding editor state that never travels with a project.
 */
export const LINK_TAB = 'link';
export type SettingsTab =
  | typeof PROJECT_TAB
  | typeof PREFS_TAB
  | typeof DRAWING_TAB
  | typeof RECORDING_TAB
  | typeof LINK_TAB;

/**
 * What each tab is FOR, shown on hovering its button.
 *
 * All three make the same point from different angles, and it is the point
 * `panelModel.ts` splits the screen on: none of this travels with a project.
 * The Project panel holds what Save, share links and checkpoints capture; these
 * three hold how your editor is set up, which persists across sessions and is
 * deliberately untouched by loading someone else's work.
 */
/**
 * What each tab is really called, for its tooltip.
 *
 * The strip's buttons are abbreviated to fit 320px without overflowing (see
 * where they are built); this is where the unabbreviated name lives, so the
 * shortening costs the user nothing. The Share menu rows use these words too,
 * which is what lets someone who ticked "Video Export Controls" recognise the
 * "Video" tab it produced.
 */
const TAB_FULL_NAME: Record<SettingsTab, string> = {
  [PROJECT_TAB]: 'Project',
  [PREFS_TAB]: 'Preferences',
  [DRAWING_TAB]: 'Drawing Controls',
  [RECORDING_TAB]: 'Recording Controls',
  [LINK_TAB]: 'Project Link Settings',
};

const TAB_HELP: Record<SettingsTab, string> = {
  // THE ODD ONE OUT, and its help says so: everything on this page DOES travel
  // with the project, which is exactly what the other three promise not to do.
  [PROJECT_TAB]:
    'The project itself: what Save, share links and checkpoints capture. ' +
    'Unlike the other tabs, everything here travels with the project.',
  [PREFS_TAB]:
    'Editor Settings: automatically tracked between sessions, but not ' +
    'saved/loaded with projects, share-urls or checkpoints',
  [DRAWING_TAB]:
    'Editor settings for shove and barrier brushes. Persistent; not ' +
    'saved/loaded with projects or checkpoints.',
  [RECORDING_TAB]:
    'Editor settings for video recording and export. Persistent; not ' +
    'saved/loaded with projects or checkpoints.',
  // THE ODD ONE OUT IN THE OTHER DIRECTION from Project: nothing here travels
  // with the project OR stays on this machine -- it describes what a link hands
  // to somebody else.
  [LINK_TAB]:
    'What a copied share link asks the recipient to adopt. Persistent; not ' +
    'saved/loaded with projects or checkpoints.',
};

/** A settings section, plus the tab control the panel drives. */
export interface SettingsSectionHandle extends SectionHandle {
  readonly setActiveTab: (tab: SettingsTab) => void;
  readonly activeTab: () => SettingsTab;
  /** The recording tab's settings, or null while that tab does not exist. */
  readonly recordingSettings: () => RecordingSettings | null;
  /** The link tab's choices, or null while that tab does not exist. */
  readonly linkSettings: () => LinkSettings | null;
}

export function buildSettingsSection(
  folder: FolderApi,
  status: Status,
  ctx: SectionContext,
  initialTab: SettingsTab,
  /**
   * Recording, when Share > Export Video is ticked. Undefined builds NO
   * recording tab at all -- not a hidden one.
   *
   * That distinction is the UI half of the lazy-loading rule: an unticked
   * Export Video means this section never imports `recordingSettings.ts`,
   * never builds four blades nobody asked for, and never runs their per-frame
   * refresh. A built-but-hidden tab would pay all three costs to show nothing.
   */
  recording?: RecordingSectionOptions,
  /**
   * Build the Project page as a fourth tab. Touch layouts only.
   *
   * True ONLY when there is no left panel to hold it -- the two are the same
   * decision seen from opposite ends, and having both would put Project on
   * screen twice with two sets of live bindings writing the same fields.
   * `panelModel.leftSections` is the other half.
   */
  project?: boolean,
  /**
   * Project Link Settings, when Share > Project Link Settings is ticked.
   * Undefined builds NO tab, on the same terms as `recording` above.
   */
  link?: LinkSectionOptions,
): SettingsSectionHandle {
  // The host folder's own header goes too: the tab strip sits directly beneath
  // it and names both pages, so a "Settings" bar above them is a third label for
  // something already labelled twice -- and one the user could collapse, hiding
  // the tabs with no clue why.
  hideFolderTitle(folder);

  // The Project page, FIRST in the strip and touch-only. See `PROJECT_TAB`.
  //
  // **ITS TITLE IS NOT SUPPRESSED, unlike every other page here.**
  // `projectSection` retitles this folder to `Project: <name>` and keeps it
  // current as the name changes underneath -- which is the only place the loaded
  // project's name appears now that the left panel is gone. Hiding it to match
  // the others would cost the user the one label that says what they are
  // editing.
  let projectFolder: FolderApi | null = null;
  let projectSection: SectionHandle | null = null;
  if (project === true) {
    projectFolder = folder.addFolder({ title: 'Project', expanded: true });
    (projectFolder.element as HTMLElement).dataset['section'] = PROJECT_TAB;
    projectSection = buildProjectSection(projectFolder, status, ctx);
  }

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

  // The third tab exists only while Export Video is ticked -- see the parameter.
  let recordingSection: RecordingSectionHandle | null = null;
  let recordingFolder: FolderApi | null = null;
  if (recording !== undefined) {
    recordingFolder = folder.addFolder({ title: 'Recording Controls', expanded: true });
    hideFolderTitle(recordingFolder);
    (recordingFolder.element as HTMLElement).dataset['section'] = RECORDING_TAB;
    recordingSection = buildRecordingSection(recordingFolder, status, ctx, recording);
  }

  // The fifth tab, on the same terms as Recording Controls -- see the parameter.
  let linkSection: LinkSectionHandle | null = null;
  let linkFolder: FolderApi | null = null;
  if (link !== undefined) {
    linkFolder = folder.addFolder({ title: 'Project Link Settings', expanded: true });
    hideFolderTitle(linkFolder);
    (linkFolder.element as HTMLElement).dataset['section'] = LINK_TAB;
    linkSection = buildLinkSection(linkFolder, status, ctx, link);
  }

  // --- the strip ----------------------------------------------------------
  // Built after the folders (Tweakpane needs to own its own children) and then
  // moved to the front, so it renders above them.
  const strip = document.createElement('div');
  strip.style.cssText = STRIP_CSS;
  // The hook the WebKit scrollbar rule in `index.html` hangs off -- a
  // pseudo-element cannot be expressed in `cssText`. Also a stable selector for
  // `tools/uiCheck.mjs`, following this file's `data-*` convention.
  strip.dataset['tabStrip'] = 'settings';

  let active: SettingsTab = initialTab;

  // Built from the tabs that EXIST, so an untickedRecording leaves two buttons
  // rather than three with one dead.
  // **THE LABELS ARE SHORT ON PURPOSE.** The panel is a fixed 320px and these
  // buttons do not wrap, so four full names ("Drawing Controls", "Recording
  // Controls", "Project Link Settings") overflow the strip and push the last
  // tab off the edge -- where it is not merely ugly but unreachable, which is
  // how a tab someone had just enabled came to be invisible.
  //
  // The full name survives in two places that have room for it: the tooltip on
  // each button (`TAB_HELP`, whose `title` is passed below) and the Share menu
  // rows that summon the optional two. So nothing is lost, and the strip stops
  // spending its width on the word "Controls" three times.
  const tabs: (readonly [SettingsTab, string])[] = [];
  // FIRST when it exists -- see `PROJECT_TAB`.
  if (projectFolder !== null) tabs.push([PROJECT_TAB, 'Project']);
  tabs.push([PREFS_TAB, 'Preferences'], [DRAWING_TAB, 'Draw']);
  if (recordingFolder !== null) tabs.push([RECORDING_TAB, 'Video']);
  // LAST, beside Video: the two are the optional pair, both summoned from the
  // Share menu, and keeping them adjacent means the strip's first buttons never
  // move as either is toggled.
  if (linkFolder !== null) tabs.push([LINK_TAB, 'Link']);

  const buttons = new Map<SettingsTab, HTMLButtonElement>();
  for (const [tab, title] of tabs) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = title;
    button.dataset['tab'] = tab;
    // ON THE TAB BUTTON, which is the only header these pages have -- their
    // folder titles are suppressed (`hideFolderTitle`), so this is where "what
    // is this whole page for" has to live. They all say the same thing in
    // different words: none of it travels with a project.
    //
    // **THE TOOLTIP CARRIES THE FULL NAME, not the button's abbreviation.**
    // That is what makes shortening the labels above safe: "Draw" is enough to
    // find the tab again, and anyone who needs to know it means "Drawing
    // Controls" gets it by hovering.
    ctx.tooltip.attach(button, { title: TAB_FULL_NAME[tab], body: TAB_HELP[tab] });
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
  //
  // **THE ANCHOR IS WHICHEVER PAGE IS FIRST, not Preferences by name.** Project
  // is built ahead of it on touch, so anchoring on `prefsFolder` would leave the
  // strip BELOW the Project page -- tabs in the middle of the panel, under the
  // page they switch. The two must stay in step, which is why this reads the
  // same "is there a project folder" the tab list above reads.
  const firstEl = (projectFolder ?? prefsFolder).element as HTMLElement;
  firstEl.parentElement?.insertBefore(strip, firstEl);

  function setActiveTab(tab: SettingsTab): void {
    // A tab that does not exist cannot be shown. Reachable in practice: the
    // panel remembers `activeTab` across rebuilds, so un-ticking Export Video
    // while its tab is in front asks for exactly this -- and without the
    // fallback every folder would hide and the panel would go blank.
    active = buttons.has(tab) ? tab : PREFS_TAB;
    if (projectFolder !== null) {
      (projectFolder.element as HTMLElement).style.display =
        active === PROJECT_TAB ? '' : 'none';
    }
    (prefsFolder.element as HTMLElement).style.display =
      active === PREFS_TAB ? '' : 'none';
    (drawingFolder.element as HTMLElement).style.display =
      active === DRAWING_TAB ? '' : 'none';
    if (recordingFolder !== null) {
      (recordingFolder.element as HTMLElement).style.display =
        active === RECORDING_TAB ? '' : 'none';
    }
    if (linkFolder !== null) {
      (linkFolder.element as HTMLElement).style.display =
        active === LINK_TAB ? '' : 'none';
    }
    for (const [id, button] of buttons) {
      button.style.cssText = id === active ? TAB_ACTIVE_CSS : TAB_IDLE_CSS;
    }
    // KEEP THE ACTIVE TAB IN VIEW when the strip has overflowed. The panel
    // brings a newly summoned tab to the front (`setLinkSettingsShown`), and if
    // the strip happens to be scrolled that tab is off screen -- the same
    // invisible-tab failure the short labels fix, arriving by another route.
    //
    // `nearest` on both axes so this never scrolls the PANEL: `block:'nearest'`
    // leaves the vertical position alone when the button is already visible,
    // which it always is.
    buttons.get(active)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  setActiveTab(active);

  return {
    // Both children's, concatenated. The panel resolves reveals across the
    // WHOLE registry rather than per folder, so a binding on the hidden tab
    // still has to be in this list -- it is hidden by its tab, not by its
    // reveal, and the two must not be confused.
    // Project's bindings JOIN THE LIST when it is a tab here. They are the same
    // bindings the left panel would have contributed on the desktop, and the
    // panel resolves reveals and gates across the whole list -- so leaving them
    // out would make every `revealsOn` and `requires` on a Project control
    // silently stop working on touch.
    bindings: [
      ...(projectSection?.bindings ?? []),
      ...prefs.bindings,
      ...drawing.bindings,
    ] as readonly ControlBinding[],
    refresh: (s, input) => {
      // EVERY tab, including the ones nobody can see. Refreshing only the active
      // tab would mean switching to another showed one frame of stale values,
      // and the cost is a handful of proxy writes.
      //
      // Project's refresh is what keeps its folder title reading the CURRENT
      // project name, which changes under the panel on every load.
      projectSection?.refresh(s, input);
      prefs.refresh(s, input);
      drawing.refresh(s, input);
      // Recording's refresh drives the export button's progress label, which
      // must keep counting while the user reads a different tab.
      recordingSection?.refresh(s, input);
      // A no-op today -- the link tab reads the live state when a link is
      // built rather than mirroring it -- and forwarded anyway, for the reason
      // `dispose` forwards to Project below.
      linkSection?.refresh(s, input);
    },
    // Forwarded so the listeners a tab registers outside its own folder are
    // released when this host is torn down.
    //
    // **EVERY TAB, INCLUDING THE ONES THAT DEFINE NO `dispose` TODAY.** This
    // list once named only three, on the reasoning that the others "have
    // nothing outside their folders" -- and that went stale the moment Drawing
    // Controls grew a release listener for the Brush Size reticle: the section
    // defined `dispose`, the host never called it, and the teardown silently
    // did nothing. Forwarding unconditionally is what keeps the next one from
    // repeating it.
    dispose: () => {
      recordingSection?.dispose?.();
      prefs.dispose?.();
      drawing.dispose?.();
      projectSection?.dispose?.();
      linkSection?.dispose?.();
    },
    setActiveTab,
    activeTab: () => active,
    recordingSettings: () => recordingSection?.settings() ?? null,
    linkSettings: () => linkSection?.settings() ?? null,
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

/**
 * The strip.
 *
 * **`overflow-x:auto` IS A SAFETY NET, NOT THE LAYOUT.** The short labels above
 * are what make the tabs fit; this is what stops a tab becoming UNREACHABLE if
 * they ever stop fitting anyway -- a fifth tab, a longer name, a browser with
 * wider default metrics. Before it, an overflowing button was simply clipped by
 * the 320px panel with no way to scroll to it.
 *
 * `scrollbar-width:none` and the WebKit rule hide the scrollbar itself: a
 * horizontal bar under four buttons would eat a row of vertical space to
 * announce an overflow that normally does not happen. The strip still scrolls
 * by wheel, trackpad and touch drag, and `scrollIntoView` below is what keeps a
 * programmatically-selected tab visible without one.
 */
const STRIP_CSS =
  'display:flex;gap:2px;padding:6px 4px 2px 4px;' +
  'border-bottom:1px solid rgba(255,255,255,0.10);margin-bottom:4px;' +
  'overflow-x:auto;scrollbar-width:none;';

/**
 * `flex:1` GROWS the buttons to share the width and `min-width:0` lets them
 * SHRINK below their text -- together they keep four tabs inside 320px, with
 * `text-overflow:ellipsis` making a squeezed label say so rather than spill.
 *
 * Without `min-width:0` a flex item refuses to shrink past its content, which
 * is precisely how a nowrap button pushed the strip wider than the panel.
 */
const TAB_BASE_CSS =
  'flex:1 1 0;min-width:0;border:0;border-radius:4px 4px 0 0;cursor:pointer;' +
  'font:11px system-ui,sans-serif;padding:6px 6px;white-space:nowrap;' +
  'overflow:hidden;text-overflow:ellipsis;';

const TAB_IDLE_CSS = `${TAB_BASE_CSS}background:transparent;color:rgba(232,232,234,0.6);`;

const TAB_ACTIVE_CSS =
  `${TAB_BASE_CSS}background:rgba(255,255,255,0.10);color:#e8e8ea;` +
  'box-shadow:inset 0 -2px 0 #8ab4f8;';
