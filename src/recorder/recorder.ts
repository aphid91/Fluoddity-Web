/**
 * The video recorder: assembled frames in, an MP4 file out.
 *
 * ## This module is LAZILY LOADED, and that shapes it
 *
 * Most users will never export a video, so nothing here -- not mediabunny, not
 * the capture canvas, not a single `VideoEncoder` -- may cost anything until the
 * moment someone asks for it. That is why `mediabunny` is reached through a
 * dynamic `import()` inside `start()` rather than a top-level import: Vite emits
 * it as a separate chunk, and a session that never records never fetches it.
 *
 * The same reasoning runs through the allocation. The capture target, the
 * encoder and the muxer are all built in `start()` and torn down in `stop()`, so
 * an idle recorder holds no VRAM and no encoder. `Orchestrator` therefore holds
 * a `VideoRecorder | null` and constructs one only on demand -- see its
 * `startRecording`.
 *
 * ## Why the timestamps are computed, never measured
 *
 * `CanvasSource.add(timestamp, duration)` takes the presentation time
 * EXPLICITLY, and this module always passes `frameIndex / fps`. That single
 * decision is what makes an offline render possible: a frame that took eight
 * seconds of GPU work to assemble -- 480 physics steps at 64 blur samples is a
 * perfectly ordinary export -- still occupies exactly 1/60s of the output. A
 * wall-clock recorder (`MediaRecorder` over `captureStream`) cannot express
 * that, which is the reason this feature is not three lines of platform API.
 *
 * ## Backpressure
 *
 * `add()` resolves when the encoder is ready for another frame, so the frame
 * loop awaits it. Without that await, a fast stretch of simulation queues
 * unbounded `VideoFrame`s and the tab is killed by memory pressure rather than
 * by anything this code would see. THE AWAIT IS THE BACKPRESSURE -- it is not a
 * convenience, and dropping it to "speed things up" reintroduces the crash.
 */

// TYPE-ONLY, and that is what keeps the lazy loading intact: `import type` is
// erased entirely by the compiler, so naming mediabunny's types here does not
// put its code in the main bundle. The `import()` in `open()` is the only thing
// that ever fetches it. A value import of any of these would silently undo the
// whole arrangement -- see the file header.
import type {
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  VideoCodec,
} from 'mediabunny';

import type { CaptureTarget } from './captureTarget.ts';
import { createCaptureTarget } from './captureTarget.ts';
import {
  RECORDING_FPS,
  type RecordingSettings,
  frameCount,
} from './recordingSettings.ts';

/** How far along an in-flight recording is, for the UI's progress readout. */
export interface RecordingProgress {
  readonly framesDone: number;
  readonly framesTotal: number;
}

/**
 * The codecs to try, best first.
 *
 * AVC (H.264) leads because an MP4 named `.mp4` is expected to play in
 * QuickTime, Premiere and every phone, and H.264 is the only one of these that
 * does so universally. VP9 and AV1 are better codecs and are the fallbacks
 * rather than the default precisely because that expectation is about the
 * ECOSYSTEM, not about compression.
 */
const CODEC_PREFERENCE: readonly VideoCodec[] = ['avc', 'vp9', 'av1'];

export class VideoRecorder {
  private readonly device: GPUDevice;
  readonly settings: RecordingSettings;

  private target: CaptureTarget | null = null;
  /**
   * The muxer, and the source frames are pushed into.
   *
   * Both generic parameters are pinned -- `Output<Format, Target>` -- so
   * `finish()` can read `.target.buffer` without a cast. The TARGET half is what
   * carries the knowledge that this output writes to memory rather than to a
   * stream; a bare `Output` erases it and `.buffer` stops existing.
   */
  private output: Output<Mp4OutputFormat, BufferTarget> | null = null;
  private source: CanvasSource | null = null;

  private framesDone = 0;
  private readonly framesTotal: number;
  /** Set by `cancel()`. The frame loop checks it and stops requesting frames. */
  private cancelled = false;

  private constructor(device: GPUDevice, settings: RecordingSettings) {
    this.device = device;
    this.settings = settings;
    this.framesTotal = frameCount(settings);
  }

  /**
   * Build a recorder and open its output. Resolves once the first frame may be
   * submitted.
   *
   * Async and static rather than a constructor plus an `init()`, matching
   * `Assembler.create` and `Camera.create`: the object never exists in a
   * half-built state that a caller could accidentally use.
   */
  static async start(
    device: GPUDevice,
    settings: RecordingSettings,
  ): Promise<VideoRecorder> {
    const recorder = new VideoRecorder(device, settings);
    await recorder.open();
    return recorder;
  }

  /**
   * The canvas the assembler presents each recorded frame into.
   *
   * Null before `open()` and after `stop()`, which is what the Orchestrator
   * checks to decide whether a recording pass belongs on this frame's encoder.
   */
  get captureTarget(): CaptureTarget | null {
    return this.target;
  }

  get progress(): RecordingProgress {
    return { framesDone: this.framesDone, framesTotal: this.framesTotal };
  }

  /** True once every frame has been submitted, or the user cancelled. */
  get finished(): boolean {
    return this.cancelled || this.framesDone >= this.framesTotal;
  }

  /**
   * Allocate the capture target and open the muxer.
   *
   * THE DYNAMIC IMPORT IS HERE, not at module scope -- see the file header.
   */
  private async open(): Promise<void> {
    const { width, height } = this.settings.resolution;
    this.target = createCaptureTarget(this.device, width, height);

    const {
      Output,
      Mp4OutputFormat,
      BufferTarget,
      CanvasSource,
      Quality,
      canEncodeVideo,
    } = await import('mediabunny');

    // Asked of the BROWSER rather than assumed. Codec availability is a property
    // of the machine (hardware encoders differ, and Linux Chromium often has no
    // H.264 encoder at all), so a hardcoded 'avc' would fail at `configure` time
    // -- after the user had chosen settings and pressed record.
    let codec: VideoCodec | null = null;
    for (const candidate of CODEC_PREFERENCE) {
      if (await canEncodeVideo(candidate, { width, height })) {
        codec = candidate;
        break;
      }
    }
    if (codec === null) {
      this.releaseTarget();
      throw new Error(
        'This browser cannot encode video at the selected resolution. Try a ' +
          'smaller size, or a Chromium-based browser.',
      );
    }

    // `fastStart: 'in-memory'` puts the moov atom at the FRONT, so the finished
    // file seeks immediately in a player and streams without range requests. It
    // costs holding the chunks until finalize, which `BufferTarget` is doing
    // anyway -- so for a buffered export it is free, and skipping it would
    // produce a file that has to be fully downloaded before it can be scrubbed.
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new BufferTarget(),
    });

    const source = new CanvasSource(this.target.canvas, {
      codec,
      quality: new Quality('high'),
      // 'quality', NOT 'realtime'. The realtime mode trades picture for latency
      // to keep up with a live stream; there is no live stream here and no
      // deadline to miss, so the trade is pure loss. This is the encoder-side
      // half of the same decision the explicit timestamps make.
      latencyMode: 'quality',
    });

    output.addVideoTrack(source, { frameRate: RECORDING_FPS });
    await output.start();

    this.output = output;
    this.source = source;
  }

  /**
   * Submit the frame currently sitting in the capture canvas.
   *
   * **Awaits the encoder**, which is the backpressure the file header describes.
   * The caller must have finished its `queue.submit()` for this frame before
   * calling -- the canvas is read here, so an unsubmitted frame would encode
   * whatever was in it previously.
   */
  async addFrame(): Promise<void> {
    if (this.source === null || this.cancelled) return;

    const index = this.framesDone;
    await this.source.add(index / RECORDING_FPS, 1 / RECORDING_FPS);
    this.framesDone = index + 1;
  }

  /**
   * Stop early. The frames already encoded are kept, so `finish()` still yields
   * a playable file -- a twenty-minute render abandoned at minute eighteen
   * should not produce nothing.
   */
  cancel(): void {
    this.cancelled = true;
  }

  /**
   * Finalize the file and hand back its bytes.
   *
   * Returns null if there is nothing to finalize (cancelled before the first
   * frame), which the caller reports rather than treating as an error -- the
   * user asked for the recording to end, and it did.
   */
  async finish(): Promise<Blob | null> {
    const output = this.output;
    const source = this.source;
    this.output = null;
    this.source = null;

    try {
      if (output === null || this.framesDone === 0) return null;
      source?.close();
      await output.finalize();
      const buffer = output.target.buffer;
      return buffer === null ? null : new Blob([buffer], { type: 'video/mp4' });
    } finally {
      // ALWAYS, including on a failed finalize: the capture target holds a
      // configured swap chain at up to 4K, and leaking it on the error path
      // would cost that VRAM for the rest of the session.
      this.releaseTarget();
    }
  }

  /** Free the capture target. Idempotent. */
  private releaseTarget(): void {
    this.target?.destroy();
    this.target = null;
  }

  /**
   * Tear down without producing a file. For the device-lost path and for
   * `dispose()`, where nobody is waiting for bytes.
   */
  destroy(): void {
    this.cancelled = true;
    this.source?.close();
    this.source = null;
    this.output = null;
    this.releaseTarget();
  }
}

/**
 * Hand `blob` to the browser as a download.
 *
 * Here rather than in the UI because it is the last step of the export and has
 * one correct implementation. The object URL is revoked on a timer rather than
 * immediately: Safari begins the download asynchronously and a URL revoked in
 * the same tick is occasionally dead before it is read.
 */
export function downloadRecording(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}
