/**
 * Bloom: the mip chain that turns bright regions into a glow.
 * A port of `assembler/bloom.py`.
 *
 * The algorithm is the standard dual-filter pyramid:
 *
 *     downsample  full -> 1/2 -> 1/4 -> 1/8 -> 1/16 -> 1/32   (threshold at 1/2)
 *     upsample    1/32 -> 1/16 -> 1/8 -> 1/4 -> 1/2           (tent, additive)
 *
 * and the result is left in mip 0 at half resolution, which the assembler
 * samples with linear filtering. Half res is not a compromise: bloom is a wide,
 * soft signal, and there is nothing at full resolution for it to represent.
 *
 * Threshold is applied ONCE, on the way down into the first mip. Every pass
 * after that is blurring what the threshold already selected, so re-applying it
 * would just eat the glow it was meant to spread.
 *
 * Everything here works in linear HDR. The original Fluoddity blooms after
 * tonemapping and so has to inverse-tonemap on the way in and re-apply on the
 * way out; assembling in the sane order removes both round-trips and the
 * precision they cost.
 *
 * RESOURCES ARE LAZY. Nothing is allocated until the first `process()` call, so
 * bloom left switched off costs no VRAM at all -- which is why it can default
 * to off without the memory showing up anyway.
 *
 * ## What is pre-built, and what is not
 *
 * The nine passes read nine different textures, so the texture half of each
 * bind group cannot be shared. All nine are built ONCE per resize and reused;
 * the uniform slices ride one buffer each with a dynamic offset. Nothing is
 * allocated per frame.
 */

import { compileModule } from '../gpu/shaderModule.ts';
import { HDR_FORMAT } from '../app/renderTargets.ts';
import { alignTo } from '../particleSystem/uniforms.ts';
import { MIP_LEVELS, mipSizes } from './bloomChain.ts';
import {
  BLOOM_DOWNSAMPLE_UNIFORM_SIZE,
  BLOOM_UPSAMPLE_UNIFORM_SIZE,
  packBloomDownsampleUniforms,
  packBloomUpsampleUniforms,
} from './assemblerUniforms.ts';

import bloomDownsampleSource from './shaders/bloomDownsample.wgsl';
import bloomUpsampleSource from './shaders/bloomUpsample.wgsl';

interface Mip {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly size: readonly [number, number];
}

export class Bloom {
  private readonly device: GPUDevice;
  private readonly sampler: GPUSampler;

  private downPipeline: GPURenderPipeline | null = null;
  private upPipeline: GPURenderPipeline | null = null;
  private downLayout: GPUBindGroupLayout | null = null;
  private upLayout: GPUBindGroupLayout | null = null;

  private readonly downUniforms: GPUBuffer;
  private readonly upUniforms: GPUBuffer;
  private readonly downStride: number;
  private readonly upStride: number;

  /** Mip textures, largest first. Empty until the first `process()`. */
  private mips: Mip[] = [];
  /** One per level: the group reading the level above (or the source). */
  private downGroups: GPUBindGroup[] = [];
  /** One per upsample step: the group reading the level below. */
  private upGroups: GPUBindGroup[] = [];
  /** Source size the chain was built for; a change reallocates. */
  private sourceSize: readonly [number, number] | null = null;
  /** The source view the groups were built against. */
  private sourceView: GPUTextureView | null = null;

  constructor(device: GPUDevice, sampler: GPUSampler) {
    this.device = device;
    // Shared with the rest of the HDR chain. Clamped, not repeated: the tent
    // filter reaches past the edge, and repeat would wrap a bright edge's glow
    // around to the far side (`bloom.py:160-163`).
    this.sampler = sampler;

    const align = device.limits.minUniformBufferOffsetAlignment;
    this.downStride = alignTo(BLOOM_DOWNSAMPLE_UNIFORM_SIZE, align);
    this.upStride = alignTo(BLOOM_UPSAMPLE_UNIFORM_SIZE, align);

    // Sized for the whole chain up front: they are a few kilobytes, and unlike
    // the mip textures their size does not depend on the window.
    this.downUniforms = device.createBuffer({
      label: 'bloom-downsample-uniforms',
      size: this.downStride * MIP_LEVELS,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.upUniforms = device.createBuffer({
      label: 'bloom-upsample-uniforms',
      size: this.upStride * MIP_LEVELS,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * Reload both bloom shaders. Safe mid-execution.
   *
   * Each half builds independently: a failure in one leaves the other's
   * pipeline alone rather than taking the whole chain down (`bloom.py:66-71`).
   */
  async reload(): Promise<void> {
    const device = this.device;
    const [downModule, upModule] = await Promise.all([
      compileModule(device, 'bloomDownsample.wgsl', bloomDownsampleSource),
      compileModule(device, 'bloomUpsample.wgsl', bloomUpsampleSource),
    ]);

    // Identical shape for both, so one description covers them.
    const layout = (label: string): GPUBindGroupLayout =>
      device.createBindGroupLayout({
        label,
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            buffer: { type: 'uniform', hasDynamicOffset: true },
          },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        ],
      });

    if (downModule !== null) {
      this.downLayout = layout('bloom-downsample');
      this.downPipeline = device.createRenderPipeline({
        label: 'bloom-downsample',
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.downLayout] }),
        vertex: { module: downModule, entryPoint: 'fullscreen_vs' },
        fragment: {
          module: downModule,
          entryPoint: 'fs_main',
          // No blend: each downsample REPLACES its destination.
          targets: [{ format: HDR_FORMAT }],
        },
        primitive: { topology: 'triangle-strip' },
      });
    }

    if (upModule !== null) {
      this.upLayout = layout('bloom-upsample');
      this.upPipeline = device.createRenderPipeline({
        label: 'bloom-upsample',
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.upLayout] }),
        vertex: { module: upModule, entryPoint: 'fullscreen_vs' },
        fragment: {
          module: upModule,
          entryPoint: 'fs_main',
          targets: [
            {
              format: HDR_FORMAT,
              // The blend unit does the addition -- see bloomUpsample.wgsl.
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
              },
            },
          ],
        },
        primitive: { topology: 'triangle-strip' },
      });
    }

    // The layout objects are new, so every group built against the old ones is
    // stale. Dropping the source size forces a full rebuild on next process().
    this.invalidate();
  }

  pipelineStatus(): Readonly<Record<string, boolean>> {
    return {
      bloomDownsample: this.downPipeline !== null,
      bloomUpsample: this.upPipeline !== null,
    };
  }

  /** Drop the bind groups. Call after a resize, or when the source view changes. */
  invalidate(): void {
    this.downGroups = [];
    this.upGroups = [];
    this.sourceView = null;
  }

  /**
   * Build the bloom for `source`. Returns the half-res result, or null.
   *
   * Null means "no bloom this frame" rather than an error -- the shaders failed
   * to compile, or the window has no area. `assembler.py:92-95` reads it the
   * same way, and invariant 5 is why: a compile failure is logged, not fatal.
   */
  process(
    encoder: GPUCommandEncoder,
    source: GPUTextureView,
    sourceSize: readonly [number, number],
    threshold: number,
    radius: number,
  ): GPUTextureView | null {
    if (this.downPipeline === null || this.upPipeline === null) return null;
    if (this.downLayout === null || this.upLayout === null) return null;
    const [width, height] = sourceSize;
    if (width <= 0 || height <= 0) return null;

    this.ensureResources(width, height);
    if (this.mips.length === 0) return null;
    this.ensureGroups(source);

    // Uniforms for all nine passes, written before any pass is recorded --
    // `queue.writeBuffer` cannot interleave with an open encoder, the same
    // constraint the engine's sub-step loop solves the same way.
    const downBytes = new Uint8Array(this.downStride * MIP_LEVELS);
    const upBytes = new Uint8Array(this.upStride * MIP_LEVELS);
    for (let i = 0; i < MIP_LEVELS; i++) {
      // The SOURCE's texel size: the level being read, not written.
      const src = i === 0 ? sourceSize : this.mips[i - 1]!.size;
      downBytes.set(
        new Uint8Array(
          packBloomDownsampleUniforms([1 / src[0], 1 / src[1]], threshold, i === 0),
        ),
        i * this.downStride,
      );
    }
    for (let i = MIP_LEVELS - 1; i > 0; i--) {
      const src = this.mips[i]!.size;
      upBytes.set(
        new Uint8Array(packBloomUpsampleUniforms([1 / src[0], 1 / src[1]], radius)),
        i * this.upStride,
      );
    }
    const queue = this.device.queue;
    queue.writeBuffer(this.downUniforms, 0, downBytes);
    queue.writeBuffer(this.upUniforms, 0, upBytes);

    // -- down: source -> mip 0 -> mip 1 -> ... --
    // Straight into mip 0 from the source. The original blits to a full-res
    // copy first purely to get a matching format; ours already matches, so that
    // pass is pure cost.
    for (let i = 0; i < MIP_LEVELS; i++) {
      const pass = encoder.beginRenderPass({
        label: `bloom-down-${i}`,
        colorAttachments: [
          {
            view: this.mips[i]!.view,
            // 'clear' is right here: each downsample fully replaces its target.
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(this.downPipeline);
      pass.setBindGroup(0, this.downGroups[i]!, [i * this.downStride]);
      pass.draw(4);
      pass.end();
    }

    // -- up: mip N -> mip N-1 -> ... -> mip 0, adding as it goes --
    for (let i = MIP_LEVELS - 1; i > 0; i--) {
      const pass = encoder.beginRenderPass({
        label: `bloom-up-${i}`,
        colorAttachments: [
          {
            view: this.mips[i - 1]!.view,
            // 'load', NOT 'clear'. The destination holds its own downsampled
            // content and this pass adds to it -- see bloomUpsample.wgsl.
            loadOp: 'load',
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(this.upPipeline);
      pass.setBindGroup(0, this.upGroups[i]!, [i * this.upStride]);
      pass.draw(4);
      pass.end();
    }

    return this.mips[0]!.view;
  }

  private ensureResources(width: number, height: number): void {
    if (this.sourceSize !== null
      && this.sourceSize[0] === width
      && this.sourceSize[1] === height) {
      return;
    }
    this.release();

    for (const [w, h] of mipSizes(width, height)) {
      const texture = this.device.createTexture({
        label: `bloom-mip-${this.mips.length}`,
        size: { width: w, height: h },
        format: HDR_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.mips.push({ texture, view: texture.createView(), size: [w, h] });
    }
    this.sourceSize = [width, height];
  }

  private ensureGroups(source: GPUTextureView): void {
    if (this.sourceView === source && this.downGroups.length === MIP_LEVELS) return;

    const bind = (
      layout: GPUBindGroupLayout,
      label: string,
      uniforms: GPUBuffer,
      size: number,
      texture: GPUTextureView,
    ): GPUBindGroup =>
      this.device.createBindGroup({
        label,
        layout,
        entries: [
          { binding: 0, resource: { buffer: uniforms, size } },
          { binding: 1, resource: texture },
          { binding: 2, resource: this.sampler },
        ],
      });

    this.downGroups = [];
    for (let i = 0; i < MIP_LEVELS; i++) {
      this.downGroups.push(
        bind(
          this.downLayout!,
          `bloom-down-${i}`,
          this.downUniforms,
          BLOOM_DOWNSAMPLE_UNIFORM_SIZE,
          i === 0 ? source : this.mips[i - 1]!.view,
        ),
      );
    }

    // Index i reads mip i and writes mip i-1, so slot 0 is unused. Kept aligned
    // with the loop index rather than compacted, because an off-by-one between
    // "which mip do I read" and "which uniform slice do I bind" is exactly the
    // kind of error that produces a plausible-looking glow.
    this.upGroups = [];
    for (let i = 0; i < MIP_LEVELS; i++) {
      this.upGroups.push(
        bind(
          this.upLayout!,
          `bloom-up-${i}`,
          this.upUniforms,
          BLOOM_UPSAMPLE_UNIFORM_SIZE,
          this.mips[i]!.view,
        ),
      );
    }

    this.sourceView = source;
  }

  /** Free the mip chain. Called on resize and at shutdown. */
  release(): void {
    for (const mip of this.mips) mip.texture.destroy();
    this.mips = [];
    this.sourceSize = null;
    this.invalidate();
  }

  destroy(): void {
    this.release();
    this.downUniforms.destroy();
    this.upUniforms.destroy();
  }
}
