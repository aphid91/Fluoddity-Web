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
  CAMERA_VIEW_UNIFORM_SIZE,
  packCameraViewUniforms,
  type CameraView,
} from './cameraUniforms.ts';

import cameraSource from './shaders/camera.wgsl';

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
}

export class Camera {
  private readonly device: GPUDevice;
  readonly state: CameraState;

  /**
   * The format the camera renders into.
   *
   * 5.1 draws straight to the swap chain, so this is the surface's preferred
   * format. 5.3 replaces it with the HDR target's `rgba16float` and the
   * swap-chain format moves to the assembler, where it belongs.
   */
  private readonly targetFormat: GPUTextureFormat;

  private trailPipeline: GPURenderPipeline | null = null;
  private trailUniformLayout: GPUBindGroupLayout | null = null;
  private trailTextureLayout: GPUBindGroupLayout | null = null;
  private trailUniformGroup: GPUBindGroup | null = null;

  private readonly viewUniforms: GPUBuffer;
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

  /** Set by `beginFrame`; guards nothing yet, and grows a job in 5.3. */
  private samplesTaken = 0;

  private constructor(
    device: GPUDevice,
    state: CameraState,
    targetFormat: GPUTextureFormat,
  ) {
    this.device = device;
    this.state = state;
    this.targetFormat = targetFormat;

    this.viewUniforms = device.createBuffer({
      label: 'CameraViewUniforms',
      size: CAMERA_VIEW_UNIFORM_SIZE,
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
    targetFormat: GPUTextureFormat,
  ): Promise<Camera> {
    const camera = new Camera(device, state, targetFormat);
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
    const device = this.device;
    const module = await compileModule(device, 'camera.wgsl', cameraSource);
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

  /** True when every pipeline compiled. Surfaced for the startup summary. */
  pipelineStatus(): Readonly<Record<string, boolean>> {
    return { cameraTrail: this.trailPipeline !== null };
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
  beginFrame(frame: CameraFrame, _samples: number): void {
    this.samplesTaken = 0;
    const view: CameraView = {
      canvasSize: frame.canvasSize,
      windowSize: frame.windowSize,
      pan: this.state.pan,
      zoom: this.state.zoom,
    };
    this.device.queue.writeBuffer(this.viewUniforms, 0, packCameraViewUniforms(view));
  }

  /**
   * Draw one temporal sample.
   *
   * Everything needed arrives per call -- the Camera keeps no reference to the
   * simulation between frames, so the canvas double-buffer swap stays invisible
   * to it.
   */
  render(encoder: GPUCommandEncoder, target: GPUTextureView, frame: CameraFrame): void {
    // 5.2 adds the PARTICLES branch on `this.state.mode` here.
    this.renderTrail(encoder, target, frame);
    this.samplesTaken += 1;
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
  }
}
