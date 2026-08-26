/**
 * Camera: the view onto the simulation, and the temporal supersampler.
 * A port of `camera/camera.py`.
 *
 * Owns both ways of drawing the world:
 *
 *   TRAIL      a fullscreen pass that samples the canvas texture through the
 *              INVERSE camera transform. The quad never moves; each screen pixel
 *              asks "what world point do I show?". That inverse is what puts the
 *              letterbox bars in the right place.
 *
 *   PARTICLES  one instanced sprite per entity, transformed to screen ndc in the
 *              vertex shader. Particles are world-sized, so they grow as you
 *              zoom in.
 *
 * Both modes share one transform (`coords.ts` + `common.wgsl`), so they agree
 * pixel-for-pixel about where a world point lands. Toggling between them does
 * not shift the image -- which is the whole point of invariant 9, and the
 * cheapest available check that the port's flip decisions are right.
 *
 * Everything the Camera emits is LINEAR HDR. Tone curve, brightness, bloom and
 * the overlays belong to the assembler; the accumulator has to average energy
 * rather than display values, or blur would darken as it smeared.
 *
 * Camera holds no simulation state: the entity buffer and canvas texture are
 * handed to it per frame (ARCHITECTURE.md rule 3).
 *
 * ## Why no dynamic uniform offsets, when the engine needed them
 *
 * `particleSystem.ts` writes all 30 sub-steps' uniforms up front and binds each
 * pass a 256-byte-aligned slice, because `queue.writeBuffer` cannot interleave
 * with an open encoder and `frame_count` varies per sub-step. The camera has the
 * same shape -- `render()` is called N times inside one encoder -- but not the
 * same problem: `inv_samples` is constant across a cycle (`camera.py:149` sets
 * it once in `begin_frame`) and pan, zoom and both resolutions cannot change
 * mid-frame either. So every camera uniform is written ONCE, in `beginFrame()`,
 * before the encoder opens. Nothing varies per sample, so nothing needs a slice.
 */

import { compileModule } from '../gpu/shaderModule.ts';
import type { CameraState } from './cameraState.ts';
import {
  ACCUMULATE_UNIFORM_SIZE,
  CAM_BRUSH_UNIFORM_SIZE,
  CAMERA_VIEW_UNIFORM_SIZE,
  packAccumulateUniforms,
  packCamBrushUniforms,
  packCameraViewUniforms,
  type CameraView,
} from './cameraUniforms.ts';

import { HDR_FORMAT, type RenderTargets } from '../app/renderTargets.ts';

import cameraSource from './shaders/camera.wgsl';
import camBrushSource from './shaders/camBrush.wgsl';
import accumulateSource from './shaders/accumulate.wgsl';

/** What `render()` is handed per sample. Nothing here is held between frames. */
export interface CameraFrame {
  /**
   * The canvas texture to sample in TRAIL mode.
   *
   * Pulled PER SAMPLE by the caller, not hoisted: the double-buffer swaps
   * inside `advance()`, so a view captured before the sub-step loop goes stale
   * immediately (`orchestrator.py:325-327`).
   */
  readonly canvas: GPUTextureView;
  readonly canvasSize: readonly [number, number];
  readonly windowSize: readonly [number, number];
  /** The entity buffer, for PARTICLES mode. Never held between frames. */
  readonly entities: GPUBuffer;
  readonly entityCount: number;
  /**
   * From the SELECTED config, handed over rather than read from the config
   * buffer -- which belongs to ParticleSystem (rule 3). With several configs
   * loaded, the selected one sets the palette for all
   * (`orchestrator.py:334-339`).
   */
  readonly colorSensitivity: number;
  readonly colorByCohort: boolean;
  /**
   * The cohort under the mouse, or negative when none is highlighted.
   *
   * PARTICLES MODE ONLY, and not because it was scoped that way to save work:
   * TRAIL renders the canvas texture, which is a velocity flow field
   * (`brush.wgsl`'s fragment stage writes `vel`, and the target is rg16float) --
   * cohort is not in it and cannot be recovered from it. A per-cohort dim is
   * therefore not expressible in that mode at all.
   *
   * Optional so callers that do not highlight -- and the tests -- need not
   * thread it through.
   */
  readonly highlightedCohort?: number;
}

export class Camera {
  private readonly device: GPUDevice;
  readonly state: CameraState;

  /**
   * The format the camera renders into: the HDR target's, not the swap chain's.
   * Everything the Camera emits is LINEAR HDR -- the tone curve belongs to the
   * assembler, and the accumulator has to average energy rather than display
   * values or blur would darken as it smeared.
   */
  private readonly targetFormat = HDR_FORMAT;

  /** The HDR and accumulation targets. Owned by the app, resized per frame. */
  private readonly targets: RenderTargets;

  private trailPipeline: GPURenderPipeline | null = null;
  private trailUniformLayout: GPUBindGroupLayout | null = null;
  private trailTextureLayout: GPUBindGroupLayout | null = null;
  private trailUniformGroup: GPUBindGroup | null = null;

  private particlePipeline: GPURenderPipeline | null = null;
  private particleLayout: GPUBindGroupLayout | null = null;
  /**
   * Built once, unlike the canvas group: the entity buffer never swaps, so
   * there is nothing here to invalidate. Rebuilt only if the buffer identity
   * changes (a world-size rebuild), which `render` checks by holding the buffer
   * it was built against.
   */
  private particleGroup: GPUBindGroup | null = null;
  private particleGroupBuffer: GPUBuffer | null = null;

  private accumPipeline: GPURenderPipeline | null = null;
  private accumLayout: GPUBindGroupLayout | null = null;
  /** Rebuilt on resize: it references the HDR target's view. */
  private accumGroup: GPUBindGroup | null = null;

  private readonly viewUniforms: GPUBuffer;
  private readonly camBrushUniforms: GPUBuffer;
  private readonly accumUniforms: GPUBuffer;
  private readonly canvasSampler: GPUSampler;

  /**
   * Bind groups for the canvas texture, keyed on the VIEW OBJECT's identity.
   *
   * The canvas double-buffer alternates between exactly two views, and
   * `particleSystem.ts` creates each one once in `makeCanvas`, so two entries
   * cover every frame and nothing is allocated per sample. At
   * `motionBlurSamples = 10` the naive rebuild-per-sample would be ten
   * allocations a frame.
   *
   * Keyed on identity rather than on a parity flag because the Camera is not
   * told which buffer is front -- and if `ParticleSystem` ever started creating
   * views per call, this degrades to one allocation per sample rather than
   * breaking. A safe failure mode, but worth knowing about.
   */
  private readonly canvasGroups = new WeakMap<GPUTextureView, GPUBindGroup>();

  /**
   * Samples accumulated into the current cycle. Reset by `beginFrame`, zeroed
   * by `invalidateTargets`.
   *
   * Guards two things: `result()` refuses to present an accumulator nothing has
   * been drawn into, and `canHold()` reports whether there is a completed frame
   * for the queued pause to freeze on.
   */
  private samplesTaken = 0;

  private constructor(device: GPUDevice, state: CameraState, targets: RenderTargets) {
    this.device = device;
    this.state = state;
    this.targets = targets;

    this.viewUniforms = device.createBuffer({
      label: 'CameraViewUniforms',
      size: CAMERA_VIEW_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.camBrushUniforms = device.createBuffer({
      label: 'CamBrushUniforms',
      size: CAM_BRUSH_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.accumUniforms = device.createBuffer({
      label: 'AccumulateUniforms',
      size: ACCUMULATE_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Clamp, not the boundary-mode sampler. `camera.frag:40-43` early-outs to
    // black outside [0,1], so the address mode is never reached -- binding the
    // repeating sampler would imply the boundary mode matters to the present
    // pass, and it does not. Linear because zooming in must not show texels.
    this.canvasSampler = device.createSampler({
      label: 'camera-canvas',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
  }

  static async create(
    device: GPUDevice,
    state: CameraState,
    targets: RenderTargets,
  ): Promise<Camera> {
    const camera = new Camera(device, state, targets);
    await camera.reload();
    return camera;
  }

  /**
   * Compile shaders and rebuild pipelines. Safe to call mid-execution.
   *
   * Invariant 5's shape: a failed compile leaves the pipeline null and every
   * pass early-returns, rather than taking the app down. The reload *triggers*
   * are gone (no browser meaning), but the isolation survives.
   */
  async reload(): Promise<void> {
    // Both compiled before either pipeline is built, so a failure in one does
    // not skip the other -- the desktop reloads each half independently for the
    // same reason (`bloom.py:66-71`).
    const [module, brushModule, accumModule] = await Promise.all([
      compileModule(this.device, 'camera.wgsl', cameraSource),
      compileModule(this.device, 'camBrush.wgsl', camBrushSource),
      compileModule(this.device, 'accumulate.wgsl', accumulateSource),
    ]);
    this.buildTrail(module);
    this.buildParticles(brushModule);
    this.buildAccumulate(accumModule);
  }

  private buildAccumulate(module: GPUShaderModule | null): void {
    const device = this.device;
    if (module === null) {
      this.accumPipeline = null;
      return;
    }

    this.accumLayout = device.createBindGroupLayout({
      label: 'accumulate',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });

    this.accumPipeline = device.createRenderPipeline({
      label: 'accumulate',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.accumLayout] }),
      vertex: { module, entryPoint: 'fullscreen_vs' },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [
          {
            format: HDR_FORMAT,
            // The blend unit does the summing; the shader supplies the 1/N
            // weight. See accumulate.wgsl for why this is not a
            // read-modify-write.
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-strip' },
    });

    this.accumGroup = null; // The layout object is new; the old group is stale.
  }

  /** Rebuild the bind group that references the HDR view. Called after a resize. */
  private ensureAccumGroup(): GPUBindGroup | null {
    if (this.accumLayout === null) return null;
    const hdr = this.targets.hdr;
    if (hdr === null) return null;
    if (this.accumGroup !== null) return this.accumGroup;

    this.accumGroup = this.device.createBindGroup({
      label: 'accumulate',
      layout: this.accumLayout,
      entries: [
        { binding: 0, resource: { buffer: this.accumUniforms } },
        { binding: 1, resource: hdr },
        { binding: 2, resource: this.targets.sampler },
      ],
    });
    return this.accumGroup;
  }

  /**
   * Drop bind groups that reference the render targets. Call after a resize.
   *
   * ALSO FORGETS THE ACCUMULATED FRAME. A resize replaces the accumulation
   * texture, so whatever average it held is gone -- reporting otherwise would
   * let the queued pause's hold reuse a texture that no longer has the still in
   * it. `canHold()` and `result()` both read this counter, so zeroing it here
   * makes a resize mid-pause fall back to a live re-render, which is exactly
   * what a stale still should do.
   */
  invalidateTargets(): void {
    this.accumGroup = null;
    this.samplesTaken = 0;
  }

  private buildTrail(module: GPUShaderModule | null): void {
    const device = this.device;
    if (module === null) {
      this.trailPipeline = null;
      return;
    }

    this.trailUniformLayout = device.createBindGroupLayout({
      label: 'camera-view',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    this.trailTextureLayout = device.createBindGroupLayout({
      label: 'camera-canvas',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });

    this.trailPipeline = device.createRenderPipeline({
      label: 'camera-trail',
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.trailUniformLayout, this.trailTextureLayout],
      }),
      vertex: { module, entryPoint: 'fullscreen_vs' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: this.targetFormat }] },
      primitive: { topology: 'triangle-strip' },
    });

    this.trailUniformGroup = device.createBindGroup({
      label: 'camera-view',
      layout: this.trailUniformLayout,
      entries: [{ binding: 0, resource: { buffer: this.viewUniforms } }],
    });
  }

  private buildParticles(module: GPUShaderModule | null): void {
    const device = this.device;
    if (module === null) {
      this.particlePipeline = null;
      return;
    }

    this.particleLayout = device.createBindGroupLayout({
      label: 'cam-brush',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage' },
        },
      ],
    });

    this.particlePipeline = device.createRenderPipeline({
      label: 'camera-particles',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.particleLayout] }),
      vertex: { module, entryPoint: 'vs_main' },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [
          {
            format: this.targetFormat,
            // Additive: overlapping sprites accumulate into brighter regions,
            // which is what makes density legible. Unrelated to the TEMPORAL
            // accumulation of motion blur -- this one is within a single sample.
            //
            // moderngl's `blend_func = ONE, ONE` sets colour AND alpha; WebGPU
            // requires both spelled out.
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            },
          },
        ],
      },
      primitive: {
        topology: 'triangle-strip',
        // The strip reorder in camBrush.wgsl flips one triangle's winding.
        cullMode: 'none',
      },
    });

    // Invalidate: the layout object is new, so the old group no longer matches.
    this.particleGroup = null;
    this.particleGroupBuffer = null;
  }

  /** True when every pipeline compiled. Surfaced for the startup summary. */
  pipelineStatus(): Readonly<Record<string, boolean>> {
    return {
      cameraTrail: this.trailPipeline !== null,
      cameraParticles: this.particlePipeline !== null,
      accumulate: this.accumPipeline !== null,
    };
  }

  /**
   * Open an accumulation cycle for one displayed frame.
   *
   * `samples` is the DERIVED count from `blurSchedule`, not the number the user
   * asked for. It must equal the number of `render()` calls that follow, or the
   * frame comes out mis-weighted.
   *
   * Writes uniforms and nothing else -- no encoder exists yet, which is why the
   * accumulator's clear cannot live here (see 5.3).
   */
  beginFrame(frame: CameraFrame, samples: number): void {
    this.samplesTaken = 0;
    const view: CameraView = {
      canvasSize: frame.canvasSize,
      windowSize: frame.windowSize,
      pan: this.state.pan,
      zoom: this.state.zoom,
    };
    // Both modes' uniforms, unconditionally. Writing only the active mode's
    // would leave the other stale, and the mode can change between frames --
    // 24 wasted bytes against a class of bug that appears one frame after a
    // toggle and then corrects itself, which is the worst kind to reproduce.
    const queue = this.device.queue;
    queue.writeBuffer(this.viewUniforms, 0, packCameraViewUniforms(view));
    queue.writeBuffer(
      this.camBrushUniforms,
      0,
      packCamBrushUniforms(
        view,
        frame.colorSensitivity,
        frame.colorByCohort,
        frame.highlightedCohort ?? -1,
      ),
    );
    queue.writeBuffer(this.accumUniforms, 0, packAccumulateUniforms(samples));
  }

  /**
   * Whether a completed frame is available to hold.
   *
   * The queued pause's settled still is an average of samples taken from a
   * simulation state that has since been advanced past: the accumulator texture
   * is the ONLY copy, and it cannot be re-rendered from. A frame that holds it
   * records no clear and no `render()`, and so must skip `beginFrame` entirely
   * -- that method's `samplesTaken = 0` would make `result()` report an empty
   * accumulator and blank the screen.
   *
   * The frame loop asks this before committing to a hold, so "there is
   * something to hold" is decided by the same counter `result()` guards on
   * rather than by two places tracking it separately.
   */
  canHold(): boolean {
    return this.samplesTaken > 0 && this.targets.accum !== null;
  }

  /**
   * Clear the accumulator. Must be recorded before the first `render()`.
   *
   * A zero-draw render pass, which is a legal and cheap way to express "clear
   * this attachment". Separate from `beginFrame` because clearing needs an
   * ENCODER and `beginFrame` runs before one exists (it writes uniforms, which
   * conversely cannot happen once an encoder is open).
   *
   * The alternative -- branching `loadOp` on `samplesTaken === 0` inside
   * `accumulate` -- would reintroduce exactly the first-sample special case
   * `camera.py:150-153` is proud of having removed ("Clearing once per cycle IS
   * the reset... there is no first-sample special case"). One extra pass against
   * 100+ is the better trade, and it keeps the clear and `result()`'s guard
   * decided by the same variable in the same place. If the empty pass ever shows
   * up in a profile, the `loadOp` branch is a one-line change.
   */
  clearAccumulator(encoder: GPUCommandEncoder): void {
    const accum = this.targets.accum;
    if (accum === null) return;
    encoder
      .beginRenderPass({
        label: 'accumulate-clear',
        colorAttachments: [
          {
            view: accum,
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      })
      .end();
  }

  /**
   * The finished supersampled frame, linear HDR.
   *
   * Null before any sample has landed, which is what the caller checks rather
   * than presenting an uninitialized buffer (`camera.py:179-187`).
   */
  result(): GPUTextureView | null {
    if (this.samplesTaken === 0) return null;
    return this.targets.accum;
  }

  /**
   * Draw one temporal sample.
   *
   * Everything needed arrives per call -- the Camera keeps no reference to the
   * simulation between frames, so the canvas double-buffer swap stays invisible
   * to it.
   */
  render(encoder: GPUCommandEncoder, frame: CameraFrame): void {
    const hdr = this.targets.hdr;
    if (hdr === null) return;

    if (this.state.mode === 'particles') {
      this.renderParticles(encoder, hdr, frame);
    } else {
      this.renderTrail(encoder, hdr, frame);
    }
    this.accumulate(encoder);
    this.samplesTaken += 1;
  }

  /**
   * Add the sample just rendered into the running average.
   *
   * The 1/N weight is applied in the shader and the sum by the blend unit, so
   * the accumulator is never read back -- see accumulate.wgsl for why that
   * matters (it is undefined behaviour on the desktop and a hard validation
   * error here).
   */
  private accumulate(encoder: GPUCommandEncoder): void {
    const accum = this.targets.accum;
    const group = this.ensureAccumGroup();
    if (this.accumPipeline === null || accum === null || group === null) return;

    const pass = encoder.beginRenderPass({
      label: 'accumulate',
      colorAttachments: [
        {
          view: accum,
          // 'load', NEVER 'clear': this pass ADDS to the running sum. The clear
          // happens once per cycle in clearAccumulator().
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(this.accumPipeline);
    pass.setBindGroup(0, group);
    pass.draw(4);
    pass.end();
  }

  private renderParticles(
    encoder: GPUCommandEncoder,
    target: GPUTextureView,
    frame: CameraFrame,
  ): void {
    if (this.particlePipeline === null || this.particleLayout === null) return;

    if (this.particleGroup === null || this.particleGroupBuffer !== frame.entities) {
      this.particleGroup = this.device.createBindGroup({
        label: 'cam-brush',
        layout: this.particleLayout,
        entries: [
          { binding: 0, resource: { buffer: this.camBrushUniforms } },
          { binding: 1, resource: { buffer: frame.entities } },
        ],
      });
      this.particleGroupBuffer = frame.entities;
    }

    const pass = encoder.beginRenderPass({
      label: 'camera-particles',
      colorAttachments: [
        {
          view: target,
          // Cleared per sample, like TRAIL: additive blending accumulates
          // within a sample, so the previous sample's content must not be
          // underneath it.
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(this.particlePipeline);
    pass.setBindGroup(0, this.particleGroup);
    // 4 vertices per entity, instanced. No vertex buffer -- the quad comes from
    // the vertex index and the entity from the instance index.
    pass.draw(4, frame.entityCount);
    pass.end();
  }

  private renderTrail(
    encoder: GPUCommandEncoder,
    target: GPUTextureView,
    frame: CameraFrame,
  ): void {
    if (this.trailPipeline === null || this.trailTextureLayout === null) return;
    if (this.trailUniformGroup === null) return;

    let textures = this.canvasGroups.get(frame.canvas);
    if (textures === undefined) {
      textures = this.device.createBindGroup({
        label: 'camera-canvas',
        layout: this.trailTextureLayout,
        entries: [
          { binding: 0, resource: frame.canvas },
          { binding: 1, resource: this.canvasSampler },
        ],
      });
      this.canvasGroups.set(frame.canvas, textures);
    }

    const pass = encoder.beginRenderPass({
      label: 'camera-trail',
      colorAttachments: [
        {
          view: target,
          // Cleared per sample: this pass writes every pixel it keeps and
          // early-outs to black in the letterbox, but the previous sample's
          // content must not survive underneath either way.
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(this.trailPipeline);
    pass.setBindGroup(0, this.trailUniformGroup);
    pass.setBindGroup(1, textures);
    pass.draw(4);
    pass.end();
  }

  destroy(): void {
    this.viewUniforms.destroy();
    this.camBrushUniforms.destroy();
    this.accumUniforms.destroy();
  }
}
