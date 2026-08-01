/**
 * The simulation: entity buffer, trail canvas, and the three passes that
 * advance them. The port of `particle_system/particle_system.py` (472 lines).
 *
 * ## What `advance()` does, and why the order looks wrong
 *
 * Three passes per sub-step, and the order is NOT the obvious one:
 *
 *     update_entities    compute; reads the canvas, rewrites every entity
 *     update_canvas      decay + diffuse, front -> back, THEN SWAP
 *     splat_into_canvas  additive brush into the (new) front
 *
 * `particle_system.py:241-245` says it plainly: "The ordering here is a little
 * weird. It doesn't matter so much, but if I weren't trying to support legacy
 * configs, the proper order would be update_entities / splat_into_canvas /
 * update_canvas." It is ported as it IS, not as it should have been -- the
 * shipped presets were tuned against this order. Do not tidy it.
 *
 * Because the swap happens at the end of pass 2, the splat lands on the
 * freshly-decayed texture, and that same texture is what the camera reads.
 *
 * ## No memory barriers
 *
 * The Python calls `ctx.memory_barrier()` between passes. WebGPU has no
 * analogue and needs none: passes within a submission observe each other's
 * writes in order, and the implementation inserts the barriers. The ordering
 * guarantee the barriers provided is structural here.
 *
 * ## One encoder per frame
 *
 * At the default physics rate, `advance()` runs 30x per frame -- 90 GPU passes,
 * plus rendering. WebGPU's per-pass overhead is JS-side and higher than GL's,
 * which docs/WEB_PORT_PLAN.md:558-564 flags as the most likely place this port
 * becomes slower than the desktop. The plan's first-choice mitigation is
 * batching sub-steps into one encoder, so that is what this does from the
 * start: `runFrame()` opens ONE encoder, records every sub-step, and submits
 * once.
 *
 * That is also why `frameCount` rides a DYNAMIC OFFSET rather than being
 * rewritten per sub-step: `queue.writeBuffer` cannot be interleaved with an
 * encoder's passes, so all 30 sub-steps' uniforms are written up front into one
 * buffer and each pass binds its own slice.
 */

import {
  type SimulationConfig,
  type WorldSettings,
  BC,
  forUpload,
} from './config.ts';
import { ENTITY_STRIDE } from './layout.ts';
import { packConfigs } from './pack.ts';
import { canvasDimensions, ENTITIES_PER_WORLD_UNIT, ENTITY_COUNT } from './sizing.ts';
import {
  type ShoveState,
  alignTo,
  BRUSH_UNIFORM_SIZE,
  CANVAS_UNIFORM_SIZE,
  ENTITY_UPDATE_UNIFORM_SIZE,
  packBrushUniforms,
  packCanvasUniforms,
  packEntityUpdateUniforms,
  packPickUniforms,
} from './uniforms.ts';
import { workgroupsFor } from './dispatch.ts';
import {
  type PickResult,
  NO_HIT,
  PICK_RESULT_SIZE,
  PICK_UNIFORM_SIZE,
  decodePickResult,
} from './pick.ts';
import { compileModule } from '../gpu/shaderModule.ts';

import entityUpdateSource from './shaders/entityUpdate.wgsl';
import canvasSource from './shaders/canvas.wgsl';
import brushSource from './shaders/brush.wgsl';
import entityPickSource from './shaders/entityPick.wgsl';

// Re-exported so callers have one import for the simulation. The definitions
// live in `dispatch.ts` because this module imports `.wgsl`, which only
// resolves through the Vite plugin -- so nothing under `node --test` can import
// this file, and the dispatch arithmetic deserves a test.
export { WORKGROUP_SIZE, workgroupsFor } from './dispatch.ts';

/** The canvas texel format. RG16F, and deliberately not RG32F.
 *
 * Base WebGPU can neither LINEAR-filter nor blend `rg32float` -- both need
 * optional device features -- while `rg16float` does everything this texture
 * needs with none, at half the bandwidth. The precision cost is paid for in the
 * shaders instead (`CANVAS_VALUE_SCALE` and the saturation clamp in
 * common.wgsl). See `particle_system.py:28-34`; do not "upgrade" this without
 * also deciding to narrow the device matrix.
 */
export const CANVAS_FORMAT: GPUTextureFormat = 'rg16float';

export interface ParticleSystemOptions {
  readonly device: GPUDevice;
  readonly config: SimulationConfig;
  readonly world: WorldSettings;
  /** Defaults to `canvasDimensions()` -- 1024x1024 at world size 1. */
  readonly canvasSize?: readonly [number, number];
  /** Injectable so World Size can rebuild the system at a different scale. */
  readonly entityCount?: number;
  /** Sub-steps per frame. The desktop's Physics Rate; 30 is the default. */
  readonly physicsSteps?: number;
}

/** A canvas texture and the views/bind groups that go with it. */
interface CanvasTarget {
  texture: GPUTexture;
  view: GPUTextureView;
}

export class ParticleSystem {
  private readonly device: GPUDevice;
  readonly canvasSize: readonly [number, number];
  readonly entityCount: number;
  /**
   * Derived from the ACTUAL entity count, not the module default, so a rebuilt
   * system scales distances correctly. Feeds WorldData and is the single source
   * of truth the shader reads.
   */
  readonly sqrtWorldSize: number;

  /** Sub-steps per frame. */
  physicsSteps: number;

  /**
   * The reset sentinel. Zero is watched by all three shaders -- see `reset()`.
   * Read-only outside; only `advance()` and `reset()` write it.
   */
  private _frameCount = 0;
  get frameCount(): number {
    return this._frameCount;
  }

  private configs: readonly SimulationConfig[];
  private world: WorldSettings;

  private readonly entityBuffer: GPUBuffer;
  private configBuffer: GPUBuffer;

  /** front = read/most recent; back = the one being written. */
  private front: CanvasTarget;
  private back: CanvasTarget;

  private readonly repeatSampler: GPUSampler;
  private readonly clampSampler: GPUSampler;
  /**
   * 1x1 stand-in bound to the Strafe Field's slot until a real field arrives.
   *
   * The texture is held, not just its view: a view cannot be destroyed and does
   * not need to be, but the texture behind it is a real (if tiny) allocation and
   * `destroy()` has to be able to free it.
   */
  private readonly dummyTexture: GPUTexture;
  private readonly dummyTextureView: GPUTextureView;

  /**
   * The Strafe Field's view and resolution, or the 1x1 placeholder.
   *
   * SET ONCE, BEFORE THE SYSTEM GOES LIVE. `computeTextureGroups` is a prebuilt
   * 2x2 that holds this view, so replacing the field mid-life would leave four
   * stale bind groups. Nothing needs to: the field's size derives from
   * `canvasSize`, which is fixed for a system, and the only thing that changes it
   * is `Orchestrator.rebuildSystem`, which builds a whole new ParticleSystem
   * anyway. See `setStrafeField`.
   */
  private strafeFieldView: GPUTextureView;
  private strafeFieldSize: readonly [number, number] = [1, 1];
  /** False while the placeholder is bound; the shader then skips the sample. */
  private strafeFieldBound = false;

  // NOT readonly: `physicsSteps` is a live preference, and each of these holds
  // one slice per sub-step. Raising the rate past the allocated slot count
  // reallocates -- see `ensureUniformCapacity`.
  private entityUpdateUniforms: GPUBuffer;
  private canvasUniforms: GPUBuffer;
  private brushUniforms: GPUBuffer;
  /** Sub-step slices the three uniform buffers above are sized for. */
  private uniformSlots: number;
  /** Stride between consecutive sub-steps' uniform slices. */
  private readonly entityUpdateStride: number;
  private readonly canvasStride: number;
  private readonly brushStride: number;

  private computePipeline: GPUComputePipeline | null = null;
  private canvasPipeline: GPURenderPipeline | null = null;
  private brushPipeline: GPURenderPipeline | null = null;
  /** Pass A: reduce every entity to one packed key by atomicMin. */
  private pickReducePipeline: GPUComputePipeline | null = null;
  /** Pass B: one invocation; derives the winner's rule and position. */
  private pickDerivePipeline: GPUComputePipeline | null = null;

  private computeStateGroup: GPUBindGroup | null = null;
  private canvasUniformGroup: GPUBindGroup | null = null;
  private brushStateGroup: GPUBindGroup | null = null;
  private pickGroup: GPUBindGroup | null = null;

  // Held so `buildStateGroups` can rebuild the three groups above without
  // recompiling shaders -- which is what a physics-rate growth needs.
  private computeStateLayout: GPUBindGroupLayout | null = null;
  private canvasUniformLayout: GPUBindGroupLayout | null = null;
  private brushStateLayout: GPUBindGroupLayout | null = null;
  private pickLayout: GPUBindGroupLayout | null = null;
  // Held for the same reason, one level down: `setStrafeField` rebuilds the
  // texture groups, and the field's view is baked into them.
  private computeTextureLayout: GPUBindGroupLayout | null = null;
  private canvasTextureLayout: GPUBindGroupLayout | null = null;

  // --- picking ------------------------------------------------------------
  // See `requestPick` for the phase machine these four fields implement.

  /** GPU-side result: the atomic key, the winner's position, and its rule. */
  private readonly pickResult: GPUBuffer;
  /** Host-visible copy. A buffer cannot be both STORAGE and MAP_READ. */
  private readonly pickStaging: GPUBuffer;
  private readonly pickUniforms: GPUBuffer;
  private pickPhase: 'idle' | 'dispatched' | 'mapping' | 'ready' = 'idle';
  /**
   * The radius of the in-flight dispatch, needed to decode its quantized
   * distance. `picker.py:90-92` keeps `_pending_radius` for the same reason:
   * decoding with a later click's radius would scale the distance wrongly.
   */
  private pickRadius = 0;
  /**
   * Bumped on every request. A `mapAsync` callback whose generation no longer
   * matches was abandoned by a later click and must not publish its result.
   */
  private pickGeneration = 0;
  /**
   * Texture groups, keyed [wrap ? 1 : 0][front-is-a ? 0 : 1]. Pre-built because
   * WebGPU samplers are immutable: the desktop flips `repeat_x/repeat_y` at
   * runtime (`_apply_boundary_sampling`), which here means swapping bind groups
   * rather than mutating one. Four combinations, built once, never per frame.
   */
  private computeTextureGroups: GPUBindGroup[][] = [];
  private canvasTextureGroups: GPUBindGroup[][] = [];
  /** Which of the two canvas textures is currently the front. */
  private frontIsA = true;
  private readonly canvasA: CanvasTarget;
  private readonly canvasB: CanvasTarget;

  private constructor(opts: ParticleSystemOptions) {
    this.device = opts.device;
    this.canvasSize = opts.canvasSize ?? canvasDimensions();
    this.entityCount = opts.entityCount ?? ENTITY_COUNT;
    this.sqrtWorldSize = Math.sqrt(this.entityCount / ENTITIES_PER_WORLD_UNIT);
    this.physicsSteps = opts.physicsSteps ?? 30;
    this.configs = [opts.config];
    this.world = opts.world;

    const device = this.device;

    // Entity buffer. Contents are written entirely GPU-side by the reset path
    // in entityUpdate.wgsl, so allocation is all that is needed here.
    //
    // Sized EXACTLY entityCount * 32 so `arrayLength(&entities)` in the shader
    // equals entityCount -- the shader's bounds check and every `/ N` cohort
    // division depend on that identity.
    this.entityBuffer = device.createBuffer({
      label: 'EntityBuffer',
      size: this.entityCount * ENTITY_STRIDE,
      // COPY_SRC, like the canvas's, is for the A/B harness only.
      usage:
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    this.configBuffer = device.createBuffer({
      label: 'ConfigBuffer',
      size: packConfigs(this.configs).byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const makeCanvas = (label: string): CanvasTarget => {
      const texture = device.createTexture({
        label,
        size: { width: this.canvasSize[0], height: this.canvasSize[1] },
        format: CANVAS_FORMAT,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.RENDER_ATTACHMENT |
          // COPY_SRC is for verification, not for the app: it is what lets the
          // A/B harness read the canvas back and compare it against the
          // desktop's own dump. Costs nothing when unused, and without it the
          // only way to check the physics is to photograph a window.
          GPUTextureUsage.COPY_SRC,
      });
      return { texture, view: texture.createView() };
    };
    this.canvasA = makeCanvas('canvas-a');
    this.canvasB = makeCanvas('canvas-b');
    this.front = this.canvasA;
    this.back = this.canvasB;

    // Both address modes, built up front. The desktop mutates one sampler;
    // WebGPU samplers are immutable, so the mode is chosen by which bind group
    // is bound. LINEAR filtering on both, matching `canvas_texture.filter`.
    const samplerBase = {
      magFilter: 'linear',
      minFilter: 'linear',
    } as const;
    this.repeatSampler = device.createSampler({
      label: 'canvas-repeat',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      ...samplerBase,
    });
    this.clampSampler = device.createSampler({
      label: 'canvas-clamp',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      ...samplerBase,
    });

    // The fallback until `setStrafeField` binds a real one. The shader's
    // `strafe_field_active` flag is false meanwhile and the sample is skipped --
    // but WebGPU validates a bind group whether or not the shader reads it, so a
    // real texture must still be bound. (GL tolerated an unbound sampler here;
    // this is the one place that difference costs anything.)
    this.dummyTexture = device.createTexture({
      label: 'strafe-field-placeholder',
      size: { width: 1, height: 1 },
      format: CANVAS_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    this.dummyTextureView = this.dummyTexture.createView();
    this.strafeFieldView = this.dummyTextureView;

    // One uniform slice per sub-step, so the whole frame's uniforms can be
    // written before the encoder opens. Dynamic offsets must be a multiple of
    // minUniformBufferOffsetAlignment (256 on most hardware).
    const align = device.limits.minUniformBufferOffsetAlignment;
    this.entityUpdateStride = alignTo(ENTITY_UPDATE_UNIFORM_SIZE, align);
    this.canvasStride = alignTo(CANVAS_UNIFORM_SIZE, align);
    this.brushStride = alignTo(BRUSH_UNIFORM_SIZE, align);

    this.uniformSlots = Math.max(1, Math.trunc(this.physicsSteps));
    this.entityUpdateUniforms = this.makeUniformBuffer(
      'entity-update-uniforms',
      this.entityUpdateStride,
    );
    this.canvasUniforms = this.makeUniformBuffer('canvas-uniforms', this.canvasStride);
    this.brushUniforms = this.makeUniformBuffer('brush-uniforms', this.brushStride);

    // --- picking ---------------------------------------------------------
    // 336 bytes: the atomic key, the winner's position, and its 320-byte Rule.
    // The rule is here because the port does NOT reproduce mutation.py's
    // float32 host mirror -- see pick.ts and rule.wgsl.
    //
    // COPY_DST is not optional: it is how the NO_HIT sentinel gets written
    // before each dispatch, and atomicMin without that reset would keep a stale
    // winner forever.
    this.pickResult = device.createBuffer({
      label: 'PickResultBuffer',
      size: PICK_RESULT_SIZE,
      usage:
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    // MAP_READ | COPY_DST is the only pairing WebGPU allows for a mappable
    // buffer -- which is the entire reason this second buffer exists rather
    // than mapping `pickResult` directly.
    this.pickStaging = device.createBuffer({
      label: 'PickStagingBuffer',
      size: PICK_RESULT_SIZE,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    // No dynamic offset: at most one pick per frame, so unlike the three
    // per-sub-step buffers there is nothing to stride through.
    this.pickUniforms = device.createBuffer({
      label: 'pick-uniforms',
      size: PICK_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.uploadConfigs();
  }

  /**
   * Build a system and compile its shaders.
   *
   * Async because WGSL compilation errors surface asynchronously through
   * `compilationInfo()`. Per invariant 5 a failed compile is LOGGED, NOT FATAL:
   * the pipeline stays null and `advance()` skips that pass, exactly as the
   * Python's `if self.brush_splat_program is None: return` guards do.
   */
  static async create(opts: ParticleSystemOptions): Promise<ParticleSystem> {
    const system = new ParticleSystem(opts);
    await system.reload();
    return system;
  }

  /**
   * Compile shaders and build pipelines. The analogue of `reload()`.
   *
   * The reload TRIGGERS are gone (invariant 5: reloading a shader edited on
   * disk has no browser meaning), but the SHAPE survives -- setup isolated in
   * one re-runnable helper, failure logged rather than thrown.
   */
  async reload(): Promise<void> {
    const device = this.device;

    const [entityModule, canvasModule, brushModule, pickModule] = await Promise.all([
      compileModule(device, 'entityUpdate.wgsl', entityUpdateSource),
      compileModule(device, 'canvas.wgsl', canvasSource),
      compileModule(device, 'brush.wgsl', brushSource),
      compileModule(device, 'entityPick.wgsl', entityPickSource),
    ]);

    // --- entity update (compute) -----------------------------------------
    const computeStateLayout = device.createBindGroupLayout({
      label: 'entity-update-state',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'storage' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform', hasDynamicOffset: true },
        },
      ],
    });
    const computeTextureLayout = device.createBindGroupLayout({
      label: 'entity-update-textures',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: {} },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: {} },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, sampler: {} },
      ],
    });

    if (entityModule !== null) {
      this.computePipeline = device.createComputePipeline({
        label: 'entity-update',
        layout: device.createPipelineLayout({
          bindGroupLayouts: [computeStateLayout, computeTextureLayout],
        }),
        compute: { module: entityModule, entryPoint: 'main' },
      });
      this.computeStateLayout = computeStateLayout;
    }

    // --- canvas decay/diffuse --------------------------------------------
    const canvasUniformLayout = device.createBindGroupLayout({
      label: 'canvas-uniforms',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true },
        },
      ],
    });
    const canvasTextureLayout = device.createBindGroupLayout({
      label: 'canvas-textures',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });

    if (canvasModule !== null) {
      this.canvasPipeline = device.createRenderPipeline({
        label: 'canvas-update',
        layout: device.createPipelineLayout({
          bindGroupLayouts: [canvasUniformLayout, canvasTextureLayout],
        }),
        vertex: { module: canvasModule, entryPoint: 'vs_main' },
        fragment: {
          module: canvasModule,
          entryPoint: 'fs_main',
          targets: [{ format: CANVAS_FORMAT }],
        },
        primitive: { topology: 'triangle-strip' },
      });
      this.canvasUniformLayout = canvasUniformLayout;
    }

    // --- brush splat ------------------------------------------------------
    // The entity buffer is read in the VERTEX stage here. Same buffer as the
    // compute pass, different binding type (read-only) and different
    // visibility, so it needs its own layout.
    const brushStateLayout = device.createBindGroupLayout({
      label: 'brush-state',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage' },
        },
      ],
    });

    if (brushModule !== null) {
      this.brushPipeline = device.createRenderPipeline({
        label: 'brush-splat',
        layout: device.createPipelineLayout({
          bindGroupLayouts: [brushStateLayout],
        }),
        vertex: { module: brushModule, entryPoint: 'vs_main' },
        fragment: {
          module: brushModule,
          entryPoint: 'fs_main',
          targets: [
            {
              format: CANVAS_FORMAT,
              // Pure additive: brush.wgsl already carries the full per-splat
              // weight. moderngl's `blend_func = ONE, ONE` sets colour AND
              // alpha; WebGPU requires both spelled out. The target is
              // rg16float so alpha does not exist -- the state is moot, but
              // omitting it is a validation error rather than a silent default.
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
              },
            },
          ],
        },
        primitive: {
          topology: 'triangle-strip',
          // The strip reorder in brush.wgsl flips the winding of one triangle.
          // With culling off that is irrelevant -- stated explicitly so nobody
          // "tightens" this to back-face culling and loses half of every splat.
          cullMode: 'none',
        },
      });
      this.brushStateLayout = brushStateLayout;
    }

    // --- picking ----------------------------------------------------------
    // ONE layout and ONE bind group for BOTH passes: they need exactly the same
    // four resources, so sharing means one createBindGroup and one setBindGroup
    // per pass rather than two of each.
    //
    // `entities` is read-only-storage here, unlike the entity-update pass. That
    // is what lets rule.wgsl be shared between the two shaders -- see
    // get_cohort's comment there.
    const pickLayout = device.createBindGroupLayout({
      label: 'entity-pick',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'read-only-storage' },
        },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    if (pickModule !== null) {
      const layout = device.createPipelineLayout({ bindGroupLayouts: [pickLayout] });
      this.pickReducePipeline = device.createComputePipeline({
        label: 'entity-pick-reduce',
        layout,
        compute: { module: pickModule, entryPoint: 'reduce' },
      });
      this.pickDerivePipeline = device.createComputePipeline({
        label: 'entity-pick-derive',
        layout,
        compute: { module: pickModule, entryPoint: 'derive' },
      });
      this.pickLayout = pickLayout;
    }

    this.computeTextureLayout = computeTextureLayout;
    this.canvasTextureLayout = canvasTextureLayout;

    this.buildStateGroups();
    this.buildTextureGroups();
  }

  /**
   * Bind the real Strafe Field, replacing the 1x1 placeholder.
   *
   * CALL ONCE, BEFORE THE SYSTEM GOES LIVE. This rebuilds all four compute
   * texture groups, which is cheap here and would not be mid-frame -- and more to
   * the point, a field swapped under a running system would leave any bind group
   * recorded earlier in the frame pointing at the old texture. The Orchestrator
   * pairs a field with a system at construction and replaces both together; see
   * `rebuildSystem`.
   *
   * `size` is the FIELD's resolution, which is not the canvas's once
   * `MAX_FIELD_DIM` bites. It rides in the entity-update uniform so
   * `get_strafe_field` maps world->uv against the texture it is actually
   * sampling (`fieldSize.ts`).
   */
  setStrafeField(view: GPUTextureView, size: readonly [number, number]): void {
    this.strafeFieldView = view;
    this.strafeFieldSize = size;
    this.strafeFieldBound = true;
    this.buildTextureGroups();
  }

  /**
   * The three bind groups that reference the per-sub-step uniform buffers.
   *
   * Split out of `reload()` because they must ALSO be rebuilt when the physics
   * rate grows past the allocated slot count and those buffers are reallocated
   * -- a bind group holds the buffer it was built against, so a bare swap would
   * leave all three pointing at destroyed memory.
   */
  private buildStateGroups(): void {
    const device = this.device;

    if (this.computeStateLayout !== null) {
      this.computeStateGroup = device.createBindGroup({
        label: 'entity-update-state',
        layout: this.computeStateLayout,
        entries: [
          { binding: 0, resource: { buffer: this.entityBuffer } },
          { binding: 1, resource: { buffer: this.configBuffer } },
          {
            binding: 2,
            resource: {
              buffer: this.entityUpdateUniforms,
              size: ENTITY_UPDATE_UNIFORM_SIZE,
            },
          },
        ],
      });
    }

    if (this.canvasUniformLayout !== null) {
      this.canvasUniformGroup = device.createBindGroup({
        label: 'canvas-uniforms',
        layout: this.canvasUniformLayout,
        entries: [
          {
            binding: 0,
            resource: { buffer: this.canvasUniforms, size: CANVAS_UNIFORM_SIZE },
          },
        ],
      });
    }

    if (this.brushStateLayout !== null) {
      this.brushStateGroup = device.createBindGroup({
        label: 'brush-state',
        layout: this.brushStateLayout,
        entries: [
          {
            binding: 0,
            resource: { buffer: this.brushUniforms, size: BRUSH_UNIFORM_SIZE },
          },
          { binding: 1, resource: { buffer: this.entityBuffer } },
        ],
      });
    }

    // The pick group references no per-sub-step buffer, so it does not strictly
    // need rebuilding when those are reallocated -- it is built here anyway so
    // there is one place that builds bind groups, rather than a second rule to
    // remember.
    if (this.pickLayout !== null) {
      this.pickGroup = device.createBindGroup({
        label: 'entity-pick',
        layout: this.pickLayout,
        entries: [
          { binding: 0, resource: { buffer: this.entityBuffer } },
          { binding: 1, resource: { buffer: this.configBuffer } },
          { binding: 2, resource: { buffer: this.pickResult } },
          { binding: 3, resource: { buffer: this.pickUniforms } },
        ],
      });
    }
  }

  /**
   * Pre-build the four texture bind groups: {repeat, clamp} x {A front, B front}.
   *
   * Both boundary modes and both buffer parities exist up front so neither a
   * mode change nor the per-sub-step swap allocates anything.
   *
   * THE STRAFE FIELD SHARES THE CANVAS'S SAMPLER (binding 3 takes the same one
   * as binding 1), which is not a shortcut -- it is what makes the field track
   * the boundary mode for free. The desktop has to say so twice
   * (`_apply_boundary_sampling` for the canvas, `StrafeField.set_wrap` for the
   * field); here the two cannot disagree, because one variant of this group is
   * built per sampler and both slots read from it.
   */
  private buildTextureGroups(): void {
    const device = this.device;
    const samplers = [this.clampSampler, this.repeatSampler];
    const fronts = [this.canvasA, this.canvasB];

    if (this.computeTextureLayout !== null) {
      const computeLayout = this.computeTextureLayout;
      this.computeTextureGroups = samplers.map((sampler) =>
        fronts.map((front) =>
          device.createBindGroup({
            layout: computeLayout,
            entries: [
              { binding: 0, resource: front.view },
              { binding: 1, resource: sampler },
              { binding: 2, resource: this.strafeFieldView },
              { binding: 3, resource: sampler },
            ],
          }),
        ),
      );
    }

    if (this.canvasTextureLayout !== null) {
      const canvasLayout = this.canvasTextureLayout;
      this.canvasTextureGroups = samplers.map((sampler) =>
        fronts.map((front) =>
          device.createBindGroup({
            layout: canvasLayout,
            entries: [
              { binding: 0, resource: front.view },
              { binding: 1, resource: sampler },
            ],
          }),
        ),
      );
    }
  }

  /** Index into the pre-built texture groups for the current state. */
  private textureGroupIndex(): readonly [number, number] {
    const wrap = this.world.boundaryConditions === BC.WRAP ? 1 : 0;
    return [wrap, this.frontIsA ? 0 : 1];
  }

  private uploadConfigs(): void {
    const bytes = packConfigs(this.configs);
    if (bytes.byteLength !== this.configBuffer.size) {
      this.configBuffer.destroy();
      this.configBuffer = this.device.createBuffer({
        label: 'ConfigBuffer',
        size: bytes.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }
    this.device.queue.writeBuffer(this.configBuffer, 0, bytes);
  }

  /** The GPU-facing world record: saved settings plus runtime sizing. */
  private worldConfig() {
    return forUpload(this.world, this.sqrtWorldSize, this.configs.length);
  }

  /**
   * Replace the configs and world settings.
   *
   * Rebuilds the config buffer and, if the boundary mode changed, simply
   * selects a different pre-built bind group next frame -- there is nothing to
   * re-apply, which is the whole benefit of building all four up front.
   */
  applyProject(configs: readonly SimulationConfig[], world: WorldSettings): void {
    const sizeChanged = configs.length !== this.configs.length;
    this.configs = configs;
    this.world = world;
    this.uploadConfigs();
    if (sizeChanged) {
      // The bind group holds the buffer; a reallocated buffer needs new groups.
      void this.reload();
    }
  }

  /**
   * Reset the simulation.
   *
   * THE ASSIGNMENT BELOW *IS* THE RESET -- it looks like bookkeeping, but
   * frameCount is a uniform, and zero is the sentinel every pass watches for on
   * the next step:
   *
   *     entityUpdate.wgsl   regenerates every entity's position, velocity and
   *                         rule (and re-assigns config_index)
   *     canvas.wgsl         writes the canvas to zero instead of decaying it,
   *                         clearing the trails
   *     brush.wgsl          discards the frame's splats, so nothing is
   *                         deposited into the canvas being cleared
   *
   * So nothing is torn down or reallocated here: the GPU rebuilds its own state
   * on the next advance(). Setting frameCount anywhere else, or skipping the
   * advance after this, would leave the reset half-applied.
   */
  reset(): void {
    this._frameCount = 0;
  }

  /**
   * The canvas the camera should read. Identity changes every sub-step, which
   * is why this is a per-frame accessor rather than a field anyone can hold --
   * see ARCHITECTURE.md rule 2 on the double-buffer swapping underfoot.
   */
  currentCanvasTexture(): GPUTextureView {
    return this.front.view;
  }

  /**
   * The same texture as an object, for `copyTextureToBuffer`.
   *
   * Exists for the A/B harness, which reads the canvas back and compares it
   * against the desktop's dump of the same preset at the same frame count.
   * Nothing in the app calls this; a view cannot be a copy source, so the
   * object has to be reachable.
   */
  currentCanvasTextureObject(): GPUTexture {
    return this.front.texture;
  }

  /**
   * The entity buffer, for `copyBufferToBuffer`. Verification only, like
   * `currentCanvasTextureObject` -- comparing mean |vel| and mean |pos| against
   * the desktop's own dump is what localises a physics divergence to a step.
   */
  entityBufferForReadback(): GPUBuffer {
    return this.entityBuffer;
  }

  /**
   * The entity buffer, for the camera's PARTICLES mode.
   *
   * Bound READ-ONLY in a vertex stage (`camBrush.wgsl`), the same way
   * `brush.wgsl` reads it -- which is why the buffer already carries STORAGE
   * usage and why both declare `read` rather than `read_write` (a vertex stage
   * cannot write storage at all).
   *
   * Returns the same object as `entityBufferForReadback()`, and is deliberately
   * a SEPARATE method rather than a rename of it. That one's name is
   * load-bearing documentation that nothing in the app calls it -- an invariant
   * the A/B harness relies on. This one IS an app path.
   *
   * Handed over per frame rather than held, matching `orchestrator.py:330`: the
   * Camera keeps no reference to the simulation between frames
   * (ARCHITECTURE.md rule 3, and `camera.py:36-37`). Note rule 3 is about the
   * CONFIG buffer -- the colour settings reach the camera as loose uniforms for
   * exactly that reason -- while the entity buffer is passed explicitly on the
   * desktop too, so a public accessor is the faithful port rather than a
   * loosening.
   */
  entityBufferForRendering(): GPUBuffer {
    return this.entityBuffer;
  }

  // =========================================================================
  // Picking
  // =========================================================================
  //
  // THE PHASE MACHINE. `picker.py` needs one boolean (`_pending`) because its
  // readback is synchronous by the time it is read. Here a buffer that is
  // mapped, or mid-`mapAsync`, is NOT A LEGAL COPY TARGET, so the states have
  // to be distinguished:
  //
  //   idle       nothing in flight; the staging buffer is free
  //   dispatched passes and the copy are recorded; mapAsync not yet called
  //   mapping    mapAsync in flight; staging cannot be copied into
  //   ready      mapped; getMappedRange() is valid and an unmap() is owed
  //
  // `dispatched` is separate from `mapping` because mapAsync must be called
  // AFTER submit(), never while the encoder is open.

  /**
   * Phase 1: dispatch a pick. The result arrives via `retrievePick()` on a
   * later frame.
   *
   * Call this BEFORE the frame's encoder opens -- it writes two buffers, and
   * `queue.writeBuffer` may not interleave with an open encoder's passes.
   *
   * A second call while one is in flight ABANDONS the first (last click wins,
   * `selection_commands.py:111-113`). The dispatch is overwritten regardless --
   * there is one result slot -- so honouring the older click would adopt a rule
   * from a pick aimed somewhere else.
   */
  requestPick(targetWorld: readonly [number, number], radiusWorld: number): void {
    if (this.pickReducePipeline === null || this.pickGroup === null) return;

    // Abandon whatever was in flight. A buffer that is mapping or mapped cannot
    // be copied into, so those two states have to be resolved before the new
    // dispatch can record its copy.
    this.pickGeneration++;
    if (this.pickPhase === 'ready') {
      // Mapped and never read. Release it; the result is stale now anyway.
      this.pickStaging.unmap();
      this.pickPhase = 'idle';
    } else if (this.pickPhase === 'mapping') {
      // Cannot unmap a buffer whose mapAsync has not settled, and cannot copy
      // into it either. The generation bump makes the pending callback discard
      // its result; this request waits for the buffer to come free. One frame,
      // and only when two clicks land inside one GPU-latency window.
      return;
    }

    const queue = this.device.queue;
    // THE SENTINEL, and it is mandatory rather than defensive: atomicMin only
    // ever LOWERS, so a stale winner would beat every candidate forever.
    // `picker.py:107` writes it first thing for the same reason.
    queue.writeBuffer(this.pickResult, 0, new Uint32Array([NO_HIT]));
    queue.writeBuffer(
      this.pickUniforms,
      0,
      packPickUniforms(this.worldConfig(), targetWorld, radiusWorld),
    );

    this.pickRadius = radiusWorld;
    this.pickPhase = 'dispatched';
  }

  /**
   * Record the two pick passes and the readback copy, if a pick is pending.
   *
   * Called from `runFrame`, so a pick rides the frame's existing encoder.
   */
  private recordPick(encoder: GPUCommandEncoder): void {
    if (this.pickPhase !== 'dispatched') return;
    if (this.pickReducePipeline === null || this.pickDerivePipeline === null) return;
    if (this.pickGroup === null) return;

    // TWO SEPARATE PASSES, not two dispatches in one. WebGPU orders passes
    // within a submission and inserts the barriers between them; dispatches
    // inside a SINGLE pass have no ordering guarantee, so `derive` would race
    // the reduction whose answer it reads.
    const reduce = encoder.beginComputePass({ label: 'entity-pick-reduce' });
    reduce.setPipeline(this.pickReducePipeline);
    reduce.setBindGroup(0, this.pickGroup);
    reduce.dispatchWorkgroups(workgroupsFor(this.entityCount));
    reduce.end();

    // One invocation: it reads the settled key and derives that one entity's
    // rule. Writing the rule from the reduce pass would let a thread that LOST
    // the atomic overwrite the winner's -- see entityPick.wgsl.
    const derive = encoder.beginComputePass({ label: 'entity-pick-derive' });
    derive.setPipeline(this.pickDerivePipeline);
    derive.setBindGroup(0, this.pickGroup);
    derive.dispatchWorkgroups(1);
    derive.end();

    // Recorded in the SAME encoder, so it is ordered after `derive` by
    // construction rather than by timing.
    encoder.copyBufferToBuffer(this.pickResult, 0, this.pickStaging, 0, PICK_RESULT_SIZE);
  }

  /**
   * Start the readback. Call AFTER `queue.submit()`.
   *
   * Separate from `recordPick` because `mapAsync` may not be called while the
   * encoder is open, and separate from `retrievePick` because the map takes
   * time -- that wait is the whole reason picking is two-phase.
   */
  beginPickReadback(): void {
    if (this.pickPhase !== 'dispatched') return;

    const generation = this.pickGeneration;
    this.pickPhase = 'mapping';
    this.pickStaging.mapAsync(GPUMapMode.READ).then(
      () => {
        if (generation !== this.pickGeneration) {
          // A later click abandoned this one. Release the buffer so the next
          // request can copy into it, and publish nothing.
          this.pickStaging.unmap();
          this.pickPhase = 'idle';
          return;
        }
        this.pickPhase = 'ready';
      },
      () => {
        // Device lost, or the buffer was destroyed. Invariant 5's shape: a
        // failed readback drops the pick rather than killing the frame.
        this.pickPhase = 'idle';
      },
    );
  }

  /**
   * Phase 2: the result, or `null` if it is not ready yet.
   *
   * `null` AND A MISS ARE DIFFERENT, and the caller must keep them so. `null`
   * means the readback has not landed and the pending click must keep waiting;
   * a `PickResult` with `index < 0` means nothing was in range. `picker.py`
   * conflates them because its retrieve() always answers -- treating `null` as
   * a miss here would silently drop every click whose readback took longer than
   * a frame.
   *
   * MUST BE CALLED AT THE TOP OF THE FRAME, before input can dispatch a new
   * pick: there is one result slot, so a new dispatch clobbers the answer being
   * read. And it must be called from the FRAME LOOP, not from inside
   * `advance()` -- `advance()` is skipped while paused, and clicking to select
   * has to keep working then (`orchestrator.py:263-279`).
   */
  retrievePick(): PickResult | null {
    if (this.pickPhase !== 'ready') return null;

    // `.slice(0)` is not optional: `unmap()` DETACHES the ArrayBuffer that
    // getMappedRange returned, and reading a detached buffer throws -- at the
    // exact moment a user clicks. 336 bytes.
    const bytes = this.pickStaging.getMappedRange().slice(0);
    this.pickStaging.unmap();
    this.pickPhase = 'idle';

    return decodePickResult(bytes, this.pickRadius);
  }

  /** Whether a dispatched pick has yet to be read. Diagnostics only. */
  get pickPending(): boolean {
    return this.pickPhase !== 'idle';
  }

  /**
   * Record one frame: `physicsSteps` sub-steps into a single encoder.
   *
   * All uniforms are written BEFORE the encoder opens, because
   * `queue.writeBuffer` may not be interleaved with an encoder's passes. Each
   * sub-step then binds its own slice by dynamic offset.
   *
   * `onSubStep` runs AFTER each `advance()`, and exists for motion blur: a
   * displayed frame is the average of several renders taken at different points
   * in the simulation's advance, so the camera must see the simulation
   * mid-advance rather than only at the end of it (`orchestrator.py:296-300`).
   *
   * NOTE what is NOT here: which sub-steps get sampled. That decision --
   * `step % stride === sampleAt` -- stays in the caller, because ParticleSystem
   * must not learn what motion blur is. It hands over "a sub-step just
   * finished" and nothing more.
   */
  runFrame(
    encoder: GPUCommandEncoder,
    shove: ShoveState | null = null,
    onSubStep?: (encoder: GPUCommandEncoder, step: number) => void,
  ): void {
    const steps = Math.max(1, Math.trunc(this.physicsSteps));
    // Before anything is written: `physicsSteps` is live, so the buffers may be
    // sized for a lower rate than this frame is about to use.
    this.ensureUniformCapacity(steps);
    const world = this.worldConfig();
    const canvasRes = this.canvasSize;

    // Write every sub-step's uniforms up front. Only frameCount varies -- the
    // world payload is identical across the frame, which is the same reasoning
    // as the desktop's cached `_world_uniform` (ARCHITECTURE.md:658-665). It is
    // rebuilt per sub-step here only because each slice must hold a full copy.
    const entityBytes = new Uint8Array(this.entityUpdateStride * steps);
    const canvasBytes = new Uint8Array(this.canvasStride * steps);
    const brushBytes = new Uint8Array(this.brushStride * steps);
    for (let i = 0; i < steps; i++) {
      const fc = this._frameCount + i;
      entityBytes.set(
        new Uint8Array(
          packEntityUpdateUniforms(
            world,
            canvasRes,
            // The FIELD's resolution, not the canvas's -- `get_strafe_field`
            // maps world->uv against the texture it samples, and the two differ
            // once MAX_FIELD_DIM bites.
            this.strafeFieldSize,
            fc,
            shove,
            this.strafeFieldBound,
          ),
        ),
        i * this.entityUpdateStride,
      );
      canvasBytes.set(
        new Uint8Array(packCanvasUniforms(world, fc)),
        i * this.canvasStride,
      );
      brushBytes.set(
        new Uint8Array(packBrushUniforms(world, canvasRes, fc)),
        i * this.brushStride,
      );
    }
    const queue = this.device.queue;
    queue.writeBuffer(this.entityUpdateUniforms, 0, entityBytes);
    queue.writeBuffer(this.canvasUniforms, 0, canvasBytes);
    queue.writeBuffer(this.brushUniforms, 0, brushBytes);

    for (let i = 0; i < steps; i++) {
      this.advance(encoder, i);
      onSubStep?.(encoder, i);
    }
    this._frameCount += steps;

    // After the sub-steps, so the pick sees the positions the frame ended on --
    // the same entities the user is looking at when they click. Inside the
    // encoder because the passes need it; the RESOLVE, by contrast, lives in
    // the frame loop outside runFrame, because picking must work while paused
    // and runFrame is what a paused frame skips.
    this.recordPick(encoder);
  }

  private makeUniformBuffer(label: string, stride: number): GPUBuffer {
    return this.device.createBuffer({
      label,
      size: stride * this.uniformSlots,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * Grow the per-sub-step uniform buffers if the physics rate has risen.
   *
   * `physicsSteps` is a LIVE preference -- the desktop's Physics Rate slider
   * moves it every frame if you drag it -- but each of these buffers holds one
   * dynamic-offset slice per sub-step, so their size depends on it. Raising the
   * rate above the allocated count would otherwise walk off the end of the
   * buffer, which WebGPU reports as an out-of-bounds dynamic offset and which
   * invalidates the whole command buffer: the screen freezes rather than
   * degrading.
   *
   * Grows only, never shrinks. Lowering the rate leaves the slack allocated,
   * which costs a few kilobytes and avoids reallocating on every frame of a
   * slider drag that crosses a threshold repeatedly.
   *
   * The bind groups reference these buffers, so a reallocation must rebuild
   * them -- hence `buildStateGroups` rather than a bare buffer swap.
   */
  private ensureUniformCapacity(steps: number): void {
    if (steps <= this.uniformSlots) return;

    this.entityUpdateUniforms.destroy();
    this.canvasUniforms.destroy();
    this.brushUniforms.destroy();

    this.uniformSlots = steps;
    this.entityUpdateUniforms = this.makeUniformBuffer(
      'entity-update-uniforms',
      this.entityUpdateStride,
    );
    this.canvasUniforms = this.makeUniformBuffer('canvas-uniforms', this.canvasStride);
    this.brushUniforms = this.makeUniformBuffer('brush-uniforms', this.brushStride);

    this.buildStateGroups();
  }

  /**
   * One sub-step. See the class header for why the pass order is what it is.
   *
   * `slot` selects this sub-step's uniform slice. No memory barriers: passes
   * within a submission are ordered and WebGPU inserts them.
   */
  private advance(encoder: GPUCommandEncoder, slot: number): void {
    this.updateEntities(encoder, slot);
    this.updateCanvas(encoder, slot);
    this.splatIntoCanvas(encoder, slot);
  }

  private updateEntities(encoder: GPUCommandEncoder, slot: number): void {
    if (this.computePipeline === null || this.computeStateGroup === null) return;
    const [wrap, parity] = this.textureGroupIndex();
    const textures = this.computeTextureGroups[wrap]?.[parity];
    if (textures === undefined) return;

    const pass = encoder.beginComputePass({ label: 'entity-update' });
    pass.setPipeline(this.computePipeline);
    pass.setBindGroup(0, this.computeStateGroup, [slot * this.entityUpdateStride]);
    pass.setBindGroup(1, textures);
    pass.dispatchWorkgroups(workgroupsFor(this.entityCount));
    pass.end();
  }

  private updateCanvas(encoder: GPUCommandEncoder, slot: number): void {
    if (this.canvasPipeline === null || this.canvasUniformGroup === null) return;
    const [wrap, parity] = this.textureGroupIndex();
    const textures = this.canvasTextureGroups[wrap]?.[parity];
    if (textures === undefined) return;

    const pass = encoder.beginRenderPass({
      label: 'canvas-update',
      colorAttachments: [
        {
          view: this.back.view,
          // 'clear' rather than 'load': the shader writes every texel
          // unconditionally (both branches assign, and the frame-0 path returns
          // a value), so the clear is a hint to tiled GPUs, not a correctness
          // requirement.
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(this.canvasPipeline);
    pass.setBindGroup(0, this.canvasUniformGroup, [slot * this.canvasStride]);
    pass.setBindGroup(1, textures);
    pass.draw(4);
    pass.end();

    // THE SWAP, and it happens here and nowhere else -- so the splat below
    // lands on the texture this pass just wrote.
    const oldFront = this.front;
    this.front = this.back;
    this.back = oldFront;
    this.frontIsA = !this.frontIsA;
  }

  private splatIntoCanvas(encoder: GPUCommandEncoder, slot: number): void {
    if (this.brushPipeline === null || this.brushStateGroup === null) return;

    const pass = encoder.beginRenderPass({
      label: 'brush-splat',
      colorAttachments: [
        {
          view: this.front.view,
          // 'load', NEVER 'clear'. The desktop renders into the canvas without
          // clearing (particle_system.py:433); clearing here would erase the
          // trails every sub-step.
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(this.brushPipeline);
    pass.setBindGroup(0, this.brushStateGroup, [slot * this.brushStride]);
    // 4 vertices per entity, instanced. No vertex buffer -- the quad comes from
    // the vertex index and the entity from the instance index.
    pass.draw(4, this.entityCount);
    pass.end();
  }

  /**
   * Free every GPU resource this system owns.
   *
   * DROPPING THE JS REFERENCE DOES NOT FREE GPU MEMORY. A disruptive preference
   * change (World Size, Canvas Aspect) rebuilds the system, and without this the
   * outgoing one's buffers leaked -- ~19 MB per rebuild at 600k entities, the
   * entity buffer alone.
   *
   * Called on a system that is already off the frame path, never on a live one:
   * `Orchestrator.rebuildSystem` builds the replacement, swaps it in, and only
   * then destroys the old one, so a failed rebuild leaves the running system
   * untouched.
   *
   * WHAT IS NOT HERE, deliberately. Texture VIEWS have no `destroy()` and need
   * none -- destroying the texture releases them. Bind groups, layouts and
   * pipelines likewise: they are GC'd once nothing references them, and unlike
   * buffers they hold no allocation worth reclaiming eagerly. And the STRAFE
   * FIELD is not freed here, because this system does not own it: the
   * Orchestrator constructs both and destroys both.
   */
  destroy(): void {
    // THE PICK STAGING BUFFER HAS A PRECONDITION. Destroying a buffer that is
    // mapped, or has a `mapAsync` in flight, is an error -- and a rebuild landing
    // inside a click's readback window is exactly when that happens. Bumping the
    // generation makes any in-flight continuation abandon (`beginPickReadback`
    // already checks it), and `unmap()` is legal on an unmapped buffer, so the
    // pair covers all four phases without needing to know which one we are in.
    this.pickGeneration++;
    this.pickPhase = 'idle';
    this.pickStaging.unmap();

    this.entityBuffer.destroy();
    this.configBuffer.destroy();
    this.canvasA.texture.destroy();
    this.canvasB.texture.destroy();
    this.entityUpdateUniforms.destroy();
    this.canvasUniforms.destroy();
    this.brushUniforms.destroy();
    this.pickResult.destroy();
    this.pickStaging.destroy();
    this.pickUniforms.destroy();
    this.dummyTexture.destroy();
  }

  /** True when every pipeline compiled. Surfaced for the startup summary. */
  pipelineStatus(): Readonly<Record<string, boolean>> {
    return {
      entityUpdate: this.computePipeline !== null,
      canvas: this.canvasPipeline !== null,
      brush: this.brushPipeline !== null,
      // Both from one module, but reported separately: they are separate
      // pipelines, and browserCheck.mjs greps this line for /FAILED/.
      entityPickReduce: this.pickReducePipeline !== null,
      entityPickDerive: this.pickDerivePipeline !== null,
    };
  }
}
