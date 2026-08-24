/**
 * The browser half of the share image: canvas pixels, blobs, and the clipboard.
 *
 * ## EVERYTHING THAT TOUCHES THE DOM, AND NOTHING THAT DOES NOT
 *
 * `share/shareImage.ts` composes pixels and is pure; this reads them off a
 * `<canvas>` and puts the result on the clipboard. The split is the same one
 * `clipboard.ts` describes and exists for the same payoff: the composition is
 * testable under `node --test`, and everything untestable is concentrated in one
 * small file where its failure modes can be documented rather than scattered.
 *
 * ## READING A WebGPU CANVAS IS NOT `getImageData`
 *
 * The app's canvas has a `webgpu` context, so it has no 2D context to read
 * through -- `getContext('2d')` on it returns `null`, having already been
 * claimed. The route that works is `drawImage` onto a SEPARATE 2D canvas, which
 * the browser services from the same compositor surface.
 *
 * That imposes the one hard constraint in this file: **the canvas must be
 * readable at the moment we ask.** A WebGPU canvas is only guaranteed to hold
 * its contents until the frame ends, so a capture scheduled at an arbitrary
 * moment can come back empty or one frame stale. Callers capture in response to
 * a user gesture, immediately, which is when the last presented frame is still
 * there.
 */

import type { RgbaImage } from '../share/qrRender.ts';

/** Thrown when pixels cannot be got out of a canvas or into an image. */
export class CaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptureError';
  }
}

/**
 * A rectangle in CSS pixels, as the drag overlay reports one.
 *
 * CSS PIXELS, NOT DEVICE PIXELS, because that is what pointer events speak and
 * converting at the boundary keeps the conversion in one place. `captureRegion`
 * applies the device-pixel ratio; nothing upstream of it should.
 */
export interface CssRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Copy a region of `canvas` into an `RgbaImage`.
 *
 * `rect` is in CSS pixels relative to the canvas's bounding box; the region is
 * mapped onto the canvas's BACKING STORE, which is what `surface.ts` sizes to
 * the device pixel ratio. Capturing in backing-store pixels rather than CSS
 * pixels is what makes a stamp on a HiDPI display the same number of REAL
 * pixels as one on a normal display -- and the stamp's survival is measured in
 * real pixels, so a capture that quietly halved them on a 2x display would
 * produce an image that fails for a reason nobody could see.
 */
export function captureRegion(canvas: HTMLCanvasElement, rect: CssRect): RgbaImage {
  const box = canvas.getBoundingClientRect();
  // The canvas is letterboxed inside its element, so the backing store maps onto
  // the BOX rather than onto the element's padding edge. Both ratios are
  // computed rather than assuming a square pixel: `surface.ts` constrains aspect
  // and the two can genuinely differ.
  const scaleX = canvas.width / box.width;
  const scaleY = canvas.height / box.height;

  const sx = Math.round(rect.x * scaleX);
  const sy = Math.round(rect.y * scaleY);
  const sw = Math.round(rect.width * scaleX);
  const sh = Math.round(rect.height * scaleY);

  // Clamped to the backing store: a drag that ran off the edge of the canvas
  // would otherwise ask `drawImage` for pixels that do not exist, which yields
  // transparent black and a stamp sitting on a void.
  const x = Math.max(0, Math.min(canvas.width - 1, sx));
  const y = Math.max(0, Math.min(canvas.height - 1, sy));
  const width = Math.max(1, Math.min(canvas.width - x, sw));
  const height = Math.max(1, Math.min(canvas.height - y, sh));

  const scratch = document.createElement('canvas');
  scratch.width = width;
  scratch.height = height;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  if (ctx === null) throw new CaptureError('could not get a 2D context to read into');

  // OPAQUE BLACK UNDERNEATH. The app's surface is `alphaMode: 'opaque'` and
  // writes no meaningful alpha, but a region that fell partly outside would
  // otherwise composite as transparent -- which a PNG preserves and a JPEG
  // flattens to whatever the platform feels like, usually white.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(canvas, x, y, width, height, 0, 0, width, height);

  const data = ctx.getImageData(0, 0, width, height);
  return { width, height, data: data.data };
}

/** An `RgbaImage` onto a fresh canvas, for encoding or display. */
export function imageToCanvas(image: RgbaImage): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new CaptureError('could not get a 2D context to write into');

  // BUILT THROUGH `createImageData` RATHER THAN `new ImageData(...)`, which is
  // not a style choice. `RgbaImage.data` is a `Uint8ClampedArray` over an
  // `ArrayBufferLike`, and that includes `SharedArrayBuffer`, which the
  // `ImageData` constructor will not accept -- the composition layer builds its
  // arrays itself and has no reason to promise otherwise. Filling a context-
  // owned buffer sidesteps the question entirely and copies no more than the
  // constructor would.
  const target = ctx.createImageData(image.width, image.height);
  target.data.set(image.data);
  ctx.putImageData(target, 0, 0);
  return canvas;
}

/**
 * An `RgbaImage` as PNG bytes.
 *
 * PNG, NEVER JPEG, and this is the one encoding decision in the feature that is
 * not negotiable. Handing a platform a JPEG makes its own re-encode a SECOND
 * generation -- our quantization artefacts get quantized again -- and the stamp
 * has a fixed budget for exactly that kind of damage. Lossless out means the
 * platform's pass is the first and only one.
 */
export async function imageToPngBlob(image: RgbaImage): Promise<Blob> {
  const canvas = imageToCanvas(image);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/png');
  });
  if (blob === null) throw new CaptureError('the browser would not encode a PNG');
  return blob;
}

/**
 * Put an image on the system clipboard.
 *
 * Returns a boolean rather than throwing, exactly as `copyText` does and for the
 * same reasons: `ClipboardItem` is absent on non-secure origins (which includes
 * `vite --host` over LAN), and the write rejects when the document is not
 * focused. A share image that could not be copied is something to tell the user
 * about, not an exception to leak into a click handler.
 *
 * THE PROMISE IS PASSED UNRESOLVED, deliberately. Safari requires the
 * `ClipboardItem` to be constructed with a promise DURING the user gesture --
 * awaiting the blob first and then constructing it loses the gesture and the
 * write is refused. Chrome and Firefox accept both forms, so the shape that
 * satisfies all three is this one.
 */
export async function copyImage(image: RgbaImage): Promise<boolean> {
  if (typeof ClipboardItem === 'undefined' || navigator.clipboard?.write === undefined) {
    return false;
  }
  try {
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': imageToPngBlob(image) }),
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Offer an image as a file download. The fallback when the clipboard refuses. */
export async function downloadImage(image: RgbaImage, filename: string): Promise<void> {
  const blob = await imageToPngBlob(image);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // Revoked on a timer rather than immediately: the click is asynchronous and
  // revoking in the same tick can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Decode a `Blob` of image bytes into pixels. */
export async function blobToImage(blob: Blob): Promise<RgbaImage> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx === null) throw new CaptureError('could not get a 2D context to read into');
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: bitmap.width, height: bitmap.height, data: data.data };
  } finally {
    // Released explicitly: an `ImageBitmap` holds GPU memory that garbage
    // collection frees only eventually, and this path can run on every paste.
    bitmap.close();
  }
}

/**
 * The first image on the clipboard, or `null` if there is none to be had.
 *
 * `null` COVERS SEVERAL DIFFERENT SITUATIONS and the caller cannot tell them
 * apart -- no permission, no image, no API. That is deliberate: the remedy is
 * the same in every case (fall back to asking for a link), so distinguishing
 * them would produce four messages for one action.
 *
 * Firefox does not implement `navigator.clipboard.read` for page script, so on
 * that engine this always returns `null` and the paste-an-image route exists
 * only through the `paste` EVENT, which carries its own data and needs no
 * permission. See `imageFromPasteEvent`.
 */
export async function readClipboardImage(): Promise<RgbaImage | null> {
  if (navigator.clipboard?.read === undefined) return null;
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type !== undefined) return await blobToImage(await item.getType(type));
    }
  } catch {
    // Denied, dismissed, or unimplemented -- see above.
  }
  return null;
}

/**
 * The image carried by a `paste` event, if it carries one.
 *
 * THE ROUTE THAT NEEDS NO PERMISSION, and therefore the important one. A real
 * Ctrl+V hands the page its data directly, so this works on Firefox and works
 * in Chrome without a prompt -- which makes the event path strictly better than
 * `readClipboardImage` wherever it is available. The async version exists for
 * the button, which has no event to read.
 */
export async function imageFromPasteEvent(event: ClipboardEvent): Promise<RgbaImage | null> {
  const items = event.clipboardData?.items;
  if (items === undefined) return null;
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file !== null) return await blobToImage(file);
    }
  }
  return null;
}
