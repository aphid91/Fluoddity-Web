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
  ASSIGNABLE_WORLDS,
  MASTER_SLOT,
  MIN_VISIBLE_COUNT,
  type Palette,
  SLOT_COUNT,
  keyLabel,
} from './palette.ts';
import { type SandTheme, THEMES, themeById } from './theme.ts';
import {
  COLOR_MODES,
  COLOR_MODE_LABELS,
  type ColorMode,
  DEFAULT_COLOR_MODE,
  asColorMode,
} from './colorMode.ts';
import {
  type SwatchColor,
  swatchColorFromCss,
  swatchColorToCss,
} from './swatchColor.ts';

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
  // EXPERIMENT: wired into the studio orchestrator only.
  'expEarlyOut',
  'expSlimConfig',
  'expNoSensors',
  'expBlackBoxCenters',
  'expNoExtras',
  'expWorkgroupSize',
  'expBlackBoxForm',
  'expCheapTrig',
  'expHalfTrig',
  'expRuleSlotZero',
  'expFuseCanvas',
  'expCanvasTaps',
  'expCanvasLoad',
  'expCanvasEvery',
  'expSkipEntityPass',
  'expRenderProbe',
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
  /** The Dev tab's automatic-compaction switch. */
  onAutoCompact(enabled: boolean): void;
  /** The Dev tab's Audit pool button. Diagnostic; stalls the pipeline. */
  onAuditPool(): void;
  /** The Dev tab's "audit after every sweep" switch. */
  onAuditAfterSweep(enabled: boolean): void;
  /** A UI comp was chosen from the Dev tab's dropdown. */
  onTheme(theme: SandTheme): void;
  /** The swatch-count slider moved. Display only -- see `palette.ts`. */
  onVisibleCount(count: number): void;
  /** The colour-mode dropdown. A display choice; takes effect next frame. */
  onColorMode(mode: ColorMode): void;
  /** The selected swatch's colour picker moved. */
  onSwatchColor(slot: number, color: SwatchColor): void;

  // --- worlds. Dev-only: this is the level editor half of the app ----------

  /** "Save world as…" -- the name has been collected and confirmed. */
  onSaveWorld(name: string): void;
  /** "Load world" -- open the library modal. */
  onOpenWorldLibrary(): void;
  /**
   * One of the five world buttons was pointed at a different save.
   *
   * `name` is empty for None, which is how a button is unassigned.
   */
  onAssignWorld(index: number, name: string): void;
}

/** The dropdown value meaning "this button is unassigned". */
export const NO_WORLD = '';

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
   * The Colour folder's mirror: the mode, and the SELECTED swatch's colour.
   *
   * `swatch` is a hex string because Tweakpane's colour view speaks hex; the
   * model stores hue and saturation and `swatchColor.ts` converts. Seeded in
   * the constructor and kept pointed at the selection by `syncSwatchColor`.
   */
  private readonly colorValues: Record<string, string> = {
    mode: DEFAULT_COLOR_MODE,
    swatch: '#ffffff',
  };
  private colorFolder: FolderApi | null = null;
  /**
   * The picker blade, kept so its label can follow the selection.
   *
   * Typed from `addBinding`'s own return rather than named outright: Tweakpane
   * exports several binding interfaces and the one this method produces is not
   * assignable to the obvious `InputBindingApi`. Deriving it means the field
   * cannot disagree with the call that fills it.
   */
  private colorBlade: ReturnType<FolderApi['addBinding']> | null = null;
  /** Which swatch the picker is pointed at, so `syncSwatchColor` can notice. */
  private shownColorSlot = -1;

  /**
   * The compaction readouts, as STRINGS.
   *
   * Tweakpane's monitor bindings show a number as a graph or a slider; these are
   * bound as text so they read as a diagnostic rather than as something to drag.
   * Written by `setCompactionStats` once per frame and never by the user.
   *
   * THE THREE SWITCHES ARE SEEDED FROM THE SESSION in the constructor, not
   * here. They are persisted now (see `SandSession`), and a panel built showing
   * `false` while the orchestrator ran with the restored value would be a
   * checkbox that lies until the user touches something else.
   */
  private readonly poolValues: Record<string, string | boolean> = {
    live: '—',
    mark: '—',
    occupancy: '—',
    sweep: 'idle',
    autoCompact: false,
    compactionPaused: false,
    auditAfterSweep: false,
  };
  /** Refreshed per frame, but only when a displayed value actually moved. */
  private poolFolder: FolderApi | null = null;

  /**
   * The five world buttons' assignments, mirrored for Tweakpane to bind.
   *
   * Rebuilt into the dropdowns by `refreshWorlds`, because Tweakpane takes its
   * `options` at bind time and a saved world added later would otherwise not
   * appear until a reload.
   */
  private readonly worldValues: Record<string, string> = {};
  /** The world dropdown blades, kept so they can be rebuilt on a save. */
  private worldFolder: FolderApi | null = null;
  private worldNames: readonly string[] = [];

  constructor(
    prefs: Preferences,
    palette: Palette,
    maxParticles: number,
    initial: {
      theme: string;
      visibleCount: number;
      /** The five assignments, restored from the session. */
      worlds: readonly string[];
      /** The compaction switches, restored from the session. */
      autoCompact: boolean;
      compactionPaused: boolean;
      auditAfterSweep: boolean;
      /** The colour mode, restored from the session. */
      colorMode: ColorMode;
    },
    callbacks: SandPrefsCallbacks,
  ) {
    this.committed = prefs;
    this.committedMaxParticles = maxParticles;
    this.devValues = {
      maxParticles,
      theme: initial.theme,
      visibleCount: initial.visibleCount,
    };
    // BEFORE `buildPool`, which binds the checkboxes to these keys -- Tweakpane
    // reads the bound value at bind time, so seeding afterwards would build the
    // panel showing `false` and only correct itself on the next refresh.
    this.poolValues['autoCompact'] = initial.autoCompact;
    this.poolValues['compactionPaused'] = initial.compactionPaused;
    this.poolValues['auditAfterSweep'] = initial.auditAfterSweep;
    // Likewise before `buildColor` binds the dropdown to it.
    this.colorValues['mode'] = initial.colorMode;
    this.palette = palette;
    this.callbacks = callbacks;
    this.prefValues = { ...prefs } as Record<string, unknown>;
    for (let i = 0; i < ASSIGNABLE_WORLDS; i++) {
      this.worldValues[worldKey(i)] = initial.worlds[i] ?? NO_WORLD;
    }

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

    this.buildColor(page);
    this.buildWorlds(page);
    this.buildPool(page);
  }

  /**
   * The Colour folder: which mode, and the selected swatch's colour.
   *
   * ## Why the picker follows the SELECTION rather than listing forty
   *
   * Forty colour inputs would be forty blades in a 280px panel, and thirty-nine
   * of them describe a swatch the user is not looking at. The tray is already
   * the place a swatch is chosen -- and it is one click away -- so the picker
   * edits whichever one is selected and the tray tints itself to show the
   * result. That makes colouring a palette the same gesture as filling it:
   * click the swatch, set the thing.
   *
   * The label names the slot so the picker cannot be mistaken for a global.
   */
  private buildColor(page: TabPageApi): void {
    const folder = page.addFolder({ title: 'Colour', expanded: true });
    this.colorFolder = folder;

    const modeBlade = folder.addBinding(this.colorValues, 'mode', {
      label: 'Colour by',
      options: Object.fromEntries(
        COLOR_MODES.map((m) => [COLOR_MODE_LABELS[m], m]),
      ),
    });
    modeBlade.element.title =
      'How each particle is coloured.\n' +
      'Behavior: hue from the rule’s own output — the original look.\n' +
      'Cohort: hue by sub-population, for telling one config’s cohorts apart.\n' +
      'Swatch: the colour set below, for telling MATERIALS apart.\n' +
      '\n' +
      'Behavior and Cohort read each config’s own Color Sensitivity and Color ' +
      'Offset (Config tab) as hue = Sensitivity × signal + Offset. Swatch uses ' +
      'neither — its colour was chosen outright, below.\n' +
      '\n' +
      'A display choice: it applies immediately, including while paused.';
    modeBlade.on('change', () => {
      this.callbacks.onColorMode(asColorMode(this.colorValues['mode']));
    });

    // THE PICKER. `<input type="color">` under the hood, which is why the model
    // speaks hex here and hue/saturation everywhere else -- see `swatchColor.ts`.
    const colorBlade = folder.addBinding(this.colorValues, 'swatch', {
      label: 'Swatch colour',
      view: 'color',
    });
    this.colorBlade = colorBlade;
    colorBlade.element.title =
      'The colour particles painted from the SELECTED swatch render in, under ' +
      'Colour by: Swatch. Saved with the world. Value is ignored — brightness ' +
      'belongs to the frame, not to one material — so a dark pick returns its ' +
      'hue and saturation at full value.';
    colorBlade.on('change', () => {
      const parsed = swatchColorFromCss(String(this.colorValues['swatch']));
      if (parsed === null) return;
      // A GREY PICK KEEPS THE STORED HUE. Every hue is equally correct at zero
      // saturation, so resetting it to red would make the hue jump the moment
      // the user dragged saturation to zero and then back up.
      const current = this.palette.colorOf(this.palette.selected);
      const color =
        parsed.saturation === 0 ? { hue: current.hue, saturation: 0 } : parsed;
      this.callbacks.onSwatchColor(this.palette.selected, color);
    });
  }

  /**
   * Point the picker at the selected swatch, and relabel it.
   *
   * Called from `syncConfig`, which already runs per frame and already knows
   * when the selection moved -- so this costs a comparison in the common case.
   *
   * NOT WHILE THE PICKER IS OPEN: Tweakpane's colour input is a popup, and
   * rewriting its bound value mid-drag would fight the user's pointer. The
   * selection cannot change while it is open anyway (the tray is behind it),
   * but the guard makes that a fact rather than a coincidence.
   */
  private syncSwatchColor(): void {
    const slot = this.palette.selected;
    const css = swatchColorToCss(this.palette.colorOf(slot));
    if (css === this.colorValues['swatch'] && slot === this.shownColorSlot) return;
    this.shownColorSlot = slot;
    this.colorValues['swatch'] = css;
    // NAMED FOR THE SLOT, so the picker cannot be mistaken for a global
    // setting. Through the blade's own `label`, not by rewriting the DOM:
    // Tweakpane's internal class names are not ours to depend on.
    const key = keyLabel(slot);
    const blade = this.colorBlade;
    if (blade !== null) {
      blade.label = `Swatch ${key === '' ? `#${slot + 1}` : key}`;
    }
    this.colorFolder?.refresh();
  }

  /**
   * Adopt a colour mode set from outside the panel -- a world load.
   *
   * The same second-writer problem `adoptPreferences` solves: the dropdown
   * binds to a mirror, so a world that set the mode would leave the panel
   * showing the old one until the next touch.
   */
  adoptColorMode(mode: ColorMode): void {
    this.colorValues['mode'] = mode;
    this.colorFolder?.refresh();
  }

  /**
   * The Worlds folder: save one, load one, and point the five buttons at them.
   *
   * ## This is the level editor, and it is dev-only on purpose
   *
   * The shipping app offers six world buttons and nothing else. Everything here
   * is the other half: the tools for AUTHORING what those buttons load. Saving a
   * world, browsing the library, deleting from it, and deciding which save each
   * button points at are all acts a player never performs.
   *
   * Placed above the particle pool because it is the reason to open this tab,
   * where the pool readouts are consulted when something is slow.
   */
  private buildWorlds(page: TabPageApi): void {
    const folder = page.addFolder({ title: 'Worlds', expanded: true });
    this.worldFolder = folder;

    const save = folder.addButton({ title: 'Save world as…' });
    save.element.title =
      'Save the palette, the preferences and the current initial conditions ' +
      'as a named world. Saving over an existing name asks first.';
    save.on('click', () => this.promptSaveWorld());

    const load = folder.addButton({ title: 'Load world' });
    load.element.title =
      'Open the world library. Loading one replaces the palette, the ' +
      'preferences and the initial conditions — it is how a world is edited. ' +
      'Worlds are deleted from here too.';
    load.on('click', () => this.callbacks.onOpenWorldLibrary());

    this.buildWorldSlots(folder);
  }

  /**
   * The five "which save does button N load" dropdowns.
   *
   * ## Rebuilt rather than refreshed, and why that is not a smell
   *
   * Tweakpane fixes a binding's `options` when the blade is created, so a world
   * saved after this folder was built would not appear in the list. The blades
   * are therefore disposed and recreated whenever the library changes, which is
   * the same call `rebuildConfig` makes for the same framework reason.
   *
   * The alternative -- a text field where the user types a name -- would not
   * need rebuilding and would let them point a button at a world that does not
   * exist, which is exactly the dangling reference the dropdown prevents.
   */
  private buildWorldSlots(folder: FolderApi): void {
    // The options map Tweakpane wants: label -> value. NONE FIRST, so
    // unassigning is the top entry rather than buried under the saves.
    const options: Record<string, string> = { 'None': NO_WORLD };
    for (const name of this.worldNames) options[name] = name;

    for (let i = 0; i < ASSIGNABLE_WORLDS; i++) {
      const key = worldKey(i);
      // A STORED NAME THAT NO LONGER EXISTS is kept as an option rather than
      // silently reset, so a button assigned to a world that was deleted shows
      // what it is pointing at instead of quietly reading "None". The panel
      // marks it as missing; see `SandUi`.
      const current = this.worldValues[key] ?? NO_WORLD;
      if (current !== NO_WORLD && !(current in options)) {
        options[`${current} (missing)`] = current;
      }

      const blade = folder.addBinding(this.worldValues, key, {
        label: `World ${i + 1}`,
        options,
      });
      blade.element.title =
        `Which saved world the panel's World ${i + 1} button loads. ` +
        'None leaves the button empty.';
      blade.on('change', () => {
        this.callbacks.onAssignWorld(i, String(this.worldValues[key] ?? NO_WORLD));
      });
    }
  }

  /**
   * Re-read the library and rebuild the dropdowns.
   *
   * Called after a save or a delete, because both change which names the five
   * buttons may point at -- and a dropdown built before a save would not offer
   * the world the user just created, which is the first thing they would try to
   * assign it to.
   */
  refreshWorlds(names: readonly string[], assignments: readonly string[]): void {
    this.worldNames = names;
    for (let i = 0; i < ASSIGNABLE_WORLDS; i++) {
      this.worldValues[worldKey(i)] = assignments[i] ?? NO_WORLD;
    }
    const folder = this.worldFolder;
    if (folder === null) return;
    // The two buttons are children 0 and 1; everything after them is a
    // dropdown from the previous build. Disposing from the end keeps the
    // indices stable as they go.
    for (let i = folder.children.length - 1; i >= 2; i--) {
      folder.children[i]?.dispose();
    }
    this.buildWorldSlots(folder);
  }

  /**
   * Collect a name for a new world, and confirm an overwrite.
   *
   * THE OVERWRITE PROMPT IS HERE rather than in the store, matching
   * `ConfigStore.write`'s stance: the store does what it is told, and "are you
   * sure" belongs where the user can see what they are about to replace.
   *
   * `nameTaken` is supplied by the host rather than read from a store this class
   * holds, which keeps `SandPrefs` free of storage entirely -- it builds panels
   * and issues callbacks, and that is all it has ever done.
   */
  private promptSaveWorld(): void {
    const name = window.prompt('Save world as:', '');
    if (name === null) return;
    const trimmed = name.trim();
    if (trimmed === '') return;
    if (
      this.worldNames.includes(trimmed) &&
      !window.confirm(`"${trimmed}" already exists. Replace it?`)
    ) {
      return;
    }
    this.callbacks.onSaveWorld(trimmed);
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
      'Compaction packs the live particles to the front of the buffer so the ' +
      'mark can fall. It runs entirely on the GPU in a single frame, which ' +
      'that frame gives up its physics step for. Nothing can interrupt it.';

    // AUTOMATIC COMPACTION. Fires when occupancy drops below 70% and the mark
    // is large enough for the saving to be worth a frame, with a cooldown so a
    // world being actively painted cannot compact every few frames.
    //
    // No quiet period, unlike the incremental sweep this replaced: that had to
    // wait for the brush to stop, because a stroke would abort a sweep and the
    // abort was expensive. A GPU compaction takes one frame on which the brush
    // simply does not run.
    const auto = folder.addBinding(this.poolValues, 'autoCompact', {
      label: 'Auto compact',
    });
    auto.element.title =
      'Compact automatically when the buffer falls below 70% occupancy. Costs ' +
      'one frame, which skips its physics step, and waits two seconds between ' +
      'compactions so painting cannot trigger a run of them.';
    auto.on('change', () => {
      this.callbacks.onAutoCompact(Boolean(this.poolValues['autoCompact']));
    });

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
      'Pack the live particles to the front of the buffer and rebuild the ' +
      'free list, so every pass stops sweeping dead slots. Runs on the GPU in ' +
      'one frame, which skips its physics step. No readback, nothing to ' +
      'interrupt.';
    button.on('click', () => this.callbacks.onCompactNow());

    // THE AUDIT BUTTON. Reads both buffers back and checks the pool's
    // invariants, so a suspicion becomes a specific, named violation with a
    // count. Every compaction bug so far has been one of these, found by eye
    // and reported after the fact -- this is what closes that gap.
    //
    // The full report goes to the CONSOLE, not the status line: it is several
    // lines with example indices, and it is worth keeping a scrollback of.
    // AUDIT AUTOMATICALLY AFTER EVERY SWEEP. The single most useful setting
    // here while hunting: a violation is reported the instant the operation
    // that caused it finishes, rather than whenever someone thinks to press the
    // button. Without it the evidence of WHICH operation broke things is gone
    // by the time the symptom is visible.
    //
    // Off by default because it stalls the pipeline once per sweep.
    const afterSweep = folder.addBinding(this.poolValues, 'auditAfterSweep', {
      label: 'Audit after sweep',
    });
    afterSweep.element.title =
      'Run the audit automatically whenever a sweep ends, aborted or ' +
      'completed, and log the result. Catches a violation at the moment it ' +
      'appears instead of minutes later. Costs one pipeline stall per sweep.';
    afterSweep.on('change', () => {
      this.callbacks.onAuditAfterSweep(Boolean(this.poolValues['auditAfterSweep']));
    });

    const audit = folder.addButton({ title: 'Audit pool' });
    audit.element.title =
      'Read the entity buffer and the free list and check that they agree: ' +
      'no live index offered as free, no double frees, no leaked dead slots, ' +
      'and nothing alive above the mark. Full report in the console. ' +
      'STALLS THE PIPELINE — it is a diagnostic, not a frame-path operation.';
    audit.on('click', () => this.callbacks.onAuditPool());
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
    compactPending: boolean;
    autoCompact: boolean;
  }): void {
    // ONE FRAME, so there is no progress to show -- only whether a compaction
    // is queued for the next frame or nothing is happening.
    const sweep = stats.compactPending ? 'queued' : 'idle';
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
      stats.autoCompact === this.poolValues['autoCompact'] &&
      stats.paused === this.poolValues['compactionPaused']
    ) {
      return;
    }

    this.poolValues['live'] = live;
    this.poolValues['mark'] = mark;
    this.poolValues['occupancy'] = occ;
    this.poolValues['sweep'] = sweep;
    this.poolValues['autoCompact'] = stats.autoCompact;
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
    // THE PICKER FOLLOWS THE SELECTION, and is checked before the early return
    // below -- a swatch's colour can change without its generation moving (the
    // picker itself does exactly that, and `setColor` deliberately does not
    // bump), so gating this on the same guard would leave the input stale.
    this.syncSwatchColor();

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
    //
    // THE APPEARANCE SETTINGS ARE NOT AMONG THEM, and this note said otherwise
    // for exactly as long as the camera took one Color Sensitivity per frame
    // from the master. It reads the whole table per particle now
    // (`palette.appearanceForUpload`), so every square's Color Sensitivity and
    // Color Offset govern its own material. Naming them here again would send
    // an author to the master square to change a colour that is not there.
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

  /**
   * Adopt preferences changed from outside the panel, and redraw the sliders.
   *
   * ## Why loading a world needs this
   *
   * Every blade here binds to `prefValues`, a plain mirror the panel writes and
   * reads. Nothing watches the real `Preferences` -- there was never a second
   * writer, so there was nothing to watch for.
   *
   * A world load is that second writer. Without this the simulation would adopt
   * the world's physics rate while the Prefs tab kept showing the old one, and
   * the next touch of any OTHER slider would commit the whole stale mirror back
   * over the world's values -- silently undoing most of what was just loaded.
   *
   * `committed` moves too, not just the mirror: it is what each blade diffs
   * against when it builds the next `Preferences`, so leaving it behind would
   * reintroduce the same staleness one layer down.
   */
  adoptPreferences(prefs: Preferences): void {
    this.committed = prefs;
    for (const [key, value] of Object.entries(prefs)) {
      this.prefValues[key] = value;
    }
    // The whole pane, because a world may have moved several preferences at
    // once and they are spread across every folder.
    this.pane.refresh();
  }

  dispose(): void {
    this.pane.dispose();
  }
}

/**
 * The mirror key for world button `i`.
 *
 * Tweakpane binds to a property NAME on an object, so the five dropdowns need
 * five distinct keys. Derived rather than written out, so the count lives only
 * in `ASSIGNABLE_WORLDS`.
 */
function worldKey(index: number): string {
  return `world${index + 1}`;
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
