/**
 * The settings window: Preferences, Config and Dev, as three tabs.
 *
 * ## Why this reads `settingsSpec.ts` rather than listing controls
 *
 * Every tunable in the app is declared once in that registry with its bounds,
 * kind and help text, and each is tagged `CONFIG`, `WORLD` or `PREFS`. Both the
 * Preferences and the Config tab are FILTERS over that data rather than second
 * lists that could drift from the studio's -- adding a setting upstream makes it
 * appear here automatically, which is the whole point of the registry.
 *
 * What is NOT reused is `ui/controls.ts`. Its `addControl` takes the studio's
 * `Status` object and issues its `Command` union -- an interface wired to a
 * 3,700-line orchestrator this modality does not have. Binding Tweakpane
 * straight to a mutable mirror is a fraction of the coupling for the same
 * result, and the registry still supplies the bounds and labels that matter.
 *
 * ## The Config tab rebuilds; the others do not
 *
 * Preferences and Dev bind to objects that outlive the window. The Config tab
 * binds to WHICHEVER PALETTE SQUARE IS SELECTED, so it is torn down and rebuilt
 * whenever the selection changes or a square is loaded into. `syncConfig()` is
 * what the frame loop calls to notice that.
 */

import { Pane } from 'tweakpane';
import type { FolderApi, TabPageApi } from 'tweakpane';

import {
  type Preferences,
  requiresRestart,
  savePreferences,
} from '../prefs/preferences.ts';
import {
  BOOL,
  CHOICE,
  CONFIG,
  INPUT,
  INT,
  PREFS,
  SETTINGS,
  type Setting,
  WORLD,
} from '../ui/settingsSpec.ts';
import type { SimulationConfig, WorldSettings } from '../particleSystem/config.ts';
import { MASTER_SLOT, type Palette } from './palette.ts';

/** Fields a sand world has no use for, and why. */
const HIDDEN_PREFS: ReadonlySet<string> = new Set([
  // Studio interactions this modality does not have: there is no selection
  // tool, so neither of these has anything to act on.
  'resetOnBehaviorChange',
  'oneClickSelection',
  // Archive/recording diagnostics, which belong to the studio's export path.
  'strongLogging',
  // The studio's own panel affordances.
  'showPhysicsSlider',
  // Motion blur is deliberately off here -- a sand world is being drawn on, and
  // the brush wants the sharpest read of where particles are.
  'motionBlurSamples',
  // The touch layout is the studio panel's, not this one's.
  'mobileMode',
]);

export interface SandPrefsCallbacks {
  onChange(prefs: Preferences): void;
  onRestartRequired(prefs: Preferences): void;
  /** A config or world setting on the selected square changed. */
  onConfigEdit(slot: number, config: SimulationConfig, world: WorldSettings): void;
  /** Save As on the Config tab. */
  onSaveConfig(slot: number, name: string): void;
  /** Max Particles was committed. Rebuilds the entity buffer. */
  onMaxParticles(count: number): void;
}

export class SandPrefs {
  private readonly pane: Pane;
  private readonly palette: Palette;
  private readonly callbacks: SandPrefsCallbacks;

  private readonly prefValues: Record<string, unknown>;
  private committed: Preferences;

  private readonly configPage: TabPageApi;
  /** Rebuilt per selection. Bound to a copy of the selected square's config. */
  private configValues: Record<string, unknown> = {};
  /** Which square the Config tab is currently showing. -1 when empty. */
  private shownSlot = -1;
  /** Bumped when a square's contents are replaced, to force a rebuild. */
  private shownGeneration = -1;

  private readonly devValues: Record<string, number>;
  /** The last committed Max Particles, for reverting a bad entry. */
  private committedMaxParticles: number;

  constructor(
    prefs: Preferences,
    palette: Palette,
    maxParticles: number,
    callbacks: SandPrefsCallbacks,
  ) {
    this.committed = prefs;
    this.committedMaxParticles = maxParticles;
    this.devValues = { maxParticles };
    this.palette = palette;
    this.callbacks = callbacks;
    this.prefValues = { ...prefs } as Record<string, unknown>;

    this.pane = new Pane({ title: 'Fluoddity Sand', expanded: true });
    const host = this.pane.element.parentElement;
    if (host !== null) {
      host.style.position = 'fixed';
      host.style.top = '8px';
      host.style.right = '8px';
      host.style.width = '280px';
      host.style.maxHeight = 'calc(100vh - 16px)';
      host.style.overflowY = 'auto';
      host.style.zIndex = '5';
    }

    const tabs = this.pane.addTab({
      pages: [{ title: 'Prefs' }, { title: 'Config' }, { title: 'Dev' }],
    });
    const [prefsPage, configPage, devPage] = tabs.pages;
    if (prefsPage === undefined || configPage === undefined || devPage === undefined) {
      throw new Error('Tweakpane did not build the expected three pages.');
    }
    this.configPage = configPage;

    this.buildPrefs(prefsPage);
    this.buildDev(devPage);
    this.syncConfig();
  }

  // -------------------------------------------------------------------------
  // Preferences
  // -------------------------------------------------------------------------

  private buildPrefs(page: TabPageApi): void {
    const folders = new Map<string, FolderApi>();
    for (const setting of SETTINGS) {
      if (setting.source !== PREFS) continue;
      if (HIDDEN_PREFS.has(setting.field)) continue;

      let folder = folders.get(setting.group);
      if (folder === undefined) {
        folder = page.addFolder({ title: setting.group });
        folders.set(setting.group, folder);
      }
      this.bindPref(folder, setting);
    }
  }

  private bindPref(folder: FolderApi, setting: Setting): void {
    const blade = folder.addBinding(
      this.prefValues,
      setting.field,
      paramsFor(setting),
    );
    if (setting.help !== '') blade.element.title = setting.help;

    // World Size and Canvas Aspect reallocate the world, so they commit on the
    // END of a gesture rather than continuously -- `INPUT` is the registry's
    // marker for exactly that, per its "disruptive settings are typed inputs".
    const disruptive = setting.kind === INPUT;

    blade.on('change', (ev) => {
      if (disruptive && !ev.last) return;
      const next = {
        ...this.committed,
        [setting.field]: this.prefValues[setting.field],
      } as Preferences;
      const restart = requiresRestart(next, this.committed);
      this.committed = next;
      savePreferences(next);
      if (restart) this.callbacks.onRestartRequired(next);
      else this.callbacks.onChange(next);
    });
  }

  // -------------------------------------------------------------------------
  // Dev
  // -------------------------------------------------------------------------

  /**
   * The Dev tab.
   *
   * Brush Rate moved OUT of here and became the Weight number-drag beside the
   * size buttons, where it belongs -- it is a brush property, and it now drives
   * shove strength and draw power as well as spawn density.
   */
  private buildDev(page: TabPageApi): void {
    // MAX PARTICLES: a typed field, not a slider, for exactly the reason
    // `Preferences.requiresRestart` makes World Size one -- it reallocates every
    // per-entity GPU buffer, so a slider would rebuild the world on every frame
    // of a drag. Nothing happens until the value is committed.
    const blade = page.addBinding(this.devValues, 'maxParticles', {
      label: 'Max Particles',
      // A plain number field. `format` keeps it from rendering in exponential
      // notation at the top of the range, which is unreadable and uneditable.
      format: (v: number) => String(Math.round(v)),
    });
    blade.element.title =
      'Overrides the world-size-derived particle cap. Applied on Enter: the ' +
      'entity buffer is rebuilt and live particles are carried across, ' +
      'truncated if the new buffer is smaller.';

    blade.on('change', (ev) => {
      // `ev.last` is the end of the gesture -- for a text field, the commit.
      // Acting on every keystroke would reallocate the world per character.
      if (!ev.last) return;
      const requested = Math.round(Number(this.devValues.maxParticles));
      if (!Number.isFinite(requested) || requested < 1) {
        // Put the field back rather than acting on nonsense.
        this.devValues.maxParticles = this.committedMaxParticles;
        this.pane.refresh();
        return;
      }
      if (requested === this.committedMaxParticles) return;
      this.committedMaxParticles = requested;
      this.callbacks.onMaxParticles(requested);
    });
  }

  // -------------------------------------------------------------------------
  // Config -- the selected palette square's settings
  // -------------------------------------------------------------------------

  /**
   * Rebuild the Config tab if the selection (or its contents) changed.
   *
   * Called every frame. The two guards make that cheap: nothing happens unless
   * the slot index or the square's generation actually moved.
   *
   * THE GENERATION IS WHAT MAKES RIGHT-CLICK-LOAD AUTHORITATIVE. Loading a
   * config into the shown square must throw away whatever the sliders were
   * showing and display the file's values -- the requirement is that a load
   * "always overrides these settings and sets things back to the saved
   * config's". The palette bumps a counter on every `set`, and a changed counter
   * forces the rebuild that re-reads from the square.
   */
  syncConfig(): void {
    const slot = this.palette.selected;
    const generation = this.palette.generationOf(slot);
    if (slot === this.shownSlot && generation === this.shownGeneration) return;
    this.shownSlot = slot;
    this.shownGeneration = generation;
    this.rebuildConfig();
  }

  private rebuildConfig(): void {
    for (const child of [...this.configPage.children]) child.dispose();

    const slot = this.shownSlot;
    const entry = this.palette.at(slot);
    if (entry.config === null || entry.world === null) {
      this.configPage.addBlade({
        view: 'text',
        label: 'Empty',
        parse: (v: string) => v,
        value: 'Right-click a square to load',
        disabled: true,
      });
      return;
    }

    // A flat mirror of both records. They are separate types with no colliding
    // field names, so one object can back both and each blade writes the lane
    // its registry entry names.
    this.configValues = { ...entry.config, ...entry.world } as Record<string, unknown>;

    const folders = new Map<string, FolderApi>();
    for (const setting of SETTINGS) {
      if (setting.source !== CONFIG && setting.source !== WORLD) continue;
      if (!(setting.field in this.configValues)) continue;

      let folder = folders.get(setting.group);
      if (folder === undefined) {
        folder = this.configPage.addFolder({ title: setting.group, expanded: false });
        folders.set(setting.group, folder);
      }
      this.bindConfig(folder, setting, slot);
    }

    // WORLD settings on a non-master square are stored and saved, but do not
    // govern the running scene -- only the master's do. Saying so is better than
    // a knob that silently does nothing.
    if (slot !== MASTER_SLOT) {
      this.configPage
        .addBlade({
          view: 'text',
          label: 'Note',
          parse: (v: string) => v,
          value: 'Trails/Boundary apply from the master square only',
          disabled: true,
        })
        .element.setAttribute(
          'title',
          'This square is not the master element, so its Trails and Boundary ' +
            'settings are saved with it but do not govern the scene.',
        );
    }

    this.configPage
      .addButton({ title: 'Save As…' })
      .on('click', () => this.promptSave(slot));
  }

  private bindConfig(folder: FolderApi, setting: Setting, slot: number): void {
    const blade = folder.addBinding(
      this.configValues,
      setting.field,
      paramsFor(setting),
    );
    if (setting.help !== '') blade.element.title = setting.help;

    blade.on('change', () => {
      const entry = this.palette.at(slot);
      if (entry.config === null || entry.world === null) return;
      // Split the flat mirror back into its two records by asking the registry
      // which one each field came from -- the same split that built it.
      const config = { ...entry.config } as Record<string, unknown>;
      const world = { ...entry.world } as Record<string, unknown>;
      for (const s of SETTINGS) {
        if (!(s.field in this.configValues)) continue;
        if (s.source === CONFIG) config[s.field] = this.configValues[s.field];
        else if (s.source === WORLD) world[s.field] = this.configValues[s.field];
      }
      this.callbacks.onConfigEdit(
        slot,
        config as unknown as SimulationConfig,
        world as unknown as WorldSettings,
      );
    });
  }

  private promptSave(slot: number): void {
    const suggested = this.palette.at(slot).name || 'Untitled';
    const name = window.prompt('Save config as:', suggested);
    if (name === null) return;
    const trimmed = name.trim();
    if (trimmed === '') return;
    this.callbacks.onSaveConfig(slot, trimmed);
  }

  get preferences(): Preferences {
    return this.committed;
  }

  dispose(): void {
    this.pane.dispose();
  }
}

/** Tweakpane binding params derived from a registry entry. */
function paramsFor(setting: Setting): Record<string, unknown> {
  const params: Record<string, unknown> = { label: setting.label };
  if (setting.kind === CHOICE && setting.options.length > 0) {
    // Tweakpane wants {label: value}; the registry's INDEX is the stored value,
    // which is why its options are an ordered tuple.
    const options: Record<string, number> = {};
    setting.options.forEach((name, index) => {
      options[name] = index;
    });
    params['options'] = options;
    return params;
  }
  if (setting.kind === BOOL) return params;
  params['min'] = setting.lo;
  params['max'] = setting.hi;
  if (setting.kind === INT) params['step'] = 1;
  return params;
}
