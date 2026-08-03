/**
 * The Preferences section: editor state, and the Basic/Advanced tier toggle.
 *
 * The port of `ui/preferences_window.py`. Separate from the Project section
 * because these are a different KIND of state: Project edits a config -- the
 * thing you save, load and share -- while Preferences is how your editor is set
 * up. **Loading someone else's config changes the former and must never change
 * the latter**, which is exactly the `source == PREFS` split in the registry.
 *
 * ## The tier toggle lives HERE
 *
 * Because it is itself an editor preference, and because it governs BOTH
 * sections -- switching to Advanced reveals advanced controls in Project as well
 * as here. Putting it in Project would have made a control that silently reaches
 * outside its own section (`preferences_window.py:12-16`).
 *
 * It is **not persisted**: it is a view mode, and the useful default is to start
 * simple each session. That is why it lives on the panel rather than in
 * `Preferences`.
 *
 * ## The Editor group is not registry-driven, deliberately
 *
 * The detail level configures the INTERFACE, not the simulation, so it has no
 * `settings_spec` entry and never will. Same reasoning as the desktop's.
 */

import type { FolderApi } from 'tweakpane';
import type { Status } from '../../orchestrator/commands.ts';
import { type ControlBinding, addControl } from '../controls.ts';
import { PREFS, grouped } from '../settingsSpec.ts';
import { type SectionContext, type SectionHandle } from './section.ts';

export function buildPreferencesSection(
  folder: FolderApi,
  status: Status,
  ctx: SectionContext,
): SectionHandle {
  const bindings: ControlBinding[] = [];

  for (const [group, settings] of grouped(ctx.advanced, [PREFS])) {
    const sub = folder.addFolder({ title: group || 'Settings', expanded: true });
    (sub.element as HTMLElement).dataset['group'] = group;
    for (const setting of settings) {
      const binding = addControl(sub, setting, status, ctx);
      if (binding !== null) bindings.push(binding);
    }
  }

  // --- Editor: not registry-driven. See the file header. -------------------
  const editor = folder.addFolder({ title: 'Editor', expanded: true });
  (editor.element as HTMLElement).dataset['group'] = 'Editor';

  const view = { advanced: ctx.advanced };
  const tier = editor.addBinding(view, 'advanced', { label: 'Advanced' });
  (tier.element as HTMLElement).dataset['setting'] = 'editor.advanced';
  tier.on('change', (ev) => {
    // A programmatic refresh must not be mistaken for the user asking for a
    // different tier -- that would rebuild the pane 60 times a second.
    if (ctx.isRefreshing()) return;
    if (ev.value === ctx.advanced) return;
    ctx.requestRebuild();
  });

  return {
    bindings,
    refresh: (s) => {
      for (const binding of bindings) binding.refresh(s);
      // The tier is the panel's own state, not the Orchestrator's, so it is
      // re-asserted from the context rather than read out of `status`.
      view.advanced = ctx.advanced;
    },
  };
}
