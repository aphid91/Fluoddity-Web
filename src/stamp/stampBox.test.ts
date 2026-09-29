import test from 'node:test';
import assert from 'node:assert/strict';

import {
  type StampBox,
  boxCenter,
  boxCenteredOn,
  boxContains,
  boxExtent,
  boxIsEmpty,
  makeStampBox,
  pixelRectFor,
  remapPoint,
  wholeWorldBox,
} from './stampBox.ts';
import { worldToUv } from '../particleSystem/coords.ts';

test('a box from two corners is normalized whichever way the drag went', () => {
  // A drag up-and-left is half of all drags, not a user error -- see
  // `makeStampBox`. All four orderings must produce the same box.
  const expected = { min: [-1, -2], max: [3, 4] };
  for (const [a, b] of [
    [[-1, -2], [3, 4]],
    [[3, 4], [-1, -2]],
    [[-1, 4], [3, -2]],
    [[3, -2], [-1, 4]],
  ] as const) {
    assert.deepEqual(makeStampBox(a, b), expected);
  }
});

test('the whole-world box spans exactly the world extent', () => {
  // This is the box the initial-conditions capture uses, so if it disagreed
  // with world space the restore would clip the edges of every scene.
  const canvas = [1000, 600] as const;
  const box = wholeWorldBox(canvas);
  const s = Math.sqrt(1000 / 600);
  assert.ok(Math.abs(box.min[0] + s) < 1e-12);
  assert.ok(Math.abs(box.max[0] - s) < 1e-12);
  assert.ok(Math.abs(box.min[1] + 1 / s) < 1e-12);
  assert.ok(Math.abs(box.max[1] - 1 / s) < 1e-12);
});

test('the whole-world box maps to the full uv range', () => {
  // The two corners must land on uv 0 and 1, or the whole-scene capture would
  // silently crop.
  const canvas = [800, 480] as const;
  const box = wholeWorldBox(canvas);
  const lo = worldToUv(box.min, canvas);
  const hi = worldToUv(box.max, canvas);
  assert.ok(Math.abs(lo[0]) < 1e-12 && Math.abs(lo[1]) < 1e-12);
  assert.ok(Math.abs(hi[0] - 1) < 1e-12 && Math.abs(hi[1] - 1) < 1e-12);
});

test('the whole-world rect covers every texel of the canvas', () => {
  // THE REGRESSION GUARD for a whole-scene stamp that loses its border. If this
  // ever returns anything but the full texture, every saved world comes back
  // with a missing edge.
  for (const canvas of [[1024, 1024], [1280, 768], [700, 300]] as const) {
    const rect = pixelRectFor(wholeWorldBox(canvas), canvas);
    assert.deepEqual(
      rect,
      { x: 0, y: 0, width: canvas[0], height: canvas[1] },
      `canvas ${canvas[0]}x${canvas[1]}`,
    );
  }
});

test('a pixel rect rounds outward so no edge texel is dropped', () => {
  // Half a texel in from each edge of a 100x100 canvas: rounding to nearest
  // would shrink this to nothing at the boundary, leaving a seam when the stamp
  // is pasted back beside itself.
  const canvas = [100, 100] as const;
  const box = makeStampBox([-0.01, -0.01], [0.01, 0.01]);
  const rect = pixelRectFor(box, canvas);
  assert.ok(rect.width >= 2, `expected outward rounding, got width ${rect.width}`);
  assert.ok(rect.height >= 2, `expected outward rounding, got height ${rect.height}`);
});

test('the pixel rect does not flip y: texel row 0 is the world’s minimum y', () => {
  // The shaders index rows by v = world y / extent + 0.5 with no flip, so the
  // upper half of the WORLD (positive y) is the HIGH rows. A flip here mirrors
  // any paste into part of a world; see `pixelRectFor`.
  const canvas = [64, 64] as const;
  const world = wholeWorldBox(canvas);
  const topHalf = makeStampBox([world.min[0], 0], [world.max[0], world.max[1]]);
  const rect = pixelRectFor(topHalf, canvas);
  assert.equal(rect.y, 32, 'the upper half of the world is the high rows');
  assert.equal(rect.height, 32);
});

test('a pixel rect is clipped to the texture, never past it', () => {
  // A stamp dragged off the edge of the world is ordinary. The rect must stay
  // inside the texture or `copyTextureToBuffer` fails validation for the frame.
  const canvas = [64, 64] as const;
  const huge = makeStampBox([-100, -100], [100, 100]);
  const rect = pixelRectFor(huge, canvas);
  assert.equal(rect.x, 0);
  assert.equal(rect.y, 0);
  assert.equal(rect.width, 64);
  assert.equal(rect.height, 64);
  assert.ok(rect.x + rect.width <= canvas[0]);
  assert.ok(rect.y + rect.height <= canvas[1]);
});

test('a box entirely outside the world yields an empty rect rather than a negative one', () => {
  const canvas = [64, 64] as const;
  const rect = pixelRectFor(makeStampBox([50, 50], [60, 60]), canvas);
  assert.equal(rect.width, 0);
  assert.equal(rect.height, 0);
});

test('box containment is half-open, so adjacent stamps partition a shared edge', () => {
  // Without this a particle on a shared boundary belongs to BOTH stamps and a
  // cut-and-paste of two halves duplicates the seam.
  const box = makeStampBox([0, 0], [1, 1]);
  assert.equal(boxContains(box, [0, 0]), true, 'min corner is inside');
  assert.equal(boxContains(box, [1, 1]), false, 'max corner is outside');
  assert.equal(boxContains(box, [0.5, 1]), false, 'the max edge belongs to the neighbour');
  assert.equal(boxContains(box, [1, 0.5]), false);
  assert.equal(boxContains(box, [0.999, 0.999]), true);
});

test('remapping between identical boxes is the exact identity', () => {
  // THE PROPERTY THE RESET KEY DEPENDS ON. A whole-scene restore into an
  // unchanged world must not drift a fraction of a texel per round trip.
  const box = wholeWorldBox([1000, 600]);
  for (const p of [[0, 0], [0.3, -0.7], [-1.2, 0.9], [1.29099, -0.7745]] as const) {
    const out = remapPoint(p, box, box);
    assert.equal(out[0], p[0], 'x must be bit-identical, not merely close');
    assert.equal(out[1], p[1], 'y must be bit-identical, not merely close');
  }
});

test('remapping rescales proportionally between differently shaped boxes', () => {
  const from = makeStampBox([0, 0], [2, 2]);
  const to = makeStampBox([10, 100], [20, 400]);
  assert.deepEqual(remapPoint([0, 0], from, to), [10, 100]);
  assert.deepEqual(remapPoint([2, 2], from, to), [20, 400]);
  assert.deepEqual(remapPoint([1, 1], from, to), [15, 250]);
});

test('remapping from a degenerate box yields the destination corner, never NaN', () => {
  // NaN in a particle position is invisible: it propagates through the physics
  // and the particle vanishes with no error anywhere.
  const degenerate = makeStampBox([5, 5], [5, 5]);
  const to = makeStampBox([0, 0], [1, 1]);
  const out = remapPoint([5, 5], degenerate, to);
  assert.ok(Number.isFinite(out[0]) && Number.isFinite(out[1]));
  assert.deepEqual(out, [0, 0]);
});

test('re-centring preserves extent exactly', () => {
  // Repositioning a stamp must never rescale it -- that is a different act.
  const source = makeStampBox([-1, -2], [3, 4]);
  const moved = boxCenteredOn(source, [10, 10]);
  assert.deepEqual(boxExtent(moved), boxExtent(source));
  assert.deepEqual(boxCenter(moved), [10, 10]);
});

test('an inverted or zero box reads as empty', () => {
  assert.equal(boxIsEmpty({ min: [1, 1], max: [1, 5] } as StampBox), true);
  assert.equal(boxIsEmpty({ min: [1, 1], max: [5, 1] } as StampBox), true);
  assert.equal(boxIsEmpty(makeStampBox([0, 0], [1, 1])), false);
});
