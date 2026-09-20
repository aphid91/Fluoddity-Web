/**
 * The rectangle a stamp covers, and how it maps into each layer's resolution.
 *
 * ## Why the box is stored in WORLD space and nowhere else
 *
 * A stamp spans three resources that do not share a resolution:
 *
 *   particles   continuous world-space positions, no grid at all
 *   canvas      the trail field, which FOLLOWS world size (`sizing.ts`)
 *   field       walls + painted trails, capped at MAX_FIELD_DIM^2 texels
 *
 * So there is no single pixel rect that describes a stamp. World space is the
 * one frame all three agree on -- it is what `coords.ts` calls the
 * area-preserving box, it is what a particle's position literally is, and both
 * textures are normalized [0,1] over exactly it (`worldToUv`). Storing the box
 * in world units and deriving each pixel rect on demand is what lets one stamp
 * be pasted into a world whose canvas is a different size than the one it was
 * copied from -- which is the whole reason a world save can carry a scene across
 * a World Size change.
 *
 * Storing pixel rects instead would bake the source resolution into the format
 * and make every such paste a resampling question with no answer.
 *
 * ## A LEAF
 *
 * Imports only `coords.ts`, which itself imports nothing, and touches no GPU
 * resource. The rect arithmetic is where an off-by-one silently clips a stamp
 * edge, so it is testable under `node --test`.
 */

import { type CanvasSize, type Vec2, worldToUv } from '../particleSystem/coords.ts';

/**
 * An axis-aligned box in world space.
 *
 * `min` is the corner with the smaller value on BOTH axes, which is an
 * invariant rather than a convention -- see `makeStampBox`. Half the arithmetic
 * below assumes `max >= min` componentwise and would produce negative extents
 * otherwise, and a negative extent does not throw: it yields an empty pixel rect
 * and a stamp that silently captures nothing.
 */
export interface StampBox {
  readonly min: Vec2;
  readonly max: Vec2;
}

/** A pixel rect within a texture. `x + width <= textureWidth`, always. */
export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A box from two arbitrary corners, normalized so `min <= max` on both axes.
 *
 * NORMALIZED RATHER THAN VALIDATED, because the gesture that produces a box is
 * a drag, and a drag up-and-left is not a user error -- it is half of all
 * drags. Rejecting it would make the stamp tool refuse two quadrants; sorting
 * the corners makes every drag mean what it looks like.
 */
export function makeStampBox(a: Vec2, b: Vec2): StampBox {
  return {
    min: [Math.min(a[0], b[0]), Math.min(a[1], b[1])],
    max: [Math.max(a[0], b[0]), Math.max(a[1], b[1])],
  };
}

/**
 * The box covering the entire world for a given canvas.
 *
 * THIS IS WHAT MAKES "SAVE THE INITIAL CONDITIONS" A SPECIAL CASE OF A STAMP
 * rather than its own subsystem: the whole-scene capture is `copy(worldBox)` and
 * the restore is `paste(stamp, at its own origin)`. Every correctness property
 * the stamp path has -- the box test, the free-list rebuild, the resampling --
 * is therefore exercised by the reset key on every session, which is the best
 * possible test coverage for a path that a world save depends on.
 *
 * Derived from the canvas size rather than stored, because world extent IS a
 * function of canvas aspect (`worldHalfExtent`) and a stored copy could disagree
 * with the canvas it is used against.
 */
export function wholeWorldBox(canvasSize: CanvasSize): StampBox {
  // `worldHalfExtent` is the authority on world extent; going through uv keeps
  // this from becoming a second place that knows the aspect math (invariant 9).
  const ca = canvasSize[0] / canvasSize[1];
  const s = Math.sqrt(ca);
  return { min: [-s, -1 / s], max: [s, 1 / s] };
}

/** Width and height of the box in world units. Never negative -- see `StampBox`. */
export function boxExtent(box: StampBox): Vec2 {
  return [Math.max(0, box.max[0] - box.min[0]), Math.max(0, box.max[1] - box.min[1])];
}

export function boxIsEmpty(box: StampBox): boolean {
  const [w, h] = boxExtent(box);
  return w <= 0 || h <= 0;
}

/**
 * The pixel rect a world box covers in a texture of `size`, clipped to it.
 *
 * ## The rounding is OUTWARD, and that is deliberate
 *
 * `floor` on the low corner and `ceil` on the high one, so the rect is the
 * smallest pixel-aligned box that FULLY CONTAINS the world box. Rounding to
 * nearest would drop up to half a texel at each edge, and a stamp that loses its
 * boundary pixels leaves a visible seam when pasted back adjacent to itself --
 * which is exactly what a user tiling a stamp would do first.
 *
 * Containing slightly more than asked is harmless in the other direction: the
 * extra texel is real field data that was inside the drag by up to a pixel.
 *
 * ## The y axis is flipped
 *
 * World space has +y UP (`coords.ts`); textures have +y DOWN (row 0 is the top).
 * `worldToUv` already produces a uv whose v grows with world y, so v=0 is the
 * BOTTOM row of the world and texel row 0 is the top. The flip therefore happens
 * here, once, rather than being left for each caller to remember -- a stamp
 * copied without it comes back vertically mirrored, which is the kind of bug
 * that looks like a shader problem for a day.
 */
export function pixelRectFor(box: StampBox, size: CanvasSize): PixelRect {
  const [w, h] = size;
  const uvMin = worldToUv(box.min, size);
  const uvMax = worldToUv(box.max, size);

  const x0 = Math.floor(uvMin[0] * w);
  const x1 = Math.ceil(uvMax[0] * w);
  // FLIPPED: the box's world max-y is the texture's TOP row (smallest row
  // index), so the v range inverts on the way to rows. See above.
  const y0 = Math.floor((1 - uvMax[1]) * h);
  const y1 = Math.ceil((1 - uvMin[1]) * h);

  const cx0 = clampInt(x0, 0, w);
  const cx1 = clampInt(x1, 0, w);
  const cy0 = clampInt(y0, 0, h);
  const cy1 = clampInt(y1, 0, h);

  return {
    x: cx0,
    y: cy0,
    width: Math.max(0, cx1 - cx0),
    height: Math.max(0, cy1 - cy0),
  };
}

function clampInt(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return Math.max(lo, Math.min(hi, Math.trunc(value)));
}

/**
 * Whether a world point falls inside the box.
 *
 * HALF-OPEN on the max edge, so two boxes sharing an edge partition the points
 * on it rather than both claiming them. A particle exactly on a shared boundary
 * belongs to exactly one of two adjacent stamps, which is what keeps a
 * cut-and-paste of two halves from duplicating the seam.
 *
 * Mirrored by the same test in `stampCopy.wgsl`; `stampBox.test.ts` asserts the
 * two agree on the edge cases, since a disagreement there means the host counts
 * a different number of particles than the GPU writes.
 */
export function boxContains(box: StampBox, p: Vec2): boolean {
  return (
    p[0] >= box.min[0] && p[0] < box.max[0] && p[1] >= box.min[1] && p[1] < box.max[1]
  );
}

/**
 * Move a world point from one box's frame into another's, proportionally.
 *
 * ## Why this is a RESCALE and not a translation
 *
 * A stamp pasted into a world of a different size must land somewhere sensible.
 * Translating alone would put a stamp captured from a wide world partly outside
 * a narrow one; rescaling maps the source box onto the destination box, so the
 * stamp's contents stay inside it whatever the two worlds' shapes are.
 *
 * For the whole-scene restore -- the initial-conditions case -- source and
 * destination are the same box and this is the identity, which is the property
 * that makes an unchanged world restore bit-identically rather than drifting a
 * fraction of a texel per round trip.
 *
 * A degenerate source box maps everything to the destination's min corner
 * rather than producing NaN. NaN in a particle position is not a visible
 * mistake: it propagates through the physics and the particle vanishes with no
 * error anywhere, which is the failure `coerce` in `preferences.ts` refuses for
 * the same reason.
 */
export function remapPoint(p: Vec2, from: StampBox, to: StampBox): Vec2 {
  // THE IDENTITY IS AN EARLY-OUT, NOT AN OPTIMIZATION.
  //
  // `(p - min) / extent * extent + min` is algebraically the identity and is
  // NOT the identity in f32: it round-trips through a division and a multiply,
  // and `0.3` comes back as `0.30000000000000004`. That drift is per-paste and
  // CUMULATIVE -- every R press would nudge the whole scene by an ulp, and a
  // world repeatedly saved and reloaded would creep.
  //
  // Same-box is also the overwhelmingly common case: the whole-scene restore
  // and every world load use it. So it is tested for and short-circuited, which
  // makes "restore into an unchanged world is bit-identical" a property of the
  // code rather than a hope about floating point.
  if (
    from.min[0] === to.min[0] &&
    from.min[1] === to.min[1] &&
    from.max[0] === to.max[0] &&
    from.max[1] === to.max[1]
  ) {
    return p;
  }
  const [fw, fh] = boxExtent(from);
  const [tw, th] = boxExtent(to);
  const fx = fw > 0 ? (p[0] - from.min[0]) / fw : 0;
  const fy = fh > 0 ? (p[1] - from.min[1]) / fh : 0;
  return [to.min[0] + fx * tw, to.min[1] + fy * th];
}

/**
 * The box `source` becomes when moved so its centre lands on `centre`.
 *
 * The stamp tool's placement gesture: a captured box is repositioned by pointing
 * at where its middle should go. Extent is preserved exactly, so repositioning
 * never rescales -- scaling a stamp is a different act and should not happen by
 * accident while dragging one.
 */
export function boxCenteredOn(source: StampBox, centre: Vec2): StampBox {
  const [w, h] = boxExtent(source);
  return {
    min: [centre[0] - w / 2, centre[1] - h / 2],
    max: [centre[0] + w / 2, centre[1] + h / 2],
  };
}

/** The midpoint of a box, for placing and for reporting. */
export function boxCenter(box: StampBox): Vec2 {
  return [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2];
}
