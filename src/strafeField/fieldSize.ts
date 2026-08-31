/**
 * How big the Strafe Field's texture is. A port of `strafe_field.py:43-82`.
 *
 * A leaf, for the same reason `sizing.ts` is one: it imports one function of
 * arithmetic and holds no state, so the GPU module beside it can be untestable
 * without taking this arithmetic down with it. `sizing.ts:5-11` records that the
 * strafe field is *why* that module was split out; this is the other end of that
 * decision.
 */

import { canvasDimensions } from '../particleSystem/sizing.ts';

/**
 * The user-drawn field's texel format. FOUR channels, and deliberately NOT the
 * canvas's `CANVAS_FORMAT`.
 *
 * ## Why this is its own constant
 *
 * This texture used to be `rg16float`, borrowed from `CANVAS_FORMAT` because it
 * held one 2D vector per texel and so did the canvas. It now holds TWO:
 *
 *   rg -- WALLS, a displacement added straight to position (`get_walls`)
 *   ba -- TRAILS, added to the canvas sample the sensors read (`get_can`)
 *
 * Widening `CANVAS_FORMAT` itself would have been the smaller diff and the wrong
 * move: the canvas is the biggest texture in the app and follows world size (4 MB
 * at world size 1, 16 MB at 4), so giving it two channels it would never write
 * doubles that for nothing. The field is capped at MAX_FIELD_DIM^2 and pays the
 * widening once, flat.
 *
 * `rgba16float` clears the same bar `rg16float` did and for the same reason: base
 * WebGPU filters, renders and blends it with no optional features. That is what
 * makes this a safe widening rather than a narrowing of the device matrix -- see
 * `CANVAS_FORMAT`'s note, which is about `rg32float` and still applies to it.
 */
export const FIELD_FORMAT: GPUTextureFormat = 'rgba16float';

/**
 * THE SINGLE SOURCE OF TRUTH for how detailed the field may get.
 *
 * Read as a square-equivalent edge: the field is capped at MAX_FIELD_DIM^2
 * TEXELS, not at that width and height -- see `fieldDimensions`.
 *
 * The field holds soft blobby pushes, not structure. It is sampled with LINEAR
 * filtering and consumed as a smooth displacement, so detail beyond this is
 * invisible while the VRAM is not. The canvas has to track world size because
 * trails ARE the fine detail; the field does not.
 *
 * rgba16float is 8 bytes/texel, so 512 costs 2 MB flat -- it was 1 MB while this
 * was a two-channel texture. Uncapped it would follow the canvas: 8 MB at world
 * size 1, 32 MB at world size 4, which is what the cap is buying.
 */
export const MAX_FIELD_DIM = 512;

/**
 * Field (width, height) for a canvas: the same SHAPE, with the total area capped.
 *
 * ## THE CAP IS ON TOTAL TEXELS, NOT ON EITHER EDGE
 *
 * `w * h <= MAX_FIELD_DIM**2` is the test. A 700x300 canvas is 210,000 texels --
 * under the 262,144 budget -- so it is used AT FULL RESOLUTION even though 700
 * is greater than 512. Only when the product exceeds the budget does this fall
 * back to `canvasDimensions(aspect, MAX_FIELD_DIM)`, which spends that budget on
 * a wider, shorter texture of the same aspect.
 *
 * Reading this as `[min(w, 512), min(h, 512)]` -- which is what "capped at 512"
 * sounds like -- would change the field's SHAPE on any wide canvas. World<->uv
 * is normalized, so a shape change is not an error: it is a silent skew, where
 * a stroke lands at a scaled position and the brush paints an oval.
 *
 * Composed from `canvasDimensions` rather than reimplemented: that function
 * already does area-preserving aspect math, and two copies of it would be one
 * too many (the same rule that keeps coordinate math in `coords.ts`). NOTE this
 * makes the field the SECOND caller of that function's half-to-even rounding
 * divergence (`sizing.ts:83-95`), and the first to pass it a real canvas ratio
 * rather than the fixed 1.0 -- still accepted, since a one-texel difference in a
 * smoothly-sampled field is invisible.
 */
export function fieldDimensions(
  canvasSize: readonly [number, number],
): readonly [number, number] {
  const [width, height] = canvasSize;
  if (width * height <= MAX_FIELD_DIM * MAX_FIELD_DIM) return [width, height];
  return canvasDimensions(width / height, MAX_FIELD_DIM);
}
