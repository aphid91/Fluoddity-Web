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

  // FIRST, above the groups it governs. See `projectSection.ts`.
  addAdvancedToggle(folder, 'advancedPreferences', ctx);

  for (const [group, settings] of grouped(ctx.advanced, [PREFS])) {
    const sub = folder.addFolder({ title: group || 'Settings', expanded: true });
    (sub.element as HTMLElement).dataset['group'] = group;
    for (const setting of settings) {
      bindings.push(addControl(sub, setting, status, ctx));
    }
  }

  return bindingsOnly(bindings);
}
