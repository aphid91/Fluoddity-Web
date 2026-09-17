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
import { worldToUv } from '../particleSystem/coords.ts';
import { ParticleSystem } from '../particleSystem/particleSystem.ts';
import { SandPasses } from './sandPasses.ts';
import { InitialConditions, RESTORE_FRAME } from './initialConditions.ts';
import { type PaletteSlot, Palette, paintsParticles } from './palette.ts';
import { isFieldTool } from './tool.ts';
import type { ShoveState } from '../particleSystem/uniforms.ts';
import type { BrushParams } from '../strafeField/strafeUniforms.ts';
import type { FieldLayer } from '../strafeField/fieldLayer.ts';
import { LINE_STROKE_GAIN } from '../strafeField/fieldLayer.ts';
import { layerForMouseMode } from '../orchestrator/commands.ts';
import {
  SHOVE_GAIN,
  SHOVE_RATE_EXPONENT,
  SHOVE_REFERENCE_STEPS,
} from '../orchestrator/shoveCommands.ts';
import { type BrushAction, BRUSH_ERASE, BRUSH_SPAWN, BrushInput } from './brushInput.ts';
import { forUpload } from '../particleSystem/config.ts';

export interface SandFrameInput {
  /** Cursor in WORLD space, or null when it is off the canvas. */
  readonly cursor: Vec2 | null;
  readonly action: BrushAction | null;
  readonly windowSize: readonly [number, number];
  /** Seconds since the last frame. */
  readonly dt: number;
  /** Whether Shift is held -- arms the line tool in the painting tools. */
  readonly shift: boolean;
}

export class SandOrchestrator {
  /**
   * NOT readonly: Max Particles replaces it with a system at a new entity count.
   * Everything that binds its buffers is rebuilt alongside -- see
   * `resizeEntities`.
   */
  system: ParticleSystem;
  readonly palette = new Palette();
  readonly brush = new BrushInput();

  private readonly device: GPUDevice;
  private readonly camera: Camera;
  private readonly assembler: Assembler;
  private readonly field: StrafeField;
  private readonly targets: RenderTargets;
  // Both hold the entity buffer by reference, so both are replaced when it is.
  private passes: SandPasses;
  private initial: InitialConditions;

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
   * How many dead particles the pool holds, for this frame's spawn cap.
   *
   * ## This is the GPU's number, not a CPU tally
   *
   * It was a host-side estimate: decremented on spawn, and deliberately NOT
   * adjusted on erase, on the reasoning that under-counting was the safe
   * direction. That was wrong, and the failure is total rather than partial --
   * spawning is countable while erasing is not, so the estimate only ever fell.
   * It reached zero, the brush stopped painting, and erasing could not bring it
   * back: the world looked full while the pool was in fact empty of nothing.
   *
   * `system.availableSlots` is the real head, read back asynchronously (a frame
   * or two stale, which a brush-rate cap does not care about). The one thing the
   * CPU still tracks is `spawnedThisFrame`, below.
   */
  private get availableEstimate(): number {
    // Subtracting this frame's own spawns matters because the readback predates
    // them: without it, a fast drag would be told the same free count several
    // frames running and could ask for slots it had already claimed.
    return Math.max(0, this.system.availableSlots - this.spawnedSinceRead);
  }

  /**
   * Particles requested since the last completed head readback.
   *
   * Reset when a fresh head arrives, so it only ever covers the window the
   * readback does not yet know about.
   */
  private spawnedSinceRead = 0;
  private lastSeenHead = -1;

  /**
   * Seed for the spawn brush's scatter, advanced every RENDERED frame.
   *
   * NOT `system.frameCount`, which is what this used to be and which is frozen
   * while paused. The scatter is hashed on it, so a paused brush drew the
   * identical random offsets every frame: holding the mouse still deposited
   * particles into the same handful of spots forever instead of filling the
   * disc. Arranging a scene is done PAUSED, so that is precisely when the bug
   * bit hardest.
   *
   * A plain counter rather than a clock: it is a hash input, not a duration, and
   * a counter cannot repeat or run backwards.
   */
  private spawnSeed = 0;

  /**
   * Last frame's cursor in FIELD uv, while a painting stroke is in progress.
   *
   * The field tools' equivalent of `BrushInput.previous`, kept separate because
   * it is in a different space (field uv, not world) and ends on different
   * events. Null means no stroke, which is what makes the next press start
   * fresh rather than drawing a line from wherever the last one ended.
   */
  private strokePrevUv: readonly [number, number] | null = null;

  /** The line tool's anchor in field uv, or null when nothing is armed. */
  private lineAnchor: readonly [number, number] | null = null;

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
    // The pool is full again; the readback will confirm it within a frame or
    // two, and until then nothing has been spawned against it.
    this.spawnedSinceRead = 0;
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
    // Advanced unconditionally, including while paused -- see `spawnSeed`.
    this.spawnSeed++;
    const encoder = this.device.createCommandEncoder({ label: 'sand-frame' });

    // FIRST, before anything reads the buffers being overwritten.
    if (this.restorePending) {
      this.restorePending = false;
      if (this.initial.restore(encoder)) {
        this.system.setFrameCount(RESTORE_FRAME);
        // The restored free list is the captured one. The head readback will
        // catch up on its own; all that is needed here is to stop subtracting
        // spawns that the restore has just undone.
        this.spawnedSinceRead = 0;
      }
    }

    const selected = this.palette.at(this.palette.selected);

    // Brushes run whether or not the simulation is advancing -- arranging a
    // scene while paused is the whole point of the paused state.
    const command = this.brush.frame(
      input.cursor,
      input.action,
      input.dt,
      this.availableEstimate,
      // Only a loaded CONFIG square paints particles. A field tool square and an
      // unloaded one both deposit nothing; the eraser ignores this, so rubbing
      // out works whatever is selected.
      paintsParticles(selected),
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
        this.spawnSeed,
      );
      this.spawnedSinceRead += command.count;
    }

    // THE PAINTING TOOLS, recorded here for the same cadence reason the studio
    // uses: ONCE PER RENDERED FRAME, above the physics. Painting inside the
    // sub-step loop would make a stroke `physicsSteps` times stronger and tie
    // its weight to the Physics Rate.
    this.paintField(encoder, selected, input);

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
    }

    if (!this._paused) {
      // SHOVE IS NOT A PASS -- it is a value handed to every sub-step, because
      // it must act AS particles move rather than as one jump at an arbitrary
      // point in the frame. That is the shape ARCHITECTURE.md describes for a
      // tool that influences the physics rather than issuing a command, and it
      // is why the strength is divided by the sub-step count host-side.
      //
      // Null while paused, like the studio: a paused frame is untouchable.
      this.system.runFrame(encoder, this.shoveFor(selected, input));
    }

    if (command !== null && command.action === BRUSH_ERASE) {
      this.passes.kill(encoder, world, command.stroke);
      // Nothing is adjusted on the host here: how many particles the eraser took
      // is a GPU-side fact, which is exactly why the free count is read back
      // rather than tallied. See `availableEstimate`.
    }

    // LAST, so the head it copies includes this frame's spawns and erases.
    this.system.recordFreeListRead(encoder);

    this.renderInto(encoder, prefs, target, input.cursor);
    this.device.queue.submit([encoder.finish()]);

    // AFTER the submit: mapAsync on a copy that has not been submitted never
    // resolves, which would wedge the readback in `mapping` forever and freeze
    // the free count at its startup value.
    this.system.pollFreeListRead();

    // A fresh head supersedes the spawns counted against the previous one.
    const head = this.system.availableSlots;
    if (head !== this.lastSeenHead) {
      this.lastSeenHead = head;
      this.spawnedSinceRead = 0;
    }

    return true;
  }

  // =========================================================================
  // The field tools -- Shove, Walls, Trails
  //
  // All three behave exactly as they do in the studio, and deliberately reuse
  // its pieces rather than reimplementing them: `StrafeField.draw/erase/clear`
  // does the painting, `layerForMouseMode` decides which layer a stroke writes,
  // and the shove tuning constants come from `shoveCommands`.
  // =========================================================================

  /**
   * The shove for this frame, or null when the tool is not armed.
   *
   * Mirrors `shoveCommands.shoveState`, which cannot be called directly: it
   * takes the studio's `InputState` and its `mouseMode`. The TUNING is imported
   * rather than restated, so the two apps cannot disagree about how hard a shove
   * pushes -- which is the part that would be invisible if it drifted.
   */
  private shoveFor(slot: PaletteSlot, input: SandFrameInput): ShoveState | null {
    if (slot.tool !== 'shove' || input.cursor === null || input.action === null) {
      return null;
    }

    // Per sub-step, so the raw value is divided by a power of the rate -- see the
    // long argument at `shoveCommands.shoveState`. The exponent leaves the brush
    // relatively stronger at low rates, which is when a user is placing things
    // carefully and wants it to bite.
    const steps = Math.max(1, Math.trunc(this.system.physicsSteps));
    const falloff =
      steps ** SHOVE_RATE_EXPONENT / SHOVE_REFERENCE_STEPS ** (SHOVE_RATE_EXPONENT - 1);
    let strength = (SHOVE_GAIN * this.brush.weight) / falloff;
    // Left pushes away, right pulls in -- the studio's convention.
    if (input.action === BRUSH_ERASE) strength = -strength;

    return {
      center: input.cursor,
      strength,
      // The shader measures in world space; the buttons store uv.
      size: this.brush.worldRadius,
    };
  }

  /**
   * Paint or erase the user-drawn field.
   *
   * Uv is taken against the FIELD's resolution, not the canvas's -- the field is
   * capped at `MAX_FIELD_DIM` and the two differ once that bites. `_mouseFieldUv`
   * in the studio mixes the same two spaces for the same reason.
   */
  private paintField(
    encoder: GPUCommandEncoder,
    slot: PaletteSlot,
    input: SandFrameInput,
  ): void {
    const layer = isFieldTool(slot.tool) ? layerForMouseMode(slot.tool) : null;
    if (layer === null) {
      this.lineAnchor = null;
      return;
    }
    if (input.cursor === null) {
      this.strokePrevUv = null;
      return;
    }

    const uv = worldToUv(input.cursor, this.field.size);

    // THE LINE TOOL. Shift arms an anchor; the next press commits a segment from
    // it and leaves the endpoint as the new anchor, so endpoints chain into a
    // polyline. A drag already in progress suppresses arming, so the modifier
    // cannot seize a gesture mid-stroke.
    if (input.shift && this.strokePrevUv === null) {
      if (input.action === null) {
        // Hovering with Shift held: arm at the cursor if nothing is armed yet.
        this.lineAnchor ??= uv;
        return;
      }
      const anchor = this.lineAnchor ?? uv;
      const brush = this.fieldBrush(layer, true);
      if (input.action === BRUSH_SPAWN) this.field.draw(encoder, uv, anchor, brush);
      else this.field.erase(encoder, uv, anchor, brush);
      // The endpoint chains, so a polyline is a sequence of clicks.
      this.lineAnchor = uv;
      return;
    }

    if (input.action === null) {
      this.strokePrevUv = null;
      if (!input.shift) this.lineAnchor = null;
      return;
    }

    // Freehand: paint the whole segment from last frame's cursor to this one, so
    // a fast drag is continuous rather than a row of dots.
    const prev = this.strokePrevUv ?? uv;
    this.strokePrevUv = uv;
    this.lineAnchor = null;

    const brush = this.fieldBrush(layer, false);
    if (input.action === BRUSH_SPAWN) this.field.draw(encoder, uv, prev, brush);
    else this.field.erase(encoder, uv, prev, brush);
  }

  private fieldBrush(layer: FieldLayer, isLine: boolean): BrushParams {
    return {
      // The five size buttons, in the uv metric this tool measures in.
      drawSize: this.brush.radius,
      drawPower: this.brush.weight,
      mode: 'diverge',
      layer,
      drawAngle: 0,
      // Freehand deposits every frame; a line deposits once.
      lineGain: isLine ? LINE_STROKE_GAIN : 1.0,
    };
  }

  /** Wipe one layer of the painted field. The hint bar's Clear button. */
  clearField(layer: FieldLayer): void {
    const encoder = this.device.createCommandEncoder({ label: 'sand-clear-field' });
    this.field.clear(encoder, layer);
    this.device.queue.submit([encoder.finish()]);
  }

  /** Kill every particle. The hint bar's Clear All Particles button. */
  clearParticles(): void {
    this.system.resetLifetimes();
    this.spawnedSinceRead = 0;
  }

  /**
   * Rebuild the entity buffer at a new size, carrying the live particles across.
   *
   * ## What is replaced, and what is not
   *
   * Only the per-entity resources: a new `ParticleSystem` at the new count, with
   * the SAME canvas size and `physicsSteps`. World Size still drives canvas
   * resolution and `sqrtWorldSize` -- so the physics feel is untouched and this
   * is purely a cap on how many particles may exist, which is the decoupling
   * this control exists for.
   *
   * ## Why everything downstream has to be re-handed the buffer
   *
   * `SandPasses` binds the entity and free-list buffers into its pipelines, and
   * `InitialConditions` holds copies sized to the old buffer. Both are rebuilt
   * rather than patched: a bind group holds a buffer by reference, so a
   * reallocated buffer needs new groups regardless, and a snapshot of a
   * differently-sized world cannot be restored into this one.
   *
   * THE SNAPSHOT IS DROPPED, not migrated. Carrying it would mean migrating four
   * resources instead of one and answering what a restore means when the buffer
   * it was taken from no longer exists. The user is mid-arrangement when they
   * change a cap; re-pressing go re-captures.
   */
  async resizeEntities(
    count: number,
    fallbackConfig: SimulationConfig,
    fallbackWorld: WorldSettings,
  ): Promise<void> {
    const wanted = Math.max(1, Math.trunc(count));
    if (wanted === this.system.entityCount) return;

    const replacement = await ParticleSystem.create({
      device: this.device,
      config: fallbackConfig,
      world: this.palette.master.world ?? fallbackWorld,
      canvasSize: this.system.canvasSize,
      entityCount: wanted,
      physicsSteps: this.system.physicsSteps,
      lifetimes: true,
    });
    // Empty, then filled by the migration -- `resetLifetimes` is what makes the
    // untouched tail read as dead rather than as live config-0 particles.
    replacement.resetLifetimes();
    replacement.setStrafeField(this.field.view(), this.field.size);
    replacement.applyProject(
      this.palette.configsForUpload(fallbackConfig),
      this.palette.master.world ?? fallbackWorld,
    );

    // Carry the live particles over, truncating silently if the new buffer is
    // smaller. Reads the old buffer back, which is acceptable here and nowhere
    // on the frame path -- see `migrateEntitiesTo`.
    await this.system.migrateEntitiesTo(replacement);
    replacement.setFrameCount(this.system.frameCount);

    const old = this.system;
    this.system = replacement;
    this.passes = await SandPasses.create(this.device, replacement);
    this.initial.destroy();
    this.initial = new InitialConditions(this.device, replacement, this.field);
    // No snapshot survives the resize, so the next go must take a fresh one.
    this.captureArmed = true;
    this.spawnedSinceRead = 0;
    this.lastSeenHead = -1;

    old.destroy();
  }

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
      // `brush.radius` IS uv now, which is the metric the assembler draws the
      // ring in -- so this is a straight hand-off with no conversion. It used to
      // divide by `uvRadiusToWorld(1)` because the brush stored world units.
      reticleRadius: cursor === null ? 0 : this.brush.radius,
    };

    this.assembler.present(encoder, this.camera.result(), target, view, prefs, overlays);
  }

  destroy(): void {
    this.initial.destroy();
  }
}
