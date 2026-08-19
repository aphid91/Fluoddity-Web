/**
 * The offscreen surface a recorded frame is assembled into.
 *
 * ## Why a canvas rather than a plain texture
 *
 * Everything else in this app renders into a `GPUTexture` it owns
 * (`app/renderTargets.ts`), and a recording target could have been one too. It
 * is an `OffscreenCanvas` with a WebGPU context instead, because of what sits at
 * the far end: mediabunny's `CanvasSource` takes a canvas and pulls frames from
 * it directly. Handing it a canvas keeps the pixels ON THE GPU for the whole
 * journey -- assemble, encode -- with no `copyTextureToBuffer` and no readback
 * stall per frame. A `GPUTexture` would have to be copied to a staging buffer,
 * mapped, and uploaded back into a `VideoFrame`, which at 4K is megabytes across
 * the bus every frame for no gain.
 *
 * ## Why it is not `app/surface.ts`
 *
 * `Surface` is the *window*: it tracks a DOM element's device-pixel size through
 * a `ResizeObserver` and exists to keep the swap chain matching a thing the user
 * can drag. This is the opposite -- a FIXED size the user picked, which must not
 * move when the window does, because a video file's dimensions cannot change
 * partway through. Sharing a type between them would mean one of the two
 * carrying machinery that is actively wrong for it.
 *
 * The `Surface` interface is nonetheless what this satisfies structurally
 * (`canvas`/`context`/`format`/`size()`), so the assembler and the camera see
 * the same shape either way and neither needs to know which one it is drawing
 * into.
 *
 * ## The format
 *
 * `navigator.gpu.getPreferredCanvasFormat()`, the same call `surface.ts` makes.
 * The assembler builds its pipeline against ONE output format, so a recording
 * canvas in a different one would need a second pipeline -- and the preferred
 * format is what the existing pipeline was already compiled for.
 */

import type { WindowSize } from '../app/surface.ts';

/** A fixed-size offscreen target, shaped like `Surface` but never resized. */
export interface CaptureTarget {
  /** The canvas mediabunny's `CanvasSource` reads from. */
  readonly canvas: OffscreenCanvas;
  readonly context: GPUCanvasContext;
  readonly format: GPUTextureFormat;
  /** The recording size. Fixed for the life of this target. */
  size(): WindowSize;
  destroy(): void;
}

/**
 * Allocate a capture target at exactly `width` x `height`.
 *
 * **`alphaMode: 'opaque'`**, matching `surface.ts`. The assembler clears to
 * opaque black and writes no meaningful alpha, and a premultiplied surface would
 * hand the encoder a frame whose alpha it then has to composite against nothing
 * -- which shows up as washed-out darks in the exported file and nowhere else.
 *
 * Throws rather than degrading if the context cannot be had. Every caller is
 * inside a user-initiated export, so a thrown error surfaces as a message the
 * user can act on; a null-returning target would be discovered frames later, as
 * a recording that silently produced nothing.
 */
export function createCaptureTarget(
  device: GPUDevice,
  width: number,
  height: number,
): CaptureTarget {
  const maxDim = device.limits.maxTextureDimension2D;
  if (width <= 0 || height <= 0 || width > maxDim || height > maxDim) {
    throw new Error(
      `Recording size ${width}x${height} is outside this device's limits ` +
        `(max ${maxDim} per dimension).`,
    );
  }

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('webgpu');
  if (context === null) {
    throw new Error('Failed to acquire a WebGPU context for the recording canvas.');
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  const size: WindowSize = [width, height];
  return {
    canvas,
    context,
    format,
    size: () => size,
    // `unconfigure` releases the swap chain's textures. The canvas itself is
    // garbage once nothing references it -- there is no DOM node to remove,
    // which is half the point of an OffscreenCanvas here.
    destroy: () => {
      context.unconfigure();
    },
  };
}
