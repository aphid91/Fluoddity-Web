/**
 * StrafeField: a painted vector field that displaces every particle.
 *
 * A port of `strafe_field/strafe_field.py` (233 lines).
 *
 * WHAT IT IS
 * One rg16float texture at capped canvas resolution. Each texel holds a
 * world-space vector added straight to the position of any particle over it,
 * every physics step. That makes it ADVECTION rather than a force: it bypasses
 * velocity entirely, so drag never damps it and no particle can "swim upstream"
 * against it the way a rule can resist a force. Paint a swirl and everything
 * caught in it goes around, regardless of what it would rather be doing.
 *
 * WHY IT IS NOT PING-PONGED
 * The drawing shader never samples the field, only writes it, and each fragment
 * writes exactly its own texel. There is no read-write hazard to double-buffer
 * away, so the brush renders into the texture in place via hardware blending.
 * Contrast the canvas, which diffuses and therefore must ping-pong.
 *
 * WHY IT IS NOT SAVED
 * The texture is megabytes of binary and belongs to no Project. It is live-only:
 * not serialized with a config, not in the undo timeline. "Clear Field" is the
 * reset. This matches the decision to leave canvas trails out of the save
 * format, and keeps History a timeline of Projects rather than of mixed state.
 *
 * The Orchestrator drives this module; it holds no reference to any other.
 */

import { compileModule } from '../gpu/shaderModule.ts';
import { FIELD_FORMAT, fieldDimensions } from './fieldSize.ts';
import { FIELD_LAYERS, LAYER_WRITE_MASK, type FieldLayer } from './fieldLayer.ts';
import {
  STRAFE_DRAW_UNIFORM_SIZE,
  packStrafeDrawUniforms,
  type BrushParams,
} from './strafeUniforms.ts';
import strafeDrawSource from './shaders/strafeDraw.wgsl';

/**
 * The brush radius `clear()` erases with, in the aspect-corrected uv metric.
 *
 * The field spans at most ~1 unit per axis in that metric, and the eraser admits
 * fragments within `2 * draw_size` of the stroke, so anything above ~0.71 from the
 * centre already covers the far corner. 4.0 is far past that with room for any
 * aspect ratio -- deliberately not tight, since the only cost of overshooting is
 * arithmetic on fragments that were going to be written anyway.
 */
const CLEAR_RADIUS = 4.0;

export class StrafeField {
  private readonly device: GPUDevice;

  /**
   * The field's OWN resolution, which is not the canvas's once MAX_FIELD_DIM
   * bites. Everything downstream -- the aspect correction in the shader, the uv
   * mapping from the cursor -- must read this, never the canvas size, or strokes
   * would skew at large world sizes. The desktop's attribute was once called
   * `canvas_size`, which invited exactly that mistake.
   */
  readonly size: readonly [number, number];

  private texture: GPUTexture;
  private textureView: GPUTextureView;
  private readonly uniforms: GPUBuffer;

  /**
   * FOUR PIPELINES, ONE SHADER MODULE, ONE ENTRY POINT: {draw, erase} x {walls,
   * trails}. Keyed by layer, because both axes are per-pipeline state that no
   * uniform can express.
   *
   * **Blend state** is per-pipeline in WebGPU, and the two operations differ in
   * it: drawing accumulates (ONE, ONE) so a held brush builds up, while erasing
   * must write literal zeros and therefore runs unblended.
   *
   * **The colour write mask** is likewise per-pipeline, and it is what makes the
   * two layers independent: a walls pass physically cannot write the trails
   * channels. That is load-bearing for ERASE and CLEAR specifically, which write
   * literal values with blending off -- unmasked, erasing walls would take the
   * trails with it. See `LAYER_WRITE_MASK`.
   *
   * `erase_mode` REMAINS A UNIFORM AS WELL, which looks redundant and is not.
   * The pipelines differ in blending; the shader branch differs in what it
   * writes and where it discards. Collapsing either into the other loses a real
   * distinction -- there is no blend state that turns the gaussian into a hard
   * circle, and no uniform that turns off blending.
   */
  private drawPipelines: Partial<Record<FieldLayer, GPURenderPipeline>> = {};
  private erasePipelines: Partial<Record<FieldLayer, GPURenderPipeline>> = {};
  private uniformGroup: GPUBindGroup | null = null;

  /**
   * Follows the world's boundary mode.
   *
   * STORED, WITH NO GPU WORK TO DO, and that is worth being explicit about
   * rather than quietly omitting. The desktop sets `texture.repeat_x/y` here
   * because wrap is a TEXTURE property in GL. In WebGPU it is a SAMPLER
   * property, and this class owns no sampler: the field is never read by its own
   * shader (`strafe_draw.frag:13-14`). Its two readers own the sampling, and
   * both are already right --
   *
   *   - `entityUpdate.wgsl` binds it at compute group 1 binding 3, which
   *     `ParticleSystem.buildTextureGroups` fills with the SAME sampler as the
   *     canvas's binding 1. One variant per address mode, so the field cannot
   *     disagree with the canvas about the boundary. The desktop has to state
   *     this twice and keep the two in step; here it is structural.
   *   - `frameAssembly.wgsl` shares the linear-clamp target sampler, and its
   *     overlay is guarded by `inside`, so it never samples outside [0,1] and
   *     wrap is unreachable.
   *
   * Kept anyway, because invariant 9 wants four things to agree on the boundary
   * mode and this is the fourth: `Orchestrator.setProject` calls it, so the
   * accounting is visible at the one place project state changes. If it ever
   * grows a sampler of its own, the call site is already there.
   */
  private wrap = false;

  private constructor(device: GPUDevice, canvasSize: readonly [number, number]) {
    this.device = device;
    this.size = fieldDimensions(canvasSize);

    // rgba16float: FOUR signed, unclamped channels -- two 2D vectors per texel,
    // walls in rg and trails in ba. Signed because a brush vector points in any
    // direction; unclamped because strokes accumulate additively and a normalized
    // format would saturate almost immediately.
    //
    // Unlike the desktop this needs no explicit zero-clear: WebGPU guarantees a
    // freshly created texture reads as zero, where an unwritten GL float texture
    // is undefined -- and undefined here means every particle is shoved by
    // garbage on frame one (`strafe_field.py:101-103`).
    this.texture = device.createTexture({
      label: 'strafe-field',
      size: { width: this.size[0], height: this.size[1] },
      format: FIELD_FORMAT,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        // For verification only, matching the canvas: it is what lets a test
        // read the painted field back and compare it against the desktop's own
        // dump. That comparison is the strongest assertion available for this
        // pass, because one fullscreen draw with no feedback is deterministic.
        GPUTextureUsage.COPY_SRC,
    });
    this.textureView = this.texture.createView();

    this.uniforms = device.createBuffer({
      label: 'strafe-draw-uniforms',
      size: STRAFE_DRAW_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  static async create(
    device: GPUDevice,
    canvasSize: readonly [number, number],
  ): Promise<StrafeField> {
    const field = new StrafeField(device, canvasSize);
    await field.reload();
    return field;
  }

  /**
   * Compile the brush shader and build both pipelines.
   *
   * Invariant 5's shape: a failed compile leaves the pipelines null and the
   * paint calls below return early, so the app runs without a brush rather than
   * not running.
   */
  async reload(): Promise<void> {
    const device = this.device;
    const module = await compileModule(device, 'strafeDraw.wgsl', strafeDrawSource);
    if (module === null) {
      this.drawPipelines = {};
      this.erasePipelines = {};
      return;
    }

    const layout = device.createBindGroupLayout({
      label: 'strafe-draw-uniforms',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });

    const build = (
      label: string,
      blend: GPUBlendState | undefined,
      writeMask: number,
    ): GPURenderPipeline =>
      device.createRenderPipeline({
        label,
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main' },
        fragment: {
          module,
          entryPoint: 'fs_main',
          targets: [{ format: FIELD_FORMAT, blend, writeMask }],
        },
        primitive: { topology: 'triangle-strip' },
      });

    const additive: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    };

    this.drawPipelines = {};
    this.erasePipelines = {};
    for (const layer of FIELD_LAYERS) {
      const mask = LAYER_WRITE_MASK[layer];
      this.drawPipelines[layer] = build(`strafe-draw-${layer}`, additive, mask);
      // No blend state at all: the erase branch writes literal zero, and blending
      // it additively would make the eraser a no-op. The MASK is what keeps that
      // zero off the other layer's channels.
      this.erasePipelines[layer] = build(`strafe-erase-${layer}`, undefined, mask);
    }

    this.uniformGroup = device.createBindGroup({
      label: 'strafe-draw-uniforms',
      layout,
      entries: [{ binding: 0, resource: { buffer: this.uniforms } }],
    });
  }

  /**
   * The field texture to sample this frame.
   *
   * Returned by value each frame rather than held by consumers, matching
   * `ParticleSystem.currentCanvasTexture()` -- so a future double-buffering of
   * this field would stay invisible to everything downstream.
   */
  view(): GPUTextureView {
    return this.textureView;
  }

  /** Follow the world's boundary mode. See the `wrap` field for what this does. */
  setWrap(wrap: boolean): void {
    this.wrap = wrap;
  }

  /** Whether the field is following a wrapping boundary. Diagnostics only. */
  get wrapping(): boolean {
    return this.wrap;
  }

  /**
   * Accumulate one stroke segment into the layer `brush` names.
   *
   * The segment is `prevUv -> uv` whether it came from one frame of a drag or
   * from the line tool's anchor and endpoint; this class does not distinguish
   * them, and neither does the shader.
   */
  draw(
    encoder: GPUCommandEncoder,
    uv: readonly [number, number],
    prevUv: readonly [number, number],
    brush: BrushParams,
  ): void {
    this.pass(encoder, uv, prevUv, brush, false);
  }

  /**
   * Zero one layer along one stroke segment.
   *
   * `drawPower` is ignored (the caller still supplies a `BrushParams`, since the
   * radius and the layer are both read): erasing is absolute, so there is nothing
   * for a strength control to mean. `brush.layer` is what keeps a walls eraser
   * off the trails.
   */
  erase(
    encoder: GPUCommandEncoder,
    uv: readonly [number, number],
    prevUv: readonly [number, number],
    brush: BrushParams,
  ): void {
    this.pass(encoder, uv, prevUv, brush, true);
  }

  /**
   * One fullscreen pass over the field.
   *
   * TAKES THE FRAME'S ENCODER rather than opening its own. The frame loop opens
   * exactly one encoder per frame, and a separate submission for a stroke would
   * be ordering-ambiguous against the physics that reads the field in the same
   * frame -- the paint could land before or after, which is the kind of race
   * that shows up as an occasional dropped stroke.
   */
  private pass(
    encoder: GPUCommandEncoder,
    uv: readonly [number, number],
    prevUv: readonly [number, number],
    brush: BrushParams,
    erase: boolean,
  ): void {
    const pipeline = erase
      ? this.erasePipelines[brush.layer]
      : this.drawPipelines[brush.layer];
    if (pipeline === undefined || this.uniformGroup === null) return;

    this.device.queue.writeBuffer(
      this.uniforms,
      0,
      packStrafeDrawUniforms(this.size, uv, prevUv, brush, erase),
    );

    const pass = encoder.beginRenderPass({
      label: erase ? `strafe-erase-${brush.layer}` : `strafe-draw-${brush.layer}`,
      colorAttachments: [
        {
          view: this.textureView,
          // 'load', NEVER 'clear'. The desktop renders into the field without
          // clearing; moderngl simply does not, so the GLSL says nothing about
          // it. A 'clear' here would wipe the whole field on every stroke frame,
          // which reads as "the brush only paints while I am moving" -- plausible
          // behaviour rather than an obvious bug. Same trap as the bloom
          // upsample.
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.uniformGroup);
    pass.draw(4);
    pass.end();
  }

  /**
   * Zero ONE layer of the field, leaving the other untouched.
   *
   * ## Why this is a masked DRAW and not `loadOp: 'clear'`
   *
   * It used to be a render pass with no draws, which is the cheapest clear there
   * is. **That shape cannot survive two layers in one texture:** `clearValue`
   * applies to the whole attachment and IGNORES the colour write mask entirely
   * (the mask governs fragment output, and a clear produces no fragments). So a
   * `loadOp: 'clear'` here would zero all four channels, and "Clear Walls" would
   * silently take the trails with it -- exactly the coupling `LAYER_WRITE_MASK`
   * exists to prevent, reintroduced at the one call that looks too simple to be
   * doing anything subtle.
   *
   * So the clear reuses the ERASE pipeline, whose mask does apply, over a segment
   * whose radius covers the whole field. `draw_size` is in the aspect-corrected
   * uv metric where the field spans at most ~1 unit in each axis, so 4.0 is
   * comfortably beyond the far corner from any point in it -- the eraser's hard
   * circle (`hit.dist < draw_size * 2.0`) then admits every fragment and the pass
   * writes zero everywhere it is allowed to.
   *
   * Still one pass and still no readback. The reference had to read back 4
   * channels, memset 2 and re-upload; the mask does that job on the GPU.
   */
  clear(encoder: GPUCommandEncoder, layer: FieldLayer): void {
    // Centre of the field, so the covering radius is measured from the middle
    // rather than a corner. The mode and angle are irrelevant on an erase pass --
    // it takes the `erase_mode` branch before it ever reads them.
    const centre: readonly [number, number] = [0.5, 0.5];
    this.pass(
      encoder,
      centre,
      centre,
      { drawSize: CLEAR_RADIUS, drawPower: 0.0, mode: 'diverge', layer, drawAngle: 0.0, lineGain: 1.0 },
      true,
    );
  }

  /** True when the pipelines compiled. Surfaced for the startup summary. */
  pipelineStatus(): Readonly<Record<string, boolean>> {
    // Reported per OPERATION rather than per pipeline, though there are now four
    // of those: the two layers compile from one module with one entry point and
    // differ only in a write mask, so they cannot fail independently, and four
    // rows would imply a failure mode that does not exist. browserCheck.mjs greps
    // these lines for /FAILED/.
    return {
      strafeDraw: this.drawPipelines.walls !== undefined,
      strafeErase: this.erasePipelines.walls !== undefined,
    };
  }

  /** Free the size-dependent resources. */
  release(): void {
    this.texture.destroy();
  }

  /**
   * Free everything.
   *
   * The release/destroy split follows `Bloom`: `release()` is the half a resize
   * would redo, `destroy()` adds what outlives one. There is no `resize()` here,
   * though -- the Orchestrator replaces the whole field when the canvas changes,
   * matching `_rebuild_system` (`project_commands.py:60-69`), which releases and
   * reconstructs rather than resizing in place.
   */
  destroy(): void {
    this.release();
    this.uniforms.destroy();
  }
}
