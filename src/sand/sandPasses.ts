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
  KILL_UNIFORM_SIZE,
  SPAWN_UNIFORM_SIZE,
  packKillUniforms,
  packSpawnUniforms,
} from './sandUniforms.ts';

import {
  KILL_WORKGROUP_SIZE,
  SPAWN_WORKGROUP_SIZE,
  workgroupsFor,
} from './sandDispatch.ts';

import spawnSource from './shaders/spawn.wgsl';
import killSource from './shaders/kill.wgsl';

// Re-exported so callers have one import for the passes. The definitions live in
// `sandDispatch.ts` because this module imports `.wgsl`, which only resolves
// through the Vite plugin -- the same split `particleSystem.ts` makes.
export { KILL_WORKGROUP_SIZE, SPAWN_WORKGROUP_SIZE, workgroupsFor } from './sandDispatch.ts';

export class SandPasses {
  private readonly device: GPUDevice;
  private readonly system: ParticleSystem;

  private spawnPipeline: GPUComputePipeline | null = null;
  private killPipeline: GPUComputePipeline | null = null;
  private spawnGroup: GPUBindGroup | null = null;
  private killGroup: GPUBindGroup | null = null;

  private readonly spawnUniforms: GPUBuffer;
  private readonly killUniforms: GPUBuffer;

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

    const [spawnModule, killModule] = await Promise.all([
      compileModule(device, 'spawn', spawnSource),
      compileModule(device, 'kill', killSource),
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
}
