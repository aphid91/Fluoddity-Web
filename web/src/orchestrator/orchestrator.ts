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
import { CameraState, PAN_PER_SECOND, ZOOM_PER_SECOND } from '../camera/cameraState.ts';
import { blurSchedule, sampleAt } from '../camera/blurSchedule.ts';
import { ParticleSystem } from '../particleSystem/particleSystem.ts';
import { screenToWorld, worldToUv } from '../particleSystem/coords.ts';
import {
  type PickResult,
  DEFAULT_PICK_RADIUS_PX,
  isHit,
  radiusPxToWorld,
} from '../particleSystem/pick.ts';
import { canvasDimensions, sizingFor } from '../particleSystem/sizing.ts';
import { defaultPreset, preset as presetByName, presetNames } from '../particleSystem/defaultConfig.ts';
import {
  type Preferences,
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
  selectedConfig,
} from '../project/project.ts';
import { History } from '../project/history.ts';
import { SelectionController, type SelectionHost } from '../selection/selection.ts';
import { type InputState, EMPTY_INPUT } from '../ui/inputState.ts';
import {
  type Command,
  type CommandBus,
  type MouseMode,
  type Status,
} from './commands.ts';
import { type Checkpoint, CheckpointStore } from './clipboardCommands.ts';
import { applySettingEdit, randomizeBehavior, randomizeSeed } from './settingsCommands.ts';
import {
  type PresetCatalog,
  buildCatalog,
  loadPresetInto,
  switchPreset,
} from './projectCommands.ts';

/** Everything `Orchestrator.create` needs. All GPU-adjacent, all injected. */
export interface OrchestratorOptions {
  readonly device: GPUDevice;
  readonly surface: Surface;
  /** Preset to open with. Defaults to the desktop's own default. */
  readonly presetName?: string;
  /** Overridden by tests and by `?prefs=default`; normally `localStorage`. */
  readonly preferences?: Preferences;
}

export class Orchestrator implements CommandBus {
  private readonly device: GPUDevice;
  private readonly surface: Surface;
  private readonly targets: RenderTargets;
  private readonly camera: Camera;
  private readonly assembler: Assembler;
  private system: ParticleSystem;

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
   * `null` when no browse session is open.
   */
  private previewOrigin: Project | null = null;

  /** The last clicked entity. `null` until the user selects something. */
  private selected: PickResult | null = null;

  /**
   * The active tool. SELECT by default -- it is the only tool whose effect is a
   * single undoable step, so a stray click on startup cannot smear the
   * simulation.
   */
  private mouseMode: MouseMode = 'select';

  /**
   * Whether the simulation is frozen. Pausing stops the physics AND (from
   * Step 9) the Shove tool, so a paused frame is genuinely untouchable; the
   * camera, the overlays and the whole UI stay live, so a frozen state can
   * still be navigated and inspected.
   */
  private paused = false;

  /** Transient UI message, surfaced through `status().saveError`. */
  private saveError = '';

  /** The shipped presets, grouped into load-menu categories. */
  private readonly catalog: PresetCatalog;
  private presetIndex = 0;
  private presetName: string;

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
    prefs: Preferences;
    project: Project;
    catalog: PresetCatalog;
    presetName: string;
  }) {
    this.device = opts.device;
    this.surface = opts.surface;
    this.targets = opts.targets;
    this.camera = opts.camera;
    this.assembler = opts.assembler;
    this.system = opts.system;
    this.prefs = opts.prefs;
    this.project = opts.project;
    this.catalog = opts.catalog;
    this.presetName = opts.presetName;
    this.presetIndex = Math.max(0, this.catalog.order.indexOf(opts.presetName));

    this.history.seed(this.project);
    this.selection = new SelectionController(this.selectionHost());
  }

  /**
   * Build the whole app. Async because every pipeline compile is.
   *
   * The desktop's `__init__` is synchronous and does this same wiring; the only
   * structural difference is that WGSL compilation returns promises, which is
   * why this is a static factory rather than a constructor.
   */
  static async create(opts: OrchestratorOptions): Promise<Orchestrator> {
    const prefs = opts.preferences ?? loadPreferences();

    const catalog = buildCatalog(presetNames());
    let presetName = opts.presetName ?? defaultPreset().name;
    let loaded;
    try {
      loaded = presetByName(presetName);
    } catch {
      console.warn(
        `No preset "${presetName}". Available: ${presetNames().join(', ')}. ` +
          `Falling back to ${defaultPreset().name}.`,
      );
      loaded = defaultPreset();
      presetName = loaded.name;
    }

    const [entityCount, dim] = sizingFor(prefs.worldSize);
    const system = await ParticleSystem.create({
      device: opts.device,
      config: loaded.config,
      world: loaded.world,
      canvasSize: canvasDimensions(prefs.canvasAspect, dim),
      entityCount,
      physicsSteps: prefs.physicsSteps,
    });

    const targets = new RenderTargets(opts.device);
    const camera = await Camera.create(opts.device, new CameraState(), targets);
    const assembler = await Assembler.create(opts.device, targets, opts.surface.format);

    const project = makeProject({
      configs: [loaded.config],
      world: loaded.world,
      name: presetName,
    });

    return new Orchestrator({
      device: opts.device,
      surface: opts.surface,
      targets,
      camera,
      assembler,
      system,
      prefs,
      project,
      catalog,
      presetName,
    });
  }

  // =========================================================================
  // The frame loop
  // =========================================================================

  /**
   * One frame. The port of `orchestrator.py:256-365`.
   *
   * THE ORDER IS THE CONTRACT. Four things about it are load-bearing and every
   * one of them has a comment at its site rather than only here:
   *
   *  1. The pending selection resolves FIRST, before input can dispatch a new
   *     pick -- there is one result slot, so a new dispatch clobbers the answer
   *     being read.
   *  2. That resolve is OUTSIDE the paused branch. `runFrame` is what a paused
   *     frame skips, and clicking to select must keep working when it is.
   *  3. Input is applied ABOVE the render, because painting (Step 9) binds its
   *     own target and would otherwise paint over the screen.
   *  4. The assembler presents AFTER the sub-step loop, because the camera
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
    // above, and the resolve at the top of the next frame reads it.

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

    if (this.paused) {
      // STILL ONE RENDER when paused: the camera has to draw the frozen state,
      // or the screen would go black. `runFrame` is what is skipped, not the
      // render (`orchestrator.py:318-322`).
      this.camera.render(encoder, frameState);
    } else {
      this.system.runFrame(encoder, null, (enc, step) => {
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
    }
    // SHOVE and DRAW claim the left button and do nothing with it until Step 9
    // builds the strafe field. The branch is absent rather than empty because
    // there is no fall-through here to guard against -- unlike the desktop,
    // where the `pass` exists so the branch below cannot pan the view out from
    // under a shove. Zoom below is navigation and runs in every tool anyway.

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
   * Uses the CANVAS size for both halves, where the desktop uses the canvas for
   * screen->world and the FIELD's own size for world->uv. They agree today only
   * because the field preserves the canvas aspect and uv is normalized -- and
   * there is no field yet. **Step 9 must pass the field's own size here** when
   * it builds one, exactly as `drawing_commands.py:53` does.
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
    return worldToUv(world, this.system.canvasSize);
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
    // STEP 9 ADDS ONE LINE HERE:
    //
    //     this.strafeField.setWrap(project.world.boundaryConditions === BC.WRAP);
    //
    // The field samples the world the same way the canvas does, so its wrap
    // mode follows the boundary condition -- and it belongs in THIS method
    // because this being the single place project state changes is exactly what
    // stops a load or an undo leaving the two disagreeing
    // (`orchestrator.py:381-385`, which makes the same call for the same
    // reason). Invariant 9: four things must agree on the boundary mode, and
    // the field is one of them.
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
   */
  private prePreviewProject(fallback: Project): Project {
    return this.previewOrigin ?? fallback;
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

      case 'saveConfig':
        // STEP 9 OWNS STORAGE. Reported through `saveError` rather than thrown
        // or silently dropped: the panel already renders that field every
        // frame, so the user gets a real answer and Step 9 has a wired path to
        // fill in rather than a missing one to discover.
        this.saveError =
          'Saving arrives in Step 9 (manifest + IndexedDB). Nothing was written.';
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
        // Remember where browsing started, so a committed load records against
        // it rather than against whatever preview happened to be showing.
        //
        // A Project IS the snapshot: immutable, so holding a reference is
        // enough (`project_commands.py:175-191`).
        this.previewOrigin = this.project;
        return;

      case 'restoreConfigs':
        // The other half of hover-preview; likewise never recorded.
        if (this.previewOrigin !== null) this.setProject(this.previewOrigin);
        this.previewOrigin = null;
        return;

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

      case 'editDrawPref':
        // Drawing controls are PREFS: editor state, saved but never recorded in
        // history -- loading someone else's config must not resize your brush,
        // and there is no project state for undo to restore.
        //
        // Skips the rebuild check that `editSetting` runs, because no drawing
        // preference is disruptive (`drawing_commands.py:107-110`).
        this.adoptPreferences(withValue(this.prefs, command.field, command.value), false);
        return;

      case 'clearStrafeField':
        // Step 9. The only reset for the field -- it is not in the undo
        // timeline, being live-only state that never survives a restart either.
        return;

      default: {
        // Exhaustiveness. Adding a Command member without a case above fails
        // HERE, at compile time, rather than as a silently ignored click.
        const unreachable: never = command;
        throw new Error(`unhandled command: ${JSON.stringify(unreachable)}`);
      }
    }
  }

  /** Load a preset by name and record one undoable entry. */
  private adoptPreset(name: string): void {
    const before = this.prePreviewProject(this.project);
    const next = loadPresetInto(this.project, name);
    if (next === null) return;
    this.setProject(next);
    this.recordHistory(before, `load ${name}`);
    this.previewOrigin = null;
    this.presetName = name;
  }

  /** Commit a checkpoint restore, recording against where browsing started. */
  private commitCheckpoint(checkpoint: Checkpoint): void {
    const before = this.prePreviewProject(this.project);
    this.setProject(checkpoint.project);
    this.recordHistory(before, `restore ${checkpoint.name}`);
    this.previewOrigin = null;
  }

  /**
   * Adopt edited preferences, persisting them and rebuilding if required.
   *
   * `withValue` returns the RECEIVER when nothing changed, so the `===` guard
   * here is what stops a slider reporting an unmoved value from writing to
   * `localStorage` every frame -- the same early-out
   * `drawing_commands.py:113-114` needs, for the same reason.
   */
  private adoptPreferences(updated: Preferences, allowRebuild = true): void {
    if (updated === this.prefs) return;
    const needsRebuild = allowRebuild && requiresRestart(this.prefs, updated);
    this.prefs = updated;
    savePreferences(this.prefs);
    if (needsRebuild) void this.rebuildSystem();
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
   * **KNOWN LEAK, and deliberate for now.** `ParticleSystem` exposes no
   * `destroy()`, so the outgoing system's entity buffer, config buffer, canvas
   * pair and uniform buffers are left to GC -- which does NOT free GPU memory
   * on its own. At 600k entities that is ~19 MB of entity buffer per rebuild.
   * It is bounded in practice: only World Size and Canvas Aspect reach here,
   * both are typed inputs committed on Enter (never dragged), and a session
   * changes them a handful of times.
   *
   * Fixing it means adding `ParticleSystem.destroy()` alongside the one
   * `Camera` already has, which is a change to that class rather than to this
   * one -- so it belongs with Step 9's rebuild work, where the strafe field
   * gets the same treatment and `release()` already exists on the desktop side.
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
    replacement.applyProject(this.project.configs, this.project.world);
    this.system = replacement;
    // Step 9: the strafe field is sized to the canvas, so a new canvas needs a
    // new field -- otherwise its uv mapping would silently skew against the new
    // shape.
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

      saveError: this.saveError,

      ...this.settingsSources(),
    };
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
