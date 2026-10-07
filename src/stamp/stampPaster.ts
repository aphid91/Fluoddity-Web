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
import type { VramLayer } from './stampCopier.ts';
import {
  type StampData,
  type StampLayer,
  channelsOf,
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

  /**
   * The highest slot a paste wrote, plus one. Written by the shader.
   *
   * ## Why this cannot be a host-side count
   *
   * The host knows how many particles it pasted and nothing about where they
   * went. `free_list_give` pushes freed indices in GPU scheduling order, so
   * after a region clear the pool is an arbitrary permutation and a paste
   * scatters across the whole buffer. Setting the mark from a count left live
   * particles above it -- invisible to every pass, with the brush appearing to
   * paint nothing. See the long note in `stampPaste.wgsl`.
   */
  private readonly highWater: GPUBuffer;
  private readonly highWaterStaging: GPUBuffer;
  /** Guards the readback: mapAsync on an unsubmitted copy never resolves. */
  private highWaterPhase: 'idle' | 'recorded' | 'mapping' = 'idle';

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
    this.highWater = device.createBuffer({
      label: 'stamp-high-water',
      size: 4,
      usage:
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.highWaterStaging = device.createBuffer({
      label: 'stamp-high-water-staging',
      size: 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
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
      entries: [storage(0), storage(1), readOnly(2), uniform(3), storage(4)],
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

    this.device.queue.writeBuffer(this.highWater, 0, new Uint32Array([0]));

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
        { binding: 4, resource: { buffer: this.highWater } },
      ],
    });

    const pass = encoder.beginComputePass({ label: 'stamp-paste' });
    pass.setPipeline(this.pastePipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(stampGroups(count, STAMP_PASTE_WORKGROUP_SIZE));
    pass.end();

    // THE WHOLE BUFFER, until the readback says otherwise -- the same two-stage
    // bound `pasteParticlesFrom` takes, and for the same reason: the free list
    // decides where these land and the host cannot predict it. `noteSpawned(count)`
    // was the bug here, adding a COUNT to the mark as though the particles had
    // been placed contiguously above it.
    this.system.restoreHighWaterMark(this.system.entityCount);

    if (this.highWaterPhase === 'idle') {
      encoder.copyBufferToBuffer(this.highWater, 0, this.highWaterStaging, 0, 4);
      this.highWaterPhase = 'recorded';
    }
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
    const texels = rect.width * rect.height * channelsOf(texture.format);
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
    // The texture's OWN texel size: `writeTexture` copies raw texels and never
    // converts format, so `data` must already be in the texture's layout.
    const bytesPerRow = width * channelsOf(texture.format) * 2;
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
    // REFUSED, not converted. A layer with another texel layout would be
    // written as scrambled texels, which is the bug this check replaces.
    if (layer.channels !== channelsOf(texture.format)) {
      console.error(
        `Stamp layer has ${layer.channels} channels; ${texture.label} has ` +
          `${channelsOf(texture.format)}. Not pasted.`,
      );
      return;
    }
    const ch = layer.channels;
    const rect = pixelRectFor(dstBox, size);
    if (rect.width <= 0 || rect.height <= 0) return;

    // THE IDENTITY CASE, short-circuited for the reason the position remap is:
    // a restore into an unchanged world must write back exactly what was
    // captured, with no resampling arithmetic in the path at all.
    if (rect.width === layer.width && rect.height === layer.height) {
      this.writeRegion(texture, rect.x, rect.y, rect.width, rect.height, layer.data);
      return;
    }

    const out = new Float32Array(rect.width * rect.height * ch);
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
        const from = (srcRow * layer.width + srcCol) * ch;
        const to = (row * rect.width + col) * ch;
        for (let c = 0; c < ch; c++) {
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
    return this.restoreInto(encoder, stamp, dstBox, dstBox);
  }

  /**
   * `restore`, clearing a LARGER box than the one pasted into. A world's
   * scene is placed as just its active region (`icFit.ts`), and whatever was
   * in the rest of the world must go too.
   */
  restoreInto(
    encoder: GPUCommandEncoder,
    stamp: StampData,
    clearBox: StampBox,
    dstBox: StampBox,
  ): boolean {
    if (!this.ready) return false;
    this.clearParticles(encoder, clearBox);
    this.clearTextures(clearBox);
    this.pasteTextures(stamp, dstBox);
    // AFTER the clear, as its own pass -- see above.
    this.pasteParticles(encoder, stamp, dstBox);
    return true;
  }

  /**
   * Replace a box from a stamp that never left the device.
   *
   * ## The GPU-only restore, and what it buys
   *
   * The same clear-then-paste composition as `restore`, with two differences,
   * both of which exist to keep `R` instant:
   *
   *   - the particles are pasted from the copier's own block, so no readback and
   *     no re-upload happen at all;
   *   - the textures are put back with `copyTextureToTexture`, which has no row
   *     padding, no format conversion, and moves the exact bits.
   *
   * The result is bit-identical to what was captured, which the host round trip
   * can only approach: that path narrows to f16 and widens again, and while
   * those conversions are individually lossless, having none of them in the path
   * is a stronger guarantee than having two that cancel.
   *
   * ## THE TEXTURE CLEAR IS SKIPPED, DELIBERATELY
   *
   * `restore` zeroes the region before writing it. This does not, because a
   * texture-to-texture copy REPLACES every texel it covers -- the destination
   * rect and the source rect are the same size by construction here, so there is
   * no uncovered remainder for a stale texel to survive in. Zeroing first would
   * be a full-region write whose every byte is then overwritten.
   *
   * The PARTICLE clear is still required: pasting is additive, so without it the
   * restored scene would be laid on top of the one already there.
   */
  restoreFromVram(
    encoder: GPUCommandEncoder,
    copier: {
      capturedBlock: GPUBuffer;
      capturedCanvas: VramLayer | null;
      capturedField: VramLayer | null;
    },
    box: StampBox,
  ): boolean {
    if (!this.ready) return false;

    this.clearParticles(encoder, box);

    // The textures first, so they are in place before the frame that resumes
    // reads them. Ordering against the compute passes does not matter -- no
    // pass in this encoder samples the canvas or the field -- but doing them
    // together keeps the scene's two halves visibly adjacent here.
    this.copyLayerBack(encoder, copier.capturedCanvas, this.system.currentCanvasTextureObject());
    this.copyLayerBack(encoder, copier.capturedField, this.field.textureObject());

    // AFTER the clear and as its own pass: the clear only gives slots and this
    // only takes them, and within one pass the head may move only one way.
    this.pasteParticlesFrom(encoder, copier.capturedBlock, box);
    return true;
  }

  /**
   * Put back the captured FIELD alone -- the walls -- from VRAM, leaving the
   * particles and the trail canvas as they are. Sand's "Restore initial walls".
   *
   * No clear first, for the reason `restoreFromVram` gives: the copy replaces
   * every texel of the captured rect.
   */
  restoreFieldFromVram(
    encoder: GPUCommandEncoder,
    copier: { capturedField: VramLayer | null },
  ): boolean {
    if (!this.ready || copier.capturedField === null) return false;
    this.copyLayerBack(encoder, copier.capturedField, this.field.textureObject());
    return true;
  }

  /**
   * The same from a stamp that has not been through VRAM yet -- a world's
   * scene before its first press of go. `clearBox` is zeroed first, as
   * `restoreInto` clears, since the scene may cover only part of it.
   */
  restoreField(stamp: StampData, clearBox: StampBox, dstBox: StampBox): boolean {
    if (!this.ready) return false;
    this.zeroRegion(clearBox, this.field.textureObject(), this.field.size);
    this.pasteLayer(stamp.field, dstBox, this.field.textureObject(), this.field.size);
    return true;
  }

  private copyLayerBack(
    encoder: GPUCommandEncoder,
    layer: VramLayer | null,
    destination: GPUTexture,
  ): void {
    if (layer === null) return;
    encoder.copyTextureToTexture(
      { texture: layer.texture },
      { texture: destination, origin: { x: layer.rect.x, y: layer.rect.y } },
      { width: layer.rect.width, height: layer.rect.height },
    );
  }

  /**
   * Paste particles from a GPU buffer that is already packed.
   *
   * ## Why the count comes from the host and not the buffer
   *
   * The paste dispatch is sized to the number of particles, and only the GPU
   * knows how many the capture matched -- the host would have to read it back,
   * which is the round trip this whole path exists to avoid.
   *
   * So the dispatch covers the WHOLE BLOCK and the shader skips dead entries.
   *
   * That is only correct because `stampScatter` CLEARS ITS TAIL. The block is
   * reused across captures, so without that clear the slots above this capture's
   * match count would still hold the previous capture's particles -- and this
   * dispatch, which cannot tell them apart from the current ones, would place
   * them. A reset key that resurrects erased particles is the symptom; see the
   * long note in `stampScatter.wgsl`.
   */
  private pasteParticlesFrom(
    encoder: GPUCommandEncoder,
    block: GPUBuffer,
    box: StampBox,
  ): boolean {
    if (this.pastePipeline === null || this.pasteLayout === null) return false;
    // One invocation per slot in the block. The shader returns immediately on a
    // dead entry, so the tail costs one read each -- the same shape `kill.wgsl`
    // uses when it sweeps the whole entity buffer.
    const capacity = Math.floor(block.size / ENTITY_STRIDE);
    if (capacity <= 0) return false;

    this.device.queue.writeBuffer(
      this.pasteUniforms,
      0,
      packStampUniforms(box, box, capacity, 0, 0),
    );

    // ZEROED FIRST, so the atomic max measures THIS paste rather than the
    // highest slot any previous one reached.
    this.device.queue.writeBuffer(this.highWater, 0, new Uint32Array([0]));

    const group = this.device.createBindGroup({
      label: 'stamp-paste-vram',
      layout: this.pasteLayout,
      entries: [
        { binding: 0, resource: { buffer: this.system.entityBufferForSand() } },
        { binding: 1, resource: { buffer: this.system.freeListBufferForSand() } },
        { binding: 2, resource: { buffer: block } },
        { binding: 3, resource: { buffer: this.pasteUniforms } },
        { binding: 4, resource: { buffer: this.highWater } },
      ],
    });

    const pass = encoder.beginComputePass({ label: 'stamp-paste-vram' });
    pass.setPipeline(this.pastePipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(stampGroups(capacity, STAMP_PASTE_WORKGROUP_SIZE));
    pass.end();

    // ---------------------------------------------------------------------
    // THE MARK, IN TWO STAGES: safe immediately, exact a few frames later.
    //
    // The true bound is the highest slot the paste wrote, which only the GPU
    // learns -- the free list hands out indices in an order no host-side count
    // can predict. But the mark has to be correct on THIS frame, and the
    // readback needs a submission plus a map.
    //
    // So the host takes the only bound it can prove synchronously: the whole
    // buffer. Every pasted particle is somewhere in [0, entityCount), so a mark
    // of `entityCount` cannot hide one. It is wasteful -- every pass sweeps the
    // full buffer until the readback lands -- and wasteful is the correct
    // direction. Too high costs invocations; too low loses particles.
    //
    // `takeHighWater` then lowers it to the measured value, and a compaction
    // lowers it further whenever one runs.
    // ---------------------------------------------------------------------
    this.system.restoreHighWaterMark(this.system.entityCount);

    if (this.highWaterPhase === 'idle') {
      encoder.copyBufferToBuffer(this.highWater, 0, this.highWaterStaging, 0, 4);
      this.highWaterPhase = 'recorded';
    }
    return true;
  }

  /**
   * Start the high-water readback. Call after submitting the encoder.
   *
   * SEPARATE FROM THE PASTE for the reason `Compactor.poll` is: a `mapAsync` on
   * a copy that has not been submitted never resolves, which would wedge the
   * readback in `mapping` forever and leave the mark pinned at the whole buffer
   * for the rest of the session.
   */
  poll(): void {
    if (this.highWaterPhase !== 'recorded') return;
    this.highWaterPhase = 'mapping';
    this.highWaterStaging.mapAsync(GPUMapMode.READ).then(
      () => {
        const data = new Uint32Array(this.highWaterStaging.getMappedRange().slice(0));
        this.highWaterStaging.unmap();
        this.pendingHighWater = data[0] ?? null;
        this.highWaterPhase = 'idle';
      },
      () => {
        // Device lost or buffer destroyed. Drop the answer rather than the
        // frame: the mark simply stays at the conservative bound, which is
        // slow but never wrong.
        this.highWaterPhase = 'idle';
      },
    );
  }

  /**
   * The measured high-water mark, if one has arrived. Reading it clears it.
   *
   * The CALLER applies it, because whether a mark may be lowered depends on
   * what has been spawned since -- state this class does not own. See
   * `noteCompactedMark`, which enforces the same direction rule.
   */
  takeHighWater(): number | null {
    const pending = this.pendingHighWater;
    this.pendingHighWater = null;
    return pending;
  }

  private pendingHighWater: number | null = null;

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
    this.highWater.destroy();
    // Set first, so an in-flight mapAsync callback finds a phase it will not
    // act on rather than touching a destroyed buffer.
    this.highWaterPhase = 'mapping';
    this.highWaterStaging.destroy();
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

