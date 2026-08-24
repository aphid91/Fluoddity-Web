/**
 * Reading a stamp back out of an image.
 *
 * ## THIS IS NOT A THIRD INTERPRETER
 *
 * `persistence.ts` owns what a document MEANS, `shareCodec.ts` owns how it is
 * spelled in bytes, and `shareLink.ts` owns how it rides in a URL. This file
 * turns PIXELS into the text one of those already understands and then gets out
 * of the way -- the string that comes off a QR is handed to `decodeShareText`,
 * the same function a pasted URL goes through. A stamped image and a pasted link
 * are therefore the same feature arriving by different doors, and neither can
 * drift from the other.
 *
 * ## WHY A SCAN AND NOT A SINGLE ATTEMPT
 *
 * The image arriving here has been through a social platform: resized to some
 * width nobody chose, re-encoded as JPEG, possibly twice. `jsQR` is written for
 * camera frames and expects to find a symbol somewhere in a photograph, which
 * makes it good at locating one and only moderately good at reading a badly
 * quantized one. The retries below are aimed at the SECOND problem, and each is
 * a distinct hypothesis about what the platform did to the pixels -- see
 * `decodeQrFromImage`.
 */

import jsQR from 'jsqr';

import type { RgbaImage } from './qrRender.ts';

/** What a decode attempt found, and what it took to find it. */
export interface QrDecodeResult {
  /** The decoded text. */
  readonly text: string;
  /**
   * Which strategy succeeded, for the harness's report.
   *
   * Carried rather than discarded because the whole point of the survival sweep
   * is to learn WHICH defence is doing the work -- a stamp that only ever
   * decodes after a 2x upscale is a stamp whose `modulePx` is too small, and
   * that is invisible if the result is just `true`.
   */
  readonly strategy: string;
}

/**
 * Nearest-neighbour scale by an integer factor.
 *
 * NEAREST, NOT BILINEAR, and that is the entire point of having it: the image
 * has already been smoothed by whatever resampling the platform applied, and
 * smoothing it again would blur module edges further. Replicating pixels gives
 * `jsQR`'s binarizer more samples per module to threshold against without
 * inventing any intermediate greys.
 */
function upscale(image: RgbaImage, factor: number): RgbaImage {
  const width = image.width * factor;
  const height = image.height * factor;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sy = (y / factor) | 0;
    for (let x = 0; x < width; x += 1) {
      const sx = (x / factor) | 0;
      const from = (sy * image.width + sx) * 4;
      const to = (y * width + x) * 4;
      data[to] = image.data[from]!;
      data[to + 1] = image.data[from + 1]!;
      data[to + 2] = image.data[from + 2]!;
      data[to + 3] = 255;
    }
  }
  return { width, height, data };
}

/**
 * Push every channel to pure black or pure white about a threshold.
 *
 * A LAST RESORT, and it can make things worse as easily as better -- which is
 * why it is tried last and never alone. JPEG ringing puts overshoot on both
 * sides of every edge; a hard threshold either cleans that up completely or
 * commits to the overshoot. Cheap enough to try, not trustworthy enough to lead
 * with.
 */
function threshold(image: RgbaImage, at: number): RgbaImage {
  const data = new Uint8ClampedArray(image.data.length);
  for (let i = 0; i < image.data.length; i += 4) {
    // Rec. 601 luma, which is what the JPEG encoder itself used to build the Y
    // channel -- so this undoes the same weighting rather than inventing one.
    const luma =
      0.299 * image.data[i]! + 0.587 * image.data[i + 1]! + 0.114 * image.data[i + 2]!;
    const v = luma >= at ? 255 : 0;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  return { width: image.width, height: image.height, data };
}

/**
 * Find and decode a stamp anywhere in an image.
 *
 * Returns `null` when there is no readable QR -- which is an ANSWER, not a
 * failure: the commonest thing on a clipboard is an image with no stamp at all,
 * and the caller distinguishes "no code here" from "a code that would not read"
 * the same way `decodeShareLink` distinguishes "not ours" from "damaged".
 *
 * THE STRATEGIES ARE ORDERED BY HOW MUCH THEY ASSUME. Plain first, because an
 * unmangled image should not pay for the others. Then upscaling, which is the
 * one that actually helps after a platform downscale -- `jsQR` needs several
 * samples per module and a 2px module does not provide them. Thresholding last,
 * for the reason its own comment gives.
 *
 * `inversionAttempts: 'attemptBoth'` is set throughout because a stamp that
 * survived a colour-managed re-encode can come back with its polarity flipped,
 * and asking costs one extra pass over an image we have already paid to build.
 */
export function decodeQrFromImage(image: RgbaImage): QrDecodeResult | null {
  const attempts: readonly (readonly [string, () => RgbaImage])[] = [
    ['as-is', () => image],
    ['upscaled 2x', () => upscale(image, 2)],
    ['upscaled 3x', () => upscale(image, 3)],
    ['thresholded', () => threshold(image, 128)],
    ['upscaled 2x + thresholded', () => threshold(upscale(image, 2), 128)],
  ];

  for (const [strategy, build] of attempts) {
    const candidate = build();
    const found = jsQR(candidate.data, candidate.width, candidate.height, {
      inversionAttempts: 'attemptBoth',
    });
    if (found !== null && found.data !== '') {
      return { text: found.data, strategy };
    }
  }
  return null;
}
