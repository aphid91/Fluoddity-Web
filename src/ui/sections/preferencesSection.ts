/**
 * The Preferences section: editor state.
 *
 * The port of `ui/preferences_window.py`. Separate from the Project section
 * because these are a different KIND of state: Project edits a config -- the
 * thing you save, load and share -- while Preferences is how your editor is set
 * up. **Loading someone else's config changes the former and must never change
 * the latter**, which is exactly the `source == PREFS` split in the registry.
 * That split is now also which side of the screen each panel is on.
 *
 * One of the two tabs in the right-hand panel; Drawing Controls is the other.
 * The host is `sections/settingsSection.ts`, which owns the tab strip.
 *
 * ## The Editor folder is gone, and with it the global tier
 *
 * It held one checkbox, and that checkbox governed BOTH windows -- so wanting
 * an advanced preference also unfolded every advanced physics slider. Each
 * panel now carries its own Advanced checkbox at the top, and this one answers
 * for this tab alone. `ui/advancedToggle.ts` builds it; the flags persist, and
 * the reasoning for both changes is in those two files.
 */

import type { FolderApi } from 'tweakpane';
import type { Status } from '../../orchestrator/commands.ts';
import { type ControlBinding, addControl } from '../controls.ts';
import { PREFS, grouped } from '../settingsSpec.ts';
import { addAdvancedToggle } from '../advancedToggle.ts';
import { type SectionContext, type SectionHandle, bindingsOnly } from './section.ts';

export function buildPreferencesSection(
  folder: FolderApi,
  status: Status,
  ctx: SectionContext,
): SectionHandle {
  const bindings: ControlBinding[] = [];
  /** Set by the calibrate button, so `refresh` can keep its label current. */
  let paintCalibrateButton: (() => void) | null = null;

  // FIRST, above the groups it governs. See `projectSection.ts`.
  addAdvancedToggle(folder, 'advancedPreferences', ctx);

  for (const [group, settings] of grouped(ctx.advanced, [PREFS])) {
    const sub = folder.addFolder({ title: group || 'Settings', expanded: true });
    (sub.element as HTMLElement).dataset['group'] = group;
    for (const setting of settings) {
      bindings.push(addControl(sub, setting, status, ctx));

      // **DIRECTLY BENEATH THE SLIDER IT TUNES.** The button is about this one
      // control, so it goes in the same folder immediately after it rather than
      // at the foot of the group -- a calibrate button several rows below the
      // thing it calibrates reads as belonging to whatever it happens to sit
      // under.
      //
      // Built here rather than by the panel because this is the only code that
      // knows where the Physics Rate row IS. Absent when `calibrateRate` is
      // (the DOM tests), which leaves no button rather than an inert one.
      if (setting.field === 'physicsSteps' && ctx.calibrateRate !== undefined) {
        paintCalibrateButton = addCalibrateButton(sub, ctx.calibrateRate);
      }
    }
  }

  const inner = bindingsOnly(bindings);
  return {
    ...inner,
    refresh: (s, input) => {
      inner.refresh(s, input);
      // The label carries the run's progress, so it changes every probe. Cheap:
      // `paintCalibrateButton` guards on the rendered string.
      paintCalibrateButton?.();
    },
  };
}

/**
 * The Auto-calibrate button, and a repaint closure for its label.
 *
 * Returns the repainter rather than taking a handle, so the caller does not have
 * to hold a Tweakpane object it otherwise has no use for.
 *
 * **A FULL-WIDTH BUTTON**, unlike the `label: ' '` used by Randomize in
 * `controls.ts`: that one sits beside a readout it belongs to, whereas this
 * spans the row because it acts on the slider ABOVE it and has nothing to sit
 * beside. It is also the one control here that takes seconds to complete, and
 * the width is what makes its changing label legible while it runs.
 */
function addCalibrateButton(
  folder: FolderApi,
  calibrate: NonNullable<SectionContext['calibrateRate']>,
): () => void {
  const button = folder.addButton({ title: calibrate.label() });
  const element = button.element as HTMLElement;
  element.dataset['setting'] = 'prefs.physicsSteps.calibrate';

  // **THE LABEL COLUMN IS COLLAPSED, and it has to be.** Tweakpane lays every
  // blade out as a fixed label cell beside a value cell, so a button renders in
  // the right-hand third of the row -- which clipped this title to
  // "Auto-calibrate Physics R". This is the one control here wide enough to
  // care, because its label is a sentence rather than a word.
  //
  // Found STRUCTURALLY, not by class name: Tweakpane's own classes are minified
  // (`controls.ts` explains at length why the tooling never depends on them),
  // and what is stable is that the label is the blade's first child cell and
  // holds no control. Same traversal `perfLabels.ts` uses, and it fails soft the
  // same way -- a Tweakpane change costs the full width, never a crash.
  const cells = [...element.children].filter(
    (cell): cell is HTMLElement => cell instanceof HTMLElement,
  );
  const label = cells.find((cell) => cell.querySelector('button') === null);
  if (label !== undefined) label.style.display = 'none';
  const value = cells.find((cell) => cell.querySelector('button') !== null);
  if (value !== undefined) value.style.width = '100%';

  // No `isRefreshing` guard: a button's click is always the user's. The guard
  // exists for BINDINGS, whose `change` fires on a programmatic refresh too.
  button.on('click', () => {
    if (calibrate.running()) calibrate.cancel();
    else calibrate.start();
  });

  let shown = '';
  return () => {
    const title = calibrate.label();
    if (title === shown) return;
    shown = title;
    button.title = title;
  };
}
