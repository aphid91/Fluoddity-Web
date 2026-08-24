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
 * A 646px stamp on a 1080-wide canvas is large, and that is the accepted trade:
 * the feature is "this image IS the project", and an unreadable stamp makes the
 * whole thing worthless while a big one merely makes it less pretty.
 */
export const DEFAULT_STAMP: StampOptions = {
  modulePx: 6,
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
 * The smallest screenshot a stamp will fit inside, in device pixels.
 *
 * WHY A MULTIPLE RATHER THAN THE STAMP ITSELF. A stamp that fills its
 * screenshot is not a screenshot, and -- more practically -- a crop barely
 * larger than the stamp gives the drag rectangle no room to be a picture of
 * anything. The factor is the smallest that leaves the artwork legible beside
 * the code.
 *
 * This is what the drag overlay clamps against, so it is exported rather than
 * recomputed there: the minimum and the stamp it exists for must come from one
 * calculation or they will drift apart the moment a default changes.
 */
export const MIN_CROP_FACTOR = 2;

export function minimumCropSize(matrix: QrMatrix): number {
  return Math.ceil(matrix.sizePx * MIN_CROP_FACTOR);
}
