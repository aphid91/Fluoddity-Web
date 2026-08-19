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
import { PanelToggle } from './panelToggle.ts';
import { RecordingBar } from './recordingBar.ts';
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
  RECORDING_TAB,
  buildSettingsSection,
} from './sections/settingsSection.ts';
import { Tooltip } from './tooltip.ts';
import { Toast, type ToastTone } from './toast.ts';
import { copyText, readText } from './clipboard.ts';
import { fromDocument, sanitizeName } from '../config/persistence.ts';
import {
  SHARE_LINK_WARN_LENGTH,
  SHARED_LINK_NAME,
  buildShareUrl,
  decodeShareText,
} from '../config/shareLink.ts';
import { bindFocusRelease } from './focusRelease.ts';
import { buildDebugSection } from './sections/debugSection.ts';
import { buildDrawingSection } from './sections/drawingSection.ts';
import { buildPreferencesSection } from './sections/preferencesSection.ts';
import { buildProjectSection } from './sections/projectSection.ts';
import { buildTransportSection } from './sections/transportSection.ts';
import type { RecordingSectionOptions } from './sections/recordingSection.ts';
// TYPE-ONLY on both: the recorder module pulls in mediabunny, and the panel is
// built for every session. `main.ts` supplies the constructed object through
// `PanelOptions.recording`, so nothing here ever imports the value side.
import type { RecordingResult, VideoRecorder } from '../recorder/recorder.ts';
import type { SaveChoice } from '../recorder/saveFile.ts';
import type { RecordingSettings, Resolution } from '../recorder/recordingSettings.ts';

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
   *
   * **THE CALLER DECIDES WHAT "FIRST" MEANS.** `main.ts` passes false for a
   * returning visitor, so the splash is a first-run experience rather than a
   * toll booth on every load. See its startup block.
   */
  readonly showSplash?: boolean;
  /**
   * Run GPU calibration, resolving when it is done.
   *
   * Passed IN rather than called by `main.ts` alone, because calibration has
   * two triggers and only one of them is startup: resetting preferences puts a
   * user back at defaults they never chose, and re-deriving the settings is the
   * point of the reset. The panel owns the reset dialog, so it has to be able to
   * start a second run -- without a page reload, which would discard the live
   * project.
   *
   * Omitted when there is nothing to calibrate (`?nocalibrate`), in which case
   * the reset path simply skips it.
   */
  readonly runCalibration?: () => Promise<void>;
  /**
   * Called whenever the panels are shown or hidden, by any route.
   *
   * `main.ts` uses it to follow `Orchestrator.panelOpen`, which gates whether
   * the settings payloads are built at all. It is a callback rather than
   * something the caller does at the `X` key because there are THREE routes now
   * -- the key, the Editor menu item, and the corner gear -- and only
   * `setHidden` sees all of them.
   */
  readonly onHiddenChange?: (hidden: boolean) => void;
  /**
   * Whether the panels start hidden. Defaults to false.
   *
   * `main.ts` passes true: the app opens on the picture, with the mutation bar
   * and its gear as the way back to the controls.
   */
  readonly startHidden?: boolean;
  /**
   * Video recording, injected because the panel cannot reach either half itself.
   *
   * **NOT on `CommandBus`, and that is the point.** Recording needs the
   * `GPUDevice` and it needs to attach a recorder to the Orchestrator, neither
   * of which a command can carry: `CommandBus` is documented as a value-in,
   * value-out seam that keeps DOM and Web APIs out of the Orchestrator entirely
   * (see `projectDocument`'s note on why the clipboard is not a command). A
   * `VideoEncoder` and an `<a download>` are exactly what that rule excludes.
   *
   * So `main.ts` -- which already owns the device, the surface and the
   * orchestrator -- supplies these two functions, and the panel drives the
   * recorder through them without either side reaching into the other.
   *
   * Omitted entirely in contexts with no GPU (the DOM tests), where Share >
   * Export Video is then absent rather than present and broken.
   */
  readonly recording?: {
    /**
     * Ask where to save, or null to buffer in memory.
     *
     * **Injected rather than imported at the call site, and that is
     * load-bearing.** It must be callable with NO preceding await, because
     * `showSaveFilePicker` needs the click's user activation and a dynamic
     * `import()` spends it on the first export. `main.ts` supplies this from a
     * module it has already loaded. See `startExport`.
     */
    readonly chooseFile: (suggestedName: string) => Promise<SaveChoice>;
    /** The window in device pixels: the recording sliders' ceiling. */
    readonly windowSize: () => readonly [number, number];
    /** Show the crop box for a size being chosen, or null to hide it. */
    readonly setCropPreview: (resolution: Resolution | null) => void;
    /** Build and attach a recorder. Resolves once frames can be rendered. */
    readonly start: (
      settings: RecordingSettings,
      file: FileSystemWritableFileStream | null,
    ) => Promise<VideoRecorder>;
    /** Detach the recorder, finalize, and report what became of the file. */
    readonly finish: (recorder: VideoRecorder) => Promise<RecordingResult>;
  };
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

  /** Set by `X`, the Editor menu item and the corner gear, via `setHidden`. */
  private hiddenFlag = false;

  /** Told whenever `hiddenFlag` moves. See `PanelOptions.onHiddenChange`. */
  private readonly onHiddenChange: ((hidden: boolean) => void) | null = null;

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
  private readonly panelToggle: PanelToggle;

  /**
   * The export progress strip.
   *
   * Owned here for the toast's reasons -- attached to `document.body`, so a pane
   * rebuild cannot orphan it -- and NOT hidden by `X`, like the toast and unlike
   * the panels. An export outlives any particular panel state, and the state it
   * most needs to be visible in is precisely the one where the panels are gone.
   */
  private readonly recordingBar: RecordingBar;

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

  /** See `PanelOptions.runCalibration`. Null when there is nothing to run. */
  private readonly runCalibration: (() => Promise<void>) | null;

  /**
   * Whether Share > Export Video is ticked, and so whether the Recording
   * Controls tab EXISTS.
   *
   * Session-only, deliberately: it is not a `Preferences` field and does not
   * persist. Ticking it is "I am exporting something now", the way expanding a
   * Load category is -- not a lasting statement about how you work, which is
   * the test the three `advanced*` flags pass and this one does not.
   *
   * Toggling it goes through `rebuild()`, because a tab that exists or does not
   * is exactly the kind of change per-frame refresh cannot express -- the same
   * reasoning as the tier flags.
   */
  private exportVideoShown = false;

  /**
   * The recorder, while an export is in flight.
   *
   * Held HERE rather than only on the Orchestrator because the panel owns the
   * lifecycle: it starts the export, polls progress for the button label, and
   * hands the finished file to the browser. The Orchestrator is given the same
   * object so `frame()` can render into it, which is the only thing it needs.
   *
   * `unknown`-free but deliberately imported as a TYPE only -- see `startExport`
   * for why the class itself arrives through a dynamic import.
   */
  private recorder: VideoRecorder | null = null;

  /** True between pressing Export and the recorder existing. See `startExport`. */
  private exportStarting = false;

  /**
   * See `PanelOptions.recording`. Null where there is no GPU to record from.
   *
   * `NonNullable`, so the field is `T | null` rather than `T | undefined | null`
   * -- two ways to say absent is one more than this needs, and it makes every
   * use site prove the same thing twice.
   */
  private readonly recording: NonNullable<PanelOptions['recording']> | null;

  /**
   * Whether a calibration run is in flight.
   *
   * Guards against a second run being started on top of the first -- two
   * ladders rebuilding the simulation against each other would interleave their
   * rungs and commit whichever finished last. Reachable in practice: the reset
   * dialog can be opened again while the run it started is still walking.
   */
  private calibrating = false;

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
    this.runCalibration = opts.runCalibration ?? null;
    this.onHiddenChange = opts.onHiddenChange ?? null;
    this.recording = opts.recording ?? null;

    // **RESETTING PREFERENCES RE-CALIBRATES.** A reset puts World Size and
    // Physics Rate back to compiled-in defaults the user never chose and their
    // machine was never measured against -- which for anyone whose hardware
    // does not match those defaults is the state calibration exists to prevent.
    // So the reset re-derives them, behind the splash, exactly as a first visit
    // does.
    //
    // AFTER the dispatch, not before: `resetPreferences` writes
    // `DEFAULT_PREFERENCES` wholesale, so a calibration that had already
    // committed would be overwritten by the reset it was supposed to follow.
    //
    // Intercepted on `send` rather than on the dialog's button, so it holds
    // however the command is raised -- the dialog today, a hotkey or a menu
    // item tomorrow.
    const send = (command: Command): void => {
      this.bus.dispatch(command);
      if (command.kind === 'resetPreferences') void this.calibrate();
    };
    this.dialogs = new Dialogs({
      send,
      onCopyShareLink: () => {
        this.copyShareLink();
      },
    });
    this.overlay = new MutationOverlay({ send });
    // Cancel through the same path the tab's button uses, so there is one
    // meaning of cancelling however it is reached.
    this.recordingBar = new RecordingBar(() => {
      this.recorder?.cancel();
    });
    // The gear, in its own corner rather than on the mutation bar -- see
    // `panelToggle.ts`. Goes through `setHidden` exactly as `X` and the Editor
    // menu item do, so all three routes share one flag and one notification.
    this.panelToggle = new PanelToggle({
      onToggle: () => {
        this.setHidden(!this.hiddenFlag);
      },
    });
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
      onPasteShareLink: () => {
        this.pasteShareLink();
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
      onToggleExportVideo: () => {
        this.setExportVideoShown(!this.exportVideoShown);
      },
      isExportVideoShown: () => this.exportVideoShown,
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

    // LAST, and after `buildBoth`. The panes must exist before their containers
    // are hidden, or the first reveal would show two empty columns; and
    // `applyHidden` rather than `setHidden` because there is nothing to notify
    // yet -- `main.ts` seeds `panelOpen` from `isOpen` immediately after this
    // returns.
    if (opts.startHidden === true) this.applyHidden(true);
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
        const handle = buildSettingsSection(
          folder,
          status,
          ctx,
          this.activeTab,
          // Undefined -- and so NO recording tab built at all -- unless both the
          // menu item is ticked and this build has somewhere to record to.
          this.exportVideoShown && this.recording !== null
            ? this.recordingOptions()
            : undefined,
        );
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
    // ALSO above the hidden check, and this is the case that most needs to be:
    // the panels start hidden, so an export begun and then hidden -- or begun
    // from a tab the user has since switched away from -- would otherwise run
    // for twenty minutes with no visible sign of what is making the app slow.
    // The bar exists precisely for the states below this line.
    this.recordingBar.update(
      this.recorder === null
        ? null
        : { ...this.recorder.progress, paused: status.paused },
    );

    // THE CROP BOX FOLLOWS THE TAB, and is therefore driven from STATE here
    // rather than pushed when a slider moves.
    //
    // It is only meaningful while the user can see the controls that shape it
    // and the button that uses it, so it is shown exactly when the Recording
    // Controls tab is in front -- not merely when Export Video is ticked. An
    // edge-driven push cannot express that: switching tabs and pressing `X`
    // move no slider, so a box pushed on change would stay on screen over a
    // panel that no longer explains it.
    //
    // ABOVE the hidden check on purpose. Hiding the panels must retire the box
    // too -- `X` means "let me look at the picture", and a white rectangle with
    // no visible control to change it is precisely what that gesture is asking
    // to be rid of.
    this.syncCropPreview();

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
    this.applyHidden(hidden);
    // EVERY PATH THAT HIDES THE PANELS COMES THROUGH HERE -- the `X` key, the
    // Editor menu item, and the corner gear -- so this is the one
    // place that can tell the Orchestrator to stop building settings payloads
    // nobody can see. It used to be `main.ts`'s job at the `X` call site alone,
    // which meant hiding from the MENU left `panelOpen` true and the payloads
    // being built for an invisible panel: wasted work every frame, and silent.
    this.onHiddenChange?.(hidden);
  }

  /**
   * The DOM half of `setHidden`, without the notification.
   *
   * Split out for the constructor's `startHidden`, which must not fire
   * `onHiddenChange`: the caller is still inside `new Panel(...)` and has not
   * bound anything yet, and `main.ts` sets `panelOpen` explicitly right after.
   * Sharing the body is what keeps the initial state and every later toggle
   * from drifting apart.
   */
  private applyHidden(hidden: boolean): void {
    this.hiddenFlag = hidden;
    const display = hidden ? 'none' : '';
    this.left.container.style.display = display;
    this.right.container.style.display = display;
    // The overlay does NOT go: `X` hides the panels so you can see the picture,
    // and the overlay is the picture's own controls. `setHidden` is a no-op
    // there and says why -- called anyway, so this stays a complete list of
    // what the key governs rather than a list with a silent omission.
    this.overlay.setHidden(hidden);
    // Nor does the gear, and for a stronger reason: it is the way BACK. Hiding
    // it with the panels would leave only `X` and a menu that is inside what
    // just disappeared. A no-op that says so, like the overlay's.
    this.panelToggle.setHidden(hidden);
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
   * Load the project from a share URL on the clipboard.
   *
   * `copyShareLink` inverted, and deliberately forgiving about what it is given:
   * `decodeShareText` takes a whole URL, a bare fragment, or either wrapped in
   * the whitespace a hard-wrapping mail client leaves behind.
   *
   * THE PROMPT IS NOT A LAST RESORT HERE, it is the Firefox path. Reading the
   * clipboard is gated behind a permission prompt in Chrome and is not
   * implemented for page script in Firefox at all -- so unlike copying, where
   * the fallback is rare, this one is the ONLY route for a whole browser engine.
   * Asking for the link directly costs one dialog and works everywhere.
   */
  pasteShareLink(): void {
    void readText().then((clip) => {
      // `null` is "could not read", which is not the same as "read nothing" --
      // an empty clipboard is a real answer and gets the same prompt, since
      // either way there is no link to work with.
      const text = clip !== null && clip.trim() !== ''
        ? clip
        : window.prompt('Paste a Fluoddity share link:') ?? '';
      this.applyShareText(text);
    });
  }

  /**
   * Decode share text and adopt it, reporting either way.
   *
   * Split out so the clipboard path and the prompt path cannot drift: both
   * arrive here with a string of unknown quality and neither is trusted.
   */
  private applyShareText(text: string): void {
    if (text.trim() === '') return; // Cancelled, or nothing to work with.

    let saved;
    try {
      const doc = decodeShareText(text);
      if (doc === null) {
        this.toast.show(
          'That does not look like a Fluoddity share link.',
          'error',
        );
        return;
      }
      saved = fromDocument(doc, 'shared link');
    } catch (err: unknown) {
      // Both halves again: a payload that will not decompress, and one that
      // decodes to something this version cannot read. The message names
      // truncation because that is overwhelmingly the likeliest cause.
      this.toast.show(
        'That share link could not be read — it may have been truncated when ' +
          'it was copied.',
        'error',
      );
      console.warn(`Rejected a pasted share link: ${String(err)}`);
      return;
    }

    this.bus.dispatch({ kind: 'loadSharedConfig', saved, name: SHARED_LINK_NAME });
    this.toast.show('Project loaded from link. Press Z to undo.');
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
   * Set the splash's progress line. Empty clears it.
   *
   * For calibration, which runs behind the splash while the user reads. Fronts
   * the splash for the same reason `notify` fronts the toast: the panel owns
   * its surfaces, and `main.ts` should not have to reach through it to reach
   * one.
   */
  setSplashStatus(text: string): void {
    this.splash.setStatus(text);
  }

  /**
   * Run calibration behind a splash that is up and locked shut for the duration.
   *
   * The one path both triggers go through -- startup and Reset Editor
   * Preferences -- so the two cannot drift into behaving differently. Shows the
   * splash if it is not already up, since the reset case starts from an app the
   * user is already looking at.
   *
   * **THE UNLOCK IS UNCONDITIONAL.** `calibrate` is documented never to throw,
   * but a lock that leaked would strand the user behind a screen with no way
   * out and no keyboard escape -- the one failure here worse than a bad world
   * size. So the release is in `finally`, and `calibrating` is cleared with it.
   */
  async calibrate(): Promise<void> {
    if (this.runCalibration === null || this.calibrating) return;
    this.calibrating = true;
    this.splash.show(); // No-op when it is already up, as at startup.
    this.splash.setLocked(true);
    try {
      await this.runCalibration();
    } finally {
      this.splash.setLocked(false);
      this.splash.setStatus('');
      this.calibrating = false;
    }
  }

  // =========================================================================
  // Video recording
  // =========================================================================

  /**
   * Show or hide the Recording Controls tab.
   *
   * Goes through `rebuild()` because a tab that EXISTS or does not is not
   * something per-frame refresh can express -- the same reasoning the Advanced
   * tier toggles document. Bringing the new tab to the front on the way in is
   * what makes the menu item feel like it did something; on the way out
   * `setActiveTab` falls back to Preferences on its own.
   *
   * **REFUSED WHILE AN EXPORT IS RUNNING.** The rebuild disposes the section
   * holding the settings the recorder is mid-way through using, and the cancel
   * path would lose its own progress readout. Someone who wants to stop presses
   * Cancel, which is the control that means that.
   */
  private setExportVideoShown(shown: boolean): void {
    if (this.recording === null) return;
    if (this.recorder !== null || this.exportStarting) {
      this.toast.show('Finish or cancel the current export first.', 'error');
      return;
    }
    if (shown === this.exportVideoShown) return;

    this.exportVideoShown = shown;

    if (shown) {
      // **BRING THE USER TO WHAT THEY JUST SUMMONED.** Three things, in this
      // order, because ticking a menu item that appears to do nothing is the
      // failure being avoided:
      //
      //   1. Make Recording Controls the active tab, so the rebuild below
      //      builds with it in front rather than behind Preferences.
      //   2. REVEAL THE PANELS if they are hidden -- which is the DEFAULT state
      //      (`startHidden: true` in `main.ts`), so without this the common case
      //      is ticking the box and seeing nothing at all happen.
      //
      // Un-ticking deliberately does NOT hide the panels again: the user may
      // have opened them for their own reasons in between, and taking them away
      // would be undoing something this feature never did.
      this.activeTab = RECORDING_TAB;
      if (this.hiddenFlag) this.setHidden(false);
    }
    // Un-ticking needs no explicit crop clear: `syncCropPreview` runs every
    // frame and reads `exportVideoShown`, so the box goes out on the next one.
    // `setActiveTab` handles falling back to Preferences.

    // 3. Rebuild, which is what makes the tab EXIST. Last, so it sees the
    //    activeTab set above.
    this.rebuild();
  }

  /**
   * Show the crop box exactly while the Recording Controls tab is in front.
   *
   * Called once per frame from `refresh`. The four conditions are all
   * "can the user see the controls this box belongs to?", stated positively:
   *
   *   - recording is wired up at all (no GPU, no box);
   *   - Export Video is ticked, so the tab exists;
   *   - the panels are not hidden;
   *   - and the Recording tab is the ACTIVE one.
   *
   * WHILE A RECORDING IS RUNNING the box is left alone -- `Orchestrator.
   * cropOverlay` prefers the recorder's own resolution over this preview, so
   * what is being captured stays marked even if the user switches tabs to watch
   * progress. This only governs the box shown while CHOOSING a size.
   *
   * Idempotent and cheap: `setCropPreview` is a field assignment, and the
   * Orchestrator recomputes the overlay from it each frame anyway.
   */
  private syncCropPreview(): void {
    if (this.recording === null) return;

    const visible =
      this.exportVideoShown &&
      !this.hiddenFlag &&
      this.settings?.activeTab() === RECORDING_TAB;

    this.recording.setCropPreview(
      visible ? this.settings?.recordingSettings()?.resolution ?? null : null,
    );
  }

  /** What the Recording Controls tab is handed. Rebuilt with the section. */
  private recordingOptions(): RecordingSectionOptions {
    return {
      windowSize: () => this.recording?.windowSize() ?? [1, 1],
      onExport: (settings) => {
        void this.startExport(settings);
      },
      onCancel: () => {
        // Marks the recorder finished; `main.ts`'s driver notices on its next
        // pass and runs the finish path, so the frames already encoded still
        // become a file. See `VideoRecorder.cancel`.
        this.recorder?.cancel();
      },
      progress: () => this.recorder?.progress ?? null,
    };
  }

  /**
   * Begin an export.
   *
   * **`exportStarting` guards the await.** Building a recorder fetches
   * mediabunny and configures a hardware encoder, which is not instant -- and
   * the Export button stays live throughout, because its label only becomes
   * Cancel once `this.recorder` exists. Without the flag a second click in that
   * window starts a second recorder, and the first is orphaned holding a 4K
   * swap chain that nothing will ever free.
   */
  private async startExport(settings: RecordingSettings): Promise<void> {
    if (this.recording === null || this.recorder !== null || this.exportStarting) return;

    this.exportStarting = true;
    try {
      // THE PICKER GOES FIRST, BEFORE ANY OTHER AWAIT, while the click's user
      // activation is still live. `showSaveFilePicker` requires that gesture and
      // any await spends it -- including a dynamic `import()`, which on the
      // FIRST export is a real network fetch of the mediabunny chunk. Calling
      // the picker after it would lose the gesture exactly once per session: on
      // the first export, silently, falling back to buffering with no
      // indication why. That is why `chooseRecordingFile` is reached through
      // the injected `chooseFile` rather than through an import here.
      //
      // Streaming gives flat memory and no practical size ceiling. A null answer
      // -- no API (Firefox, Safari), or the user dismissed the picker -- falls
      // back to buffering in memory, which is fine for an ordinary short export.
      const safe = sanitizeName(this.bus.status().projectName) || 'fluoddity';
      const choice = await this.recording.chooseFile(`${safe}.mp4`);

      // CANCEL MEANS CANCEL. Dismissing the file picker is the user changing
      // their mind about exporting, not a request to export somewhere else --
      // and starting a recording anyway is especially bad here, because the
      // export unpauses the simulation and runs it at the recording's physics
      // rate. Backing out of a dialog should not restart your simulation.
      //
      // Silent: the user just closed a dialog, which is its own feedback. A
      // toast explaining that nothing happened is noise.
      if (choice.kind === 'cancelled') return;

      this.recorder = await this.recording.start(
        settings,
        // `unavailable` means no picker on this browser, which is a fallback to
        // buffering rather than a refusal -- see `SaveChoice`.
        choice.kind === 'file' ? choice.writable : null,
      );

      // **UNPAUSE, IF PAUSED.** A recording started against a paused simulation
      // would encode nothing at all -- the driver skips paused frames, so the
      // export would sit at 0% looking broken until the user worked out why.
      // Pressing Export is an unambiguous statement that motion is wanted.
      //
      // AFTER the recorder exists, not before: if `start()` throws (no encoder
      // for the size, a resolution past the device limit) the simulation should
      // be left exactly as it was found rather than resumed for an export that
      // never happened.
      //
      // The bus offers `togglePause` and no absolute setter, so this reads the
      // state first and only toggles when it actually needs to move -- a blind
      // toggle would pause a running simulation, which is the precise inverse of
      // what is wanted. Same shape as the splash's pause handling above.
      if (this.bus.status().paused) this.bus.dispatch({ kind: 'togglePause' });

      const res = this.recorder.settings.resolution;
      this.toast.show(
        `Recording ${settings.duration}s at ${res.width}×${res.height}. ` +
          'The editor will be slow while this runs. Pausing pauses the recording.',
      );
    } catch (err: unknown) {
      // The likely causes are all things the user can act on -- no encoder for
      // the chosen size, a resolution past the device limit -- so the message
      // is shown rather than only logged.
      this.toast.show(`Could not start recording: ${String(err)}`, 'error');
      console.warn('Recording failed to start:', err);
    } finally {
      this.exportStarting = false;
    }
  }

  /**
   * Finalize the export and hand the file to the browser.
   *
   * Called by `main.ts`'s driver when the recorder reports itself finished,
   * rather than by anything in here: the panel does not run a frame loop, and
   * the last frame must be submitted before the file can be closed.
   */
  async finishExport(): Promise<void> {
    const recorder = this.recorder;
    if (recorder === null || this.recording === null) return;
    // Cleared FIRST, so the driver cannot re-enter this while the finalize is
    // in flight -- `finalize()` is awaited, and a second call would try to
    // finalize an output that is already closing.
    this.recorder = null;

    // **PAUSE ON FINISH.** The export is done, and what the user wants next is
    // to look at the result rather than to watch the simulation carry on past
    // the end of what they just captured -- which, at the recording's physics
    // rate, would run away from the final frame within seconds and make the clip
    // hard to compare against what is on screen.
    //
    // BEFORE the await, so the simulation stops at the frame the video ends on.
    // Finalizing a large MP4 takes real time; pausing afterwards would let the
    // simulation run on through all of it, and the still left on screen would
    // not be the last frame of the file.
    //
    // Reads the state first, like `startExport` -- see the note there.
    if (!this.bus.status().paused) this.bus.dispatch({ kind: 'togglePause' });

    try {
      const result = await this.recording.finish(recorder);

      // The three outcomes are genuinely different messages. "Streamed" is a
      // completed multi-gigabyte export the user already chose a home for;
      // "empty" is a recording that captured nothing. Reporting either as the
      // other is the failure `RecordingResult` exists to prevent.
      if (result.kind === 'empty') {
        this.toast.show('Recording stopped before any frames were captured.', 'error');
        return;
      }
      if (result.kind === 'streamed') {
        // No download link: the bytes went straight to the file the user picked.
        this.toast.show('Export complete — saved to the file you chose.');
        return;
      }

      const { downloadRecording } = await import('../recorder/saveFile.ts');
      // `sanitizeName` rather than a new helper: it exists precisely to make a
      // user-typed name safe to use as a filename, and it CAN return empty (a
      // name of "..." has nothing usable left), which is what the fallback is
      // for -- an export called ".mp4" would be a puzzle in a downloads folder.
      const safe = sanitizeName(this.bus.status().projectName) || 'fluoddity';
      const name = `${safe}.mp4`;
      downloadRecording(result.blob, name);
      this.toast.show(`Exported ${name} — ${(result.blob.size / 1e6).toFixed(1)} MB.`);
    } catch (err: unknown) {
      this.toast.show(`Could not finish the export: ${String(err)}`, 'error');
      console.warn('Recording failed to finalize:', err);
    }
  }

  /** Whether an export is in flight, for `main.ts`'s driver loop. */
  get exportInFlight(): boolean {
    return this.recorder !== null;
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
    this.panelToggle.dispose();
    this.recordingBar.dispose();
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
 *
 * **THE OVERLAY IS TWO ROWS NOW**, and this had to move again for it. The
 * context hint added beneath the bar is 11px text in a 5px-padded, 1px-bordered
 * box (~26px) plus the root's 4px column gap -- so ~30px, and 83 became 113.
 * Adding a third row, or changing the hint's padding or font size, means
 * revisiting this number: nothing enforces it, which is exactly what the
 * paragraph above is warning about.
 */
const PANEL_TOP_PX = 113;
