/**
 * The preferences window, driven by the shared settings registry.
 *
 * ## Why this reads `settingsSpec.ts` rather than listing controls
 *
 * Every tunable in the app is declared once in that registry with its bounds,
 * kind and help text, and each is tagged `CONFIG`, `WORLD` or `PREFS`. The
 * preferences window is by definition "everything tagged PREFS" -- so this is a
 * FILTER over existing data, not a second list that could drift from the
 * studio's. Adding a preference upstream makes it appear here automatically,
 * which is the whole point of the registry existing.
 *
 * What is NOT reused is `ui/controls.ts`. Its `addControl` takes the studio's
 * `Status` object and issues its `Command` union -- an interface wired to a
 * 3,700-line orchestrator this modality does not have. Binding Tweakpane
 * straight to a mutable copy of `Preferences` is a fraction of the coupling for
 * the same result, and the registry (which is pure data) still supplies the
 * bounds and labels that actually matter.
 *
 * ## Disruptive settings
 *
 * World Size and Canvas Aspect reallocate every GPU buffer, so they are typed
 * inputs that commit on Enter rather than sliders that would rebuild the world
 * on every frame of a drag -- the reason `Preferences.requiresRestart` exists.
 * In this modality they ALSO invalidate the initial conditions, because the
 * snapshot holds copies of buffers that are about to be replaced.
 */

import { Pane } from 'tweakpane';
import type { FolderApi } from 'tweakpane';

import {
  type Preferences,
  requiresRestart,
  savePreferences,
} from '../prefs/preferences.ts';
import {
  BOOL,
  CHOICE,
  INPUT,
  INT,
  PREFS,
  SETTINGS,
  type Setting,
} from '../ui/settingsSpec.ts';

/** Fields a sand world has no use for, and why. */
const HIDDEN: ReadonlySet<string> = new Set([
  // Studio interactions this modality does not have: there is no selection
  // tool, so neither of these has anything to act on.
  'resetOnBehaviorChange',
  'oneClickSelection',
  // Archive/recording diagnostics, which belong to the studio's export path.
  'strongLogging',
  // The studio's own panel affordances.
  'showPhysicsSlider',
  // Motion blur is deliberately off here -- a sand world is being drawn on, and
  // the brush wants the sharpest read of where particles are. See
  // `SandOrchestrator.renderInto`.
  'motionBlurSamples',
  // The touch layout is the studio panel's, not this one's.
  'mobileMode',
]);

export interface SandPrefsCallbacks {
  /** A preference changed. The value is already written into the object. */
  onChange(prefs: Preferences): void;
  /**
   * World size or canvas aspect changed, so every GPU buffer must be rebuilt
   * and the initial-conditions snapshot is stale.
   */
  onRestartRequired(prefs: Preferences): void;
}

export class SandPrefs {
  private readonly pane: Pane;
  /** A mutable mirror -- Tweakpane binds to object properties. */
  private readonly values: Record<string, unknown>;
  private committed: Preferences;

  constructor(prefs: Preferences, callbacks: SandPrefsCallbacks) {
    this.committed = prefs;
    this.values = { ...prefs } as Record<string, unknown>;

    this.pane = new Pane({ title: 'Preferences', expanded: false });
    const element = this.pane.element.parentElement;
    if (element !== null) {
      element.style.position = 'fixed';
      element.style.top = '8px';
      element.style.right = '8px';
      element.style.width = '260px';
      element.style.zIndex = '5';
    }

    // Grouped by the registry's own `group`, in declaration order -- the same
    // grouping the studio's panel uses, so the two windows read alike.
    const folders = new Map<string, FolderApi>();
    for (const setting of SETTINGS) {
      if (setting.source !== PREFS) continue;
      if (HIDDEN.has(setting.field)) continue;

      let folder = folders.get(setting.group);
      if (folder === undefined) {
        folder = this.pane.addFolder({ title: setting.group });
        folders.set(setting.group, folder);
      }
      this.addBinding(folder, setting, callbacks);
    }
  }

  private addBinding(
    folder: FolderApi,
    setting: Setting,
    callbacks: SandPrefsCallbacks,
  ): void {
    const params: Record<string, unknown> = { label: setting.label };

    if (setting.kind === CHOICE && setting.options.length > 0) {
      // Tweakpane wants {label: value}; the registry's index IS the stored
      // value, which is why the options are an ordered tuple.
      const options: Record<string, number> = {};
      setting.options.forEach((name, index) => {
        options[name] = index;
      });
      params['options'] = options;
    } else if (setting.kind !== BOOL) {
      params['min'] = setting.lo;
      params['max'] = setting.hi;
      if (setting.kind === INT) params['step'] = 1;
    }

    const blade = folder.addBinding(this.values, setting.field, params);
    if (setting.help !== '') blade.element.title = setting.help;

    // World Size and Canvas Aspect reallocate the world, so they commit on
    // change rather than continuously -- `INPUT` is the registry's marker for
    // exactly that, per its "disruptive settings are typed inputs" rule.
    const disruptive = setting.kind === INPUT;

    blade.on('change', (ev) => {
      if (disruptive && !ev.last) return;

      const next = { ...this.committed, [setting.field]: this.values[setting.field] } as Preferences;
      const restart = requiresRestart(next, this.committed);
      this.committed = next;
      savePreferences(next);

      if (restart) callbacks.onRestartRequired(next);
      else callbacks.onChange(next);
    });
  }

  get preferences(): Preferences {
    return this.committed;
  }

  dispose(): void {
    this.pane.dispose();
  }
}
