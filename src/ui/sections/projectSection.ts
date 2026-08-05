/**
 * The Project section: live controls over everything a save file contains.
 *
 * The port of `ui/settings_window.py`'s body (`:72-126`). **The project** is the
 * state the save/load system stores and restores: the whole ConfigBuffer plus
 * the world settings -- so this section renders `CONFIG` and `WORLD` and
 * nothing else. Editor preferences are a different KIND of state and live in
 * `preferencesSection.ts`, together with the Basic/Advanced toggle that governs
 * both.
 *
 * Controls are grouped into collapsible folders by their `group`, and **a group
 * whose members are all hidden by the current tier is not rendered at all** --
 * `grouped()` omits it, which is how the Trails and Advanced folders vanish in
 * Basic mode rather than showing empty headers.
 *
 * ## No undo here, on purpose
 *
 * The config clipboard already snapshots and restores the whole buffer, so
 * "checkpoint, experiment, hover to A/B, click to revert" is the undo story
 * (`settings_window.py:24-27`). The Revert button (10e) is the coarser version:
 * back to what storage holds, discarding everything since.
 *
 * Values are pushed on every change, straight into the GPU buffer -- editing a
 * slider shows its effect immediately, which is the point of having sliders at
 * all rather than editing JSON.
 */

import type { FolderApi } from 'tweakpane';
import type { Status } from '../../orchestrator/commands.ts';
import { type ControlBinding, addControl } from '../controls.ts';
import { CONFIG, WORLD, grouped } from '../settingsSpec.ts';
import { addAdvancedToggle } from '../advancedToggle.ts';
import { type SectionContext, type SectionHandle, bindingsOnly } from './section.ts';

/**
 * The folder header, naming the project the controls below are editing.
 *
 * The panel writes a static `'Project'` from `panelModel.ts`; this section
 * replaces it with the live name on every refresh, because the name changes
 * under the panel -- a load, a save-as, a clipboard restore -- and a header
 * still reading the previous project is the exact confusion `project.ts:17-20`
 * describes.
 */
function projectTitle(name: string): string {
  return `Project: ${name}`;
}

export function buildProjectSection(
  folder: FolderApi,
  status: Status,
  ctx: SectionContext,
): SectionHandle {
  const bindings: ControlBinding[] = [];

  folder.title = projectTitle(status.projectName);

  // FIRST, above the groups it governs. Tweakpane appends, so build order is
  // display order. This panel's tier only -- the other two answer for
  // themselves (`advancedToggle.ts`).
  addAdvancedToggle(folder, 'advancedProject', ctx);

  for (const [group, settings] of grouped(ctx.advanced, [CONFIG, WORLD])) {
    // `group` is never empty for these entries -- every CONFIG/WORLD setting
    // declares one -- but the fallback keeps a future ungrouped entry from
    // producing a folder with no title rather than crashing.
    const sub = folder.addFolder({ title: group || 'Settings', expanded: true });
    (sub.element as HTMLElement).dataset['group'] = group;
    for (const setting of settings) {
      bindings.push(addControl(sub, setting, status, ctx));
    }
  }

  // Wraps `bindingsOnly` rather than replacing it: the controls refresh exactly
  // as every other section's do, and this only adds the header on top.
  //
  // Written on an actual change, not every frame. Tweakpane's title setter
  // touches the DOM, and this runs once per frame for a string that changes on
  // a load or a save -- the same instinct as `panel.ts`'s `setHidden`.
  const base = bindingsOnly(bindings);
  let shown = folder.title;
  return {
    bindings: base.bindings,
    refresh: (s, input) => {
      const title = projectTitle(s.projectName);
      if (title !== shown) {
        shown = title;
        folder.title = title;
      }
      base.refresh(s, input);
    },
  };
}
