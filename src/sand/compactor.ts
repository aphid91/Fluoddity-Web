/**
 * GPU-only compaction: four passes that pack the entity buffer and rebuild the
 * free list, with no host involvement in any write.
 *
 * ## Why this module exists rather than another method on SandPasses
 *
 * It owns five pipelines, three scratch buffers and a readback state machine,
 * and it is the only thing in the program allowed to rewrite both the entity
 * buffer and the free list at once. That is enough to be its own thing, and
 * keeping it separate means the brush passes stay readable as brush passes.
 *
 * ## The protocol, which the caller must honour
 *
 * `record()` must be given a frame on which NOTHING ELSE touches the entity
 * buffer or the pool: no spawn, no kill, no `advance()`. It rewrites both
 * wholesale, so a concurrent take or give would be operating on state that is
 * about to be replaced.
 *
 * That is one dropped physics frame, and unlike the incremental design this
 * replaces, it is a single frame with a hard boundary -- there is no window to
 * guard, nothing to abort, and no generation to track. Compaction either
 * happened on this frame or it did not.
 *
 * ## What the old design got wrong, in one line
 *
 * It relocated particles into dead slots found by probing and never told the
 * free list those slots were consumed, leaking one per relocation. This one
 * writes the free list from scratch, so leaking is not possible to express.
 */

import { compileModule } from '../gpu/shaderModule.ts';
import type { ParticleSystem } from '../particleSystem/particleSystem.ts';
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

import countSource from './shaders/compactCount.wgsl';
import scanSource from './shaders/compactScan.wgsl';
import scatterSource from './shaders/compactScatter.wgsl';
import finalizeSource from './shaders/compactFinalize.wgsl';

/** `vec4u` of uniforms, the same shape for every pass here. */
const UNIFORM_SIZE = 16;

/**
 * Slots in the result buffer: the mark, and the generation that produced it.
 *
 * THE GENERATION IS WHAT MAKES THE READBACK SAFE. A mark that arrives without
 * one cannot be distinguished from an older mark arriving late, and applying a
 * stale mark that is too low hides live particles -- the worst failure this
 * subsystem has. Stamping it GPU-side means the host compares two numbers
 * rather than reasoning about timing.
 */
const RESULT_SLOTS = 2;

export class Compactor {
  private readonly device: GPUDevice;
  private readonly system: ParticleSystem;

  private countPipeline: GPUComputePipeline | null = null;
  private scanPipeline: GPUComputePipeline | null = null;
  private addPipeline: GPUComputePipeline | null = null;
  private scatterPipeline: GPUComputePipeline | null = null;
  private finalizePipeline: GPUComputePipeline | null = null;

  private countGroup: GPUBindGroup | null = null;
  private scatterGroup: GPUBindGroup | null = null;
  private finalizeGroup: GPUBindGroup | null = null;
  /** One per scan level, plus one per fold-down. Built in `reload`. */
  private scanGroupsPerLevel: GPUBindGroup[] = [];
  private addGroupsPerLevel: GPUBindGroup[] = [];

  /**
   * The scatter's destination.
   *
   * A FULL SECOND ENTITY BUFFER. The scatter cannot write in place -- an entity
   * moving from 500 to 12 races another invocation reading 12 -- and the result
   * is copied back rather than swapped in, so that the entity buffer OBJECT
   * never changes and every bind group in the program stays valid. The long
   * form of that reasoning is in `compactPlan.ts`.
   */
  private readonly scratchEntities: GPUBuffer;
  /** Per-workgroup live counts, then each scan level's partials. */
  private readonly scanScratch: GPUBuffer;
  /** `[mark, generation]`, written by the finalize pass. */
  private readonly result: GPUBuffer;
  private readonly resultStaging: GPUBuffer;

  private readonly countUniforms: GPUBuffer;
  private readonly scatterUniforms: GPUBuffer;
  private readonly finalizeUniforms: GPUBuffer;
  /** One per scan level: each needs its own count/base/next triple. */
  private readonly scanUniforms: GPUBuffer[] = [];

  private readbackPhase: 'idle' | 'recorded' | 'mapping' = 'idle';
  /** Bumped per compaction and stamped into the result. See `RESULT_SLOTS`. */
  private generation = 0;
  /** The generation whose mark the host has already consumed. */
  private appliedGeneration = -1;
  /** The most recent mark the GPU reported, or null if none is pending. */
  private pendingMark: { mark: number; generation: number } | null = null;

  private constructor(device: GPUDevice, system: ParticleSystem) {
    this.device = device;
    this.system = system;
    const entityCount = system.entityCount;

    this.scratchEntities = device.createBuffer({
      label: 'compact-scratch-entities',
      size: Math.max(ENTITY_STRIDE, entityCount * ENTITY_STRIDE),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.scanScratch = device.createBuffer({
      label: 'compact-scan-scratch',
      size: scanScratchSlots(entityCount) * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.result = device.createBuffer({
      label: 'compact-result',
      size: RESULT_SLOTS * 4,
      usage:
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.resultStaging = device.createBuffer({
      label: 'compact-result-staging',
      size: RESULT_SLOTS * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const makeUniform = (label: string): GPUBuffer =>
      device.createBuffer({
        label,
        size: UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    this.countUniforms = makeUniform('compact-count-uniforms');
    this.scatterUniforms = makeUniform('compact-scatter-uniforms');
    this.finalizeUniforms = makeUniform('compact-finalize-uniforms');
    for (let i = 0; i < scanLevelSizes(partialCount(entityCount)).length; i++) {
      this.scanUniforms.push(makeUniform(`compact-scan-uniforms-${i}`));
    }
  }

  static async create(device: GPUDevice, system: ParticleSystem): Promise<Compactor> {
    const c = new Compactor(device, system);
    await c.reload();
    return c;
  }

  /** Whether every pipeline compiled. The caller refuses to compact without it. */
  get ready(): boolean {
    return (
      this.countPipeline !== null &&
      this.scanPipeline !== null &&
      this.addPipeline !== null &&
      this.scatterPipeline !== null &&
      this.finalizePipeline !== null
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
      label: 'compact-count',
      entries: [readOnly(0), storage(1), uniform(2)],
    });
    const scanLayout = device.createBindGroupLayout({
      label: 'compact-scan',
      entries: [storage(0), uniform(1)],
    });
    const scatterLayout = device.createBindGroupLayout({
      label: 'compact-scatter',
      entries: [readOnly(0), storage(1), storage(2), readOnly(3), uniform(4)],
    });
    const finalizeLayout = device.createBindGroupLayout({
      label: 'compact-finalize',
      entries: [storage(0), readOnly(1), storage(2), uniform(3)],
    });

    const [countModule, scanModule, scatterModule, finalizeModule] = await Promise.all([
      compileModule(device, 'compactCount', countSource),
      compileModule(device, 'compactScan', scanSource),
      compileModule(device, 'compactScatter', scatterSource),
      compileModule(device, 'compactFinalize', finalizeSource),
    ]);

    const entities = this.system.entityBufferForSand();
    const freeList = this.system.freeListBufferForSand();

    if (countModule !== null) {
      this.countPipeline = device.createComputePipeline({
        label: 'compact-count',
        layout: device.createPipelineLayout({ bindGroupLayouts: [countLayout] }),
        compute: { module: countModule, entryPoint: 'main' },
      });
      this.countGroup = device.createBindGroup({
        label: 'compact-count',
        layout: countLayout,
        entries: [
          { binding: 0, resource: { buffer: entities } },
          { binding: 1, resource: { buffer: this.scanScratch } },
          { binding: 2, resource: { buffer: this.countUniforms } },
        ],
      });
    }

    if (scanModule !== null) {
      const layout = device.createPipelineLayout({ bindGroupLayouts: [scanLayout] });
      this.scanPipeline = device.createComputePipeline({
        label: 'compact-scan',
        layout,
        compute: { module: scanModule, entryPoint: 'main' },
      });
      // SAME MODULE, different entry point -- the fold-down shares the scan's
      // uniform layout so the two cannot disagree about which slice is which.
      this.addPipeline = device.createComputePipeline({
        label: 'compact-scan-add',
        layout,
        compute: { module: scanModule, entryPoint: 'add_offsets' },
      });
      this.scanGroupsPerLevel = this.scanUniforms.map((buffer, i) =>
        device.createBindGroup({
          label: `compact-scan-${i}`,
          layout: scanLayout,
          entries: [
            { binding: 0, resource: { buffer: this.scanScratch } },
            { binding: 1, resource: { buffer } },
          ],
        }),
      );
      // The fold-down reuses each level's uniforms, so the bind groups are the
      // same objects; kept as a second list only so `record` reads clearly.
      this.addGroupsPerLevel = this.scanGroupsPerLevel;
    }

    if (scatterModule !== null) {
      this.scatterPipeline = device.createComputePipeline({
        label: 'compact-scatter',
        layout: device.createPipelineLayout({ bindGroupLayouts: [scatterLayout] }),
        compute: { module: scatterModule, entryPoint: 'main' },
      });
      this.scatterGroup = device.createBindGroup({
        label: 'compact-scatter',
        layout: scatterLayout,
        entries: [
          { binding: 0, resource: { buffer: entities } },
          { binding: 1, resource: { buffer: this.scratchEntities } },
          { binding: 2, resource: { buffer: freeList } },
          { binding: 3, resource: { buffer: this.scanScratch } },
          { binding: 4, resource: { buffer: this.scatterUniforms } },
        ],
      });
    }

    if (finalizeModule !== null) {
      this.finalizePipeline = device.createComputePipeline({
        label: 'compact-finalize',
        layout: device.createPipelineLayout({ bindGroupLayouts: [finalizeLayout] }),
        compute: { module: finalizeModule, entryPoint: 'main' },
      });
      this.finalizeGroup = device.createBindGroup({
        label: 'compact-finalize',
        layout: finalizeLayout,
        entries: [
          { binding: 0, resource: { buffer: freeList } },
          { binding: 1, resource: { buffer: this.scanScratch } },
          { binding: 2, resource: { buffer: this.result } },
          { binding: 3, resource: { buffer: this.finalizeUniforms } },
        ],
      });
    }
  }

  /**
   * Record the whole compaction onto `encoder`.
   *
   * THE CALLER MUST SUPPRESS the brush passes and the physics on this frame --
   * see the module header. Returns false if a pipeline is missing, so the
   * caller can decline rather than run a partial compaction.
   *
   * ## Why every stage is its own compute pass
   *
   * WebGPU orders passes within a submission and inserts the barriers between
   * them; dispatches inside a single pass have no ordering guarantee. The scan
   * reads what count wrote, the scatter reads what the scan wrote, and finalize
   * reads what the scan wrote -- so each must be able to see the previous one
   * complete. `entityPick` splits its reduce and derive for exactly this.
   */
  record(encoder: GPUCommandEncoder): boolean {
    if (!this.ready) return false;
    const entityCount = this.system.entityCount;
    if (entityCount <= 0) return false;

    const partials = partialCount(entityCount);
    const levels = scanLevelSizes(partials);
    const offsets = scanLevelOffsets(entityCount);
    const queue = this.device.queue;

    this.generation++;

    // --- uniforms, all written before any pass opens ----------------------
    // Queue writes may not be interleaved with an open pass, which is the same
    // constraint `runFrame` and the brush passes work under.
    queue.writeBuffer(this.countUniforms, 0, new Uint32Array([entityCount, 0, 0, 0]));
    const total = totalSlot(entityCount);
    for (let i = 0; i < levels.length; i++) {
      const isLast = i === levels.length - 1;
      queue.writeBuffer(
        this.scanUniforms[i]!,
        0,
        new Uint32Array([
          levels[i]!,
          offsets[i]!,
          // THE LAST LEVEL POINTS AT THE RESERVED TOTAL SLOT, not at a next
          // level that does not exist. An exclusive scan discards the total, so
          // this is the only place the live count is ever written. See
          // `totalSlot`.
          isLast ? total : offsets[i + 1]!,
          isLast ? 1 : 0,
        ]),
      );
    }

    // --- 1. count ----------------------------------------------------------
    const count = encoder.beginComputePass({ label: 'compact-count' });
    count.setPipeline(this.countPipeline!);
    count.setBindGroup(0, this.countGroup!);
    count.dispatchWorkgroups(compactGroups(entityCount));
    count.end();

    // --- 2. scan, one pass per level, outermost first ----------------------
    for (let i = 0; i < levels.length; i++) {
      const pass = encoder.beginComputePass({ label: `compact-scan-${i}` });
      pass.setPipeline(this.scanPipeline!);
      pass.setBindGroup(0, this.scanGroupsPerLevel[i]!);
      pass.dispatchWorkgroups(scanGroups(levels[i]!));
      pass.end();
    }

    // --- 2b. fold each level's offsets back down, innermost first ----------
    // Reverse order: the outermost level is scanned last and must be added
    // back first, or a level would fold in offsets that are not yet scanned.
    for (let i = levels.length - 2; i >= 0; i--) {
      const pass = encoder.beginComputePass({ label: `compact-scan-add-${i}` });
      pass.setPipeline(this.addPipeline!);
      pass.setBindGroup(0, this.addGroupsPerLevel[i]!);
      pass.dispatchWorkgroups(compactGroups(levels[i]!));
      pass.end();
    }

    // --- the live total, for the scatter and finalize uniforms -------------
    // THE HOST DOES NOT KNOW IT, and passes the SLOT rather than the value.
    // Both shaders read the number the scan wrote there, which is exact on the
    // same submission. Every past attempt to have the host infer a live count
    // produced one that disagreed with the buffer.
    queue.writeBuffer(
      this.scatterUniforms,
      0,
      new Uint32Array([entityCount, total, 0, 0]),
    );
    queue.writeBuffer(
      this.finalizeUniforms,
      0,
      new Uint32Array([entityCount, total, this.generation, 0]),
    );

    // --- 3. scatter --------------------------------------------------------
    const scatter = encoder.beginComputePass({ label: 'compact-scatter' });
    scatter.setPipeline(this.scatterPipeline!);
    scatter.setBindGroup(0, this.scatterGroup!);
    scatter.dispatchWorkgroups(compactGroups(entityCount));
    scatter.end();

    // --- 4. finalize -------------------------------------------------------
    const finalize = encoder.beginComputePass({ label: 'compact-finalize' });
    finalize.setPipeline(this.finalizePipeline!);
    finalize.setBindGroup(0, this.finalizeGroup!);
    finalize.dispatchWorkgroups(1);
    finalize.end();

    // --- the copy back -----------------------------------------------------
    // AFTER the passes, so it is ordered behind the scatter by construction.
    // This is what keeps the entity buffer OBJECT stable; see compactPlan.ts.
    encoder.copyBufferToBuffer(
      this.scratchEntities,
      0,
      this.system.entityBufferForSand(),
      0,
      entityCount * ENTITY_STRIDE,
    );

    // The mark readback rides the same encoder, so it cannot observe a state
    // earlier than the compaction that produced it.
    if (this.readbackPhase === 'idle') {
      encoder.copyBufferToBuffer(this.result, 0, this.resultStaging, 0, RESULT_SLOTS * 4);
      this.readbackPhase = 'recorded';
    }
    return true;
  }

  /** Start the mark readback. Call after submitting the encoder. */
  poll(): void {
    if (this.readbackPhase !== 'recorded') return;
    this.readbackPhase = 'mapping';
    this.resultStaging.mapAsync(GPUMapMode.READ).then(
      () => {
        const data = new Uint32Array(this.resultStaging.getMappedRange().slice(0));
        this.resultStaging.unmap();
        const mark = data[0];
        const generation = data[1];
        if (mark !== undefined && generation !== undefined) {
          this.pendingMark = { mark, generation };
        }
        this.readbackPhase = 'idle';
      },
      () => {
        // Device lost or buffer destroyed. Drop the answer rather than the
        // frame -- the mark simply stays where it was, which is conservative.
        this.readbackPhase = 'idle';
      },
    );
  }

  /**
   * The mark the GPU computed, if one has arrived that has not been consumed.
   *
   * Returns null when there is nothing new. The CALLER decides whether to apply
   * it, because the safety rule depends on state this module does not own --
   * see `noteCompactedMark` in particleSystem.ts. Reading it clears it, so a
   * mark is offered exactly once.
   */
  takeMark(): number | null {
    const pending = this.pendingMark;
    if (pending === null) return null;
    if (pending.generation <= this.appliedGeneration) return null;
    this.appliedGeneration = pending.generation;
    this.pendingMark = null;
    return pending.mark;
  }

  destroy(): void {
    this.scratchEntities.destroy();
    this.scanScratch.destroy();
    this.result.destroy();
    this.countUniforms.destroy();
    this.scatterUniforms.destroy();
    this.finalizeUniforms.destroy();
    for (const buffer of this.scanUniforms) buffer.destroy();
    // Set first, so an in-flight mapAsync callback finds a phase it will not
    // act on rather than touching a destroyed buffer.
    this.readbackPhase = 'mapping';
    this.resultStaging.destroy();
  }
}
