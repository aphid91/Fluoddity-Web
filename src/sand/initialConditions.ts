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
 * ## Why it is a snapshot rather than the studio's reset
 *
 * The studio resets by setting `frameCount` to 0, which is a SENTINEL every pass
 * watches: `entityUpdate` regenerates every entity from scratch, `canvas` zeroes
 * the trails, `brush` discards its splats. That is exactly the wrong behaviour
 * here -- it would destroy the scene being restored and repopulate the world
 * with particles the user never painted.
 *
 * So this modality never uses frame 0 after startup. It copies the four pieces
 * of live state aside, and restores them by copying back and setting the frame
 * counter to 1. Every pass then behaves as if the simulation had simply been
 * running, which is the point: the restored scene is bit-identical to the
 * captured one, including trails already laid down and walls already painted.
 *
 * ## The four pieces, and why each is needed
 *
 *   entities    the particles themselves -- position, velocity, which config
 *   free list   which indices are dead. WITHOUT THIS the pool would still think
 *               the particles erased before capture were available, and the next
 *               brush stroke would hand out indices that are now live again.
 *   canvas      the trail field. Restoring particles onto a canvas full of the
 *               trails they left over the following minute would immediately
 *               steer them somewhere else.
 *   field       painted walls and trails (rgba16float, both layers in one).
 *
 * ## Cost
 *
 * Doubles each. At the default world size that is ~9.6 MB of entities, ~1.2 MB
 * of free list, ~4 MB of canvas and 1 MB of field -- about 16 MB, allocated once
 * and reused for every capture. At world size 4 it approaches 90 MB, which is
 * why `invalidate()` exists: a world-size change replaces the buffers this holds
 * copies of, and a stale snapshot must not be restorable.
 */

import type { ParticleSystem } from '../particleSystem/particleSystem.ts';
import type { StrafeField } from '../strafeField/strafeField.ts';
import { CANVAS_FORMAT } from '../particleSystem/particleSystem.ts';
import { FIELD_FORMAT } from '../strafeField/fieldSize.ts';

// Re-exported so callers have one import for the restore. The definition lives
// in `restoreFrame.ts` because this module imports `particleSystem.ts`, which
// imports `.wgsl` -- so nothing under `node --test` can reach it from here.
export { RESTORE_FRAME } from './restoreFrame.ts';

export class InitialConditions {
  private readonly device: GPUDevice;
  private readonly system: ParticleSystem;
  private readonly field: StrafeField;

  private entities: GPUBuffer | null = null;
  private freeList: GPUBuffer | null = null;
  private canvas: GPUTexture | null = null;
  private fieldCopy: GPUTexture | null = null;

  /** Whether a scene has been captured and can be restored. */
  private captured = false;

  constructor(device: GPUDevice, system: ParticleSystem, field: StrafeField) {
    this.device = device;
    this.system = system;
    this.field = field;
  }

  get hasSnapshot(): boolean {
    return this.captured;
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
   */
  capture(encoder: GPUCommandEncoder): void {
    this.ensureTargets();
    if (
      this.entities === null ||
      this.freeList === null ||
      this.canvas === null ||
      this.fieldCopy === null
    ) {
      return;
    }

    const entitySrc = this.system.entityBufferForSand();
    const freeSrc = this.system.freeListBufferForSand();
    encoder.copyBufferToBuffer(entitySrc, 0, this.entities, 0, entitySrc.size);
    encoder.copyBufferToBuffer(freeSrc, 0, this.freeList, 0, freeSrc.size);

    const canvasSrc = this.system.currentCanvasTextureObject();
    encoder.copyTextureToTexture(
      { texture: canvasSrc },
      { texture: this.canvas },
      { width: this.system.canvasSize[0], height: this.system.canvasSize[1] },
    );

    const fieldSrc = this.field.textureObject();
    encoder.copyTextureToTexture(
      { texture: fieldSrc },
      { texture: this.fieldCopy },
      { width: this.field.size[0], height: this.field.size[1] },
    );

    this.captured = true;
  }

  /**
   * Put the captured scene back. Returns false if there is nothing to restore.
   *
   * THE CALLER MUST SET THE FRAME COUNT to `RESTORE_FRAME` after this -- it is
   * not done here because the frame counter belongs to `ParticleSystem` and this
   * class holds no authority over it. `SandOrchestrator.reset()` is the one
   * place the two happen together.
   *
   * ## The canvas copy targets the CURRENT front
   *
   * The canvas double-buffers and the front swaps every sub-step, so which
   * texture is "the canvas" changes underfoot. Asking the system for its front
   * at restore time is what makes this correct regardless of how many sub-steps
   * have run since capture.
   */
  restore(encoder: GPUCommandEncoder): boolean {
    if (
      !this.captured ||
      this.entities === null ||
      this.freeList === null ||
      this.canvas === null ||
      this.fieldCopy === null
    ) {
      return false;
    }

    const entityDst = this.system.entityBufferForSand();
    const freeDst = this.system.freeListBufferForSand();
    encoder.copyBufferToBuffer(this.entities, 0, entityDst, 0, entityDst.size);
    encoder.copyBufferToBuffer(this.freeList, 0, freeDst, 0, freeDst.size);

    encoder.copyTextureToTexture(
      { texture: this.canvas },
      { texture: this.system.currentCanvasTextureObject() },
      { width: this.system.canvasSize[0], height: this.system.canvasSize[1] },
    );

    encoder.copyTextureToTexture(
      { texture: this.fieldCopy },
      { texture: this.field.textureObject() },
      { width: this.field.size[0], height: this.field.size[1] },
    );

    return true;
  }

  /**
   * Drop the snapshot.
   *
   * MUST be called when world size or canvas aspect changes. Those reallocate
   * the entity buffer and both textures, so the copies held here describe a
   * world that no longer exists -- restoring one would copy a 300k-entity buffer
   * into a 2.4M-entity one, which WebGPU rejects, or a 1024x1024 canvas into a
   * 2048x2048 one, which it also rejects. Better to have no initial conditions
   * than a snapshot that errors on use.
   */
  invalidate(): void {
    this.captured = false;
    this.entities?.destroy();
    this.freeList?.destroy();
    this.canvas?.destroy();
    this.fieldCopy?.destroy();
    this.entities = null;
    this.freeList = null;
    this.canvas = null;
    this.fieldCopy = null;
  }

  destroy(): void {
    this.invalidate();
  }

  /**
   * Allocate the shadow copies, once, sized to what they mirror.
   *
   * Lazily rather than in the constructor: a session that never presses go never
   * pays the ~16 MB, and after `invalidate()` the next capture re-allocates at
   * whatever the new world size is.
   */
  private ensureTargets(): void {
    if (this.entities !== null) return;
    const device = this.device;

    this.entities = device.createBuffer({
      label: 'ic-entities',
      size: this.system.entityBufferForSand().size,
      usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.freeList = device.createBuffer({
      label: 'ic-freelist',
      size: this.system.freeListBufferForSand().size,
      usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.canvas = device.createTexture({
      label: 'ic-canvas',
      size: { width: this.system.canvasSize[0], height: this.system.canvasSize[1] },
      format: CANVAS_FORMAT,
      usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
    });
    this.fieldCopy = device.createTexture({
      label: 'ic-field',
      size: { width: this.field.size[0], height: this.field.size[1] },
      format: FIELD_FORMAT,
      usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
    });
  }
}
