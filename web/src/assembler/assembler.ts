/**
 * Assembler: the finished camera frame, turned into what the screen shows.
 * A port of `assembler/assembler.py`.
 *
 * The Camera hands over a linear HDR frame -- possibly the average of several
 * temporal samples -- and this module takes it the rest of the way:
 *
 *     bloom        wide glow around bright regions, added in linear space
 *     brightness   exposure, still linear
 *     tone curve   asinh, linear -> display
 *     overlays     strafe field, brush reticle
 *
 * THE ORDER IS THE POINT. Light is added and exposed while the values still
 * mean energy, and the curve runs once at the end; the original Fluoddity
 * tonemaps before blooming and pays for it by inverse-tonemapping in two
 * separate shaders to get back to a space where addition is meaningful.
 *
 * Everything but bloom happens in one pass (`shaders/frameAssembly.wgsl`),
 * because each stage is a handful of instructions on a value already in a
 * register -- splitting them into separate passes would cost a full-screen read
 * and write each to save nothing.
 *
 * Holds no simulation state and no preferences: the caller passes what this
 * needs per frame, including the already-resolved decisions about whether the
 * overlays should be visible at all.
 *
 * ## The dummy textures
 *
 * `assembler.py:102-109` relies on "intensity 0 means the sampler is never
 * fetched, so a stale binding is harmless." WebGPU validates a bind group
 * whether or not the shader reads it, so both optional slots carry a real 1x1
 * texture when their feature is off. The zero in the uniform is still what
 * guarantees they are never sampled for real -- the dummy is a validation
 * formality, not a fallback anyone should see.
 */

import { compileModule } from '../gpu/shaderModule.ts';
import { HDR_FORMAT, type RenderTargets } from '../app/renderTargets.ts';
import { CANVAS_FORMAT } from '../particleSystem/particleSystem.ts';
import type { CameraView } from '../camera/cameraUniforms.ts';
import type { DisplayPreferences } from '../prefs/preferences.ts';
import {
  FRAME_ASSEMBLY_UNIFORM_SIZE,
  packFrameAssemblyUniforms,
  type OverlayState,
} from './assemblerUniforms.ts';

import frameAssemblySource from './shaders/frameAssembly.wgsl';

export class Assembler {
  private readonly device: GPUDevice;
  private readonly targets: RenderTargets;
  private readonly outputFormat: GPUTextureFormat;

  private pipeline: GPURenderPipeline | null = null;
  private uniformLayout: GPUBindGroupLayout | null = null;
  private textureLayout: GPUBindGroupLayout | null = null;
  private uniformGroup: GPUBindGroup | null = null;
  /** Rebuilt on resize; 5.5 adds a second variant for bloom-on. */
  private textureGroup: GPUBindGroup | null = null;

  private readonly uniforms: GPUBuffer;
  /** 1x1 stand-ins. See the class header. */
  private readonly dummyHdrView: GPUTextureView;
  private readonly dummyFieldView: GPUTextureView;

  private constructor(
    device: GPUDevice,
    targets: RenderTargets,
    outputFormat: GPUTextureFormat,
  ) {
    this.device = device;
    this.targets = targets;
    this.outputFormat = outputFormat;

    this.uniforms = device.createBuffer({
      label: 'FrameAssemblyUniforms',
      size: FRAME_ASSEMBLY_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // The formats must match what will really be bound there, or the bind group
    // is rejected when the real texture arrives: bloom is rgba16float like the
    // rest of the HDR chain, the strafe field is rg16float like the canvas.
    const dummy = (label: string, format: GPUTextureFormat): GPUTextureView =>
      device
        .createTexture({
          label,
          size: { width: 1, height: 1 },
          format,
          usage: GPUTextureUsage.TEXTURE_BINDING,
        })
        .createView();
    this.dummyHdrView = dummy('bloom-placeholder', HDR_FORMAT);
    this.dummyFieldView = dummy('strafe-field-placeholder', CANVAS_FORMAT);
  }

  static async create(
    device: GPUDevice,
    targets: RenderTargets,
    outputFormat: GPUTextureFormat,
  ): Promise<Assembler> {
    const assembler = new Assembler(device, targets, outputFormat);
    await assembler.reload();
    return assembler;
  }

  /** Reload the assembly shader. Safe mid-execution; invariant 5's shape. */
  async reload(): Promise<void> {
    const device = this.device;
    const module = await compileModule(
      device,
      'frameAssembly.wgsl',
      frameAssemblySource,
    );
    if (module === null) {
      this.pipeline = null;
      return;
    }

    this.uniformLayout = device.createBindGroupLayout({
      label: 'frame-assembly-uniforms',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    this.textureLayout = device.createBindGroupLayout({
      label: 'frame-assembly-textures',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });

    this.pipeline = device.createRenderPipeline({
      label: 'frame-assembly',
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.uniformLayout, this.textureLayout],
      }),
      vertex: { module, entryPoint: 'fullscreen_vs' },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [{ format: this.outputFormat }],
      },
      primitive: { topology: 'triangle-strip' },
    });

    this.uniformGroup = device.createBindGroup({
      label: 'frame-assembly-uniforms',
      layout: this.uniformLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniforms } }],
    });
    this.textureGroup = null;
  }

  /** True when the pipeline compiled. Surfaced for the startup summary. */
  pipelineStatus(): Readonly<Record<string, boolean>> {
    return { frameAssembly: this.pipeline !== null };
  }

  /** Drop bind groups that reference the render targets. Call after a resize. */
  invalidateTargets(): void {
    this.textureGroup = null;
  }

  /**
   * Assemble `source` onto `target`.
   *
   * `overlays` arrives already decided: whether an overlay belongs on screen,
   * and which tool it is describing, depends on the active tool -- and that is
   * the Orchestrator's to know, not this module's (`assembler.py:80-86`).
   */
  present(
    encoder: GPUCommandEncoder,
    source: GPUTextureView | null,
    target: GPUTextureView,
    view: CameraView,
    prefs: DisplayPreferences,
    overlays: OverlayState,
  ): void {
    if (this.pipeline === null || this.textureLayout === null) return;
    if (this.uniformGroup === null || source === null) return;

    // 5.5 passes the real mip 0 here and flips `bloomAvailable` to true.
    const bloomView = this.dummyHdrView;
    const bloomAvailable = false;

    this.device.queue.writeBuffer(
      this.uniforms,
      0,
      packFrameAssemblyUniforms(view, prefs, bloomAvailable, overlays),
    );

    this.textureGroup ??= this.device.createBindGroup({
      label: 'frame-assembly-textures',
      layout: this.textureLayout,
      entries: [
        { binding: 0, resource: source },
        { binding: 1, resource: bloomView },
        { binding: 2, resource: this.dummyFieldView },
        { binding: 3, resource: this.targets.sampler },
      ],
    });

    const pass = encoder.beginRenderPass({
      label: 'frame-assembly',
      colorAttachments: [
        {
          view: target,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.uniformGroup);
    pass.setBindGroup(1, this.textureGroup);
    pass.draw(4);
    pass.end();
  }

  destroy(): void {
    this.uniforms.destroy();
  }
}
