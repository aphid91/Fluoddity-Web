/**
 * The simulation: entity buffer, trail canvas, and the two passes that advance
 * them. The port of `particle_system/particle_system.py` (472 lines).
 *
 * ## What `advance()` does, and why the order looks wrong
 *
 * The desktop runs three passes per sub-step, and the order is NOT the obvious
 * one:
 *
 *     update_entities    compute; reads the canvas, rewrites every entity
 *     update_canvas      decay + diffuse, front -> back, THEN SWAP
 *     splat_into_canvas  additive brush into the (new) front
 *
 * `particle_system.py:241-245` says it plainly: "The ordering here is a little
 * weird. It doesn't matter so much, but if I weren't trying to support legacy
 * configs, the proper order would be update_entities / splat_into_canvas /
 * update_canvas." The shipped presets were tuned against this order, so its
 * EFFECT is kept: each step's splat lands on the freshly-decayed canvas, from
 * the positions the entity update just wrote. Do not tidy it.
 *
 * The web keeps that effect in TWO passes. The entity update adds each
 * particle's splat to an integer accumulator with atomics as it writes the
 * particle (entityUpdate.wgsl `deposit`), and the canvas pass adds the
 * accumulator after its decay and zeroes it (canvas.wgsl). There is no splat
 * pass: a separate graphics pass per sub-step cost a phone GPU about half its
 * frame rate, and made no difference on desktop ones.
 *
 * The canvas pass swaps at its end, so the texture it just wrote -- decay plus
 * this step's deposits -- is the front one, and that is what the camera reads.
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
 * At the default physics rate, `advance()` runs 30x per frame -- 60 GPU passes,
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
// A LEAF import, sanctioned by invariant 3: `fieldSize.ts` holds a format
// constant and one function of arithmetic, with no state and no GPU resources.
// It is `strafeField/`'s value module, not its implementation module -- importing
// `strafeField.ts` here would be the cycle (that class already imports this one).
import { FIELD_FORMAT } from '../strafeField/fieldSize.ts';
import { packConfigs } from './pack.ts';
import {
  DEAD_CONFIG,
  deadEntityBytes,
  freeListAfterMigration,
  freeListSize,
  initialFreeList,
} from './freeList.ts';
import { type PoolAudit, auditPool } from './poolAudit.ts';
import { canDropMarkToZero, markAfterSpawnReach, sortedFreeList } from './compaction.ts';
import { canvasDimensions, ENTITIES_PER_WORLD_UNIT, ENTITY_COUNT } from './sizing.ts';
import {
  type FieldStrengths,
  type ShoveState,
  alignTo,
  CANVAS_UNIFORM_SIZE,
  DEFAULT_FIELD_STRENGTHS,
  ENTITY_UPDATE_UNIFORM_SIZE,
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
import { timestampWrites } from '../gpu/passTimer.ts';

import entityUpdateSource from './shaders/entityUpdate.wgsl';
import canvasSource from './shaders/canvas.wgsl';
import entityPickSource from './shaders/entityPick.wgsl';
import cohortRulesSource from './shaders/cohortRules.wgsl';
import { configSlots } from './configSlots.ts';

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
  /**
   * The world's SCALE, as `sqrt(worldSize)`. Defaults to deriving it from
   * `entityCount`, which is what the studio wants.
   *
   * ## Why this can be given separately
   *
   * `sqrtWorldSize` divides nearly every force in `entityUpdate` -- forces are
   * tuned in world units and must shrink as the world grows. Deriving it from
   * the entity count is correct for the STUDIO, where World Size moves particle
   * count and canvas resolution together and the ratio is fixed by
   * `ENTITIES_PER_WORLD_UNIT`.
   *
   * It is wrong the moment those two decouple. The sand modality's Max Particles
   * changes the entity count alone, and deriving the scale from it meant raising
   * the cap silently retuned gravity, drag and every force -- the same config
   * behaving differently because a buffer got bigger. Passing the scale
   * explicitly is what keeps a cap a cap.
   */
  readonly sqrtWorldSize?: number;
  /** Sub-steps per frame. The desktop's Physics Rate; 30 is the default. */
  readonly physicsSteps?: number;
  /**
   * Whether particles can be born and die -- the sand modality's mode.
   *
   * OFF IS THE STUDIO, exactly as it was: every particle is permanently alive,
   * the free list is a minimal dummy that nothing writes, and `BC_KILL` is
   * unreachable because no studio config selects it. On, the pool is sized to
   * the entity count and `resetLifetimes()` starts the world empty.
   *
   * A construction option rather than a setting: it decides how big a GPU buffer
   * is, so flipping it means rebuilding the system anyway.
   */
  readonly lifetimes?: boolean;
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
  /**
   * How the config buffer is laid out -- see configSlots.ts. The studio (no
   * lifetimes) gives each cohort its own slot; sand gives each palette config
   * one. Every shader that indexes the buffer is built with this as its
   * CONFIG_PER_COHORT constant, so they cannot disagree about the layout.
   */
  private readonly perCohort: boolean;
  /** Slots in the config buffer, which is what the shaders see as the config count. */
  private slotCount = 0;
  /**
   * Set by `uploadConfigs`, cleared by `recordRuleBake`. The bake mutates the
   * slots IN PLACE, so it may run once per upload and never again until the
   * next -- this flag is what enforces that.
   */
  private rulesDirty = false;

  private readonly entityBuffer: GPUBuffer;
  private configBuffer: GPUBuffer;
  /**
   * The dead-index pool. Allocated in both apps so the bind group layout is the
   * same one; a minimal dummy when `lifetimes` is off. See `freeList.wgsl`.
   */
  /** The splat accumulator. See the constructor and entityUpdate.wgsl. */
  private readonly splatBuffer: GPUBuffer;
  private readonly freeListBuffer: GPUBuffer;
  /** 4 bytes, for reading the head back. See `recordFreeListRead`. */
  private readonly headStaging: GPUBuffer;
  /** Same state machine as `pickPhase`, and for the same reasons. */
  private headPhase: 'idle' | 'recorded' | 'mapping' = 'idle';
  /** Last completed head readback. See `availableSlots`. */
  private freeListHead: number;
  /**
   * Highest index any pass needs to visit. See `activeEntityCount`.
   *
   * `entityCount` when lifetimes are off: the studio's particles are all alive
   * from frame 0, so every pass covers the whole buffer exactly as before.
   */
  private highWaterMark: number;
  /** Whether particles can be born and die. See `ParticleSystemOptions`. */
  readonly lifetimes: boolean;

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

  /**
   * How strongly each painted layer acts, pre-multiplied by its base gain.
   *
   * **A SETTER, NOT A `runFrame` PARAMETER**, unlike `shove` beside it, and the
   * split is the same one ARCHITECTURE.md:658-665 draws: a shove is live input
   * that genuinely differs every frame, while these change only when a slider
   * moves. Threading them through `runFrame` would rebuild them 30 times a frame
   * -- ~1800 times a second -- for a value the user touches once an hour.
   *
   * Defaults reproduce the pre-slider behaviour exactly: `walls` is the old
   * `STRAFE_FIELD_GAIN`, and `trails` is the gain a strength of 1.0 gives.
   */
  private fieldStrengths: FieldStrengths = DEFAULT_FIELD_STRENGTHS;

  // NOT readonly: `physicsSteps` is a live preference, and each of these holds
  // one slice per sub-step. Raising the rate past the allocated slot count
  // reallocates -- see `ensureUniformCapacity`.
  private entityUpdateUniforms: GPUBuffer;
  private canvasUniforms: GPUBuffer;
  /** Sub-step slices the two uniform buffers above are sized for. */
  private uniformSlots: number;
  /** Stride between consecutive sub-steps' uniform slices. */
  private readonly entityUpdateStride: number;
  private readonly canvasStride: number;

  private computePipeline: GPUComputePipeline | null = null;
  private canvasPipeline: GPURenderPipeline | null = null;
  /** Pass A: reduce every entity to one packed key by atomicMin. */
  private pickReducePipeline: GPUComputePipeline | null = null;
  /** Pass B: one invocation; copies the winner's rule and position. */
  private pickDerivePipeline: GPUComputePipeline | null = null;
  /** Bakes each config slot's cohort mutation into its rule. See cohortRules.wgsl. */
  private cohortRulesPipeline: GPUComputePipeline | null = null;

  private computeStateGroup: GPUBindGroup | null = null;
  private canvasUniformGroup: GPUBindGroup | null = null;
  private pickGroup: GPUBindGroup | null = null;
  private cohortRulesGroup: GPUBindGroup | null = null;

  // Held so `buildStateGroups` can rebuild the groups above without
  // recompiling shaders -- which is what a physics-rate growth needs.
  private computeStateLayout: GPUBindGroupLayout | null = null;
  private canvasUniformLayout: GPUBindGroupLayout | null = null;
  private pickLayout: GPUBindGroupLayout | null = null;
  private cohortRulesLayout: GPUBindGroupLayout | null = null;
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
  private pickPhase: 'idle' | 'dispatched' | 'recorded' | 'mapping' | 'ready' = 'idle';
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
    // Derived from the entity count unless given -- see the option's note. The
    // derivation is the studio's; an explicit value is what lets the sand
    // modality change the particle cap without retuning the physics.
    this.sqrtWorldSize =
      opts.sqrtWorldSize ?? Math.sqrt(this.entityCount / ENTITIES_PER_WORLD_UNIT);
    this.physicsSteps = opts.physicsSteps ?? 30;
    this.configs = [opts.config];
    this.world = opts.world;
    this.perCohort = !(opts.lifetimes ?? false);

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

    // A placeholder the size of one config: `uploadConfigs`, at the end of
    // construction, reallocates it to the slot count.
    this.configBuffer = device.createBuffer({
      label: 'ConfigBuffer',
      size: packConfigs(this.configs).byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // The splat accumulator: one (x, y) i32 pair per canvas pixel, which the
    // entity update adds each step's deposits to and the canvas pass drains.
    // Created zeroed, which is the empty accumulator the first step expects;
    // the canvas pass re-zeroes every pixel it drains. See entityUpdate.wgsl.
    this.splatBuffer = device.createBuffer({
      label: 'splat-accumulator',
      size: this.canvasSize[0] * this.canvasSize[1] * 8,
      usage: GPUBufferUsage.STORAGE,
    });

    // The dead-index pool. See `freeList.wgsl` for the allocation protocol and
    // `freeListSize` for the sizing.
    //
    // ALLOCATED IN BOTH APPS, sized differently. `lifetimes` is off in the
    // studio, which gets a minimal dummy: WebGPU validates a bind group against
    // its layout whether or not the shader reads it, so the binding must exist
    // even where BC_KILL is never selected and nothing ever writes it. This is
    // the same shape the strafe field's 1x1 dummy texture already uses.
    this.lifetimes = opts.lifetimes ?? false;
    this.freeListBuffer = device.createBuffer({
      label: this.lifetimes ? 'FreeList' : 'FreeList (dummy)',
      size: freeListSize(this.lifetimes ? this.entityCount : 0),
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_DST |
        // Both directions: COPY_SRC for the initial-conditions snapshot,
        // COPY_DST to restore it and to seed the pool at reset.
        GPUBufferUsage.COPY_SRC,
    });
    this.freeListHead = this.lifetimes ? this.entityCount : 0;
    // The studio sweeps everything; a sand world starts empty and grows.
    this.highWaterMark = this.lifetimes ? 0 : this.entityCount;
    this.headStaging = device.createBuffer({
      label: 'free-list-head-staging',
      size: 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const makeCanvas = (label: string): CanvasTarget => {
      const texture = device.createTexture({
        label,
        size: { width: this.canvasSize[0], height: this.canvasSize[1] },
        format: CANVAS_FORMAT,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.RENDER_ATTACHMENT |
          // COPY_SRC is for verification and for the sand modality's initial
          // conditions: it is what lets the A/B harness read the canvas back and
          // compare it against the desktop's own dump, and what lets a scene's
          // trails be snapshotted. Costs nothing when unused, and without it the
          // only way to check the physics is to photograph a window.
          GPUTextureUsage.COPY_SRC |
          // Restoring that snapshot copies back INTO the canvas. Only the sand
          // modality does so; the studio's reset rebuilds the canvas on the GPU.
          GPUTextureUsage.COPY_DST,
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
      // FIELD_FORMAT, not CANVAS_FORMAT: this stands in for the user-drawn field,
      // which is rgba16float since it gained the trails channels. A placeholder
      // whose format disagrees with the texture that replaces it is a bind group
      // validation error at the swap, not at creation.
      format: FIELD_FORMAT,
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

    this.uniformSlots = Math.max(1, Math.trunc(this.physicsSteps));
    this.entityUpdateUniforms = this.makeUniformBuffer(
      'entity-update-uniforms',
      this.entityUpdateStride,
    );
    this.canvasUniforms = this.makeUniformBuffer('canvas-uniforms', this.canvasStride);

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

    const [entityModule, canvasModule, pickModule, rulesModule] =
      await Promise.all([
        compileModule(device, 'entityUpdate.wgsl', entityUpdateSource),
        compileModule(device, 'canvas.wgsl', canvasSource),
        compileModule(device, 'entityPick.wgsl', entityPickSource),
        compileModule(device, 'cohortRules.wgsl', cohortRulesSource),
      ]);

    // The config buffer's layout, for every shader that indexes it. One value
    // from one field, so the pipelines below cannot disagree.
    const slotConstants = { CONFIG_PER_COHORT: this.perCohort ? 1 : 0 };

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
        // The free list, written by BC_KILL. Present in BOTH apps -- WebGPU
        // validates the bind group against this layout whether or not the
        // shader reaches the branch that uses it.
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'storage' },
        },
        // The splat accumulator, which every live particle adds its trail to.
        {
          binding: 4,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'storage' },
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
        compute: { module: entityModule, entryPoint: 'main', constants: slotConstants },
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
        // The splat accumulator, drained (read and zeroed) per fragment.
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'storage' },
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
        compute: { module: pickModule, entryPoint: 'reduce', constants: slotConstants },
      });
      this.pickDerivePipeline = device.createComputePipeline({
        label: 'entity-pick-derive',
        layout,
        compute: { module: pickModule, entryPoint: 'derive', constants: slotConstants },
      });
      this.pickLayout = pickLayout;
    }

    // --- cohort rule bake --------------------------------------------------
    // The config buffer read_write: the pass rewrites each slot's rule in place.
    const cohortRulesLayout = device.createBindGroupLayout({
      label: 'cohort-rules',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });

    if (rulesModule !== null) {
      this.cohortRulesPipeline = device.createComputePipeline({
        label: 'cohort-rules',
        layout: device.createPipelineLayout({ bindGroupLayouts: [cohortRulesLayout] }),
        compute: { module: rulesModule, entryPoint: 'main', constants: slotConstants },
      });
      this.cohortRulesLayout = cohortRulesLayout;
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
   * Set how strongly each painted layer acts.
   *
   * Takes values ALREADY MULTIPLIED by their base gains -- the caller owns that
   * arithmetic (`fieldStrengthsFor` in `prefs/preferences.ts`), so there is one
   * place that knows a slider of 1.0 means 0.01. Passing raw slider values here
   * would put half the conversion in this class and half in the shader, which is
   * how the two drift.
   *
   * Cheap and idempotent: it writes a field that the next `runFrame` reads. No
   * GPU work, so calling it on every settings change costs nothing.
   */
  setFieldStrengths(strengths: FieldStrengths): void {
    this.fieldStrengths = strengths;
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
          { binding: 3, resource: { buffer: this.freeListBuffer } },
          { binding: 4, resource: { buffer: this.splatBuffer } },
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
          { binding: 1, resource: { buffer: this.splatBuffer } },
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

    // Holds the config buffer, which `uploadConfigs` reallocates when the slot
    // count changes -- the other reason this method exists.
    if (this.cohortRulesLayout !== null) {
      this.cohortRulesGroup = device.createBindGroup({
        label: 'cohort-rules',
        layout: this.cohortRulesLayout,
        entries: [{ binding: 0, resource: { buffer: this.configBuffer } }],
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

  /**
   * Write the configs to the GPU as slots, and schedule the rule bake.
   *
   * THE ONLY WRITER OF THE CONFIG BUFFER, and the only thing that sets
   * `rulesDirty`. That pairing is what keeps the in-place bake safe: every bake
   * starts from freshly written PARENT rules, because nothing else can put
   * parents back or ask for a bake.
   *
   * A reallocation rebuilds the bind groups right here, synchronously, rather
   * than leaving them pointing at a destroyed buffer until something else
   * rebuilds them. In the studio this happens on every Cohorts change.
   */
  private uploadConfigs(): void {
    const slots = configSlots(this.configs, this.perCohort);
    const bytes = packConfigs(slots);
    this.slotCount = slots.length;
    if (bytes.byteLength !== this.configBuffer.size) {
      this.configBuffer.destroy();
      this.configBuffer = this.device.createBuffer({
        label: 'ConfigBuffer',
        size: bytes.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.buildStateGroups();
    }
    this.device.queue.writeBuffer(this.configBuffer, 0, bytes);
    this.rulesDirty = true;
  }

  /**
   * Bake each slot's cohort mutation into its rule, if an upload is waiting.
   *
   * Called at the top of every path that reads the config buffer -- the physics
   * (`runFrame`) and the picker (`recordPick`, which runs while paused) -- so no
   * reader ever sees a parent rule. Costs nothing on a frame with no upload,
   * which is almost every frame: the bake follows EDITS, not time.
   *
   * Waits, rather than dropping the request, while the pipeline is still
   * compiling: the first upload happens in the constructor, before `reload`.
   */
  private recordRuleBake(encoder: GPUCommandEncoder): void {
    if (!this.rulesDirty) return;
    if (this.cohortRulesPipeline === null || this.cohortRulesGroup === null) return;
    const pass = encoder.beginComputePass({
      label: 'cohort-rules',
      timestampWrites: timestampWrites('cohort-rules'),
    });
    pass.setPipeline(this.cohortRulesPipeline);
    pass.setBindGroup(0, this.cohortRulesGroup);
    // 64 matches @workgroup_size in cohortRules.wgsl.
    pass.dispatchWorkgroups(Math.ceil(this.slotCount / 64));
    pass.end();
    this.rulesDirty = false;
  }

  /**
   * The GPU-facing world record: saved settings plus runtime sizing.
   *
   * `configCount` is the SLOT count, not the project's config count: it is the
   * clamp bound every shader applies to a slot index, so it must describe the
   * buffer they index.
   */
  private worldConfig() {
    return forUpload(this.world, this.sqrtWorldSize, this.slotCount);
  }

  /**
   * Replace the configs and world settings.
   *
   * Rebuilds the config buffer and, if the boundary mode changed, simply
   * selects a different pre-built bind group next frame -- there is nothing to
   * re-apply, which is the whole benefit of building all four up front.
   */
  applyProject(configs: readonly SimulationConfig[], world: WorldSettings): void {
    this.configs = configs;
    this.world = world;
    // Rebuilds the bind groups itself if the buffer had to grow or shrink.
    this.uploadConfigs();
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
   *                         (and entityUpdate.wgsl deposits no splats, so
   *                         nothing lands on the canvas being cleared)
   *
   * So nothing is torn down or reallocated here: the GPU rebuilds its own state
   * on the next advance(). Setting frameCount anywhere else, or skipping the
   * advance after this, would leave the reset half-applied.
   */
  reset(): void {
    this._frameCount = 0;
  }

  /**
   * Empty the world: every particle dead, every index available.
   *
   * THE SAND MODALITY'S "RESET TO NOTHING", and the counterpart of `reset()`
   * rather than a part of it. `reset()` works by setting the frame-0 sentinel
   * and letting the GPU rebuild its own state; this cannot, because the state it
   * wants is "no particles", and frame 0 is precisely the path that REPOPULATES
   * the world. So it writes both buffers directly and leaves `frameCount` alone.
   *
   * Callers set `frameCount` themselves afterwards -- the sand orchestrator
   * restores to frame 1, never 0, so the studio's regenerate-everything path
   * never runs there.
   *
   * Writing the whole entity buffer is `entityCount * 32` bytes -- 9.6 MB at the
   * default world size. That is a visible cost, but it happens on reset only,
   * and the alternative (a compute pass to zero it) would need its own pipeline
   * for a job the queue does in one call.
   */
  resetLifetimes(): void {
    if (!this.lifetimes) return;
    const queue = this.device.queue;
    queue.writeBuffer(this.freeListBuffer, 0, initialFreeList(this.entityCount));
    // A dead Entity is 32 zero bytes EXCEPT for config_index, which must be
    // negative -- zero is a valid config index and would mean "alive, config 0".
    queue.writeBuffer(this.entityBuffer, 0, deadEntityBytes(this.entityCount));
    // Nothing is live, so no pass needs to visit anything.
    this.highWaterMark = 0;
  }

  /** The free list, for the sand modality's spawn/kill passes and snapshots. */
  freeListBufferForSand(): GPUBuffer {
    return this.freeListBuffer;
  }

  /**
   * Copy this system's live entities into a NEW system's buffer, truncating.
   *
   * ## Why the host reads the buffer back to do this
   *
   * Changing Max Particles reallocates the entity buffer, and the particles the
   * user has painted should survive that -- rebuilding the world from scratch
   * because a cap moved is not what a cap moving means. But the host does not
   * know which entities are alive: that is written GPU-side by the brushes and
   * by edge-death.
   *
   * So the migration reads the old buffer, keeps the LIVE entities (in index
   * order), and writes them densely into the front of the new one. That gives
   * two things a blind `copyBufferToBuffer` could not: truncation that drops
   * dead particles before live ones, and a free list that is correct on the
   * other side without a second pass to rebuild it.
   *
   * THE READBACK IS ACCEPTABLE HERE, unlike anywhere on the frame path. It
   * happens when the user confirms a typed field -- a deliberate, occasional act
   * that already reallocates several buffers. The pipeline stall it causes is
   * invisible against that.
   *
   * SILENT TRUNCATION is deliberate, and specified: if the new buffer is
   * smaller, the excess live particles are dropped without a warning.
   */
  async migrateEntitiesTo(target: ParticleSystem): Promise<void> {
    if (!this.lifetimes || !target.lifetimes) return;

    const stride = ENTITY_STRIDE;
    const staging = this.device.createBuffer({
      label: 'entity-migration-staging',
      size: this.entityCount * stride,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    try {
      const encoder = this.device.createCommandEncoder({ label: 'entity-migration' });
      encoder.copyBufferToBuffer(this.entityBuffer, 0, staging, 0, staging.size);
      this.device.queue.submit([encoder.finish()]);

      await staging.mapAsync(GPUMapMode.READ);
      const source = new Uint8Array(staging.getMappedRange());
      // `config_index` is misc.y -- float lane 5 of 8. Read as i32, because a
      // dead particle is one whose index is negative.
      const asInt = new Int32Array(
        source.buffer,
        source.byteOffset,
        source.byteLength / 4,
      );

      const kept = new Uint8Array(target.entityCount * stride);
      // Everything not written below stays zero, which is NOT dead -- config 0
      // is a real config. The tail is marked dead explicitly after the copy.
      let out = 0;
      for (let i = 0; i < this.entityCount && out < target.entityCount; i++) {
        if (asInt[i * 8 + 5]! < 0) continue; // dead: skip, do not migrate
        kept.set(source.subarray(i * stride, (i + 1) * stride), out * stride);
        out++;
      }
      staging.unmap();

      // The tail -- every slot past the migrated ones -- must read as dead.
      const tail = new Int32Array(kept.buffer, kept.byteOffset, kept.byteLength / 4);
      for (let i = out; i < target.entityCount; i++) tail[i * 8 + 5] = DEAD_CONFIG;

      target.device.queue.writeBuffer(target.entityBuffer, 0, kept);
      // The free list holds exactly the slots past the migrated block, with the
      // head at how many of them there are. Built here rather than by a GPU pass
      // because the host already knows `out` exactly.
      target.device.queue.writeBuffer(
        target.freeListBuffer,
        0,
        freeListAfterMigration(target.entityCount, out),
      );
      target.freeListHead = target.entityCount - out;
      // The migration packs the live particles into the front of the buffer, so
      // the mark is exactly how many were kept.
      target.highWaterMark = out;
    } finally {
      staging.destroy();
    }
  }

  /**
   * Record a copy of the free-list head into the staging buffer.
   *
   * ## Why this exists rather than a CPU-side count
   *
   * How many particles the ERASER took is a GPU-side fact: only the shader knows
   * which particles had drifted under the brush. A host that guessed would
   * ratchet -- spawning is countable and erasing is not, so the estimate would
   * fall monotonically to zero and the brush would starve with a world full of
   * dead slots. That bug shipped once.
   *
   * ## Deferred, never synchronous
   *
   * Exactly the shape `requestPick`/`retrievePick` use, and for the same reason:
   * reading a buffer the same frame you wrote it forces a GPU sync, and WebGPU
   * has no synchronous readback at all. The answer is a frame or two stale,
   * which is harmless -- it feeds a brush-rate cap, not a correctness decision,
   * and the shader's own reservation refuses anything the pool cannot supply.
   */
  recordFreeListRead(encoder: GPUCommandEncoder): void {
    if (!this.lifetimes) return;
    // `mapping` means mapAsync is in flight and the buffer is not a legal copy
    // target; `ready` means an answer is waiting to be taken. Skipping in both
    // is what keeps this from clobbering a read in progress.
    if (this.headPhase !== 'idle') return;
    encoder.copyBufferToBuffer(this.freeListBuffer, 0, this.headStaging, 0, 4);
    this.headPhase = 'recorded';
  }

  /**
   * Start the readback for a recorded copy. Call after submitting the encoder --
   * `mapAsync` on a buffer whose copy has not been submitted never resolves.
   */
  pollFreeListRead(): void {
    if (this.headPhase !== 'recorded') return;
    this.headPhase = 'mapping';
    this.headStaging.mapAsync(GPUMapMode.READ).then(
      () => {
        const value = new Uint32Array(this.headStaging.getMappedRange().slice(0))[0];
        this.headStaging.unmap();
        // A wrapped head (the shader's guards undo their own overflow, but a
        // torn read during one is possible) is discarded rather than believed:
        // it would tell the brush there are four billion slots free.
        if (value !== undefined && value <= this.entityCount) {
          this.freeListHead = value;
        }
        this.headPhase = 'idle';
      },
      () => {
        // Device lost or buffer destroyed. Invariant 5's shape: a failed
        // readback drops the answer rather than killing the frame.
        this.headPhase = 'idle';
      },
    );
  }

  /**
   * Available dead slots, as of the last completed readback.
   *
   * A frame or two stale by construction -- see `recordFreeListRead`. Starts at
   * the full entity count, which is the truth for a world that has not been
   * painted in yet.
   */
  get availableSlots(): number {
    return this.freeListHead;
  }

  /**
   * How many entities every pass actually has to visit.
   *
   * ## THE SINGLE MOST IMPORTANT NUMBER FOR A LARGE PARTICLE CAP
   *
   * Every pass over the entities -- the physics dispatch, the trail splat, the
   * sprite draw -- used to cover `entityCount` regardless of how many particles
   * existed. Each dead one costs only a buffer read and a branch, which is
   * genuinely cheap; the mistake was believing cheap-per-invocation made it
   * cheap. At a 3M cap and the default physics rate that is ~460 MILLION
   * invocations per frame with an EMPTY WORLD, and the frame rate craters
   * exactly as one would expect.
   *
   * The free list allocates upward from index 0 (see `initialFreeList`), so
   * every live particle lives below the high-water mark and everything at or
   * above it is untouched. Stopping there is exact, not approximate: nothing
   * above the mark has ever been written.
   *
   * ## Why the host can track this without a readback
   *
   * `entityCount - availableSlots` is the live count, and the mark only ever
   * needs to be an UPPER BOUND on the highest live index. Spawning `n` can push
   * it up by at most `n`; nothing else raises it. Deaths lower the live count
   * but the mark is deliberately NOT lowered -- a freed slot below the mark is
   * reused before the mark grows, so shrinking it would risk skipping a live
   * particle for no benefit. `resetLifetimes` is what returns it to zero.
   */
  get activeEntityCount(): number {
    return this.highWaterMark;
  }

  /**
   * Raise the high-water mark after spawning `count` particles.
   *
   * Conservative by construction: assumes every reservation succeeded and every
   * one took a fresh index at the top. Over-counting costs a few wasted
   * invocations; under-counting would silently freeze particles, so the bound
   * errs upward.
   */
  /**
   * Put the mark back to a captured value, on an initial-conditions restore.
   *
   * Separate from `noteSpawned` because it ASSIGNS rather than accumulates: the
   * restore replaces the entity buffer wholesale, so the mark that goes with it
   * is the captured one, not the current one plus anything.
   */
  restoreHighWaterMark(value: number): void {
    if (!this.lifetimes) return;
    this.highWaterMark = Math.max(0, Math.min(this.entityCount, Math.trunc(value)));
  }

  noteSpawned(count: number): void {
    if (!this.lifetimes || count <= 0) return;
    this.highWaterMark = Math.min(this.entityCount, this.highWaterMark + count);
  }

  /**
   * Raise the mark to a bound the GPU MEASURED, never lower it.
   *
   * ## Why `noteSpawned` is not enough on its own
   *
   * That one ACCUMULATES a count, which silently assumes the brush took
   * contiguous indices starting at the mark. True in a fresh world, because
   * `initialFreeList` fills descending and the pool hands out 0, 1, 2, ... --
   * and false after any erasing, because `free_list_give` returns indices in GPU
   * retire order and the pool becomes a scatter. A stroke can then take index
   * 599,999 while the mark rises by 200, and every particle above the bound is
   * skipped by every pass and drawn by nothing.
   *
   * `spawn.wgsl` reports the highest slot it actually took. This applies it.
   *
   * ## RAISE-ONLY, which is what makes a stale measurement safe
   *
   * The readback lags a frame or two, so the value may describe a stroke older
   * than the mark currently reflects. Lowering to it would undo a later stroke's
   * accounting and hide its particles -- the precise failure this exists to fix,
   * reintroduced from the other direction. Only growth is ever applied, so a
   * late arrival is at worst a no-op.
   *
   * Lowering the mark is the sole business of compaction (`noteCompactedMark`),
   * which relocates particles and can therefore prove where the highest live one
   * is, and of `dropMarkIfEmpty` when the pool is provably empty.
   */
  noteSpawnReach(bound: number): boolean {
    if (!this.lifetimes) return false;
    // THE POLICY LIVES IN `markAfterSpawnReach`, so the raise-only rule is
    // testable without a device -- this class needs one to construct, which is
    // why the count-based version it replaces was never covered.
    const next = markAfterSpawnReach(this.highWaterMark, bound, this.entityCount);
    if (next === this.highWaterMark) return false;
    this.highWaterMark = next;
    return true;
  }

  /**
   * Apply a mark the GPU computed during a compaction. Returns whether it was
   * taken.
   *
   * ## THE DIRECTION RULE, which is the whole safety argument
   *
   * The mark now has two authors. The host raises it on every spawn
   * (`noteSpawned`), because it knows immediately how many particles it asked
   * for. The GPU lowers it after a compaction, because only it knows how many
   * survived. The readback is a frame or two late, and that lag is safe in
   * exactly one direction:
   *
   *   TOO HIGH is harmless -- a few wasted invocations per pass until the next
   *   compaction, and the bound is still an upper bound.
   *
   *   TOO LOW hides live particles. They stay in memory, every pass skips
   *   them, nothing draws them, and they reappear only if the mark rises past
   *   them again. That is the worst failure this subsystem has produced and it
   *   must not be reachable.
   *
   * So a GPU mark is applied only when it LOWERS the bound, and only when
   * nothing has been spawned since the readback was taken -- a spawn in that
   * window would have raised the mark for a particle the compaction never saw.
   * `spawnedSinceRead` is the caller's count of exactly that, the same number
   * that already guards `dropMarkIfEmpty`.
   *
   * A refused mark costs nothing: the next compaction computes a fresh one.
   */
  noteCompactedMark(mark: number, spawnedSinceRead: number): boolean {
    if (!this.lifetimes) return false;
    if (spawnedSinceRead > 0) return false;
    const want = Math.max(0, Math.min(this.entityCount, Math.trunc(mark)));
    // NEVER RAISES. A GPU mark above the current one means the readback
    // predates a spawn the host already accounted for, so believing it would
    // undo that accounting.
    if (want >= this.highWaterMark) return false;
    this.highWaterMark = want;
    // THE CACHED HEAD FOLLOWS THE MARK, because the compaction set both from
    // the same fact: the buffer is packed into [0, live), so exactly
    // `entityCount - live` slots are free. The GPU already wrote that head; the
    // host's copy would otherwise stay stale until the next `pollFreeListRead`
    // resolves, and in the meantime the brush budget and the UI's live count
    // would both be wrong by whatever the compaction moved.
    //
    // This is not a second source of truth. It is the same number arriving by a
    // faster route than the readback, and the readback will confirm it
    // unchanged a frame or two later.
    this.freeListHead = this.entityCount - want;
    return true;
  }

  /**
   * Drop the mark to zero IF the pool is provably empty -- TIER 1's one mark
   * reduction. Returns whether it fired.
   *
   * `activeEntityCount` explains why the mark is otherwise never lowered: a
   * freed slot below it is reused before it grows, so shrinking it risks
   * skipping a live particle. The single exception is a pool in which EVERY slot
   * is free, because then there is no live particle to skip.
   *
   * That case is ordinary use, not a curiosity -- paint a lot, erase all of it --
   * and without this the world keeps paying the full mark on every pass forever
   * afterwards.
   *
   * `spawnedSinceRead` is required because the head is a readback and lags a
   * frame or two; the reasoning is in `canDropMarkToZero`, which owns the
   * decision so it can be tested without a device.
   */
  dropMarkIfEmpty(spawnedSinceRead: number): boolean {
    if (!this.lifetimes) return false;
    if (this.highWaterMark === 0) return false;
    if (!canDropMarkToZero(this.freeListHead, this.entityCount, spawnedSinceRead)) {
      return false;
    }
    this.highWaterMark = 0;
    return true;
  }

  /**
   * Rebuild the pool to offer exactly the slots at or above `boundary`.
   *
   * TIER 2's cleanup. A sweep leaves the free list stale in one direction: it
   * may still list slots the sweep has filled with relocated particles, and
   * handing one to a brush would overwrite a live particle. This replaces the
   * pool with a statement the host knows to be true.
   *
   * CONSERVATIVE BY CONSTRUCTION. Slots below the boundary are simply not
   * offered, whether or not they are dead. That leaks reusable slots -- the
   * eraser's holes below the mark become unavailable until the next sweep or
   * reset -- and that is the correct trade: an unoffered dead slot costs a
   * little capacity, while an offered live one costs a particle.
   *
   * One `writeBuffer`, no pass in flight, from a value the host computed
   * itself. That is the whole reason the sweep can avoid touching the pool
   * while it runs. Mirrors `freeListAfterMigration`, which does this after a
   * Max Particles resize.
   */
  rebuildFreeListAbove(boundary: number): void {
    if (!this.lifetimes) return;
    const live = Math.max(0, Math.min(this.entityCount, Math.trunc(boundary)));
    this.device.queue.writeBuffer(
      this.freeListBuffer,
      0,
      freeListAfterMigration(this.entityCount, live),
    );
    this.freeListHead = this.entityCount - live;
  }

  /**
   * Land a completed sweep: lower the mark to `target`, but only as far as the
   * buffer actually permits. Resolves to the mark that was set.
   *
   * ## WHY THIS CONFIRMS RATHER THAN TRUSTS
   *
   * The sweep relocates every live particle it finds above the target, but a
   * relocation can give up -- the probe limit in `compact.wgsl` is a hang guard,
   * and a particle that exhausts it stays where it is. Rare, since the sweep
   * only runs on sparse worlds, but a mark lowered past such a straggler would
   * make it invisible: alive in memory, skipped by every pass, drawn by nothing.
   * That is the single worst failure in this whole subsystem and it must not be
   * reachable by a probability argument.
   *
   * So the range being abandoned is READ and scanned. The mark lands just above
   * the highest live particle found there, which is `target` in the overwhelming
   * common case and higher when a straggler exists. A sweep that achieved less
   * than it hoped is self-correcting: the next one starts from the new mark.
   *
   * The readback is acceptable for the reason `migrateEntitiesTo` gives: this
   * happens once per sweep, at the end of a deliberate act, and the pool rebuild
   * it feeds has to be exact.
   */
  /**
   * @param stillValid Consulted after the readback resolves, immediately before
   *   the result is applied. A sweep can be abandoned while its confirmation is
   *   in flight -- by a clear, a restore, or the user picking up the brush --
   *   and the mapAsync cannot be cancelled. This is how the caller says "the
   *   world I asked about is gone, throw the answer away"; returning false
   *   leaves the mark and the pool exactly as they are.
   */
  async packMarkTo(
    target: number,
    stillValid: () => boolean = () => true,
  ): Promise<number> {
    if (!this.lifetimes) return this.highWaterMark;
    const want = Math.max(0, Math.min(this.entityCount, Math.trunc(target)));
    const from = this.highWaterMark;
    // Nothing above the target to abandon, so nothing to confirm.
    if (want >= from) return from;

    const stride = ENTITY_STRIDE;
    const bytes = (from - want) * stride;
    const staging = this.device.createBuffer({
      label: 'compact-confirm-staging',
      size: bytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    let mark = want;
    try {
      const encoder = this.device.createCommandEncoder({ label: 'compact-confirm' });
      // ONLY THE ABANDONED RANGE is read, not the whole buffer: at a 3M cap
      // with a sweep that packed to 200k this is 2.8M entities rather than 3M,
      // but on the far more common small-gain sweep it is a fraction of one.
      encoder.copyBufferToBuffer(this.entityBuffer, want * stride, staging, 0, bytes);
      this.device.queue.submit([encoder.finish()]);

      await staging.mapAsync(GPUMapMode.READ);
      const source = new Uint8Array(staging.getMappedRange());
      const asInt = new Int32Array(
        source.buffer,
        source.byteOffset,
        source.byteLength / 4,
      );
      // Scan DOWNWARD and stop at the first live particle: the mark is an upper
      // bound on the highest live index, so the highest straggler is the only
      // one that matters and finding it ends the search.
      for (let i = from - want - 1; i >= 0; i--) {
        // `config_index` is misc.y -- float lane 5 of 8. Negative means dead.
        if (asInt[i * 8 + 5]! >= 0) {
          mark = want + i + 1;
          break;
        }
      }
      staging.unmap();
    } catch {
      // A failed readback must not lower the mark on an unverified range.
      // Holding the old mark is the safe direction: slow, never invisible.
      return from;
    } finally {
      staging.destroy();
    }

    // THE LAST POSSIBLE MOMENT to bail, and the right one: everything above is
    // a read, and everything below writes. A sweep abandoned during the
    // readback must not land its result on the world that replaced it.
    if (!stillValid()) return -1;

    this.highWaterMark = mark;
    // The pool now offers exactly the slots at or above the confirmed mark.
    this.rebuildFreeListAbove(mark);
    return mark;
  }

  /**
   * Read the free list back, sort it exactly, and write it returned -- the Dev
   * panel's manual compaction.
   *
   * ## Why this is allowed to stall when nothing else on the frame path is
   *
   * It maps a buffer and waits, which is a genuine pipeline stall -- the thing
   * `recordFreeListRead` exists to avoid doing per frame. It is acceptable here
   * for the reason `migrateEntitiesTo` gives for the same sin: this runs when a
   * user presses a button, a deliberate and occasional act, and the hitch is
   * what they asked for.
   *
   * The per-frame pass does the same job incrementally and without stalling.
   * This exists to make the effect immediate and total for testing, and for the
   * rare case where a user wants it done now.
   *
   * THE HEAD IS READ FROM THE BUFFER, not from `freeListHead`: the cached one is
   * stale, and sorting a region sized by a stale head would reorder slots that
   * are live indices. `sortedFreeList` bounds itself by the head it is handed,
   * so handing it the real one is what makes that bound true.
   *
   * Returns the number of slots sorted, for the status line.
   */
  /**
   * Read both buffers and check the pool's invariants. A DIAGNOSTIC.
   *
   * ## Why a readback is fine here and nowhere else
   *
   * It stalls the pipeline, which the frame path must never do. This is not the
   * frame path: it runs when a developer presses a button, to answer a question
   * that cannot be answered any other way. The stall is the cost of the answer.
   *
   * ## What it is for
   *
   * Compaction bugs present as something other than themselves, minutes after
   * the operation that caused them. This collapses that gap: press the button
   * after any suspicious operation and find out precisely which invariant broke
   * and by how many indices. See `poolAudit.ts` for the invariants and why each
   * matters.
   *
   * THE ENTITY BUFFER IS THE GROUND TRUTH. The live count here comes from
   * scanning it, never from the free-list head -- the head is exactly what is
   * under suspicion, and a check that trusted it could not detect the bug that
   * has bitten most often.
   */
  async auditPoolNow(): Promise<PoolAudit> {
    const capacity = this.entityCount;
    if (!this.lifetimes) {
      return auditPool({
        liveFlags: new Array(capacity).fill(true),
        poolSlots: [],
        mark: capacity,
        capacity,
      });
    }

    const stride = ENTITY_STRIDE;
    const entityStaging = this.device.createBuffer({
      label: 'pool-audit-entities',
      size: capacity * stride,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const poolStaging = this.device.createBuffer({
      label: 'pool-audit-freelist',
      size: freeListSize(capacity),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    try {
      // BOTH COPIES IN ONE ENCODER, so they describe the same instant. Two
      // submissions could straddle a frame, and a mismatch caused by that would
      // look exactly like the bug being hunted.
      const encoder = this.device.createCommandEncoder({ label: 'pool-audit' });
      encoder.copyBufferToBuffer(this.entityBuffer, 0, entityStaging, 0, capacity * stride);
      encoder.copyBufferToBuffer(this.freeListBuffer, 0, poolStaging, 0, poolStaging.size);
      this.device.queue.submit([encoder.finish()]);

      await Promise.all([
        entityStaging.mapAsync(GPUMapMode.READ),
        poolStaging.mapAsync(GPUMapMode.READ),
      ]);

      const entityBytes = new Uint8Array(entityStaging.getMappedRange());
      const asInt = new Int32Array(
        entityBytes.buffer,
        entityBytes.byteOffset,
        entityBytes.byteLength / 4,
      );
      const liveFlags: boolean[] = new Array(capacity);
      for (let i = 0; i < capacity; i++) {
        // `config_index` is misc.y -- float lane 5 of 8. Negative means dead.
        liveFlags[i] = asInt[i * 8 + 5]! >= 0;
      }
      entityStaging.unmap();

      const poolImage = new Uint32Array(poolStaging.getMappedRange().slice(0));
      poolStaging.unmap();
      const head = poolImage[0] ?? 0;
      // ONLY `slots[0 .. head)`. Entries above the head are stale residue from
      // indices already taken, and counting them as available is itself one of
      // the mistakes this audit exists to catch.
      const usable = Math.min(head, poolImage.length - 1);
      const poolSlots = Array.from(poolImage.slice(1, 1 + usable));

      return auditPool({
        liveFlags,
        poolSlots,
        mark: this.highWaterMark,
        capacity,
        cachedHead: this.freeListHead,
      });
    } finally {
      entityStaging.destroy();
      poolStaging.destroy();
    }
  }

  async sortFreeListNow(): Promise<number> {
    if (!this.lifetimes) return 0;
    const bytes = freeListSize(this.entityCount);
    const staging = this.device.createBuffer({
      label: 'freelist-sort-staging',
      size: bytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    try {
      const encoder = this.device.createCommandEncoder({ label: 'freelist-sort-read' });
      encoder.copyBufferToBuffer(this.freeListBuffer, 0, staging, 0, bytes);
      this.device.queue.submit([encoder.finish()]);

      await staging.mapAsync(GPUMapMode.READ);
      // `slice` before unmapping: the mapped range is detached by `unmap`, and
      // sorting a detached view would throw rather than fail quietly.
      const image = new Uint32Array(staging.getMappedRange().slice(0));
      staging.unmap();

      const sorted = sortedFreeList(image);
      this.device.queue.writeBuffer(this.freeListBuffer, 0, sorted);
      // The head did not move, so the cached copy stays true and the next
      // readback will confirm it unchanged.
      return sorted[0] ?? 0;
    } finally {
      staging.destroy();
    }
  }

  /** The entity buffer, for the sand modality's passes and snapshots. */
  entityBufferForSand(): GPUBuffer {
    return this.entityBuffer;
  }

  /**
   * Set the frame counter directly.
   *
   * EXISTS FOR RESTORE, which must land on frame 1 rather than 0: frame 0 is the
   * sentinel that regenerates every entity, clears the canvas and discards
   * splats, which would destroy the very scene being restored. Deliberately
   * narrow, and deliberately not a setter on `frameCount` -- that property's
   * read-only-ness is what documents that `advance()` and `reset()` own it.
   */
  setFrameCount(value: number): void {
    this._frameCount = Math.max(0, Math.trunc(value));
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
   * Bound READ-ONLY in a vertex stage (`camBrush.wgsl`) -- which is why it
   * declares `read` rather than `read_write` (a vertex stage cannot write
   * storage at all).
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
  //   dispatched REQUESTED: uniforms written, nothing recorded yet
  //   recorded   passes and the copy are in an encoder; mapAsync not yet called
  //   mapping    mapAsync in flight; staging cannot be copied into
  //   ready      mapped; getMappedRange() is valid and an unmap() is owed
  //
  // `recorded` is separate from `mapping` because mapAsync must be called AFTER
  // submit(), never while the encoder is open.
  //
  // `dispatched` IS SEPARATE FROM `recorded` BECAUSE THE GAP BETWEEN THEM IS A
  // REAL BUG THAT SHIPPED. These were one state, on the reading that a request
  // is always recorded in the same frame -- but `recordPick` was called from
  // `runFrame`, which a PAUSED frame skips, while `beginPickReadback` ran
  // regardless. So a paused click mapped a staging buffer nothing had written
  // and decoded whatever was left in it: the previous pick's bytes, or zeroes,
  // which decode as a confident hit on entity 0 with an all-zero rule. That
  // result was then adopted into the project and pushed onto the undo stack --
  // `pick.ts` calls silently adopting the wrong rule the worst failure mode
  // available, and this was it. Splitting the states makes the readback demand
  // proof that the GPU work exists, so the same mistake drops the pick instead.

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
  requestPick(
    targetWorld: readonly [number, number],
    radiusWorld: number,
    highlightedCohort = -1,
  ): void {
    if (this.pickReducePipeline === null || this.pickGroup === null) return;

    // Abandon whatever was in flight. A buffer that is mapping or mapped cannot
    // be copied into, so those two states have to be resolved before the new
    // dispatch can record its copy. `dispatched` and `recorded` both fall
    // through to the overwrite below: neither has mapped the buffer, so it is
    // still a legal copy target and the newer click simply replaces the older.
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
      packPickUniforms(this.worldConfig(), targetWorld, radiusWorld, highlightedCohort),
    );

    this.pickRadius = radiusWorld;
    this.pickPhase = 'dispatched';
  }

  /**
   * Record the two pick passes and the readback copy, if a pick is pending.
   *
   * CALLED FROM THE FRAME LOOP, NOT FROM `runFrame` -- the same reason
   * `retrievePick` is. `runFrame` is exactly what a paused frame skips, and
   * clicking to select has to keep working while paused; that is precisely when
   * a user wants to inspect a particle. This lived in `runFrame` and picking was
   * silently broken while paused as a result (see the phase machine above).
   *
   * The caller must record this AFTER the sub-steps, so the pick sees the
   * positions the frame ended on -- the same entities the user is looking at
   * when they click. It rides the frame's existing encoder either way.
   */
  recordPick(encoder: GPUCommandEncoder): void {
    if (this.pickPhase !== 'dispatched') return;
    // A pick while PAUSED skips `runFrame`, so an edit made during the pause
    // would otherwise leave the picker reading parent rules.
    this.recordRuleBake(encoder);
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

    // The staging buffer now HAS something coming. Only from here is a readback
    // meaningful -- see the phase machine.
    this.pickPhase = 'recorded';
  }

  /**
   * Start the readback. Call AFTER `queue.submit()`.
   *
   * Separate from `recordPick` because `mapAsync` may not be called while the
   * encoder is open, and separate from `retrievePick` because the map takes
   * time -- that wait is the whole reason picking is two-phase.
   *
   * REQUIRES `recorded`, NOT `dispatched`. Mapping a staging buffer that no
   * encoder wrote hands back stale bytes that decode as a real hit; demanding
   * proof of the GPU work turns that into a dropped pick instead.
   */
  beginPickReadback(): void {
    if (this.pickPhase !== 'recorded') return;

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
            this.fieldStrengths,
          ),
        ),
        i * this.entityUpdateStride,
      );
      canvasBytes.set(
        new Uint8Array(packCanvasUniforms(world, fc)),
        i * this.canvasStride,
      );
    }
    const queue = this.device.queue;
    queue.writeBuffer(this.entityUpdateUniforms, 0, entityBytes);
    queue.writeBuffer(this.canvasUniforms, 0, canvasBytes);

    this.recordRuleBake(encoder);

    for (let i = 0; i < steps; i++) {
      this.advance(encoder, i);
      onSubStep?.(encoder, i);
    }
    this._frameCount += steps;

    // NO `recordPick` HERE. It used to be, and that is the whole of the paused-
    // picking bug: this method is what a paused frame skips, so the pick passes
    // were never recorded while paused even though the readback still ran. The
    // caller records it after this returns, on the same encoder, which keeps the
    // "after the sub-steps" ordering and works in both branches.
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

    this.uniformSlots = steps;
    this.entityUpdateUniforms = this.makeUniformBuffer(
      'entity-update-uniforms',
      this.entityUpdateStride,
    );
    this.canvasUniforms = this.makeUniformBuffer('canvas-uniforms', this.canvasStride);

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
  }

  private updateEntities(encoder: GPUCommandEncoder, slot: number): void {
    if (this.computePipeline === null || this.computeStateGroup === null) return;
    const [wrap, parity] = this.textureGroupIndex();
    const textures = this.computeTextureGroups[wrap]?.[parity];
    if (textures === undefined) return;

    const pass = encoder.beginComputePass({
      label: 'entity-update',
      timestampWrites: timestampWrites('entity-update'),
    });
    pass.setPipeline(this.computePipeline);
    pass.setBindGroup(0, this.computeStateGroup, [slot * this.entityUpdateStride]);
    pass.setBindGroup(1, textures);
    // Bounded by the high-water mark, not the buffer size -- see
    // `activeEntityCount`. In the studio the two are equal, so this dispatches
    // exactly what it always did.
    pass.dispatchWorkgroups(workgroupsFor(this.activeEntityCount));
    pass.end();
  }

  private updateCanvas(encoder: GPUCommandEncoder, slot: number): void {
    if (this.canvasPipeline === null || this.canvasUniformGroup === null) return;
    const [wrap, parity] = this.textureGroupIndex();
    const textures = this.canvasTextureGroups[wrap]?.[parity];
    if (textures === undefined) return;

    const pass = encoder.beginRenderPass({
      label: 'canvas-update',
      timestampWrites: timestampWrites('canvas-update'),
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

    // THE SWAP, and it happens here and nowhere else -- so the texture this pass
    // just wrote, decay plus this step's deposits, is the one the next entity
    // update senses and the camera reads.
    const oldFront = this.front;
    this.front = this.back;
    this.back = oldFront;
    this.frontIsA = !this.frontIsA;
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
    // pair covers every phase without needing to know which one we are in.
    this.pickGeneration++;
    this.pickPhase = 'idle';
    this.pickStaging.unmap();

    this.entityBuffer.destroy();
    this.configBuffer.destroy();
    this.canvasA.texture.destroy();
    this.canvasB.texture.destroy();
    this.entityUpdateUniforms.destroy();
    this.canvasUniforms.destroy();
    this.splatBuffer.destroy();
    this.pickResult.destroy();
    this.pickStaging.destroy();
    this.pickUniforms.destroy();
    this.dummyTexture.destroy();
    // The lifetime buffers. Small in the studio (a dummy header and 4 bytes) and
    // megabytes in the sand modality, where Max Particles and World Size both
    // rebuild the system -- so leaking these would accumulate per change.
    this.freeListBuffer.destroy();
    // `headPhase` is set so the in-flight `mapAsync` callback, which fires after
    // this buffer is gone, takes its failure path instead of reading a destroyed
    // buffer. It already catches, but leaving the phase at `mapping` would also
    // strand the readback if the object somehow outlived the destroy.
    this.headPhase = 'idle';
    this.headStaging.destroy();
  }

  /** True when every pipeline compiled. Surfaced for the startup summary. */
  pipelineStatus(): Readonly<Record<string, boolean>> {
    return {
      entityUpdate: this.computePipeline !== null,
      canvas: this.canvasPipeline !== null,
      // Both from one module, but reported separately: they are separate
      // pipelines, and browserCheck.mjs greps this line for /FAILED/.
      entityPickReduce: this.pickReducePipeline !== null,
      entityPickDerive: this.pickDerivePipeline !== null,
    };
  }
}
