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
import { type SectionContext, type SectionHandle, bindingsOnly } from './section.ts';

export function buildProjectSection(
  folder: FolderApi,
  status: Status,
  ctx: SectionContext,
): SectionHandle {
  const bindings: ControlBinding[] = [];

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

  return bindingsOnly(bindings);
}
