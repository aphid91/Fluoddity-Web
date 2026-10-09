/**
 * Webcam: the camera feature, as one object both apps hold for the session.
 *
 * Three parts, each in its own file:
 *
 *   webcamSettings.ts  what the user chose, persisted per app
 *   webcamSource.ts    the MediaStream and its <video>
 *   webcamField.ts     the GPU passes that make a vector field of the picture
 *
 * This is the seam between them and the two places that use them. The
 * orchestrators call `record` once per rendered frame and pass `strengths()` to
 * the particle system; the Camera tab reads and writes `settings`, presses
 * `start`/`stop`, and lends a canvas for the preview.
 *
 * ## Why it outlives the tab and the particle system
 *
 * The studio rebuilds its panel on every tier toggle and its particle system on
 * every World Size change; sand rebuilds its world on every window resize. A
 * camera owned by either would stop -- and re-prompt, on some browsers --
 * whenever someone touched an unrelated control. So `main.ts` makes one of these
 * at startup and both the panel and the orchestrator are handed it. The field
 * texture lives here for the same reason: every system the session builds binds
 * the same `fieldView` (see `ParticleSystem.setCameraField`).
 *
 * ## The camera is released whenever the page is hidden
 *
 * Switching tabs, sending the browser to the background or locking a phone
 * hides the page, and the camera is CLOSED then -- not merely ignored. A stream
 * left open keeps the OS's camera-in-use indicator lit while the user is
 * somewhere else entirely, which reads as the page watching them. When the page
 * is shown again a camera that was running when it left is reopened, so a
 * performance survives a glance at another tab. Only HIDDEN counts: a desktop
 * window that merely loses focus, still visible, keeps its camera.
 */

import { type CameraStrengths, NO_CAMERA } from '../particleSystem/uniforms.ts';
import { WebcamField } from './webcamField.ts';
import { type WebcamState, WebcamSource } from './webcamSource.ts';
import {
  type WebcamSettings,
  cameraStrengths,
  loadWebcamSettings,
  sanitizeWebcamSettings,
  saveWebcamSettings,
  withFacing,
} from './webcamSettings.ts';

export class Webcam {
  private readonly device: GPUDevice;
  private readonly storageKey: string;
  private readonly field: WebcamField;
  /** Created on the first `start`, so a session that never asks has no <video>. */
  private source: WebcamSource | null = null;
  private _settings: WebcamSettings;

  /** Blur and map must re-run before the next frame: a setting changed. */
  private remapPending = false;
  /** The field still holds a frame from a stream that has since stopped. */
  private clearPending = false;
  /** The world aspect the field was last built for. A reshape remaps. */
  private lastAspect = 0;

  private preview: { canvas: HTMLCanvasElement; context: GPUCanvasContext; format: GPUTextureFormat } | null =
    null;
  /** The preview canvas needs drawing even if the field did not change. */
  private previewStale = false;
  /**
   * Closed because the page was hidden, and to be reopened when it is shown.
   * Cleared by the user's own Stop, so a camera they turned off stays off.
   */
  private suspended = false;

  private constructor(device: GPUDevice, field: WebcamField, storageKey: string) {
    this.device = device;
    this.field = field;
    this.storageKey = storageKey;
    this._settings = loadWebcamSettings(storageKey);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  /** See the header: release on hide, reopen on show. */
  private readonly onVisibilityChange = (): void => {
    if (document.hidden) {
      // 'starting' counts: a permission prompt or open in flight is cancelled
      // by the stop, and must come back like a running camera would.
      if (this.state === 'on' || this.state === 'starting') {
        this.source?.stop();
        this.suspended = true;
        this.clearPending = true;
        this.previewStale = true;
      }
    } else if (this.suspended) {
      this.suspended = false;
      void this.start();
    }
  };

  /**
   * @param storageKey Where this app keeps its camera setup --
   *   `STUDIO_CAMERA_STORAGE_KEY` or `SAND_CAMERA_STORAGE_KEY`.
   */
  static async create(device: GPUDevice, storageKey: string): Promise<Webcam> {
    return new Webcam(device, await WebcamField.create(device), storageKey);
  }

  /** The texture every particle system binds. See `ParticleSystem.setCameraField`. */
  get fieldView(): GPUTextureView {
    return this.field.view;
  }

  get settings(): WebcamSettings {
    return this._settings;
  }

  get state(): WebcamState {
    return this.source?.state ?? 'off';
  }

  get error(): string | null {
    return this.source?.error ?? null;
  }

  get running(): boolean {
    return this.source?.running ?? false;
  }

  /**
   * The world's width over its height, as of the last frame -- the shape the
   * preview should take, since the field spans the world. 0 before the first.
   */
  get worldAspect(): number {
    return this.lastAspect;
  }

  /**
   * Change some settings, persist them, and apply them from the next frame.
   *
   * A facing change goes through `withFacing`, so the mirror follows the new
   * camera's default unless the same call sets it explicitly; and it reopens the
   * camera if one is running, since a MediaStream cannot change which lens it
   * is reading.
   */
  update(patch: Partial<WebcamSettings>): void {
    const before = this._settings;
    let next = before;
    if (patch.facing !== undefined) next = withFacing(next, patch.facing);
    const { facing: _facing, ...rest } = patch;
    next = sanitizeWebcamSettings({ ...next, ...rest });
    this._settings = next;
    saveWebcamSettings(next, this.storageKey);
    this.remapPending = true;
    this.previewStale = true;
    if (next.facing !== before.facing && this.state !== 'off') void this.start();
  }

  /** Open the camera with the current facing. Resolves when it is on or failed. */
  async start(): Promise<void> {
    this.source ??= new WebcamSource();
    this.clearPending = true;
    await this.source.start(this._settings.facing);
  }

  stop(): void {
    this.suspended = false;
    this.source?.stop();
    this.clearPending = true;
    this.previewStale = true;
  }

  toggle(): void {
    if (this.state === 'off' || this.state === 'error') void this.start();
    else this.stop();
  }

  /** What the particle system should multiply the field by this frame. */
  strengths(): CameraStrengths {
    return this.running ? cameraStrengths(this._settings, true) : NO_CAMERA;
  }

  /**
   * Lend a canvas for the preview, or null to take it back.
   *
   * The context is configured here, against the same device, so the preview is
   * one more render pass in the frame's encoder rather than a second device or
   * a readback. Attaching marks the preview stale, so a tab that was just
   * rebuilt shows the field at once rather than waiting for the camera.
   */
  attachPreview(canvas: HTMLCanvasElement | null): void {
    if (canvas === null) {
      this.preview = null;
      return;
    }
    if (this.preview?.canvas === canvas) return;
    const context = canvas.getContext('webgpu');
    if (context === null) {
      this.preview = null;
      return;
    }
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device: this.device, format, alphaMode: 'opaque' });
    this.preview = { canvas, context, format };
    this.previewStale = true;
  }

  /** The canvas was resized; draw it again. */
  invalidatePreview(): void {
    this.previewStale = true;
  }

  /**
   * One rendered frame's camera work, recorded into the frame's encoder BEFORE
   * the physics, which samples what this writes.
   *
   * Runs whether or not the simulation is paused: the camera is not simulation
   * state, and someone who paused to frame a shot wants the preview live.
   *
   * @param canvasSize The world's canvas, for its ASPECT -- see `fieldMath.ts`.
   */
  record(encoder: GPUCommandEncoder, canvasSize: readonly [number, number]): void {
    const aspect = canvasSize[1] > 0 ? canvasSize[0] / canvasSize[1] : 1;
    if (aspect !== this.lastAspect) {
      this.lastAspect = aspect;
      this.remapPending = true;
    }

    let changed = false;
    if (this.clearPending && !this.running) {
      this.field.clear(encoder);
      this.clearPending = false;
      changed = true;
    }

    const source = this.source;
    const size = source?.size ?? null;
    if (source !== null && size !== null && source.takeNewFrame()) {
      if (this.clearPending) {
        // A new stream's first frame: forget the old one's before reading it.
        this.field.clear(encoder);
        this.clearPending = false;
      }
      if (this.field.ingest(encoder, source.video, size, aspect, this._settings)) {
        this.remapPending = false;
        changed = true;
      }
    }
    if (this.remapPending && this.running) {
      this.field.remap(encoder, aspect, this._settings);
      this.remapPending = false;
      changed = true;
    }

    const preview = this.preview;
    if (
      preview !== null &&
      this._settings.preview &&
      (changed || this.previewStale) &&
      preview.canvas.isConnected &&
      preview.canvas.width > 0 &&
      preview.canvas.height > 0
    ) {
      this.field.renderPreview(encoder, preview.context, preview.format);
      this.previewStale = false;
    }
  }

  destroy(): void {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
    this.source?.destroy();
    this.source = null;
    this.field.destroy();
  }
}
