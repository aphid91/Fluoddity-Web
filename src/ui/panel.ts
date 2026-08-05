/**
 * The panel: two docked side-panels built from sections, plus the overlay.
 *
 * The port of `ui.py`'s `_build_ui` (`:274-297`) and the five window mixins it
 * calls. **Replaces `ui/thinPanel.ts`**, which was Step 7's flat registry dump.
 *
 * ## Two panels, split by what the state IS
 *
 * The desktop has five independent floating windows because they grew that way,
 * and `ARCHITECTURE.md`'s "Toolbar and the planned side-panel" names the
 * endpoint it wants instead: a docked panel whose visible controls follow the
 * active tool, with "each `_*_window()` body as a panel-*section* function".
 *
 * That endpoint arrived as TWO panels rather than one, because the controls
 * divide on something more fundamental than the tool: Project is the config you
 * save and share, and everything else is how your editor is set up. See
 * `panelModel.ts` for the split, and `sections/settingsSection.ts` for where
 * the tool-selection part of the endpoint actually landed -- as a tab that
 * follows the tool, driven from `refresh` below.
 *
 * **One `Panel` still owns both.** The tooltip, the gate state, the dialogs,
 * the menu bar and -- critically -- the `refreshing` flag are all panel-wide.
 * Two `Panel` instances would give two of each, and two `refreshing` flags is
 * two chances to get the guard below wrong.
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
import type {
  Command,
  CommandBus,
  MouseMode,
  Status,
  ViewPrefField,
} from '../orchestrator/commands.ts';
import { type ControlBinding, currentValues } from './controls.ts';
import { Dialogs } from './dialogs.ts';
import { GateState } from './gateState.ts';
import { showsSlider } from './gatedControl.ts';
import { MenuBar } from './menuBar.ts';
import { MutationOverlay } from './mutationOverlay.ts';
import { Splash } from './splash.ts';
import { isGated } from './gating.ts';
import { type InputState, EMPTY_INPUT } from './inputState.ts';
import { gateOpen, isRevealed } from './reveal.ts';
import type { Source } from './settingsSpec.ts';
import {
  DEBUG,
  DRAWING,
  PREFERENCES,
  PROJECT,
  SETTINGS,
  TRANSPORT,
  type PanelSection,
  leftSections,
  rightSections,
} from './panelModel.ts';
import { type SectionContext, type SectionHandle } from './sections/section.ts';
import {
  type SettingsSectionHandle,
  type SettingsTab,
  DRAWING_TAB,
  PREFS_TAB,
  buildSettingsSection,
} from './sections/settingsSection.ts';
import { Tooltip } from './tooltip.ts';
import { Toast, type ToastTone } from './toast.ts';
import { copyText } from './clipboard.ts';
import { SHARE_LINK_WARN_LENGTH, buildShareUrl } from '../config/shareLink.ts';
import { bindFocusRelease } from './focusRelease.ts';
import { buildDebugSection } from './sections/debugSection.ts';
import { buildDrawingSection } from './sections/drawingSection.ts';
import { buildPreferencesSection } from './sections/preferencesSection.ts';
import { buildProjectSection } from './sections/projectSection.ts';
import { buildTransportSection } from './sections/transportSection.ts';

export interface PanelOptions {
  readonly bus: CommandBus;
  /** Where to mount the left (Project) panel. Defaults to a fixed container. */
  readonly leftContainer?: HTMLElement;
  /** Where to mount the right (Settings) panel. Defaults to a fixed container. */
  readonly rightContainer?: HTMLElement;
  /**
   * Whether to show the welcome splash on construction. Defaults to true.
   *
   * False still BUILDS it, so Help > Welcome / Controls works either way -- it
   * only suppresses the automatic first showing. That is what `?nosplash`
   * wants, and what a screenshot comparison wants.
   */
  readonly showSplash?: boolean;
}

/** Which side of the screen, and therefore which tier flag governs it. */
const LEFT = 'left';
const RIGHT = 'right';
type Side = typeof LEFT | typeof RIGHT;

/** One built panel. Two of these, and everything else on `Panel` is shared. */
interface PanelSide {
  readonly container: HTMLElement;
  pane: Pane;
  sections: SectionHandle[];
}

/**
 * The tools that want the Drawing Controls tab.
 *
 * A set rather than a list, because what matters at every use site is
 * membership: the tab rule is about crossing INTO or OUT OF this group, and
 * moves within it change nothing.
 */
const BRUSH_TOOLS: ReadonlySet<MouseMode> = new Set<MouseMode>(['shove', 'draw']);

export class Panel {
  private readonly bus: CommandBus;
  private readonly left: PanelSide;
  private readonly right: PanelSide;

  /** The right panel's tab host, for the tool-driven switch in `refresh`. */
  private settings: SettingsSectionHandle | null = null;

  /**
   * Which tab is showing, held HERE rather than only in the section.
   *
   * A rebuild replaces the section object, and a tier toggle must not also
   * throw you back to the Preferences tab -- the two decisions are unrelated.
   */
  private activeTab: SettingsTab = PREFS_TAB;

  /**
   * The tool as of the last frame, for the tab rule.
   *
   * **A TRANSITION, NOT A LEVEL.** The rule is "entering a brush tool from a
   * non-brush one shows Drawing Controls", and answering it needs the previous
   * value. A level rule -- "a brush tool is active, so show Drawing" --
   * re-asserted every frame would silently undo a manual tab click on the very
   * next frame, leaving the tab buttons apparently dead for as long as a brush
   * tool was selected.
   */
  private lastMouseMode: MouseMode;

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
   * Transient messages, for actions that change nothing on screen.
   *
   * Owned here for the tooltip's reasons: one on screen at a time, attached to
   * `document.body` so a pane rebuild cannot orphan it. NOT hidden by `X` -- it
   * is attached outside both containers, and someone who has hidden the UI can
   * still press Shift+C and deserves to be told whether it worked.
   */
  private readonly toast = new Toast();

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

  /**
   * Mutation Scale, above the canvas.
   *
   * Outside both containers for the same reason the menu bar is, and owned here
   * so it is hidden by `X` along with everything else. See `mutationOverlay.ts`
   * for why it is not a control in a pane.
   */
  private readonly overlay: MutationOverlay;

  /**
   * The welcome splash, shown once at startup and again from Help.
   *
   * Owned here for the same reason the dialogs are: it is reachable from the
   * menu bar, and the bar outlives any one showing. It is NOT hidden by `X` --
   * unlike the overlay, it is not part of the picture's controls, and a user who
   * hid the panel and then asked for Help means it.
   */
  private readonly splash: Splash;

  /**
   * Whether the splash is what paused the simulation, and so whether dismissing
   * it should resume.
   *
   * False when the sim was ALREADY paused as the splash came up: that pause was
   * the user's, and it outlives the splash.
   */
  private pausedBySplash = false;

  /**
   * Teardown for the focus-release listeners, one per side.
   *
   * Bound to the CONTAINERS rather than to the panes, so these survive a tier
   * rebuild: `buildBoth` disposes and replaces both `Pane`s, but the containers
   * outlive that and the listeners are delegated onto them.
   */
  private readonly focusReleasers: readonly (() => void)[];

  constructor(opts: PanelOptions) {
    this.bus = opts.bus;
    this.lastMouseMode = this.bus.status().mouseMode;

    const send = (command: Command): void => {
      this.bus.dispatch(command);
    };
    this.dialogs = new Dialogs({
      send,
      onCopyShareLink: () => {
        this.copyShareLink();
      },
    });
    this.overlay = new MutationOverlay({ send });
    // Built before the menu bar, since the bar's Help item closes over it.
    //
    // The splash pauses the simulation while it is up, and resumes it on
    // dismissal -- but ONLY if the splash is what paused it. Someone who paused
    // deliberately (Space, or the menu) and then opened Help would otherwise
    // find their simulation running again on the way out, which is the kind of
    // thing that loses work in a sim you were watching a moment in.
    //
    // `pausedBySplash` is what records that difference. The bus offers a
    // `togglePause` and no absolute setter, so both directions read
    // `status().paused` first and only toggle when the state actually needs to
    // change -- a blind toggle would invert the wrong thing the moment these
    // two disagreed.
    this.splash = new Splash({
      showNow: opts.showSplash !== false,
      onVisibilityChange: (visible) => {
        if (visible) {
          this.pausedBySplash = !this.bus.status().paused;
          if (this.pausedBySplash) send({ kind: 'togglePause' });
        } else if (this.pausedBySplash) {
          this.pausedBySplash = false;
          // Re-read rather than trusting the flag alone: pausing is reachable
          // while the splash is up (the menu bar stays live above it), so the
          // sim may already be where we want it.
          if (this.bus.status().paused) send({ kind: 'togglePause' });
        }
      },
    });
    this.menuBar = new MenuBar({
      send,
      status: () => this.bus.status(),
      onSave: () => {
        this.dialogs.openSave(this.bus.status().projectName);
      },
      onCopyShareLink: () => {
        this.copyShareLink();
      },
      onDeleteConfig: (category, name) => {
        this.dialogs.openDelete(category, name);
      },
      onResetPreferences: () => {
        this.dialogs.openResetPreferences();
      },
      onToggleUi: () => {
        this.setHidden(!this.hiddenFlag);
      },
      isUiHidden: () => this.hiddenFlag,
      onShowWelcome: () => {
        this.splash.show();
      },
    });

    this.left = {
      container: opts.leftContainer ?? sideContainer(LEFT),
      pane: new Pane({ container: document.createElement('div') }),
      sections: [],
    };
    this.right = {
      container: opts.rightContainer ?? sideContainer(RIGHT),
      pane: new Pane({ container: document.createElement('div') }),
      sections: [],
    };
    // The throwaway panes above exist only to satisfy definite assignment; both
    // are replaced here, before anything can observe them.
    this.left.pane.dispose();
    this.right.pane.dispose();

    // AFTER the containers are resolved, so this covers the option-supplied
    // ones as well as the defaults -- `bindFocusRelease` stamps the marker
    // attribute on whatever container it is handed, which is why the lookup in
    // `focusRelease.ts` is by attribute and not by the `sideContainer` ids.
    // Those ids only exist on the defaults (`panel.ts:641-655`), so an id-based
    // selector would leave a caller-supplied container silently unmanaged.
    this.focusReleasers = [
      bindFocusRelease(this.left.container),
      bindFocusRelease(this.right.container),
    ];

    this.buildBoth();
  }

  /**
   * Build both panes and seed their proxies, in one `refreshing` window.
   *
   * ONE window rather than one per side, because the flag is panel-wide: two
   * nested guards would have the inner `finally` clear it while the outer was
   * still seeding, and every remaining proxy write would then read as a user
   * edit. That is the exact failure the file header describes.
   */
  private buildBoth(): void {
    const status = this.bus.status();
    this.left.pane = this.buildSide(this.left, LEFT, leftSections(), status);
    this.right.pane = this.buildSide(this.right, RIGHT, rightSections(), status);

    // Seed every proxy from the real value rather than the zero it was
    // constructed with -- otherwise the first frame shows a panel full of
    // defaults that do not match the loaded preset.
    //
    // Writes through the LOCAL panes rather than the public `refresh()`: during
    // construction the fields are not assigned yet, so `refresh()` would read
    // `undefined`. That is a real crash rather than a stale value, and it only
    // reproduces in a browser, so `browserCheck.mjs` is what caught it.
    this.refreshing = true;
    try {
      this.applyStatus(status, EMPTY_INPUT);
      this.left.pane.refresh();
      this.right.pane.refresh();
    } finally {
      this.refreshing = false;
    }
  }

  /** One side's pane, from its section list. */
  private buildSide(
    side: PanelSide,
    which: Side,
    sections: readonly PanelSection[],
    status: Status,
  ): Pane {
    // NO pane title. Each panel holds exactly one top-level section whose own
    // folder header already names it, and a pane title above that said the same
    // word twice ("Project" over "Project") while costing a row. If a panel ever
    // holds two sections again, the section headers are what distinguish them --
    // which is what they are for.
    const pane = new Pane({ container: side.container });
    const ctx = this.context(which);

    side.sections = [];
    for (const section of sections) {
      const folder = pane.addFolder({
        title: section.title,
        expanded: section.expanded,
      });
      (folder.element as HTMLElement).dataset['section'] = section.id;

      // The tabbed host is the one section the panel keeps a typed handle on,
      // because `refresh` has to drive its tab from the active tool.
      if (section.id === SETTINGS) {
        const handle = buildSettingsSection(folder, status, ctx, this.activeTab);
        this.settings = handle;
        side.sections.push(handle);
        continue;
      }
      side.sections.push(buildSection(section.id, folder, status, ctx));
    }
    return pane;
  }

  /**
   * What every section and control on one side is handed.
   *
   * **The tier is baked in per side**, which is what makes the three Advanced
   * checkboxes independent: a section reads `ctx.advanced` exactly as it always
   * did and cannot see -- or accidentally answer for -- another panel's tier.
   * The alternative, a function taking a panel name, would have every
   * `grouped(ctx.advanced, ...)` call site grow an argument for no gain.
   *
   * The right panel's two tabs are a wrinkle: they are one section list but two
   * tiers. The settings section resolves that itself by asking for the flag it
   * wants, so what this bakes in for RIGHT is the Preferences tab's -- and
   * `drawingSection` reads `advancedDrawing` through its own toggle instead.
   */
  private context(which: Side): SectionContext {
    const field: ViewPrefField =
      which === LEFT ? 'advancedProject' : 'advancedPreferences';
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
      advanced: this.tierOf(field),
      advancedFor: (f: ViewPrefField) => this.tierOf(f),
      requestRebuild: () => {
        // Deferred: disposing a pane from inside its own event handler reenters
        // Tweakpane's own teardown. A microtask is enough.
        queueMicrotask(() => {
          this.rebuild();
        });
      },
    };
  }

  /**
   * One tier flag's current value.
   *
   * From the named `Status` fields rather than from `status.editPrefs`, because
   * that payload is EMPTY while no panel is open (`settingsSources`'s
   * optimization) -- and the very first `buildBoth()` runs before `panelOpen`
   * has been set. Reading it there would build both panels in Basic regardless
   * of what was saved, and only a later rebuild would correct it.
   */
  private tierOf(field: ViewPrefField): boolean {
    return this.bus.status()[field];
  }

  /**
   * Tear down and rebuild BOTH panes.
   *
   * **Reserved for a tier change**, which is a rare, deliberate act that changes
   * which controls exist at all. Per-frame refresh never rebuilds anything, and
   * 10c's reveal/gate visibility uses `blade.hidden` rather than coming through
   * here -- a rebuild would drop folder expansion state and replace every DOM
   * node, which is both visible and expensive.
   *
   * Both sides, even though a tier change only affects one: the saving is two
   * pane teardowns on a rare action, and the cost of getting it wrong is a
   * panel showing the wrong tier until something else happens to rebuild it.
   * `activeTab` is held on the panel precisely so this cannot lose it.
   */
  private rebuild(): void {
    this.left.pane.dispose();
    this.right.pane.dispose();
    this.settings = null;
    this.buildBoth();
  }

  /**
   * Push this frame's status into every section.
   *
   * Called once per frame, AFTER the Orchestrator has run -- so what the panel
   * shows is what the simulation actually holds, including changes the panel did
   * not cause (undo, a preset load, randomize). That is the whole reason the
   * bindings are proxies rather than direct.
   */
  refresh(status: Status, input: InputState = EMPTY_INPUT): void {
    // BEFORE the hidden check: the menu bar stays on screen when the panel is
    // hidden -- it holds the only visible way to bring it back -- and an open
    // dialog outlives a hide entirely. Starving either of status would freeze a
    // menu's checkmarks and strand a save dialog waiting for an outcome it
    // could no longer see.
    this.menuBar.refresh(status);
    this.dialogs.refresh(status);
    // ALSO before the hidden check, and for the same reason as the menu bar:
    // `X` does not hide the overlay, so it is still on screen and still has to
    // track the tool and the mutation value. Below the early return it froze
    // whenever the panels were hidden, and showed stale values afterwards.
    this.overlay.refresh(status);

    // A hidden panel refreshes nothing else: `pane.refresh()` walks every
    // binding and re-reads every proxy, which is real per-frame work to update
    // widgets nobody can see. The next `setHidden(false)` is followed by the
    // frame loop's own `refresh()`, so what reappears is current, not stale.
    if (this.hiddenFlag) return;

    this.followTool(status.mouseMode);

    // `finally` because a throw inside a binding's handler would otherwise wedge
    // the panel permanently read-only, which is worse than the bug it guards.
    this.refreshing = true;
    try {
      this.applyStatus(status, input);
      this.left.pane.refresh();
      this.right.pane.refresh();
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Bring the tab the new tool wants to the front.
   *
   * **Only on a crossing.** Entering a brush tool from a non-brush one shows
   * Drawing Controls; leaving for a non-brush one shows Preferences; moving
   * between the two brush tools changes nothing, because both want the same tab
   * and re-asserting it would undo a manual click for no reason.
   *
   * The early return on an unchanged mode is what makes the tab buttons work at
   * all: on every frame where the tool did not move, this does nothing, so
   * whatever the user last clicked stands.
   */
  private followTool(mode: MouseMode): void {
    if (mode === this.lastMouseMode) return;
    const was = BRUSH_TOOLS.has(this.lastMouseMode);
    const now = BRUSH_TOOLS.has(mode);
    this.lastMouseMode = mode;
    if (was === now) return; // A move within a group. Leave the tab alone.
    this.setActiveTab(now ? DRAWING_TAB : PREFS_TAB);
  }

  /** Show one tab, remembering it across rebuilds. */
  private setActiveTab(tab: SettingsTab): void {
    this.activeTab = tab;
    this.settings?.setActiveTab(tab);
  }

  /**
   * Write `status` into every section, without touching the pane.
   *
   * Split out from `refresh()` so `build()` can seed the proxies before
   * `this.pane` exists -- see the note at its call site.
   */
  private applyStatus(status: Status, input: InputState): void {
    // Retire gate state that no longer applies, BEFORE anything reads it. A
    // project or config change means the values came from a load rather than
    // from the user, so whatever was loaded should speak for itself
    // (`gated_controls.py:123-140`).
    this.gates.sync(
      { projectName: status.projectName, selectedConfig: status.selectedConfig },
      (gate) => gateOpen(gate, (source) => currentValues(status, source)),
    );

    for (const section of this.left.sections) section.refresh(status, input);
    for (const section of this.right.sections) section.refresh(status, input);

    // Adopt a tab the USER changed by clicking. The section owns the live
    // answer; this mirror exists only so a rebuild can restore it, and without
    // this line a manual click would survive until the next tier toggle and
    // then silently revert.
    if (this.settings !== null) this.activeTab = this.settings.activeTab();

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

  /**
   * Every registry-driven control, across BOTH panels. For 10c.
   *
   * Both sides in one list on purpose: reveals resolve across the whole
   * registry rather than per panel, and `bloomEnabled` revealing its three
   * children happens to stay within one folder only by coincidence. A
   * per-panel visibility pass would make that coincidence load-bearing.
   */
  get bindings(): readonly ControlBinding[] {
    return [
      ...this.left.sections.flatMap((s) => s.bindings),
      ...this.right.sections.flatMap((s) => s.bindings),
    ];
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
    const display = hidden ? 'none' : '';
    this.left.container.style.display = display;
    this.right.container.style.display = display;
    // The overlay does NOT go: `X` hides the panels so you can see the picture,
    // and the overlay is the picture's own controls. `setHidden` is a no-op
    // there and says why -- called anyway, so this stays a complete list of
    // what the key governs rather than a list with a silent omission.
    this.overlay.setHidden(hidden);
  }

  /**
   * Copy a link that restores the project as it stands right now.
   *
   * THE LIVE PROJECT, WHICH IS THE WHOLE POINT. `projectDocument()` serializes
   * what is on screen this instant, not the file that was loaded -- someone who
   * opens a preset, edits ten sliders and presses Shift+C must get a link to
   * what they are looking at, not to what they started from.
   *
   * Public because two callers want exactly this: the `Shift+C` hotkey, which
   * arrives from `main.ts` with no dialog open, and the save dialog's button,
   * which arrives with one up. Only where the RESULT lands differs, and that is
   * `showShareResult`'s problem rather than this one's.
   *
   * Built from `window.location` so the link points wherever the app is
   * actually served from -- `vite.config.ts` sets `base: './'` precisely so this
   * app does not care, and a hardcoded origin here would quietly undo that.
   */
  copyShareLink(): void {
    const url = buildShareUrl(window.location, this.bus.projectDocument());
    void copyText(url).then((ok) => {
      this.showShareResult(ok, url);
    });
  }

  /**
   * Say something transient, when there is no better place to say it.
   *
   * For `main.ts` to report a share link that would not load. Fronts the toast
   * rather than exposing it, so the panel keeps ownership of its own surfaces.
   */
  notify(text: string, tone: ToastTone = 'ok'): void {
    this.toast.show(text, tone);
  }

  /**
   * Report a copy, choosing a surface that is actually visible.
   *
   * THE DIALOG WINS WHEN IT IS UP, and this is not a preference. A native
   * `<dialog showModal()>` renders in the browser's top layer, above every
   * `z-index` there is, so a `document.body` toast is behind its backdrop and
   * invisible for as long as the dialog is open -- the one moment the user is
   * most certainly watching for a response.
   */
  private showShareResult(ok: boolean, url: string): void {
    const message = ok
      ? url.length > SHARE_LINK_WARN_LENGTH
        ? `Link copied — ${url.length} characters. Links this long can be cut ` +
          'short by some chat and mail clients; check it pasted whole.'
        : `Link copied — ${url.length} characters.`
      : 'Could not reach the clipboard. Copy the link from the box instead.';

    if (this.dialogs.saveDialogOpen) {
      this.dialogs.showShareNote(message, ok);
    } else {
      this.toast.show(message, ok ? 'ok' : 'error');
    }

    // THE FALLBACK, and it is deliberately the crude one. `execCommand('copy')`
    // is the traditional answer and cannot work here (see `clipboard.ts`), so
    // what is left is to put the text somewhere the user can select it. A
    // `prompt` is ugly, and it needs no permission, no secure origin and no
    // gesture -- which is exactly the situation this branch is in. Its ugliness
    // is confined to a path that only runs when the modern API is gone.
    if (!ok) window.prompt('Copy this link:', url);
  }

  dispose(): void {
    for (const release of this.focusReleasers) release();
    this.left.pane.dispose();
    this.right.pane.dispose();
    this.tooltip.dispose();
    this.toast.dispose();
    this.menuBar.dispose();
    this.dialogs.dispose();
    this.overlay.dispose();
    this.splash.dispose();
    this.left.container.remove();
    this.right.container.remove();
  }
}

/**
 * Dispatch on section id. A `never` arm, so adding one without a builder fails.
 *
 * SETTINGS is absent because `buildSide` handles it before reaching here -- it
 * needs the initial tab and returns a wider handle than `SectionHandle`.
 * TRANSPORT and DEBUG are absent from the section LISTS but present here on
 * purpose: their builders are parked, not deleted, and keeping the arms means
 * un-parking one is a single line in `panelModel.ts` (`panelModel.ts:26-37`).
 */
function buildSection(
  id: Exclude<PanelSection['id'], typeof SETTINGS>,
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

/**
 * A fixed-position container on one side, scrollable when the list is long.
 *
 * The LEFT one starts lower, because the menu bar is pinned to the top-left
 * corner (`menuBar.ts:533-543`) and a panel at `top:8px` would sit underneath
 * it. The right side has no such neighbour, so it keeps the original geometry.
 *
 * Both leave room at the top for the mutation overlay to clear them: the
 * overlay is centred and capped at 420px, so on any window wide enough for two
 * 320px panels there is no overlap.
 */
function sideContainer(which: Side): HTMLElement {
  const el = document.createElement('div');
  const left = which === LEFT;
  el.id = left ? 'fluoddity-panel-left' : 'fluoddity-panel-right';
  // Below the menu bar AND the mutation overlay, which is centred at the top and
  // is the taller of the two. The panels are 320px and the overlay is capped so
  // that on any window wide enough for both there is no horizontal overlap --
  // this clears it vertically as well, for windows that are not.
  const top = PANEL_TOP_PX;
  el.style.cssText =
    `position:fixed;top:${top}px;${left ? 'left:8px' : 'right:8px'};` +
    `width:320px;max-height:calc(100vh - ${top + 8}px);overflow-y:auto;z-index:20;`;
  document.body.append(el);
  return el;
}

/**
 * Where both side panels start, in px from the top.
 *
 * Clears the menu bar (fixed at `top:0`, ~26px) and the mutation overlay
 * beneath it. A single constant because the two panels must agree -- one of
 * them starting lower than the other reads as a rendering bug.
 *
 * HAND-COMPUTED, not derived from `mutationOverlay.ts`'s MENU_BAR_CLEARANCE --
 * these two numbers are related by intent only, so moving one without the other
 * is what makes them overlap. Raised from 78 because at some window sizes the
 * panels still clipped the mutation slider's bottom edge.
 */
const PANEL_TOP_PX = 83;
