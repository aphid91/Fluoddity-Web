/**
 * Putting a stamp back: the region clear, and the additive paste.
 *
 * ## Two operations, and why they are not one
 *
 * `clearRegion(box)` empties a box -- kills the particles in it, zeroes the two
 * texture layers over it. `paste(stamp, box)` adds a stamp's contents to
 * whatever is already there.
 *
 * Neither has a mode flag, because the compositions are what the callers want:
 *
 *   paste                  the stamp tool's drop
 *   clear                  the stamp tool's cut, after a copy
 *   clear then paste       replace -- which is what an initial-conditions
 *                          restore is
 *
 * A `replace` mode on the paste would duplicate the clear's job, and the two
 * could then disagree about which particles count as "in" the box. Composing
 * them means there is exactly one answer to that question, in one shader.
 *
 * ## The free-list protocol, which decides the pass order
 *
 * Within any one pass the head must move in one direction only (see
 * `freeList.wgsl`). The clear ONLY GIVES and the paste ONLY TAKES, so each is
 * safe alone -- but a clear and a paste on the same frame must be SEPARATE
 * PASSES, which WebGPU orders and barriers between. `restore()` below records
 * them in that order onto one encoder, which is what makes replace a single
 * frame with no intermediate state anyone can observe.
 *
 * ## The textures are written, not cleared with `loadOp: 'clear'`
 *
 * A load operation runs BEFORE any scissor test, so it zeroes the entire
 * attachment regardless of the region asked for -- and `clearValue` ignores the
 * colour write mask too, because a clear produces no fragments for a mask to act
 * on. `StrafeField.clear` carries the neighbouring half of this note: it is why
 * clearing one field layer has to be a masked draw.
 *
 * Both the region clear and the texture paste therefore go through
 * `queue.writeTexture`, which takes an origin and a size directly. See
 * `zeroRegion`.
 */

import { compileModule } from '../gpu/shaderModule.ts';
import type { ParticleSystem } from '../particleSystem/particleSystem.ts';
import type { StrafeField } from '../strafeField/strafeField.ts';
import { ENTITY_STRIDE } from '../particleSystem/layout.ts';
import { type StampBox, boxIsEmpty, pixelRectFor } from './stampBox.ts';
import {
  type StampData,
  type StampLayer,
  STAMP_TEXEL_CHANNELS,
  layerIsEmpty,
  particleCount,
} from './stampData.ts';
import { toHalfBits } from './stampCodec.ts';
import {
  STAMP_CLEAR_WORKGROUP_SIZE,
  STAMP_PASTE_WORKGROUP_SIZE,
  stampGroups,
} from './stampDispatch.ts';

import clearSource from './shaders/stampClear.wgsl';
import pasteSource from './shaders/stampPaste.wgsl';

/** `vec4f` src box + `vec4f` dst box + `vec4u` params. Matches StampUniforms. */
const UNIFORM_SIZE = 48;

export class StampPaster {
  private readonly device: GPUDevice;
  private readonly system: ParticleSystem;
  private readonly field: StrafeField;

  private clearPipeline: GPUComputePipeline | null = null;
  private pastePipeline: GPUComputePipeline | null = null;
  private clearGroup: GPUBindGroup | null = null;
  private pasteLayout: GPUBindGroupLayout | null = null;

  private readonly clearUniforms: GPUBuffer;
  private readonly pasteUniforms: GPUBuffer;

  /**
   * The stamp's particles, uploaded for the paste.
   *
   * Grown on demand and reused, because a restore happens on every `R` and
   * allocating a multi-megabyte buffer per press would hitch the frame it
   * happens on -- which is precisely the frame the user is watching.
   */
  private upload: GPUBuffer | null = null;
  private uploadCapacity = 0;

  private constructor(device: GPUDevice, system: ParticleSystem, field: StrafeField) {
    this.device = device;
    this.system = system;
    this.field = field;
    const make = (label: string): GPUBuffer =>
      device.createBuffer({
        label,
        size: UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    this.clearUniforms = make('stamp-clear-uniforms');
    this.pasteUniforms = make('stamp-paste-uniforms');
  }

  static async create(
    device: GPUDevice,
    system: ParticleSystem,
    field: StrafeField,
  ): Promise<StampPaster> {
    const paster = new StampPaster(device, system, field);
    await paster.reload();
    return paster;
  }

  get ready(): boolean {
    return this.clearPipeline !== null && this.pastePipeline !== null;
  }

  private async reload(): Promise<void> {
    const device = this.device;
    const storage = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: 'storage' },
    });
    const readOnly = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: 'read-only-storage' },
    });
    const uniform = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: 'uniform' },
    });

    const clearLayout = device.createBindGroupLayout({
      label: 'stamp-clear',
      entries: [storage(0), storage(1), uniform(2)],
    });
    const pasteLayout = device.createBindGroupLayout({
      label: 'stamp-paste',
      entries: [storage(0), storage(1), readOnly(2), uniform(3)],
    });
    this.pasteLayout = pasteLayout;

    const [clearModule, pasteModule] = await Promise.all([
      compileModule(device, 'stampClear', clearSource),
      compileModule(device, 'stampPaste', pasteSource),
    ]);

    const entities = this.system.entityBufferForSand();
    const freeList = this.system.freeListBufferForSand();

    if (clearModule !== null) {
      this.clearPipeline = device.createComputePipeline({
        label: 'stamp-clear',
        layout: device.createPipelineLayout({ bindGroupLayouts: [clearLayout] }),
        compute: { module: clearModule, entryPoint: 'main' },
      });
      this.clearGroup = device.createBindGroup({
        label: 'stamp-clear',
        layout: clearLayout,
        entries: [
          { binding: 0, resource: { buffer: entities } },
          { binding: 1, resource: { buffer: freeList } },
          { binding: 2, resource: { buffer: this.clearUniforms } },
        ],
      });
    }

    if (pasteModule !== null) {
      this.pastePipeline = device.createComputePipeline({
        label: 'stamp-paste',
        layout: device.createPipelineLayout({ bindGroupLayouts: [pasteLayout] }),
        compute: { module: pasteModule, entryPoint: 'main' },
      });
    }
  }

  /**
   * Kill every particle in a box and return its slot to the pool.
   *
   * THE PARTICLE HALF ONLY. Textures are cleared by `clearTextures`, which is a
   * host-side write rather than a dispatch -- separated because a caller may
   * want one without the other (cutting particles while leaving the walls
   * standing is a legitimate stamp-tool gesture).
   *
   * ONLY EVER GIVES SLOTS BACK, so this may not share a pass with a paste. See
   * the class header.
   */
  clearParticles(encoder: GPUCommandEncoder, box: StampBox): boolean {
    if (this.clearPipeline === null || this.clearGroup === null) return false;
    if (boxIsEmpty(box)) return false;
    const entityCount = this.system.entityCount;
    if (entityCount <= 0) return false;

    this.device.queue.writeBuffer(
      this.clearUniforms,
      0,
      packStampUniforms(box, box, entityCount, 0, 0),
    );

    const pass = encoder.beginComputePass({ label: 'stamp-clear' });
    pass.setPipeline(this.clearPipeline);
    pass.setBindGroup(0, this.clearGroup);
    pass.dispatchWorkgroups(stampGroups(entityCount, STAMP_CLEAR_WORKGROUP_SIZE));
    pass.end();
    return true;
  }

  /**
   * Add a stamp's particles to the world.
   *
   * ALWAYS ADDITIVE. For replace, call `clearParticles` first -- see the class
   * header on why that composition is the design rather than a mode.
   *
   * `dstBox` is where the stamp lands. Passing the stamp's own box is the
   * identity placement, which the shader short-circuits so a restore into an
   * unchanged world is bit-exact.
   *
   * ONLY EVER TAKES SLOTS, so it may not share a pass with a clear.
   */
  pasteParticles(
    encoder: GPUCommandEncoder,
    stamp: StampData,
    dstBox: StampBox,
  ): boolean {
    if (this.pastePipeline === null || this.pasteLayout === null) return false;
    const count = particleCount(stamp);
    if (count <= 0) return false;

    this.ensureUpload(count);
    if (this.upload === null) return false;

    this.device.queue.writeBuffer(this.upload, 0, stamp.particles);
    this.device.queue.writeBuffer(
      this.pasteUniforms,
      0,
      // `params.x` counts the STAMP here, not the world -- the free list decides
      // where anything lands, so the world's entity count is irrelevant.
      packStampUniforms(stamp.box, dstBox, count, 0, 0),
    );

    // REBUILT PER PASTE, because the upload buffer is replaced when it grows.
    // A cached group holding a destroyed buffer is a validation error that
    // rejects the whole submit.
    const group = this.device.createBindGroup({
      label: 'stamp-paste',
      layout: this.pasteLayout,
      entries: [
        { binding: 0, resource: { buffer: this.system.entityBufferForSand() } },
        { binding: 1, resource: { buffer: this.system.freeListBufferForSand() } },
        { binding: 2, resource: { buffer: this.upload } },
        { binding: 3, resource: { buffer: this.pasteUniforms } },
      ],
    });

    const pass = encoder.beginComputePass({ label: 'stamp-paste' });
    pass.setPipeline(this.pastePipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(stampGroups(count, STAMP_PASTE_WORKGROUP_SIZE));
    pass.end();

    // THE MARK MUST RISE TO COVER WHAT WAS PASTED. Every pass over the entities
    // stops at the high-water mark, so particles placed above it would exist in
    // memory and be skipped by the physics and drawn by nothing -- present and
    // invisible. `noteSpawned` errs upward, which is the safe direction.
    this.system.noteSpawned(count);
    return true;
  }

  /**
   * Zero both texture layers over a box.
   *
   * A SCISSORED RENDER PASS per texture. See the class header on why this is not
   * `loadOp: 'clear'`: that ignores the write mask and the region both.
   *
   * The canvas is `rg16float` with one meaning, so it clears wholesale within
   * the box. The field packs two layers, and this clears BOTH -- a caller
   * wanting one should use `StrafeField.clear`, which is layer-masked. For the
   * initial-conditions restore both are correct, since the stamp carries both.
   */
  clearTextures(box: StampBox): void {
    this.zeroRegion(box, this.system.currentCanvasTextureObject(), this.system.canvasSize);
    this.zeroRegion(box, this.field.textureObject(), this.field.size);
  }

  /**
   * Write zeros over a texture region.
   *
   * ## Why a `writeTexture` of zeros rather than a render pass
   *
   * The obvious shape is a render pass with `loadOp: 'clear'` and a scissor, and
   * it does not work: the load operation runs BEFORE any scissor test, so it
   * clears the entire attachment regardless. `StrafeField.clear` documents the
   * neighbouring version of this trap -- that a `clearValue` also ignores the
   * colour write mask, which is why clearing one field layer has to be a masked
   * draw rather than a clear.
   *
   * The alternative is a draw of a zero-filled quad, which needs a pipeline, a
   * bind group and a vertex shader to move bytes that are already sitting on the
   * host. `writeTexture` puts them there directly, and routes through the same
   * path a paste's upload uses -- so there is one way a texture region is
   * written, not two that could drift.
   */
  private zeroRegion(
    box: StampBox,
    texture: GPUTexture,
    size: readonly [number, number],
  ): void {
    const rect = pixelRectFor(box, size);
    if (rect.width <= 0 || rect.height <= 0) return;
    const texels = rect.width * rect.height * STAMP_TEXEL_CHANNELS;
    this.writeRegion(
      texture,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      new Float32Array(texels),
    );
  }

  /**
   * Upload a layer's texels into a texture region.
   *
   * ## Via `writeTexture`, not a render pass
   *
   * The data is already on the host -- it came out of a `.fwld` file or is a
   * block of zeros -- so a render pass would mean uploading it to a buffer,
   * binding it, and drawing a quad to move it where `writeTexture` puts it
   * directly. The only thing a draw would add is blending, and a texture paste
   * is a replace within its region by construction: the region was cleared
   * first when replace was wanted, and left alone when additive was.
   *
   * ## The narrowing back to f16 happens here
   *
   * Both textures are half-float. `toHalfBits` is the codec's own conversion, so
   * a value that went to disk and came back writes the identical bit pattern it
   * was captured with.
   */
  private writeRegion(
    texture: GPUTexture,
    x: number,
    y: number,
    width: number,
    height: number,
    data: Float32Array,
  ): void {
    if (width <= 0 || height <= 0) return;
    const bits = toHalfBits(data);
    const bytesPerRow = width * STAMP_TEXEL_CHANNELS * 2;
    this.device.queue.writeTexture(
      { texture, origin: { x, y } },
      bits,
      // UNPADDED. `writeTexture` accepts any row stride, unlike
      // `copyTextureToBuffer`'s 256-byte rule -- which is why the upload path
      // needs no `packRows` and the readback path does.
      { bytesPerRow, rowsPerImage: height },
      { width, height },
    );
  }

  /**
   * Write a stamp's texture layers into the world at `dstBox`.
   *
   * ## Resampling is NEAREST, deliberately
   *
   * When the destination rect differs from the layer's captured size -- a world
   * loaded at a different World Size, or a rescaled stamp -- the texels are
   * resampled. Nearest rather than bilinear, because the WALLS layer is
   * structure: a bilinear filter smears a wall's edge into a soft gradient that
   * pushes particles in directions the author never painted, and a wall that
   * leaks is worse than one that is a texel jagged.
   *
   * At the identity size, which is every restore into an unchanged world, the
   * mapping is exact and no filtering of any kind occurs.
   */
  pasteTextures(stamp: StampData, dstBox: StampBox): void {
    this.pasteLayer(
      stamp.canvas,
      dstBox,
      this.system.currentCanvasTextureObject(),
      this.system.canvasSize,
    );
    this.pasteLayer(stamp.field, dstBox, this.field.textureObject(), this.field.size);
  }

  private pasteLayer(
    layer: StampLayer,
    dstBox: StampBox,
    texture: GPUTexture,
    size: readonly [number, number],
  ): void {
    if (layerIsEmpty(layer)) return;
    const rect = pixelRectFor(dstBox, size);
    if (rect.width <= 0 || rect.height <= 0) return;

    // THE IDENTITY CASE, short-circuited for the reason the position remap is:
    // a restore into an unchanged world must write back exactly what was
    // captured, with no resampling arithmetic in the path at all.
    if (rect.width === layer.width && rect.height === layer.height) {
      this.writeRegion(texture, rect.x, rect.y, rect.width, rect.height, layer.data);
      return;
    }

    const out = new Float32Array(rect.width * rect.height * STAMP_TEXEL_CHANNELS);
    for (let row = 0; row < rect.height; row++) {
      // Sample at the texel CENTRE, which is what keeps a resample from drifting
      // half a texel toward the origin.
      const srcRow = Math.min(
        layer.height - 1,
        Math.floor(((row + 0.5) / rect.height) * layer.height),
      );
      for (let col = 0; col < rect.width; col++) {
        const srcCol = Math.min(
          layer.width - 1,
          Math.floor(((col + 0.5) / rect.width) * layer.width),
        );
        const from = (srcRow * layer.width + srcCol) * STAMP_TEXEL_CHANNELS;
        const to = (row * rect.width + col) * STAMP_TEXEL_CHANNELS;
        for (let c = 0; c < STAMP_TEXEL_CHANNELS; c++) {
          out[to + c] = layer.data[from + c] ?? 0;
        }
      }
    }
    this.writeRegion(texture, rect.x, rect.y, rect.width, rect.height, out);
  }

  /**
   * Replace everything in a box with a stamp: clear, then paste.
   *
   * THE COMPOSITION THE CLASS HEADER DESCRIBES, in one place so that callers
   * wanting replace cannot get the order wrong or forget a half. An
   * initial-conditions restore is exactly this call over the whole world.
   *
   * ## The two particle passes are separate, and the order is not arbitrary
   *
   * The clear only GIVES slots and the paste only TAKES them, so each is
   * internally monotonic -- but they must not share a pass, or the head would
   * move both ways while an invocation held a reservation. Recording them as two
   * passes on one encoder is what WebGPU orders and barriers between.
   *
   * Clear first, so the slots it frees are available to the paste that follows.
   * Pasting first would place the new particles and then the clear would kill
   * them, since they are inside the very box being cleared.
   *
   * ## The textures do not ride the encoder
   *
   * `queue.writeTexture` is a queue operation, ordered against submissions
   * rather than recorded into one. That is correct here: both the zeroing and
   * the paste target the same region, the host sequences them, and no pass in
   * this encoder reads those textures before the frame ends.
   */
  restore(encoder: GPUCommandEncoder, stamp: StampData, dstBox: StampBox): boolean {
    if (!this.ready) return false;
    this.clearParticles(encoder, dstBox);
    this.clearTextures(dstBox);
    this.pasteTextures(stamp, dstBox);
    // AFTER the clear, as its own pass -- see above.
    this.pasteParticles(encoder, stamp, dstBox);
    return true;
  }

  private ensureUpload(count: number): void {
    if (this.upload !== null && count <= this.uploadCapacity) return;
    this.upload?.destroy();
    this.uploadCapacity = count;
    this.upload = this.device.createBuffer({
      label: 'stamp-upload',
      size: Math.max(ENTITY_STRIDE, count * ENTITY_STRIDE),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  destroy(): void {
    this.clearUniforms.destroy();
    this.pasteUniforms.destroy();
    this.upload?.destroy();
  }
}

/**
 * Pack the uniform block every stamp pass shares.
 *
 * Shared with `StampCopier` by shape rather than by import, because the two
 * classes own different buffers and neither should reach into the other's. The
 * LAYOUT is stated once in `stampBox.wgsl` and both pack to it; `stampShaders`
 * asserts the shader side.
 */
function packStampUniforms(
  src: StampBox,
  dst: StampBox,
  countOrEntities: number,
  totalIndex: number,
  capacity: number,
): ArrayBuffer {
  const buffer = new ArrayBuffer(UNIFORM_SIZE);
  const floats = new Float32Array(buffer);
  const uints = new Uint32Array(buffer);
  floats[0] = src.min[0];
  floats[1] = src.min[1];
  floats[2] = src.max[0];
  floats[3] = src.max[1];
  floats[4] = dst.min[0];
  floats[5] = dst.min[1];
  floats[6] = dst.max[0];
  floats[7] = dst.max[1];
  uints[8] = countOrEntities;
  uints[9] = totalIndex;
  uints[10] = capacity;
  uints[11] = 0;
  return buffer;
}

