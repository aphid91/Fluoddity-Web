/**
 * The sand modality's frame loop and state.
 *
 * The counterpart of `orchestrator/orchestrator.ts`, and deliberately a separate
 * class rather than a mode inside it. They share the whole ENGINE -- the same
 * `ParticleSystem`, `Camera`, `Assembler` and `StrafeField` -- and almost none of
 * the interaction model: no picking, no mutation overlay, no preset cycling, no
 * recording, and a completely different notion of what a click means. Folding a
 * flag into a 3,700-line class to reuse the twenty lines of frame loop they have
 * in common would put every sand bug one branch away from the studio.
 *
 * ## The frame, and why the order is what it is
 *
 *     restore?        pending R, recorded before anything reads the buffers
 *     capture?        on the 0 -> 1 transition: this IS the initial conditions
 *     spawn           ONCE -- reads the free list, only takes slots
 *     advance x N     the physics. Edge-death gives slots back, never takes
 *     kill            ONCE -- only gives slots back
 *     render          camera -> assembler -> screen
 *
 * The free-list head therefore moves DOWN across one pass and UP across the
 * others, never both within a pass. That is what makes the atomic reservation
 * safe; see the header of `freeList.wgsl`.
 *
 * ## Pause, and what "initial conditions" means
 *
 * The world starts PAUSED at frame 0, which is the arranging state: brushes
 * work, the field can be painted, and nothing moves. The first unpause is the
 * 0 -> 1 transition, and the scene as it stands at that instant is captured.
 * `R` restores it and returns to the arranging state, so the user can edit and
 * re-run the same setup -- requirement 3.
 */

import type { Assembler } from '../assembler/assembler.ts';
import type { Camera } from '../camera/camera.ts';
import type { RenderTargets } from '../app/renderTargets.ts';
import type { StrafeField } from '../strafeField/strafeField.ts';
import type { Preferences } from '../prefs/preferences.ts';
import type { SimulationConfig, WorldSettings } from '../particleSystem/config.ts';
import type { Vec2 } from '../particleSystem/coords.ts';
import type { CameraView } from '../camera/cameraUniforms.ts';
import { type OverlayState, NO_OVERLAYS } from '../assembler/assemblerUniforms.ts';
import { uvRadiusToWorld, worldToUv } from '../particleSystem/coords.ts';
import { ParticleSystem } from '../particleSystem/particleSystem.ts';
import { SandPasses } from './sandPasses.ts';
import { InitialConditions, RESTORE_FRAME } from './initialConditions.ts';
import { Palette } from './palette.ts';
import { type BrushAction, BRUSH_ERASE, BRUSH_SPAWN, BrushInput } from './brushInput.ts';
import { forUpload } from '../particleSystem/config.ts';

export interface SandFrameInput {
  /** Cursor in WORLD space, or null when it is off the canvas. */
  readonly cursor: Vec2 | null;
  readonly action: BrushAction | null;
  readonly windowSize: readonly [number, number];
  /** Seconds since the last frame. */
  readonly dt: number;
}

export class SandOrchestrator {
  readonly system: ParticleSystem;
  readonly palette = new Palette();
  readonly brush = new BrushInput();

  private readonly device: GPUDevice;
  private readonly camera: Camera;
  private readonly assembler: Assembler;
  private readonly field: StrafeField;
  private readonly targets: RenderTargets;
  private readonly passes: SandPasses;
  private readonly initial: InitialConditions;

  /**
   * Starts PAUSED, at frame 0. That is the arranging state -- the user paints a
   * scene before anything moves, which is what makes "initial conditions" a
   * thing the user authors rather than a snapshot of a random moment.
   */
  private _paused = true;
  private restorePending = false;

  /**
   * Whether the next 0 -> 1 transition should capture the scene.
   *
   * True while arranging, cleared by the capture, and set again by every reset.
   * That is what makes the snapshot the MOST RECENTLY SET initial conditions
   * rather than the first ones of the session -- see `reset()`.
   */
  private captureArmed = true;

  /**
   * How many dead particles the pool holds, as far as the CPU knows.
   *
   * AN ESTIMATE, AND DELIBERATELY SO. The true head lives on the GPU and only a
   * readback could know it, which would stall the pipeline every frame -- the
   * exact cost the picker's two-phase design exists to avoid. So this tracks
   * spawns optimistically and is corrected on reset.
   *
   * Being wrong is SAFE in both directions: too high and the shader's
   * reservation refuses the excess (an empty pool is a normal state it already
   * handles); too low and the brush paints slightly less than it could. Neither
   * corrupts anything, which is why an estimate is acceptable where a readback
   * would not be worth its cost.
   */
  private availableEstimate: number;

  private constructor(opts: {
    device: GPUDevice;
    system: ParticleSystem;
    camera: Camera;
    assembler: Assembler;
    field: StrafeField;
    targets: RenderTargets;
    passes: SandPasses;
  }) {
    this.device = opts.device;
    this.system = opts.system;
    this.camera = opts.camera;
    this.assembler = opts.assembler;
    this.field = opts.field;
    this.targets = opts.targets;
    this.passes = opts.passes;
    this.initial = new InitialConditions(opts.device, opts.system, opts.field);
    this.availableEstimate = opts.system.entityCount;
  }

  static async create(opts: {
    device: GPUDevice;
    system: ParticleSystem;
    camera: Camera;
    assembler: Assembler;
    field: StrafeField;
    targets: RenderTargets;
  }): Promise<SandOrchestrator> {
    const passes = await SandPasses.create(opts.device, opts.system);
    const orch = new SandOrchestrator({ ...opts, passes });
    orch.startEmpty();
    return orch;
  }

  get paused(): boolean {
    return this._paused;
  }

  get hasInitialConditions(): boolean {
    return this.initial.hasSnapshot;
  }

  /** Live particles, by the same estimate `availableEstimate` tracks. */
  get liveEstimate(): number {
    return this.system.entityCount - this.availableEstimate;
  }

  /**
   * An empty world, paused, ready to be painted.
   *
   * Frame 1, NOT 0. Zero is the studio's regenerate-everything sentinel: leaving
   * it there would make the first advance fill the world with particles the user
   * never painted, which is the opposite of an empty canvas.
   */
  private startEmpty(): void {
    this.system.resetLifetimes();
    this.system.setFrameCount(RESTORE_FRAME);
    this.availableEstimate = this.system.entityCount;
    this._paused = true;
    // An empty world is a fresh arrangement, so the next go captures it.
    this.captureArmed = true;
  }

  togglePause(): void {
    this._paused = !this._paused;
  }

  /**
   * `R` -- restore the scene the user pressed go on, and return to arranging.
   *
   * Deferred to the top of the next frame rather than acted on here, because the
   * restore is a set of GPU copies and must be recorded onto an encoder. Doing it
   * inline would need its own submission, and a sub-step could run in between.
   *
   * With no snapshot yet -- R pressed before ever unpausing -- this empties the
   * world instead, which is the only sensible reading of "go back to the start".
   *
   * ## RE-ARMING THE CAPTURE IS THE POINT, NOT AN EXTRA
   *
   * After the restore the user is back in the arranging state and may erase
   * particles, paint more, or redraw a wall. Pressing go again must remember
   * THAT scene -- "the most recently set initial conditions", not the first ones
   * ever set. So `armed` goes true here and the next 0 -> 1 transition captures
   * over the old snapshot.
   *
   * Without this the very first arrangement would be frozen for the session and
   * every later edit silently discarded on the next R, which looks like the
   * reset key being broken rather than like a capture that never re-ran.
   */
  reset(): void {
    if (this.initial.hasSnapshot) {
      this.restorePending = true;
      this._paused = true;
      this.captureArmed = true;
      return;
    }
    this.startEmpty();
  }

  /**
   * Upload the palette's configs.
   *
   * The MASTER SLOT'S world settings govern -- one `WorldData`, one trail field,
   * so the scene needs one answer about trail persistence. Other slots contribute
   * `ConfigData` only; their world settings are read solely by `isCompatible`, to
   * warn in the load menu.
   */
  applyPalette(fallbackConfig: SimulationConfig, fallbackWorld: WorldSettings): void {
    const master = this.palette.master;
    const world = master.world ?? fallbackWorld;
    this.system.applyProject(this.palette.configsForUpload(fallbackConfig), world);
    this.field.setWrap(false);
  }

  /**
   * World size or canvas aspect changed: the snapshot describes a dead world.
   *
   * Re-arms the capture as well as dropping the copies. Otherwise the session
   * would be left with no snapshot AND no intention of taking one, so `R` would
   * fall back to emptying the world for good.
   */
  invalidateInitialConditions(): void {
    this.initial.invalidate();
    this.captureArmed = true;
  }

  /**
   * One rendered frame.
   *
   * Returns false when there is nothing to present -- a failed target
   * allocation, which the caller handles by skipping the frame rather than
   * crashing.
   */
  runFrame(input: SandFrameInput, prefs: Preferences, target: GPUTextureView): boolean {
    this.targets.ensure(input.windowSize);
    const encoder = this.device.createCommandEncoder({ label: 'sand-frame' });

    // FIRST, before anything reads the buffers being overwritten.
    if (this.restorePending) {
      this.restorePending = false;
      if (this.initial.restore(encoder)) {
        this.system.setFrameCount(RESTORE_FRAME);
        // The restored free list is the captured one, so the CPU's estimate has
        // to come back to what it was at capture. Not knowing it exactly is why
        // this is an estimate; the shader tolerates the drift either way.
        this.availableEstimate = this.capturedAvailable;
      }
    }

    // Brushes run whether or not the simulation is advancing -- arranging a
    // scene while paused is the whole point of the paused state.
    const command = this.brush.frame(
      input.cursor,
      input.action,
      input.dt,
      this.availableEstimate,
    );
    const world = forUpload(
      this.palette.master.world ?? this.currentWorld(),
      this.system.sqrtWorldSize,
      this.palette.all().length,
    );

    if (command !== null && command.action === BRUSH_SPAWN) {
      this.passes.spawn(
        encoder,
        world,
        command.stroke,
        command.count,
        this.palette.selected,
        this.system.frameCount,
      );
      this.availableEstimate = Math.max(0, this.availableEstimate - command.count);
    }

    // THE CAPTURE POINT: the scene as it stands the instant the user presses go.
    //
    // Recorded after the frame's spawn so a particle painted on the very frame
    // of unpausing is part of the initial conditions, and BEFORE the sub-steps
    // so nothing has moved yet -- this is the arrangement, not one frame of
    // simulation later.
    //
    // Gated on `captureArmed`, which `reset()` sets, rather than on "no snapshot
    // exists". The requirement is the MOST RECENTLY SET initial conditions: after
    // an R the user edits and presses go again, and that new arrangement is what
    // the next R must restore.
    if (!this._paused && this.captureArmed) {
      this.captureArmed = false;
      this.initial.capture(encoder);
      this.capturedAvailable = this.availableEstimate;
    }

    if (!this._paused) {
      this.system.runFrame(encoder, null);
    }

    if (command !== null && command.action === BRUSH_ERASE) {
      this.passes.kill(encoder, world, command.stroke);
      // Deliberately NOT adjusted: how many particles the eraser actually took
      // is a GPU-side fact. Leaving the estimate low means the brush under-paints
      // until the next reset, which is the safe direction to be wrong in.
    }

    this.renderInto(encoder, prefs, target, input.cursor);
    this.device.queue.submit([encoder.finish()]);
    return true;
  }

  private capturedAvailable = 0;

  private currentWorld(): WorldSettings {
    return this.palette.master.world ?? this.fallbackWorld;
  }

  /** Set by `main.ts` from the loaded defaults, so the field is never unset. */
  fallbackWorld!: WorldSettings;

  private renderInto(
    encoder: GPUCommandEncoder,
    prefs: Preferences,
    target: GPUTextureView,
    cursor: Vec2 | null,
  ): void {
    const windowSize = this.targets.size;
    if (windowSize === null) return;

    // ONE SAMPLE, NO MOTION BLUR. The studio's temporal supersample averages N
    // renders taken at different points in the advance; a sand world is being
    // drawn on, and the brush wants the sharpest possible read of where the
    // particles actually are. Blur is a studio affordance for judging emergent
    // character, which is not what this modality is for.
    //
    // Built once and used for both calls: `beginFrame` writes the uniforms and
    // `render` draws, and handing them different frames would make the two
    // disagree about where the camera is.
    const frame = {
      canvas: this.system.currentCanvasTexture(),
      canvasSize: this.system.canvasSize,
      windowSize,
      entities: this.system.entityBufferForRendering(),
      entityCount: this.system.entityCount,
      colorSensitivity: this.palette.master.config?.colorSensitivity ?? 0,
      colorByCohort: false,
    };
    this.camera.beginFrame(frame, 1);
    this.camera.clearAccumulator(encoder);
    this.camera.render(encoder, frame);

    const state = this.camera.state;
    const view: CameraView = {
      canvasSize: this.system.canvasSize,
      windowSize,
      pan: state.pan,
      zoom: state.zoom,
    };

    // The reticle shows the brush's reach. Measured in the same
    // `aspect_correct_uv` metric the assembler draws it in, so it stays circular
    // on a non-square canvas -- `uvRadiusToWorld` is the bare factor of 2 between
    // the two, so dividing by it converts back.
    const overlays: OverlayState = {
      ...NO_OVERLAYS,
      showField: prefs.fieldOpacity > 0,
      showTrails: prefs.fieldOpacity > 0,
      reticleCenter:
        cursor === null ? [0, 0] : worldToUv(cursor, this.system.canvasSize),
      reticleRadius: cursor === null ? 0 : this.brush.radius / uvRadiusToWorld(1),
    };

    this.assembler.present(encoder, this.camera.result(), target, view, prefs, overlays);
  }

  destroy(): void {
    this.initial.destroy();
  }
}
