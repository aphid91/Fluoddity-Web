/**
 * A screenshot with the project stamped into it.
 *
 * ## THE FEATURE, IN ONE SENTENCE
 *
 * The image IS the project: post it anywhere that carries pictures, and anyone
 * who can save the picture can load what made it -- no link to keep alongside,
 * nothing to paste into a text field, nothing a chat client can truncate.
 *
 * ## PURE, so the whole composition is testable
 *
 * Takes an `RgbaImage` and returns one. No canvas, no DOM, no `window` -- for
 * the same reason `qrRender.ts` writes into a byte array: it lets the survival
 * harness and `node --test` exercise the REAL composition rather than a copy of
 * it. `shareCapture.ts` owns everything that touches a `<canvas>`.
 *
 * ## THE MINIMUM SIZE IS A CONSTRAINT, NOT A PREFERENCE
 *
 * A stamp is a fixed number of pixels (`qrStamp.ts` explains why it cannot
 * simply be scaled down: modules smaller than a few pixels do not survive a
 * platform's resize). So a crop must be big enough to HOLD one, and the drag
 * overlay has to know that number before the user finishes dragging -- which is
 * why `minimumCropSize` lives in `qrStamp.ts` beside the geometry it derives
 * from, and why this file refuses rather than silently shrinking the stamp.
 * Shrinking would produce an image that looks right and does not decode, which
 * is the failure mode the whole feature has to avoid.
 */

import { decodeQrFromImage } from './qrDecode.ts';
import { type RgbaImage, blankImage, drawQrStamp, stampOrigin } from './qrRender.ts';
import {
  DEFAULT_STAMP,
  type StampOptions,
  buildQrMatrix,
  minimumCropSize,
} from './qrStamp.ts';

/** Thrown when a crop cannot carry a stamp. */
export class ShareImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareImageError';
  }
}

/**
 * How far the stamp sits from the edges of the image, in device pixels.
 *
 * NOT ZERO, and not for looks. A stamp flush against the border loses its quiet
 * zone the moment anything crops the image by even a pixel -- and platforms do
 * crop, for thumbnails and for aspect-ratio fitting. The inset is cheap
 * insurance against the one edit that would otherwise destroy the symbol
 * outright.
 */
export const STAMP_INSET = 16;

export interface StampedImage {
  readonly image: RgbaImage;
  /** The link the stamp carries, so a caller can offer it as text as well. */
  readonly payload: string;
  /** Stamp geometry, for a caller that wants to describe or preview it. */
  readonly stampSizePx: number;
  readonly version: number;
}

/**
 * The smallest crop that can carry a stamp for `payload`, in device pixels.
 *
 * Exported for the drag overlay, which needs it BEFORE there is an image to
 * stamp -- the minimum has to be enforced while the rectangle is still being
 * dragged, not discovered when the user lets go.
 *
 * Square, because the stamp is: a crop can be any shape as long as BOTH sides
 * clear this, and quoting one number keeps the overlay's clamping logic from
 * having to reason about which side is short.
 */
export function minimumCropFor(
  payload: string,
  options: StampOptions = DEFAULT_STAMP,
): number {
  return minimumCropSize(buildQrMatrix(payload, options));
}

/**
 * The stamp's own side for `payload`, in device pixels.
 *
 * For the drag overlay's preview square. A SEPARATE CALL rather than something
 * the caller derives from `minimumCropFor`: the two were once a fixed factor
 * apart and are not any more (see `MIN_CROP_HEADROOM`), and a preview square
 * computed from the minimum would have gone quietly wrong when that changed
 * -- drawing the user a promise about stamp size that the stamper would not
 * keep.
 */
export function stampSizeFor(
  payload: string,
  options: StampOptions = DEFAULT_STAMP,
): number {
  return buildQrMatrix(payload, options).sizePx;
}

/**
 * Stamp `payload` into the bottom-right of `source`.
 *
 * DOES NOT MUTATE `source` -- it is very likely the pixels the user is still
 * looking at, and a preview that permanently branded the live canvas would be a
 * bug that only appears when someone cancels.
 *
 * Throws `ShareImageError` when the image is too small, rather than stamping
 * something unreadable. See the file header on why that is not a courtesy.
 */
export function stampShareImage(
  source: RgbaImage,
  payload: string,
  options: StampOptions = DEFAULT_STAMP,
): StampedImage {
  const matrix = buildQrMatrix(payload, options);
  const needed = matrix.sizePx + STAMP_INSET * 2;
  if (source.width < needed || source.height < needed) {
    throw new ShareImageError(
      `a ${source.width}x${source.height} image cannot carry a ${matrix.sizePx}px ` +
        `stamp -- it needs at least ${needed}x${needed}`,
    );
  }

  // Copied, not aliased. `Uint8ClampedArray.slice` is a real copy.
  const image: RgbaImage = {
    width: source.width,
    height: source.height,
    data: source.data.slice(),
  };

  const at = stampOrigin(image.width, image.height, matrix, STAMP_INSET);
  drawQrStamp(image, matrix, at.x, at.y);

  return {
    image,
    payload,
    stampSizePx: matrix.sizePx,
    version: matrix.version,
  };
}

/**
 * Read a stamp back out of an image, if there is one.
 *
 * A THIN PASS-THROUGH, deliberately: the decode lives in `qrDecode.ts` and the
 * meaning lives in `persistence.ts`, so this exists only to give the paste path
 * a name in the same file as the stamp path. Returning the raw text rather than
 * a document keeps `decodeShareText` the single entry point for "text that
 * might be a share link", which is what stops a stamped image and a pasted URL
 * from drifting apart.
 */
export function readShareImage(image: RgbaImage): string | null {
  return decodeQrFromImage(image)?.text ?? null;
}

/**
 * A solid-colour image, for tests and for a caller that needs a blank plate.
 *
 * Re-exported rather than reached for through `qrRender.ts` so that the
 * composition layer presents one surface: a caller building a share image
 * should not have to know which of the two lower files owns which primitive.
 */
export { blankImage };
