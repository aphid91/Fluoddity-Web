/**
 * The QR stamp: a share link rendered as modules, sized to survive a re-encode.
 *
 * PURE, in the same sense as `shareCodec.ts` -- it computes a MATRIX and a
 * LAYOUT, and touches no canvas. Rasterizing is `qrRender.ts`'s job. That split
 * is what lets the whole sizing policy below be swept over in a harness under
 * `node --test`, with no browser and no image, which is the only way to find out
 * what actually survives Twitter rather than guessing at it.
 *
 * ## THE PROBLEM THIS FILE IS SHAPED BY
 *
 * A share link is ~639 characters (`shareCodec.ts`). That is a version 20 QR at
 * ECC L -- 97x97 modules -- and the requirement is not that a phone camera can
 * read it, but that it survives being uploaded to X or Bluesky, recompressed as
 * JPEG, downloaded, and pasted back. No perspective, no blur, no lighting: the
 * ONLY enemies are RESAMPLING and JPEG QUANTIZATION.
 *
 * That changes what matters. Against a camera you buy robustness with error
 * correction. Against a JPEG you buy it with MODULE SIZE, because the failure
 * mode is not random noise -- it is 8x8 blocks of the DCT smearing neighbouring
 * modules into each other. A module smaller than a JPEG block is not
 * recoverable by error correction; it is gone. So `modulePx` is the primary
 * dial in this file and error correction is the secondary one.
 *
 * ## EVERYTHING IS A PARAMETER, ON PURPOSE
 *
 * Nothing here hardcodes a version, a module size or an ECC level. The whole
 * point is to sweep them (`tools/qrSurvival.mjs`) and keep what survives, so
 * every knob is in `StampOptions` with a documented default rather than baked
 * into a call site. The defaults below are a STARTING POINT for that experiment,
 * not a conclusion -- see `DEFAULT_STAMP` .
 */

import qrcode from 'qrcode-generator';

/**
 * Error-correction levels, in the library's spelling.
 *
 * L recovers ~7% of the symbol, M ~15%, Q ~25%, H ~30%. Higher costs capacity,
 * which costs VERSION, which costs module size at a fixed pixel budget -- so
 * raising this is not free robustness, it trades one defence for another. Which
 * side of that trade wins against a JPEG is exactly what the harness measures.
 */
export type EccLevel = 'L' | 'M' | 'Q' | 'H';

export interface StampOptions {
  /**
   * Device pixels per QR module. THE PRIMARY DIAL.
   *
   * JPEG works on 8x8 blocks. At 1 or 2 px per module a block spans several
   * modules and the DCT averages them together, which no amount of error
   * correction recovers. At 8+ each module owns at least one whole block and
   * survives quantization nearly intact. The interesting range is in between,
   * and that is what the sweep is for.
   */
  readonly modulePx: number;
  /** Error correction. See `EccLevel` on why more is not simply better. */
  readonly ecc: EccLevel;
  /**
   * Quiet-zone width IN MODULES. The spec says 4 and every decoder assumes some.
   *
   * NOT DECORATION: `jsQR` locates a symbol by scanning for the finder pattern's
   * 1:1:3:1:1 ratio, and a finder flush against busy artwork does not present
   * that ratio. This is the cheapest robustness in the file.
   */
  readonly quietModules: number;
  /**
   * Extra WHITE padding around the quiet zone, in device pixels.
   *
   * Distinct from `quietModules` because it scales differently: the quiet zone
   * is part of the symbol's geometry and must scale with the modules, while this
   * is a fixed margin that keeps JPEG ringing at the stamp's outer edge -- which
   * is a hard luminance step against arbitrary artwork -- from bleeding into the
   * quiet zone itself.
   */
  readonly padPx: number;
}

/**
 * MEASURED, not guessed. `tools/qrSurvival.mjs` produced these.
 *
 * 6px at ECC M is the only combination that came through every simulated
 * platform DECODING AS-IS -- no upscale, no thresholding, no retry -- which is
 * the margin worth paying for: a configuration that only decodes after a 2x
 * upscale passed the harness but has nothing left for whatever the harness did
 * not model.
 *
 * The sweep also overturned the assumption this file was first written around,
 * and the defaults reflect the corrected picture rather than the original one:
 *
 *   - JPEG quantization is NOT the threat. A hard black/white pattern at 2px
 *     modules survives quality 50 with 0.00% of its pixels crossing the
 *     threshold, because the symbol is pure luma and luma is never subsampled.
 *   - DOWNSCALING is the threat, and specifically non-integer ratios: a 2px
 *     module resampled by 0.75 loses 37% of its modules to phase aliasing,
 *     while the same module at 0.5 loses none.
 *
 * So `modulePx` is the dial and ECC is the backstop -- raising ECC costs
 * version, which costs module size at a fixed stamp budget, which spends the
 * defence that works to buy the one that mostly does not. 6px survives every
 * resize ratio tested; 2-4px fail selectively depending on where the phase
 * lands, which is the worst kind of failure because it looks like luck.
 *
 * A stamp this size on a 1080-wide canvas is large, and that is the accepted
 * trade: the feature is "this image IS the project", and an unreadable stamp
 * makes the whole thing worthless while a big one merely makes it less pretty.
 * There is a limit to that argument, though, and the block below is where it
 * bit -- a stamp can be too large to SELECT, at which point robustness has
 * bought nothing.
 */
/**
 * ## 4px RATHER THAN 6px, AND WHY THE SWEEP'S WINNER DID NOT SHIP
 *
 * The harness's favourite was 6px at ECC M -- the only setting that decoded
 * as-is on every simulated platform. It is not the default, because a second
 * measurement contradicted it: a 6px stamp is 646px square, which puts the
 * minimum crop at 886px, and a 1280x720 browser window CANNOT PRODUCE a
 * selection that large. The most robust stamp in the sweep was one most users
 * could not make.
 *
 * 4px at ECC M is 436px, a 676px minimum, and it fits.
 *
 * IT IS NOT AS ROBUST, and the difference is measured rather than hand-waved:
 * 4px FAILS the harness's `harsh 900 q60` case -- a downscale from 1080 to 900,
 * a 0.83 ratio, which is squarely in the aliasing band -- where 6px survives it.
 * It passes everything else, including both double-JPEG cases and the awkward
 * 0.94 resample.
 *
 * So this is a real trade with a real cost, taken because the alternative is not
 * a more robust feature but NO feature. The mitigation is the canvas: staying at
 * or under 1080 wide is what keeps a platform from resizing at all, and the
 * whole finding above is that an un-resized stamp is never in danger. The 900px
 * case models a platform that resizes anyway.
 *
 * `modulePx` is a parameter precisely so this can be revisited once the
 * real-upload results are in. If 4px turns out to fail somewhere real, the right
 * answer is a SHORTER PAYLOAD -- see the base32 note on `buildQrMatrix`, which
 * would cut the version and let the modules grow without growing the stamp --
 * not a bigger stamp, which is the thing that was already unaffordable.
 */
export const DEFAULT_STAMP: StampOptions = {
  modulePx: 4,
  ecc: 'M',
  quietModules: 4,
  padPx: 8,
};

/** A generated symbol: the module grid plus the pixel geometry it implies. */
export interface QrMatrix {
  /** Module count per side, EXCLUDING the quiet zone. 97 for a version 20. */
  readonly count: number;
  /** QR version, 1..40. Useful for reporting; the encoder picks it. */
  readonly version: number;
  /** `true` where the module is dark. Row-major, `count * count` entries. */
  readonly dark: readonly boolean[];
  /** Total stamp size in device pixels, including quiet zone and padding. */
  readonly sizePx: number;
  /** The options this was built with, carried so a renderer cannot disagree. */
  readonly options: StampOptions;
}

/** Thrown when a payload will not fit any QR version at the requested ECC. */
export class QrCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QrCapacityError';
  }
}

/**
 * Build the module grid for a payload.
 *
 * TYPE NUMBER 0 lets the library choose the smallest version that fits, which is
 * what we want: the payload size is set by the project, and the version follows
 * from it. Pinning a version would mean either wasting capacity or refusing
 * documents that would have fit one size up.
 *
 * MODE IS `Byte` BY CONSEQUENCE, not by choice. A share link is base64url, which
 * contains lowercase; QR's Alphanumeric mode covers only uppercase, digits and
 * nine symbols, so it cannot carry this payload at all. That costs real density
 * -- Alphanumeric packs 5.5 bits per character against Byte's 8 -- and it is the
 * single biggest lever left on stamp size if it ever matters enough to change
 * the link alphabet to base32. Noted here because it is invisible at the call
 * site and would otherwise have to be rediscovered.
 */
export function buildQrMatrix(
  payload: string,
  options: StampOptions = DEFAULT_STAMP,
): QrMatrix {
  let qr: ReturnType<typeof qrcode>;
  try {
    qr = qrcode(0, options.ecc);
    qr.addData(payload, 'Byte');
    qr.make();
  } catch (e: unknown) {
    // The library throws a bare string for an over-capacity payload, which is
    // not something a caller can catch on type. Restated as a real error naming
    // the number that has to come down, because the remedy -- fewer configs, or
    // a lower ECC -- depends on knowing it.
    throw new QrCapacityError(
      `a ${payload.length}-character payload does not fit a QR at ECC ` +
        `${options.ecc} (${e instanceof Error ? e.message : String(e)})`,
    );
  }

  const count = qr.getModuleCount();
  const dark: boolean[] = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) dark.push(qr.isDark(row, col));
  }

  const sizePx =
    (count + options.quietModules * 2) * options.modulePx + options.padPx * 2;

  return {
    count,
    // The library exposes the version only as the module count: v = (n - 17) / 4.
    version: (count - 17) / 4,
    dark,
    sizePx,
    options,
  };
}

/**
 * Warn about a share image larger than this on either side, in device pixels.
 *
 * ## 1080 IS WHERE PLATFORMS START RESIZING
 *
 * The sweep's central finding is that JPEG quality barely touches a stamp and
 * DOWNSCALING is what destroys it -- and the corollary is that an image a
 * platform does not resize is never in danger at all. Most of them leave uploads
 * at or under about 1080 on the long edge alone and resample anything above it,
 * so this is the line between "the code arrives intact" and "the code takes its
 * chances".
 *
 * A WARNING, NEVER A LIMIT, exactly as `SHARE_LINK_WARN_LENGTH` is: the image is
 * valid at any size, several routes never resize it, and someone posting to a
 * service that leaves originals alone should not be overruled by our guess. It
 * lives here rather than in the UI because it is a fact about stamp survival,
 * which is this file's subject -- the overlay only renders it.
 */
export const DOWNSCALE_WARN_PX = 1080;

/**
 * Headroom around the stamp in a minimum-sized crop, in device pixels.
 *
 * ## WHY THIS IS AN ADDITION AND NOT A MULTIPLE
 *
 * It was `sizePx * 2`, and that was unusable. The reasoning sounded right -- a
 * stamp should not fill its own screenshot -- but a 646px stamp then demanded a
 * 1292x1292 crop, which is TALLER THAN A 1080p SCREEN. On an ordinary display
 * there was no drag the user could make that satisfied it, so the feature could
 * not be operated at all. The multiple compounded the very thing that was
 * already large.
 *
 * An addition does not compound. The minimum is the stamp plus enough room for
 * the picture to be a picture, which is a FIXED amount of artwork rather than a
 * proportion of a number that is itself in flux. 240px is roughly a thumbnail's
 * worth on each axis -- visibly a screenshot with a code in the corner, not a
 * code with a border.
 *
 * The lesson generalizes and is worth stating: anything derived from `sizePx` by
 * multiplication inherits its growth, and `sizePx` grows with the payload. A
 * two-config project would have demanded a 1724px crop under the old rule.
 */
export const MIN_CROP_HEADROOM = 240;

/**
 * The smallest screenshot a stamp will fit inside, in device pixels.
 *
 * This is what the drag overlay clamps against, so it is exported rather than
 * recomputed there: the minimum and the stamp it exists for must come from one
 * calculation or they will drift apart the moment a default changes.
 */
export function minimumCropSize(matrix: QrMatrix): number {
  return matrix.sizePx + MIN_CROP_HEADROOM;
}
