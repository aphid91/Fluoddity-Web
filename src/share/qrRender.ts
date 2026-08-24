/**
 * Painting a QR matrix into pixels.
 *
 * SEPARATE FROM `qrStamp.ts` AND FROM THE CANVAS BOTH. This writes into a plain
 * `RGBA` byte array -- not a `CanvasRenderingContext2D` -- which is what lets the
 * survival harness run the real stamping code under `node --test` with no
 * browser and no GPU. The app wraps the result in an `ImageData` and blits it;
 * the harness feeds it straight to a JPEG encoder. Neither path is a
 * reimplementation of the other, which is the only way the measurements mean
 * anything.
 *
 * ## WHY A WHITE PLATE UNDER THE CODE
 *
 * The stamp lands on arbitrary artwork -- usually a dark, high-contrast particle
 * field. A QR drawn as "dark modules only, background transparent" would be
 * unreadable against half of them, and worse, would give the binarizer no stable
 * white reference. `jsQR` thresholds against local averages, so the quiet zone
 * and the light modules must actually BE light. The plate is not styling; it is
 * what makes the symbol decodable at all.
 */

import type { QrMatrix } from './qrStamp.ts';

/** A raw RGBA image. The lowest common denominator of canvas and Node. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** `width * height * 4` bytes, row-major, non-premultiplied. */
  readonly data: Uint8ClampedArray;
}

/** An opaque RGBA image of a single colour. */
export function blankImage(width: number, height: number, value = 0): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(value);
  // Alpha is set separately: `fill` above would otherwise make the image
  // transparent whenever `value` is 0, and a transparent screenshot flattens to
  // black in some encoders and white in others.
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width, height, data };
}

/** Write one pixel, ignoring anything outside the image. */
function setPixel(image: RgbaImage, x: number, y: number, v: number): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const at = (y * image.width + x) * 4;
  image.data[at] = v;
  image.data[at + 1] = v;
  image.data[at + 2] = v;
  image.data[at + 3] = 255;
}

/** Fill an axis-aligned rectangle with a grey level. */
function fillRect(
  image: RgbaImage,
  x0: number,
  y0: number,
  w: number,
  h: number,
  v: number,
): void {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) setPixel(image, x, y, v);
  }
}

/**
 * Draw the stamp into `image` with its top-left at `(originX, originY)`.
 *
 * PURE BLACK AND WHITE, never anti-aliased and never a grey. Every module edge
 * is placed on an integer pixel boundary by construction (`modulePx` is an
 * integer count of pixels), so there is nothing to anti-alias -- and softening
 * the edges would hand the JPEG encoder exactly the gradients it is worst at,
 * turning a hard threshold into a ramp the binarizer then has to guess at.
 */
export function drawQrStamp(
  image: RgbaImage,
  matrix: QrMatrix,
  originX: number,
  originY: number,
): void {
  const { modulePx, quietModules, padPx } = matrix.options;

  // The plate: quiet zone plus padding, all white. Drawn first and in one go,
  // so the quiet zone cannot be left showing artwork by an off-by-one below.
  fillRect(image, originX, originY, matrix.sizePx, matrix.sizePx, 255);

  const gridX = originX + padPx + quietModules * modulePx;
  const gridY = originY + padPx + quietModules * modulePx;

  for (let row = 0; row < matrix.count; row += 1) {
    for (let col = 0; col < matrix.count; col += 1) {
      if (!matrix.dark[row * matrix.count + col]) continue;
      fillRect(
        image,
        gridX + col * modulePx,
        gridY + row * modulePx,
        modulePx,
        modulePx,
        0,
      );
    }
  }
}

/**
 * Where the stamp goes: bottom-right, inset by its own padding.
 *
 * BOTTOM-RIGHT because that is the corner least likely to hold the subject of a
 * screenshot, and because it is where a watermark conventionally sits, so it
 * reads as deliberate rather than as damage.
 */
export function stampOrigin(
  imageWidth: number,
  imageHeight: number,
  matrix: QrMatrix,
  insetPx = 0,
): { readonly x: number; readonly y: number } {
  return {
    x: imageWidth - matrix.sizePx - insetPx,
    y: imageHeight - matrix.sizePx - insetPx,
  };
}
