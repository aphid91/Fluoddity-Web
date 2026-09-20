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
// The value import as well as the type: `applyWorldSize` builds a replacement.
import { StrafeField as StrafeFieldClass } from '../strafeField/strafeField.ts';
import type { Preferences } from '../prefs/preferences.ts';
import type { SimulationConfig, WorldSettings } from '../particleSystem/config.ts';
import type { Vec2 } from '../particleSystem/coords.ts';
import type { CameraView } from '../camera/cameraUniforms.ts';
import { type OverlayState, NO_OVERLAYS } from '../assembler/assemblerUniforms.ts';
import { worldToUv } from '../particleSystem/coords.ts';
import {
  type ColorMode,
  DEFAULT_COLOR_MODE,
  colorModeIndex,
} from './colorMode.ts';
import { ParticleSystem } from '../particleSystem/particleSystem.ts';
import { SandPasses } from './sandPasses.ts';
import { Compactor } from './compactor.ts';
import { InitialConditions, RESTORE_FRAME } from './initialConditions.ts';
import { Palette, isLoaded } from './palette.ts';
import { type SandTool, actionFor, isFieldTool, usesSwatch } from './tool.ts';
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
import {
  type BrushAction,
  BRUSH_ERASE,
  BRUSH_SPAWN,
  BrushInput,
  DEFAULT_BRUSH_RATE,
} from './brushInput.ts';
import { forUpload } from '../particleSystem/config.ts';
import { canvasDimensions, sizingFor } from '../particleSystem/sizing.ts';
import { occupancy } from '../particleSystem/compaction.ts';
import { shouldAutoCompact } from '../particleSystem/compactPlan.ts';
import type { PoolAudit } from '../particleSystem/poolAudit.ts';
import { fieldStrengthsFor } from '../prefs/preferences.ts';

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
  // NOT readonly: a World Size or Canvas Aspect change reshapes the canvas, and
  // the field takes its shape from the canvas.
  private field: StrafeField;
  private readonly targets: RenderTargets;
  // Both hold the entity buffer by reference, so both are replaced when it is.
  private passes: SandPasses;
  /**
   * GPU-only compaction. NOT readonly: a Max Particles or World Size change
   * rebuilds the system, and the compactor's scratch buffers are sized to the
   * entity count.
   */
  private compactor: Compactor;
  private initial: InitialConditions;

  /**
   * Starts PAUSED, at frame 0. That is the arranging state -- the user paints a
   * scene before anything moves, which is what makes "initial conditions" a
   * thing the user authors rather than a snapshot of a random moment.
   */
  private _paused = true;
  private restorePending = false;
  /**
   * A world-wide act queued for the top of the next frame.
   *
   * Exists so a clear and a restore cannot race -- one is a queue write, the
   * other is encoder-recorded, and mixing the two ordered them by submission
   * rather than by intent. See `clearParticles`.
   */
  private pendingWorldOp: 'clear' | null = null;

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

  // THE CAPTURED HIGH-WATER MARK IS GONE, and its absence is deliberate.
  //
  // It existed because the old snapshot copied the entity buffer and the free
  // list VERBATIM, so the restored scene occupied exactly the indices it had
  // before and the mark that went with it was a property of the capture.
  //
  // A stamp paste allocates fresh slots instead, so the restored arrangement is
  // rebuilt rather than reproduced -- and the mark that describes it is the one
  // the paste's own `noteSpawned` produces. Keeping a captured value here would
  // mean asserting a bound for an arrangement that no longer exists.

  /**
   * Whether the Dev panel has switched TIER 1 COMPACTION off.
   *
   * A kill switch rather than a tuning knob, and it exists because compaction is
   * the one thing here that changes a bound the physics reads. If a world ever
   * misbehaves in a way that might be the mark, turning this off and watching the
   * behaviour persist or vanish is the fastest way to know -- without it the only
   * way to rule compaction out is to rebuild.
   *
   * Off means the per-frame ordering pass is not recorded AND the empty-pool mark
   * drop does not fire. The manual button still works: it is an explicit act, and
   * refusing it would be confusing when the user pressed it on purpose.
   */
  private compactionPaused = false;

  /**
   * Suppresses the empty-pool mark drop until a head readback lands that was
   * taken AFTER the free list was last rewritten wholesale.
   *
   * ## The hazard this closes
   *
   * A restore replaces the entire free list through the encoder, so for a frame
   * or two `availableSlots` describes a pool that no longer exists. If the
   * world was cleared before the restore, that stale head reads "entirely
   * free" -- and the mark drop would believe it and zero the mark that the
   * restore had just correctly put back. The restored particles would then sit
   * above the bound: alive in memory, skipped by every pass, drawn by nothing.
   *
   * `spawnedSinceRead` does not cover it. That counter guards against SPAWNS
   * the readback has not seen; this is the pool itself being replaced, which it
   * has no way to express.
   *
   * Cleared in `runFrame` when a head arrives that differs from the one held at
   * the time of the rewrite -- the same "a fresh head supersedes" test the spawn
   * counter already uses.
   */
  private markDropHeld = false;

  /**
   * A compaction requested for the next frame.
   *
   * ## WHY THIS IS A SINGLE BOOLEAN NOW
   *
   * It replaces a cursor, a target, a start mark, a "finishing" flag and two
   * generation counters. All of that existed because the old compaction ran
   * across many frames while the world kept changing underneath it, so every
   * one of those fields answered a question about a partially-applied state:
   * how far had it got, was its answer still valid, had something invalidated
   * it since.
   *
   * GPU compaction runs in ONE FRAME. It either happened or it did not, so
   * there is no partial state to describe, nothing to abort, and no window for
   * anything to invalidate. The five fields collapse to "do it next frame".
   *
   * That simplification is the point of the rewrite as much as the correctness
   * is: the old bugs all lived in the gaps between those fields.
   */
  private compactRequested = false;

  /**
   * True on the frame a compaction was recorded, so the caller can report it.
   *
   * Cleared at the top of every frame. For the UI only -- nothing depends on it
   * for correctness.
   */
  private compactedThisFrame = false;

  /**
   * Whether compaction may start itself. Off until the user asks for it.
   *
   * A pass that rewrites both buffers unsupervised is worth opting into, and
   * the button covers anyone who only wants it occasionally.
   */
  private autoCompact = false;

  /**
   * When the last compaction was RECORDED, for the cooldown.
   *
   * Recorded rather than confirmed: the cooldown exists to space out the frames
   * that skip physics, and that cost lands when the passes are recorded, not
   * when the mark readback arrives.
   *
   * Starts at -Infinity so the first compaction is not made to wait out a
   * cooldown that never ran.
   */
  private lastCompactedAt = -Infinity;

  /**
   * Particles spawned since the last compaction was RECORDED.
   *
   * ## Why `spawnedSinceRead` cannot do this job
   *
   * That counter tracks spawns since the last FREE-LIST HEAD readback, and is
   * reset whenever a fresh head arrives. The compacted mark takes its own
   * readback, two or three frames, and a head can easily land inside that
   * window -- zeroing `spawnedSinceRead` while spawns made after the compaction
   * are still outstanding.
   *
   * The guard then read zero, believed a mark measured before those spawns, and
   * lowered the bound below particles the brush had just created. They stayed
   * in memory, invisible, until the mark rose past them again -- which is
   * exactly the "particles appear at a previous brush location in a previously
   * selected material" report: old spawns reappearing when the bound climbed
   * back over them.
   *
   * Two readbacks, two windows. This counter measures the one the compacted
   * mark actually needs: spawns the compaction did not see.
   */
  private spawnedSinceCompact = 0;

  /**
   * Particles spawned whose measured reach has not come back yet.
   *
   * Diagnostic only -- the spawn correction is RAISE-ONLY (`noteSpawnReach`), so
   * unlike the two counters around it this guards nothing: a stale measurement
   * can only fail to raise the bound, never wrongly lower it.
   *
   * Kept because "how far behind is the measurement" is the first thing worth
   * knowing if the mark ever looks wrong again, and the number is free.
   */
  private spawnsAwaitingHighWater = 0;

  /**
   * Particles spawned since the last restore's high-water readback was taken.
   *
   * ## WHY THIS IS A SEPARATE COUNTER FROM `spawnsAwaitingHighWater`
   *
   * The two track measurements that move the mark in OPPOSITE DIRECTIONS, and
   * that is the whole distinction:
   *
   *   the SPAWN pass reports how far up a stroke reached, which can only RAISE
   *   the bound. A stale answer is harmless -- it merely fails to raise -- so it
   *   needs no guard.
   *
   *   the RESTORE sets the bound to the whole buffer and its readback LOWERS it
   *   to what the paste actually used. A stale answer there is exactly the
   *   dangerous case: it would lower the bound beneath particles created since,
   *   hiding them. So it needs the same guard `noteCompactedMark` already
   *   enforces, and the counter has to measure this readback's own window.
   *
   * Neither of the other two windows fits: `spawnedSinceRead` is zeroed whenever
   * a free-list head arrives, and a head can easily land between the paste and
   * its readback -- which is precisely the trap `spawnedSinceCompact` was
   * introduced to fix, arrived at by the same route.
   *
   * Poisoned rather than zeroed when the world changes underneath an in-flight
   * measurement, so the answer is refused rather than permitted.
   */
  private spawnedSinceRestore = Number.MAX_SAFE_INTEGER;

  /** Whether a compaction was recorded on the frame just rendered. */
  get justCompacted(): boolean {
    return this.compactedThisFrame;
  }

  /**
   * An explicit particle cap from the Dev panel, or null to follow World Size.
   *
   * Held so a World Size change can REBUILD at the capped count rather than
   * silently reverting to the derived one -- the cap is a property of the
   * session, not of the world's shape.
   */
  private maxParticles: number | null = null;

  /** The explicit cap, for the session snapshot. Null means follow World Size. */
  get maxParticlesSetting(): number | null {
    return this.maxParticles;
  }

  /** Re-apply a cap restored from a previous session. */
  setMaxParticlesSetting(value: number | null): void {
    this.maxParticles = value;
  }

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
    compactor: Compactor;
    // CONSTRUCTED BY THE CALLER, because it compiles shaders and this cannot
    // await. It became async when the initial conditions became a whole-scene
    // stamp -- see `initialConditions.ts`.
    initial: InitialConditions;
  }) {
    this.device = opts.device;
    this.system = opts.system;
    this.camera = opts.camera;
    this.assembler = opts.assembler;
    this.field = opts.field;
    this.targets = opts.targets;
    this.passes = opts.passes;
    this.compactor = opts.compactor;
    this.initial = opts.initial;
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
    const compactor = await Compactor.create(opts.device, opts.system);
    const initial = await InitialConditions.create(opts.device, opts.system, opts.field);
    const orch = new SandOrchestrator({ ...opts, passes, compactor, initial });
    orch.startEmpty();
    return orch;
  }

  get paused(): boolean {
    return this._paused;
  }

  get hasInitialConditions(): boolean {
    return this.initial.hasSnapshot;
  }

  /**
   * Whether the user is authoring the initial conditions right now.
   *
   * ## Derived, not a fourth flag
   *
   * It is exactly `paused && captureArmed`, which is the state the frame loop
   * already uses to decide whether the next 0 -> 1 transition captures. Adding a
   * separate boolean for the UI to read would create a second source of truth
   * that could drift from the one the capture actually consults -- and the
   * symptom of that drift would be a dashed border promising an edit that the
   * next unpause quietly discards.
   *
   * True at startup, true after `R`, true after a world rebuild; false the
   * instant the scene is captured, and true again when a reset re-arms it. The
   * dashed canvas border and the banner both read this, and so does `reset()`.
   */
  get editingInitialConditions(): boolean {
    return this._paused && this.captureArmed;
  }

  /** Live particles, by the same estimate `availableEstimate` tracks. */
  get liveEstimate(): number {
    return this.system.entityCount - this.availableEstimate;
  }

  // =========================================================================
  // Compaction -- the Dev panel's readouts and controls
  // =========================================================================

  /**
   * Everything the Dev panel needs to describe the pool, in one read.
   *
   * ONE OBJECT RATHER THAN FIVE GETTERS because the panel refreshes every frame
   * and the numbers must be MUTUALLY CONSISTENT: `occupancy` is derived from the
   * same `live` and `mark` that are displayed beside it, so a reader who does the
   * division themselves gets the number on screen. Five independent getters
   * sampled across a frame boundary could disagree, and a diagnostic that
   * contradicts itself is worse than no diagnostic.
   */
  get compactionStats(): {
    live: number;
    mark: number;
    capacity: number;
    occupancy: number;
    paused: boolean;
    compactPending: boolean;
    autoCompact: boolean;
  } {
    const capacity = this.system.entityCount;
    const mark = this.system.activeEntityCount;
    // The same estimate the brush budgets against, so the panel and the brush
    // never disagree about how full the world is.
    const live = Math.max(0, Math.min(capacity, this.liveEstimate));
    return {
      live,
      mark,
      capacity,
      occupancy: occupancy(live, mark),
      paused: this.compactionPaused,
      // NO PROGRESS FIGURE. The compaction is one frame, so there is no
      // in-between to report -- only whether one is queued for the next.
      compactPending: this.compactRequested,
      autoCompact: this.autoCompact,
    };
  }

  /**
   * Check the pool's invariants and report. The Dev panel's Audit button.
   *
   * Stalls the pipeline, which is acceptable for a diagnostic pressed by hand.
   * See `auditPoolNow` and `poolAudit.ts`.
   */
  async auditPool(): Promise<PoolAudit> {
    return this.system.auditPoolNow();
  }

  /** The Dev panel's automatic-compaction switch. See `autoCompact`. */
  setAutoCompact(enabled: boolean): void {
    this.autoCompact = enabled;
  }

  /**
   * Queue a compaction if the world has fragmented past the threshold.
   *
   * THE POLICY LIVES IN `shouldAutoCompact`, so every threshold is testable
   * without a device or a clock. This supplies the readings and acts on the
   * answer.
   *
   * `compactionPaused` is checked separately rather than folded in, because it
   * is a kill switch for ALL compaction -- including the button -- and not a
   * condition on this particular decision.
   */
  private considerAutoCompact(): void {
    if (this.compactionPaused) return;
    if (!this.compactor.ready) return;
    const stats = this.compactionStats;
    const ready = shouldAutoCompact({
      enabled: this.autoCompact,
      idle: !this.compactRequested,
      live: stats.live,
      mark: stats.mark,
      now: performance.now(),
      lastCompactedAt: this.lastCompactedAt,
    });
    if (ready) this.compactRequested = true;
  }

  /** The Dev panel's kill switch. See `compactionPaused`. */
  setCompactionPaused(paused: boolean): void {
    this.compactionPaused = paused;
    // A pause cancels a pending request. Nothing else to undo: a compaction
    // either ran on a frame or it did not, so there is no in-flight state for
    // the kill switch to unwind.
    if (paused) this.compactRequested = false;
  }

  /**
   * Whether a compaction is queued for the next frame.
   *
   * There is no "running" state to report. The compaction occupies exactly one
   * frame, so by the time anything could observe it, it is done.
   */
  get compactPending(): boolean {
    return this.compactRequested;
  }

  /**
   * Ask for a compaction on the next frame.
   *
   * Returns why not, rather than failing silently, because this is a button: a
   * user who presses Compact and sees nothing deserves to know which of
   * "already queued", "nothing to gain" or "did not compile" applied.
   *
   * ## Why it is queued rather than done here
   *
   * The compaction rewrites the entity buffer and the free list wholesale, so
   * it needs a frame on which nothing else touches either -- no spawn, no kill,
   * no `advance()`. `runFrame` is the only thing that can arrange that, so the
   * request is left for it.
   */
  requestCompaction(): { queued: boolean; reason: string } {
    if (this.compactionPaused) {
      return { queued: false, reason: 'compaction is paused' };
    }
    if (this.compactRequested) {
      return { queued: false, reason: 'already queued' };
    }
    if (!this.compactor.ready) {
      // A pipeline failed to compile. Invariant 5's shape -- the app runs
      // without it -- but a button that cannot work should say so.
      return { queued: false, reason: 'the compaction passes did not compile' };
    }
    const stats = this.compactionStats;
    if (stats.mark === 0) {
      return { queued: false, reason: 'the world is empty' };
    }
    this.compactRequested = true;
    return { queued: true, reason: '' };
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
   *
   * ## IT DOES NOTHING WHILE THE INITIAL CONDITIONS ARE BEING EDITED
   *
   * In that state the scene on screen IS the arrangement being authored, and the
   * snapshot is whatever was captured before it -- an older, superseded scene.
   * Restoring would throw away work the user is in the middle of and replace it
   * with something they had already decided to move on from, which is the
   * opposite of what a reset key is for. Returning false lets the caller say so
   * rather than leaving the keypress looking broken.
   *
   * Returns whether anything happened.
   */
  reset(): boolean {
    if (this.editingInitialConditions) return false;
    if (this.initial.hasSnapshot) {
      this.restorePending = true;
      this._paused = true;
      this.captureArmed = true;
      return true;
    }
    this.startEmpty();
    return true;
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
   * Apply every preference that can change without rebuilding the world.
   *
   * ## Why this is one method rather than assignments at the call site
   *
   * `main.ts` used to set `system.physicsSteps` inside the prefs callback, which
   * closed over the `system` captured at startup -- so after a Max Particles
   * resize replaced it, the slider wrote to a discarded object and appeared to
   * do nothing until a refresh. Reading `this.system` per call is what makes it
   * survive the swap, and putting every live preference in one place is what
   * stops the next one being forgotten (the field strengths already were).
   */
  applyPreferences(prefs: Preferences): void {
    this.system.physicsSteps = prefs.physicsSteps;
    // Never wired at all before this: the Walls and Trails strength sliders sat
    // in the panel doing nothing.
    this.system.setFieldStrengths(fieldStrengthsFor(prefs));
  }

  /**
   * Rebuild for a new World Size or Canvas Aspect.
   *
   * These reallocate the canvas, the field and the entity buffer, so unlike
   * everything in `applyPreferences` they cannot be applied in place -- which is
   * why the registry marks them as typed inputs that commit on Enter.
   *
   * THE WORLD IS EMPTIED. The canvas and field are being replaced at a different
   * resolution and the snapshot describes buffers that will not exist; there is
   * no honest way to carry a painted scene across a reshape of the world it was
   * painted in. Saying so in the status line is better than silently keeping
   * half of it.
   */
  async applyWorldSize(
    prefs: Preferences,
    fallbackConfig: SimulationConfig,
    fallbackWorld: WorldSettings,
  ): Promise<void> {
    const [derivedCount, canvasDim] = sizingFor(prefs.worldSize);
    const canvasSize = canvasDimensions(prefs.canvasAspect, canvasDim);
    // Max Particles, if the user set one, survives a World Size change -- it is
    // a cap on the buffer, not a property of the world's shape.
    const entityCount = this.maxParticles ?? derivedCount;

    const replacement = await ParticleSystem.create({
      device: this.device,
      config: fallbackConfig,
      world: this.palette.master.world ?? fallbackWorld,
      canvasSize,
      entityCount,
      // FROM WORLD SIZE, never from the entity count -- see the option's note.
      sqrtWorldSize: Math.sqrt(prefs.worldSize),
      physicsSteps: prefs.physicsSteps,
      lifetimes: true,
    });
    replacement.resetLifetimes();
    replacement.setFieldStrengths(fieldStrengthsFor(prefs));

    // The field takes its SHAPE from the canvas, so a reshape rebuilds it too.
    const replacementField = await StrafeFieldClass.create(this.device, canvasSize);
    replacementField.setWrap(false);
    replacement.setStrafeField(replacementField.view(), replacementField.size);
    replacement.applyProject(
      this.palette.configsForUpload(fallbackConfig),
      this.palette.master.world ?? fallbackWorld,
    );
    replacement.setFrameCount(RESTORE_FRAME);

    const oldSystem = this.system;
    const oldField = this.field;
    this.system = replacement;
    this.field = replacementField;
    this.assembler.setStrafeField(replacementField.view());

    // The outgoing passes own GPU buffers -- uniforms, the sweep cursor and its
    // staging. Dropping the JS reference does not free them, so a session spent
    // tuning World Size leaked one set per change.
    this.passes.destroy();
    this.passes = await SandPasses.create(this.device, replacement);
    // Scratch buffers are sized to the entity count, so the compactor is
    // rebuilt alongside rather than resized.
    this.compactor.destroy();
    this.compactor = await Compactor.create(this.device, replacement);
    this.initial.destroy();
    this.initial = await InitialConditions.create(
      this.device,
      replacement,
      replacementField,
    );

    this._paused = true;
    this.captureArmed = true;
    this.spawnedSinceRead = 0;
    this.lastSeenHead = -1;
    this.strokePrevUv = null;
    this.lineAnchor = null;

    oldSystem.destroy();
    oldField.destroy();
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
    // THE RETURN VALUE IS NOT OPTIONAL. `ensure` reallocates the HDR and
    // accumulator textures when the window size changes, and destroys the old
    // ones -- but the camera and the assembler cache BIND GROUPS holding views
    // of them. Dropping this on the floor left both pointing at destroyed
    // textures, so every subsequent submit failed validation with
    //
    //     Destroyed texture [Texture "hdr"] used in a submit
    //
    // and NOTHING RENDERED. Painted particles existed and were counted -- the
    // compute passes were unaffected -- but the screen stayed black and the
    // scene looked empty. The studio has always done this (`orchestrator.ts`
    // does the same two calls); the sand path simply never did.
    //
    // It went unnoticed until the UI overhaul because the studio's canvas fills
    // the window and settles on its size before the first frame. The grid shell
    // sizes the canvas from the stage cell, which moves once after layout --
    // so here the reallocation lands AFTER the first frames have cached their
    // bind groups, which is exactly the case this guards.
    if (this.targets.ensure(input.windowSize)) {
      this.camera.invalidateTargets();
      this.assembler.invalidateTargets();
    }
    // Advanced unconditionally, including while paused -- see `spawnSeed`.
    this.spawnSeed++;
    const encoder = this.device.createCommandEncoder({ label: 'sand-frame' });

    // FIRST, before anything reads the buffers being overwritten.
    //
    // ONE SLOT FOR BOTH ACTS. A clear is an immediate queue write and a restore
    // is encoder-recorded; doing them from wherever the button was pressed let
    // the two interleave by submission order rather than by what the user asked
    // for last. Routing both through here makes "the later request wins" true by
    // construction. See `clearParticles`.
    if (this.pendingWorldOp === 'clear') {
      this.system.resetLifetimes();
      this.spawnedSinceRead = 0;
      // A queued compaction was requested for a world that no longer exists,
      // and an empty world has nothing to compact.
      this.compactRequested = false;
      // POISONED, not zeroed. A clear empties the world and takes the mark to
      // zero; an in-flight compacted mark measured the world before that and
      // must be refused, not permitted. Zero here would permit it.
      this.spawnedSinceCompact = Number.MAX_SAFE_INTEGER;
      // Same argument for an in-flight restore measurement: it describes a
      // scene this clear has just emptied.
      this.spawnedSinceRestore = Number.MAX_SAFE_INTEGER;
    }
    this.pendingWorldOp = null;

    if (this.restorePending) {
      this.restorePending = false;
      if (this.initial.restore(encoder)) {
        this.system.setFrameCount(RESTORE_FRAME);
        // The pool has been rewritten by the clear-then-paste: every live slot
        // returned, then a fresh one taken per restored particle. The head
        // readback will catch up on its own; all that is needed here is to stop
        // subtracting spawns against a head that predates the whole exchange.
        this.spawnedSinceRead = 0;
        // THE MARK IS RAISED BY THE PASTE ITSELF, not restored to a captured
        // value. A stamp paste allocates fresh slots rather than reproducing the
        // captured indices, so the mark that goes with the restored scene is
        // whatever the paste's own `noteSpawned` produced -- assigning the old
        // captured mark here would state a bound for an arrangement that no
        // longer describes where the particles are.
        //
        // The paste errs upward, which is the safe direction: an over-high mark
        // costs wasted invocations, while an under-low one leaves live particles
        // above the bound, skipped by the physics and drawn by nothing.
        //
        // AND THE MARK DROP MUST BE HELD OFF until the head readback catches
        // up. The clear and the paste both moved the head through the encoder,
        // but `availableSlots` still reports the head from BEFORE them -- and
        // after the clear half that stale head reads "entirely free".
        // `dropMarkIfEmpty` would believe it, zero the mark the paste has just
        // raised, and leave every restored particle above the bound.
        //
        // `spawnedSinceRead` cannot cover this. It guards against spawns the
        // readback has not seen, and a restore is not a spawn -- it is the whole
        // pool changing underneath the reading.
        this.markDropHeld = true;
        // THE RESTORE'S OWN READBACK WINDOW OPENS HERE. The paste has just set
        // the mark to the whole buffer and recorded a measurement of where its
        // particles actually landed; anything spawned from now on is something
        // that measurement did not see.
        this.spawnedSinceRestore = 0;
        // A queued compaction was requested for the pre-restore arrangement.
        // The restored scene may not need one at all, and the user can ask
        // again if it does.
        this.compactRequested = false;
        // AND AN IN-FLIGHT COMPACTED MARK MUST BE REFUSED. Its readback
        // measured the world the restore has just replaced, so lowering the
        // bound to it would hide the restored particles. Poisoning the counter
        // makes `noteCompactedMark` decline it; the value itself is discarded
        // when the next compaction supersedes it.
        this.spawnedSinceCompact = Number.MAX_SAFE_INTEGER;
      }
    }

    // THE AUTOMATIC TRIGGER, consulted before the decision below so a
    // compaction it queues runs on THIS frame rather than idling one.
    this.considerAutoCompact();

    // THIS FRAME BELONGS TO THE COMPACTION IF ONE IS QUEUED.
    //
    // It rewrites the entity buffer and the free list wholesale, so nothing
    // else may touch either: no spawn (would take from a pool about to be
    // replaced), no kill and no `advance()` (would push into it). Each of those
    // is suppressed at its own site below, naming this flag.
    //
    // Decided ONCE, here, rather than tested repeatedly -- a frame in which
    // some passes thought they were compacting and others did not is precisely
    // the kind of half-state the old design kept producing.
    const compacting = this.compactRequested && this.compactor.ready;
    this.compactedThisFrame = false;

    const tool = this.brush.tool;
    const selected = this.palette.at(this.palette.selected);

    // WHAT THE STROKE MEANS now comes from the TOOL, not from the swatch -- see
    // `tool.ts` on the split. The two painting verbs are explicit tools, so the
    // mouse button no longer decides between them on its own: Brush spawns and
    // Erase kills, and within each the right button is still the inverse.
    const action = actionFor(tool, input.action);

    // Brushes run whether or not the simulation is advancing -- arranging a
    // scene while paused is the whole point of the paused state.
    const command = this.brush.frame(
      input.cursor,
      action,
      input.dt,
      this.availableEstimate,
      // Only the Brush over a LOADED swatch deposits particles. Every other tool
      // and every empty swatch spawn nothing; the eraser ignores this, so rubbing
      // out works whatever is selected.
      usesSwatch(tool) && isLoaded(selected),
    );
    const world = forUpload(
      this.palette.master.world ?? this.currentWorld(),
      this.system.sqrtWorldSize,
      this.palette.all().length,
    );

    // NO ABORT HERE ANY MORE, and its absence is the point.
    //
    // The old sweep ran across many frames, so painting during one could hand a
    // brush a slot the sweep had already filled -- which meant every stroke had
    // to abort it and rebuild the pool. That abort was itself the source of
    // several bugs.
    //
    // A GPU compaction occupies one frame on which the brush passes do not run
    // at all (`compactingThisFrame` below), so the two can never overlap. There
    // is nothing to abort because there is never anything in flight.

    if (!compacting && command !== null && command.action === BRUSH_SPAWN) {
      this.passes.spawn(
        encoder,
        world,
        command.stroke,
        command.count,
        this.palette.selected,
        this.spawnSeed,
      );
      this.spawnedSinceRead += command.count;
      // Tracked separately from `spawnedSinceRead`, against a different
      // readback window. See `spawnedSinceCompact`.
      this.spawnedSinceCompact += command.count;
      // And two more windows, for the two high-water readbacks -- the spawn
      // pass's own and the restore's. See each counter on why neither the head
      // nor the compaction window covers it.
      this.spawnsAwaitingHighWater += command.count;
      this.spawnedSinceRestore += command.count;
      // THE OPTIMISTIC BOUND, corrected a frame or two later by the measured
      // one. `noteSpawned` assumes the reservation took contiguous indices from
      // the mark upward, which is true in a fresh world and false after any
      // erasing -- so on its own it can leave particles above the bound. It is
      // kept because the mark must be safe on THIS frame and the measurement has
      // not arrived yet; `takeHighWater` below is what makes it right.
      this.system.noteSpawned(command.count);
    }

    // THE PAINTING TOOLS, recorded here for the same cadence reason the studio
    // uses: ONCE PER RENDERED FRAME, above the physics. Painting inside the
    // sub-step loop would make a stroke `physicsSteps` times stronger and tie
    // its weight to the Physics Rate.
    this.paintField(encoder, tool, input);

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

    if (!this._paused && !compacting) {
      // SHOVE IS NOT A PASS -- it is a value handed to every sub-step, because
      // it must act AS particles move rather than as one jump at an arbitrary
      // point in the frame. That is the shape ARCHITECTURE.md describes for a
      // tool that influences the physics rather than issuing a command, and it
      // is why the strength is divided by the sub-step count host-side.
      //
      // Null while paused, like the studio: a paused frame is untouchable.
      //
      // SUPPRESSED ON A COMPACTION FRAME. `advance()` returns edge-killed
      // indices to the pool via BC_KILL, and the compaction rewrites that pool
      // from scratch -- a push landing in between would be discarded. One
      // dropped physics frame is imperceptible; a lost push is a slot that can
      // never be reused.
      this.system.runFrame(encoder, this.shoveFor(tool, input));
    }

    if (!compacting && command !== null && command.action === BRUSH_ERASE) {
      this.passes.kill(encoder, world, command.stroke);
      // Nothing is adjusted on the host here: how many particles the eraser took
      // is a GPU-side fact, which is exactly why the free count is read back
      // rather than tallied. See `availableEstimate`.
    }

    // POOL ORDERING: keep the lowest free index on top of the stack, so the
    // eraser's scatter cannot ratchet the high-water mark upward. Moves no
    // particle.
    //
    // AFTER kill, so a freed index can be ordered in on a later frame, and the
    // spawn flag is what keeps it off the creation pass's frames -- the one
    // overlap that is genuinely unsafe. See `sortFreeList`.
    //
    // SKIPPED ON A COMPACTION FRAME: the compaction writes the pool in perfect
    // order anyway, so ordering it first is work about to be overwritten.
    if (!this.compactionPaused && !compacting) {
      this.passes.sortFreeList(
        encoder,
        command !== null && command.action === BRUSH_SPAWN,
      );
    }

    // THE COMPACTION, which owns this frame entirely -- see `compacting` above.
    if (compacting) {
      this.compactedThisFrame = this.compactor.record(encoder);
      this.compactRequested = false;
      // Stamped on the frame that SKIPS PHYSICS, which is the cost the cooldown
      // spaces out -- not on the later frame the mark readback lands.
      this.lastCompactedAt = performance.now();
      // The pool is about to be replaced wholesale, so the cached head and any
      // spawn tally against it describe a world that will not exist. Same
      // hazard a restore creates, handled the same way.
      this.markDropHeld = true;
      this.spawnedSinceRead = 0;
      // The compaction sees the world as it stands on THIS frame, so spawns
      // before it are accounted for in the mark it will report. Only spawns
      // from here on are ones it did not see.
      this.spawnedSinceCompact = 0;
    }

    // LAST, so the head it copies includes this frame's spawns and erases.
    this.system.recordFreeListRead(encoder);

    this.renderInto(encoder, prefs, target, input.cursor);
    this.device.queue.submit([encoder.finish()]);

    // AFTER the submit: mapAsync on a copy that has not been submitted never
    // resolves, which would wedge the readback in `mapping` forever and freeze
    // the free count at its startup value.
    this.system.pollFreeListRead();
    // Same constraint, same placement: a mapAsync on an unsubmitted copy never
    // resolves and would wedge the readback forever.
    this.compactor.poll();
    // And the spawn pass's reach, which is what corrects the optimistic mark
    // after a stroke into a scattered pool. Same constraint again.
    this.passes.pollHighWater();
    // And the restore's, which is what brings the mark back down from the whole
    // buffer after an R. Same constraint again.
    this.initial.poll();

    // A fresh head supersedes the spawns counted against the previous one --
    // and, equally, supersedes a pool rewrite the old head predated.
    const head = this.system.availableSlots;
    if (head !== this.lastSeenHead) {
      this.lastSeenHead = head;
      this.spawnedSinceRead = 0;
      this.markDropHeld = false;
    }

    // THE MARK THE GPU COMPUTED, applied under the direction rule.
    //
    // `noteCompactedMark` refuses anything that would RAISE the bound, and
    // anything measured before a spawn the host has since counted. Both
    // refusals are cheap: the mark simply stays where it is until the next
    // compaction, which is the conservative direction.
    const compacted = this.compactor.takeMark();
    if (compacted !== null) {
      // `spawnedSinceCompact`, NOT `spawnedSinceRead`. The two count against
      // different readbacks, and using the wrong one lowered the mark below
      // particles the brush had just created -- see `spawnedSinceCompact`.
      this.system.noteCompactedMark(compacted, this.spawnedSinceCompact);
    }

    // THE RESTORE'S MEASURED MARK, which LOWERS the bound.
    //
    // A restore sets it to the whole buffer because the free list decides where
    // the pasted particles land and the host cannot predict it. This is that
    // guess being replaced by the measurement -- the highest slot the paste
    // actually wrote, computed by an atomic max on the GPU.
    //
    // `noteCompactedMark` is reused rather than reimplemented: it already
    // refuses anything that would RAISE the bound and anything measured before a
    // spawn the host has counted, which are exactly the two refusals a lowering
    // correction needs. `spawnedSinceRestore` measures this readback's own
    // window -- see its declaration on why the other windows do not fit.
    //
    // FIRST, so a spawn reach arriving on the same frame is applied on top of
    // the lowered bound rather than being undone by it.
    const restored = this.initial.takeHighWater();
    if (restored !== null) {
      this.system.noteCompactedMark(restored, this.spawnedSinceRestore);
    }

    // THE SPAWN PASS'S MEASURED REACH, which RAISES it.
    //
    // `noteSpawned` raised the mark by a COUNT on the frame of the stroke, which
    // assumes contiguous indices and is wrong the moment the pool has been
    // scattered by erasing. This is the number the GPU actually observed.
    //
    // RAISE-ONLY (`noteSpawnReach`), so a measurement that arrives after a later
    // stroke cannot lower the bound beneath it. That is what makes the lag safe
    // with no guard counter -- unlike the two corrections that lower, which both
    // need one.
    //
    // BEFORE `dropMarkIfEmpty`, so a raise is not applied on top of a decision
    // made from a head that predates it.
    const reach = this.passes.takeHighWater();
    if (reach !== null) {
      this.system.noteSpawnReach(reach);
      this.spawnsAwaitingHighWater = 0;
    }

    // TIER 1's ONE MARK REDUCTION, and it is deliberately the only one: if the
    // pool is entirely free there is no live particle for a lowered bound to
    // skip, so the mark can go to zero. Every other case needs Tier 2, which
    // moves particles and can therefore prove where the highest live one is.
    //
    // AFTER the head refresh above, so `spawnedSinceRead` is measured against
    // the head being tested rather than against an older one -- the pairing is
    // what makes a stale "full" reading safe to act on. See `canDropMarkToZero`.
    if (!this.compactionPaused && !this.markDropHeld) {
      this.system.dropMarkIfEmpty(this.spawnedSinceRead);
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
   *
   * ## THE ERASER RIGHT-DRAGS AS A VACUUM
   *
   * Erase is the second tool that returns a shove, and only on the right button,
   * where it is always a PULL. The gesture is the one Shove already has -- right
   * draws particles inward -- reused as "gather what is nearby and take it",
   * which is what a user right-dragging an eraser is reaching for: the kill pass
   * still runs on the same frame, so the pull feeds particles into the radius
   * the eraser is already clearing.
   *
   * It is the same `SHOVE_GAIN` on purpose rather than a second constant. The
   * pull has to be the one the user's hand is already calibrated to from Shove,
   * and a separate tuning number would be one more thing that could drift.
   *
   * `brush.weight` is NOT read: `usesStrength` returns false for Erase, so the
   * Strength field is greyed out and its stored value is whatever a previous
   * session happened to leave there. Multiplying by it would make the vacuum
   * secretly obey a control the UI says does not apply.
   */
  private shoveFor(tool: SandTool, input: SandFrameInput): ShoveState | null {
    if (input.cursor === null || input.action === null) return null;
    // Erase pulls on the right button only; left is the plain eraser.
    if (tool === 'erase' && input.action !== BRUSH_ERASE) return null;
    if (tool !== 'shove' && tool !== 'erase') return null;

    // Per sub-step, so the raw value is divided by a power of the rate -- see the
    // long argument at `shoveCommands.shoveState`. The exponent leaves the brush
    // relatively stronger at low rates, which is when a user is placing things
    // carefully and wants it to bite.
    const steps = Math.max(1, Math.trunc(this.system.physicsSteps));
    const falloff =
      steps ** SHOVE_RATE_EXPONENT / SHOVE_REFERENCE_STEPS ** (SHOVE_RATE_EXPONENT - 1);

    // The eraser takes the bare gain -- see above on why its Strength is not
    // read. Shove scales by its own.
    const gain = tool === 'erase' ? SHOVE_GAIN : SHOVE_GAIN * this.brush.weight;
    let strength = gain / falloff;
    // Left pushes away, right pulls in -- the studio's convention. The eraser
    // only ever reaches here on the right, so it is always a pull.
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
    tool: SandTool,
    input: SandFrameInput,
  ): void {
    // THE ERASER IS A FIELD TOOL TOO, and only ever subtracts.
    //
    // It used to fall out here as "not a field tool", so rubbing over a wall
    // left it standing: the tool erased particles and nothing else, which made
    // it the only way to remove a wall was the Clear button -- all of them at
    // once, or none. An eraser that cannot erase the thing under it reads as
    // broken rather than as scoped.
    //
    // WALLS, not trails. Walls are structure the user places deliberately and
    // wants to take back one stroke at a time; trails are simulation residue
    // that decays on its own, and rubbing them out mid-run would fight the
    // decay rather than assist it. The Trails tool still has its own right
    // button for the rare case.
    //
    // `eraseOnly` is what carries "this stroke subtracts whatever the button
    // is" down to the draw call -- see below. The eraser has no additive half,
    // so unlike the field tools its right button must not flip it to drawing.
    const eraseOnly = tool === 'erase';
    const layer = eraseOnly
      ? ('walls' as FieldLayer)
      : isFieldTool(tool)
        ? layerForMouseMode(tool)
        : null;
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
      // `eraseOnly` overrides the button: the eraser subtracts on both.
      if (!eraseOnly && input.action === BRUSH_SPAWN) {
        this.field.draw(encoder, uv, anchor, brush);
      } else {
        this.field.erase(encoder, uv, anchor, brush);
      }
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
    // `eraseOnly` overrides the button, as above.
    if (!eraseOnly && input.action === BRUSH_SPAWN) {
      this.field.draw(encoder, uv, prev, brush);
    } else {
      this.field.erase(encoder, uv, prev, brush);
    }
  }

  private fieldBrush(layer: FieldLayer, isLine: boolean): BrushParams {
    return {
      // The five size buttons, in the uv metric this tool measures in.
      drawSize: this.brush.radius,
      // THE ERASER TAKES THE DEFAULT, not its stored Strength. `usesStrength`
      // returns false for it, so the field is greyed out and whatever number
      // sits behind it is stale -- letting that scale the wall erase would make
      // a disabled control secretly load-bearing. The other tools read their
      // own, which is the whole point of per-tool strengths.
      drawPower:
        this.brush.tool === 'erase' ? DEFAULT_BRUSH_RATE : this.brush.weight,
      mode: 'diverge',
      layer,
      drawAngle: 0,
      // Freehand deposits every frame; a line deposits once.
      lineGain: isLine ? LINE_STROKE_GAIN : 1.0,
    };
  }

  // =========================================================================
  // Worlds -- exporting the scene to bytes, and putting one back
  // =========================================================================

  /**
   * The current scene as `.fwld` bytes, or null if there is nothing to save.
   *
   * ## THIS IS THE ONE PLACE THAT PAYS FOR A READBACK
   *
   * The initial-conditions capture keeps its stamp in VRAM precisely so that `R`
   * stays instant (see `initialConditions.ts`). Saving a world is the opposite
   * case: the bytes have to reach the host to be written to IndexedDB, and the
   * user has just clicked a menu item and can wait a frame.
   *
   * SAVES THE CAPTURED INITIAL CONDITIONS, not the live scene. A world's initial
   * conditions are what the author arranged and pressed go on -- the thing `R`
   * returns to -- and the live scene is however far that has since evolved.
   * Saving the latter would make every world open mid-simulation, at whatever
   * moment the author happened to hit save.
   *
   * Null when nothing has been captured yet, which is the honest answer for a
   * world that is only a palette and a set of preferences.
   */
  async exportScene(): Promise<ArrayBuffer | null> {
    return this.initial.exportScene(this.palette);
  }

  /**
   * Adopt a scene from `.fwld` bytes as the initial conditions, and show it.
   *
   * ## The world is left ARRANGING, not running
   *
   * Loading a world puts the user where its author was when they pressed go:
   * paused, looking at the arrangement, free to edit it before starting. That is
   * the same state `R` leaves them in, and it is what makes "click the world
   * again to reset it" mean something.
   */
  async importScene(bytes: ArrayBuffer): Promise<boolean> {
    const applied = await this.initial.importScene(bytes);
    if (!applied) return false;
    // The restore path proper: the scene is now the snapshot, so put it on
    // screen through the same route `R` uses rather than duplicating it.
    this.restorePending = true;
    this._paused = true;
    // ARMED, so editing the loaded arrangement and pressing go captures the
    // edit -- the world's own scene is a starting point, not a cage.
    this.captureArmed = true;
    return true;
  }

  /** Wipe one layer of the painted field. The hint bar's Clear button. */
  clearField(layer: FieldLayer): void {
    const encoder = this.device.createCommandEncoder({ label: 'sand-clear-field' });
    this.field.clear(encoder, layer);
    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * Kill every particle. The hint bar's Clear All Particles button.
   *
   * ## DEFERRED, for the same reason the restore is
   *
   * This used to call `resetLifetimes()` immediately, which writes the entity
   * buffer through `queue.writeBuffer`. A pending `R` restore, meanwhile, is
   * recorded onto the frame's ENCODER and submitted at the end of it. Queue
   * writes are ordered against submissions, so clearing between pressing R and
   * the next frame put the clear FIRST and the restore on top of it -- the
   * cleared particles came back, which is precisely the "old particles return"
   * symptom.
   *
   * Both acts now go through the same per-frame slot, so the last one asked for
   * is the one that happens and neither can overwrite the other's result.
   */
  clearParticles(): void {
    this.pendingWorldOp = 'clear';
    // A clear supersedes a restore that has not run yet -- the user asked for an
    // empty world after asking for the old one, and the later request wins.
    this.restorePending = false;
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
    this.maxParticles = wanted;
    if (wanted === this.system.entityCount) return;

    const replacement = await ParticleSystem.create({
      device: this.device,
      config: fallbackConfig,
      world: this.palette.master.world ?? fallbackWorld,
      canvasSize: this.system.canvasSize,
      entityCount: wanted,
      // CARRIED OVER EXPLICITLY, not re-derived. Deriving it from the entity
      // count is what made raising the cap silently retune gravity and every
      // other force -- Max Particles is a cap, not a world size.
      sqrtWorldSize: this.system.sqrtWorldSize,
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
    // See the note at the other rebuild site: these own GPU buffers.
    this.passes.destroy();
    this.passes = await SandPasses.create(this.device, replacement);
    // Scratch buffers are sized to the entity count, so the compactor is
    // rebuilt alongside rather than resized.
    this.compactor.destroy();
    this.compactor = await Compactor.create(this.device, replacement);
    this.initial.destroy();
    this.initial = await InitialConditions.create(this.device, replacement, this.field);
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

  /**
   * How the particle camera assigns hue. The Dev tab's dropdown writes it.
   *
   * A PLAIN FIELD rather than a setter: nothing has to happen when it changes.
   * The next frame reads it on its way to the uniform, which is what makes the
   * dropdown take effect immediately -- including while paused, since a paused
   * frame still renders.
   */
  colorMode: ColorMode = DEFAULT_COLOR_MODE;

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
      // The HIGH-WATER MARK, not the buffer size. The camera draws one instanced
      // sprite per entity, so an unbounded count means four vertex invocations
      // per dead particle per frame -- at a large Max Particles that alone is
      // tens of millions of invocations with an empty world. See
      // `activeEntityCount`.
      entityCount: this.system.activeEntityCount,
      // THE DEV TAB'S DROPDOWN, mapped to the integer the shader switches on.
      // A display choice, so it takes effect on the next rendered frame rather
      // than on the next physics step -- which is what lets it be compared
      // while paused, the same argument `camBrush.wgsl` makes for deciding
      // colour in the renderer at all.
      colorMode: colorModeIndex(this.colorMode),
      // EVERY SLOT'S OWN APPEARANCE: its swatch colour, and the Color
      // Sensitivity and Color Offset of the config sitting in it.
      //
      // The camera used to take ONE sensitivity per frame and this line read it
      // from the master slot, which meant the master's slider coloured every
      // material on screen and the copy on every other square was saved and
      // silently ignored. Now each material answers to its own.
      //
      // Written every frame regardless of the mode -- see `CameraFrame`.
      swatchColors: this.palette.appearanceForUpload(),
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
      // TWICE `drawSize`, which is the brush's VISIBLE EXTENT -- two sigma of
      // its gaussian, and exactly the eraser's hard radius (`strafeDraw.wgsl`
      // tests `hit.dist < draw_size * 2.0`). The studio computes the same
      // `2.0 * prefs.drawSize`.
      //
      // Handing over the bare `drawSize` drew a ring at half the true reach, so
      // a wall stroke visibly affected far more than the circle promised.
      reticleRadius: cursor === null ? 0 : this.brush.reticleRadius,
      // THE LINE PREVIEW, which this never set -- it inherited `null` from
      // `NO_OVERLAYS` and the capsule the studio draws while Shift is held
      // simply never appeared here. The anchor was tracked correctly all along
      // and the committed stroke landed where it should; only the preview of it
      // was missing, so the gesture worked blind.
      //
      // The condition is `lineAnchor !== null` and nothing else, for the reason
      // the studio gives: every path that abandons a line clears the anchor, so
      // "is one armed" and "should one be previewed" are the same question and
      // cannot disagree.
      //
      // THE ANCHOR NEEDS NO CONVERSION. It is stored in field uv and the overlay
      // measures in canvas uv, but both are normalized [0,1] over the SAME world
      // rect -- the field takes the canvas's shape and only its resolution is
      // capped (`MAX_FIELD_DIM`). Resolution does not enter a normalized
      // coordinate, so the two spaces are numerically identical and the anchor
      // crosses as-is.
      linePreview:
        this.lineAnchor === null || cursor === null
          ? null
          : { from: this.lineAnchor, to: worldToUv(cursor, this.system.canvasSize) },
    };

    this.assembler.present(encoder, this.camera.result(), target, view, prefs, overlays);
  }

  destroy(): void {
    this.initial.destroy();
  }
}
