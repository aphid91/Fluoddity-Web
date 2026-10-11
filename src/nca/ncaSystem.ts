/**
 * NcaSystem: the simulation backend that replaces `ParticleSystem` in the
 * studio. Owns every NCA GPU resource and nothing else.
 *
 * ## The seam it presents to the Orchestrator
 *
 * The particle system's per-frame contract, minus what only particles have:
 *
 *   prepareFrame(encoder)        init (after a reset) and this frame's brush stroke
 *   runSteps(encoder, onSubStep) the physics sub-steps; `onSubStep` is the
 *                                motion-blur hook, exactly as before
 *   renderDisplay(encoder)       state -> the texture the camera samples; call it
 *                                before every camera render
 *   applyProject(configs, world) the one place project state reaches the GPU
 *   requestPick / retrievePick   host-side: a cohort is a grid rectangle, so a
 *                                pick is arithmetic, not a GPU readback
 *
 * ## Architecture changes are asynchronous
 *
 * The step kernel is generated per architecture (`ncaShaders.ts`) and compiled
 * asynchronously, while `applyProject` is synchronous. So the running bundle --
 * pipelines, state buffers, weights -- keeps going until the new pipelines are
 * ready, then is swapped in whole. A change of CHANNEL count reallocates the
 * state and resets; any other architecture change keeps the state running.
 */

import { compileModule } from '../gpu/shaderModule.ts';
import { cohortAt, cohortIndexMap, cohortRects } from './cohortLayout.ts';
import { type NcaArch, type NcaConfig, type NcaWorld, archOf, sameArch } from './ncaConfig.ts';
import {
  BRUSH,
  PARAMS_SIZE,
  WORKGROUP,
  brushShader,
  displayShader,
  initShader,
  stepShader,
} from './ncaShaders.ts';
import { type BrushStroke, packParams, uvToCell } from './ncaUniforms.ts';
import { paramCount } from './paramLayout.ts';
import { allCohortWeights } from './weights.ts';

export { BRUSH };
export type { BrushStroke };

/** Uniform slot stride; covers `minUniformBufferOffsetAlignment` (<= 256). */
const SLOT = 256;

/**
 * A landed pick: which cohort, and which cell. A miss has `index` -1 (the
 * shape `CohortHighlight`'s `PickSample` reads) and `cell` null.
 */
export interface NcaPick {
  readonly key: number;
  /** Row-major cell index, or -1 for a miss. */
  readonly index: number;
  readonly cohort: number;
  readonly cell: readonly [number, number] | null;
}

export function isHit(pick: NcaPick | null): boolean {
  return pick !== null && pick.index >= 0;
}

export interface NcaSystemOptions {
  readonly device: GPUDevice;
  readonly config: NcaConfig;
  readonly world: NcaWorld;
  readonly gridSize: readonly [number, number];
  readonly physicsSteps?: number;
}

interface Layouts {
  readonly sim: GPUBindGroupLayout;
  readonly brush: GPUBindGroupLayout;
  readonly display: GPUBindGroupLayout;
}

interface Pipelines {
  readonly arch: NcaArch;
  readonly step: GPUComputePipeline;
  readonly init: GPUComputePipeline;
  readonly brush: GPUComputePipeline;
  readonly display: GPUComputePipeline;
}

/** What `weights` was last built from, so slider drags do not re-mutate. */
interface WeightsKey {
  readonly weights: readonly number[] | null;
  readonly mutationSeed: number;
  readonly mutationScale: number;
  readonly cohorts: number;
  readonly arch: NcaArch;
}

export class NcaSystem {
  private readonly device: GPUDevice;
  readonly canvasSize: readonly [number, number];
  physicsSteps: number;

  private config: NcaConfig;
  private world: NcaWorld;

  private readonly layouts: Layouts;
  private pipelines: Pipelines | null = null;
  /** Bumped per requested build; a build that resolves stale is dropped. */
  private buildGeneration = 0;
  private building: NcaArch | null = null;

  private stateA: GPUBuffer | null = null;
  private stateB: GPUBuffer | null = null;
  /** Which buffer holds the current state. */
  private currentIsA = true;
  private stateChannels = 0;

  private weightsBuffer: GPUBuffer | null = null;
  private weightsKey: WeightsKey | null = null;

  private readonly cmapBuffer: GPUBuffer;
  private rectsBuffer: GPUBuffer | null = null;
  private layoutCohorts = 0;
  private readonly wallsBuffer: GPUBuffer;

  private uniforms: GPUBuffer;
  private uniformSlots = 0;

  private readonly displayTexture: GPUTexture;
  private readonly displayView: GPUTextureView;

  /**
   * Bind groups, rebuilt whenever a buffer or pipeline changes. The init
   * kernel shares the step layout: initialising INTO A is the B->A group.
   */
  private groups: {
    stepAtoB: GPUBindGroup;
    stepBtoA: GPUBindGroup;
    brushA: GPUBindGroup;
    brushB: GPUBindGroup;
    displayA: GPUBindGroup;
    displayB: GPUBindGroup;
  } | null = null;

  /** Next free uniform slot this frame. Slot 0 is the frame's own. */
  private slotCursor = 1;

  private needsInit = true;
  private pendingBrush: BrushStroke[] = [];
  private wallsClearPending = false;
  private _frameCount = 0;
  private highlighted = -1;

  private pendingPick: NcaPick | null = null;
  private pickKey = 0;

  private constructor(opts: NcaSystemOptions) {
    this.device = opts.device;
    this.canvasSize = [opts.gridSize[0], opts.gridSize[1]];
    this.physicsSteps = opts.physicsSteps ?? 1;
    this.config = opts.config;
    this.world = opts.world;
    const [W, H] = this.canvasSize;

    this.cmapBuffer = this.device.createBuffer({
      label: 'nca-cohort-map',
      size: W * H * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.wallsBuffer = this.device.createBuffer({
      label: 'nca-walls',
      size: W * H * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.uniforms = this.makeUniforms(8);
    this.displayTexture = this.device.createTexture({
      label: 'nca-display',
      size: [W, H],
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.displayView = this.displayTexture.createView();
    this.layouts = this.makeLayouts();
  }

  /**
   * Explicit, because `layout: 'auto'` never has dynamic offsets -- and every
   * pass selects its `Params` slot by dynamic offset.
   */
  private makeLayouts(): Layouts {
    const C = GPUShaderStage.COMPUTE;
    const uniform: GPUBindGroupLayoutEntry = {
      binding: 0,
      visibility: C,
      buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: PARAMS_SIZE },
    };
    const ro = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: C,
      buffer: { type: 'read-only-storage' },
    });
    const rw = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: C,
      buffer: { type: 'storage' },
    });
    const device = this.device;
    return {
      sim: device.createBindGroupLayout({
        label: 'nca-sim',
        entries: [uniform, ro(1), rw(2), ro(3), ro(4), ro(5), ro(6)],
      }),
      brush: device.createBindGroupLayout({
        label: 'nca-brush',
        entries: [uniform, rw(1), rw(2)],
      }),
      display: device.createBindGroupLayout({
        label: 'nca-display',
        entries: [
          uniform,
          ro(1),
          ro(2),
          ro(3),
          ro(4),
          {
            binding: 5,
            visibility: C,
            storageTexture: { access: 'write-only', format: 'rgba16float' },
          },
        ],
      }),
    };
  }

  static async create(opts: NcaSystemOptions): Promise<NcaSystem> {
    const system = new NcaSystem(opts);
    system.uploadLayout();
    await system.build(archOf(opts.config));
    return system;
  }

  // -------------------------------------------------------------------------
  // Pipelines and buffers
  // -------------------------------------------------------------------------

  private makeUniforms(slots: number): GPUBuffer {
    this.uniformSlots = slots;
    return this.device.createBuffer({
      label: 'nca-params',
      size: slots * SLOT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  private async compile(arch: NcaArch): Promise<Pipelines | null> {
    const device = this.device;
    const make = async (
      label: string,
      code: string,
      layout: GPUBindGroupLayout,
    ): Promise<GPUComputePipeline | null> => {
      const module = await compileModule(device, label, code);
      if (module === null) return null;
      try {
        return await device.createComputePipelineAsync({
          label,
          layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
          compute: { module, entryPoint: 'main' },
        });
      } catch (err) {
        console.error(`[nca] pipeline ${label} failed`, err);
        return null;
      }
    };
    const [step, init, brush, display] = await Promise.all([
      make('nca-step', stepShader(arch), this.layouts.sim),
      make('nca-init', initShader(arch), this.layouts.sim),
      make('nca-brush', brushShader(arch), this.layouts.brush),
      make('nca-display', displayShader(arch), this.layouts.display),
    ]);
    if (step === null || init === null || brush === null || display === null) return null;
    return { arch, step, init, brush, display };
  }

  /** Compile `arch` and swap it in when ready (unless superseded). */
  private async build(arch: NcaArch): Promise<void> {
    const generation = ++this.buildGeneration;
    this.building = arch;
    const pipelines = await this.compile(arch);
    if (generation !== this.buildGeneration) return;
    this.building = null;
    if (pipelines === null) return;

    this.pipelines = pipelines;
    if (this.stateChannels !== arch.channels) {
      this.allocateState(arch.channels);
      this.needsInit = true;
    }
    this.uploadWeights(true);
    this.rebind();
  }

  private allocateState(channels: number): void {
    const [W, H] = this.canvasSize;
    this.stateA?.destroy();
    this.stateB?.destroy();
    const make = (label: string): GPUBuffer =>
      this.device.createBuffer({
        label,
        size: W * H * channels * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      });
    this.stateA = make('nca-state-a');
    this.stateB = make('nca-state-b');
    this.currentIsA = true;
    this.stateChannels = channels;
  }

  /** Cohort map + rects, for the current cohort count. */
  private uploadLayout(): void {
    const [W, H] = this.canvasSize;
    const n = Math.max(1, Math.round(this.config.cohorts));
    this.layoutCohorts = n;
    this.device.queue.writeBuffer(this.cmapBuffer, 0, cohortIndexMap(n, W, H));
    const rects = cohortRects(n, W, H);
    const data = new Uint32Array(n * 4);
    rects.forEach((r, i) => data.set([r.x0, r.y0, Math.max(1, r.w), Math.max(1, r.h)], i * 4));
    if (this.rectsBuffer === null || this.rectsBuffer.size < data.byteLength) {
      this.rectsBuffer?.destroy();
      this.rectsBuffer = this.device.createBuffer({
        label: 'nca-cohort-rects',
        size: Math.max(16, data.byteLength),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.groups = null;
    }
    this.device.queue.writeBuffer(this.rectsBuffer, 0, data);
  }

  /** Rebuild every cohort's weights if anything they derive from moved. */
  private uploadWeights(force = false): void {
    if (this.pipelines === null) return;
    const arch = this.pipelines.arch;
    // Weights must match the RUNNING architecture. A config whose architecture
    // is still compiling is uploaded when its build lands.
    if (!sameArch(arch, this.config)) return;
    const c = this.config;
    const key: WeightsKey = {
      weights: c.weights,
      mutationSeed: c.mutationSeed,
      mutationScale: c.mutationScale,
      cohorts: Math.max(1, Math.round(c.cohorts)),
      arch,
    };
    const prev = this.weightsKey;
    if (
      !force &&
      prev !== null &&
      prev.weights === key.weights &&
      prev.mutationSeed === key.mutationSeed &&
      prev.mutationScale === key.mutationScale &&
      prev.cohorts === key.cohorts &&
      sameArch(prev.arch, key.arch)
    ) {
      return;
    }
    this.weightsKey = key;
    const data = allCohortWeights({ ...c, ...arch });
    if (this.weightsBuffer === null || this.weightsBuffer.size < data.byteLength) {
      this.weightsBuffer?.destroy();
      this.weightsBuffer = this.device.createBuffer({
        label: 'nca-weights',
        size: Math.max(16, data.byteLength),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.groups = null;
    }
    this.device.queue.writeBuffer(this.weightsBuffer, 0, data);
  }

  private rebind(): void {
    const p = this.pipelines;
    if (p === null || this.stateA === null || this.stateB === null) return;
    if (this.weightsBuffer === null || this.rectsBuffer === null) return;
    const device = this.device;
    const L = this.layouts;
    const uniform = { buffer: this.uniforms, size: PARAMS_SIZE };
    const sim = (src: GPUBuffer, dst: GPUBuffer, label: string): GPUBindGroup =>
      device.createBindGroup({
        label,
        layout: L.sim,
        entries: [
          { binding: 0, resource: uniform },
          { binding: 1, resource: { buffer: src } },
          { binding: 2, resource: { buffer: dst } },
          { binding: 3, resource: { buffer: this.weightsBuffer! } },
          { binding: 4, resource: { buffer: this.cmapBuffer } },
          { binding: 5, resource: { buffer: this.rectsBuffer! } },
          { binding: 6, resource: { buffer: this.wallsBuffer } },
        ],
      });
    const brush = (state: GPUBuffer, label: string): GPUBindGroup =>
      device.createBindGroup({
        label,
        layout: L.brush,
        entries: [
          { binding: 0, resource: uniform },
          { binding: 1, resource: { buffer: state } },
          { binding: 2, resource: { buffer: this.wallsBuffer } },
        ],
      });
    const display = (state: GPUBuffer, label: string): GPUBindGroup =>
      device.createBindGroup({
        label,
        layout: L.display,
        entries: [
          { binding: 0, resource: uniform },
          { binding: 1, resource: { buffer: state } },
          { binding: 2, resource: { buffer: this.cmapBuffer } },
          { binding: 3, resource: { buffer: this.rectsBuffer! } },
          { binding: 4, resource: { buffer: this.wallsBuffer } },
          { binding: 5, resource: this.displayView },
        ],
      });
    this.groups = {
      stepAtoB: sim(this.stateA, this.stateB, 'nca-step-a-b'),
      stepBtoA: sim(this.stateB, this.stateA, 'nca-step-b-a'),
      brushA: brush(this.stateA, 'nca-brush-a'),
      brushB: brush(this.stateB, 'nca-brush-b'),
      displayA: display(this.stateA, 'nca-display-a'),
      displayB: display(this.stateB, 'nca-display-b'),
    };
  }

  private ensureBound(): boolean {
    if (this.groups === null) this.rebind();
    return this.groups !== null;
  }

  // -------------------------------------------------------------------------
  // Project state
  // -------------------------------------------------------------------------

  /**
   * The one place project state reaches the GPU. The studio simulates
   * `configs[0]`; the array is kept for the Project type's sake.
   */
  applyProject(configs: readonly NcaConfig[], world: NcaWorld): void {
    const config = configs[0];
    if (config === undefined) return;
    this.config = config;
    this.world = world;

    if (Math.max(1, Math.round(config.cohorts)) !== this.layoutCohorts) this.uploadLayout();

    const arch = archOf(config);
    const running = this.pipelines?.arch ?? null;
    const target = this.building ?? running;
    if (target === null || !sameArch(target, arch)) {
      void this.build(arch);
      return;
    }
    this.uploadWeights();
  }

  /** Restart from the initial conditions on the next frame. */
  reset(): void {
    this.needsInit = true;
  }

  /** Steps since the last reset. */
  get frameCount(): number {
    return this._frameCount;
  }

  /** The cohort the display dims around, or -1. */
  setHighlight(cohort: number): void {
    this.highlighted = cohort;
  }

  /** Queue a brush stroke for the next `prepareFrame`. */
  queueBrush(stroke: BrushStroke): void {
    this.pendingBrush.push(stroke);
  }

  clearWalls(): void {
    this.wallsClearPending = true;
  }

  // -------------------------------------------------------------------------
  // The frame
  // -------------------------------------------------------------------------

  private ensureUniformCapacity(slots: number): void {
    if (slots <= this.uniformSlots) return;
    this.uniforms.destroy();
    this.uniforms = this.makeUniforms(Math.max(slots, this.uniformSlots * 2));
    this.groups = null;
  }

  private params(step: number, brush: BrushStroke | null = null): ArrayBuffer {
    const [W, H] = this.canvasSize;
    return packParams({
      W,
      H,
      config: this.config,
      world: this.world,
      step,
      highlighted: this.highlighted,
      brush,
    });
  }

  private dispatch(
    encoder: GPUCommandEncoder,
    pipeline: GPUComputePipeline,
    group: GPUBindGroup,
    slot: number,
    label: string,
  ): void {
    const [W, H] = this.canvasSize;
    const pass = encoder.beginComputePass({ label });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group, [slot * SLOT]);
    pass.dispatchWorkgroups(Math.ceil(W / WORKGROUP), Math.ceil(H / WORKGROUP));
    pass.end();
  }

  /**
   * Everything a frame does BEFORE physics, in both the running and the paused
   * branch: a pending walls clear, the reset, and this frame's brush strokes.
   * Also writes slot 0, which `renderDisplay` reads -- so call this first.
   *
   * `steps` is how many sub-steps `runSteps` will take this frame. EVERY slot
   * the frame needs is reserved here, before anything is encoded: growing the
   * uniform buffer later would destroy a buffer the open encoder references.
   */
  prepareFrame(encoder: GPUCommandEncoder, steps: number): void {
    this.ensureUniformCapacity(1 + this.pendingBrush.length + Math.max(0, steps));
    this.slotCursor = 1;
    const p = this.pipelines;
    if (p === null || !this.ensureBound()) return;
    const g = this.groups!;
    const queue = this.device.queue;

    queue.writeBuffer(this.uniforms, 0, this.params(this._frameCount));

    if (this.wallsClearPending) {
      encoder.clearBuffer(this.wallsBuffer);
      this.wallsClearPending = false;
    }

    if (this.needsInit) {
      // Init writes `dst`: into A is the B->A group, into B the A->B one.
      this.dispatch(encoder, p.init, this.currentIsA ? g.stepBtoA : g.stepAtoB, 0, 'nca-init');
      this._frameCount = 0;
      this.needsInit = false;
    }

    for (const stroke of this.pendingBrush) {
      const slot = this.slotCursor++;
      queue.writeBuffer(this.uniforms, slot * SLOT, this.params(this._frameCount, stroke));
      this.dispatch(encoder, p.brush, this.currentIsA ? g.brushA : g.brushB, slot, 'nca-brush');
    }
    this.pendingBrush = [];
  }

  /**
   * The physics sub-steps. `onSubStep(encoder, i)` runs after each, which is
   * where the orchestrator takes motion-blur samples (calling `renderDisplay`
   * then the camera). Must follow `prepareFrame` in the same frame.
   */
  runSteps(
    encoder: GPUCommandEncoder,
    onSubStep?: (encoder: GPUCommandEncoder, step: number) => void,
  ): void {
    const p = this.pipelines;
    // Never more than `prepareFrame` reserved slots for.
    const steps = Math.min(
      Math.max(0, Math.trunc(this.physicsSteps)),
      this.uniformSlots - this.slotCursor,
    );
    if (p === null || this.groups === null) {
      for (let i = 0; i < steps; i++) onSubStep?.(encoder, i);
      return;
    }
    const base = this.slotCursor;
    this.slotCursor += steps;
    const queue = this.device.queue;
    for (let i = 0; i < steps; i++) {
      queue.writeBuffer(this.uniforms, (base + i) * SLOT, this.params(this._frameCount + i));
    }
    const g = this.groups;
    for (let i = 0; i < steps; i++) {
      this.dispatch(encoder, p.step, this.currentIsA ? g.stepAtoB : g.stepBtoA, base + i, 'nca-step');
      this.currentIsA = !this.currentIsA;
      onSubStep?.(encoder, i);
    }
    this._frameCount += steps;
  }

  /** Write the display texture from the current state; returns its view. */
  renderDisplay(encoder: GPUCommandEncoder): GPUTextureView {
    const p = this.pipelines;
    if (p !== null && this.ensureBound()) {
      const g = this.groups!;
      this.dispatch(encoder, p.display, this.currentIsA ? g.displayA : g.displayB, 0, 'nca-display');
    }
    return this.displayView;
  }

  /** The display texture. Written by `renderDisplay`. */
  currentCanvasTexture(): GPUTextureView {
    return this.displayView;
  }

  // -------------------------------------------------------------------------
  // Picking -- host-side
  // -------------------------------------------------------------------------

  /** Resolve a pick at canvas uv now; `retrievePick` hands it over. */
  requestPick(uv: readonly [number, number]): void {
    const [W, H] = this.canvasSize;
    const key = ++this.pickKey;
    const inside = uv[0] >= 0 && uv[0] <= 1 && uv[1] >= 0 && uv[1] <= 1;
    if (!inside) {
      this.pendingPick = { key, index: -1, cohort: -1, cell: null };
      return;
    }
    const cell = uvToCell(uv, W, H);
    this.pendingPick = {
      key,
      index: cell[1] * W + cell[0],
      cohort: cohortAt(this.config.cohorts, W, H, cell[0], cell[1]),
      cell,
    };
  }

  /** A pick that lands on `cohort` itself (its centre cell): Enter's confirm. */
  requestCohortPick(cohort: number): void {
    const [W, H] = this.canvasSize;
    const rect = cohortRects(this.config.cohorts, W, H)[cohort];
    const key = ++this.pickKey;
    if (rect === undefined) {
      this.pendingPick = { key, index: -1, cohort: -1, cell: null };
      return;
    }
    const cell: [number, number] = [rect.x0 + (rect.w >> 1), rect.y0 + (rect.h >> 1)];
    this.pendingPick = { key, index: cell[1] * W + cell[0], cohort, cell };
  }

  /** Destructive read of the last pick, mirroring the particle API. */
  retrievePick(): NcaPick | null {
    const pick = this.pendingPick;
    this.pendingPick = null;
    return pick;
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  get paramCount(): number {
    return paramCount(this.config);
  }

  get channels(): number {
    return this.stateChannels;
  }

  /** Whether an architecture build is in flight. */
  get rebuilding(): boolean {
    return this.building !== null;
  }

  /** Read the current state back. For the parity check and debugging. */
  async readState(): Promise<Float32Array> {
    const src = this.currentIsA ? this.stateA : this.stateB;
    if (src === null) return new Float32Array(0);
    const staging = this.device.createBuffer({
      size: src.size,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(src, 0, staging, 0, src.size);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return out;
  }

  /** Overwrite the current state. For the parity check. */
  writeState(data: Float32Array<ArrayBuffer>): void {
    const dst = this.currentIsA ? this.stateA : this.stateB;
    if (dst === null) return;
    this.device.queue.writeBuffer(dst, 0, data);
    this.needsInit = false;
  }

  /** Overwrite the walls mask (one u32 per cell). For the parity check. */
  writeWalls(data: Uint32Array<ArrayBuffer>): void {
    this.device.queue.writeBuffer(this.wallsBuffer, 0, data);
  }

  pipelineStatus(): Readonly<Record<string, boolean>> {
    return {
      ncaStep: this.pipelines !== null,
    };
  }

  destroy(): void {
    this.buildGeneration++;
    this.stateA?.destroy();
    this.stateB?.destroy();
    this.weightsBuffer?.destroy();
    this.rectsBuffer?.destroy();
    this.cmapBuffer.destroy();
    this.wallsBuffer.destroy();
    this.uniforms.destroy();
    this.displayTexture.destroy();
  }
}
