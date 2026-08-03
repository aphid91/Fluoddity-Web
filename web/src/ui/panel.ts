/**
 * The panel: one docked side-panel built from sections.
 *
 * The port of `ui.py`'s `_build_ui` (`:274-297`) and the five window mixins it
 * calls. **Replaces `ui/thinPanel.ts`**, which was Step 7's flat registry dump.
 *
 * ## One panel, not five windows
 *
 * The desktop has five independent floating windows because they grew that way,
 * and `ARCHITECTURE.md`'s "Toolbar and the planned side-panel" names the
 * endpoint it wants instead: one docked side-panel whose visible controls follow
 * the active tool, with "each `_*_window()` body as a panel-*section*
 * function". Writing five floating panels here and merging them later would be
 * strictly more work than writing sections now, so this is sections from the
 * start. `panelModel.sectionsFor` is where the tool-selection decision will
 * land; nothing in this file has to move when it does.
 *
 * ## THE RETAINED-MODE FEEDBACK LOOP, and the flag that closes it
 *
 * **Tweakpane is retained-mode: writing a proxy and calling `pane.refresh()`
 * makes it fire `change` on every binding whose value moved -- and it cannot
 * distinguish a value the USER dragged from one the APP just pushed in.**
 * Without the `refreshing` guard, loading a preset feeds that preset's own
 * values straight back through `editSetting`, so a single `Next >` recorded
 * FOUR history entries (measured: depth 1 -> 5) and the top of the undo stack
 * read "edit Sensor Distance". Undo then stepped back through those phantom
 * edits instead of unloading the preset, which looks exactly like "undo is
 * broken" and is not.
 *
 * The desktop has no equivalent hazard: imgui is immediate-mode, so a widget
 * reports a change only when the user actually moves it. This is a real
 * difference between the two UI models, not a Tweakpane quirk, and **every
 * retained binding in every section needs the guard.**
 *
 * Verified in the bundle, because the fix depends on it: `pane.refresh()` ->
 * `BindingApi.refresh()` -> `fetch()` -> the plain `rawValue` setter, which
 * calls `setRawValue(v, {forceEmit: false, last: true})`. So a programmatic
 * refresh is indistinguishable from a released drag by `ev.last` alone -- which
 * is exactly why 10d's gated latch must test this flag FIRST and `ev.last`
 * second.
 */

import { Pane } from 'tweakpane';
import type { BladeApi, FolderApi } from 'tweakpane';
import type { Command, CommandBus, Status } from '../orchestrator/commands.ts';
import { type ControlBinding, currentValues } from './controls.ts';
import { Dialogs } from './dialogs.ts';
import { GateState } from './gateState.ts';
import { showsSlider } from './gatedControl.ts';
import { MenuBar } from './menuBar.ts';
import { isGated } from './gating.ts';
import { gateOpen, isRevealed } from './reveal.ts';
import type { Source } from './settingsSpec.ts';
import {
  DEBUG,
  DRAWING,
  PREFERENCES,
  PROJECT,
  TRANSPORT,
  sectionsFor,
} from './panelModel.ts';
import { type SectionContext, type SectionHandle } from './sections/section.ts';
import { Tooltip } from './tooltip.ts';
import { buildDebugSection } from './sections/debugSection.ts';
import { buildDrawingSection } from './sections/drawingSection.ts';
import { buildPreferencesSection } from './sections/preferencesSection.ts';
import { buildProjectSection } from './sections/projectSection.ts';
import { buildTransportSection } from './sections/transportSection.ts';

export interface PanelOptions {
  readonly bus: CommandBus;
  /** Where to mount. Defaults to a fixed-position container on the right. */
  readonly container?: HTMLElement;
  /** Start with ADVANCED settings shown. Defaults to false, like the desktop. */
  readonly advanced?: boolean;
}

export class Panel {
  private readonly bus: CommandBus;
  private readonly container: HTMLElement;
  private pane: Pane;
  private sections: SectionHandle[] = [];
  private advanced: boolean;

  /** See the file header. Read through `isRefreshing`, never captured. */
  private refreshing = false;

  /** Set by `X`, through `setHidden`. */
  private hiddenFlag = false;

  /**
   * The shared help tooltip.
   *
   * Owned by the panel rather than by a section, because there is exactly one on
   * screen at a time and it must outlive a tier rebuild -- it is attached to
   * `document.body`, not to the pane, so a `pane.dispose()` cannot orphan it.
   */
  private readonly tooltip = new Tooltip();

  /**
   * Gate and session state, for the derived checkboxes and (10d) the
   * self-hiding sliders.
   *
   * **Survives a tier rebuild**, unlike the panes and bindings: a forced-open
   * Gravity box should still be open after switching to Advanced, since nothing
   * about the values changed. `sync` is what retires it, and only a real project
   * or config change does that.
   */
  private readonly gates = new GateState();

  /**
   * The menu bar and the dialogs.
   *
   * Both live OUTSIDE the panel's container: the bar because it must stay
   * reachable while the panel is hidden (it holds the only visible way to bring
   * it back), and the dialogs because a modal that has taken input must not
   * vanish with a `setHidden` (`ui.py:274-289`).
   */
  private readonly dialogs: Dialogs;
  private readonly menuBar: MenuBar;

  constructor(opts: PanelOptions) {
    this.bus = opts.bus;
    this.advanced = opts.advanced ?? false;
    this.container = opts.container ?? defaultContainer();

    const send = (command: Command): void => {
      this.bus.dispatch(command);
    };
    this.dialogs = new Dialogs({ send });
    this.menuBar = new MenuBar({
      send,
      status: () => this.bus.status(),
      onSave: () => {
        this.dialogs.openSave(this.bus.status().projectName);
      },
      onDeleteConfig: (category, name) => {
        this.dialogs.openDelete(category, name);
      },
      onToggleUi: () => {
        this.setHidden(!this.hiddenFlag);
      },
      isUiHidden: () => this.hiddenFlag,
    });

    this.pane = this.build();
  }

  private build(): Pane {
    const pane = new Pane({ container: this.container, title: 'Fluoddity' });
    const status = this.bus.status();
    const ctx = this.context();

    this.sections = [];
    for (const section of sectionsFor(status.mouseMode, this.advanced)) {
      const folder = pane.addFolder({
        title: section.title,
        expanded: section.expanded,
      });
      (folder.element as HTMLElement).dataset['section'] = section.id;
      this.sections.push(buildSection(section.id, folder, status, ctx));
    }

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

  /** What every section and control is handed. Rebuilt per `build()`. */
  private context(): SectionContext {
    return {
      send: (command: Command) => {
        this.bus.dispatch(command);
      },
      // A function, not a snapshot: the flag flips during the panel's lifetime
      // and a captured boolean would read `false` forever.
      isRefreshing: () => this.refreshing,
      tooltip: this.tooltip,
      gates: this.gates,
      // A live read, never a captured snapshot: a click handler that closed over
      // the build frame's status would be answering with arbitrarily old values.
      status: () => this.bus.status(),
      advanced: this.advanced,
      requestRebuild: () => {
        this.advanced = !this.advanced;
        // Deferred: disposing the pane from inside its own event handler
        // reenters Tweakpane's own teardown. A microtask is enough.
        queueMicrotask(() => {
          this.rebuild();
        });
      },
    };
  }

  /**
   * Tear down and rebuild.
   *
   * **Reserved for the tier change**, which is a rare, deliberate act that
   * changes which controls exist at all. Per-frame refresh never rebuilds
   * anything, and 10c's reveal/gate visibility uses `blade.hidden` rather than
   * coming through here -- a rebuild would drop folder expansion state and
   * replace every DOM node, which is both visible and expensive.
   */
  private rebuild(): void {
    this.pane.dispose();
    this.pane = this.build();
  }

  /**
   * Push this frame's status into every section.
   *
   * Called once per frame, AFTER the Orchestrator has run -- so what the panel
   * shows is what the simulation actually holds, including changes the panel did
   * not cause (undo, a preset load, randomize). That is the whole reason the
   * bindings are proxies rather than direct.
   */
  refresh(status: Status): void {
    // BEFORE the hidden check: the menu bar stays on screen when the panel is
    // hidden -- it holds the only visible way to bring it back -- and an open
    // dialog outlives a hide entirely. Starving either of status would freeze a
    // menu's checkmarks and strand a save dialog waiting for an outcome it
    // could no longer see.
    this.menuBar.refresh(status);
    this.dialogs.refresh(status);

    // A hidden panel refreshes nothing else: `pane.refresh()` walks every
    // binding and re-reads every proxy, which is real per-frame work to update
    // widgets nobody can see. The next `setHidden(false)` is followed by the
    // frame loop's own `refresh()`, so what reappears is current, not stale.
    if (this.hiddenFlag) return;

    // `finally` because a throw inside a binding's handler would otherwise wedge
    // the panel permanently read-only, which is worse than the bug it guards.
    this.refreshing = true;
    try {
      this.applyStatus(status);
      this.pane.refresh();
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Write `status` into every section, without touching the pane.
   *
   * Split out from `refresh()` so `build()` can seed the proxies before
   * `this.pane` exists -- see the note at its call site.
   */
  private applyStatus(status: Status): void {
    // Retire gate state that no longer applies, BEFORE anything reads it. A
    // project or config change means the values came from a load rather than
    // from the user, so whatever was loaded should speak for itself
    // (`gated_controls.py:123-140`).
    this.gates.sync(
      { projectName: status.projectName, selectedConfig: status.selectedConfig },
      (gate) => gateOpen(gate, (source) => currentValues(status, source)),
    );

    for (const section of this.sections) section.refresh(status);
    this.applyVisibility(status);
  }

  /**
   * Show or hide each control according to its `revealsOn`.
   *
   * **`blade.hidden`, not a rebuild.** A rebuild would drop folder expansion
   * state, replace every DOM node, and cost a full pane teardown for what is a
   * CSS class change -- and it would do that on any frame a checkbox moved.
   * Rebuilding stays reserved for the tier change.
   *
   * The write is guarded on an actual transition because the setter touches
   * class lists: doing that for ~40 blades every frame is real per-frame DOM
   * work to change nothing. This is the same instinct as the hidden-panel early
   * return in `refresh()`.
   */
  private applyVisibility(status: Status): void {
    const values = (source: Source) => currentValues(status, source);
    for (const binding of this.bindings) {
      const setting = binding.setting;
      const revealed = isRevealed(setting, values, this.gates);

      // A GATED control owns two blades -- a checkbox and a slider -- and shows
      // exactly one. Which one is the latch's answer; whether EITHER shows at
      // all is still the reveal's. The two compose rather than competing: a
      // gated control whose `revealsOn` is off shows neither.
      if (isGated(setting)) {
        const value = numericValue(values(setting.source)[setting.field]);
        const slider = showsSlider(setting, value, this.gates.sessions);
        // `blades` is `[checkbox, slider]`, built in that order.
        setHidden(binding.blades[0], !revealed || slider);
        setHidden(binding.blades[1], !revealed || !slider);
        continue;
      }

      for (const blade of binding.blades) setHidden(blade, !revealed);
    }
  }

  /** Every registry-driven control, across all sections. For 10c. */
  get bindings(): readonly ControlBinding[] {
    return this.sections.flatMap((s) => s.bindings);
  }

  /**
   * Whether the panel is open, so the Orchestrator can skip building payloads.
   *
   * Hiding it counts as closed: `_settings_dicts`'s closed-panel optimization
   * exists so a panel nobody can see does not cost a payload per frame, and a
   * hidden panel is exactly that case.
   */
  get isOpen(): boolean {
    return !this.hiddenFlag;
  }

  /** Whether `X` has hidden the panel. The port of `ui.py`'s `gui_hidden`. */
  get hidden(): boolean {
    return this.hiddenFlag;
  }

  /**
   * Show or hide the panel.
   *
   * `display` rather than removing the container, so Tweakpane keeps its DOM and
   * its state -- an open folder stays open across a hide, and no binding is
   * rebuilt. It also means a hidden panel cannot hold focus, so the hotkey
   * table's editable-target gate cannot be tripped by an input nobody can see.
   */
  setHidden(hidden: boolean): void {
    this.hiddenFlag = hidden;
    this.container.style.display = hidden ? 'none' : '';
  }

  dispose(): void {
    this.pane.dispose();
    this.tooltip.dispose();
    this.menuBar.dispose();
    this.dialogs.dispose();
    this.container.remove();
  }
}

/** Dispatch on section id. A `never` arm, so adding one without a builder fails. */
function buildSection(
  id: ReturnType<typeof sectionsFor>[number]['id'],
  folder: FolderApi,
  status: Status,
  ctx: SectionContext,
): SectionHandle {
  switch (id) {
    case TRANSPORT:
      return buildTransportSection(folder, status, ctx);
    case PROJECT:
      return buildProjectSection(folder, status, ctx);
    case PREFERENCES:
      return buildPreferencesSection(folder, status, ctx);
    case DRAWING:
      return buildDrawingSection(folder, status, ctx);
    case DEBUG:
      return buildDebugSection(folder, status, ctx);
    default: {
      const unreachable: never = id;
      throw new Error(`No builder for section ${String(unreachable)}`);
    }
  }
}

/**
 * Hide or show one blade, writing only on an actual transition.
 *
 * The setter touches class lists, and doing that for ~45 blades every frame is
 * real per-frame DOM work to change nothing.
 */
function setHidden(blade: BladeApi | undefined, hidden: boolean): void {
  if (blade === undefined) return;
  if (blade.hidden !== hidden) blade.hidden = hidden;
}

/** Status payloads are `number | boolean`; the gate arithmetic wants a number. */
function numericValue(value: number | boolean | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return 0;
}

/** A fixed-position container on the right, scrollable when the list is long. */
function defaultContainer(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'fluoddity-panel';
  el.style.cssText =
    'position:fixed;top:8px;right:8px;width:320px;max-height:calc(100vh - 16px);' +
    'overflow-y:auto;z-index:20;';
  document.body.append(el);
  return el;
}
