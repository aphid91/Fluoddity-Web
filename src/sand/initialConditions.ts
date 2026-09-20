/**
 * The scene as it stood when the user pressed go, and the ability to put it
 * back.
 *
 * ## What this is for
 *
 * A sand world is something the user BUILDS: draw a bowl-shaped wall, drop two
 * species into it, press go. Pressing `R` should hand that arrangement back to
 * be edited and re-run -- not a fresh random world, and not an empty one.
 *
 * ## IT IS A WHOLE-SCENE STAMP, AND THAT IS THE POINT
 *
 * This used to be four hand-rolled GPU copies -- entity buffer, free list,
 * canvas, field -- with its own capture and restore. It is now `copy(the whole
 * world)` and `restore(that stamp)`, running the same passes the stamp tool
 * will use for an arbitrary box.
 *
 * The reason is coverage, not tidiness. A world save is a stamp written to
 * disk, so the stamp path has to be correct or every saved world is wrong --
 * and the reset key is the one thing in this app that gets pressed constantly.
 * Routing `R` through the general operation means the save path is exercised
 * every session by the fastest feedback loop available, rather than only when
 * somebody remembers to test a save.
 *
 * ## THE STAMP STAYS IN VRAM
 *
 * `StampCopier` can read a stamp back to the host -- that is how a world is
 * saved -- and this never does. The captured block is left on the GPU and
 * pasted straight from it.
 *
 * That matters because `R` should feel instant. A readback is a frame or two of
 * latency on a key pressed while the user is watching, and it would buy nothing
 * here: the bytes are already in the right place, on the right device, and
 * nothing between capture and restore needs to look at them. The host round
 * trip is reserved for the one caller that genuinely needs the bytes.
 *
 * ## What changed for the free list, and why it is acceptable
 *
 * The old snapshot copied the free list VERBATIM, so a restored scene had its
 * particles at exactly the indices they occupied before. A stamp paste
 * allocates fresh slots, so the arrangement is rebuilt rather than reproduced:
 * the scene looks identical and behaves identically, but a given particle may
 * live at a different index.
 *
 * Nothing depends on the indices themselves -- they are pool bookkeeping, not
 * identity -- and the paste writes the pool correctly by construction, which is
 * the property the audit actually cares about. Worth stating plainly because
 * the free list is where this subsystem's sharp edges have always been.
 *
 * ## Cost
 *
 * One entity-buffer-sized block, plus the two texture layers, allocated on
 * first capture and reused. Comparable to what the four copies cost, and
 * `invalidate()` still exists for the same reason: a world-size change
 * replaces the resources the stamp describes.
 */

import type { ParticleSystem } from '../particleSystem/particleSystem.ts';
import type { StrafeField } from '../strafeField/strafeField.ts';
import { StampCopier } from '../stamp/stampCopier.ts';
import { StampPaster } from '../stamp/stampPaster.ts';
import { type StampBox, wholeWorldBox } from '../stamp/stampBox.ts';
import type { StampData } from '../stamp/stampData.ts';
import { decodeStamp, encodeStamp } from '../stamp/stampCodec.ts';

// Re-exported so callers have one import for the restore. The definition lives
// in `restoreFrame.ts` because this module imports `particleSystem.ts`, which
// imports `.wgsl` -- so nothing under `node --test` can reach it from here.
export { RESTORE_FRAME } from './restoreFrame.ts';

export class InitialConditions {
  /**
   * Held for `exportScene` alone, which submits an encoder of its own.
   *
   * Every other operation here records onto the frame loop's encoder, which is
   * what keeps a capture or a restore inside the submission it belongs to. The
   * export is the exception because it awaits a readback afterwards, and a frame
   * that cannot complete until storage does is not a frame.
   */
  private readonly device: GPUDevice;
  private readonly system: ParticleSystem;

  private readonly copier: StampCopier;
  private readonly paster: StampPaster;

  /** Whether a scene has been captured and can be restored. */
  private captured = false;

  /**
   * The box the capture covered.
   *
   * THE WHOLE WORLD, always, for this caller -- but stored rather than
   * re-derived at restore time. The canvas aspect decides world extent, so
   * re-deriving it after a reshape would produce a box describing the NEW world
   * while the stamp describes the old one, and the paste would rescale a scene
   * that should simply have been invalidated.
   *
   * Holding the captured box means source and destination compare equal in the
   * ordinary case, which is what triggers the identity short-circuit in both the
   * position remap and the texture write -- so an unchanged world restores
   * bit-exactly rather than through a resample.
   */
  private box: StampBox | null = null;

  /**
   * A scene loaded from a world, waiting for its first restore.
   *
   * ## Two sources for one snapshot, and why the distinction is temporary
   *
   * An ordinary capture leaves its stamp in VRAM, which is what keeps `R`
   * instant. A world load arrives as host bytes instead, and those have to be
   * uploaded before anything can paste them.
   *
   * Rather than keep two restore paths forever, the FIRST restore of an imported
   * scene pastes from the host copy and the capture that follows -- the user
   * pressing go on the arrangement they just loaded -- puts it back in VRAM by
   * the ordinary route. So this is non-null only between a world load and the
   * next press of go, and `restore` is the one place that has to know.
   *
   * Cleared on capture and on invalidate, so a stale import can never outlive
   * the world it describes.
   */
  private pendingStamp: StampData | null = null;

  private constructor(
    device: GPUDevice,
    system: ParticleSystem,
    copier: StampCopier,
    paster: StampPaster,
  ) {
    this.device = device;
    this.system = system;
    this.copier = copier;
    this.paster = paster;
  }

  /**
   * ASYNCHRONOUS, where the old constructor was not.
   *
   * The stamp passes compile WGSL, and `compileModule` is async by nature --
   * WGSL diagnostics arrive through `getCompilationInfo()` rather than by
   * throwing. Every other GPU class here already takes this shape
   * (`SandPasses.create`, `Compactor.create`), so the orchestrator's
   * construction path was already awaiting its neighbours.
   */
  static async create(
    device: GPUDevice,
    system: ParticleSystem,
    field: StrafeField,
  ): Promise<InitialConditions> {
    const [copier, paster] = await Promise.all([
      StampCopier.create(device, system, field),
      StampPaster.create(device, system, field),
    ]);
    return new InitialConditions(device, system, copier, paster);
  }

  get hasSnapshot(): boolean {
    return this.captured;
  }

  /**
   * Whether both stamp paths compiled.
   *
   * Invariant 5's shape: a failed compile leaves the app running without
   * initial conditions rather than not running. The orchestrator reports it
   * instead of silently never capturing.
   */
  get ready(): boolean {
    return this.copier.ready && this.paster.ready;
  }

  /**
   * Capture the current scene.
   *
   * Called on the 0 -> 1 transition: the first frame the simulation actually
   * advances after a reset. That is the moment the user has finished arranging
   * and pressed go, which is what "initial conditions" means here.
   *
   * Recorded onto the CALLER'S encoder rather than submitting its own, so the
   * capture lands in the same submission as the frame it belongs to. Copying in
   * a separate submission would let a sub-step run in between and capture the
   * scene one step late.
   *
   * ## The capture cannot disturb what it captures
   *
   * `StampCopier` binds the entity buffer read-only and never touches the free
   * list -- structurally, not by convention. That is what makes it safe to
   * record this on a frame that is also spawning and advancing.
   */
  capture(encoder: GPUCommandEncoder): void {
    if (!this.ready) return;
    const box = wholeWorldBox(this.system.canvasSize);
    if (!this.copier.record(encoder, box)) return;
    this.copier.stageTexturesInVram(encoder, box);
    this.box = box;
    this.captured = true;
    // THE IMPORT IS SUPERSEDED. The user has pressed go on this arrangement, so
    // the VRAM stamp just taken is the snapshot from here on -- and holding the
    // host copy would make every later `R` paste the world's ORIGINAL scene
    // rather than the edit that was just captured.
    this.pendingStamp = null;
  }

  /**
   * Put the captured scene back. Returns false if there is nothing to restore.
   *
   * THE CALLER MUST SET THE FRAME COUNT to `RESTORE_FRAME` after this -- it is
   * not done here because the frame counter belongs to `ParticleSystem` and this
   * class holds no authority over it. `SandOrchestrator.reset()` is the one
   * place the two happen together.
   *
   * ## Clear then paste, as two passes
   *
   * Replace is a composition here rather than a mode: the region clear returns
   * every live slot to the pool, and the paste then takes from it. They must be
   * separate passes, because within one pass the free list's head may only move
   * in a single direction -- `StampPaster.restore` records them in that order on
   * one encoder, which is what WebGPU orders and barriers between.
   *
   * ## The canvas copy targets the CURRENT front
   *
   * The canvas double-buffers and the front swaps every sub-step, so which
   * texture is "the canvas" changes underfoot. Both the clear and the paste ask
   * the system for its front at restore time, which is what makes this correct
   * regardless of how many sub-steps have run since capture.
   */
  restore(encoder: GPUCommandEncoder): boolean {
    if (!this.captured || this.box === null || !this.ready) return false;
    // AN IMPORTED SCENE PASTES FROM THE HOST COPY, once. See `pendingStamp`:
    // a world arrives as bytes rather than as a VRAM stamp, and the next
    // capture returns it to the ordinary route.
    const pending = this.pendingStamp;
    if (pending !== null) {
      return this.paster.restore(encoder, pending, this.box);
    }
    return this.paster.restoreFromVram(encoder, this.copier, this.box);
  }

  /**
   * Start the paste's high-water readback. Call after submitting the frame.
   *
   * A restore sets the mark to the WHOLE BUFFER until this lands, because the
   * free list decides where pasted particles go and the host cannot predict it.
   * Every frame this is not called is a frame every pass sweeps the full buffer,
   * so it belongs in the frame loop rather than behind a condition.
   */
  poll(): void {
    this.paster.poll();
  }

  /**
   * The measured mark from the last restore, if one has arrived.
   *
   * Offered to the caller rather than applied here, because whether the mark may
   * be lowered depends on what has been spawned since -- which the orchestrator
   * tracks and this class does not. Reading it clears it.
   */
  takeHighWater(): number | null {
    return this.paster.takeHighWater();
  }

  // -------------------------------------------------------------------------
  // Worlds -- the host round trip, which only these two methods pay for
  // -------------------------------------------------------------------------

  /**
   * The captured scene as `.fwld` bytes, or null if nothing is captured.
   *
   * ## Why this re-records the copy rather than reading the existing stamp
   *
   * The capture wrote its particles into the copier's block and its textures
   * into VRAM-resident shadows -- fine for pasting, useless for reading, because
   * a `copyTextureToBuffer` needs its own staging with 256-byte row alignment
   * and the block's length is a number only the GPU knows.
   *
   * So this runs the copy passes again against the CURRENT world. That is
   * correct rather than merely convenient: the whole point of exporting is to
   * save what the author arranged, and the arrangement is what the world holds
   * right now while paused. Re-reading a stamp taken at some earlier press of go
   * would save a scene the author has since edited away from.
   *
   * SUBMITS ITS OWN ENCODER, unlike everything else here. The frame loop's
   * encoder is for work that must land in a frame's submission; this is a menu
   * action that then awaits a readback, and hanging it off the frame would mean
   * a frame that cannot complete until storage does.
   */
  async exportScene(palette: {
    at(slot: number): { name: string };
  }): Promise<ArrayBuffer | null> {
    if (!this.ready) return null;
    const box = wholeWorldBox(this.system.canvasSize);

    const encoder = this.device.createCommandEncoder({ label: 'stamp-export' });
    if (!this.copier.record(encoder, box)) return null;
    const staged = this.copier.stageTextures(encoder, box);
    this.device.queue.submit([encoder.finish()]);

    // AFTER the submit, for the reason every readback here is: a mapAsync on an
    // unsubmitted copy never resolves.
    const count = await this.copier.readCount();
    const particles = await this.copier.readParticles(count);
    const canvas = await this.copier.readLayer(staged.canvas);
    const field = await this.copier.readLayer(staged.field);

    return encodeStamp({
      box,
      particles,
      canvas,
      field,
      // WHICH SLOTS THE PARTICLES REFERENCE, captured now because it cannot be
      // recovered later: the palette travels with the world, but a stamp pasted
      // into a DIFFERENT palette silently reassigns its materials, and this is
      // what a future stamp tool will compare to notice.
      palette: StampCopier.paletteRefsFor(particles, (slot) => palette.at(slot).name),
    });
  }

  /**
   * Adopt a scene from `.fwld` bytes as the snapshot.
   *
   * The paste itself is deferred to the next frame's restore, so this only
   * uploads and records. Returns false if the bytes will not decode, which is an
   * ordinary outcome for a truncated download rather than an exception.
   *
   * ## The box comes from the FILE, not from this world
   *
   * A world saved at a different World Size has a different world extent, and
   * its box says so. Keeping the stored box is what lets the paste rescale the
   * scene into the current world instead of clipping it -- and when the two
   * match, which is the common case, the comparison is exact and the identity
   * short-circuit makes the restore bit-perfect.
   */
  async importScene(bytes: ArrayBuffer): Promise<boolean> {
    if (!this.ready) return false;
    let stamp: StampData;
    try {
      stamp = decodeStamp(bytes, 'world');
    } catch (e) {
      console.error(`Could not read the world's scene: ${String(e)}`);
      return false;
    }

    this.pendingStamp = stamp;
    this.box = stamp.box;
    this.captured = true;
    return true;
  }

  /**
   * Drop the snapshot.
   *
   * MUST be called when world size or canvas aspect changes. Those reallocate
   * the entity buffer and both textures, so the stamp held here describes a
   * world that no longer exists -- and the BOX describes a world of a different
   * shape, since world extent follows canvas aspect. Better to have no initial
   * conditions than a snapshot that pastes a scene into the wrong geometry.
   */
  invalidate(): void {
    this.captured = false;
    this.box = null;
    // A world-size change reshapes world space, so an imported scene's box
    // describes a world that no longer exists. Dropping it here is what stops a
    // stale import outliving the geometry it was written for.
    this.pendingStamp = null;
  }

  destroy(): void {
    this.invalidate();
    this.copier.destroy();
    this.paster.destroy();
  }
}
