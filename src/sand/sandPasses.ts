/**
 * The spawn and kill passes: pipelines, bind groups, and the dispatch.
 *
 * ## Why these live here and not on ParticleSystem
 *
 * `ParticleSystem` owns the simulation every app shares. Brushes are the sand
 * modality's, and folding them in would put a `spawnCount` and a stroke on the
 * class the studio uses, for a feature it does not have. This module reaches in
 * through the two narrow accessors (`entityBufferForSand`, `freeListBufferForSand`)
 * and owns everything else itself -- which is also what keeps the passes'
 * cadence visible at the one call site that records them.
 *
 * ## Cadence
 *
 * Both run ONCE PER RENDERED FRAME. Spawn is recorded before the sub-steps and
 * kill after, which is what keeps the free list's head monotonic within each:
 * spawn only takes, kill and edge-death only give. See `freeList.wgsl`.
 */

import { compileModule } from '../gpu/shaderModule.ts';
import type { ParticleSystem } from '../particleSystem/particleSystem.ts';
import type { WorldConfig } from '../particleSystem/config.ts';
import {
  type Stroke,
  COMPACT_UNIFORM_SIZE,
  KILL_UNIFORM_SIZE,
  SPAWN_UNIFORM_SIZE,
  SORT_UNIFORM_SIZE,
  packCompactUniforms,
  packKillUniforms,
  packSpawnUniforms,
  packSortUniforms,
} from './sandUniforms.ts';

import {
  COMPACT_MAX_PROBES,
  COMPACT_WORKGROUP_SIZE,
  KILL_WORKGROUP_SIZE,
  SORT_SLOT_BUDGET,
  SORT_WORKGROUP_SIZE,
  SPAWN_WORKGROUP_SIZE,
  workgroupsFor,
} from './sandDispatch.ts';

import spawnSource from './shaders/spawn.wgsl';
import killSource from './shaders/kill.wgsl';
import sortSource from './shaders/freeListSort.wgsl';
import compactSource from './shaders/compact.wgsl';

// Re-exported so callers have one import for the passes. The definitions live in
// `sandDispatch.ts` because this module imports `.wgsl`, which only resolves
// through the Vite plugin -- the same split `particleSystem.ts` makes.
export {
  COMPACT_MAX_PROBES,
  COMPACT_SLOT_BUDGET,
  COMPACT_WORKGROUP_SIZE,
  KILL_WORKGROUP_SIZE,
  SORT_SLOT_BUDGET,
  SORT_WORKGROUP_SIZE,
  SPAWN_WORKGROUP_SIZE,
  workgroupsFor,
} from './sandDispatch.ts';

export class SandPasses {
  private readonly device: GPUDevice;
  private readonly system: ParticleSystem;

  private spawnPipeline: GPUComputePipeline | null = null;
  private killPipeline: GPUComputePipeline | null = null;
  private sortPipeline: GPUComputePipeline | null = null;
  private compactPipeline: GPUComputePipeline | null = null;
  private spawnGroup: GPUBindGroup | null = null;
  private killGroup: GPUBindGroup | null = null;
  private sortGroup: GPUBindGroup | null = null;
  private compactGroup: GPUBindGroup | null = null;

  private readonly spawnUniforms: GPUBuffer;
  private readonly killUniforms: GPUBuffer;
  private readonly sortUniforms: GPUBuffer;
  private readonly compactUniforms: GPUBuffer;

  /**
   * The sweep's own allocator: `{ next, moved }`, both atomics.
   *
   * DELIBERATELY NOT THE FREE LIST. Taking destinations from the pool would put
   * this pass into the monotonic-head protocol while the eraser is also moving
   * the head, which is the one interleaving `freeList.wgsl` forbids. This cursor
   * is owned outright by the compaction pass and touched by nothing else. See
   * the header of `compact.wgsl`.
   */
  private readonly compactCursor: GPUBuffer;
  /** 8 bytes, for reading `moved` back. Same deferred shape as the head read. */
  private readonly compactStaging: GPUBuffer;
  /** Same state machine as the free-list head readback, for the same reasons. */
  private compactPhase: 'idle' | 'recorded' | 'mapping' = 'idle';
  /** Relocations counted by the last completed readback. */
  private movedTotal = 0;

  /**
   * Which disjoint pairs the next ordering phase compares. Flipped every time
   * the pass is recorded.
   *
   * WITHOUT THE ALTERNATION THE SORT REACHES A FIXED POINT THAT IS NOT SORTED:
   * comparing the same pairs forever lets nothing migrate past its neighbour.
   * Kept here rather than passed in because it is the pass's own business, and a
   * caller that forgot to advance it would produce a pass that runs and does
   * nothing -- the quietest possible failure.
   */
  private sortParity = 0;

  private constructor(device: GPUDevice, system: ParticleSystem) {
    this.device = device;
    this.system = system;
    this.spawnUniforms = device.createBuffer({
      label: 'spawn-uniforms',
      size: SPAWN_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.killUniforms = device.createBuffer({
      label: 'kill-uniforms',
      size: KILL_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.sortUniforms = device.createBuffer({
      label: 'freelist-sort-uniforms',
      size: SORT_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.compactUniforms = device.createBuffer({
      label: 'compact-uniforms',
      size: COMPACT_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.compactCursor = device.createBuffer({
      label: 'compact-cursor',
      // Two u32 atomics: `next` and `moved`.
      size: 8,
      usage:
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.compactStaging = device.createBuffer({
      label: 'compact-cursor-staging',
      size: 8,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  static async create(device: GPUDevice, system: ParticleSystem): Promise<SandPasses> {
    const passes = new SandPasses(device, system);
    await passes.reload();
    return passes;
  }

  /**
   * Compile and wire both passes.
   *
   * Invariant 5's shape: a compile failure is logged and leaves the pipeline
   * null, and `spawn`/`kill` guard on that rather than throwing. A sand app whose
   * brushes failed to compile still runs and still renders -- it just cannot
   * paint, which is a far better failure than a blank page.
   */
  private async reload(): Promise<void> {
    const device = this.device;

    const layout = device.createBindGroupLayout({
      label: 'sand-brush',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });

    // ITS OWN LAYOUT, because the ordering pass binds two resources rather than
    // three: it touches the free list and its own uniform, and has no reason to
    // see the entity buffer at all. Reusing the brush layout would bind the
    // entities to a pass that must never write one, which is exactly the
    // confusion worth spending a second layout to avoid.
    const sortLayout = device.createBindGroupLayout({
      label: 'freelist-sort',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    const sortPipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [sortLayout],
    });

    // The compaction pass binds entities, its own cursor, and a uniform. It
    // does NOT bind the free list -- it must not touch the pool while the
    // eraser is moving the head, and not binding it is the strongest available
    // statement of that. See the header of `compact.wgsl`.
    const compactLayout = device.createBindGroupLayout({
      label: 'compact',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    const compactPipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [compactLayout],
    });

    const [spawnModule, killModule, sortModule, compactModule] = await Promise.all([
      compileModule(device, 'spawn', spawnSource),
      compileModule(device, 'kill', killSource),
      compileModule(device, 'freeListSort', sortSource),
      compileModule(device, 'compact', compactSource),
    ]);

    const entities = this.system.entityBufferForSand();
    const freeList = this.system.freeListBufferForSand();

    if (spawnModule !== null) {
      this.spawnPipeline = device.createComputePipeline({
        label: 'spawn',
        layout: pipelineLayout,
        compute: { module: spawnModule, entryPoint: 'main' },
      });
      this.spawnGroup = device.createBindGroup({
        label: 'spawn',
        layout,
        entries: [
          { binding: 0, resource: { buffer: entities } },
          { binding: 1, resource: { buffer: freeList } },
          { binding: 2, resource: { buffer: this.spawnUniforms } },
        ],
      });
    }

    if (killModule !== null) {
      this.killPipeline = device.createComputePipeline({
        label: 'kill',
        layout: pipelineLayout,
        compute: { module: killModule, entryPoint: 'main' },
      });
      this.killGroup = device.createBindGroup({
        label: 'kill',
        layout,
        entries: [
          { binding: 0, resource: { buffer: entities } },
          { binding: 1, resource: { buffer: freeList } },
          { binding: 2, resource: { buffer: this.killUniforms } },
        ],
      });
    }

    if (sortModule !== null) {
      this.sortPipeline = device.createComputePipeline({
        label: 'freelist-sort',
        layout: sortPipelineLayout,
        compute: { module: sortModule, entryPoint: 'main' },
      });
      this.sortGroup = device.createBindGroup({
        label: 'freelist-sort',
        layout: sortLayout,
        entries: [
          { binding: 0, resource: { buffer: freeList } },
          { binding: 1, resource: { buffer: this.sortUniforms } },
        ],
      });
    }

    if (compactModule !== null) {
      this.compactPipeline = device.createComputePipeline({
        label: 'compact',
        layout: compactPipelineLayout,
        compute: { module: compactModule, entryPoint: 'main' },
      });
      this.compactGroup = device.createBindGroup({
        label: 'compact',
        layout: compactLayout,
        entries: [
          { binding: 0, resource: { buffer: entities } },
          { binding: 1, resource: { buffer: this.compactCursor } },
          { binding: 2, resource: { buffer: this.compactUniforms } },
        ],
      });
    }
  }

  /**
   * Record the creation pass.
   *
   * MUST BE RECORDED BEFORE THE SUB-STEPS, so that nothing returns a slot to the
   * pool while this one is taking them -- the head has to move only downward for
   * the whole pass. `count` of 0 records nothing at all.
   *
   * Note `writeBuffer` before the encoder's passes rather than between them:
   * queue writes may not be interleaved with an open pass, which is the same
   * constraint that makes `runFrame` write all its uniforms up front.
   */
  spawn(
    encoder: GPUCommandEncoder,
    world: WorldConfig,
    stroke: Stroke,
    count: number,
    configIndex: number,
    frame: number,
  ): void {
    if (this.spawnPipeline === null || this.spawnGroup === null) return;
    if (count <= 0) return;

    this.device.queue.writeBuffer(
      this.spawnUniforms,
      0,
      packSpawnUniforms(world, stroke, count, configIndex, frame),
    );

    const pass = encoder.beginComputePass({ label: 'spawn' });
    pass.setPipeline(this.spawnPipeline);
    pass.setBindGroup(0, this.spawnGroup);
    pass.dispatchWorkgroups(workgroupsFor(count, SPAWN_WORKGROUP_SIZE));
    pass.end();
  }

  /**
   * Record the eraser pass.
   *
   * MUST BE RECORDED AFTER THE SUB-STEPS. It only ever gives slots back, which
   * is the same direction edge-death moves the head inside `advance()`, so the
   * two compose. Dispatches over the whole buffer -- only the GPU knows which
   * particles are under the brush.
   */
  kill(encoder: GPUCommandEncoder, world: WorldConfig, stroke: Stroke): void {
    if (this.killPipeline === null || this.killGroup === null) return;
    if (stroke.radius <= 0) return;

    this.device.queue.writeBuffer(this.killUniforms, 0, packKillUniforms(world, stroke));

    const pass = encoder.beginComputePass({ label: 'kill' });
    pass.setPipeline(this.killPipeline);
    pass.setBindGroup(0, this.killGroup);
    pass.dispatchWorkgroups(
      workgroupsFor(this.system.entityCount, KILL_WORKGROUP_SIZE),
    );
    pass.end();
  }

  /**
   * Record one phase of the free-list ordering pass -- TIER 1 COMPACTION.
   *
   * Moves no particle and changes no liveness: it only permutes the available
   * region of the pool so the LOWEST free index pops next, which is what stops
   * the high-water mark creeping as the eraser scatters freed indices. See the
   * header of `freeListSort.wgsl`.
   *
   * ## MUST NOT BE RECORDED ON A FRAME THAT SPAWNED
   *
   * This is the one real hazard and the caller cannot see it, so it is enforced
   * here. The pass never touches `head`, so it composes with anything that only
   * moves the head -- including the eraser, which appends at `slots[head]` and
   * above, outside the region this reorders.
   *
   * SPAWN IS DIFFERENT. It pops `slots[head-1]`, which is inside the region and
   * is in fact the very entry the ordering pass is trying to make smallest. The
   * two racing on that slot could hand one index to a particle while this pass
   * moves it elsewhere -- a double allocation, which is the failure the whole
   * free-list protocol is built to prevent.
   *
   * Skipping the frame entirely is the fix, and it costs nothing: ordering is a
   * background tidy with no deadline, and a frame where the user is painting is
   * a frame where the pool is being consumed rather than fragmented.
   */
  sortFreeList(encoder: GPUCommandEncoder, spawnedThisFrame: boolean): void {
    if (this.sortPipeline === null || this.sortGroup === null) return;
    // See the note above: never alongside the creation pass.
    if (spawnedThisFrame) return;
    // Nothing to order in a world with no pool at all.
    if (this.system.entityCount <= 1) return;

    const window = Math.min(SORT_SLOT_BUDGET, this.system.entityCount);
    this.device.queue.writeBuffer(
      this.sortUniforms,
      0,
      packSortUniforms(this.sortParity, window),
    );
    // Flip for next time. Comparing the same disjoint pairs forever would reach
    // a fixed point that is not sorted.
    this.sortParity = this.sortParity === 0 ? 1 : 0;

    const pass = encoder.beginComputePass({ label: 'freelist-sort' });
    pass.setPipeline(this.sortPipeline);
    pass.setBindGroup(0, this.sortGroup);
    // ONE INVOCATION PER PAIR, so half as many as there are slots in the window.
    pass.dispatchWorkgroups(workgroupsFor(window / 2, SORT_WORKGROUP_SIZE));
    pass.end();
  }

  // =========================================================================
  // TIER 2 -- the compaction sweep
  // =========================================================================

  /** Whether the compaction pass compiled. The Dev panel refuses to start a
   *  sweep without it, rather than running one that silently moves nothing. */
  get canCompact(): boolean {
    return this.compactPipeline !== null && this.compactGroup !== null;
  }

  /**
   * Reset the sweep's allocator to the start of a new sweep.
   *
   * `next` begins at 0 so destinations are handed out from the bottom of the
   * buffer upward -- the same direction `initialFreeList` allocates, and for the
   * same reason: packing must run toward index 0, not away from it.
   *
   * Called once per sweep, never per chunk. A per-chunk reset would send every
   * chunk back to probing from zero over ground the previous chunk already
   * filled, turning a linear sweep into a quadratic one.
   */
  beginSweep(): void {
    this.device.queue.writeBuffer(this.compactCursor, 0, new Uint32Array([0, 0]));
    this.movedTotal = 0;
  }

  /**
   * Record one chunk of the sweep: relocate live particles in `[lo, hi)` down
   * into dead slots below `target`.
   *
   * MUST NOT BE RECORDED ALONGSIDE A SPAWN. Mid-sweep the free list may still
   * list slots this pass has filled, so a brush taking one would overwrite a
   * live particle. The host refuses to spawn while a sweep is in flight, and
   * painting aborts the sweep outright -- see `sandOrchestrator.ts`.
   *
   * Safe alongside the ERASER, which only marks particles dead and pushes their
   * indices. A particle erased while being relocated is erased at one index or
   * the other; either way it ends up dead, and the slot it vacated is dead too.
   */
  compactChunk(
    encoder: GPUCommandEncoder,
    lo: number,
    hi: number,
    target: number,
  ): void {
    if (this.compactPipeline === null || this.compactGroup === null) return;
    if (hi <= lo) return;

    this.device.queue.writeBuffer(
      this.compactUniforms,
      0,
      packCompactUniforms(lo, hi, target, COMPACT_MAX_PROBES),
    );

    const pass = encoder.beginComputePass({ label: 'compact' });
    pass.setPipeline(this.compactPipeline);
    pass.setBindGroup(0, this.compactGroup);
    pass.dispatchWorkgroups(workgroupsFor(hi - lo, COMPACT_WORKGROUP_SIZE));
    pass.end();
  }

  /**
   * Record a copy of the sweep cursor, for the progress readout.
   *
   * DEFERRED, never synchronous -- the same shape and the same reason as
   * `recordFreeListRead`. The count feeds a readout, not a decision: whether the
   * sweep completes is determined by the host's own cursor arithmetic, which
   * does not depend on this at all.
   */
  recordSweepRead(encoder: GPUCommandEncoder): void {
    if (this.compactPhase !== 'idle') return;
    encoder.copyBufferToBuffer(this.compactCursor, 0, this.compactStaging, 0, 8);
    this.compactPhase = 'recorded';
  }

  /** Start the readback. Call after submitting the encoder. */
  pollSweepRead(): void {
    if (this.compactPhase !== 'recorded') return;
    this.compactPhase = 'mapping';
    this.compactStaging.mapAsync(GPUMapMode.READ).then(
      () => {
        const data = new Uint32Array(this.compactStaging.getMappedRange().slice(0));
        this.compactStaging.unmap();
        // Lane 1 is `moved`; lane 0 is the allocator cursor, which is an
        // implementation detail the host has no use for.
        const moved = data[1];
        if (moved !== undefined) this.movedTotal = moved;
        this.compactPhase = 'idle';
      },
      () => {
        // Device lost or buffer destroyed. Invariant 5: drop the answer rather
        // than killing the frame.
        this.compactPhase = 'idle';
      },
    );
  }

  /** Relocations so far in this sweep, as of the last completed readback. */
  get relocated(): number {
    return this.movedTotal;
  }

  /**
   * Free the buffers this module owns.
   *
   * The passes are rebuilt on every Max Particles and World Size change, so
   * without this the cursor and both staging buffers leak once per change --
   * small individually, unbounded over a session of tuning.
   */
  destroy(): void {
    this.spawnUniforms.destroy();
    this.killUniforms.destroy();
    this.sortUniforms.destroy();
    this.compactUniforms.destroy();
    this.compactCursor.destroy();
    // Set first, so an in-flight mapAsync callback finds a phase it will not
    // act on rather than touching a destroyed buffer.
    this.compactPhase = 'mapping';
    this.compactStaging.destroy();
  }
}
