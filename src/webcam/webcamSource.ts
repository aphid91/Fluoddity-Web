/**
 * The camera itself: a MediaStream playing into a <video> element.
 *
 * No GPU here -- `webcamField.ts` copies frames out of `video`. This file owns
 * the lifecycle (ask, play, stop, switch cameras), turns the browser's error
 * names into sentences, and answers one question per rendered frame: has a NEW
 * picture arrived since I last asked?
 *
 * ## Why "new frame" is tracked at all
 *
 * A camera delivers ~30 frames a second and the app renders at 60 or more. The
 * field passes are cheap but not free, and Motion compares consecutive camera
 * frames -- running it against the SAME frame twice would read as "nothing
 * moved" on every other render and make the motion field flicker. So the field
 * is rebuilt exactly once per camera frame, and this is what says when.
 *
 * ## The element is in the document, invisibly
 *
 * iOS Safari has, in some versions, stopped advancing a <video> that is not in
 * the document. A 1px transparent element costs nothing and removes the
 * question. `playsInline` and `muted` are what let it play without a gesture of
 * its own and without going fullscreen on a phone.
 */

import type { CameraFacing } from './webcamSettings.ts';

export type WebcamState = 'off' | 'starting' | 'on' | 'error';

/** `requestVideoFrameCallback`, which TypeScript's DOM types may not carry yet. */
type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export class WebcamSource {
  readonly video: FrameCallbackVideo;

  private _state: WebcamState = 'off';
  private _error: string | null = null;
  private stream: MediaStream | null = null;
  /**
   * Bumped by every `start` and `stop`. An in-flight `getUserMedia` whose
   * generation is stale when it resolves belongs to a request the user has
   * already superseded -- a stop, or a second press -- so its stream is closed
   * on arrival rather than adopted. Without this, pressing Stop while the
   * permission prompt was up would leave the camera running afterwards.
   */
  private generation = 0;

  /** Frames delivered so far, counted by `requestVideoFrameCallback`. */
  private delivered = 0;
  /** `delivered` as of the last `takeNewFrame`. */
  private consumed = 0;
  private frameHandle: number | null = null;
  /** The fallback's memory, where `requestVideoFrameCallback` is missing. */
  private lastTime = -1;

  constructor() {
    const video = document.createElement('video') as FrameCallbackVideo;
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.setAttribute('playsinline', '');
    video.style.cssText =
      'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;' +
      'pointer-events:none;z-index:-1;';
    video.setAttribute('aria-hidden', 'true');
    document.body.append(video);
    this.video = video;
  }

  get state(): WebcamState {
    return this._state;
  }

  /** Why the last start failed, in words for the user. Null unless `error`. */
  get error(): string | null {
    return this._error;
  }

  get running(): boolean {
    return this._state === 'on';
  }

  /** The picture's size, or null until the first frame has arrived. */
  get size(): readonly [number, number] | null {
    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    if (this._state !== 'on' || w === 0 || h === 0) return null;
    // HAVE_CURRENT_DATA: there is a frame to copy. Before it, the dimensions
    // can be known while the frame is not, and copying would fail validation.
    if (this.video.readyState < 2) return null;
    return [w, h];
  }

  /**
   * Open the camera facing `facing`, closing whatever was open.
   *
   * Resolves when the camera is playing or has failed -- never rejects. The
   * failure is in `state` and `error`, which is where the tab reads it.
   */
  async start(facing: CameraFacing): Promise<void> {
    this.closeStream();
    const generation = ++this.generation;
    this._state = 'starting';
    this._error = null;

    const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
    if (media === undefined || typeof media.getUserMedia !== 'function') {
      // `mediaDevices` is withheld entirely outside a secure context, so this
      // is nearly always an http:// page -- the one cause worth naming.
      this.fail('Camera access needs a secure (https) page.');
      return;
    }

    let stream: MediaStream;
    try {
      stream = await media.getUserMedia({
        audio: false,
        video: {
          // IDEAL, NOT EXACT. A laptop's single webcam has no facing at all,
          // and `exact` would refuse it rather than open the only camera there
          // is. On a phone the ideal is honoured.
          facingMode: { ideal: facing },
          // The field is 256 texels square, so asking for more costs bandwidth
          // and a bigger per-frame copy for detail the field throws away.
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30 },
        },
      });
    } catch (e) {
      if (generation !== this.generation) return;
      this.fail(describeError(e));
      return;
    }

    // Superseded while the prompt was up: close what arrived, adopt nothing.
    if (generation !== this.generation) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }

    this.stream = stream;
    for (const track of stream.getVideoTracks()) {
      // Unplugged, revoked from the browser's own UI, or taken by the OS.
      track.addEventListener('ended', () => {
        if (generation !== this.generation) return;
        this.closeStream();
        this.fail('The camera stopped.');
      });
    }

    this.video.srcObject = stream;
    try {
      await this.video.play();
    } catch (e) {
      if (generation !== this.generation) return;
      this.closeStream();
      this.fail(`The camera could not play: ${describeError(e)}`);
      return;
    }
    if (generation !== this.generation) return;

    this._state = 'on';
    this.delivered = 0;
    this.consumed = 0;
    this.lastTime = -1;
    this.watchFrames(generation);
  }

  /** Close the camera. Idempotent. */
  stop(): void {
    this.generation++;
    this.closeStream();
    this._state = 'off';
    this._error = null;
  }

  /**
   * True exactly once per camera frame that has arrived since the last call.
   *
   * `requestVideoFrameCallback` where the browser has it (Chrome, Safari,
   * Firefox 132+), which counts real presented frames. Otherwise `currentTime`
   * moving, which is coarser but never claims a frame that did not happen.
   */
  takeNewFrame(): boolean {
    if (this._state !== 'on') return false;
    if (typeof this.video.requestVideoFrameCallback === 'function') {
      if (this.delivered === this.consumed) return false;
      this.consumed = this.delivered;
      return true;
    }
    const t = this.video.currentTime;
    if (t === this.lastTime) return false;
    this.lastTime = t;
    return true;
  }

  /** Release the camera and the element. The source is unusable afterwards. */
  destroy(): void {
    this.stop();
    this.video.remove();
  }

  private watchFrames(generation: number): void {
    const video = this.video;
    if (typeof video.requestVideoFrameCallback !== 'function') return;
    const tick = (): void => {
      // A callback from an earlier start must not keep counting -- and must not
      // re-register, or every restart would add another counter.
      if (generation !== this.generation) return;
      this.delivered++;
      this.frameHandle = video.requestVideoFrameCallback!(tick);
    };
    this.frameHandle = video.requestVideoFrameCallback(tick);
  }

  private closeStream(): void {
    if (this.frameHandle !== null) {
      this.video.cancelVideoFrameCallback?.(this.frameHandle);
      this.frameHandle = null;
    }
    if (this.stream !== null) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.video.srcObject = null;
  }

  private fail(message: string): void {
    this._state = 'error';
    this._error = message;
  }
}

/** The browser's error, as a sentence that says what to do about it. */
export function describeError(e: unknown): string {
  const name = typeof e === 'object' && e !== null && 'name' in e ? String(e.name) : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission was denied. Allow it in the browser’s site settings.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera is in use by another app, or could not be opened.';
    default:
      return e instanceof Error ? e.message : String(e);
  }
}
