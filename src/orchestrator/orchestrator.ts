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
import { NO_OVERLAYS, type OverlayState } from '../assembler/assemblerUniforms.ts';
import { Camera } from '../camera/camera.ts';
import {
  CameraState,
  PAN_PER_SECOND,
  ZOOM_PER_SECOND,
} from '../camera/cameraState.ts';
import { blurSchedule, sampleAt } from '../camera/blurSchedule.ts';
import { ParticleSystem } from '../particleSystem/particleSystem.ts';
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
  selectedConfig,
} from '../project/project.ts';
import { History } from '../project/history.ts';
import { SelectionController, type SelectionHost } from '../selection/selection.ts';
import { type InputState, EMPTY_INPUT } from '../ui/inputState.ts';
import {
  type Command,
  type CommandBus,
  type MouseMode,
  type PreviewSurface,
  type Status,
} from './commands.ts';
import { type Checkpoint, CheckpointStore } from './clipboardCommands.ts';
import { type PendingStroke, strokeFor } from './drawingCommands.ts';
import { shoveState } from './shoveCommands.ts';
import {
  applySettingEdit,
  randomizeBehavior,
  randomizeSeed,
  ruleIsSentinel,
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

  /** This frame's input. Replaced once per frame by `frame()`. */
  private input: InputState = EMPTY_INPUT;

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
    this.selection.resolve();

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

    // Physics rate is a live preference, read each frame.
    this.system.physicsSteps = Math.max(1, Math.trunc(this.prefs.physicsSteps));

    // MOTION BLUR PUTS THE RENDER INSIDE THE PHYSICS LOOP. A displayed frame is
    // the average of `samples` renders taken `stride` sub-steps apart, so the
    // camera must see the simulation mid-advance rather than only at the end.
    //
    // PAUSED IS ONE SAMPLE OF A STILL IMAGE. Nothing moves, so there is nothing
    // for motion blur to average -- N samples of an unchanging scene is the
    // same picture at N times the cost (`orchestrator.py:301-304`).
    const schedule = this.paused
      ? { samples: 1, stride: 1 }
      : blurSchedule(this.system.physicsSteps, this.prefs.motionBlurSamples);
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

    this.device.queue.submit([encoder.finish()]);

    // AFTER submit, and it has to be: `mapAsync` may not be called while the
    // encoder that writes the buffer is still open. It resolves on a later
    // frame, which is what makes the whole path two-phase.
    this.system.beginPickReadback();
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
      if (state.leftPressed) this.selection.select(state.mousePos);
      // Right-click undoes, mirroring the desktop's binding.
      if (state.rightPressed) this.dispatch({ kind: 'undo' });
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

    if (!(brushing && this.prefs.showReticle)) {
      return { ...NO_OVERLAYS, showField };
    }
    // The brush's VISIBLE extent, which is 2 sigma of its gaussian -- and also
    // exactly the eraser's hard radius, so the ring reads as "what the eraser
    // will take". Measured in the aspect-corrected metric the brush shader
    // paints in, so what crosses this boundary is a plain scalar.
    return {
      ...NO_OVERLAYS,
      showField,
      reticleCenter: this.mouseFieldUv(this.input.mousePos),
      reticleRadius: 2.0 * this.prefs.drawSize,
      reticleDashed: shoving,
    };
  }

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
      requestPick: (pixel) => {
        const cam = this.camera.state;
        const windowSize = this.surface.size();
        const canvasSize = this.system.canvasSize;
        // The one place the pick inputs are built, so a dispatch and anything
        // reasoning about the same pick cannot disagree about where it was
        // aimed or how wide it searched (`selection_commands.py:76-95`).
        const target = screenToWorld(pixel, windowSize, canvasSize, cam.pan, cam.zoom);
        // Through the transform, not a fudge factor, so the tolerance is
        // exactly 40 screen pixels at any zoom.
        const radius = radiusPxToWorld(
          DEFAULT_PICK_RADIUS_PX,
          windowSize,
          canvasSize,
          cam.pan,
          cam.zoom,
        );
        this.system.requestPick(target, radius);
      },
      retrievePick: () => this.system.retrievePick(),
      isHit,
      currentProject: () => this.project,
      adoptRule: (p, result) => (result.rule === null ? p : adoptRule(p, result.rule)),
      setProject: (p) => {
        this.setProject(p);
      },
      recordHistory: (before, label) => {
        this.recordHistory(before, label);
      },
      setSelected: (result) => {
        this.selected = result;
      },
      describe: (result) => `select particle #${result.index}`,
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
    this.project = project;
    this.system.applyProject(project.configs, project.world);
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
  private recordHistory(before: Project, label: string, coalesceKey: string | null = null): void {
    if (before !== this.project) {
      this.history.record(before, this.project, label, coalesceKey);
    }
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

      case 'setMouseMode':
        // Switching tools abandons any stroke in progress (Step 9), so
        // releasing the button over a different tool cannot resume painting.
        this.mouseMode = command.mode;
        return;

      case 'undo': {
        // Undo is not a continuation of whatever gesture preceded it: without
        // this, resuming a drag afterwards would rewrite the entry just stepped
        // back to (`selection_commands.py:176-177`).
        this.history.breakCoalescing();
        const previous = this.history.undo();
        if (previous !== null) this.setProject(previous);
        return;
      }

      case 'redo': {
        this.history.breakCoalescing();
        const next = this.history.redo();
        if (next !== null) this.setProject(next);
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

      case 'setCheckpoint':
        this.checkpoints.capture(this.project);
        return;

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
        return;

      case 'restoreConfigs': {
        // The other half of hover-preview; likewise never recorded. Restores
        // only THIS surface's origin -- another open browser keeps its own.
        const origin = this.previewOrigins.get(command.surface);
        if (origin !== undefined) this.setProject(origin);
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
        const before = this.project;
        const next = randomizeSeed(this.project);
        if (next === null) return;
        this.setProject(next);
        // No coalesce key: a button press is a discrete act, not a gesture to
        // merge, so three presses give three undo steps.
        this.recordHistory(before, 'randomize mutation seed');
        return;
      }

      case 'randomizeBehavior': {
        const before = this.project;
        this.setProject(randomizeBehavior(this.project));
        this.recordHistory(before, 'randomize behavior');
        return;
      }

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
    this.setProject(loadSavedInto(this.project, entry.name, saved));
    this.recordHistory(before, `load ${entry.name}`);
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
    this.recordHistory(before, `load ${name}`);
    this.previewOrigins.clear();
    this.presetName = name;
    this.configOrigin = null;
    this.saveError = '';
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
    this.setProject(checkpoint.project);
    this.recordHistory(before, `restore ${checkpoint.name}`);
    // Ends every browse, for the reason `adoptSaved` gives.
    this.previewOrigins.clear();
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
   */
  private settingsSources(): Pick<Status, 'editConfig' | 'editWorld' | 'editPrefs'> {
    if (!this.panelOpen) return NO_SETTINGS;
    const config = selectedConfig(this.project);
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
    };
  }

  /** The blur schedule this frame would resolve to. Diagnostics only. */
  currentSchedule(): { samples: number; stride: number } {
    return this.paused
      ? { samples: 1, stride: 1 }
      : blurSchedule(this.system.physicsSteps, this.prefs.motionBlurSamples);
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
 * Empty payload reused when no panel is open, so the common case allocates
 * nothing at all. `orchestrator.py:588`'s `_NO_SETTINGS`.
 */
const NO_SETTINGS: Pick<Status, 'editConfig' | 'editWorld' | 'editPrefs'> = Object.freeze({
  editConfig: Object.freeze({}),
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
