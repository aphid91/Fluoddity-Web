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
  StreamTarget,
  StreamTargetChunk,
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
 * What `finish()` produced. See its docstring for why this is three cases.
 *
 *   buffered  The whole file, in memory, for a download link.
 *   streamed  Already written to the user's chosen file. Nothing to hand back.
 *   empty     No frames were captured. Not an error, but not a file either.
 */
export type RecordingResult =
  | { readonly kind: 'buffered'; readonly blob: Blob }
  | { readonly kind: 'streamed' }
  | { readonly kind: 'empty' };

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
   * The TARGET half of the generic is the union, because which one is in play is
   * decided at `open()` time from whether the browser gave us a file handle --
   * see `openOutput`. `finish()` discriminates on `this.fileWritable` rather
   * than by inspecting the target, since that is the same fact stated once.
   */
  private output: Output<Mp4OutputFormat, BufferTarget | StreamTarget> | null = null;
  private source: CanvasSource | null = null;

  /**
   * The open file, when the export is streaming straight to disk.
   *
   * Null means the in-memory path: `BufferTarget` holds the whole MP4 and
   * `finish()` returns it as a Blob for a download link. Non-null means the
   * bytes have been going to the user's chosen file all along and there is no
   * Blob to return -- `finish()` closes this and returns null, which is a
   * SUCCESS on that path rather than the failure it means on the other.
   *
   * WHY BOTH EXIST. `BufferTarget` is documented as unsuitable past ~100 MB, and
   * a minute of 1080p60 clears that comfortably -- a long 4K export would put a
   * multi-gigabyte ArrayBuffer in the tab and be killed for it. Streaming has
   * flat memory and no size ceiling worth naming. But `showSaveFilePicker` is
   * Chromium-only and needs a user gesture, so the buffered path cannot simply
   * be deleted: it is the fallback for Firefox and Safari, where the size limit
   * is real and the alternative is no export at all.
   */
  private fileWritable: FileSystemWritableFileStream | null = null;

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
    /**
     * An already-open file to stream into, or null to buffer in memory.
     *
     * Opened by the CALLER, not here, and that is forced rather than chosen:
     * `showSaveFilePicker` requires a user gesture, and by the time this async
     * method runs the gesture that started the export has been consumed by the
     * awaits above it. The picker has to be raised from the click handler
     * itself. See `chooseRecordingFile`.
     */
    fileWritable: FileSystemWritableFileStream | null = null,
  ): Promise<VideoRecorder> {
    const recorder = new VideoRecorder(device, settings);
    recorder.fileWritable = fileWritable;
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
      StreamTarget,
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

    // THE TARGET, and the `fastStart` that goes with it. The two are chosen
    // together because the right answer for one depends on the other.
    //
    //   STREAMING (a file handle was granted): `fastStart: false`. Metadata goes
    //   at the END, which is the only option that keeps memory flat -- the whole
    //   point of streaming. 'in-memory' would hold every chunk until finalize
    //   and reintroduce exactly the ceiling this path exists to remove.
    //
    //   BUFFERED (no handle -- Firefox, Safari, or the user declined):
    //   `fastStart: 'in-memory'`. It puts the moov atom at the FRONT so the file
    //   seeks immediately in a player, and it costs holding the chunks until
    //   finalize -- which `BufferTarget` is doing anyway. Free here, and skipping
    //   it would produce a file that must be fully downloaded before scrubbing.
    //
    // A file written with metadata at the end still plays and still seeks once
    // it is on disk; what it cannot do is stream progressively over HTTP. That
    // is the right trade for a local export the user is about to open.
    // THE CAST IS A TYPE BRIDGE, NOT A LIE, and it is worth saying why since a
    // bare `as unknown as` normally is one. mediabunny writes
    // `{ type: 'write', data, position }` chunks; that is precisely the
    // `WriteParams` shape `FileSystemWritableFileStream.write` accepts, and a
    // `FileSystemWritableFileStream` IS a `WritableStream` of them. The two
    // types are declared in different packages (`mediabunny` and the DOM lib)
    // and so are nominally unrelated, but structurally identical -- which is
    // exactly the situation a cast is for. The `position` field is what makes
    // this path support seeking, and therefore what lets the muxer go back and
    // patch its headers on a stream.
    const output = this.fileWritable !== null
      ? new Output({
          format: new Mp4OutputFormat({ fastStart: false }),
          target: new StreamTarget(
            this.fileWritable as unknown as WritableStream<StreamTargetChunk>,
          ),
        })
      : new Output({
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
   * Finalize the file.
   *
   * THREE OUTCOMES, not two, which is why this returns a tagged result rather
   * than `Blob | null`. "Streamed to disk" and "nothing was captured" both have
   * no Blob to hand back, and they are opposites -- one is the successful
   * completion of a multi-gigabyte export, the other is a recording that
   * produced no frames. A nullable Blob collapses them, and the caller would
   * report the wrong one roughly half the time.
   */
  async finish(): Promise<RecordingResult> {
    const output = this.output;
    const source = this.source;
    const writable = this.fileWritable;
    this.output = null;
    this.source = null;
    this.fileWritable = null;

    try {
      if (output === null || this.framesDone === 0) {
        // Nothing to finalize, so nothing ever locked the stream -- this is the
        // one path where closing it here is both safe and necessary. An
        // un-closed handle leaves a zero-byte file the user cannot overwrite
        // from the picker until the tab goes away.
        await writable?.close().catch(() => {});
        return { kind: 'empty' };
      }
      source?.close();
      await output.finalize();

      if (writable !== null) {
        // **DO NOT CLOSE THE STREAM HERE.** `finalize()` has already done it.
        //
        // `StreamTarget` takes a `getWriter()` on the writable when it starts,
        // which LOCKS the stream, and closes the file through that writer as
        // part of finalizing (`target.js`'s `_close`). Calling `writable.close()`
        // on top of that throws `Cannot close a locked stream`.
        //
        // The failure was maximally confusing: the export had completely
        // succeeded -- every byte written, the file valid and playable -- and
        // the user still got an error toast, because the throw happened after
        // all the real work and was caught by the caller's error path. A
        // correct export that reports itself as broken is worse than either a
        // clean success or an honest failure.
        return { kind: 'streamed' };
      }

      const buffer = (output.target as BufferTarget).buffer;
      return buffer === null
        ? { kind: 'empty' }
        : { kind: 'buffered', blob: new Blob([buffer], { type: 'video/mp4' }) };
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
    // ABORTED, not closed. This path abandons the export without finalizing, so
    // `StreamTarget`'s writer still holds the lock and `close()` would throw
    // `Cannot close a locked stream` -- see `finish()`. `abort()` is the
    // operation for "give up on this stream", it works on a locked one, and it
    // discards the partial file rather than committing a truncated MP4 that
    // would look like a real export until someone tried to play it.
    //
    // Still `.catch`-guarded: the stream may already be errored or gone, and
    // this runs on the device-lost path where nothing is left to report to.
    void this.fileWritable?.abort().catch(() => {});
    this.fileWritable = null;
    this.releaseTarget();
  }
}
