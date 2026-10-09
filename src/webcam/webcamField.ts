/**
 * WebcamField: the camera picture, turned into a vector field on the GPU.
 *
 * Four passes, each a fullscreen draw into a `CAMERA_FIELD_DIM`-square target:
 *
 *   ingest  camera frame -> (brightness, motion)   once per CAMERA frame
 *   blur x  ...          -> blurred                 }
 *   blur y  ...          -> blurred                 } again on a settings change
 *   map     blurred      -> the vector field        }
 *
 * and a fifth, `renderPreview`, that colours the result into the Camera tab's
 * thumbnail. `entityUpdate.wgsl` samples `view` through `get_camera`.
 *
 * ## Nothing accumulates, by construction
 *
 * The output is rebuilt from the current camera frame alone (Motion's short
 * tail lives in the ingest targets, upstream, and decays to nothing). That is
 * the community fork's rule -- "the bus is stateless per frame; a source that
 * needs memory owns its own buffer" -- and the reason this is not written into
 * the painted field: stopping the camera must take its contribution away, not
 * leave the last frame painted on the world.
 *
 * ## One texture for the session
 *
 * `view` is bound into every `ParticleSystem` the app builds, so it is never
 * reallocated -- see `fieldMath.ts` on why the field is a fixed square. The
 * camera IMAGE texture does reallocate when the camera's resolution changes
 * (switching cameras, a phone rotating), but nothing outside this class holds
 * it, and the bind groups that do are built per use.
 */

import { compileModule } from '../gpu/shaderModule.ts';
import ingestSource from './shaders/cameraIngest.wgsl';
import blurSource from './shaders/cameraBlur.wgsl';
import mapSource from './shaders/cameraMap.wgsl';
import previewSource from './shaders/cameraPreview.wgsl';
import { CAMERA_FIELD_DIM, blurStep, coverScale, stencilRadius } from './fieldMath.ts';
import { type WebcamSettings, blurTexels, mappingIndex } from './webcamSettings.ts';

/**
 * Two channels, half float: renderable, filterable, and enough range for a
 * field capped at length 1. The particle system's placeholder is rgba16float,
 * which its layout accepts alongside this -- see `setCameraField`.
 */
export const CAMERA_FIELD_FORMAT: GPUTextureFormat = 'rg16float';

/** One vec4 per pass. */
const UNIFORM_SIZE = 16;

export class WebcamField {
  private readonly device: GPUDevice;

  /** The output the particles read. */
  private readonly field: GPUTexture;
  readonly view: GPUTextureView;

  /** Ingest targets, ping-ponged: each frame reads the other for Motion. */
  private readonly scalars: readonly [GPUTexture, GPUTexture];
  private current = 0;
  /** Whether `scalars[current]` holds a frame of the running stream. */
  private primed = false;
  /** Between the two blur passes. */
  private readonly blurTemp: GPUTexture;
  private readonly blurred: GPUTexture;

  /** The camera frame, as copied out of the <video>. Sized to the camera. */
  private image: GPUTexture | null = null;

  private readonly sampler: GPUSampler;
  private readonly ingestUniforms: GPUBuffer;
  private readonly blurXUniforms: GPUBuffer;
  private readonly blurYUniforms: GPUBuffer;
  private readonly mapUniforms: GPUBuffer;

  private ingestPipeline: GPURenderPipeline | null = null;
  private blurPipeline: GPURenderPipeline | null = null;
  private mapPipeline: GPURenderPipeline | null = null;
  private previewModule: GPUShaderModule | null = null;
  /** Built on first use, per canvas format -- see `renderPreview`. */
  private readonly previewPipelines = new Map<GPUTextureFormat, GPURenderPipeline>();

  private constructor(device: GPUDevice) {
    this.device = device;
    const target = (label: string): GPUTexture =>
      device.createTexture({
        label,
        size: { width: CAMERA_FIELD_DIM, height: CAMERA_FIELD_DIM },
        format: CAMERA_FIELD_FORMAT,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      });
    this.field = target('camera-field');
    this.view = this.field.createView();
    this.scalars = [target('camera-scalars-a'), target('camera-scalars-b')];
    this.blurTemp = target('camera-blur-temp');
    this.blurred = target('camera-blurred');

    // CLAMP, always. The camera picture has no far side to wrap to, and a blur
    // or stencil reaching past the edge should read the edge rather than the
    // opposite side of someone's face.
    this.sampler = device.createSampler({
      label: 'camera',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    const uniforms = (label: string): GPUBuffer =>
      device.createBuffer({
        label,
        size: UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    this.ingestUniforms = uniforms('camera-ingest-uniforms');
    this.blurXUniforms = uniforms('camera-blur-x-uniforms');
    this.blurYUniforms = uniforms('camera-blur-y-uniforms');
    this.mapUniforms = uniforms('camera-map-uniforms');
  }

  static async create(device: GPUDevice): Promise<WebcamField> {
    const field = new WebcamField(device);
    await field.compile();
    return field;
  }

  /**
   * A compile failure is logged and leaves that pipeline null, like every other
   * module here: the camera then contributes nothing, and the app runs.
   */
  private async compile(): Promise<void> {
    const device = this.device;
    const [ingest, blur, map, preview] = await Promise.all([
      compileModule(device, 'cameraIngest.wgsl', ingestSource),
      compileModule(device, 'cameraBlur.wgsl', blurSource),
      compileModule(device, 'cameraMap.wgsl', mapSource),
      compileModule(device, 'cameraPreview.wgsl', previewSource),
    ]);
    this.previewModule = preview;
    const build = (
      label: string,
      module: GPUShaderModule | null,
      entryPoint: string,
    ): GPURenderPipeline | null =>
      module === null
        ? null
        : device.createRenderPipeline({
            label,
            layout: 'auto',
            vertex: { module, entryPoint: 'fullscreen_vs' },
            fragment: { module, entryPoint, targets: [{ format: CAMERA_FIELD_FORMAT }] },
            primitive: { topology: 'triangle-strip' },
          });
    this.ingestPipeline = build('camera-ingest', ingest, 'ingest_fs');
    this.blurPipeline = build('camera-blur', blur, 'blur_fs');
    this.mapPipeline = build('camera-map', map, 'map_fs');
  }

  /**
   * Take a new camera frame and rebuild the field from it.
   *
   * `copyExternalImageToTexture` is a QUEUE operation and runs now; the passes
   * are recorded into `encoder` and run at its submit -- after the copy, since
   * the queue is ordered. Returns false if the frame could not be copied (the
   * video not actually ready), leaving the field as it was.
   */
  ingest(
    encoder: GPUCommandEncoder,
    video: HTMLVideoElement,
    videoSize: readonly [number, number],
    worldAspect: number,
    settings: WebcamSettings,
  ): boolean {
    if (this.ingestPipeline === null) return false;
    const image = this.ensureImage(videoSize);
    try {
      this.device.queue.copyExternalImageToTexture(
        { source: video },
        { texture: image },
        { width: videoSize[0], height: videoSize[1] },
      );
    } catch (e) {
      // A frame the element reported but cannot yet hand over. The next one
      // will do; logging every occurrence would flood the console at 30 Hz.
      console.debug(`Camera frame skipped: ${String(e)}`);
      return false;
    }

    const [sx, sy] = coverScale(videoSize, worldAspect);
    this.device.queue.writeBuffer(
      this.ingestUniforms,
      0,
      new Float32Array([sx, sy, settings.mirror ? 1 : 0, this.primed ? 1 : 0]),
    );

    const previous = this.scalars[this.current]!;
    this.current = 1 - this.current;
    const next = this.scalars[this.current]!;
    this.draw(encoder, 'camera-ingest', this.ingestPipeline, next, [
      { binding: 0, resource: { buffer: this.ingestUniforms } },
      { binding: 1, resource: image.createView() },
      { binding: 2, resource: this.sampler },
      { binding: 3, resource: previous.createView() },
    ]);
    this.primed = true;

    this.remap(encoder, worldAspect, settings);
    return true;
  }

  /**
   * Re-run blur and map over the frame already ingested. What a settings change
   * needs when no new frame has arrived -- a slider dragged while the camera is
   * covered, say -- so the field and the preview follow the slider at once.
   */
  remap(encoder: GPUCommandEncoder, worldAspect: number, settings: WebcamSettings): void {
    if (this.blurPipeline === null || this.mapPipeline === null) return;
    const sigma = blurTexels(settings.blur);
    const sx = blurStep(sigma, worldAspect, 'x');
    const sy = blurStep(sigma, worldAspect, 'y');
    this.device.queue.writeBuffer(
      this.blurXUniforms,
      0,
      new Float32Array([sx?.[0] ?? 0, sx?.[1] ?? 0, sx === null ? 0 : 1, 0]),
    );
    this.device.queue.writeBuffer(
      this.blurYUniforms,
      0,
      new Float32Array([sy?.[0] ?? 0, sy?.[1] ?? 0, sy === null ? 0 : 1, 0]),
    );
    this.device.queue.writeBuffer(
      this.mapUniforms,
      0,
      new Float32Array([
        mappingIndex(settings.mapping),
        settings.direction === 'away' ? -1 : 1,
        worldAspect > 0 ? worldAspect : 1,
        stencilRadius(sigma, worldAspect),
      ]),
    );

    const source = this.scalars[this.current]!;
    this.draw(encoder, 'camera-blur-x', this.blurPipeline, this.blurTemp, [
      { binding: 0, resource: { buffer: this.blurXUniforms } },
      { binding: 1, resource: source.createView() },
      { binding: 2, resource: this.sampler },
    ]);
    this.draw(encoder, 'camera-blur-y', this.blurPipeline, this.blurred, [
      { binding: 0, resource: { buffer: this.blurYUniforms } },
      { binding: 1, resource: this.blurTemp.createView() },
      { binding: 2, resource: this.sampler },
    ]);
    this.draw(encoder, 'camera-map', this.mapPipeline, this.field, [
      { binding: 0, resource: { buffer: this.mapUniforms } },
      { binding: 1, resource: this.blurred.createView() },
      { binding: 2, resource: this.sampler },
    ]);
  }

  /**
   * Zero the field and forget the last frame.
   *
   * On stop. The particles already ignore the field once the strengths drop to
   * zero, so this is for the NEXT start: without it the first frames of a new
   * session would show (and, for one frame, push with) whatever the last one
   * ended on, and Motion would difference the new stream against the old.
   */
  clear(encoder: GPUCommandEncoder): void {
    for (const texture of [this.field, ...this.scalars]) {
      encoder
        .beginRenderPass({
          label: 'camera-clear',
          colorAttachments: [
            {
              view: texture.createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
        })
        .end();
    }
    this.primed = false;
  }

  /**
   * Colour the field into a canvas, direction as hue. See cameraPreview.wgsl.
   *
   * The pipeline is built for the canvas's own format on first use, rather than
   * assuming the preferred one, because the format is whatever the caller
   * configured the context with.
   */
  renderPreview(
    encoder: GPUCommandEncoder,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
  ): void {
    const module = this.previewModule;
    if (module === null) return;
    let pipeline = this.previewPipelines.get(format);
    if (pipeline === undefined) {
      pipeline = this.device.createRenderPipeline({
        label: 'camera-preview',
        layout: 'auto',
        vertex: { module, entryPoint: 'fullscreen_vs' },
        fragment: { module, entryPoint: 'preview_fs', targets: [{ format }] },
        primitive: { topology: 'triangle-strip' },
      });
      this.previewPipelines.set(format, pipeline);
    }
    let target: GPUTexture;
    try {
      target = context.getCurrentTexture();
    } catch {
      // An unconfigured or zero-sized canvas -- the tab mid-rebuild.
      return;
    }
    const pass = encoder.beginRenderPass({
      label: 'camera-preview',
      colorAttachments: [
        { view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.view },
          { binding: 1, resource: this.sampler },
        ],
      }),
    );
    pass.draw(4);
    pass.end();
  }

  destroy(): void {
    for (const t of [this.field, ...this.scalars, this.blurTemp, this.blurred]) t.destroy();
    this.image?.destroy();
    this.image = null;
    for (const b of [this.ingestUniforms, this.blurXUniforms, this.blurYUniforms, this.mapUniforms]) {
      b.destroy();
    }
  }

  private ensureImage(size: readonly [number, number]): GPUTexture {
    const image = this.image;
    if (image !== null && image.width === size[0] && image.height === size[1]) return image;
    // Safe to destroy at once: nothing outside this class binds it, and work
    // already submitted against it keeps it alive until that work completes.
    image?.destroy();
    this.image = this.device.createTexture({
      label: 'camera-image',
      size: { width: size[0], height: size[1] },
      format: 'rgba8unorm',
      // RENDER_ATTACHMENT is required of a copyExternalImageToTexture target.
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    return this.image;
  }

  private draw(
    encoder: GPUCommandEncoder,
    label: string,
    pipeline: GPURenderPipeline,
    target: GPUTexture,
    entries: GPUBindGroupEntry[],
  ): void {
    const pass = encoder.beginRenderPass({
      label,
      colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      this.device.createBindGroup({ label, layout: pipeline.getBindGroupLayout(0), entries }),
    );
    pass.draw(4);
    pass.end();
  }
}
