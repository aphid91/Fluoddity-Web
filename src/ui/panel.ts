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
// The two button constants, so `touchDragButton` names them rather than
// returning a bare 0 or 2 that the caller has to decode.
import { LEFT_BUTTON, RIGHT_BUTTON } from './inputTracker.ts';
import { RecordingBar } from './recordingBar.ts';
import { FpsCounter } from './fpsCounter.ts';
import { paintPerfLabels, watchPerfDrag } from './perfLabels.ts';
import { PhysicsSlider } from './physicsSlider.ts';
import { type Band, INITIAL_BAND } from '../perf/fpsBand.ts';
import { AutoCalibration } from '../perf/autoCalibrate.ts';
import { Splash } from './splash.ts';
import { isGated } from './gating.ts';
import { type InputState, EMPTY_INPUT } from './inputState.ts';
import { gateOpen, isRevealed } from './reveal.ts';
import { type Source, PREFS, settingFor } from './settingsSpec.ts';
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
import { describeImport, exportFiles, planImport } from '../config/saveTransfer.ts';
// STATIC, not a dynamic import, and for the reason `recorder/saveFile.ts` is
// imported statically: `chooseExportFolder` needs the click's user activation,
// and an `import()` is an await that spends it. This module imports nothing.
import { chooseExportFolder, readImportFolder, writeFolder } from './saveFolder.ts';
import {
  SHARE_LINK_WARN_LENGTH,
  SHARED_LINK_NAME,
  buildShareUrl,
  decodeShareText,
} from '../config/shareLink.ts';
import {
  type SettingChange,
  type SplashVariant,
  withSharedName,
} from '../config/urlOptions.ts';
import type { RgbaImage } from '../share/qrRender.ts';
import { DOWNSCALE_WARN_PX, QrCapacityError } from '../share/qrStamp.ts';
import {
  STAMP_INSET,
  ShareImageError,
  minimumCropFor,
  readShareImage,
  stampShareImage,
  stampSizeFor,
} from '../share/shareImage.ts';
import { pickCropRegion } from './cropOverlay.ts';
import {
  blobToImage,
  captureRegion,
  copyImage,
  downloadImage,
  imageFromPasteEvent,
  readClipboardImage,
} from './shareCapture.ts';
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
// STATIC. `main.ts` already imports this module statically, so a dynamic import
// here would split no chunk -- it would only add an await, which is the thing
// this file must not spend before reaching a picker. See `saveFolder.ts`.
import { type SaveChoice, downloadRecording } from '../recorder/saveFile.ts';
import type { RecordingSettings, Resolution } from '../recorder/recordingSettings.ts';
// VALUE imports, and safe ones -- the distinction the comment above draws.
// `recordingSettings.ts` is a pure leaf with no mediabunny and no WebGPU (see
// its header), which is why `orchestrator.ts` value-imports it too. Only
// `recorder.ts` has to stay type-only.
import {
  loadExportVideoShown,
  saveExportVideoShown,
} from '../recorder/recordingSettings.ts';

export interface PanelOptions {
  readonly bus: CommandBus;
  /** Where to mount the left (Project) panel. Defaults to a fixed container. */
  readonly leftContainer?: HTMLElement;
  /** Where to mount the right (Settings) panel. Defaults to a fixed container. */
  readonly rightContainer?: HTMLElement;
  /**
   * Whether to show the welcome splash on construction. Defaults to true.
   *
   * False still BUILDS it, so Help > Welcome and Help > Controls/Guide work
   * either way -- it
   * only suppresses the automatic first showing. That is what `?nosplash`
   * wants, and what a screenshot comparison wants.
   *
   * **THE CALLER DECIDES WHAT "FIRST" MEANS.** `main.ts` passes false for a
   * returning visitor, so the splash is a first-run experience rather than a
   * toll booth on every load. See its startup block.
   */
  readonly showSplash?: boolean;
  /**
   * Which splash document to open with. Defaults to the welcome.
   *
   * `?splash=` supplies this. Separate from `showSplash` because the two
   * answer different questions -- whether to show one at all, and which -- and
   * a link can force the second without changing the first.
   */
  readonly splashVariant?: SplashVariant;
  /**
   * Called whenever the splash closes, including the first-run one.
   *
   * Exists for the URL settings prompt, which must wait for the user to be
   * looking at the app before asking them anything. Fires on every close, not
   * just the first: the caller decides whether it still has a question.
   */
  readonly onSplashClosed?: () => void;
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
   * Build the touch layout. Defaults to false, which is the desktop UI.
   *
   * Resolved once by `main.ts` and handed down, never re-detected here -- see
   * `ui/mobile.ts` on why the answer is latched. Read at CONSTRUCTION, because
   * the two layouts differ in which elements exist rather than in how they are
   * styled.
   */
  readonly mobile?: boolean;
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
  /**
   * The canvas a share image is captured from.
   *
   * PASSED IN rather than found with `getElementById`, matching how `bus` and
   * `recording` arrive: the panel is constructed against a canvas `main.ts`
   * already holds, and reaching back into the document for it would give the
   * panel a second way to be wrong about which canvas is live.
   *
   * Optional so every existing test that builds a bare `Panel` keeps compiling.
   * The share-image commands report that they cannot run rather than throwing
   * when it is absent -- see `copyShareImage`.
   */
  readonly canvas?: HTMLCanvasElement;
}

/**
 * How long `tuneRate` waits for a run to finish before giving up.
 *
 * 20 seconds. The search is bounded at `MAX_PROBES` probes of ~20 frames each,
 * so a machine at 60 fps finishes in ~2s and one limping at 15 fps in ~11s --
 * this only fires when frames have stopped arriving altogether. See its use.
 */
const TUNE_CEILING_MS = 20000;

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
  /** The canvas share images are captured from, or `null`. See `PanelOptions`. */
  private readonly canvas: HTMLCanvasElement | null;
  /** Told when the splash closes, for the URL settings prompt. See its option. */
  private readonly onSplashClosed: (() => void) | null;
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
  private readonly tooltip: Tooltip;

  /**
   * Transient messages, for actions that change nothing on screen.
   *
   * Owned here for the tooltip's reasons: one on screen at a time, attached to
   * `document.body` so a pane rebuild cannot orphan it. NOT hidden by `X` -- it
   * is attached outside both containers, and someone who has hidden the UI can
   * still press Shift+C and deserves to be told whether it worked.
   */
  private readonly toast: Toast;

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
   * Whether this panel was built for touch. Fixed at construction.
   *
   * Held rather than passed straight through because several build steps
   * consult it -- the overlay below, and the container and tab decisions that
   * follow. See `PanelOptions.mobile`.
   */
  private readonly mobile: boolean;

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
   * The frame-rate button, top-right.
   *
   * Owned here for the recording bar's reasons -- attached to `document.body`,
   * so a pane rebuild cannot orphan it -- and **NOT hidden by `X`**, which is
   * the point of it rather than an oversight: the panels start hidden, and this
   * button is the way back to the three settings it is reporting on. Someone
   * whose app is struggling is exactly the person looking at the picture rather
   * than at a panel.
   *
   * The `showFpsCounter` preference is how it is turned off for good, which is
   * a different gesture from `X` and deliberately not conflated with it.
   */
  private readonly fpsCounter: FpsCounter;

  /**
   * Physics Rate, as a collapsible vertical slider at the right edge.
   *
   * On `document.body` beside the counter, so a pane rebuild cannot orphan it
   * -- and **hidden by `X` INVERTED**: it is shown only while the panels are
   * not, because the panels occupy the same space and Preferences carries the
   * same setting a few rows down. `applyHidden` is where that happens, and
   * `physicsSlider.ts` explains why the polarity is opposite to the counter's.
   */
  private readonly physicsSlider: PhysicsSlider;

  /**
   * The band the counter and the three tinted labels are showing.
   *
   * Held on the panel rather than passed through, because `refresh` receives it
   * from `main.ts` while `applyStatus` is where the labels get painted -- and
   * because the labels must be repainted after a REBUILD, which replaces every
   * element and takes the tint with it. See `paintLabels`.
   */
  private band: Band = INITIAL_BAND;

  /**
   * What `paintLabels` last wrote, so the per-frame case is one string compare.
   *
   * `null` before the first paint AND after every rebuild -- a rebuild discards
   * the elements this describes, so the memory of having painted them is stale
   * in the one way that matters.
   */
  private labelsShown: string | null = null;

  /**
   * Whether a performance slider is under the pointer right now.
   *
   * Read by `main.ts` each frame and handed to `stepBand` as its `immediate`
   * flag, which suspends the colour's dwell for the duration -- see
   * `watchPerfDrag` for why that inversion is right.
   *
   * Lives on the panel because the panel owns the container the listener is
   * delegated to, and because it is a fact about the UI rather than about the
   * simulation -- the same reasoning that keeps `hiddenFlag` off `Status`.
   */
  private draggingPerfSlider = false;

  /** Teardown for the perf-slider drag watcher. See `watchPerfDrag`. */
  private readonly perfDragRelease: () => void;

  /**
   * The Physics Rate auto-calibration in flight, or null.
   *
   * Held here for the recorder's reasons: the panel owns the button that starts
   * it and the label that reports it, while `main.ts` owns the frame loop that
   * drives it. `feedCalibration` is the seam -- see `PanelOptions.onCalibrateRate`.
   */
  private rateCalibration: AutoCalibration | null = null;

  /**
   * Resolved when the run in flight finishes, for the awaiting caller.
   *
   * Null for a run the BUTTON started -- nobody is waiting on that one, and the
   * toast is its own report. Set only by `tuneRateAsync`, which first-run
   * calibration awaits as its final step.
   */
  private rateCalibrationDone: (() => void) | null = null;

  /**
   * Told which probe the run is on, for the splash's progress counter.
   *
   * Null for a button-started run: the button's own label carries the progress,
   * and the splash is not up.
   */
  private rateCalibrationProgress: ((probe: number) => void) | null = null;

  /**
   * Whether this calibration was the thing that unpaused the simulation.
   *
   * The run needs frames to measure, so a paused simulation has to be resumed --
   * but only a pause THIS started may be undone at the end. Someone who paused
   * deliberately and then pressed calibrate should be handed their pause back;
   * someone who was already running should not be paused when it finishes. Same
   * shape, and same reasoning, as `pausedBySplash` above.
   */
  private unpausedByCalibration = false;

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
   * **PERSISTED**, and it did not used to be. The original reasoning was that
   * ticking this means "I am exporting something now" -- a temporary peek, like
   * expanding a Load category, rather than a lasting statement about how you
   * work. Watching it in use settled the question the other way: someone who
   * exports video does it repeatedly, and re-ticking the box every reload to get
   * a tab back is the same re-assertion the three `advanced*` flags were made
   * persistent to avoid. It passes their test after all.
   *
   * Stored beside the recording settings rather than in `Preferences`, because
   * it belongs to the same lazily-loaded feature they do -- see
   * `RECORDING_STORAGE_KEY`. It still DEFAULTS to false, so a first-run user
   * meets the same two-tab panel as before.
   *
   * Toggling it goes through `rebuild()`, because a tab that exists or does not
   * is exactly the kind of change per-frame refresh cannot express -- the same
   * reasoning as the tier flags.
   */
  private exportVideoShown = loadExportVideoShown();

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
    this.canvas = opts.canvas ?? null;
    this.onSplashClosed = opts.onSplashClosed ?? null;
    // FIRST, because the build steps below branch on it -- the overlay, the
    // containers and the tab list all ask which layout they are building.
    this.mobile = opts.mobile ?? false;
    // With it, since every section's `attach` call goes through this one object
    // and the affordance is decided per instance. See `tooltip.ts`.
    this.tooltip = new Tooltip(document.body, this.mobile);
    // Both move to the TOP on touch, where the bottom edge now holds the control
    // bar -- see `toast.ts` and `recordingBar.ts` for why that inverts.
    this.toast = new Toast(document.body, this.mobile);
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
    // The gear rides the mutation bar now, at its right end -- see the bar's own
    // construction for why it moved back. Still goes through `setHidden` exactly
    // as `X` and the Editor menu item do, so all three routes share one flag and
    // one notification.
    this.overlay = new MutationOverlay({
      send,
      onToggleUi: () => {
        this.setHidden(!this.hiddenFlag);
      },
      // Passed through rather than re-detected: `main.ts` resolves this once
      // and hands it down, so every part of the UI agrees about which layout it
      // is building. See `ui/mobile.ts`.
      mobile: this.mobile,
    });
    // Cancel through the same path the tab's button uses, so there is one
    // meaning of cancelling however it is reached.
    this.recordingBar = new RecordingBar(() => {
      this.recorder?.cancel();
    }, this.mobile);
    // The click does what Export Video's menu item does for its own tab: reveal
    // the panels if they are hidden and bring the right tab to the front. See
    // `showPerformanceSettings`.
    this.fpsCounter = new FpsCounter({
      onClick: () => {
        this.showPerformanceSettings();
      },
    });
    // The hidden-panels route to Physics Rate. Sends through the same bus as
    // the Preferences row it mirrors, so the two cannot disagree -- see
    // `physicsSlider.ts` on why one field is worth two widgets here.
    this.physicsSlider = new PhysicsSlider({
      send,
      // Passed down rather than re-detected, like the overlay's above.
      mobile: this.mobile,
      // Right-clicking the control runs the SAME search the Preferences button
      // drives -- `startRateCalibration` is the one entry point, so the two
      // gestures cannot diverge in what they measure or how they restore the
      // pause afterwards. See `PhysicsSliderOptions.onCalibrate`.
      //
      // TOGGLES, so a second right-click stops a run rather than being ignored.
      // This control is on screen precisely when the panels are hidden, which is
      // when the Preferences button that would otherwise cancel is out of reach
      // -- without this, a run started here could only be stopped by opening a
      // panel.
      onCalibrate: () => {
        if (this.rateCalibration === null) this.startRateCalibration();
        else this.cancelRateCalibration();
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
      // Wording only -- the dismiss rule itself branches per event. See
      // `SplashOptions.mobile`.
      mobile: this.mobile,
      // Which document opens on construction. `main.ts` passes a forced one
      // through from `?splash`; otherwise the welcome, as it always has.
      ...(opts.splashVariant !== undefined ? { variant: opts.splashVariant } : {}),
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
        // Announced AFTER the pause bookkeeping, so a listener that opens a
        // modal cannot run while this method is half done. `Splash` fires only
        // on real transitions, so this cannot double-report a close.
        if (!visible) this.onSplashClosed?.();
      },
    });
    this.menuBar = new MenuBar({
      send,
      mobile: this.mobile,
      status: () => this.bus.status(),
      onSave: () => {
        this.dialogs.openSave(this.bus.status().projectName);
      },
      onCopyShareLink: () => {
        this.copyShareLink();
      },
      onPasteShareLink: () => {
        void this.pasteShareLink();
      },
      onCopyScreenshot: () => {
        void this.copyScreenshot();
      },
      onCopyShareImage: () => {
        void this.copyShareImage();
      },
      // NOT `void this.exportSaves()` with an await inside before the picker --
      // see `exportSaves`. The gesture is spent by the first await, so the
      // picker has to be the first thing that happens.
      onExportSaves: () => {
        this.exportSaves();
      },
      onImportSaves: () => {
        this.importSaves();
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
        this.splash.show('welcome');
      },
      onShowGuide: () => {
        this.showGuide();
      },
      onShowControls: () => {
        this.showControls();
      },
      onToggleExportVideo: () => {
        this.setExportVideoShown(!this.exportVideoShown);
      },
      isExportVideoShown: () => this.exportVideoShown,
    });

    this.left = {
      container: opts.leftContainer ?? sideContainer(LEFT, this.mobile),
      pane: new Pane({ container: document.createElement('div') }),
      sections: [],
    };
    this.right = {
      container: opts.rightContainer ?? sideContainer(RIGHT, this.mobile),
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

    // The RIGHT container only: both performance sliders are `PREFS` fields and
    // so live in the Preferences tab. Bound to the container rather than to the
    // blades for the reason the focus releasers above are -- it outlives every
    // rebuild, and a per-blade listener would be discarded by the next one.
    this.perfDragRelease = watchPerfDrag(this.right.container, (dragging) => {
      this.draggingPerfSlider = dragging;
    });
    // **A SECOND WATCH, because the physics slider is outside both containers.**
    // It carries the same `data-setting` as the Preferences blade, so the rule
    // recognises it -- but a listener bound to the right container cannot see
    // an element that is not in it. Dragging here suspends the band's dwell
    // exactly as dragging the panel's own slider does, which is the whole point:
    // the user is looking straight at the control asking what it costs.
    const sliderDragRelease = watchPerfDrag(this.physicsSlider.element, (dragging) => {
      this.draggingPerfSlider = dragging;
    });
    const panelDragRelease = this.perfDragRelease;
    this.perfDragRelease = (): void => {
      panelDragRelease();
      sliderDragRelease();
    };

    this.buildBoth();

    // LAST, and after `buildBoth`. The panes must exist before their containers
    // are hidden, or the first reveal would show two empty columns; and
    // `applyHidden` rather than `setHidden` because there is nothing to notify
    // yet -- `main.ts` seeds `panelOpen` from `isOpen` immediately after this
    // returns.
    if (opts.startHidden === true) this.applyHidden(true);
    // **UNCONDITIONAL, unlike the line above.** `applyHidden` runs at
    // construction only for a hidden start, which is enough for the containers
    // -- they are already visible in their own stylesheet. The physics slider
    // is the opposite polarity and mounts HIDDEN, so an un-hidden start would
    // otherwise never tell it anything and it would stay invisible for the
    // session. Seeding it from the flag covers both starts with one statement.
    this.physicsSlider.setUiHidden(this.hiddenFlag);
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
    // EMPTY ON TOUCH -- Project moves into the right panel's tab strip, because
    // two 320px columns do not fit on a phone. The build loop runs over nothing
    // rather than being skipped, so refresh, dispose and the hidden-state
    // handling below all stay exactly as they are. See `panelModel.ts`.
    this.left.pane = this.buildSide(this.left, LEFT, leftSections(this.mobile), status);
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

    // BEFORE the list is replaced. A section may hold something the pane cannot
    // reclaim -- Recording Controls listens on the window for the end of a
    // slider drag -- and this method is reached on every rebuild, so dropping
    // the old handles without asking them to let go leaks one set per toggle of
    // any tier checkbox or of Export Video.
    for (const handle of side.sections) handle.dispose?.();
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
          // Project becomes a tab here exactly when the left panel is empty --
          // the same decision `leftSections` makes, read from the same flag, so
          // the two cannot both claim it and render it twice.
          this.mobile,
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
      // Read by `addInput` alone, so that a typed value survives the keyboard
      // being dismissed -- on a phone there is often no Enter key to commit
      // with. See `controls.ts`.
      mobile: this.mobile,
      requestRebuild: () => {
        // Deferred: disposing a pane from inside its own event handler reenters
        // Tweakpane's own teardown. A microtask is enough.
        queueMicrotask(() => {
          this.rebuild();
        });
      },
      // RIGHT ONLY: Physics Rate is a `PREFS` field, so its button can only be
      // built in the Preferences tab. Omitting it for the left panel means the
      // Project section cannot accidentally grow a calibrate button by reading a
      // context member that was never meant for it.
      ...(which === RIGHT ? { calibrateRate: this.calibrateRateContext() } : {}),
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
    // The tint lives on elements that are about to be replaced, so the memory of
    // having applied it is now describing nodes that no longer exist. Cleared
    // here rather than in `buildBoth` because THIS is the operation that
    // invalidates it -- see `paintLabels`.
    this.labelsShown = null;
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
  refresh(
    status: Status,
    input: InputState = EMPTY_INPUT,
    /**
     * This frame's frame-rate readout, or null where there is none.
     *
     * Null under `?nopanel`-adjacent conditions and in the DOM tests, which
     * construct a Panel with no frame loop behind it -- the counter then keeps
     * whatever it last showed rather than being fed a fabricated number.
     *
     * Passed IN rather than measured here for the reason `PanelOptions.recording`
     * is injected: the measurement needs the `GPUDevice` and the frame loop, and
     * `CommandBus` admits neither. `main.ts` owns both and hands over the answer.
     */
    fps: { readonly band: Band; readonly readout: string } | null = null,
  ): void {
    // BEFORE the hidden check: the menu bar stays on screen when the panel is
    // hidden -- it holds the only visible way to bring it back -- and an open
    // dialog outlives a hide entirely. Starving either of status would freeze a
    // menu's checkmarks and strand a save dialog waiting for an outcome it
    // could no longer see.
    // FIRST, and above the hidden check with the menu bar and the overlay. A
    // notice describes something that just happened to the user's work -- an
    // undo, a preset load -- and those are all reachable while the panels are
    // hidden, which is the app's default state. Below the early return the
    // toast would fire for some routes and silently not for others.
    //
    // `Status.notice` is drained by `status()`, so this reads it exactly once;
    // an empty string is the common case and shows nothing.
    if (status.notice !== '') this.toast.show(status.notice);

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

    // ALSO above the hidden check, and this one is emphatic about it: the button
    // is NOT hidden by `X`, because it is the route back to the settings it
    // reports on and the panels start hidden. Below this line it would freeze
    // the moment someone pressed `X` -- which is the state they spend most of
    // their time in.
    //
    // The preference is read from `editPrefs`, which is EMPTY while the panels
    // are shut (`settingsSources`'s optimization). So an absent value means
    // "no panel is open to tell us", not "the user turned it off", and it
    // degrades to SHOWN -- the same live-read-with-a-safe-default shape
    // `refreshReroll` uses for a missing `mutationScale`.
    //
    // `status.showFpsCounter` is what makes that honest: it rides on `Status`
    // beside `ruleIsGenerated` for precisely this reason -- a value the
    // always-visible chrome reads, which therefore cannot live in a payload
    // that empties when the panel closes.
    //
    // **THE PREFERENCE ALONE DECIDES VISIBILITY**, not the preference AND
    // whether a reading has arrived. Those are different questions, and
    // conflating them made the badge appear a few seconds into every session --
    // a control that pops into existence unannounced, in the corner, over the
    // artwork. `startBand()` supplies a neutral "60" for the warmup window, so
    // there is always something honest to show.
    if (fps !== null) this.band = fps.band;
    this.fpsCounter.update(this.band, fps?.readout ?? '', status.showFpsCounter);

    // ALSO above the hidden check, and this one MOST of all: the slider is
    // shown only while the panels are hidden, so refreshing it below the early
    // return would freeze it in the exact state it exists to serve. It takes
    // `this.band` rather than `fps` for the reason the line above does -- the
    // held band is what survives the warmup window.
    this.physicsSlider.refresh(status, this.band);

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

  // =========================================================================
  // Physics Rate auto-calibration
  // =========================================================================

  /**
   * Begin a calibration run, unpausing first if it has to.
   *
   * **THE SIMULATION MUST BE RUNNING TO BE MEASURED**, and a paused frame is
   * deliberately not one this app measures -- `frame()` skips `runFrame` and
   * re-renders a still, so every probe would report an idle loop and the search
   * would drive the rate to the ceiling. Pressing the button is an unambiguous
   * request to find out what the machine can do, so resuming is implied by it.
   *
   * Reads the state first and only toggles when it must, the same shape
   * `startExport` and the splash both use: the bus offers `togglePause` and no
   * absolute setter, so a blind toggle would pause a running simulation.
   */
  private startRateCalibration(): void {
    if (this.rateCalibration !== null) return;

    const setting = settingFor(PREFS, 'physicsSteps');
    if (setting === null) return; // A renamed field: no button rather than a crash.

    const status = this.bus.status();
    this.unpausedByCalibration = status.paused;
    if (status.paused) this.bus.dispatch({ kind: 'togglePause' });

    // **FROM THE NAMED `Status` FIELD, NOT FROM `editPrefs`.** That payload is
    // empty whenever no panel is open (`settingsSources`'s optimization), and
    // first-run calibration runs with the panels hidden behind the splash -- so
    // the starting rate would read as `undefined` and fall back to the floor,
    // throwing away the rung the ladder just measured. See `Status.physicsSteps`.
    const current = status.physicsSteps;
    this.rateCalibration = new AutoCalibration({
      lo: setting.lo,
      hi: setting.hi,
      startRate: current > 0 ? current : setting.lo,
      // Straight through `editSetting`, exactly as dragging the slider does, so
      // the value persists and the panel's own binding follows it on the next
      // refresh. Nothing about this path is special-cased.
      setRate: (rate) => {
        this.bus.dispatch({ kind: 'editSetting', setting, value: rate });
      },
      onProgress: (progress) => {
        this.rateCalibrationProgress?.(progress.probe);
      },
    });
  }

  /**
   * Run a calibration and resolve when it finishes. First-run's final step.
   *
   * **THE SAME `AutoCalibration` THE BUTTON DRIVES**, against the same live rAF
   * frames, so a first-time visitor is tuned by exactly the measurement a
   * returning one gets from pressing the button. The alternative -- a second
   * driver submitting its own frames so this could run inside `calibrate()` --
   * would measure `probeFrame`'s physics-only render, which omits the camera,
   * bloom and motion blur that the user's frames actually pay for, and would
   * therefore commit a rate that is too high.
   *
   * **RESOLVES RATHER THAN THROWING**, on every path including a run that could
   * not start. First-run calibration is best-effort by design (`calibrate.ts`'s
   * "Everything here is best-effort"), and this is its last step -- a rejection
   * here would strand the splash locked over an app the user cannot reach.
   *
   * `onProbe` is told each probe number so the splash can keep one continuous
   * counter across both phases.
   */
  async tuneRate(onProbe?: (probe: number) => void): Promise<void> {
    // A run already going -- the button, most likely, since the splash blocks
    // little else. Leave it alone rather than starting a second.
    if (this.rateCalibration !== null) return;

    this.rateCalibrationProgress = onProbe ?? null;
    this.startRateCalibration();

    // `startRateCalibration` refuses when the registry entry is missing. Nothing
    // is in flight, so there is nothing to await.
    if (this.rateCalibration === null) {
      this.rateCalibrationProgress = null;
      return;
    }

    await new Promise<void>((resolve) => {
      // **A CEILING, FOR THE SAME REASON `calibrate.ts` HAS ONE.** This resolves
      // when frames arrive, and there are states where they stop arriving --
      // rAF halts entirely in a backgrounded tab, and a device loss stops the
      // loop for good. Either would leave the awaiting caller hanging forever
      // with the splash locked over it, which is the one failure worse than a
      // badly-tuned physics rate.
      //
      // Generous, because it must never fire on a run that was merely slow: the
      // search is bounded at `MAX_PROBES` probes of ~20 frames, so even a
      // machine limping at 15 fps finishes inside a third of this.
      const ceiling = setTimeout(() => {
        if (this.rateCalibration === null) return;
        console.warn('Physics-rate tuning timed out; keeping the rate it started from.');
        // Restores rather than commits -- see `AutoCalibration.cancel`. A run
        // that never delivered frames has measured nothing worth keeping, and
        // this calls back into `finishRateCalibration`, which resolves below.
        this.cancelRateCalibration();
      }, TUNE_CEILING_MS);

      // Cleared however the run ends, so a finished run never leaves a timer
      // alive to fire over a later one.
      this.rateCalibrationDone = () => {
        clearTimeout(ceiling);
        resolve();
      };
    });
  }

  /**
   * Stop a run early, putting the rate back where it started.
   *
   * See `AutoCalibration.cancel` for why abandoning restores rather than
   * commits. The pause is restored here for the same reason it is on the normal
   * finish -- the user's pause outlives our need for frames.
   */
  private cancelRateCalibration(): void {
    if (this.rateCalibration === null) return;
    this.rateCalibration.cancel();
    this.finishRateCalibration();
  }

  /** Common teardown: drop the run, hand back a pause we took, wake the waiter. */
  private finishRateCalibration(): void {
    this.rateCalibration = null;
    this.rateCalibrationProgress = null;

    if (this.unpausedByCalibration) {
      this.unpausedByCalibration = false;
      // Re-read rather than trusting the flag: pausing stays reachable throughout
      // (the menu bar and Space both work), so the simulation may already be
      // where we want it.
      if (!this.bus.status().paused) this.bus.dispatch({ kind: 'togglePause' });
    }

    // LAST, and unconditionally. `tuneRate` is awaited by first-run calibration,
    // which holds the splash locked until it returns -- so a path that finished
    // the run without resolving would leave the user staring at a locked splash
    // with no way out. Same posture as `Panel.calibrate`'s `finally`.
    const done = this.rateCalibrationDone;
    this.rateCalibrationDone = null;
    done?.();
  }

  /**
   * Offer one frame to a run in flight. Called every frame by `main.ts`.
   *
   * Takes the interval the FPS counter already measures rather than timing
   * anything itself -- one clock, one set of frames, and no second rAF loop
   * racing the real one.
   */
  feedCalibration(frameMs: number): void {
    const run = this.rateCalibration;
    if (run === null) return;
    run.onFrame(frameMs);
    if (!run.finished) return;

    const rate = run.result;
    // Read BEFORE the teardown clears it: a run someone is awaiting is a
    // first-run one, and that path reports through the splash it is already
    // holding. A toast there would fire behind the splash, unseen, and then
    // linger over the app once it closed -- announcing something the user never
    // asked for on their very first frame.
    const awaited = this.rateCalibrationDone !== null;
    this.finishRateCalibration();
    if (rate !== null && !awaited) {
      this.toast.show(`Physics Rate calibrated to ${String(rate)} for this project.`);
    }
  }

  /** What the calibrate button says right now. */
  private rateCalibrationLabel(): string {
    const run = this.rateCalibration;
    if (run === null) return 'Auto-calibrate Physics Rate';
    // Naming the rate being probed is what makes the wait legible: the slider is
    // visibly jumping, and this says why.
    return `Calibrating… ${String(run.probingRate)} (click to stop)`;
  }

  /** What the Preferences section is handed. See `SectionContext.calibrateRate`. */
  private calibrateRateContext(): NonNullable<SectionContext['calibrateRate']> {
    return {
      start: () => {
        this.startRateCalibration();
      },
      cancel: () => {
        this.cancelRateCalibration();
      },
      label: () => this.rateCalibrationLabel(),
      running: () => this.rateCalibration !== null,
    };
  }

  /**
   * Bring the three performance settings into view. The FPS button's click.
   *
   * **THE SAME TWO STEPS `setExportVideoShown` TAKES**, in the same order and
   * for the same reason: reveal the panels if they are hidden -- which is the
   * DEFAULT state (`startHidden: true` in `main.ts`), so without this the common
   * case is clicking the badge and seeing nothing happen -- and bring the tab
   * holding the settings to the front.
   *
   * **NO REBUILD, unlike the recording path.** The Preferences tab always
   * exists, so there is nothing to construct; `setActiveTab` is a `display`
   * toggle over folders that are already built. A rebuild here would drop folder
   * expansion state and replace every node to show controls that were one CSS
   * property away, and it would also throw away the label tint mid-frame.
   *
   * Deliberately does NOT scroll to or highlight the individual controls. The
   * three are already tinted the counter's own colour, which is the connection
   * this click is making -- and a panel that jumped its own scroll position
   * would fight a user who had put it where they wanted it.
   */
  private showPerformanceSettings(): void {
    if (this.hiddenFlag) this.setHidden(false);
    this.setActiveTab(PREFS_TAB);
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
    this.paintLabels();
  }

  /**
   * Tint World Size, Physics Rate and Motion Blur to match the counter.
   *
   * Guarded on the rendered result, like every other per-frame writer here: the
   * band moves rarely (it is debounced by three seconds) and the tint is three
   * `querySelectorAll` calls, so doing it every frame would be real DOM work to
   * change nothing.
   *
   * **The guard is cleared by `rebuild`, and it has to be.** A tier toggle
   * replaces every element in both panes, so the new labels are untinted while
   * `labelsShown` still claims they are painted -- the tint would silently stop
   * applying until the band happened to change. Clearing the memory alongside
   * the elements it describes is what keeps the two in step.
   *
   * **DOES NOT FOLLOW THE `showFpsCounter` PREFERENCE**, and that reverses an
   * earlier decision. The argument for following it was that a colour with no
   * badge to explain it is a mystery -- but the tint is not only an echo of the
   * badge. It is the one thing on screen that says WHICH THREE SETTINGS decide
   * performance, and that is worth knowing whether or not someone wants a
   * frame-rate readout in the corner of their artwork. Turning the counter off
   * is a statement about the badge, not a request to stop marking these three.
   */
  private paintLabels(): void {
    const key = this.band;
    if (key === this.labelsShown) return;
    this.labelsShown = key;

    // The right panel only: all three settings are `PREFS` fields and so live in
    // the Preferences tab. Searching the left panel too would be three more
    // queries per repaint that can never match.
    paintPerfLabels(this.right.container, this.band);
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
   * Whether a performance slider is being dragged this instant.
   *
   * `main.ts` passes this to `stepBand` as its `immediate` flag. See
   * `draggingPerfSlider`.
   */
  get adjustingPerformance(): boolean {
    return this.draggingPerfSlider;
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
    // and the overlay is the picture's own controls. It is told anyway, because
    // its gear REPORTS this flag -- gold while the panels show. That state
    // never reaches the Orchestrator, so this call is the only notification
    // there is, and every route that hides the panels comes through here.
    this.overlay.setHidden(hidden);
    // **INVERTED, and that is the point of it.** The panels occupy the right
    // edge this slider sits in, and Preferences already carries Physics Rate as
    // a dedicated row -- so showing both would put two live controls for one
    // field within an inch of each other, where a drag on either silently moves
    // the other. It takes the panels' flag rather than its own negation of it,
    // so there is one statement of the rule rather than two that can drift.
    this.physicsSlider.setUiHidden(hidden);
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
    // `?name=Shared-<project>` rides along, so the recipient sees the link
    // named after what the sender had open rather than the bare "Shared Link".
    // Built here rather than in `buildShareUrl` because that function is pure
    // and takes a location; this is the one place that knows the live project's
    // name. `withSharedName` collapses an existing prefix, so a link that has
    // been passed along several times does not accumulate them.
    const loc = withSharedName(window.location, this.bus.status().projectName);
    const url = buildShareUrl(loc, this.bus.projectDocument());
    void copyText(url).then((ok) => {
      this.showShareResult(ok, url);
    });
  }

  /**
   * Capture a region of the canvas and copy it as an ordinary picture.
   *
   * ## NO STAMP, NO MINIMUM, NO WARNING
   *
   * All three restrictions on `copyShareImage` exist to protect the QR code, and
   * there is no QR code here. A plain screenshot of any size is a perfectly good
   * screenshot, so the overlay is given a zero minimum and a zero warning
   * threshold and simply gets out of the way -- see `CropOverlayOptions`, where
   * zero is the documented way to say "no opinion" for both.
   *
   * Sharing the overlay rather than writing a second one is the point: the drag,
   * the dimming, the readout and the Escape handling are identical, and the only
   * real difference between the two commands is what happens to the pixels
   * afterwards.
   */
  async copyScreenshot(): Promise<void> {
    if (this.canvas === null) {
      this.toast.show('Screenshots are not available in this view.', 'error');
      return;
    }

    const region = await pickCropRegion({
      minDevicePx: 0,
      stampDevicePx: 0,
      insetDevicePx: 0,
      warnAboveDevicePx: 0,
    });
    if (region === null) return;

    try {
      const shot = await captureRegion(this.canvas, region);
      if (await copyImage(shot)) {
        this.toast.show(`Screenshot copied — ${shot.width}x${shot.height}.`);
        return;
      }
      await downloadImage(shot, 'fluoddity.png');
      this.toast.show('Could not reach the clipboard — the screenshot was downloaded instead.');
    } catch (err: unknown) {
      this.toast.show('Could not capture the screenshot.', 'error');
      console.warn(`Screenshot failed: ${String(err)}`);
    }
  }

  /**
   * Capture a region of the canvas and copy it with the project stamped in.
   *
   * ## THE IMAGE IS THE PROJECT
   *
   * The point of the feature: post the picture anywhere that carries pictures,
   * and anyone who can save it can load what made it. No link to keep beside it
   * and nothing for a chat client to truncate -- which is the failure
   * `shareLink.ts` warns about at 8000 characters and cannot otherwise prevent.
   *
   * ## THE ORDER OF OPERATIONS IS FORCED
   *
   * The payload has to exist BEFORE the crop overlay opens, because the stamp's
   * size -- and therefore the minimum selectable region -- depends on how long
   * the link is, which depends on how many configs the project holds. So the
   * document is serialized first, the minimum is computed from it, and only then
   * does the user get to drag. Doing it the other way round would mean telling
   * someone their perfectly good selection was too small AFTER they made it.
   *
   * ## CAPTURE HAPPENS AFTER THE OVERLAY IS GONE
   *
   * `pickCropRegion` resolves once it has removed its own elements, and the
   * capture reads the canvas underneath. If the overlay were still mounted the
   * read would be unaffected -- it is a separate element, not a canvas filter --
   * but the dimming would be on screen while the browser encoded, which reads as
   * a freeze. Sequencing it after is free and looks deliberate.
   */
  async copyShareImage(): Promise<void> {
    if (this.canvas === null) {
      this.toast.show('Screenshot sharing is not available in this view.', 'error');
      return;
    }

    const url = buildShareUrl(window.location, this.bus.projectDocument());

    // CAPACITY IS CHECKED FIRST, because a project too big for a QR is a real
    // and reachable state -- a stamp gives out after two or three configs, far
    // below the link's own limit -- and the honest answer is to say so and offer
    // the link instead, not to open an overlay that cannot end in success.
    let minDevicePx: number;
    let stampDevicePx: number;
    try {
      minDevicePx = minimumCropFor(url);
      // ASKED FOR DIRECTLY, never inferred from the minimum. These were related
      // by a factor of two when the minimum was a multiple; it is an addition
      // now, and a derived value would have silently drawn the preview square at
      // the wrong size the moment that changed.
      stampDevicePx = stampSizeFor(url);
    } catch (err: unknown) {
      if (err instanceof QrCapacityError) {
        this.toast.show(
          'This project is too large to fit in a QR code. Use Copy Share Link ' +
            'instead — the link has no such limit.',
          'error',
        );
        return;
      }
      throw err;
    }

    const region = await pickCropRegion({
      minDevicePx,
      stampDevicePx,
      insetDevicePx: STAMP_INSET,
      warnAboveDevicePx: DOWNSCALE_WARN_PX,
    });
    if (region === null) return; // Cancelled; say nothing.

    try {
      const shot = await captureRegion(this.canvas, region);
      const stamped = stampShareImage(shot, url);
      const copied = await copyImage(stamped.image);

      if (copied) {
        this.toast.show(
          `Image copied — ${stamped.image.width}x${stamped.image.height}, ` +
            `QR v${stamped.version}. Paste it anywhere; Ctrl+V here loads it back.`,
        );
        return;
      }

      // THE FALLBACK IS A DOWNLOAD, not a prompt. `copyShareLink` can offer its
      // text in a `window.prompt` when the clipboard refuses; an image has no
      // equivalent, and a download needs no permission and no secure origin --
      // which are exactly the conditions that made the copy fail.
      await downloadImage(stamped.image, 'fluoddity-share.png');
      this.toast.show('Could not reach the clipboard — the image was downloaded instead.');
    } catch (err: unknown) {
      if (err instanceof ShareImageError) {
        // Should be unreachable: the overlay grows an undersized selection
        // before returning it. Reported rather than thrown because the third
        // layer of that guard exists to be a message, not a crash.
        this.toast.show('That area was too small to hold the code.', 'error');
        return;
      }
      this.toast.show('Could not build the share image.', 'error');
      console.warn(`Share image failed: ${String(err)}`);
    }
  }

  /**
   * Decode a stamped image and adopt what it carries.
   *
   * Split out so the arrival routes cannot drift -- the Ctrl+V event, the
   * clipboard read behind Shift+V, and a dropped or picked file. Each finds an
   * image its own way and they all land here.
   */
  private applyShareImage(image: RgbaImage): boolean {
    const text = readShareImage(image);
    if (text === null) {
      this.toast.show(
        'No Fluoddity code found in that image. It may have been cropped or ' +
          'resized too far.',
        'error',
      );
      return false;
    }
    this.applyShareText(text);
    return true;
  }

  /**
   * Handle a native paste. Returns whether the event was consumed.
   *
   * ## WHY NATIVE PASTE IS WORTH INTERCEPTING AT ALL
   *
   * Ctrl+V is what everyone will actually press. `Shift+V` exists and is
   * documented, but a user who has just copied a stamped image from a timeline
   * has no reason to think this app wants a special key for it -- so the
   * gesture has to be the ordinary one.
   *
   * ## THE EVENT PATH IS BETTER THAN THE API, NOT A FALLBACK FOR IT
   *
   * A `paste` event carries its data directly, so it needs no `clipboard-read`
   * permission and works on Firefox, where `navigator.clipboard.read` does not
   * exist for page script at all. The menu item has no event and must use the
   * API; this path should be preferred wherever there is one.
   *
   * ## IT MUST NOT EAT A PASTE MEANT FOR A TEXT FIELD
   *
   * The caller checks the event target before delegating here -- see `main.ts`.
   * Pasting into the project-name box, the notes field or any Tweakpane input
   * has to keep working, and silently hijacking it would be the kind of bug a
   * user cannot report because they cannot see what took their keystroke.
   */
  async handlePasteEvent(event: ClipboardEvent): Promise<boolean> {
    const image = await imageFromPasteEvent(event);
    if (image !== null) return this.applyShareImage(image);

    // No image, so try text -- a pasted URL is the commoner case and arrives
    // through the same gesture. Read from the event rather than the clipboard
    // API for the permission reason above.
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text.trim() === '') return false;
    // ONLY CONSUMED IF IT IS OURS. `decodeShareText` returns null for text that
    // is not a share link, and swallowing an unrelated paste would be the same
    // hijack the header warns about, one level further in.
    try {
      if (decodeShareText(text) === null) return false;
    } catch {
      // Ours but damaged. `applyShareText` gives the better message.
    }
    this.applyShareText(text);
    return true;
  }

  /**
   * Load a project from an image file the user picked or dropped.
   *
   * The route that needs no clipboard at all, which matters because saving an
   * image off a timeline and re-copying it is two steps a file picker does in
   * one.
   */
  async loadShareImageFile(file: Blob): Promise<void> {
    try {
      this.applyShareImage(await blobToImage(file));
    } catch (err: unknown) {
      this.toast.show('That file could not be read as an image.', 'error');
      console.warn(`Share image file failed: ${String(err)}`);
    }
  }

  /**
   * Load the project from whatever is on the clipboard -- a link OR an image.
   *
   * `copyShareLink` inverted, and deliberately forgiving about what it is given:
   * `decodeShareText` takes a whole URL, a bare fragment, or either wrapped in
   * the whitespace a hard-wrapping mail client leaves behind.
   *
   * ## TEXT AND IMAGES BOTH, BECAUSE "PASTE" MEANS ONE THING TO A USER
   *
   * This used to read only text, so a stamped screenshot on the clipboard fell
   * through to the "Paste a Fluoddity share link:" prompt -- asking for
   * something the user did not have, when what they DID have was sitting right
   * there and perfectly readable. Shift+V and Ctrl+V now accept the same two
   * things, because the distinction between them was never one anybody outside
   * this file could see.
   *
   * ORDER: TEXT FIRST, THEN IMAGE. A link is cheaper to decode than a QR scan
   * over a full-size screenshot, and a clipboard holding both almost always got
   * the text from a copied URL -- so the cheap, likely case goes first and the
   * image work only happens when it has to.
   *
   * THE PROMPT IS NOT A LAST RESORT HERE, it is the Firefox path. Reading the
   * clipboard is gated behind a permission prompt in Chrome and is not
   * implemented for page script in Firefox at all -- so unlike copying, where
   * the fallback is rare, this one is the ONLY route for a whole browser engine.
   * Asking for the link directly costs one dialog and works everywhere.
   */
  async pasteShareLink(): Promise<void> {
    const clip = await readText();
    // `null` is "could not read", which is not the same as "read nothing". Both
    // fall through to the image attempt below, because neither means the
    // clipboard is empty -- only that it holds no text we can see.
    if (clip !== null && clip.trim() !== '') {
      this.applyShareText(clip);
      return;
    }

    // No usable text. Before giving up on the clipboard and asking, look for a
    // stamped image -- which is the case that used to produce a prompt for a
    // link the user was not holding.
    const image = await readClipboardImage();
    if (image !== null) {
      this.applyShareImage(image);
      return;
    }

    const typed = window.prompt('Paste a Fluoddity share link:') ?? '';
    this.applyShareText(typed);
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
   * Open the guide overlay. The `H` key, and Help → Guide.
   *
   * Fronts the splash for the reason `setSplashStatus` does. Safe while the
   * welcome is already up: `show` swaps the document in place rather than
   * refusing, which is what makes `H` work as the welcome's own last line
   * promises it does.
   */
  showGuide(): void {
    this.splash.show('guide');
  }

  /**
   * Open the key and mouse reference. The `?` / `/` keys, and Help → Controls.
   *
   * The same surface as `showGuide`, its other document -- and it swaps in
   * place for the same reason, so `?` works with the guide already up.
   */
  showControls(): void {
    this.splash.show('controls');
  }

  /**
   * Ask whether a link may change these editor settings.
   *
   * Fronts `Dialogs` for the reason `setSplashStatus` fronts the splash:
   * `main.ts` owns the startup sequence but should not reach through the panel
   * to one of its surfaces. Resolves with the accepted subset -- see
   * `Dialogs.openUrlSettings` for why it resolves rather than dispatching.
   */
  askUrlSettings(
    changes: readonly SettingChange[],
  ): Promise<readonly SettingChange[]> {
    return this.dialogs.openUrlSettings(changes);
  }

  /**
   * Whether a splash is currently up.
   *
   * For the startup sequence, which defers the URL settings prompt until the
   * splash closes and so has to know whether one will ever close. See
   * `askForSettings` in `main.ts`.
   */
  get splashVisible(): boolean {
    return this.splash.visible;
  }

  /**
   * Run the rate search the Auto-calibrate button runs, and report it.
   *
   * For the world-size case in `main.ts`: accepting a new world size leaves the
   * physics rate tuned for the old one, so the rate has to be re-derived. This
   * is the BUTTON's path rather than the first-run ladder -- the world size is
   * already decided, and only the rate is in question.
   */
  async recalibrateRate(): Promise<void> {
    await this.tuneRate();
  }

  // --- touch -----------------------------------------------------------------
  //
  // Two thin forwards to the bar, which owns both the state and the meaning.
  // They exist because `main.ts` holds the touch binding and the panel, but not
  // the overlay -- that is deliberately private here (see `overlay`), and
  // exposing it wholesale to reach two methods would be a much wider opening
  // than either needs.

  /**
   * Which mouse button a one-finger drag should imitate, for `touchBinding`.
   *
   * LEFT unless the context latch has been flipped in Shove or Draw, which is
   * also what it always reports on the desktop -- nothing there ever flips it.
   */
  touchDragButton(): typeof LEFT_BUTTON | typeof RIGHT_BUTTON {
    return this.overlay.touchDragIsRight ? RIGHT_BUTTON : LEFT_BUTTON;
  }

  /**
   * Cancel the current cohort selection. What a canvas long press asks for.
   *
   * **DELIBERATELY NARROWER THAN THE CONTEXT BUTTON**, which it used to mirror
   * exactly. The button is context-dependent -- Cancel, Undo, or the draw latch
   * -- and routing a long press to it meant the gesture undid whenever nothing
   * was lit. A long press is easy to produce by accident, and an accidental undo
   * discards real work with no visible cause; an accidental cancel costs a
   * re-tap. See `TouchBindingOptions.onLongPress`.
   *
   * A no-op when nothing is lit: `cancelSelection` refuses in that state
   * (`orchestrator.ts`), so the gesture is simply inert rather than doing
   * something else.
   */
  cancelSelection(): void {
    this.overlay.cancelSelection();
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
   *
   * ## THE RESET, AND WHY IT IS HERE RATHER THAN INSIDE CALIBRATION
   *
   * Calibration advances the simulation -- a lot. The ladder probes five frames
   * per rung at up to 20 sub-steps each, and the rate tuning that follows drives
   * ~20 REAL frames per probe. Without a reset the first thing someone sees on
   * dismissing the splash is several hundred sub-steps of evolution that
   * happened while they were reading it.
   *
   * `commitCalibration` already resets, and that is not enough: it is the
   * LADDER's commit, and `tuneRate` runs afterwards (`main.ts`, the final step
   * of `runCalibration`) driving live frames with nothing reset after them. So
   * the ladder's reset is immediately undone by the phase that follows it. This
   * is the last point where the whole run is known to be over.
   *
   * **NOT IN `tuneRate` OR `finishRateCalibration`**, deliberately: those are
   * shared with the Auto-calibrate Physics Rate button, which measures the piece
   * the user is looking at and must leave it running. Resetting there would wipe
   * live work to measure it. This method is only ever reached with the splash
   * up -- first run, and Reset Editor Preferences -- where there is nothing on
   * screen worth preserving because the user has not seen it yet.
   *
   * IN `finally`, so a calibration that threw or was cut short still hands over
   * a fresh simulation rather than a half-probed one.
   */
  async calibrate(): Promise<void> {
    if (this.runCalibration === null || this.calibrating) return;
    this.calibrating = true;
    this.splash.show(); // No-op when it is already up, as at startup.
    this.splash.setLocked(true);
    try {
      await this.runCalibration();
    } finally {
      // BEFORE the unlock, so the reset has landed by the time the splash can
      // be dismissed -- the user must never catch the tail of the probe run.
      this.bus.dispatch({ kind: 'reset' });
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
    // Stored on the toggle rather than at teardown: there is no reliable
    // "session ended" moment in a browser tab -- `unload` is not guaranteed to
    // run -- and this is the only place the flag changes.
    saveExportVideoShown(shown);

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
   * Write every user save into a folder, as the v8 files they already are.
   *
   * ## THE PICKER GOES FIRST, BEFORE ANY AWAIT
   *
   * This is why the method is `void`-returning and starts a promise rather than
   * being `async` itself: `chooseExportFolder` needs the click's transient user
   * activation, and the first `await` in this handler spends it. Reading the
   * saves first -- an IndexedDB round trip -- would leave the picker to be
   * called with a dead gesture, which browsers answer with a `SecurityError`.
   * That surfaces as `unavailable`, so the app would silently download a ZIP
   * instead of writing the folder the user asked for, EVERY TIME. See
   * `saveFolder.ts` and `recorder/saveFile.ts`, which carry the same rule.
   *
   * The cost is asking for a folder before knowing whether there is anything to
   * put in it, so an empty library means a picker that is dismissed with
   * "nothing to export". That is the lesser of the two: the alternative is a
   * feature that never once does what it says.
   */
  private exportSaves(): void {
    // FIRST. Nothing may be awaited above this line.
    const choice = chooseExportFolder();

    void (async () => {
      const saves = await this.bus.savedDocuments();
      const files = exportFiles(saves);
      if (files.length === 0) {
        this.toast.show('No saved configs to export.', 'error');
        return;
      }

      const folder = await choice;
      // Cancel means cancel -- it must NOT fall through to the ZIP. See
      // `FolderChoice`, which separates these two outcomes for this reason.
      if (folder.kind === 'cancelled') return;

      if (folder.kind === 'folder') {
        try {
          const written = await writeFolder(folder.handle, files);
          this.toast.show(
            `Exported ${String(written)} ${written === 1 ? 'save' : 'saves'} to the folder you chose.`,
          );
        } catch (err: unknown) {
          this.toast.show(`Could not write the folder: ${String(err)}`, 'error');
          console.warn('Save export failed:', err);
        }
        return;
      }

      // No directory picker here (Firefox, Safari, any non-secure context). One
      // archive rather than N downloads: a browser that would not let the user
      // choose a folder also should not drop thirty files into Downloads.
      // `zip.ts` is lazy -- it is dead weight on the path that has a picker,
      // which is every browser this app is developed on. `downloadRecording` is
      // NOT: `main.ts` already imports it statically, so asking for it here
      // dynamically would split nothing and only add an await.
      const { buildZip } = await import('./zip.ts');
      downloadRecording(buildZip(files), 'fluoddity-saves.zip');
      this.toast.show(
        `Exported ${String(files.length)} saves as fluoddity-saves.zip.`,
      );
    })();
  }

  /**
   * Read a folder of v8 files into the save list.
   *
   * NO GESTURE PROBLEM HERE, unlike `exportSaves`: this opens an
   * `<input type="file">`, which needs no activation and no permission. So the
   * ordering constraint that shapes the export path does not apply, and this can
   * be a plain async method.
   *
   * COLLISIONS AND BAD FILES ARE DECIDED BY `planImport`, not here -- this is
   * the DOM edge, and the rules are pure. What the toast reports is that plan.
   */
  private importSaves(): void {
    void (async () => {
      const files = await readImportFolder();
      if (files.length === 0) return;

      const existing = await this.bus.savedNames();
      const plan = planImport(files, existing);

      // Every file bounced. Reported as an error tone because the user picked a
      // folder expecting something to happen, and nothing did -- the counts in
      // the message are what say why.
      if (plan.accepted.length === 0) {
        this.toast.show(describeImport(plan), 'error');
        return;
      }

      try {
        await this.bus.importSaves(plan.accepted);
        this.toast.show(describeImport(plan));
      } catch (err: unknown) {
        this.toast.show(`Could not import: ${String(err)}`, 'error');
        console.warn('Save import failed:', err);
      }
    })();
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
    // BEFORE the rest: a run in flight has moved the physics rate away from
    // where the user left it, and cancelling is what puts it back. Disposing the
    // panel around it would strand them at whatever the last probe happened to
    // set.
    this.cancelRateCalibration();
    for (const release of this.focusReleasers) release();
    this.perfDragRelease();
    // Sections first, for the reason `buildPane` gives: what they hold outside
    // their own folder is not the pane's to reclaim.
    for (const handle of this.left.sections) handle.dispose?.();
    for (const handle of this.right.sections) handle.dispose?.();
    this.left.pane.dispose();
    this.right.pane.dispose();
    this.tooltip.dispose();
    this.toast.dispose();
    this.menuBar.dispose();
    this.dialogs.dispose();
    this.overlay.dispose();
    this.recordingBar.dispose();
    this.fpsCounter.dispose();
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
function sideContainer(which: Side, mobile = false): HTMLElement {
  const el = document.createElement('div');
  const left = which === LEFT;
  el.id = left ? 'fluoddity-panel-left' : 'fluoddity-panel-right';

  // =====================================================================
  // TOUCH: one full-width sheet, stopping above the control bar
  // =====================================================================
  //
  // The desktop geometry -- two 320px columns pinned to the left and right
  // edges -- has nothing to give on a 390px screen: the columns would overlap
  // almost completely, which is exactly the "project panel badly overlaps the
  // preferences panel" this work started from.
  //
  // So on touch there is ONE panel and it spans the viewport. The LEFT
  // container is still created and still positioned; it is simply built with no
  // sections (`panelModel.leftSections`), so it measures zero and shows
  // nothing. Creating it anyway is what lets `setHidden`, `dispose` and the
  // build loop stay uniform across both layouts.
  //
  // **IT STOPS ABOVE THE CONTROL BAR RATHER THAN FILLING THE SCREEN.** The bar
  // is bottom-anchored and always visible, so a sheet running to `bottom:0`
  // would put its last rows underneath the controls -- unreachable, and looking
  // like the list had been cut off. `bottom` is set from a CSS variable the
  // overlay measures itself into (`--fluoddity-bar-height`), with a fallback
  // that is generous rather than tight: too much clearance costs a little
  // scrolling, too little hides controls.
  if (mobile) {
    el.style.cssText =
      'position:fixed;left:0;right:0;' +
      `top:${PANEL_TOP_PX}px;` +
      'bottom:calc(var(--fluoddity-bar-height, 190px) + 8px);' +
      'overflow-y:auto;-webkit-overflow-scrolling:touch;' +
      // CONTAINS ITS OWN SCROLL. Without this, flicking past the end of a long
      // settings list continues into the page behind it -- and the page is the
      // canvas, which has `touch-action:none` and would simply eat the rest of
      // the gesture. The list would feel like it had stuck.
      'overscroll-behavior:contain;z-index:20;padding:0 6px;box-sizing:border-box;';
    document.body.append(el);
    return el;
  }

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
