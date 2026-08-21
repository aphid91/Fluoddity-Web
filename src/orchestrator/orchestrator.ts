/**
 * Orchestrator: the sole broker of commands and data between modules.
 * The port of `orchestrator/orchestrator.py` and its six command mixins.
 *
 * Owns one instance each of Surface, Camera, Assembler and ParticleSystem, plus
 * the project, history and preferences. Modules hold no references to one
 * another; all inter-module communication flows through here. Two examples of
 * the pattern, both preserved verbatim from the desktop:
 *
 *   - Data: each frame the Orchestrator pulls the current canvas texture from
 *     ParticleSystem (via a narrow accessor) and hands it to Camera. Camera
 *     never holds a persistent reference to it.
 *   - Commands: the UI reports named intents which the Orchestrator translates
 *     into method calls on the right module.
 *
 * **THIS FILE HOLDS THE LOOP, THE WIRING AND THE STATE -- NOT THE HANDLERS.**
 * "Sole broker" means it routes, not that it implements.
 *
 * ## The mixins become composition, and what that changed
 *
 * The desktop has six command mixins (`ProjectCommands`, `ClipboardCommands`,
 * `SettingsCommands`, `SelectionCommands`, `DrawingCommands`, `ShoveCommands`)
 * flattened into one class by Python's MRO, and **the MRO is load-bearing**
 * (`orchestrator.py:106-107`): the mixins own no state, they read and replace
 * attributes defined on the Orchestrator, and they call each other's methods
 * freely. TypeScript has no multiple inheritance, and the plan asks for the
 * cross-calls to become explicit dependencies.
 *
 * So each group is now a MODULE OF FUNCTIONS taking the collaborators it needs
 * (`projectCommands.ts`, `clipboardCommands.ts`, `settingsCommands.ts`), and
 * this class is what holds the state they read and replace. The seams the
 * desktop's section comments marked are the same seams; only the mechanism
 * differs.
 *
 * **What that mechanically prevents:** on the desktop, `ShoveCommands` reaching
 * `self.prefs` is invisible in its signature, so nothing stops a mixin growing
 * a dependency on state it has no business seeing. Here every dependency is an
 * argument, and adding one is visible in the diff.
 *
 * ## Frame order
 *
 * Input is polled at the TOP of the frame, so the physics and rendering that
 * follow act on this frame's input rather than the previous frame's. See
 * `frame()`, which states the two ordering constraints Step 6 established and
 * this step must not break.
 */

import type { Surface } from '../app/surface.ts';
import { RenderTargets } from '../app/renderTargets.ts';
import { Assembler } from '../assembler/assembler.ts';
import {
  NO_OVERLAYS,
  type CropOverlay,
  type OverlayState,
} from '../assembler/assemblerUniforms.ts';
import { Camera } from '../camera/camera.ts';
import {
  CameraState,
  PAN_PER_SECOND,
  ZOOM_PER_SECOND,
} from '../camera/cameraState.ts';
import { blurSchedule, sampleAt } from '../camera/blurSchedule.ts';
import {
  type BehaviorEvent,
  describeCheckpointSet,
  describeEvent,
  describeHistoryStep,
  historyLabelFor,
} from './notices.ts';
import { ParticleSystem } from '../particleSystem/particleSystem.ts';
// TYPE-ONLY. `recorder.ts` reaches mediabunny through a dynamic `import()`, and
// a value import here would pull the whole encoder into the main bundle for
// every user -- including the majority who never record. See its file header.
import type { VideoRecorder } from '../recorder/recorder.ts';
// Value imports, and safe ones: `recordingSettings.ts` is a pure leaf holding
// arithmetic and constants, with no mediabunny and no GPU behind it. The lazy
// loading protects the ENCODER, not the geometry.
import {
  type Resolution,
  clampResolution,
  isFullFrame,
} from '../recorder/recordingSettings.ts';
import { StrafeField } from '../strafeField/strafeField.ts';
import { screenToWorld, worldToUv } from '../particleSystem/coords.ts';
import {
  type PickResult,
  DEFAULT_PICK_RADIUS_PX,
  isHit,
  radiusPxToWorld,
} from '../particleSystem/pick.ts';
import { BC } from '../particleSystem/config.ts';
import { canvasDimensions, sizingFor } from '../particleSystem/sizing.ts';
import {
  type ConfigEntry,
  ConfigStore,
  CUSTOM_CATEGORY,
  DEFAULT_PRESET_NAME,
} from '../config/configStore.ts';
import { type SavedConfig, sanitizeName, toDocument } from '../config/persistence.ts';
import {
  type Preferences,
  DEFAULT_PREFERENCES,
  loadPreferences,
  requiresRestart,
  savePreferences,
  withValue,
} from '../prefs/preferences.ts';
import {
  type Project,
  adoptRule,
  configCount,
  makeProject,
  renamed,
  ruleChanged,
  selectedConfig,
} from '../project/project.ts';
import { History } from '../project/history.ts';
import { SelectionController, type SelectionHost } from '../selection/selection.ts';
import { CohortHighlight, NO_COHORT, wrapCohort } from '../selection/cohortHighlight.ts';
import { type InputState, EMPTY_INPUT } from '../ui/inputState.ts';
import {
  type Command,
  type CommandBus,
  type MouseMode,
  type PreviewSurface,
  type Status,
} from './commands.ts';
import { type Checkpoint, CheckpointStore } from './clipboardCommands.ts';
import { RESET_ON_CONFIG_LOAD, RESET_ON_CONFIG_UNDO_REDO } from './featureFlags.ts';
import { type PendingStroke, strokeFor } from './drawingCommands.ts';
import { shoveState } from './shoveCommands.ts';
import {
  applySettingEdit,
  randomizeBehavior,
  randomizeSeed,
  rerollIsNoOp,
  ruleIsGeneratedOnGpu,
  ruleIsSentinel,
  selectionIsNoOp,
  setPopulationLayout,
} from './settingsCommands.ts';
import { type PresetCatalog, loadSavedInto, switchPreset } from './projectCommands.ts';

/** Everything `Orchestrator.create` needs. All GPU-adjacent, all injected. */
export interface OrchestratorOptions {
  readonly device: GPUDevice;
  readonly surface: Surface;
  /** Preset to open with. Defaults to the desktop's own default. */
  readonly presetName?: string;
  /** Overridden by tests and by `?prefs=default`; normally `localStorage`. */
  readonly preferences?: Preferences;
  /**
   * Open with this project instead of one from the catalog. For the share link.
   *
   * INJECTED HERE RATHER THAN LOADED AFTERWARDS, and the alternative is worse in
   * three ways that a user would actually notice. Loading a shared project after
   * `create` would have to go through `adoptSaved`, which:
   *
   *   1. RECORDS AN UNDO ENTRY the user never performed. Someone opening a link
   *      would arrive with a populated history, and one press of `Z` would drop
   *      them into a default preset they have never seen.
   *   2. SETS `configOrigin`, lighting up "Revert to preset: X" in the History
   *      menu, pointing at a catalog entry that has nothing to do with the link.
   *   3. Builds and uploads the default project first, only to discard it.
   *
   * The catalog is still opened and `presetIndex` still resolved, because the
   * LEFT/RIGHT cycle needs somewhere to start from.
   */
  readonly openWith?: {
    readonly saved: SavedConfig;
    /** The project's name. A link has no catalog identity; see `create`. */
    readonly name: string;
  };
}

export class Orchestrator implements CommandBus {
  private readonly device: GPUDevice;
  private readonly surface: Surface;
  private readonly targets: RenderTargets;
  private readonly camera: Camera;
  private readonly assembler: Assembler;
  private system: ParticleSystem;
  /**
   * The painted field. Paired with `system`: both are sized from the canvas, so
   * `rebuildSystem` replaces the two together and destroys the two together.
   */
  private strafeField: StrafeField;

  /**
   * Where the cursor was on the previous frame of the stroke in progress, in
   * FIELD uv. `null` between strokes -- see `drawingCommands.ts`.
   */
  private strokePrevUv: readonly [number, number] | null = null;

  /**
   * This frame's stroke, recorded by `applyCanvasInput` and consumed by
   * `frame()`.
   *
   * The indirection exists because painting needs a command ENCODER and
   * `applyCanvasInput` has none -- it runs above the encoder deliberately, so
   * that a stroke lands once per rendered frame rather than once per physics
   * sub-step. Recording intent here is what lets both facts hold at once.
   */
  private pendingStroke: PendingStroke | null = null;

  /**
   * Set by `clearStrafeField`, consumed by the frame loop.
   *
   * Same shape and same reason as the accumulator's clear: zeroing a texture is
   * a render pass, a render pass needs an encoder, and a command handler runs
   * outside one.
   */
  private clearFieldPending = false;

  /** Editor state, distinct from anything saved with a project. */
  private prefs: Preferences;

  /**
   * The current project: configs + world + name + selection, as one immutable
   * value. Replaced wholesale rather than mutated, so its invariants hold by
   * construction -- see `project/project.ts`.
   */
  private project: Project;

  /** Undo/redo timeline, seeded with the startup state. */
  private readonly history = new History();

  /** In-session checkpoints. Not persisted: saving is the route for keeping. */
  private readonly checkpoints = new CheckpointStore();

  /**
   * Project state from before a hover-preview began, so a committed load
   * records against it rather than against the preview showing at click time.
   * Absent for a surface with no browse session open.
   *
   * **KEYED BY SURFACE, unlike the desktop's single `_preview_origin`**
   * (`orchestrator.py:198-201`). Two surfaces browse by hovering -- the Load
   * menu and the checkpoint menu -- and the desktop's one slot is safe "only
   * because both are submenus of the same menu bar", so at most one can be open.
   * The web's are independent DOM, so both can be open at once, and a shared
   * slot would let one browser's unhover restore the other's snapshot.
   * `ui/hover_preview.py:13-19` records that exact bug from when the sessions
   * themselves shared a slot.
   */
  private readonly previewOrigins = new Map<PreviewSurface, Project>();

  /** The last clicked entity. `null` until the user selects something. */
  private selected: PickResult | null = null;

  /**
   * The active tool. SELECT by default -- it is the only tool whose effect is a
   * single undoable step, so a stray click on startup cannot smear the
   * simulation.
   */
  private mouseMode: MouseMode = 'select';

  /**
   * Whether the simulation is frozen. Pausing stops the physics AND the Shove
   * tool, so a paused frame is genuinely untouchable; the camera, the overlays
   * and the whole UI stay live, so a frozen state can still be navigated and
   * inspected.
   *
   * PAINTING IS NOT STOPPED, and the asymmetry with Shove is deliberate: the
   * field is not simulation state, so a frozen simulation is no reason to stop
   * being able to paint into it -- or to clear it.
   */
  private paused = false;

  /** Transient UI message, surfaced through `status().saveError`. */
  private saveError = '';
  /** In-flight storage work, surfaced through `status().configBusy`. */
  private configBusy = '';

  /** Shipped presets plus the user's saves. See `config/configStore.ts`. */
  private readonly store: ConfigStore;
  /** Rebuilt after every write or delete; `store.catalog()` is the source. */
  private catalog: PresetCatalog;
  private presetIndex = 0;
  private presetName: string;

  /**
   * Where the current project came from, for `revertConfig`.
   *
   * Set by a committed load or a successful save; `null` when the project has no
   * storage origin, which is what `canRevert` reports. Cleared by nothing except
   * a `reset` -- notably NOT by preset cycling, because after Step 9 a preset IS
   * a config entry and cycling to one IS loading it. Mirrors the desktop's
   * `set_config_path` (`project_commands.py:129`).
   */
  private configOrigin: { readonly category: string; readonly name: string } | null = null;

  /**
   * Bumped on every storage request. A continuation whose generation no longer
   * matches was superseded and must not publish its result.
   *
   * THE SAME LAST-REQUEST-WINS PROBLEM `SelectionController` SOLVES, and
   * deliberately the same idiom: storage is async, so a load that resolves after
   * the user has already loaded something else would clobber the newer project
   * with the older one. One pattern for this in the codebase, not two.
   */
  private configGeneration = 0;

  private readonly selection: SelectionController<Project, PickResult>;

  // --- the cohort highlight -------------------------------------------------
  //
  // TWO-STAGE SELECTION. A Select-tool click picks as it always did, but what
  // the result MEANS now depends on what is highlighted: a hit on a new cohort
  // lights it up, a hit inside the lit cohort adopts its rule, a miss puts it
  // out. See `selection/cohortHighlight.ts` for the three outcomes, and
  // `frame()` for where the transition is applied.

  /** Which cohort is lit, and what each landed pick does to it. */
  private readonly highlight = new CohortHighlight();

  /**
   * Whether the pick being resolved RIGHT NOW is a commit.
   *
   * Set by `frame()` from `applyPickToHighlight` immediately before
   * `selection.resolve()` reads it back through the host's `adoptRule`, and
   * false at every other moment. It exists because `SelectionHost` is a
   * value-in, value-out seam -- `adoptRule` receives the pick result but not the
   * verdict about it, and widening that interface would push the two-stage rule
   * into `selection.ts`, which is deliberately generic over both the project and
   * the result types and has no business knowing what a cohort is.
   */
  private pickCommits = false;

  /**
   * This frame's landed pick, held between the classify and the resolve.
   *
   * `ParticleSystem.retrievePick` is DESTRUCTIVE -- it unmaps the staging buffer
   * and returns the phase machine to `idle`, so the second caller in a frame
   * gets `null`. The highlight has to see the result before `resolve()` decides
   * what to do with it, so `frame()` reads it once into here and the host's
   * `retrievePick` replays it. Null at every other moment, which is what makes
   * "still in flight" and "already consumed this frame" stay distinguishable.
   */
  private landedPick: PickResult | null = null;

  /** This frame's input. Replaced once per frame by `frame()`. */
  private input: InputState = EMPTY_INPUT;

  /**
   * A message waiting to be shown, or empty. Drained by `status()`.
   *
   * See `Status.notice` for why this crosses the boundary as data and why the
   * read is destructive. Set through `notify()`, never assigned directly, so
   * there is one place to look when asking what can raise a toast.
   */
  private pendingNotice = '';

  /**
   * The in-flight video recorder, or null -- which is the overwhelmingly common
   * case and is why this is nullable rather than always-present.
   *
   * NOTHING about recording is allocated until someone asks for it: no capture
   * canvas, no encoder, and not even mediabunny's code, which `recorder.ts`
   * fetches as a separate chunk on first use. An idle session pays nothing.
   *
   * Assigned from OUTSIDE this class (`main.ts` builds the recorder and hands it
   * over), which is the one deviation from invariant 2's "writes are the
   * asymmetry" worth naming: constructing it requires an `await` for the dynamic
   * import, and `frame()` is synchronous. Making the Orchestrator own the
   * construction would mean either an async frame path or a promise field that
   * `frame()` has to poll -- both worse than a setter that takes an
   * already-built object. `setRecorder` is that setter.
   */
  private recorder: VideoRecorder | null = null;

  /**
   * Whether a settings panel is open, so `settingsSources()` can skip building
   * the three payloads when nothing reads them.
   *
   * The desktop reads `ui.show_settings || ui.show_preferences ||
   * ui.show_drawing` (`orchestrator.py:597`); the port has one panel, so this
   * is one flag. It matters for the same reason it matters there: building
   * `editConfig` copies the 80-float rule EVERY FRAME, and doing that for a
   * closed panel is pure garbage.
   */
  panelOpen = true;

  private constructor(opts: {
    device: GPUDevice;
    surface: Surface;
    targets: RenderTargets;
    camera: Camera;
    assembler: Assembler;
    system: ParticleSystem;
    strafeField: StrafeField;
    prefs: Preferences;
    project: Project;
    store: ConfigStore;
    catalog: PresetCatalog;
    presetName: string;
    configOrigin: { readonly category: string; readonly name: string } | null;
  }) {
    this.device = opts.device;
    this.surface = opts.surface;
    this.targets = opts.targets;
    this.camera = opts.camera;
    this.assembler = opts.assembler;
    this.system = opts.system;
    this.strafeField = opts.strafeField;
    this.prefs = opts.prefs;
    this.project = opts.project;
    this.store = opts.store;
    this.catalog = opts.catalog;
    this.presetName = opts.presetName;
    this.configOrigin = opts.configOrigin;
    this.presetIndex = Math.max(0, this.catalog.order.indexOf(opts.presetName));

    this.history.seed(this.project);
    this.selection = new SelectionController(this.selectionHost());
  }

  /**
   * Build the whole app. Async because every pipeline compile is.
   *
   * The desktop's `__init__` is synchronous and does this same wiring; the only
   * structural differences are that WGSL compilation returns promises and that
   * the config catalog is FETCHED rather than globbed -- which is why the store
   * is opened here rather than in `main.ts`. Keeping it inside means `main.ts`
   * never learns about storage and `?preset=` resolution stays where it is.
   *
   * The extra awaits cost nothing user-visible: device acquisition and pipeline
   * compilation already dominate startup, which is why the first frame's `dt` is
   * already forced to zero.
   */
  static async create(opts: OrchestratorOptions): Promise<Orchestrator> {
    const prefs = opts.preferences ?? loadPreferences();

    // THROWS IF THE MANIFEST IS MISSING, deliberately -- `main.ts` renders it
    // through the same banner a missing GPU adapter uses. An app with no presets
    // is not usable, and the likeliest cause is a build that did not copy
    // `public/`, which would otherwise present as a mysteriously empty menu.
    const store = await ConfigStore.open();
    const catalog = store.catalog();

    // ASKING FOR A PRESET BY NAME AND NOT ASKING ARE DIFFERENT SITUATIONS, and
    // only the first can be disappointed. `?preset=Nope` is a request that
    // failed and deserves to say so; opening with no preference at all is the
    // ordinary case, and warning about it on every boot -- which naming a
    // now-deleted file in `DEFAULT_PRESET_NAME` used to do -- trains everyone to
    // ignore the console.
    let presetName = opts.presetName ?? DEFAULT_PRESET_NAME;
    let entry = presetName === '' ? null : store.entryByName(presetName);
    if (entry === null && presetName !== '') {
      console.warn(
        `No preset "${presetName}". Available: ${catalog.order.join(', ')}. ` +
          `Opening the first one instead.`,
      );
    }
    // Whatever sorts first, which is what an unset default means. `sync:configs`
    // builds the catalog order, so this follows the shipped library rather than
    // a constant that has to be maintained alongside it.
    if (entry === null && catalog.order.length > 0) {
      presetName = catalog.order[0]!;
      entry = store.entryByName(presetName);
    }
    if (entry === null) {
      throw new Error('The config manifest contains no presets.');
    }
    // A share link supersedes the preset, but only AFTER the catalog has been
    // resolved above: `presetIndex` seeds the LEFT/RIGHT cycle, and a link is
    // not in the catalog, so the cycle starts from wherever the default sits.
    //
    // The preset read is SKIPPED entirely when a link supplies the project --
    // there is no point fetching a JSON file to throw it away.
    const loaded = opts.openWith?.saved ?? (await store.read(entry));
    // NO ORIGIN FOR A LINK. `configOrigin` is what "Revert to Saved" reverts
    // TO, and a shared project has no file behind it -- `canRevert` reads this,
    // so leaving it null is what correctly greys that row out rather than
    // offering to revert to a preset the user never opened.
    const configOrigin =
      opts.openWith === undefined ? { category: entry.category, name: entry.name } : null;

    const [entityCount, dim] = sizingFor(prefs.worldSize);
    const system = await ParticleSystem.create({
      device: opts.device,
      config: loaded.configs[0]!,
      world: loaded.world,
      canvasSize: canvasDimensions(prefs.canvasAspect, dim),
      entityCount,
      physicsSteps: prefs.physicsSteps,
    });

    // The field is sized from the canvas, and bound into the system BEFORE it
    // goes live -- `setStrafeField` rebuilds the compute texture groups, which
    // is only safe while nothing has been recorded against them.
    const strafeField = await StrafeField.create(opts.device, system.canvasSize);
    strafeField.setWrap(loaded.world.boundaryConditions === BC.WRAP);
    system.setStrafeField(strafeField.view(), strafeField.size);

    const targets = new RenderTargets(opts.device);
    const camera = await Camera.create(opts.device, new CameraState(), targets);
    const assembler = await Assembler.create(opts.device, targets, opts.surface.format);
    assembler.setStrafeField(strafeField.view());

    const project = makeProject({
      // Every config in the file, not just slot 0: a save can hold several.
      configs: loaded.configs,
      world: loaded.world,
      name: opts.openWith?.name ?? presetName,
    });

    const orchestrator = new Orchestrator({
      device: opts.device,
      surface: opts.surface,
      targets,
      camera,
      assembler,
      system,
      strafeField,
      prefs,
      project,
      store,
      catalog,
      presetName,
      configOrigin,
    });
    // No camera is applied from the startup preset -- the view starts where the
    // camera's own defaults put it. See the note above `adoptPreset`.
    return orchestrator;
  }

  // =========================================================================
  // The frame loop
  // =========================================================================

  /**
   * One frame. The port of `orchestrator.py:256-365`.
   *
   * THE ORDER IS THE CONTRACT. Five things about it are load-bearing and every
   * one of them has a comment at its site rather than only here:
   *
   *  1. The pending selection resolves FIRST, before input can dispatch a new
   *     pick -- there is one result slot, so a new dispatch clobbers the answer
   *     being read.
   *  2. BOTH HALVES OF PICKING SIT OUTSIDE THE PAUSED BRANCH: the resolve at the
   *     top, and `recordPick` below it. `runFrame` is what a paused frame skips,
   *     and clicking to select must keep working when it is. Only the resolve
   *     was hoisted originally, which left paused picking recording nothing and
   *     reading stale bytes -- the two have to move together.
   *  3. Input is applied ABOVE the render, because painting (Step 9) binds its
   *     own target and would otherwise paint over the screen.
   *  4. `recordPick` runs AFTER the branch, so the pick sees the positions the
   *     frame ended on rather than the ones it started from.
   *  5. The assembler presents AFTER the sub-step loop, because the camera
   *     binds its own targets for every sample inside it.
   */
  frame(input: InputState): void {
    this.input = input;

    // 1. FINISH LAST FRAME'S SELECTION FIRST. Read before write.
    //
    // Here rather than inside the paused branch below: `runFrame` is skipped
    // while paused, and clicking to select must keep working when it is --
    // which is precisely when a user wants to inspect a particle
    // (`orchestrator.py:262-270`).
    //
    // THE TWO-STAGE GATE, resolved BEFORE `resolve()` runs: that call adopts the
    // rule through the host's `adoptRule`, which asks `pickCommits` whether this
    // pick is the confirming one.
    //
    // THE RESULT IS RETRIEVED HERE, ONCE, AND REPLAYED. `retrievePick` is
    // destructive -- it unmaps the staging buffer and drops the phase machine
    // back to `idle`, so calling it twice returns `null` the second time and the
    // selection would be silently lost. So this consumes it, classifies it, and
    // parks it in `landedPick` for the host's `retrievePick` to hand straight to
    // `resolve()`. One GPU read, two readers.
    //
    // GUARDED ON `isPending`, WHICH IS `resolve()`'S OWN FIRST CHECK, and it has
    // to be: this read happens ABOVE that check, so without the same guard it
    // would consume -- and CLASSIFY -- results belonging to no pending click at
    // all. Those exist: `requestPick` abandons an older dispatch when a second
    // click lands inside its readback window, and the mapAsync continuation for
    // the abandoned one still settles. Classifying it would move the highlight
    // for a click the user has already superseded, so a stale pick could aim,
    // or commit, on its own.
    if (this.selection.isPending) {
      const landed = this.system.retrievePick();
      if (landed !== null) {
        this.landedPick = landed;
        this.pickCommits = this.applyPickToHighlight(landed);
      }
    }

    const selected = this.selection.resolve();
    this.landedPick = null;
    // ONLY A COMMIT RESETS. `isHit` is not enough any more -- an aiming click is
    // a hit too, and it changed no rule, so restarting the simulation for it
    // would throw away the state the user is still deciding about.
    if (selected !== null && isHit(selected) && this.pickCommits) {
      this.resetForBehavior();
      // ANNOUNCED HERE rather than from `describe`, because this is the branch
      // that knows the click COMMITTED. `describe` runs for the label whenever
      // `resolve()` records an entry, and an aiming click -- the first of the
      // two-stage selection -- must not claim to have adopted anything.
      this.notify(describeEvent({ kind: 'commitSelection', cohort: selected.cohort }));
    }
    // One pick, one verdict. Left true, the NEXT pick to land would be adopted
    // without ever being classified.
    this.pickCommits = false;

    // 2. Translate this frame's input into whatever the ACTIVE TOOL means.
    this.applyCanvasInput(input);

    // PICKING IS DELIBERATELY NOT RUN PER FRAME. A pick dispatches over every
    // entity, which measured in the tens of milliseconds per frame at large
    // world sizes -- far too much for something whose answer is only wanted
    // when the user acts. It is on-demand: a SELECT-mode click requests one
    // above, `recordPick` below puts its passes on this frame's encoder, and the
    // resolve at the top of the next frame reads the result back.

    const windowSize = this.surface.size();

    // BEFORE the encoder opens. A ResizeObserver callback firing between
    // `createCommandEncoder` and `submit` would otherwise destroy a texture
    // whose view is already recorded -- see `renderTargets.ts`.
    if (this.targets.ensure(windowSize)) {
      this.camera.invalidateTargets();
      this.assembler.invalidateTargets();
    }

    // Physics rate is a live preference, read each frame -- unless a recording
    // is running, which supplies its own. See `frameSchedule`.
    //
    // MOTION BLUR PUTS THE RENDER INSIDE THE PHYSICS LOOP. A displayed frame is
    // the average of `samples` renders taken `stride` sub-steps apart, so the
    // camera must see the simulation mid-advance rather than only at the end.
    const { steps, schedule } = this.frameSchedule();
    this.system.physicsSteps = steps;
    const at = sampleAt(schedule);

    const config = selectedConfig(this.project);
    const frameState = {
      canvas: this.system.currentCanvasTexture(),
      canvasSize: this.system.canvasSize,
      windowSize,
      entities: this.system.entityBufferForRendering(),
      entityCount: this.system.entityCount,
      // From the SELECTED config. Per-particle in the shader would mean handing
      // Camera the config buffer, which belongs to ParticleSystem -- so with
      // several configs loaded, the selected one sets the palette for all
      // (`orchestrator.py:334-339`).
      colorSensitivity: config.colorSensitivity,
      colorByCohort: config.colorByCohort,
      // PARTICLES mode only -- TRAIL renders the canvas texture, which holds
      // velocity rather than cohort and cannot express a per-cohort dim at all.
      // See `CameraFrame.highlightedCohort`.
      //
      // GATED ON THE SAME PREDICATE THE CLICKS ARE, so the picture can never
      // show a highlight the clicks would not honour. Both exemptions can turn
      // on while a cohort is lit -- ticking `oneClickSelection`, or loading a
      // config with one cohort -- and reading the lit value regardless would
      // leave most of the screen dimmed for a stage that no longer exists.
      highlightedCohort: this.highlightEnabled ? this.highlight.cohort : NO_COHORT,
    };

    // Uniforms are written BEFORE the encoder opens -- `queue.writeBuffer`
    // cannot interleave with an open encoder's passes.
    this.camera.beginFrame(frameState, schedule.samples);

    const encoder = this.device.createCommandEncoder({ label: 'frame' });
    this.camera.clearAccumulator(encoder);

    // 3. THE FIELD, ONCE PER RENDERED FRAME, ABOVE THE PHYSICS LOOP.
    //
    // Both of these sit above the paused branch on purpose. Clearing must work
    // while paused -- it is the only reset the field has, and a user who paused
    // to look at a mess should be able to remove it. And painting must too: the
    // field is not simulation state, so freezing the simulation is not a reason
    // to stop being able to paint into it.
    //
    // Painting HERE rather than inside `runFrame` is the whole cadence argument:
    // one stroke segment per rendered frame, so brush weight never tracks the
    // physics rate (`drawing_commands.py:14-19`).
    if (this.clearFieldPending) {
      this.strafeField.clear(encoder);
      this.clearFieldPending = false;
      // A cleared field ends the stroke in progress: the next press should start
      // fresh rather than draw a segment from wherever the cursor was.
      this.strokePrevUv = null;
    }
    if (this.pendingStroke !== null) {
      const { uv, prevUv, erasing } = this.pendingStroke;
      if (erasing) {
        this.strafeField.erase(encoder, uv, prevUv, this.prefs.drawSize);
      } else {
        this.strafeField.draw(encoder, uv, prevUv, this.prefs.drawSize, this.prefs.drawPower);
      }
      this.pendingStroke = null;
    }

    // Hoisted out of the sub-step loop: a shove is fixed for the whole frame,
    // and `shoveState` is the one place that decides whether there is one
    // (`orchestrator.py:294`).
    const shove = shoveState(input, {
      mouseMode: this.mouseMode,
      paused: this.paused,
      windowSize,
      canvasSize: this.system.canvasSize,
      pan: this.camera.state.pan,
      zoom: this.camera.state.zoom,
      physicsSteps: this.system.physicsSteps,
      drawPower: this.prefs.drawPower,
      drawSize: this.prefs.drawSize,
    });

    if (this.paused) {
      // STILL ONE RENDER when paused: the camera has to draw the frozen state,
      // or the screen would go black. `runFrame` is what is skipped, not the
      // render (`orchestrator.py:318-322`).
      this.camera.render(encoder, frameState);
    } else {
      this.system.runFrame(encoder, shove, (enc, step) => {
        if (step % schedule.stride !== at) return;
        this.camera.render(enc, {
          ...frameState,
          // Re-pulled PER SAMPLE, not hoisted: the canvas double-buffer swaps
          // inside advance(), so a view captured before the loop is stale after
          // the first sub-step (`orchestrator.py:325-327`).
          canvas: this.system.currentCanvasTexture(),
        });
      });
    }

    // 4. THE PICK PASSES, IN BOTH BRANCHES.
    //
    // Outside the paused branch for the same reason `selection.resolve()` is at
    // the top of this method: `runFrame` is what a paused frame skips, and
    // clicking to select must keep working when it is -- which is precisely when
    // a user wants to inspect a particle. This call lived at the end of
    // `runFrame`, so while paused nothing was ever recorded, yet the readback
    // below still ran and decoded whatever stale bytes the staging buffer held.
    //
    // AFTER the branch, so it keeps the ordering `runFrame` gave it: the pick
    // sees the positions the frame ended on, which are the entities the user is
    // looking at when they click. While paused those are the frozen ones, which
    // is the same guarantee.
    this.system.recordPick(encoder);

    // AFTER the loop, not before: the camera binds its own targets for every
    // sample above, so binding the swap chain any earlier would be undone.
    this.assembler.present(
      encoder,
      this.camera.result(),
      this.surface.context.getCurrentTexture().createView(),
      {
        canvasSize: this.system.canvasSize,
        windowSize,
        pan: this.camera.state.pan,
        zoom: this.camera.state.zoom,
      },
      this.prefs,
      this.overlayState(),
    );

    // 5b. THE RECORDING PASS: the same assembled frame, a second time, into
    // the capture canvas -- reading only the crop box's interior.
    //
    // ## The crop, and why this is now EXACT
    //
    // The recording size is capped at the window size, and the recorded pixels
    // are the interior of a centred box of exactly that size. So every exported
    // pixel is a real rendered pixel taken 1:1 -- there is no upscaling, no
    // second render of the world, and no resolution the source cannot supply.
    // (This replaces an earlier design that offered sizes ABOVE the window and
    // stretched to reach them, which was correctly composed but no sharper than
    // the window it came from.)
    //
    // `capture` carries that as a uv remap. `windowSize` stays the WINDOW's,
    // not the crop's: the letterbox maths must place the world exactly as it is
    // placed on screen, and the remap is what selects the sub-rectangle
    // afterwards. Passing the crop size here instead would re-letterbox the
    // world for a smaller viewport and the recording would show a different
    // framing than the box promised.
    //
    // A SECOND `present()` RATHER THAN A COPY OF THE FIRST. The two differ in
    // ways a blit could not express: this one reads a sub-rect, carries no
    // brush reticle and no crop box, and the screen must keep showing both.
    //
    // IT IS CHEAP, and that is the point of the design rather than an accident
    // of it: `camera.result()` is the already-accumulated HDR frame, so
    // everything expensive -- every physics sub-step, every blur sample --
    // happened once, above, and is shared. This pass is bloom plus a tone curve
    // over a texture that already exists.
    //
    // WHY THE OVERLAYS ARE HAND-BUILT rather than `this.overlayState()`:
    //
    //   - The RETICLE is dropped. It is a cursor, not part of the picture, and
    //     a video with a ring following an absent mouse is not what anyone is
    //     exporting.
    //   - The CROP BOX is dropped, for a stronger version of the same reason: it
    //     marks what will be recorded, so recording it would burn the annotation
    //     into the thing it describes.
    //   - The FIELD is KEPT, when it would be on screen. Unlike those two it is
    //     painted content -- the user made it, it steers the particles, and
    //     `fieldAlwaysShow` is an explicit statement about wanting to see it.
    //     Suppressing it would silently drop authored work from the export.
    //
    // Bloom and motion blur need no mention: blur is baked into
    // `camera.result()` before the assembler sees it, and bloom runs INSIDE
    // `present()` from `this.prefs`. Both are in the recording because both are
    // in the frame, which is what "record what the camera outputs" means.
    const recorder = this.recorder;
    const capture = recorder?.captureTarget ?? null;
    if (recorder !== null && capture !== null) {
      const [cw, ch] = capture.size();
      const [ww, wh] = windowSize;
      // The sub-rect, in uv. Centred, so the offset is half the leftover on each
      // side -- the uv form of `cropRect`'s pixel centring, and derived from the
      // same two sizes so the two cannot disagree about where the box is.
      //
      // **CLAMPED TO 1, which is not defensive padding -- it is reachable.**
      // `setRecorder` locks the canvas to the recording's aspect, which SHRINKS
      // the window; the recording size is fixed when the recorder is built and
      // does not shrink with it. So `cw` can exceed `ww` for the frames between
      // the lock being applied and the `ResizeObserver` reporting the new
      // backing store, and again whenever the user makes the browser smaller
      // mid-export.
      //
      // Unclamped, a scale above 1 samples OUTSIDE the source. The sampler is
      // clamp-to-edge (`renderTargets.ts`), so that does not read garbage -- it
      // smears the edge row of pixels into a border, which looks like a
      // legitimate vignette and would be very easy to mistake for a rendering
      // choice rather than a bug. Capping at 1 records the whole frame instead,
      // which is the honest answer when the crop no longer fits.
      const scale: readonly [number, number] = [
        Math.min(1, cw / ww),
        Math.min(1, ch / wh),
      ];
      this.assembler.present(
        encoder,
        this.camera.result(),
        capture.context.getCurrentTexture().createView(),
        {
          canvasSize: this.system.canvasSize,
          // THE WINDOW'S, deliberately. See the note above.
          windowSize,
          pan: this.camera.state.pan,
          zoom: this.camera.state.zoom,
        },
        this.prefs,
        {
          ...NO_OVERLAYS,
          showField: this.prefs.fieldAlwaysShow || this.mouseMode === 'draw',
          capture: {
            scale,
            offset: [(1 - scale[0]) / 2, (1 - scale[1]) / 2],
          },
        },
      );
    }

    this.device.queue.submit([encoder.finish()]);

    // AFTER submit, and it has to be: `mapAsync` may not be called while the
    // encoder that writes the buffer is still open. It resolves on a later
    // frame, which is what makes the whole path two-phase.
    this.system.beginPickReadback();
  }

  /**
   * Attach or detach the video recorder.
   *
   * A setter rather than construction inside this class, because building a
   * recorder needs an `await` (mediabunny is fetched on demand) and `frame()` is
   * synchronous. See the `recorder` field.
   *
   * Passing null detaches without finalizing -- the caller owns the recorder's
   * lifecycle and is the one that knows whether the file should be written.
   */
  setRecorder(recorder: VideoRecorder | null): void {
    this.recorder = recorder;

    // **SHAPE THE CANVAS TO THE RECORDING, so the preview is not a lie.**
    //
    // Without this the canvas keeps filling the viewport while the video holds a
    // differently-shaped crop of it, so the picture on screen is composed for
    // the window's aspect and the file for the crop's. The export is correct
    // either way -- this is purely what the user sees while it runs -- but a
    // preview that does not match the output makes a recording impossible to
    // judge as it happens, which is when judging it is useful.
    //
    // Locking the canvas to the recording's aspect makes the crop fill it
    // exactly. Released on detach, which every path goes through: normal
    // completion, cancel, and the failure paths in `Panel.finishExport`.
    //
    // The RESOLUTION is not forced, only the ASPECT: the backing store stays at
    // whatever device pixels the element gets, so a 720p export on a large
    // display still previews at full sharpness rather than being pixel-doubled.
    if (recorder === null) {
      this.surface.setAspectLock(null);
      return;
    }
    const { width, height } = recorder.settings.resolution;
    this.surface.setAspectLock(width / height);
  }

  /** The attached recorder, for the driver loop and the UI's progress readout. */
  get activeRecorder(): VideoRecorder | null {
    return this.recorder;
  }

  /**
   * The physics rate and blur sample count to render THIS frame with.
   *
   * Split out of `frame()` so recording can override both without the frame
   * loop growing a second copy of the schedule logic. While a recording is
   * running the numbers come from its settings -- which is what lets an export
   * use 480 steps and 64 samples in an editor that would be unusable at either.
   *
   * PAUSED STILL WINS. A paused simulation has nothing to average, so N samples
   * of a still image is the same picture at N times the cost -- true whether or
   * not a recording is in flight (`orchestrator.py:301-304`).
   */
  private frameSchedule(): { steps: number; schedule: ReturnType<typeof blurSchedule> } {
    const recording = this.recorder;
    const steps =
      recording !== null
        ? recording.settings.physicsSteps
        : Math.max(1, Math.trunc(this.prefs.physicsSteps));
    const samples =
      recording !== null ? recording.settings.motionBlurSamples : this.prefs.motionBlurSamples;

    return {
      steps,
      schedule: this.paused ? { samples: 1, stride: 1 } : blurSchedule(steps, samples),
    };
  }

  /**
   * Translate canvas input into whatever the ACTIVE TOOL means.
   *
   * The UI reports *what happened* (a drag, a click); deciding what it means is
   * the Orchestrator's job. Every field consulted here is already filtered for
   * UI capture, so dragging a panel never pans the view and clicking a button
   * never selects a particle -- see `ui/inputState.ts`, where that filtering is
   * resolved once, at the event handler.
   *
   * THE TOOL ARBITRATES THE LEFT BUTTON. Selecting and painting both want it,
   * and they must not both fire -- without a tool, every click would select a
   * particle on the way down and paint on the way across.
   *
   * NAVIGATION IS NOT A TOOL. WASD, Q/E and the scroll wheel move the view in
   * every mode, so the mouse is free for tools and the view can be adjusted
   * mid-stroke.
   */
  private applyCanvasInput(state: InputState): void {
    const canvasSize = this.system.canvasSize;
    const windowSize = this.surface.size();

    this.applyCameraKeys(state, canvasSize);

    if (this.mouseMode === 'select') {
      // ONE CLICK, ONE PICK, unconditionally. What the pick MEANS -- aim,
      // re-aim, or commit -- is decided when the result lands, not here: the
      // cohort it hit is not known yet, and the whole two-stage rule is a
      // question about that cohort. See `frame()`.
      if (state.leftPressed) this.selection.select(state.mousePos);
      // Right-click CANCELS AN AIM FIRST, and undoes only when there is no aim
      // to cancel. Right-click is "back out of what I just did", and while a
      // cohort is lit the thing the user just did is light it -- undoing a
      // completed edit from further back instead would be a bigger, more
      // surprising step than the one they asked to take back. With nothing lit
      // it is the desktop's plain undo binding, unchanged.
      //
      // THE `Z` HOTKEY IS DELIBERATELY NOT ROUTED THROUGH THIS. It dispatches
      // `undo` straight to the command bus (`ui/hotkeys.ts`), so the keyboard
      // always means undo no matter what is lit -- there is no cancelling
      // gesture to confuse it with, and a modifier-free key that sometimes
      // undoes and sometimes does not would be worse than either behaviour.
      if (state.rightPressed) {
        if (this.highlightEnabled && this.highlight.isHighlighted) {
          this.clearHighlight();
        } else {
          this.dispatch({ kind: 'undo' });
        }
      }
    } else if (this.mouseMode === 'draw') {
      // RECORDS INTENT, DOES NOT PAINT. Painting needs an encoder, and this runs
      // above the one `frame()` opens -- deliberately, because that is what
      // makes a stroke land once per rendered frame instead of once per physics
      // sub-step. `frame()` consumes what this records.
      const step = strokeFor(state, this.strokePrevUv, (p) => this.mouseFieldUv(p));
      this.pendingStroke = step.stroke;
      this.strokePrevUv = step.prevUv;
    }
    // SHOVE HAS NO BRANCH HERE, and that asymmetry with DRAW is correct rather
    // than an omission. A shove is not an event to record: `shoveState` reads
    // the same `InputState` directly in the frame loop, because its answer is a
    // uniform the physics loop needs, not a pass to encode. The desktop splits
    // them the same way (`_apply_draw_input` vs `shove_state`).
    //
    // There is also no fall-through to guard against here, unlike the desktop,
    // where a bare `pass` exists so the branch below cannot pan the view out
    // from under a shove. Zoom below is navigation and runs in every tool.

    // Zoom works in every tool: it is navigation, not a tool.
    if (state.scroll !== 0) {
      this.camera.state.zoomAtPixel(state.scroll, state.mousePos, windowSize, canvasSize);
    }
  }

  /**
   * WASD pans, Q/E zooms. Navigation, so it works in every tool.
   *
   * Reads keys HELD rather than keys pressed: this is continuous motion for as
   * long as the key is down, not a one-shot. **Scaled by dt so the speed is the
   * same at any framerate** -- a per-frame step would move twice as fast at
   * 120fps as at 60.
   *
   * This is also why these two are NOT in the hotkey table: routing them
   * through it would make each one step per key-REPEAT, whose rate is an OS
   * setting (the plan states this under Step 8, and it applies the moment
   * held-key movement exists, which is now).
   */
  private applyCameraKeys(state: InputState, canvasSize: readonly [number, number]): void {
    const dt = state.dt;
    if (dt <= 0.0) return;

    const held = state.keysHeld;
    // W is up on screen, which is +y in world space.
    const dx = (held.has('KeyD') ? 1 : 0) - (held.has('KeyA') ? 1 : 0);
    const dy = (held.has('KeyW') ? 1 : 0) - (held.has('KeyS') ? 1 : 0);
    if (dx !== 0 || dy !== 0) {
      const step = PAN_PER_SECOND * dt;
      this.camera.state.panByFraction([dx * step, dy * step], canvasSize);
    }

    // E zooms in, Q out -- E is the "forward" of the pair, next to W.
    const dz = (held.has('KeyE') ? 1 : 0) - (held.has('KeyQ') ? 1 : 0);
    if (dz !== 0) {
      this.camera.state.zoomByFactor(ZOOM_PER_SECOND ** (dz * dt));
    }
  }

  /**
   * Whether the drawing overlays are on screen, and where.
   *
   * THE ACTIVE TOOL DECIDES, so this is the Orchestrator's call: the assembler
   * renders what it is told and the UI owns no simulation truth (invariant 10).
   * The field can optionally stay visible outside the Draw tool; the reticle
   * never does, because it shows where a brush that is not currently usable
   * would land.
   *
   * The reticle serves BOTH brush tools: Draw and Shove share `drawSize`, so
   * the ring means the same thing in each -- the reach of what the button is
   * about to do. Because one ring serves two tools, its SHAPE cannot say which
   * is armed, so its LINE STYLE does: Shove dashes it, Draw leaves it solid.
   *
   * The field half stays dark until Step 9 supplies a texture; the reticle half
   * is live now, which is what makes the brush size slider mean something
   * before the field exists.
   */
  private overlayState(): OverlayState {
    const drawing = this.mouseMode === 'draw';
    const shoving = this.mouseMode === 'shove';
    const brushing = drawing || shoving;
    const showField = this.prefs.fieldAlwaysShow || drawing;
    // The crop box, whenever one has been asked for and is smaller than the
    // window. Independent of the tool and of the reticle: it says what will be
    // recorded, which is true regardless of what the mouse is currently doing.
    const crop = this.cropOverlay;

    if (!(brushing && this.prefs.showReticle)) {
      return { ...NO_OVERLAYS, showField, crop };
    }
    // The brush's VISIBLE extent, which is 2 sigma of its gaussian -- and also
    // exactly the eraser's hard radius, so the ring reads as "what the eraser
    // will take". Measured in the aspect-corrected metric the brush shader
    // paints in, so what crosses this boundary is a plain scalar.
    return {
      ...NO_OVERLAYS,
      showField,
      crop,
      reticleCenter: this.mouseFieldUv(this.input.mousePos),
      reticleRadius: 2.0 * this.prefs.drawSize,
      reticleDashed: shoving,
    };
  }

  /**
   * The crop box to draw on screen, or null for none.
   *
   * Null in the two cases where a box would be noise rather than information:
   * nobody has asked for a crop, and the crop is the whole window (a rule around
   * the screen edge with a zero-pixel surround says nothing).
   *
   * The size arrives from the UI through `setCropPreview` rather than being read
   * from a recorder: the box must be visible while the user is CHOOSING the
   * size, which is before any recorder exists. During a recording it is the
   * recorder's own size that is shown, because that is what is being captured
   * and the sliders can no longer move it.
   */
  private get cropOverlay(): CropOverlay | null {
    const resolution =
      this.recorder?.settings.resolution ?? this.cropPreview;
    if (resolution === null) return null;

    const windowSize = this.surface.size();
    if (isFullFrame(resolution, windowSize)) return null;

    const { width, height } = clampResolution(resolution, windowSize);
    // HALF-extent, because the box is centred and the shader tests one symmetric
    // distance from the middle. See `packFrameAssemblyUniforms`.
    return { halfExtent: [width / windowSize[0] / 2, height / windowSize[1] / 2] };
  }

  /**
   * Show a crop box for a size the user is choosing, or null to hide it.
   *
   * Set by the Recording Controls tab as its sliders move, so the box is
   * visible while the size is being chosen rather than only once recording
   * starts -- which is the entire point of an on-screen box.
   *
   * A plain setter and a nullable field rather than a command, for the reason
   * `panelOpen` is one: it is a statement about what the EDITOR is showing, not
   * a change to the project, and it must never reach history.
   */
  setCropPreview(resolution: Resolution | null): void {
    this.cropPreview = resolution;
  }

  private cropPreview: Resolution | null = null;

  /**
   * Screen pixel -> field texture uv [0,1].
   *
   * COMPOSED from `coords`, never reimplemented. The reference carried six
   * divergent copies of this transform and its overlays never quite lined up
   * with its simulation as a result; `coords.ts` exists to make that impossible
   * (invariant 9). `screenToWorld` is the same call picking uses, so a brush
   * lands exactly where a click would select.
   *
   * THE TWO HALVES USE DIFFERENT SIZES, deliberately. screen->world is the
   * CANVAS's transform -- that is the space the camera shows and the particles
   * live in. world->uv is the FIELD's, because the field may be lower resolution
   * than the canvas (see `MAX_FIELD_DIM`). The two agree today only because
   * `fieldDimensions` preserves the canvas aspect and uv is normalized; reading
   * the field's own size here says so out loud rather than relying on it, and is
   * what keeps strokes landing under the cursor once the cap bites
   * (`drawing_commands.py:43-47`).
   */
  private mouseFieldUv(pixel: readonly [number, number]): readonly [number, number] {
    const cam = this.camera.state;
    const world = screenToWorld(
      pixel,
      this.surface.size(),
      this.system.canvasSize,
      cam.pan,
      cam.zoom,
    );
    return worldToUv(world, this.strafeField.size);
  }

  // =========================================================================
  // The cohort highlight
  // =========================================================================

  /**
   * Whether clicks go through the two-stage highlight at all.
   *
   * **THE ONE PLACE THE TWO EXEMPTIONS LIVE**, so a click, the uniform the
   * shader reads, and anything added later cannot disagree about whether the
   * highlight is running:
   *
   *   - the `oneClickSelection` preference, which is the explicit opt-out; and
   *   - A SINGLE COHORT, where the feature is not merely unnecessary but
   *     actively wrong. With one cohort every particle is in it, so the first
   *     click would light the entire screen (dimming nothing, since there is no
   *     "outside") and the user would see no feedback at all -- then need a
   *     second click for a selection that could never have gone anywhere else.
   *     A confirmation step with one possible answer is pure cost.
   *
   * Reads the SELECTED config's cohort count, matching what `camBrush.wgsl`
   * colours by and what the Cohorts control edits. With several configs loaded
   * the selected one already sets the palette for all (`frame()`), so this
   * follows the same rule rather than inventing a second one.
   */
  private get highlightEnabled(): boolean {
    if (this.prefs.oneClickSelection) return false;
    return selectedConfig(this.project).cohorts > 1;
  }

  /**
   * Apply a landed pick to the highlight, and say whether it COMMITS.
   *
   * The single decision point of the two-stage selection. `CohortHighlight`
   * classifies the pick against what is lit; this turns that verdict into the
   * one bit the caller needs -- whether the rule should be adopted.
   *
   * **THE FIRST CLICK OF A SELECTION MUST NOT CHANGE THE PROJECT**, and this is
   * what enforces it: `false` here means `adoptRule` hands the project back
   * untouched, so `SelectionController.resolve()` finds nothing changed, records
   * no history entry (its guard is reference identity), and the click costs
   * exactly one highlight transition.
   *
   * With the highlight disabled every hit commits immediately, which IS the
   * old one-click behaviour -- and a miss still commits nothing, because there
   * is no rule to adopt. Note this deliberately does not consult
   * `CohortHighlight` at all in that case: feeding it picks it cannot act on
   * would leave a cohort lit behind a disabled feature, ready to change the
   * meaning of the first click after the preference is turned back off.
   *
   * **A NO-OP SELECTION IS REFUSED, BUT THE HIGHLIGHT STILL MOVES.** At mutation
   * scale 0 with an authored rule every cohort obeys the same rule, so adopting
   * one installs what the project already has: the simulation would reset and an
   * undo entry would be pushed for a picture that did not change. Aiming stays
   * live because it costs nothing and still shows which particles share a
   * cohort -- it is only the commit that has nothing to do. `selectionIsNoOp`
   * says why this asks the shader's generate-test rather than `ruleIsSentinel`.
   */
  private applyPickToHighlight(result: PickResult): boolean {
    const noOp = selectionIsNoOp(this.project);

    if (!this.highlightEnabled) return isHit(result) && !noOp;

    // ASKED BEFORE THE TRANSITION, not after. `apply` CLEARS the highlight on a
    // 'commit' verdict -- so letting it run and then refusing the adoption would
    // put the cohort out while changing nothing: the lit cohort would go dark on
    // click, which reads as the feature being broken rather than as the
    // selection being declined. Classifying first lets a refused commit leave
    // the highlight exactly where it was, so the user can raise the mutation
    // scale and click again.
    if (noOp && this.highlight.classify(result) === 'commit') return false;

    return this.highlight.apply(result) === 'commit';
  }

  /**
   * Put the highlight out.
   *
   * Called wherever the lit cohort stops naming something true: leaving the
   * Select tool, a rebuild that renumbers cohorts, and every rule change that
   * did not come from a commit (the rerolls, and undo/redo of any of them).
   */
  private clearHighlight(): void {
    this.highlight.clear();
  }

  // =========================================================================
  // Selection
  // =========================================================================

  /**
   * The collaborators `SelectionController` needs.
   *
   * Built here rather than inline in the constructor so the two ordering
   * constraints stay readable: this object says WHAT selection does, and
   * `frame()` says WHEN. `selection.ts` enforces neither -- both are properties
   * of where the caller puts `resolve()` and `select()`.
   */
  private selectionHost(): SelectionHost<Project, PickResult> {
    return {
      requestPick: (pixel, wide = false) => {
        const cam = this.camera.state;
        const windowSize = this.surface.size();
        const canvasSize = this.system.canvasSize;
        // The one place the pick inputs are built, so a dispatch and anything
        // reasoning about the same pick cannot disagree about where it was
        // aimed or how wide it searched (`selection_commands.py:76-95`).
        const target = screenToWorld(pixel, windowSize, canvasSize, cam.pan, cam.zoom);
        // Through the transform, not a fudge factor, so the tolerance is
        // exactly 40 screen pixels at any zoom.
        //
        // **CONFIRM MODE IS HOW ENTER COMMITS WITHOUT A CURSOR.** The negative
        // radius is a sentinel: `entityPick.wgsl` reads the sign as "restrict to
        // the highlighted cohort, ignore distance as a filter" and still breaks
        // ties on nearness to `target`, so the adopted rule comes from a member
        // near the middle of the view. See `CONFIRM_PICK_RADIUS`.
        const radius = wide
          ? CONFIRM_PICK_RADIUS
          : radiusPxToWorld(
              DEFAULT_PICK_RADIUS_PX,
              windowSize,
              canvasSize,
              cam.pan,
              cam.zoom,
            );
        // THE HIGHLIGHT GOES WITH THE PICK, so the reduce pass can give the lit
        // cohort priority within a small radius of the cursor -- otherwise a
        // click meant to CONFIRM a cohort gets handed to whatever unrelated
        // particle happens to be a few pixels nearer, and the confirmation
        // silently re-aims instead. See `CONFIRM_SNAP_FRACTION`.
        //
        // Through the same `highlightEnabled` gate everything else uses, so a
        // stale cohort cannot bias picks after highlighting is switched off.
        this.system.requestPick(
          target,
          radius,
          this.highlightEnabled ? this.highlight.cohort : NO_COHORT,
        );
      },
      // THE REPLAY, not a fresh read. `frame()` has already consumed this
      // frame's result from the phase machine so the highlight could classify it
      // before `resolve()` acts on it; going to `this.system` again here would
      // find `idle` and answer `null`, and the pending click would wait forever
      // for a result that had already arrived and been thrown away.
      retrievePick: () => this.landedPick,
      isHit,
      currentProject: () => this.project,
      /**
       * THE TWO-STAGE GATE. A pick only becomes a rule change when it lands on
       * the cohort the user was already shown; the first click of a selection
       * merely lights that cohort up.
       *
       * Returning the project UNCHANGED is how "no adoption" is expressed, and
       * it is load-bearing rather than merely tidy: `SelectionController.resolve`
       * calls this and then `recordHistory`, whose guard is reference identity
       * (`before !== this.project`). An unchanged project therefore records no
       * undo entry by itself -- so an aiming click cannot litter the timeline
       * with steps that undo to the state they came from.
       *
       * The highlight TRANSITION is not made here. This runs inside `resolve()`,
       * which may call it once per landed pick, and a getter that also mutates
       * would make the outcome depend on how many times it happened to be
       * consulted. `frame()` applies the transition, once, and passes the verdict
       * in -- see `applyPickToHighlight`.
       */
      adoptRule: (p, result) =>
        result.rule === null || !this.pickCommits ? p : adoptRule(p, result.rule),
      setProject: (p) => {
        this.setProject(p);
      },
      recordHistory: (before, label) => {
        this.recordHistory(before, label);
      },
      setSelected: (result) => {
        this.selected = result;
      },
      /**
       * BY COHORT, not by particle index.
       *
       * A commit adopts the picked particle's RULE, and every particle in its
       * cohort obeys that rule -- so "cohort 7" names what actually changed
       * where "particle #48213" names an individual the user cannot pick out
       * again. The index was what this said before the toast existed, when the
       * label only ever appeared in the undo menu; now that it is shown at the
       * moment of the act, it has to describe the act.
       *
       * The toast for the SAME event is raised in `frame()` rather than here:
       * this runs inside `resolve()`, which the host may call without a commit
       * following, and announcing from a describe-callback would fire on
       * aiming clicks too.
       */
      describe: (result) =>
        historyLabelFor({ kind: 'commitSelection', cohort: result.cohort }),
    };
  }

  // =========================================================================
  // Per-frame plumbing
  // =========================================================================

  /**
   * Adopt a new project and push it to the GPU.
   *
   * **THE single place project state changes.** Everything that used to be
   * "apply the configs, fix the name, re-clamp the selection" is one call, with
   * the invariants enforced inside `makeProject` rather than repeated at each
   * call site.
   *
   * Deliberately does NOT record history -- hover-preview and undo/redo flow
   * through here too, and neither belongs in the timeline. See
   * `recordHistory`.
   */
  private setProject(project: Project): void {
    // **A CHANGED COHORT COUNT PUTS THE HIGHLIGHT OUT.** Read BEFORE the
    // assignment, since the comparison is across the change.
    //
    // A lit cohort is an index into a population that no longer exists. Going
    // from 8 cohorts to 4, cohort 6 names nothing at all; going from 4 to 8, the
    // particles that were cohort 2 are redistributed and the lit index now
    // covers a different set. Either way the highlight stops naming what the
    // user aimed at, and the confirming click would commit a rule from a
    // population that has been rebuilt underneath it.
    //
    // HERE RATHER THAN AT THE COMMAND HANDLERS, because there are several and
    // they kept diverging: the mutation bar's cohort/grid buttons go through
    // `setPopulationLayout`, the panel's Cohorts control through `editSetting`,
    // and a preset load or an undo through `applyProject` -- all of which
    // change the count and none of which cleared the highlight. This is the one
    // place project state changes, which is the same reason `setWrap` is called
    // from here: a single choke point is what stops a new caller reintroducing
    // the bug by forgetting.
    //
    // COMPARES THE COUNT, not the config identity. Every slider drag calls this
    // method, and clearing on any project change at all would put the highlight
    // out whenever the user nudged an unrelated value -- which is the opposite
    // failure and just as confusing.
    const cohortsBefore = selectedConfig(this.project).cohorts;

    this.project = project;
    this.system.applyProject(project.configs, project.world);

    if (selectedConfig(project).cohorts !== cohortsBefore) this.clearHighlight();
    // The field samples the world the same way the canvas does, so its wrap mode
    // follows the boundary condition -- and it belongs in THIS method because
    // this being the single place project state changes is exactly what stops a
    // load or an undo leaving the two disagreeing (`orchestrator.py:381-385`
    // makes the same call for the same reason). Invariant 9: four things must
    // agree on the boundary mode, and the field is one of them.
    //
    // See `StrafeField.setWrap` for why this currently issues no GPU work: the
    // field's readers already take their address mode from the canvas's
    // sampler, so the two cannot disagree. The call stays because the ACCOUNTING
    // belongs here, and because the day the field grows its own sampler this is
    // where it would have had to go anyway.
    this.strafeField.setWrap(project.world.boundaryConditions === BC.WRAP);
  }

  /**
   * Record an undoable step from `before` to the current project.
   *
   * Called by every deliberate act. Deliberately NOT from `setProject` --
   * hover-preview and undo/redo flow through there too, and neither belongs in
   * history (`project/history.ts` says why).
   *
   * **THE GUARD IS REFERENCE IDENTITY** (`selection_commands.py:198`): `!==` is
   * the port of `is not`, and a spread copy anywhere in the chain silently
   * breaks it into "every call records an entry, including the no-ops".
   * `project.ts`'s mutators return the receiver unchanged when nothing changes,
   * which is what keeps this meaningful.
   */
  /**
   * Queue a message for the toast. See `Status.notice`.
   *
   * The ONE writer of `pendingNotice`, so there is a single place to look when
   * asking what can raise a toast. A later notice in the same frame REPLACES an
   * earlier one rather than queueing behind it: two things worth announcing in
   * one frame is a compound action (a preset load resets and re-seeds), and the
   * last one to fire is the outermost -- which is the one the user asked for.
   */
  private notify(message: string): void {
    this.pendingNotice = message;
  }

  /** Take the pending notice and clear it. The destructive half of `notify`. */
  private takeNotice(): string {
    const notice = this.pendingNotice;
    this.pendingNotice = '';
    return notice;
  }

  /**
   * Zero the rule so the GPU generates a fresh behaviour, and say so.
   *
   * A METHOD BECAUSE TWO COMMANDS REACH IT. `randomizeBehavior` is the obvious
   * one; `randomizeSeed` arrives here whenever the rule is already generated,
   * because moving the seed under a generated rule IS this act -- see that case
   * for why the two collapse. Sharing the body rather than copying it is what
   * makes the toast, the undo entry and the reset identical however it is
   * reached, so `F` in the sentinel state cannot drift from `B`.
   */
  private randomizeBehavior(): void {
    const before = this.project;
    this.setProject(randomizeBehavior(this.project));
    // `notifyBehavior` rather than a bare `recordHistory`: this is the most
    // complete behaviour change there is, so it earns the toast every other
    // whole-rule replacement gets -- and routing both through one call keeps
    // "Randomize behavior" and "Undo: Randomize behavior" derived from the same
    // value. The stored label is unchanged from when this was a literal:
    // `historyLabelFor` lowercases the first letter, reproducing `randomize
    // behavior` exactly.
    this.notifyBehavior(before, { kind: 'randomizeBehavior' });
    // The rule is zeroed so the GPU generates a fresh one. That already LOOKS
    // like a restart (`derive_entity_rule` takes the generate branch and the
    // population visibly reorganizes), which is why this path never reset
    // before; but it does not clear the trails or the positions the old rule
    // built, and "reset on behavior change" is a promise about all three.
    this.behaviorChangedElsewhere();
  }

  /** Announce a behaviour change AND record it, so the toast and undo agree. */
  private notifyBehavior(before: Project, event: BehaviorEvent): void {
    this.notify(describeEvent(event));
    this.recordHistory(before, historyLabelFor(event));
  }

  private recordHistory(before: Project, label: string, coalesceKey: string | null = null): void {
    if (before !== this.project) {
      this.history.record(before, this.project, label, coalesceKey);
    }
  }

  /**
   * Restart the simulation when the config on screen CHANGES, if the flag allows.
   *
   * **THE single place the load paths reset**, for the same reason `setProject`
   * is the single place project state changes: every path that swaps the config
   * either all restart or all do not, and a path added later should be a
   * one-line call rather than a copy of the flag check.
   *
   * Called AFTER `setProject`, never before: `reset()` only sets a sentinel the
   * next `advance()` reads, so the configs the GPU regenerates from must
   * already be the new ones.
   *
   * **KEYED ON THE CHANGE, NOT ON THE CLICK.** Hover-preview is what the user
   * experiences as "loading" -- each row applies as the pointer reaches it, so
   * that is where a config first needs its opening conditions. The committed
   * click that follows changes NOTHING: the project already holds the previewed
   * config, so it resets nothing and merely closes the menu. Resetting there
   * would restart a simulation the user had been watching settle since they
   * hovered the row they then chose. See `RESET_ON_CONFIG_LOAD`.
   *
   * **THE HIGHLIGHT GOES OUT HERE TOO, AND IT IS NOT GATED ON THE FLAG.** A
   * config swap replaces every rule on screen, so a cohort lit against the old
   * one names a behaviour nothing is running -- and the cohort COUNT may have
   * changed with it, in which case the lit index does not even refer to the same
   * particles. That is true whether or not the simulation restarts, which is why
   * the clear sits above the flag rather than inside it.
   *
   * Putting it here rather than at the individual call sites is what makes it
   * cover the whole set for free: browsing the Load menu (the hover IS the
   * load), the mouse-out restore, Revert to Saved, the preset cycle, checkpoint
   * apply and a shared link opened mid-session all reach this one method.
   */
  private resetForConfig(): void {
    this.clearHighlight();
    if (RESET_ON_CONFIG_LOAD) this.system.reset();
  }

  /**
   * Reset for a committed load ONLY if no preview already did.
   *
   * `adoptSaved` serves two kinds of caller and they want opposite things. A
   * click in the Load menu arrives with a browse in flight: the config is
   * already on screen, already restarted, and resetting again would throw away
   * the settling the user just spent time watching. The LEFT/RIGHT cycle,
   * Revert to Saved and `loadPreset` arrive with no browse at all, having
   * changed the config for the first time right here -- and they must restart,
   * or those paths would silently lose the feature.
   */
  private resetIfUnpreviewed(previewed: boolean): void {
    if (!previewed) this.resetForConfig();
  }

  /** The undo/redo half of `resetForConfig`, gated on its own flag. */
  private resetForUndoRedo(): void {
    if (RESET_ON_CONFIG_UNDO_REDO) this.system.reset();
  }

  /**
   * Restart the simulation because the particles got a NEW TARGET RULE.
   *
   * **THE single place the behavior-change paths reset**, for the reason
   * `resetForConfig` is the single place the load paths do: every path that
   * retargets the particles either all restart or all do not, and a path added
   * later should be a one-line call rather than a copy of the check.
   *
   * Called AFTER `setProject`, never before -- `reset()` only sets a sentinel
   * the next `advance()` reads, so the configs the GPU regenerates from must
   * already be the new ones.
   *
   * The callers are a committing click, Reroll Mutations, Reroll All Behavior,
   * and the undo/redo of any of them. Undo/redo goes through
   * `resetIfRuleChanged` instead, because there the step being replayed is not
   * necessarily a rule change at all.
   *
   * See `Preferences.resetOnBehaviorChange` for why this is a preference rather
   * than a feature flag.
   */
  private resetForBehavior(): void {
    if (this.prefs.resetOnBehaviorChange) this.system.reset();
  }

  /**
   * A rule change arrived from somewhere OTHER than a committing click.
   *
   * The rerolls and undo/redo, which retarget the particles without going
   * anywhere near the pick path. Both halves happen unconditionally-then-gated:
   * the highlight ALWAYS goes out (a lit cohort names a behaviour that is no
   * longer running, whatever the preference says), while the restart is the
   * preference's business.
   *
   * Separate from `resetForBehavior` because the committing click must NOT use
   * this: `CohortHighlight.apply` has already cleared the highlight as part of
   * classifying that very pick, so calling it there would be a second clear of
   * something already dark -- harmless, but it would suggest the commit path
   * needs an external clear when the state machine handles its own.
   */
  private behaviorChangedElsewhere(): void {
    this.clearHighlight();
    this.resetForBehavior();
  }

  /**
   * The undo/redo half of `resetForBehavior`: reset only if the RULE moved.
   *
   * Undo and redo are ONE code path for every kind of step -- a rule adoption, a
   * slider drag, a boundary-mode switch all arrive here identically. Resetting
   * unconditionally would restart the simulation when someone stepped back over
   * a brightness tweak, which is not a behavior change and is exactly the
   * "reset I did not ask for" that makes undo feel unsafe.
   *
   * So it compares the two states. The rule and the mutation seed BOTH count,
   * and the seed is not an optimization: Reroll Mutations moves only the seed
   * (`randomizeSeed` edits `mutationSeed` and nothing else), while Reroll All
   * Behavior moves both -- so a rule-only comparison would silently skip the
   * reroll case, which is one of the three the feature was asked for.
   */
  private resetIfRuleChanged(before: Project, after: Project): void {
    if (!ruleChanged(before, after)) return;
    // THE CLEAR IS NOT GATED ON THE PREFERENCE. Undoing a rule change puts a
    // different behaviour on the particles whether or not the simulation
    // restarts, so a cohort lit against the old one is stale either way. Only
    // the restart is the preference's decision.
    this.behaviorChangedElsewhere();
  }

  /**
   * The state from before any hover-preview began, or `fallback`.
   *
   * A committed load arrives with the project ALREADY moved by the preview that
   * was showing when the user clicked. Recording `before = live` would see no
   * change and skip the entry, so commits record against what was live before
   * browsing started (`selection_commands.py:201-209`).
   *
   * **A commit does not name a surface, deliberately.** Clicking a row commits
   * whatever browse is in flight, and the click itself does not know -- nor
   * should it -- whether a second browser happens to be open elsewhere. With at
   * most one origin this is the desktop's behaviour exactly; with two, the
   * OLDEST is the right answer, because it is the state the user was in before
   * any of this browsing started and therefore what undo should return them to.
   * `Map` preserves insertion order, so the first entry is that state.
   */
  private prePreviewProject(fallback: Project): Project {
    for (const origin of this.previewOrigins.values()) return origin;
    return fallback;
  }

  // =========================================================================
  // The command bus
  // =========================================================================

  /**
   * Route one command. The port of `orchestrator.py:206-244`'s dict.
   *
   * A `switch` over a discriminated union rather than a name-keyed table, so
   * **the compiler checks exhaustiveness** -- the `never` in the default arm is
   * what makes adding a `Command` member without a handler a build error. The
   * Python's dict can only fail at dispatch time, on a key the UI happened to
   * type.
   */
  dispatch(command: Command): void {
    switch (command.kind) {
      case 'reset':
        this.system.reset();
        return;

      case 'togglePause':
        this.paused = !this.paused;
        return;

      case 'toggleCameraMode':
        this.camera.state.toggleMode();
        return;

      case 'resetCamera':
        this.camera.state.reset();
        return;

      case 'setHighlightedCohort': {
        // Only ever RE-AIMS an existing highlight. Refusing while nothing is lit
        // is what keeps the stepper honest about being an alternative to
        // clicking a neighbour rather than a second way to start a selection:
        // the arrows and the field only exist in the UI once a cohort is lit,
        // and a command that could light one from nothing would let a stray
        // dispatch put the app in a state the user never aimed at. Also refused
        // when highlighting is off at all, for the same reason the status field
        // is gated.
        if (!this.highlightEnabled || !this.highlight.isHighlighted) return;

        // WRAPPED HERE, NOT IN THE UI. Both the arrows and the text field go
        // through this, so there is one answer to "what is 64 with 64 cohorts"
        // and they cannot drift. `wrapCohort` says why a bare `%` is wrong.
        const wrapped = wrapCohort(command.cohort, selectedConfig(this.project).cohorts);
        if (wrapped === NO_COHORT) return;
        this.highlight.set(wrapped);
        return;
      }

      case 'confirmSelection': {
        // Only in Select mode: Enter while painting or shoving would adopt a
        // rule the user is not looking at, from a tool that has nothing to do
        // with selection.
        if (this.mouseMode !== 'select') return;

        // NOTHING TO CONFIRM, when the two-stage highlight is running and no
        // cohort is lit. With highlighting OFF -- one-click selection, or a
        // single-cohort config -- there is no aiming stage to have completed, so
        // Enter commits the same way one click would, which is the specified
        // "works when there is only a single cohort".
        if (this.highlightEnabled && !this.highlight.isHighlighted) return;

        // FROM THE CENTRE. In confirm mode the pixel breaks ties among the
        // cohort's members, so the adopted rule comes from one near the middle
        // of the view rather than from an arbitrary index.
        const [w, h] = this.surface.size();

        // CONFIRM MODE IN BOTH CASES. It applies the cohort filter only when a
        // cohort is actually lit; with highlighting off it searches worldwide
        // and adopts whatever is nearest the centre, which is what one click
        // there would do. Using an ordinary pick for that case instead would
        // give Enter the 15px cursor radius with no cursor behind it -- a
        // keyboard shortcut that usually works is worse than one that always
        // does.
        this.selection.select([w / 2, h / 2], true);
        return;
      }

      case 'cancelSelection':
        // THE AIM-CANCELLING HALF OF RIGHT-CLICK. `applyCanvasInput` picks
        // between cancelling and undoing on exactly this condition; the button
        // that sends this is only shown while a cohort is lit, so the other
        // branch is unreachable from it. Refusing here rather than falling
        // through to `undo` is what keeps that true even if the command is ever
        // dispatched from somewhere else -- an inert press is recoverable, an
        // unexpected undo is not.
        //
        // NO HISTORY ENTRY AND NO TOAST. Nothing about the project changed:
        // the highlight is view state, and the aim being cancelled was never
        // committed to anything. Announcing it would put a message on screen
        // for the act of taking a message away.
        if (!this.highlightEnabled || !this.highlight.isHighlighted) return;
        this.clearHighlight();
        return;

      case 'stepHighlightedCohort': {
        // Highlighting off entirely -- one-click selection, or a single-cohort
        // config -- means there is no cohort to step through and never will be.
        // Inert, as before.
        if (!this.highlightEnabled) return;

        // **NOTHING LIT YET: LIGHT COHORT 0 AND STOP.** The arrows are the
        // mouse-free route into selection, so the first press has to be able to
        // START one -- otherwise the keyboard path is unreachable without first
        // clicking, which is the thing it exists to avoid.
        //
        // Cohort 0 REGARDLESS OF DIRECTION, and it is not an oversight that
        // LEFT does not light the last cohort instead. There is no current
        // position for a direction to be relative TO; the press means "begin",
        // and beginning at the same place whichever key was pressed is more
        // predictable than a rule the user has to derive. Stepping from there
        // behaves normally, so the last cohort is one LEFT away.
        //
        // This is also the one path that can light a cohort without a pick,
        // which is safe precisely because it adopts nothing: it moves the
        // highlight, and `confirmSelection` is still what commits.
        if (!this.highlight.isHighlighted) {
          this.highlight.set(0);
          return;
        }

        // Resolved against the LIVE highlight, which is the authority a hotkey
        // has no other way to read -- the stepper BUTTONS get it from their own
        // input field, and a key has no field. Wrapping is the absolute form's
        // and is reached by routing back through it, so -1 from cohort 0 lands
        // on the last cohort exactly as the `‹` button does.
        this.dispatch({
          kind: 'setHighlightedCohort',
          cohort: this.highlight.cohort + command.delta,
        });
        return;
      }

      case 'setMouseMode':
        // Switching tools abandons any stroke in progress (Step 9), so
        // releasing the button over a different tool cannot resume painting.
        this.mouseMode = command.mode;
        // And it abandons a half-finished selection. The lit cohort is an aim
        // waiting for its confirming click, and only the Select tool can give it
        // one -- leaving it lit would dim the field indefinitely while drawing,
        // and would arm a commit for whenever the user came back.
        this.clearHighlight();
        return;

      case 'undo': {
        // Undo is not a continuation of whatever gesture preceded it: without
        // this, resuming a drag afterwards would rewrite the entry just stepped
        // back to (`selection_commands.py:176-177`).
        this.history.breakCoalescing();
        // Captured BEFORE `setProject`, because that is what the rule is
        // compared against -- `this.project` is the new state immediately after.
        const before = this.project;
        // BEFORE the cursor moves, and that is the whole subtlety of undo's
        // label: the entry being TAKEN BACK is the one at the current cursor,
        // and `undo()` steps off it. Reading afterwards would name the step
        // before the one just undone.
        const undone = this.history.undoLabel();
        const previous = this.history.undo();
        // Only when a step actually happened: undo at the end of the timeline
        // returns null and changes nothing, and restarting the simulation on a
        // keypress that did nothing would be the most confusing reset of all.
        if (previous !== null) {
          this.notify(describeHistoryStep('undo', undone));
          this.setProject(previous);
          this.resetForUndoRedo();
          // Undoing a rule adoption or a reroll gives the particles a target
          // rule they were not obeying a moment ago, which is a behavior change
          // like any other. `resetForUndoRedo` above is a different question
          // (its flag is about undo AS SUCH and is currently off), so both are
          // asked -- and `reset()` is idempotent, it only sets a sentinel, so
          // the frame where both say yes still resets exactly once.
          this.resetIfRuleChanged(before, previous);
        }
        return;
      }

      case 'redo': {
        this.history.breakCoalescing();
        const before = this.project;
        // Also before the move, but for the opposite reason to undo's: the entry
        // redo APPLIES is the one ahead of the cursor, and `redoLabel` reads
        // `cursorIndex + 1` to name it. See its docstring for why the two are
        // not mirror images.
        const redone = this.history.redoLabel();
        const next = this.history.redo();
        if (next !== null) {
          this.notify(describeHistoryStep('redo', redone));
          this.setProject(next);
          this.resetForUndoRedo();
          // Redo re-applies the rule change undo just took away, so it is a
          // behavior change by the same argument. See the undo case above.
          this.resetIfRuleChanged(before, next);
        }
        return;
      }

      case 'nextPreset':
      case 'prevPreset': {
        const delta = command.kind === 'nextPreset' ? 1 : -1;
        const moved = switchPreset(this.catalog, this.presetIndex + delta);
        if (moved === null) return;
        this.presetIndex = moved.index;
        this.adoptPreset(moved.name);
        return;
      }

      case 'loadPreset': {
        const index = this.catalog.order.indexOf(command.name);
        if (index < 0) {
          console.warn(`No preset "${command.name}".`);
          return;
        }
        this.presetIndex = index;
        this.adoptPreset(command.name);
        return;
      }

      case 'loadConfig':
        this.loadConfig(command.category, command.name);
        return;

      case 'previewConfig':
        this.previewConfig(command.category, command.name, command.surface);
        return;

      case 'deleteConfig':
        this.deleteConfig(command.category, command.name);
        return;

      case 'revertConfig':
        // Reload from wherever the project came from, discarding unsaved edits.
        // Silently ignored with no origin, which is what `canRevert` reports --
        // there is nothing to revert TO before the first load or save.
        if (this.configOrigin !== null) {
          this.loadConfig(this.configOrigin.category, this.configOrigin.name);
        }
        return;

      case 'saveConfig':
        this.saveConfig(command.name);
        return;

      case 'loadSharedConfig':
        this.loadSharedConfig(command.saved, command.name);
        return;

      case 'clearSaveError':
        // Dispatched when the save dialog OPENS. The dialog renders `saveError`
        // from status every frame -- it must not read it once, right after
        // dispatch -- so without this a previous failure would greet the user
        // again on a fresh dialog.
        this.saveError = '';
        return;

      case 'setCheckpoint': {
        // `capture` NAMES the checkpoint (`<project><NN>`), and that name is how
        // the user finds it again in the Checkpoints menu -- so the toast says
        // it rather than announcing a bare "Checkpoint set". Taking the return
        // value is what makes the message and the menu entry agree by
        // construction instead of by a second call to `nameFor`.
        //
        // `notify`, NOT `notifyBehavior`: nothing about the particles changed
        // and nothing was recorded to history, so there is no undo step for a
        // behaviour label to describe. See `describeCheckpointSet`.
        const checkpoint = this.checkpoints.capture(this.project);
        this.notify(describeCheckpointSet(checkpoint.name));
        return;
      }

      case 'deleteCheckpoint':
        this.checkpoints.remove(command.key);
        return;

      case 'loadCheckpoint': {
        const checkpoint = this.checkpoints.byKey(command.key);
        if (checkpoint === null) return;
        this.commitCheckpoint(checkpoint);
        return;
      }

      case 'loadLatestCheckpoint': {
        const latest = this.checkpoints.latest();
        if (latest === null) return;
        this.commitCheckpoint(latest);
        return;
      }

      case 'clipboardApply': {
        // Hover-preview of a checkpoint; the committed load records instead.
        const checkpoint = this.checkpoints.byKey(command.key);
        if (checkpoint === null) return;
        this.setProject(checkpoint.project);
        // The hover is the load here too, exactly as in `previewConfig`.
        this.resetForConfig();
        return;
      }

      case 'snapshotConfigs':
        // Remember where THIS SURFACE's browsing started, so a committed load
        // records against it rather than against whatever preview happened to
        // be showing.
        //
        // A Project IS the snapshot: immutable, so holding a reference is
        // enough (`project_commands.py:175-191`).
        //
        // Idempotent within a session, matching `PreviewSession.begin()`: a
        // re-open with no intervening close must not overwrite the origin with
        // a previewed state.
        if (!this.previewOrigins.has(command.surface)) {
          this.previewOrigins.set(command.surface, this.project);
        }
        // OPENING THE MENU ENDS ANY AIM, before a single row has been hovered.
        // `resetForConfig` covers every path that actually swaps a config, but
        // that first fires when the pointer reaches a row -- and a cohort lit
        // behind an open Load menu is already meaningless: the user has left the
        // canvas to go somewhere else, and whatever they pick will replace the
        // rules the aim was pointing at. Clearing on open rather than on the
        // first hover also means abandoning the menu without touching anything
        // leaves the highlight off, which matches "entering the menu cancels".
        //
        // Deliberately NOT restored by `restoreConfigs`: an aim is a gesture in
        // progress, not part of the config state a snapshot puts back.
        this.clearHighlight();
        return;

      case 'restoreConfigs': {
        // The other half of hover-preview; likewise never recorded. Restores
        // only THIS surface's origin -- another open browser keeps its own.
        const origin = this.previewOrigins.get(command.surface);
        // Restoring is itself a config change, so it resets too: abandoning the
        // menu would otherwise leave the ORIGINAL config's settings running on
        // whatever state the last preview's simulation had evolved into. Only
        // when a preview actually applied -- closing a menu never hovered
        // changes nothing and must not restart anything.
        if (origin !== undefined) {
          this.setProject(origin);
          this.resetForConfig();
        }
        this.previewOrigins.delete(command.surface);
        return;
      }

      case 'editSetting': {
        const before = this.project;
        const result = applySettingEdit(
          { project: this.project, prefs: this.prefs },
          command.setting,
          command.value,
        );
        if (result.kind === 'prefs') {
          this.adoptPreferences(result.prefs);
          return;
        }
        this.setProject(result.project);
        if (command.record !== false) {
          // Key on source+field: moving to a different slider ends the gesture,
          // as does pausing longer than the coalesce window.
          this.recordHistory(
            before,
            `edit ${command.setting.label}`,
            `${command.setting.source}:${command.setting.field}`,
          );
        }
        return;
      }

      case 'randomizeSeed': {
        // **WITH A GENERATED RULE, THIS IS RANDOMIZE BEHAVIOR** -- not merely
        // similar to it, the same act. The shader seeds its generator from
        // `mutationSeed`, so moving the seed regenerates the behaviour outright;
        // "reroll the mutations" names an operation on an authored rule that is
        // not there. The two commands collapse to one thing on the backend, so
        // the honest UI is to stop offering the misleading one: the bar and the
        // Simulation menu grey Reroll in this state, and `F` becomes a second
        // key for Randomize Behavior -- which is what the wide Reroll All
        // Behavior button already implies by naming `F` beside `B`.
        //
        // FALLING THROUGH TO THE CASE rather than duplicating its body is the
        // point: the toast, the undo entry and the reset are then identical by
        // construction. A copy here would be a second place for "randomize
        // behavior" to drift from the command that actually means it, and the
        // undo stack would fill with a step whose label disagreed with what the
        // key did.
        if (ruleIsGeneratedOnGpu(this.project)) return this.randomizeBehavior();

        // INERT AT MUTATION SCALE 0, so `F` does nothing there -- matching the
        // greyed Reroll button on the bar and the greyed Simulation menu row,
        // which is the point: a key that works while its own on-screen twin is
        // greyed teaches that the greying is a lie.
        //
        // `mutate_rule` scales both its terms by `amount` (see
        // `selectionIsNoOp`), so at 0 every cohort obeys the base rule and a new
        // seed selects a variation that is multiplied away. Pressing on would
        // move the seed and dirty the document while changing nothing visible.
        //
        // The sentinel never reaches this line -- it returned above -- so the
        // exception `rerollIsNoOp` carries is already spent by the time it is
        // asked. It is still the right predicate: it states the whole condition
        // in one place, and the UI greys on exactly it.
        if (rerollIsNoOp(this.project)) return;

        const before = this.project;
        const next = randomizeSeed(this.project);
        if (next === null) return;
        this.setProject(next);
        // No coalesce key: a button press is a discrete act, not a gesture to
        // merge, so three presses give three undo steps. `notifyBehavior`
        // supplies the label from the event, which RENAMES the stored step from
        // `randomize mutation seed` to `reroll mutations` -- deliberately: the
        // control the user pressed says "Reroll Mutations", and the undo entry
        // should name what they did rather than the field it moved.
        this.notifyBehavior(before, { kind: 'randomizeSeed' });
        // Every cohort re-mutates around a new seed, so every particle is now
        // chasing a different target -- and a cohort lit against the old seed
        // names a behaviour nothing is running. AFTER `setProject`, per
        // `resetForBehavior`.
        this.behaviorChangedElsewhere();
        return;
      }

      case 'randomizeBehavior':
        return this.randomizeBehavior();

      case 'setPopulationLayout': {
        const before = this.project;
        this.setProject(setPopulationLayout(this.project, command.cohorts));
        // One entry for both fields, and no coalesce key: a button press is a
        // discrete act, so two presses give two undo steps.
        this.recordHistory(before, 'set population layout');
        // Part of the act, not a separate one. Initial conditions only take
        // effect on a restart, so without this the layout the button promises
        // would not appear until something else happened to reset.
        this.system.reset();
        return;
      }

      case 'editDrawPref':
        // Drawing controls are PREFS: editor state, saved but never recorded in
        // history -- loading someone else's config must not resize your brush,
        // and there is no project state for undo to restore.
        //
        // Skips the rebuild check that `editSetting` runs, because no drawing
        // preference is disruptive (`drawing_commands.py:107-110`).
        this.adoptPreferences(withValue(this.prefs, command.field, command.value), false);
        return;

      case 'editViewPref':
        // A view mode: which controls a panel shows, not what any of them hold.
        // Persisted like every other preference -- and like `editDrawPref`,
        // never recorded in history and never rebuilding, because no tier is
        // disruptive and undo has no project state to restore.
        this.adoptPreferences(withValue(this.prefs, command.field, command.value), false);
        return;

      case 'resetPreferences':
        // **`allowRebuild` STAYS TRUE**, unlike the two cases above. This is the
        // one preference command that can move World Size or Canvas Aspect, and
        // those reallocate the entity buffer and the canvas -- so `false` here
        // would leave a live simulation running at the OLD size with the panel
        // reporting the new one, which is the exact divergence `requiresRestart`
        // exists to prevent. `adoptPreferences` decides whether a rebuild is
        // actually needed, so a reset that changed neither is still free.
        //
        // The project is untouched: `rebuildSystem` carries it over, so a reset
        // that does rebuild keeps your unsaved edits.
        this.adoptPreferences(DEFAULT_PREFERENCES);
        return;

      case 'clearStrafeField':
        // THE ONLY RESET the field has, and deliberately NOT in the undo
        // timeline: it is live-only state that never survives a restart either,
        // and History is a timeline of Projects rather than of mixed state it
        // was never designed to hold. The desktop labels the button "(not
        // undoable)" for the same reason.
        //
        // Flagged rather than done, because zeroing a texture is a render pass
        // and a render pass needs an encoder, which a command handler has not
        // got. The frame loop consumes this above its paused branch, so clearing
        // works while paused.
        this.clearFieldPending = true;
        return;

      default: {
        // Exhaustiveness. Adding a Command member without a case above fails
        // HERE, at compile time, rather than as a silently ignored click.
        const unreachable: never = command;
        throw new Error(`unhandled command: ${JSON.stringify(unreachable)}`);
      }
    }
  }

  // =========================================================================
  // Storage
  //
  // Every handler here is FIRE-AND-FORGET: it starts async work, returns
  // immediately, and reports through `Status`, which the panel reads every
  // frame. `dispatch` stays `void` -- making it async would turn every button
  // click into a promise the caller has to handle, for no gain.
  //
  // Three properties every one of them keeps:
  //
  //  1. `configBusy` is cleared in BOTH arms. A rejected promise that left the
  //     panel saying "Saving..." forever is the failure mode, and it is the
  //     async analogue of `thinPanel.ts`'s `try`/`finally` around `refreshing`.
  //  2. A GENERATION GUARD on anything that adopts a project. A load resolving
  //     after the user already loaded something else would otherwise clobber the
  //     newer project with the older one.
  //  3. Errors land in `saveError`, never thrown. A preset deleted in another
  //     tab, a denied database, a corrupt file -- none of them should take the
  //     app down.
  // =========================================================================

  /** Look an entry up, reporting through `saveError` rather than throwing. */
  private resolveEntry(category: string, name: string): ConfigEntry | null {
    const entry = this.store.entry(category, name);
    if (entry === null) {
      this.saveError = `No config "${name}" in ${category}.`;
    }
    return entry;
  }

  /** Adopt a loaded config, recording one undoable entry. Shared by load paths. */
  private adoptSaved(
    entry: ConfigEntry,
    saved: Awaited<ReturnType<ConfigStore['read']>>,
  ): void {
    const before = this.prePreviewProject(this.project);
    // READ BEFORE THE CLEAR BELOW. A browse in flight means the config being
    // committed is already on screen and already running on a simulation the
    // preview restarted, which is exactly the case that must NOT reset again.
    const previewed = this.previewOrigins.size > 0;
    this.setProject(loadSavedInto(this.project, entry.name, saved));
    // Announced AND recorded together, so the toast shown now and the toast
    // shown when this is undone describe one act. See `notifyBehavior`.
    this.notifyBehavior(before, { kind: 'loadPreset', name: entry.name });
    // A commit ends EVERY browse, not just the one that produced it: the loaded
    // project is now the state, so no surface has anything left to restore to.
    // Leaving another surface's origin behind would let its close event undo the
    // load the user just committed.
    this.previewOrigins.clear();
    this.presetName = entry.name;
    this.presetIndex = Math.max(0, this.catalog.order.indexOf(entry.name));
    this.configOrigin = { category: entry.category, name: entry.name };
    // NO CAMERA. Loading a config leaves the view exactly where it was, on every
    // path -- committed load, preview, and the LEFT/RIGHT cycle alike.
    //
    // AND NO RESET, when the commit follows a hover-preview: the preview
    // already applied this config and already restarted the simulation for it,
    // so the click that closes the menu must leave the running sim alone.
    // `resetIfUnpreviewed` is what tells the two cases apart -- the LEFT/RIGHT
    // cycle and Revert reach here with no preview in flight and DO restart.
    this.resetIfUnpreviewed(previewed);
  }

  /**
   * Adopt a project that came off a share link, mid-session.
   *
   * SYNCHRONOUS, unlike every other load here: the bytes already arrived with
   * the command, so there is no store to read, no promise to guard and no
   * generation to check. The whole async apparatus above exists for storage,
   * and a link is not storage.
   *
   * `configOrigin` is CLEARED rather than left alone. Whatever the project used
   * to come from, it is not where this came from -- leaving the old origin would
   * point "Revert to Saved" at a file that has nothing to do with what is now on
   * screen, which is worse than the row being greyed out.
   */
  private loadSharedConfig(saved: SavedConfig, name: string): void {
    const before = this.prePreviewProject(this.project);
    this.setProject(loadSavedInto(this.project, name, saved));
    // Undoable, because this REPLACED live work. The startup path deliberately
    // does not record one -- see the `loadSharedConfig` command's comment.
    this.notifyBehavior(before, { kind: 'loadSharedLink' });
    this.previewOrigins.clear();
    this.presetName = name;
    this.configOrigin = null;
    this.saveError = '';
    this.resetForConfig();
  }

  /** Commit a load: settings, world, name, camera, and one history entry. */
  private loadConfig(category: string, name: string): void {
    const entry = this.resolveEntry(category, name);
    if (entry === null) return;

    const generation = ++this.configGeneration;
    this.configBusy = `Loading ${name}…`;
    void this.store
      .read(entry)
      .then((saved) => {
        if (generation !== this.configGeneration) return; // superseded
        this.configBusy = '';
        this.saveError = '';
        this.adoptSaved(entry, saved);
      })
      .catch((e: unknown) => {
        if (generation !== this.configGeneration) return;
        this.configBusy = '';
        this.saveError = `Could not load ${name}: ${String(e)}`;
      });
  }

  /**
   * Apply a config for hover-preview: settings only.
   *
   * NO CAMERA AND NO HISTORY, deliberately (`project_commands.py:161-165`):
   * browsing forty configs would otherwise leave forty undo entries and jump the
   * view forty times.
   *
   * Takes a snapshot if none is open, so hovering without a prior
   * `snapshotConfigs` still restores -- the desktop's menu always pairs them,
   * but nothing here enforces that ordering.
   */
  private previewConfig(
    category: string,
    name: string,
    surface: PreviewSurface,
  ): void {
    const entry = this.resolveEntry(category, name);
    if (entry === null) return;
    if (!this.previewOrigins.has(surface)) {
      this.previewOrigins.set(surface, this.project);
    }

    const generation = ++this.configGeneration;
    void this.store
      .read(entry)
      .then((saved) => {
        if (generation !== this.configGeneration) return;
        this.setProject(loadSavedInto(this.project, entry.name, saved));
        // THE HOVER IS THE LOAD, so this is where a config gets its opening
        // conditions. Inside the generation guard deliberately: a superseded
        // read must not restart the simulation the newer preview is running.
        this.resetForConfig();
      })
      .catch((e: unknown) => {
        // Only warned: a preview that fails should not put an error banner up
        // while the user is merely moving the mouse across a menu.
        console.warn(`Failed to preview ${name}: ${String(e)}`);
      });
  }

  /** Delete a saved config. Shipped presets are refused by the store. */
  private deleteConfig(category: string, name: string): void {
    const entry = this.resolveEntry(category, name);
    if (entry === null) return;

    this.configBusy = `Deleting ${name}…`;
    void this.store
      .remove(entry)
      .then(() => {
        this.configBusy = '';
        this.saveError = '';
        this.refreshCatalog();
        // The project keeps its contents and its name; only its ORIGIN is gone,
        // so Revert has nothing to go back to. Matching the desktop, which
        // leaves the live project alone when its file is deleted.
        if (
          this.configOrigin?.category === category &&
          this.configOrigin.name === name
        ) {
          this.configOrigin = null;
        }
      })
      .catch((e: unknown) => {
        this.configBusy = '';
        this.saveError = `Could not delete ${name}: ${String(e)}`;
      });
  }

  /**
   * Write the project to storage under "Custom".
   *
   * ALWAYS SAVES THE WHOLE CONFIG BUFFER, matching `_cmd_save_config`
   * (`project_commands.py:105-133`): saving only the selected slot was removed
   * there because it silently dropped the others.
   *
   * RECORDS NO CAMERA, unlike the desktop. See `SavedConfig` in
   * `persistence.ts` -- the view is not part of a project.
   *
   * Overwrites silently, also matching the desktop. Any "are you sure" belongs
   * in the UI, where the user can see what they are replacing.
   */
  private saveConfig(name: string): void {
    this.saveError = '';
    const safe = sanitizeName(name);
    if (safe === '') {
      // The empty-after-sanitize case `sanitizeName` warns about: a name with no
      // usable characters would be written under an empty key and be unreachable.
      this.saveError = 'That name has no usable characters.';
      return;
    }
    if (!this.store.writable) {
      this.saveError = 'Saving is unavailable: this browser denied local storage.';
      return;
    }

    const document = toDocument(this.project.configs, this.project.world);
    this.configBusy = `Saving ${safe}…`;
    void this.store
      .write(CUSTOM_CATEGORY, safe, document)
      .then(() => {
        this.configBusy = '';
        this.saveError = '';
        this.project = renamed(this.project, safe);
        this.presetName = safe;
        this.configOrigin = { category: CUSTOM_CATEGORY, name: safe };
        this.refreshCatalog();
      })
      .catch((e: unknown) => {
        this.configBusy = '';
        this.saveError = `Could not save ${safe}: ${String(e)}`;
      });
  }

  /** Re-read the catalog after a write or a delete, keeping the cycle in step. */
  private refreshCatalog(): void {
    this.catalog = this.store.catalog();
    this.presetIndex = Math.max(0, this.catalog.order.indexOf(this.presetName));
  }

  // THE CAMERA IS NOT PART OF A PROJECT. `cameraDocument` and `applySavedCamera`
  // used to live here, writing the view into every save and snapping to it on
  // every load. Where you were looking is not a property of the simulation, and
  // carrying it meant you could not compare two presets without being thrown
  // across the world between them. See `SavedConfig` in `persistence.ts`.
  //
  // This also ends the LEFT/RIGHT view-jump: the cycle reaches loads through
  // `adoptPreset` -> `loadConfig` -> `adoptSaved`, so it moved the camera too,
  // despite two comments here claiming the camera moved only on a committed
  // load. It never did what they said.

  /** Load a config by name from anywhere in the catalog, for the LEFT/RIGHT cycle. */
  private adoptPreset(name: string): void {
    const entry = this.store.entryByName(name);
    if (entry === null) {
      this.saveError = `No config "${name}".`;
      return;
    }
    this.loadConfig(entry.category, entry.name);
  }

  /** Commit a checkpoint restore, recording against where browsing started. */
  private commitCheckpoint(checkpoint: Checkpoint): void {
    const before = this.prePreviewProject(this.project);
    // Before the clear below, for the reason `adoptSaved` gives.
    const previewed = this.previewOrigins.size > 0;
    this.setProject(checkpoint.project);
    this.notifyBehavior(before, { kind: 'loadCheckpoint', name: checkpoint.name });
    // Ends every browse, for the reason `adoptSaved` gives.
    this.previewOrigins.clear();
    // Clicking a hovered checkpoint locks in what is already running; the
    // keyboard shortcut for the latest checkpoint arrives with no hover and
    // does restart. Same split as `adoptSaved`.
    this.resetIfUnpreviewed(previewed);
  }

  /**
   * Adopt edited preferences, persisting them and rebuilding if required.
   *
   * `withValue` returns the RECEIVER when nothing changed, so the `===` guard
   * here is what stops a slider reporting an unmoved value from writing to
   * `localStorage` every frame -- the same early-out
   * `drawing_commands.py:113-114` needs, for the same reason.
   *
   * RETURNS THE REBUILD, so a caller that has work to do AFTER the new system
   * exists can order itself against it (`commitCalibration` resets the
   * simulation, and must reset the incoming one rather than the outgoing one).
   * Every other caller ignores it and is unaffected: the rebuild still runs
   * detached, and the command handlers stay synchronous.
   */
  private adoptPreferences(updated: Preferences, allowRebuild = true): Promise<void> {
    if (updated === this.prefs) return Promise.resolve();
    const needsRebuild = allowRebuild && requiresRestart(this.prefs, updated);
    // Switching to one-click selection abandons any aim in progress. The
    // `highlightEnabled` gate already makes a lit cohort inert -- it stops
    // reaching the shader and stops changing what a click means -- so this is
    // about the STATE rather than the behaviour: leaving it lit would mean
    // turning the preference back off silently re-armed a confirming click
    // from before, and the first click after that would commit something the
    // user aimed at minutes ago.
    if (updated.oneClickSelection && !this.prefs.oneClickSelection) {
      this.clearHighlight();
    }
    this.prefs = updated;
    savePreferences(this.prefs);
    return needsRebuild ? this.rebuildSystem() : Promise.resolve();
  }

  /**
   * Rebuild after a disruptive preference change, preserving the project.
   *
   * The simulation restarts -- inherent to reallocating the entity buffer --
   * but the live project carries over, so a world-size change does not discard
   * edits. Deliberately does not reload from the preset: the in-memory configs
   * may contain unsaved edits (`project_commands.py:45-69`).
   *
   * Async where the desktop's is synchronous, because pipeline compilation is.
   * The replacement is built BEFORE the old one is dropped, so a failed compile
   * leaves the app running on what it had rather than on nothing -- the
   * desktop's `_rebuild_system` can assign directly because its
   * `ParticleSystem(...)` either returns or raises.
   *
   * THE SYSTEM AND THE FIELD ARE REPLACED TOGETHER, because the field is sized
   * from the canvas: a new canvas needs a new field, or its uv mapping would
   * silently skew against the new shape. That pairing is also what lets
   * `setStrafeField` be a build-time call rather than a live-swap -- the field a
   * system was built with is the only one it ever sees.
   *
   * Nothing is reassigned or destroyed until BOTH replacements exist, so a
   * failed compile anywhere above leaves the app running on what it had.
   */
  private async rebuildSystem(): Promise<void> {
    const [entityCount, dim] = sizingFor(this.prefs.worldSize);
    const config = selectedConfig(this.project);
    const replacement = await ParticleSystem.create({
      device: this.device,
      config,
      world: this.project.world,
      canvasSize: canvasDimensions(this.prefs.canvasAspect, dim),
      entityCount,
      physicsSteps: this.prefs.physicsSteps,
    });
    const replacementField = await StrafeField.create(
      this.device,
      replacement.canvasSize,
    );
    replacementField.setWrap(this.project.world.boundaryConditions === BC.WRAP);
    replacement.setStrafeField(replacementField.view(), replacementField.size);
    replacement.applyProject(this.project.configs, this.project.world);

    const outgoingSystem = this.system;
    const outgoingField = this.strafeField;
    this.system = replacement;
    this.strafeField = replacementField;
    this.assembler.setStrafeField(replacementField.view());

    // End the stroke in progress: `strokePrevUv` holds a uv in the OLD field's
    // space, and the first segment after a rebuild would streak from a stale
    // coordinate (`project_commands.py:69` calls `_end_stroke()` for this).
    this.strokePrevUv = null;
    this.pendingStroke = null;

    // AND THE HIGHLIGHT. The entity count changed, so `get_cohort` divides by a
    // different number -- the cohort index that was lit does not name the same
    // particles any more, and a confirming click against it would commit
    // something the user never aimed at.
    this.clearHighlight();

    // DROPPING THE REFERENCES IS NOT ENOUGH -- GPU memory is not GC'd. ~19 MB of
    // entity buffer per rebuild at 600k entities, plus the field's texture.
    // Destroyed last, so nothing above can throw between the swap and the free.
    outgoingSystem.destroy();
    outgoingField.destroy();
  }

  // =========================================================================
  // Status
  // =========================================================================

  /**
   * Push read-only status to the UI (invariant 10).
   *
   * Supplies EVERY member of `Status`, every frame. That totality is what lets
   * UI code read `status.preset` rather than defending itself with a fallback:
   * a missing key means the Orchestrator forgot one, which is a bug worth
   * hearing about. Here the compiler enforces it rather than a comment.
   */
  status(): Status {
    const cam = this.camera.state;
    const windowSize = this.surface.size();
    const canvasSize = this.system.canvasSize;
    return {
      // Through the full inverse chain, so the readout accounts for pan, zoom
      // and letterboxing -- it is the world point actually under the cursor,
      // not an approximation.
      mouseWorld: screenToWorld(
        this.input.mousePos,
        windowSize,
        canvasSize,
        cam.pan,
        cam.zoom,
      ),
      camMode: cam.mode,
      camPan: cam.pan,
      camZoom: cam.zoom,
      canvasSize: `${canvasSize[0]}x${canvasSize[1]}`,
      windowSize: `${windowSize[0]}x${windowSize[1]}`,

      mouseMode: this.mouseMode,
      paused: this.paused,
      preset: this.presetName,
      entityCount: this.system.entityCount,
      frameCount: this.system.frameCount,
      // NOT inside `settingsSources()`: the mutation overlay reads this and
      // refreshes while the panel is shut, where that payload is empty. An
      // `.every()` over 80 floats is nothing next to the deep copy the
      // closed-panel early-out exists to avoid.
      ruleIsGenerated: ruleIsSentinel(this.project),
      // NOT inside `settingsSources()`, for the reason `ruleIsGenerated` is not:
      // the FPS counter reads this and stays on screen while the panels are
      // hidden, where that payload is empty. A bare boolean read costs nothing
      // next to the deep copy the closed-panel early-out exists to avoid.
      showFpsCounter: this.prefs.showFpsCounter,
      // THROUGH THE SAME GATE THE CLICKS AND THE SHADER USE, so the hint under
      // the slider can never advertise a highlight the clicks would not honour
      // -- with `oneClickSelection` on, or a single-cohort config, this reads
      // `NO_COHORT` and the UI shows the one-click wording instead.
      highlightedCohort: this.highlightEnabled ? this.highlight.cohort : NO_COHORT,
      highlightEnabled: this.highlightEnabled,
      cohortCount: selectedConfig(this.project).cohorts,
      // DRAINED, not read: this is an event on a snapshot, so leaving it set
      // would re-fire the same toast every frame. See `Status.notice`.
      notice: this.takeNotice(),
      selectionIsNoOp: selectionIsNoOp(this.project),

      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      undoLabel: this.history.undoLabel(),
      historyDepth: this.history.depth,
      historyCursor: this.history.cursor,

      selected: this.selected,

      configCategories: this.catalog.categories,
      projectName: this.project.name,
      selectedConfig: this.project.selected,
      configCount: configCount(this.project),
      checkpoints: this.checkpoints.views(),
      canRevert: this.configOrigin !== null,
      canSave: this.store.writable,

      saveError: this.saveError,
      configBusy: this.configBusy,

      // Read from `prefs` directly, NOT from `settingsSources()` -- which is
      // empty while the panel is closed. See the `Status` field comments.
      advancedProject: this.prefs.advancedProject,
      advancedPreferences: this.prefs.advancedPreferences,
      advancedDrawing: this.prefs.advancedDrawing,

      ...this.settingsSources(),
    };
  }

  /**
   * The live project as a v8 document. See `CommandBus.projectDocument`.
   *
   * THE LIVE PROJECT, not `configOrigin` and not the last file read. This is
   * the same call `saveConfig` makes, and deliberately the same: a share link
   * and a save must produce identical bytes, or a link would restore something
   * its sender never had on screen. `this.project` is replaced wholesale on
   * every edit, so there is no window in which this is stale.
   *
   * NO NOTES, because a live `Project` has none -- `notes` exists on
   * `SavedConfig` with no field to hold it here, so `saveConfig` omits it too.
   * Symmetry, not an oversight.
   *
   * NO CAMERA, for the reason `SavedConfig` gives: where you were standing is
   * not a property of what you built.
   */
  projectDocument(): unknown {
    return toDocument(this.project.configs, this.project.world);
  }

  /**
   * The three settings payloads, built only when something reads them.
   *
   * Copying `editConfig` deep-copies the 80-float rule. Doing that every frame
   * for a closed panel is pure garbage; with the panel shut this returns a
   * shared empty payload instead, exactly as `_settings_dicts` does
   * (`orchestrator.py:590-604`).
   *
   * **`X` DOES NOT HIDE EVERYTHING, AND THAT IS WHY THE EARLY-OUT IS NOT
   * UNCONDITIONAL.** The mutation overlay deliberately opts out of the hide
   * (`mutationOverlay.setHidden` changes no visibility -- it only colours the
   * gear, because the bar is the picture's own controls and pressing `X` for a
   * clean view must not also take away the one slider worth reaching for while
   * watching). It reads `mutationScale` out of
   * `editConfig` every frame, so returning the empty payload while it is still
   * on screen freezes it: `refresh` finds no number, keeps whatever the slider
   * last showed, and the bar then disagrees with the config until something
   * opens the panel again.
   *
   * That looked like an intermittent bug -- the slider goes stale after a load,
   * but only if the panels happened to be hidden at the time -- which is a much
   * harder thing to notice than a slider that is always wrong. `panel.ts`
   * already refreshes the overlay ABOVE its own hidden check for exactly this
   * reason; this is the other half, on the data side.
   *
   * So the early-out now skips only the EXPENSIVE part. `editConfig` still
   * costs a shallow copy per frame, which is what the overlay needs and is not
   * what the comment above was worried about -- the 80-float `rule` is excluded
   * either way.
   */
  private settingsSources(): Pick<Status, 'editConfig' | 'editWorld' | 'editPrefs'> {
    const config = selectedConfig(this.project);
    if (!this.panelOpen) {
      return {
        // The overlay's slice, and only it. `editWorld` and `editPrefs` have no
        // reader outside the panel, so they stay empty.
        editConfig: asRecord(config, ['rule']),
        editWorld: NO_SETTINGS.editWorld,
        editPrefs: NO_SETTINGS.editPrefs,
      };
    }
    return {
      // `rule` is excluded: it is 80 floats no control reads, and it is the
      // whole reason the closed-panel early-out above exists.
      editConfig: asRecord(config, ['rule']),
      editWorld: asRecord(this.project.world),
      editPrefs: asRecord(this.prefs),
    };
  }

  // =========================================================================
  // Accessors for the frame driver and the debug readout
  // =========================================================================

  /** Diagnostics only -- `main.ts`'s `?debug` overlay. */
  get diagnostics(): {
    readonly preset: string;
    readonly camMode: string;
    readonly frameCount: number;
    readonly entityCount: number;
    readonly canvasSize: readonly [number, number];
    readonly physicsSteps: number;
    readonly motionBlurSamples: number;
    readonly paused: boolean;
    readonly bloomEnabled: boolean;
    readonly selected: PickResult | null;
    readonly pickPending: boolean;
    readonly mouseMode: MouseMode;
    /**
     * Whether the recording crop box is being drawn.
     *
     * On `diagnostics` rather than `Status` because it is exactly what this
     * getter is for: a readout of what the renderer is doing, for the `?debug`
     * overlay and the verification tools. `Status` drives CONTROLS, and no
     * control binds to this -- the box's visibility is decided from the panel's
     * own tab state (`Panel.syncCropPreview`), so putting it there would invite
     * something to bind to a value that is downstream of the UI rather than
     * upstream of it.
     */
    readonly cropVisible: boolean;
  } {
    return {
      preset: this.presetName,
      camMode: this.camera.state.mode,
      frameCount: this.system.frameCount,
      entityCount: this.system.entityCount,
      canvasSize: this.system.canvasSize,
      physicsSteps: this.system.physicsSteps,
      motionBlurSamples: this.prefs.motionBlurSamples,
      paused: this.paused,
      bloomEnabled: this.prefs.bloomEnabled,
      selected: this.selected,
      pickPending: this.system.pickPending,
      mouseMode: this.mouseMode,
      // The same getter the frame path uses, so this reports what is actually
      // drawn rather than a second opinion about it.
      cropVisible: this.cropOverlay !== null,
    };
  }

  /**
   * The blur schedule this frame would resolve to. Diagnostics only.
   *
   * Through `frameSchedule()` rather than reading the preferences directly, so
   * the overlay reports what is ACTUALLY rendering. While a recording overrides
   * the rate, a readout sourced from `this.prefs` would show the editor's
   * numbers -- disagreeing with the picture at precisely the moment someone is
   * looking at the overlay to check what their export is doing.
   */
  currentSchedule(): { samples: number; stride: number } {
    return this.frameSchedule().schedule;
  }

  pipelineStatus(): Readonly<Record<string, boolean>> {
    return {
      ...this.system.pipelineStatus(),
      ...this.strafeField.pipelineStatus(),
      ...this.camera.pipelineStatus(),
      ...this.assembler.pipelineStatus(),
    };
  }

  /** The camera, for `main.ts`'s startup URL overrides only. */
  get cameraState(): CameraState {
    return this.camera.state;
  }

  /** Current preferences, for the panel to render. Immutable. */
  get preferences(): Preferences {
    return this.prefs;
  }

  // =========================================================================
  // First-run calibration
  //
  // Three narrow methods `calibration/calibrate.ts` drives, and nothing else
  // calls. They exist because calibration needs two things the normal
  // preference path deliberately does not offer: settings that change WITHOUT
  // being persisted, and a frame that runs WHILE PAUSED.
  // =========================================================================

  /**
   * Move to a rung's settings without persisting them.
   *
   * **THE POINT IS THAT IT DOES NOT SAVE.** `adoptPreferences` writes to
   * `localStorage` on every change, and a ladder that walked seven rungs
   * through it would leave whichever rung it happened to abort on as the
   * user's stored setting -- including a rung that FAILED. Calibration commits
   * exactly once, at the end, through the normal path; everything before that
   * is a measurement, not a decision.
   *
   * Rebuilds through `rebuildSystem` rather than reimplementing it, so probes
   * inherit its guarantees: the replacement is built before the old one is
   * dropped, the live project carries over, and the outgoing GPU resources are
   * destroyed rather than leaked. Seven rungs would otherwise leak up to seven
   * entity buffers.
   *
   * Only rebuilds when the world size actually moves. Physics rate is live --
   * `frame()` re-reads it every frame -- so half the rungs cost nothing but an
   * assignment.
   *
   * **RETURNS WHETHER IT REBUILT**, and the ladder needs to know. A rebuild
   * constructs a fresh `ParticleSystem` whose `_frameCount` starts at zero, and
   * zero is the reset sentinel every shader watches for (`reset()` at
   * `particleSystem.ts:800`): the next frames regenerate every entity's
   * position, velocity and rule, and clear the canvas. Those frames are far
   * more expensive than the steady state, so a rung measured across them reads
   * as unaffordable when it is not. A physics-only change keeps the same system
   * and its accumulated frame count, so it needs no such burn-in -- which is
   * the difference this return value carries.
   */
  async calibrateTo(worldSize: number, physicsSteps: number): Promise<boolean> {
    const needsRebuild = worldSize !== this.prefs.worldSize;
    this.prefs = Object.freeze({ ...this.prefs, worldSize, physicsSteps });
    if (needsRebuild) await this.rebuildSystem();
    return needsRebuild;
  }

  /**
   * Run and submit one physics frame, resolving when the GPU has finished it.
   *
   * **WHY NOT JUST TIME `frame()`.** Two reasons, either one fatal.
   *
   * The first is the pause. Calibration runs behind the welcome splash, and the
   * splash pauses the simulation -- a paused `frame()` takes the branch that
   * skips `runFrame` entirely and renders one still image. Timing that would
   * measure the camera, not the physics, and would report the same number for
   * every rung on the ladder.
   *
   * The second is that `performance.now()` around `frame()` measures nothing
   * useful even unpaused. WebGPU submission is asynchronous: `submit` queues a
   * command buffer and returns, so the wall time around it is CPU-side encoding
   * cost, which barely moves as the GPU load changes. That is fine for the
   * debug overlay's readout, which is all it was ever for, and useless as a
   * calibration signal. `onSubmittedWorkDone` is what actually waits for the
   * GPU.
   *
   * SO THIS IS A DELIBERATELY MINIMAL FRAME: physics only, no camera, no
   * assembler, no pick. That narrows what is being measured to the thing the
   * two knobs actually scale, and it is why `HEADROOM` exists to account for
   * everything left out.
   */
  async probeFrame(): Promise<void> {
    this.system.physicsSteps = Math.max(1, Math.trunc(this.prefs.physicsSteps));
    const encoder = this.device.createCommandEncoder({ label: 'calibration probe' });
    // No shove: `shoveState` needs an InputState, and a probe has no user input
    // to translate. `null` is the same thing a frame with no drag on it passes.
    this.system.runFrame(encoder, null);
    this.device.queue.submit([encoder.finish()]);
    await this.device.queue.onSubmittedWorkDone();
  }

  /**
   * Commit a calibration result through the normal preference path, and restart
   * the simulation on it.
   *
   * Goes through `adoptPreferences` so the result persists and any world-size
   * change rebuilds exactly as a hand-typed one would. `calibrated` rides along
   * in the same write, so a machine is never left with tuned settings it will
   * re-derive on the next load, nor with the flag set and the settings not.
   *
   * **THE RESET IS WHAT THE USER ACTUALLY SEES.** Probing advances the
   * simulation -- five frames per rung, at up to 20 sub-steps each, across
   * however many rungs the machine reached. Without this, the first picture
   * someone gets is a few hundred sub-steps of evolution that happened behind a
   * splash they were still reading, at world sizes that no longer apply, on a
   * canvas that was reallocated underneath it. A reset makes the run they watch
   * start where a run is supposed to start.
   *
   * LAST, AFTER THE REBUILD. `adoptPreferences` may replace the whole
   * `ParticleSystem`, and resetting the outgoing one would zero a frame counter
   * on an object about to be destroyed. `rebuildSystem` is async, so this is
   * ordered explicitly rather than by luck -- see below.
   */
  async commitCalibration(worldSize: number, physicsSteps: number): Promise<void> {
    const rebuild = this.adoptPreferences(
      Object.freeze({ ...this.prefs, worldSize, physicsSteps, calibrated: true }),
    );
    await rebuild;
    this.system.reset();
  }
}

/**
 * Empty payloads reused when no panel is open, so the closed case allocates
 * nothing for the sources nobody is reading. `orchestrator.py:588`'s
 * `_NO_SETTINGS`.
 *
 * **`editConfig` IS NOT AMONG THEM ANY MORE**, and that is not an oversight to
 * tidy up: the mutation overlay stays on screen when `X` hides the panels, and
 * it reads `mutationScale` out of `editConfig` every frame. Handing it an empty
 * record freezes the slider at whatever it last showed, so it disagrees with
 * the config until the panel is reopened -- an intermittent-looking staleness
 * that depends on whether the panels happened to be hidden. See
 * `settingsSources`, which still skips the two payloads that genuinely have no
 * reader outside the panel.
 */
/**
 * The radius that means CONFIRM MODE: search the highlighted cohort, worldwide.
 *
 * Negative is a SENTINEL, not a distance. `entityPick.wgsl` takes `abs()` for
 * the magnitude and reads the sign as "filter by cohort and ignore the radius"
 * -- see its `confirm_only`. One lane carries both facts, so there is no second
 * flag that could disagree with it.
 *
 * **THIS REPLACES A LARGE POSITIVE RADIUS, WHICH WAS SUBTLY WRONG.** Passing
 * 100 world units did reach every particle, and then quantized them all into
 * distance bucket 0 -- `dist_norm` is `distance / limit`. The key collapsed to
 * the raw index, `atomicMin` returned the lowest index in the world, and
 * `get_cohort` is monotonic in index, so the winner was always in a low-numbered
 * cohort: confirming cohort 20 silently re-aimed to cohort 12. Filtering is what
 * was wanted; distance was the wrong instrument.
 */
const CONFIRM_PICK_RADIUS = -1.0;

const NO_SETTINGS: Pick<Status, 'editWorld' | 'editPrefs'> = Object.freeze({
  editWorld: Object.freeze({}),
  editPrefs: Object.freeze({}),
});

/**
 * A settings source as a flat record of the primitives a control can bind to.
 *
 * The port of `dataclasses.asdict`, minus the deep copy: every value kept is a
 * number or a boolean, so there is nothing to copy deeply. Anything else --
 * `rule`, notably -- is dropped rather than serialized, because no control
 * binds to it and carrying it would reintroduce the per-frame cost the closed
 * panel early-out exists to avoid.
 */
function asRecord(
  source: object,
  exclude: readonly string[] = [],
): Readonly<Record<string, number | boolean>> {
  const out: Record<string, number | boolean> = {};
  for (const [key, value] of Object.entries(source)) {
    if (exclude.includes(key)) continue;
    if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}
