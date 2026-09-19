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
import {
  MASTER_SLOT,
  MIN_VISIBLE_COUNT,
  type Palette,
  SLOT_COUNT,
} from './palette.ts';
import { type SandTheme, THEMES, themeById } from './theme.ts';

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
  /** The Dev tab's Compact Now button. Stalls the pipeline; see the button. */
  onCompactNow(): void;
  /** The Dev tab's compaction kill switch. */
  onCompactionPaused(paused: boolean): void;
  /** A UI comp was chosen from the Dev tab's dropdown. */
  onTheme(theme: SandTheme): void;
  /** The swatch-count slider moved. Display only -- see `palette.ts`. */
  onVisibleCount(count: number): void;
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

  private readonly devValues: Record<string, number | string>;
  /** The last committed Max Particles, for reverting a bad entry. */
  private committedMaxParticles: number;

  /**
   * The compaction readouts, as STRINGS.
   *
   * Tweakpane's monitor bindings show a number as a graph or a slider; these are
   * bound as text so they read as a diagnostic rather than as something to drag.
   * Written by `setCompactionStats` once per frame and never by the user.
   */
  private readonly poolValues: Record<string, string | boolean> = {
    live: '—',
    mark: '—',
    occupancy: '—',
    sweep: 'idle',
    compactionPaused: false,
  };
  /** Refreshed per frame, but only when a displayed value actually moved. */
  private poolFolder: FolderApi | null = null;

  constructor(
    prefs: Preferences,
    palette: Palette,
    maxParticles: number,
    initial: { theme: string; visibleCount: number },
    callbacks: SandPrefsCallbacks,
  ) {
    this.committed = prefs;
    this.committedMaxParticles = maxParticles;
    this.devValues = {
      maxParticles,
      theme: initial.theme,
      visibleCount: initial.visibleCount,
    };
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
    // THE UI COMP. Four of them -- see `theme.ts`. Three are a token swap and
    // one moves the furniture; the dropdown does not distinguish, because from
    // here they are all just "which front end".
    const themeBlade = page.addBinding(this.devValues, 'theme', {
      label: 'UI style',
      options: Object.fromEntries(THEMES.map((t) => [t.label, t.id])),
    });
    themeBlade.element.title = THEMES.map((t) => `${t.label}: ${t.note}`).join('\n');
    themeBlade.on('change', () => {
      this.callbacks.onTheme(themeById(String(this.devValues['theme'])));
    });

    // SWATCH COUNT. A slider, unlike Max Particles, because it is genuinely
    // free: capacity is a fixed `SLOT_COUNT` and this only changes how many
    // buttons are DRAWN. Nothing reallocates and no particle is repointed --
    // see the header of `palette.ts` on why the array itself cannot follow it.
    const countBlade = page.addBinding(this.devValues, 'visibleCount', {
      label: 'Swatches',
      min: MIN_VISIBLE_COUNT,
      max: SLOT_COUNT,
      step: 1,
    });
    countBlade.element.title =
      `How many swatch buttons the tray shows, ${MIN_VISIBLE_COUNT}-${SLOT_COUNT}. ` +
      'Display only: configs in hidden slots keep running and keep their ' +
      'particles. Lowering this does not delete anything.';
    countBlade.on('change', () => {
      this.callbacks.onVisibleCount(Number(this.devValues['visibleCount']));
    });

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

    this.buildPool(page);
  }

  /**
   * The pool folder: what compaction is doing, and the controls for it.
   *
   * ## Why these three numbers and not a particle count alone
   *
   * A sand world's cost is not "how many particles exist" -- it is HOW FAR EVERY
   * PASS HAS TO SWEEP, which is the high-water mark. The two come apart exactly
   * when compaction matters: erase a full world and Live goes to zero while Mark
   * stays where it was, and every pass keeps paying the old price for particles
   * that are gone. Showing Live without Mark would make that state look healthy.
   *
   * Occupancy is the ratio, surfaced because it is the number that says whether
   * anything is wrong: at 100% the buffer is packed and there is nothing to win,
   * and at 5% the world is paying twenty invocations per particle that exists.
   *
   * Folded and placed below Max Particles because it is a diagnostic, not a
   * setting -- it is read when something is slow, not adjusted in normal use.
   */
  private buildPool(page: TabPageApi): void {
    const folder = page.addFolder({ title: 'Particle pool', expanded: false });
    this.poolFolder = folder;

    // MONITORS, not bindings: `readonly` is what makes Tweakpane render these as
    // a display rather than as an editable field. A user cannot type a new
    // high-water mark, and offering a box that looks like they could would be a
    // lie about what the number is.
    const live = folder.addBinding(this.poolValues, 'live', {
      label: 'Live',
      readonly: true,
    });
    live.element.title =
      'Particles currently alive, from the free-list head. A frame or two ' +
      'stale — the head is read back asynchronously, never synchronously.';

    const mark = folder.addBinding(this.poolValues, 'mark', {
      label: 'Mark',
      readonly: true,
    });
    mark.element.title =
      'The high-water mark: how far every pass over the entities actually ' +
      'sweeps. THIS is what a large particle cap costs, not the live count. ' +
      'It rises as particles are painted and only falls when the pool empties ' +
      'completely or you compact.';

    const occ = folder.addBinding(this.poolValues, 'occupancy', {
      label: 'Occupancy',
      readonly: true,
    });
    occ.element.title =
      'Live ÷ Mark — the fraction of the swept range that is doing any work. ' +
      '100% is packed. A low value means the passes are sweeping mostly dead ' +
      'slots, which is what compaction exists to fix.';

    // THE SWEEP. Tier 2 runs over many frames, so it needs a readout of its own
    // -- a button whose effect arrives two seconds later, with nothing saying it
    // is working, is indistinguishable from a button that does nothing. That is
    // the mistake this panel already made once.
    const sweep = folder.addBinding(this.poolValues, 'sweep', {
      label: 'Sweep',
      readonly: true,
    });
    sweep.element.title =
      'Tier 2 compaction: relocating live particles down so the mark can ' +
      'fall. Runs in budgeted chunks over a second or two. Painting aborts ' +
      'it — the relocations already made are kept, the mark simply does not ' +
      'come down that time.';

    // THE KILL SWITCH. Compaction is the only thing on the Dev tab that changes
    // a bound the physics reads, so being able to take it out of the picture in
    // one click is what makes a suspicious world diagnosable.
    const pause = folder.addBinding(this.poolValues, 'compactionPaused', {
      label: 'Pause compaction',
    });
    pause.element.title =
      'Stop the per-frame pool ordering and the automatic mark drop. For ' +
      'telling whether odd behaviour is compaction or something else. Compact ' +
      'Now still works while this is on.';
    pause.on('change', () => {
      this.callbacks.onCompactionPaused(Boolean(this.poolValues['compactionPaused']));
    });

    const button = folder.addButton({ title: 'Compact now' });
    button.element.title =
      'Order the pool exactly, then sweep: relocate live particles down so ' +
      'the mark can fall. The sort is immediate and briefly stalls the ' +
      'pipeline; the sweep then runs in budgeted chunks over a second or two ' +
      'and is reported above. Painting aborts the sweep.';
    button.on('click', () => this.callbacks.onCompactNow());
  }

  /**
   * Push a frame's pool numbers into the readouts.
   *
   * Called every frame from the frame loop. Cheap: it writes four strings and
   * refreshes the folder, and Tweakpane does nothing if the folder is collapsed
   * -- which it is by default, so the common case costs the formatting alone.
   *
   * FORMATTED HERE rather than in the orchestrator, because these are display
   * strings and the orchestrator should not own a locale.
   */
  setCompactionStats(stats: {
    live: number;
    mark: number;
    capacity: number;
    occupancy: number;
    paused: boolean;
    sweeping: boolean;
    sweepProgress: number;
    relocated: number;
  }): void {
    const sweep = stats.sweeping
      ? `${Math.round(stats.sweepProgress * 100)}% · ${stats.relocated.toLocaleString()} moved`
      : 'idle';
    const live = stats.live.toLocaleString();
    // WITH THE CAPACITY, because the mark is meaningless alone: 400,000 is
    // excellent against a 3M cap and catastrophic against a 400k one.
    const mark =
      `${stats.mark.toLocaleString()} / ${stats.capacity.toLocaleString()}`;
    const occ = `${Math.round(stats.occupancy * 100)}%`;

    // GUARDED, because `refresh()` rebuilds every blade's DOM text and this runs
    // at frame rate. The live count moves constantly while painting but is
    // static the rest of the time, so the guard makes the common case free.
    if (
      live === this.poolValues['live'] &&
      mark === this.poolValues['mark'] &&
      occ === this.poolValues['occupancy'] &&
      sweep === this.poolValues['sweep'] &&
      stats.paused === this.poolValues['compactionPaused']
    ) {
      return;
    }

    this.poolValues['live'] = live;
    this.poolValues['mark'] = mark;
    this.poolValues['occupancy'] = occ;
    this.poolValues['sweep'] = sweep;
    this.poolValues['compactionPaused'] = stats.paused;
    // The FOLDER, not the whole pane: refreshing the pane would also rewrite
    // every Prefs and Config blade, including one the user may be mid-drag on.
    this.poolFolder?.refresh();
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
