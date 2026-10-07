/**
 * Copying a region of the world out: three passes, then a readback.
 *
 * ## The shape, and what it borrows
 *
 * count -> scan -> scatter, which is `Compactor`'s shape minus the finalize
 * pass, with a BOX PREDICATE where the compaction has a liveness test. The scan
 * is not merely similar to the compaction's -- it is literally
 * `compactScan.wgsl`, sized by `compactPlan.ts`. That reuse is deliberate: the
 * multi-level scan is the subtlest arithmetic in the program, it has already
 * been debugged once against a failure that silently lost most of a large world,
 * and a second copy would be a second chance to get it wrong.
 *
 * ## THIS CLASS NEVER MUTATES THE WORLD
 *
 * The entity buffer is bound read-only, the free list is not bound at all, and
 * the high-water mark is untouched. A copy cannot disturb the scene it is
 * capturing, which is what makes it safe to run on the very frame the user
 * presses go -- the initial-conditions capture is exactly that.
 *
 * A CUT is this followed by `StampClearer`, as two ordered passes on one
 * encoder. That composition is why there is no cut mode here.
 *
 * ## Why the readback is explicit rather than automatic
 *
 * `record()` leaves the stamp in VRAM. `read()` is a separate, awaited call that
 * maps it to the host. The split matters because the two callers want different
 * things: the initial-conditions restore is GPU->GPU and must never pay a
 * readback, while saving a world needs the bytes and can afford to wait. Folding
 * the readback into the copy would tax the common path for the rare one.
 */

import { compileModule } from '../gpu/shaderModule.ts';
import type { ParticleSystem } from '../particleSystem/particleSystem.ts';
import type { StrafeField } from '../strafeField/strafeField.ts';
// The formats the shadow textures must match. A copy between textures of
// different formats is a validation error, so these come from the same
// constants the sources are created with rather than being restated.
import { CANVAS_FORMAT } from '../particleSystem/particleSystem.ts';
import { FIELD_FORMAT } from '../strafeField/fieldSize.ts';
import { ENTITY_STRIDE } from '../particleSystem/layout.ts';
import {
  compactGroups,
  scanGroups,
  scanLevelOffsets,
  scanLevelSizes,
  scanScratchSlots,
  partialCount,
  totalSlot,
} from '../particleSystem/compactPlan.ts';
import {
  type StampBox,
  type PixelRect,
  boxIsEmpty,
  pixelRectFor,
} from './stampBox.ts';
import {
  type StampLayer,
  type StampPaletteRef,
  channelsOf,
  emptyLayer,
} from './stampData.ts';
// THE CODEC'S OWN CONVERSION, imported rather than duplicated. That module is a
// leaf -- it imports nothing and touches no GPU type -- so there is no cycle and
// no reason for a second implementation of IEEE-754 half-float widening to exist
// in the program.
import { f16BitsToF32 } from './stampCodec.ts';
import {
  STAMP_WORKGROUP_SIZE,
  alignedBytesPerRow,
  particleBlockBytes,
  stampGroups,
  unpackRows,
} from './stampDispatch.ts';

import countSource from './shaders/stampCount.wgsl';
import scatterSource from './shaders/stampScatter.wgsl';
// THE COMPACTION'S OWN SCAN, not a copy of it. See the header.
import scanSource from '../sand/shaders/compactScan.wgsl';

/** `vec4f` src box + `vec4f` dst box + `vec4u` params. */
const UNIFORM_SIZE = 48;

/** Bytes per channel as the texture holds it: half-float. */
const BYTES_PER_CHANNEL = 2;

/**
 * A texture layer captured into VRAM, before readback.
 *
 * The rect is kept because the readback has to know how much to copy and the
 * unpack has to know the row stride -- both are functions of the rect, and
 * re-deriving them at read time would mean re-doing the world-to-pixel mapping
 * against a canvas that may have changed size since.
 */
interface StagedLayer {
  readonly rect: PixelRect;
  readonly buffer: GPUBuffer;
  readonly bytesPerRow: number;
  /** The source texture's own channel count -- see `channelsOf`. */
  readonly channels: number;
}

/**
 * A captured texture layer that never leaves the device.
 *
 * What `stageTexturesInVram` produces and what the initial-conditions restore
 * pastes from. Holds a TEXTURE rather than a buffer, so putting it back is a
 * `copyTextureToTexture` -- no row padding, no format conversion, exact bits.
 */
interface VramLayer {
  readonly rect: PixelRect;
  readonly texture: GPUTexture;
}

export class StampCopier {
  private readonly device: GPUDevice;
  private readonly system: ParticleSystem;
  private readonly field: StrafeField;

  private countPipeline: GPUComputePipeline | null = null;
  private scanPipeline: GPUComputePipeline | null = null;
  private addPipeline: GPUComputePipeline | null = null;
  private scatterPipeline: GPUComputePipeline | null = null;

  private countGroup: GPUBindGroup | null = null;
  private scatterGroup: GPUBindGroup | null = null;
  private scanGroupsPerLevel: GPUBindGroup[] = [];

  /** Per-workgroup match counts, then each scan level's partials. */
  private readonly scanScratch: GPUBuffer;
  /** The packed particles. Sized to the whole buffer -- see `ensureBlock`. */
  private block: GPUBuffer;
  private blockCapacity: number;

  private readonly uniforms: GPUBuffer;
  private readonly scanUniforms: GPUBuffer[] = [];

  /**
   * Staging for the particle count, so the host learns how many were captured.
   *
   * WITHOUT THIS THE HOST CANNOT SIZE THE READBACK. The count is the scan's
   * grand total, which lives in a slot of `scanScratch` that only the GPU wrote.
   * Reading the whole block back and scanning for dead entries would work and
   * would move megabytes to learn one number.
   */
  private readonly countStaging: GPUBuffer;

  /**
   * The captured texture layers, kept on the device.
   *
   * Reused across captures and reallocated only when the rect's SIZE changes --
   * a capture happens on every press of go, so allocating two textures each
   * time would churn VRAM on the exact frame the user is watching.
   */
  private vramCanvas: VramLayer | null = null;
  private vramField: VramLayer | null = null;

  private constructor(device: GPUDevice, system: ParticleSystem, field: StrafeField) {
    this.device = device;
    this.system = system;
    this.field = field;
    const entityCount = system.entityCount;

    this.scanScratch = device.createBuffer({
      label: 'stamp-scan-scratch',
      size: scanScratchSlots(entityCount) * 4,
      usage:
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.blockCapacity = entityCount;
    this.block = device.createBuffer({
      label: 'stamp-block',
      size: particleBlockBytes(entityCount, ENTITY_STRIDE),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.uniforms = device.createBuffer({
      label: 'stamp-uniforms',
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.countStaging = device.createBuffer({
      label: 'stamp-count-staging',
      size: 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    for (let i = 0; i < scanLevelSizes(partialCount(entityCount)).length; i++) {
      this.scanUniforms.push(
        device.createBuffer({
          label: `stamp-scan-uniforms-${i}`,
          size: 16,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      );
    }
  }

  static async create(
    device: GPUDevice,
    system: ParticleSystem,
    field: StrafeField,
  ): Promise<StampCopier> {
    const copier = new StampCopier(device, system, field);
    await copier.reload();
    return copier;
  }

  /** Whether every pipeline compiled. Callers decline to copy without it. */
  get ready(): boolean {
    return (
      this.countPipeline !== null &&
      this.scanPipeline !== null &&
      this.addPipeline !== null &&
      this.scatterPipeline !== null
    );
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

    const countLayout = device.createBindGroupLayout({
      label: 'stamp-count',
      entries: [readOnly(0), storage(1), uniform(2)],
    });
    const scanLayout = device.createBindGroupLayout({
      label: 'stamp-scan',
      entries: [storage(0), uniform(1)],
    });
    const scatterLayout = device.createBindGroupLayout({
      label: 'stamp-scatter',
      entries: [readOnly(0), storage(1), readOnly(2), uniform(3)],
    });

    const [countModule, scanModule, scatterModule] = await Promise.all([
      compileModule(device, 'stampCount', countSource),
      compileModule(device, 'compactScan', scanSource),
      compileModule(device, 'stampScatter', scatterSource),
    ]);

    // READ-ONLY, structurally. See the class header: a copy may not mutate.
    const entities = this.system.entityBufferForSand();

    if (countModule !== null) {
      this.countPipeline = device.createComputePipeline({
        label: 'stamp-count',
        layout: device.createPipelineLayout({ bindGroupLayouts: [countLayout] }),
        compute: { module: countModule, entryPoint: 'main' },
      });
      this.countGroup = device.createBindGroup({
        label: 'stamp-count',
        layout: countLayout,
        entries: [
          { binding: 0, resource: { buffer: entities } },
          { binding: 1, resource: { buffer: this.scanScratch } },
          { binding: 2, resource: { buffer: this.uniforms } },
        ],
      });
    }

    if (scanModule !== null) {
      const layout = device.createPipelineLayout({ bindGroupLayouts: [scanLayout] });
      this.scanPipeline = device.createComputePipeline({
        label: 'stamp-scan',
        layout,
        compute: { module: scanModule, entryPoint: 'main' },
      });
      // Same module, the fold-down entry point -- exactly as `Compactor` does.
      this.addPipeline = device.createComputePipeline({
        label: 'stamp-scan-add',
        layout,
        compute: { module: scanModule, entryPoint: 'add_offsets' },
      });
      this.scanGroupsPerLevel = this.scanUniforms.map((buffer, i) =>
        device.createBindGroup({
          label: `stamp-scan-${i}`,
          layout: scanLayout,
          entries: [
            { binding: 0, resource: { buffer: this.scanScratch } },
            { binding: 1, resource: { buffer } },
          ],
        }),
      );
    }

    if (scatterModule !== null) {
      this.scatterPipeline = device.createComputePipeline({
        label: 'stamp-scatter',
        layout: device.createPipelineLayout({ bindGroupLayouts: [scatterLayout] }),
        compute: { module: scatterModule, entryPoint: 'main' },
      });
      this.rebuildScatterGroup(scatterLayout);
    }
    this.scatterLayout = scatterLayout;
  }

  /** Kept so `ensureBlock` can rebuild the group when the block is replaced. */
  private scatterLayout: GPUBindGroupLayout | null = null;

  private rebuildScatterGroup(layout: GPUBindGroupLayout): void {
    this.scatterGroup = this.device.createBindGroup({
      label: 'stamp-scatter',
      layout,
      entries: [
        { binding: 0, resource: { buffer: this.system.entityBufferForSand() } },
        { binding: 1, resource: { buffer: this.block } },
        { binding: 2, resource: { buffer: this.scanScratch } },
        { binding: 3, resource: { buffer: this.uniforms } },
      ],
    });
  }

  /**
   * Record the three particle passes for a box.
   *
   * Returns false when a pipeline is missing or the box is empty, so the caller
   * can decline rather than record a partial copy.
   *
   * ## Why each stage is its own compute pass
   *
   * WebGPU orders passes within a submission and inserts the barriers between
   * them; dispatches inside one pass have no ordering guarantee. The scan reads
   * what count wrote and the scatter reads what the scan wrote, so each must see
   * the previous complete. `Compactor.record` splits for the identical reason.
   */
  record(encoder: GPUCommandEncoder, box: StampBox): boolean {
    if (!this.ready || this.scatterLayout === null) return false;
    if (boxIsEmpty(box)) return false;
    const entityCount = this.system.entityCount;
    if (entityCount <= 0) return false;

    this.ensureBlock(entityCount);

    const levels = scanLevelSizes(partialCount(entityCount));
    const offsets = scanLevelOffsets(entityCount);
    const total = totalSlot(entityCount);
    const queue = this.device.queue;

    // ALL UNIFORMS BEFORE ANY PASS OPENS. Queue writes may not be interleaved
    // with an open pass -- the same constraint `runFrame` works under.
    queue.writeBuffer(this.uniforms, 0, this.packUniforms(box, box, entityCount, total));
    for (let i = 0; i < levels.length; i++) {
      const isLast = i === levels.length - 1;
      queue.writeBuffer(
        this.scanUniforms[i]!,
        0,
        new Uint32Array([
          levels[i]!,
          offsets[i]!,
          // The last level writes the GRAND TOTAL to its reserved slot: an
          // exclusive scan discards it, and both the scatter and the host need
          // it. See `totalSlot`.
          isLast ? total : offsets[i + 1]!,
          isLast ? 1 : 0,
        ]),
      );
    }

    const count = encoder.beginComputePass({ label: 'stamp-count' });
    count.setPipeline(this.countPipeline!);
    count.setBindGroup(0, this.countGroup!);
    count.dispatchWorkgroups(stampGroups(entityCount, STAMP_WORKGROUP_SIZE));
    count.end();

    for (let i = 0; i < levels.length; i++) {
      const pass = encoder.beginComputePass({ label: `stamp-scan-${i}` });
      pass.setPipeline(this.scanPipeline!);
      pass.setBindGroup(0, this.scanGroupsPerLevel[i]!);
      pass.dispatchWorkgroups(scanGroups(levels[i]!));
      pass.end();
    }
    // Reverse order: the outermost level is scanned last and folds back first,
    // or a level would add offsets that are not yet scanned.
    for (let i = levels.length - 2; i >= 0; i--) {
      const pass = encoder.beginComputePass({ label: `stamp-scan-add-${i}` });
      pass.setPipeline(this.addPipeline!);
      pass.setBindGroup(0, this.scanGroupsPerLevel[i]!);
      pass.dispatchWorkgroups(compactGroups(levels[i]!));
      pass.end();
    }

    const scatter = encoder.beginComputePass({ label: 'stamp-scatter' });
    scatter.setPipeline(this.scatterPipeline!);
    scatter.setBindGroup(0, this.scatterGroup!);
    scatter.dispatchWorkgroups(stampGroups(entityCount, STAMP_WORKGROUP_SIZE));
    scatter.end();

    // The count, so the host can size its readback. Recorded onto this encoder
    // so it cannot observe a state earlier than the scan that produced it.
    encoder.copyBufferToBuffer(this.scanScratch, total * 4, this.countStaging, 0, 4);
    return true;
  }

  /**
   * The captured particle count, once the encoder holding `record` has been
   * submitted.
   *
   * SEPARATE FROM `record` because a mapAsync on an unsubmitted copy never
   * resolves -- it would wedge the readback forever, which is the trap
   * `Compactor.poll` and `pollFreeListRead` both carry notes about.
   */
  async readCount(): Promise<number> {
    await this.countStaging.mapAsync(GPUMapMode.READ);
    const data = new Uint32Array(this.countStaging.getMappedRange().slice(0));
    this.countStaging.unmap();
    return Math.min(data[0] ?? 0, this.blockCapacity);
  }

  /**
   * Record the two texture copies for a box.
   *
   * SEPARATE FROM THE PARTICLE PASSES because they are copies rather than
   * dispatches, and because a caller restoring initial conditions GPU-to-GPU
   * wants the textures without ever staging them to the host. Returns the
   * staging buffers, which the caller frees after reading.
   *
   * Returns null for an empty rect rather than a zero-sized buffer -- see
   * `particleBlockBytes` on why a zero-sized binding is a frame-killing error.
   */
  stageTextures(encoder: GPUCommandEncoder, box: StampBox): {
    canvas: StagedLayer | null;
    field: StagedLayer | null;
  } {
    return {
      canvas: this.stageOne(
        encoder,
        box,
        this.system.currentCanvasTextureObject(),
        this.system.canvasSize,
        'canvas',
      ),
      field: this.stageOne(
        encoder,
        box,
        this.field.textureObject(),
        this.field.size,
        'field',
      ),
    };
  }

  /**
   * Copy the two texture layers into VRAM-resident textures of their own.
   *
   * ## The counterpart of `stageTextures`, and why both exist
   *
   * That one stages to host-readable buffers, which is what SAVING a world
   * needs. This one keeps everything on the device, which is what the
   * initial-conditions capture needs: `R` should feel instant, and a readback
   * would add a frame or two of latency to buy nothing -- the bytes are already
   * on the right device and nothing between capture and restore reads them.
   *
   * ## `copyTextureToTexture`, not a buffer round trip
   *
   * A texture-to-texture copy has no 256-byte row rule to respect, does no
   * format conversion, and moves the exact bits. That is three ways this path
   * cannot go subtly wrong that the readback path has to actively handle -- and
   * it is why a restore into an unchanged world is bit-identical rather than
   * merely close.
   *
   * The shadow textures are allocated on first use and reused, sized to the
   * rect. A world-size change replaces them, because the rect changes with it.
   */
  stageTexturesInVram(encoder: GPUCommandEncoder, box: StampBox): void {
    this.vramCanvas = this.copyLayerToVram(
      encoder,
      box,
      this.system.currentCanvasTextureObject(),
      this.system.canvasSize,
      CANVAS_FORMAT,
      this.vramCanvas,
      'canvas',
    );
    this.vramField = this.copyLayerToVram(
      encoder,
      box,
      this.field.textureObject(),
      this.field.size,
      FIELD_FORMAT,
      this.vramField,
      'field',
    );
  }

  /** The VRAM-resident canvas layer from the last capture, if any. */
  get capturedCanvas(): VramLayer | null {
    return this.vramCanvas;
  }

  /** The VRAM-resident field layer from the last capture, if any. */
  get capturedField(): VramLayer | null {
    return this.vramField;
  }

  /** The packed particle block from the last capture. */
  get capturedBlock(): GPUBuffer {
    return this.block;
  }

  private copyLayerToVram(
    encoder: GPUCommandEncoder,
    box: StampBox,
    source: GPUTexture,
    size: readonly [number, number],
    format: GPUTextureFormat,
    existing: VramLayer | null,
    label: string,
  ): VramLayer | null {
    const rect = pixelRectFor(box, size);
    if (rect.width <= 0 || rect.height <= 0) return existing;

    let target = existing;
    if (
      target === null ||
      target.rect.width !== rect.width ||
      target.rect.height !== rect.height
    ) {
      target?.texture.destroy();
      target = {
        rect,
        texture: this.device.createTexture({
          label: `stamp-${label}-vram`,
          size: { width: rect.width, height: rect.height },
          format,
          usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
        }),
      };
    }

    encoder.copyTextureToTexture(
      { texture: source, origin: { x: rect.x, y: rect.y } },
      { texture: target.texture },
      { width: rect.width, height: rect.height },
    );
    // The rect is re-recorded because the ORIGIN may have moved even when the
    // size did not -- a box dragged elsewhere in a world of the same shape.
    return { rect, texture: target.texture };
  }

  private stageOne(
    encoder: GPUCommandEncoder,
    box: StampBox,
    texture: GPUTexture,
    size: readonly [number, number],
    label: string,
  ): StagedLayer | null {
    const rect = pixelRectFor(box, size);
    if (rect.width <= 0 || rect.height <= 0) return null;

    // THE 256-BYTE ROW RULE. `copyTextureToBuffer` rejects any other stride, and
    // a wrong one reads back an image sheared diagonally. `unpackRows` removes
    // the padding on the way out.
    // The texture's OWN texel size. A copy moves raw texels and never converts
    // format, so the layer must have exactly the texture's channels.
    const channels = channelsOf(texture.format);
    const bytesPerRow = alignedBytesPerRow(rect.width, channels * BYTES_PER_CHANNEL);
    const buffer = this.device.createBuffer({
      label: `stamp-${label}-staging`,
      size: bytesPerRow * rect.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    encoder.copyTextureToBuffer(
      { texture, origin: { x: rect.x, y: rect.y } },
      { buffer, bytesPerRow, rowsPerImage: rect.height },
      { width: rect.width, height: rect.height },
    );
    return { rect, buffer, bytesPerRow, channels };
  }

  /**
   * Read a staged layer back and free its buffer.
   *
   * ## The format widens here, on purpose
   *
   * Both textures are 16-bit float on the GPU, and `copyTextureToBuffer`
   * produces their raw bits -- so this reads `Uint16Array` and widens. It does
   * NOT read `Float32Array` directly, which would reinterpret two adjacent
   * half-floats as one garbage float. That mistake produces plausible-looking
   * noise rather than an error.
   */
  async readLayer(staged: StagedLayer | null, emptyChannels: number): Promise<StampLayer> {
    // Nothing was staged for an empty rect, so the caller says what an empty
    // layer of this kind looks like.
    if (staged === null) return emptyLayer(emptyChannels);
    await staged.buffer.mapAsync(GPUMapMode.READ);
    const raw = new Uint16Array(staged.buffer.getMappedRange().slice(0));
    staged.buffer.unmap();
    staged.buffer.destroy();

    const { rect, bytesPerRow, channels } = staged;
    // Widen first, then strip the row padding: the padding is measured in BYTES
    // and the unpack works in floats, so the stride converts once here.
    const widened = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) widened[i] = f16BitsToF32(raw[i] ?? 0);

    // The staged rows are `bytesPerRow` of HALF-floats; after widening each row
    // occupies twice as many bytes, so the stride doubles.
    const data = unpackRows(
      widened,
      rect.width,
      rect.height,
      channels,
      bytesPerRow * 2,
    );
    return { width: rect.width, height: rect.height, channels, data };
  }

  /** Read the packed particles back. Call after the encoder is submitted. */
  async readParticles(count: number): Promise<ArrayBuffer> {
    if (count <= 0) return new ArrayBuffer(0);
    const bytes = count * ENTITY_STRIDE;
    const staging = this.device.createBuffer({
      label: 'stamp-particle-staging',
      size: bytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = this.device.createCommandEncoder({ label: 'stamp-particle-read' });
    encoder.copyBufferToBuffer(this.block, 0, staging, 0, bytes);
    this.device.queue.submit([encoder.finish()]);

    await staging.mapAsync(GPUMapMode.READ);
    const out = staging.getMappedRange().slice(0);
    staging.unmap();
    staging.destroy();
    return out;
  }

  /**
   * Grow the packed block if the entity buffer has outgrown it.
   *
   * The block is sized to the WHOLE entity buffer rather than to an expected
   * match count, because the host cannot know how many particles fall inside a
   * box until the GPU has counted them -- and a box covering the whole world
   * matches everything. Sizing to the maximum removes the question.
   */
  private ensureBlock(entityCount: number): void {
    if (entityCount <= this.blockCapacity && this.scatterGroup !== null) return;
    this.block.destroy();
    this.blockCapacity = entityCount;
    this.block = this.device.createBuffer({
      label: 'stamp-block',
      size: particleBlockBytes(entityCount, ENTITY_STRIDE),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    if (this.scatterLayout !== null) this.rebuildScatterGroup(this.scatterLayout);
  }

  /**
   * Pack the shared uniform block.
   *
   * MUST BE CALLED AFTER `ensureBlock`. The capacity lane below reads
   * `this.blockCapacity`, which `ensureBlock` updates when it grows the buffer
   * -- so packing first would hand the scatter the OLD, smaller capacity and its
   * bound would silently drop every particle past it. The stamp would come back
   * short with no error anywhere, which is exactly the failure the bound exists
   * to make visible.
   *
   * `record` does them in that order; this note is what keeps a future reorder
   * from quietly undoing it.
   */
  private packUniforms(
    src: StampBox,
    dst: StampBox,
    entityCount: number,
    totalIndex: number,
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
    uints[8] = entityCount;
    uints[9] = totalIndex;
    uints[10] = this.blockCapacity;
    uints[11] = 0;
    return buffer;
  }

  /** The palette slots a captured set of particles references. */
  static paletteRefsFor(
    particles: ArrayBuffer,
    nameOf: (slot: number) => string,
  ): readonly StampPaletteRef[] {
    // `config_index` is misc.y -- float lane 5 of 8, read as an i32. The same
    // lane `deadEntityBytes` writes; asserted against the fixture there.
    const FLOATS_PER_ENTITY = 8;
    const CONFIG_INDEX_LANE = 5;
    const ints = new Int32Array(particles);
    const seen = new Set<number>();
    for (let i = 0; i * FLOATS_PER_ENTITY < ints.length; i++) {
      const slot = ints[i * FLOATS_PER_ENTITY + CONFIG_INDEX_LANE] ?? -1;
      if (slot >= 0) seen.add(slot);
    }
    return [...seen]
      .sort((a, b) => a - b)
      .map((slot) => ({ slot, name: nameOf(slot) }));
  }

  destroy(): void {
    this.scanScratch.destroy();
    this.block.destroy();
    this.uniforms.destroy();
    this.countStaging.destroy();
    this.vramCanvas?.texture.destroy();
    this.vramField?.texture.destroy();
    for (const buffer of this.scanUniforms) buffer.destroy();
  }
}

export type { StagedLayer, VramLayer };
