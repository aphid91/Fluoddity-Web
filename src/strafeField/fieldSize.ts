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
 * rg16float is 4 bytes/texel, so 512 costs 1 MB flat. Uncapped it would follow
 * the canvas: 4 MB at world size 1, 16 MB at world size 4.
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
