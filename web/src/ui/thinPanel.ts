/**
 * The thin UI: a flat Tweakpane dump of the settings registry.
 *
 * ## What "thin" means, and why it is the plan's choice
 *
 * Milestone 1 is **engine-first with a thin UI** -- "a flat Tweakpane dump of
 * the registry, no tabs/gates/tooltips/menus -- so physics parity is never
 * blocked on UI design questions" (the port plan's decisions section). This
 * file is that, deliberately and completely:
 *
 *   - bindings are driven by `kind`/`lo`/`hi`/`options` and nothing else
 *   - `group` becomes a plain folder, not the desktop's collapsible tabs
 *   - `tier` is honoured by ONE checkbox at the top, not by per-control gating
 *   - `revealsOn`, `gates`, `curve` and `inverted` are IGNORED (all Step 10)
 *   - GATED controls render as plain sliders (see below)
 *
 * **Step 10 rebuilds this properly on the proven engine.** Everything it needs
 * is already in the registry; nothing here has to be un-learned.
 *
 * ## The one degradation worth stating out loud
 *
 * A GATED control on the desktop hides itself behind a checkbox while it sits
 * at `gateBase`. Rendering it as a plain slider is the CORRECT degradation
 * rather than a compromise, and for a specific reason: **on/off is derived from
 * the value itself, so nothing extra is stored** (`gated_controls.py`). The
 * stored value, the save format, undo and preview are all identical either way
 * -- only the widget differs. A gate that stored a flag would not be safe to
 * skip; this one is.
 *
 * `curve` and `inverted` are different, and this file's honesty about them
 * matters: they change WHAT VALUE a given slider position produces. Ignoring
 * them here means Hazard Rate's slider is linear rather than cubed and Trail
 * Stiffness reads as its stored diffusion -- the values are still correct and
 * still save correctly, the travel just is not shaped yet. Step 10 supplies the
 * shaping. **What would be a bug is applying one of them and not the other on
 * the way back out**, which is why neither is applied here.
 *
 * ## How it drives the engine
 *
 * Through `CommandBus` and nothing else -- no `Orchestrator` import, no
 * `ParticleSystem`, no `Project`. That is invariant 10 as a type: this file
 * *cannot* reach simulation state, because it holds nothing that leads there.
 * The desktop enforces the same rule by convention and a lint (`ui/` imports no
 * simulation module) and pays for it with two untyped string dicts; here the
 * boundary is `commands.ts` and the compiler checks both sides.
 */

import { Pane } from 'tweakpane';
import type { FolderApi } from 'tweakpane';
import {
  type Command,
  type CommandBus,
  type MouseMode,
  type Status,
  MOUSE_MODES,
} from '../orchestrator/commands.ts';
import {
  type Setting,
  type Source,
  BOOL,
  CHOICE,
  CONFIG,
  GATED,
  GATED_INT,
  INPUT,
  INT,
  PREFS,
  SEED,
  SLIDER,
  WORLD,
  grouped,
} from './settingsSpec.ts';

/**
 * Which status payload a source's current value comes from.
 *
 * The three payloads are separate because their SAVE semantics differ, not
 * because their contents do -- so reading them is one lookup keyed by source.
 */
function currentValues(status: Status, source: Source): Readonly<Record<string, number | boolean>> {
  if (source === CONFIG) return status.editConfig;
  if (source === WORLD) return status.editWorld;
  return status.editPrefs;
}

/**
 * A binding's proxy object.
 *
 * **Tweakpane binds to a mutable property**, and the app's state is immutable
 * and lives behind the command bus. So each control gets a one-property object
 * that Tweakpane writes into, and an `on('change')` that turns the write into a
 * command. `refresh()` then pushes the authoritative value back in, which is
 * what makes undo, preset loads and randomize show up in the panel without the
 * panel knowing any of them happened.
 *
 * The alternative -- binding straight to a mutable settings object -- would
 * make the panel a second source of truth, and the first divergence would be
 * silent.
 */
interface Binding {
  readonly setting: Setting;
  /** The object Tweakpane writes into. One key: `value`. */
  readonly proxy: { value: number | boolean };
  /** Push the authoritative value back into the proxy. */
  refresh(status: Status): void;
}

export interface ThinPanelOptions {
  readonly bus: CommandBus;
  /** Where to mount. Defaults to a fixed-position container on the right. */
  readonly container?: HTMLElement;
  /** Start with ADVANCED settings shown. Defaults to false, like the desktop. */
  readonly advanced?: boolean;
}

/**
 * The panel. Built once, refreshed every frame from `status()`.
 *
 * Rebuilt WHOLESALE when the tier changes, because Tweakpane has no "hide this
 * blade" that survives a folder rebuild cleanly and the tier switch is a rare,
 * deliberate act. Per-frame refresh never rebuilds anything.
 */
export class ThinPanel {
  private readonly bus: CommandBus;
  private readonly container: HTMLElement;
  private pane: Pane;
  private bindings: Binding[] = [];
  private advanced: boolean;

  /**
   * True while `refresh()` is writing authoritative values into the proxies.
   *
   * **THE FEEDBACK LOOP THIS CLOSES.** Tweakpane is retained-mode: writing a
   * proxy and calling `pane.refresh()` makes it fire `change` on every binding
   * whose value moved -- and it cannot distinguish a value the USER dragged
   * from one the APP just pushed in. Without this guard, loading a preset feeds
   * that preset's own values straight back through `editSetting`, so a single
   * `Next >` recorded FOUR history entries (measured: depth 1 -> 5) and the top
   * of the undo stack read "edit Sensor Distance". Undo then stepped back
   * through those phantom edits instead of unloading the preset, which looks
   * exactly like "undo is broken" and is not.
   *
   * The desktop has no equivalent hazard: imgui is immediate-mode, so a widget
   * reports a change only when the user actually moves it. This is a real
   * difference between the two UI models, not a Tweakpane quirk, and Step 10
   * inherits it -- any retained-mode binding needs this guard.
   */
  private refreshing = false;

  /** Set by `X`, through `setHidden`. See `hidden`. */
  private hiddenFlag = false;

  /**
   * Monitors -- read-only rows -- are refreshed by writing into these proxies,
   * the same trick the bindings use. Separate because they never dispatch.
   */
  private readonly readout = {
    preset: '',
    project: '',
    frame: 0,
    entities: 0,
    canvas: '',
    selected: '-',
    history: '',
    saveError: '',
    configBusy: '',
  };

  /**
   * Mirrors of state the panel both shows and sets. Tweakpane needs a mutable
   * property for a binding, so these exist for the same reason `Binding.proxy`
   * does -- `refresh()` overwrites them from `status()` every frame, so they
   * cannot drift.
   */
  private readonly toggles = {
    paused: false,
    tool: 'select' as MouseMode,
    camera: 'particles',
    advancedTier: false,
  };

  /**
   * The save dialog's name field, such as it is in a thin panel.
   *
   * NOT REFRESHED FROM STATUS, unlike everything else here -- it is the user's
   * own text, and overwriting it each frame would make it impossible to type in.
   * The real dialog is Step 10's; this is enough to drive the storage path and
   * to let `configCheck.mjs` save something.
   */
  private readonly saveAs = { name: '' };

  constructor(opts: ThinPanelOptions) {
    this.bus = opts.bus;
    this.advanced = opts.advanced ?? false;
    this.toggles.advancedTier = this.advanced;
    this.container = opts.container ?? defaultContainer();
    this.pane = this.build();
  }

  /** Tear down and rebuild, after a tier change. */
  private rebuild(): void {
    this.pane.dispose();
    this.bindings = [];
    this.pane = this.build();
  }

  private build(): Pane {
    const pane = new Pane({ container: this.container, title: 'Fluoddity' });
    const status = this.bus.status();

    this.buildTransport(pane, status);
    this.buildSettings(pane, status);
    this.buildReadout(pane);

    // Seed every proxy from the real value rather than the zero it was
    // constructed with -- otherwise the first frame shows a panel full of
    // defaults that do not match the loaded preset.
    //
    // Writes through the LOCAL `pane`, not `this.pane`: during construction
    // `this.pane` is not assigned yet (the constructor assigns what this
    // returns), so calling the public `refresh()` here reads `undefined`. That
    // is a real crash rather than a stale value, and it only reproduces in a
    // browser, so `browserCheck.mjs` is what caught it.
    this.refreshing = true;
    try {
      this.applyStatus(status);
      pane.refresh();
    } finally {
      this.refreshing = false;
    }
    return pane;
  }

  /** Transport, tool, camera and the one-shot buttons. */
  private buildTransport(pane: Pane, status: Status): void {
    const folder = pane.addFolder({ title: 'Transport' });

    this.toggles.paused = status.paused;
    folder
      .addBinding(this.toggles, 'paused', { label: 'Paused' })
      .on('change', (ev) => {
        if (this.refreshing) return;
        // Dispatched as a TOGGLE rather than a set, because that is the command
        // the desktop has. Compared against the LIVE status rather than the
        // captured one, so a pause toggled from anywhere else cannot make this
        // fire a second time and undo it.
        if (ev.value !== this.bus.status().paused) this.send({ kind: 'togglePause' });
      });

    this.toggles.tool = status.mouseMode;
    folder
      .addBinding(this.toggles, 'tool', {
        label: 'Tool',
        options: Object.fromEntries(
          MOUSE_MODES.map((m) => [m[0]!.toUpperCase() + m.slice(1), m]),
        ),
      })
      .on('change', (ev) => {
        if (this.refreshing) return;
        this.send({ kind: 'setMouseMode', mode: ev.value as MouseMode });
      });

    folder.addButton({ title: 'Reset Simulation' }).on('click', () => {
      this.send({ kind: 'reset' });
    });
    folder.addButton({ title: 'Toggle Camera Mode' }).on('click', () => {
      this.send({ kind: 'toggleCameraMode' });
    });
    folder.addButton({ title: 'Reset Camera' }).on('click', () => {
      this.send({ kind: 'resetCamera' });
    });

    const presets = pane.addFolder({ title: 'Presets', expanded: false });
    // Flat buttons rather than a dropdown, and BUILT ONCE at construction. The
    // catalog grows when the user saves, so this list goes stale until the page
    // reloads -- accepted here because rebuilding a Tweakpane folder mid-session
    // is Step 10's problem along with the real load menu. The Save folder below
    // says so where a user would notice.
    presets.addButton({ title: '< Prev' }).on('click', () => {
      this.send({ kind: 'prevPreset' });
    });
    presets.addButton({ title: 'Next >' }).on('click', () => {
      this.send({ kind: 'nextPreset' });
    });
    for (const [category, names] of Object.entries(status.configCategories)) {
      for (const name of names) {
        presets
          .addButton({ title: name, label: category })
          .on('click', () => {
            // (category, name), not just the name: two categories may hold the
            // same name, and the identity is the pair.
            this.send({ kind: 'loadConfig', category, name });
          });
      }
    }

    const save = pane.addFolder({ title: 'Save', expanded: false });
    save.addBinding(this.saveAs, 'name', { label: 'Name' });
    save.addButton({ title: 'Save to Custom' }).on('click', () => {
      // No `refreshing` guard needed: a button's click is always the user's.
      // The guard exists for BINDINGS, whose `change` fires on a programmatic
      // refresh too.
      this.send({ kind: 'saveConfig', name: this.saveAs.name });
    });
    save.addButton({ title: 'Revert to Saved' }).on('click', () => {
      this.send({ kind: 'revertConfig' });
    });
    save.addButton({ title: 'Delete (Custom)' }).on('click', () => {
      this.send({ kind: 'deleteConfig', category: 'Custom', name: this.saveAs.name });
    });

    const edit = pane.addFolder({ title: 'Edit', expanded: false });
    edit.addButton({ title: 'Undo' }).on('click', () => {
      this.send({ kind: 'undo' });
    });
    edit.addButton({ title: 'Redo' }).on('click', () => {
      this.send({ kind: 'redo' });
    });
    edit.addButton({ title: 'Randomize Behavior' }).on('click', () => {
      this.send({ kind: 'randomizeBehavior' });
    });
    edit.addButton({ title: 'Checkpoint' }).on('click', () => {
      this.send({ kind: 'setCheckpoint' });
    });
    edit.addButton({ title: 'Restore Latest Checkpoint' }).on('click', () => {
      this.send({ kind: 'loadLatestCheckpoint' });
    });

    folder
      .addBinding(this.toggles, 'advancedTier', { label: 'Advanced' })
      .on('change', (ev) => {
        if (this.refreshing) return;
        if (ev.value === this.advanced) return;
        this.advanced = ev.value;
        // Deferred: disposing the pane from inside its own event handler
        // reenters Tweakpane's own teardown. A microtask is enough.
        queueMicrotask(() => {
          this.rebuild();
        });
      });
  }

  /** Every registry entry, grouped by `group`, in declaration order. */
  private buildSettings(pane: Pane, status: Status): void {
    for (const [group, settings] of grouped(this.advanced, [CONFIG, WORLD, PREFS])) {
      const folder = pane.addFolder({ title: group || 'Settings' });
      for (const setting of settings) {
        this.addControl(folder, setting, status);
      }
    }
  }

  /**
   * One control, by `kind`.
   *
   * The `field: ''` case is skipped: the Gravity entry is a pure gate that
   * "is not itself a saved setting" and stores nothing (`settings_spec.py:263`).
   * With gating unimplemented it would be a checkbox that does nothing at all,
   * which is worse than its absence. Step 10 gives it its job back.
   */
  private addControl(folder: FolderApi, setting: Setting, status: Status): void {
    if (setting.field === '') return;

    if (setting.kind === SEED) {
      // A Randomize button with the value shown beside it: the seed is an
      // opaque selector into rule-variation space, so it is worth reading but
      // never worth typing.
      folder.addButton({ title: 'Randomize', label: setting.label }).on('click', () => {
        this.send({ kind: 'randomizeSeed' });
      });
      return;
    }

    const values = currentValues(status, setting.source);
    const initial = values[setting.field] ?? 0;
    const proxy = { value: initial };

    const params = paramsFor(setting);
    const blade = folder.addBinding(proxy, 'value', { label: setting.label, ...params });
    // The help text, free. Tweakpane has no tooltip API, so it rides the DOM
    // `title` attribute -- which is not the desktop's rich tooltip and is not
    // pretending to be. Step 10 owns the real ones.
    if (setting.help !== '') {
      (blade.element as HTMLElement).title = setting.help;
    }
    if (!setting.implemented) {
      blade.disabled = true;
    }

    blade.on('change', (ev) => {
      // Not a user edit: `refresh()` is pushing the authoritative value in.
      // See `refreshing` for what happens without this.
      if (this.refreshing) return;
      this.send({
        kind: 'editSetting',
        setting,
        value: ev.value as number | boolean,
      });
    });

    this.bindings.push({
      setting,
      proxy,
      refresh: (s) => {
        const authoritative = currentValues(s, setting.source)[setting.field];
        if (authoritative !== undefined) proxy.value = authoritative;
      },
    });
  }

  /** Read-only rows. The desktop's Debug panel, minus everything decorative. */
  private buildReadout(pane: Pane): void {
    const folder = pane.addFolder({ title: 'Status', expanded: false });
    folder.addBinding(this.readout, 'preset', { readonly: true, label: 'Preset' });
    folder.addBinding(this.readout, 'project', { readonly: true, label: 'Project' });
    folder.addBinding(this.readout, 'frame', { readonly: true, label: 'Frame' });
    folder.addBinding(this.readout, 'entities', { readonly: true, label: 'Entities' });
    folder.addBinding(this.readout, 'canvas', { readonly: true, label: 'Canvas' });
    folder.addBinding(this.readout, 'selected', { readonly: true, label: 'Selected' });
    folder.addBinding(this.readout, 'history', { readonly: true, label: 'History' });
    folder.addBinding(this.readout, 'saveError', { readonly: true, label: 'Message' });
    // Storage is async and `dispatch` returns void, so this row is how a load or
    // a save that has not landed yet reports itself. Read from status every
    // frame, like everything else here.
    folder.addBinding(this.readout, 'configBusy', { readonly: true, label: 'Storage' });
  }

  /**
   * Push this frame's status into every proxy.
   *
   * Called once per frame, AFTER the Orchestrator has run -- so what the panel
   * shows is what the simulation actually holds, including changes the panel
   * did not cause (undo, a preset load, randomize). That is the whole reason
   * the bindings are proxies rather than direct.
   *
   * `pane.refresh()` is what makes Tweakpane re-read them.
   */
  refresh(status: Status): void {
    // A hidden panel refreshes nothing: `pane.refresh()` walks every binding
    // and re-reads every proxy, which is real per-frame work to update widgets
    // nobody can see. The next `setHidden(false)` is followed by the frame
    // loop's own `refresh()`, so what reappears is current rather than stale.
    if (this.hiddenFlag) return;

    // `pane.refresh()` fires `change` on every binding whose value moved, and
    // cannot tell an app-pushed value from a user-dragged one. The flag is what
    // tells the handlers apart -- see `refreshing`. `finally` because a throw
    // inside a binding's handler would otherwise wedge the panel permanently
    // read-only, which is worse than the bug it guards.
    this.refreshing = true;
    try {
      this.applyStatus(status);
      this.pane.refresh();
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Write `status` into every proxy, without touching the pane.
   *
   * Split out from `refresh()` so `build()` can seed the proxies before
   * `this.pane` exists -- see the note at its call site.
   */
  private applyStatus(status: Status): void {
    for (const binding of this.bindings) binding.refresh(status);

    this.toggles.paused = status.paused;
    this.toggles.tool = status.mouseMode;
    this.toggles.camera = status.camMode;

    this.readout.preset = status.preset;
    this.readout.project = status.projectName;
    this.readout.frame = status.frameCount;
    this.readout.entities = status.entityCount;
    this.readout.canvas = status.canvasSize;
    this.readout.selected = describeSelected(status);
    this.readout.history = `${status.historyCursor + 1}/${status.historyDepth}` +
      (status.undoLabel === '' ? '' : `  (undo: ${status.undoLabel})`);
    this.readout.saveError = status.saveError;
    this.readout.configBusy = status.configBusy;
  }

  /**
   * Whether the panel is open, so the Orchestrator can skip building payloads.
   *
   * Hiding it counts as closed: `_settings_dicts`'s closed-panel optimization
   * exists so a panel nobody can see does not cost a payload per frame, and a
   * hidden panel is exactly that case.
   */
  get isOpen(): boolean {
    return !this.hidden;
  }

  /**
   * Whether `X` has hidden the panel. The port of `ui.py`'s `gui_hidden`.
   *
   * Handled by the UI rather than through the command bus, as the desktop does
   * (`ui.py:471-473`): no simulation state changes, so there is nothing for the
   * Orchestrator to broker -- "rule 10 cuts both ways".
   */
  get hidden(): boolean {
    return this.hiddenFlag;
  }

  /**
   * Show or hide the panel.
   *
   * `display` rather than removing the container, so Tweakpane keeps its DOM
   * and its state -- an open folder stays open across a hide, and no binding is
   * rebuilt. It also means a hidden panel cannot hold focus, so the hotkey
   * table's editable-target gate cannot be tripped by an input nobody can see.
   */
  setHidden(hidden: boolean): void {
    this.hiddenFlag = hidden;
    this.container.style.display = hidden ? 'none' : '';
  }

  dispose(): void {
    this.pane.dispose();
    this.container.remove();
  }

  private send(command: Command): void {
    this.bus.dispatch(command);
  }
}

/**
 * Tweakpane binding params for one registry entry.
 *
 * GATED and GATED_INT fall through to their ungated equivalents -- see the file
 * header for why that is safe. CHOICE builds its options from the registry
 * tuple, **indexed by position**, because the index IS the stored value and
 * must stay in lockstep with the `BC_*`/`IC_*` constants.
 */
function paramsFor(setting: Setting): Record<string, unknown> {
  switch (setting.kind) {
    case BOOL:
      return {};

    case CHOICE:
      return {
        options: Object.fromEntries(setting.options.map((label, index) => [label, index])),
      };

    case INT:
    case GATED_INT:
      return { min: setting.lo, max: setting.hi, step: 1 };

    case INPUT:
      // A DISRUPTIVE setting: it reallocates GPU resources and resets the
      // simulation, so it must not be a slider -- dragging would rebuild on
      // every frame of the drag. A bare number input commits on Enter/blur.
      return { min: setting.lo, max: setting.hi };

    case SLIDER:
    case GATED:
    default:
      return { min: setting.lo, max: setting.hi };
  }
}

/**
 * The `selected` row, formatted as `ui.py:385-391` does: `#index (x, y) d=dist`,
 * `-` for nothing selected, `miss` for a click that found nothing in range.
 */
function describeSelected(status: Status): string {
  const result = status.selected;
  if (result === null) return '-';
  if (result.index < 0) return 'miss';
  return (
    `#${result.index} (${result.pos[0].toFixed(3)}, ${result.pos[1].toFixed(3)}) ` +
    `d=${result.distance.toFixed(4)}`
  );
}

/** A fixed-position container on the right, scrollable when the list is long. */
function defaultContainer(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'thin-panel';
  el.style.cssText =
    'position:fixed;top:8px;right:8px;width:320px;max-height:calc(100vh - 16px);' +
    'overflow-y:auto;z-index:20;';
  document.body.append(el);
  return el;
}
