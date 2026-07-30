/**
 * Tests for the coordinate chain.
 *
 * Two kinds of check, and both are needed:
 *
 *  - ROUND TRIPS, which prove the inverse really inverts. These check the port
 *    against itself, so they cannot catch an error made consistently in both
 *    directions.
 *  - PARITY GOLDENS from the Python (see `testing/parity.ts`), which catch
 *    exactly that -- a swapped `worldHalfExtent` would round-trip perfectly and
 *    still be wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  type CanvasSize,
  type Vec2,
  type WindowSize,
  letterboxScale,
  ndcToScreen,
  ndcToWorld,
  screenNdcToWorld,
  screenToNdc,
  screenToWorld,
  uvRadiusToWorld,
  uvToWorld,
  vec2Equals,
  worldHalfExtent,
  worldToNdc,
  worldToScreenNdc,
  worldToUv,
} from './coords.ts';
import { PARITY, assertClose, assertCloseVec2, pair } from '../testing/parity.ts';

const CANVAS_SIZES: CanvasSize[] = [[1024, 1024], [1448, 724], [724, 1448]];
const WINDOW_SIZES: WindowSize[] = [[1920, 1080], [800, 800], [600, 900]];
const CAMERAS: Array<{ pan: Vec2; zoom: number }> = [
  { pan: [0, 0], zoom: 1 },
  { pan: [0.5, -0.3], zoom: 1 },
  { pan: [0.5, -0.3], zoom: 3.7 },
  { pan: [-1.25, 0.75], zoom: 0.5 },
];
const WORLD_POINTS: Vec2[] = [[0, 0], [0.37, -0.62], [-0.9, 0.15], [1.4, -1.4]];

// ---------------------------------------------------------------------------
// Round trips
// ---------------------------------------------------------------------------

test('screenNdcToWorld inverts worldToScreenNdc', () => {
  for (const canvasSize of CANVAS_SIZES) {
    for (const windowSize of WINDOW_SIZES) {
      for (const { pan, zoom } of CAMERAS) {
        for (const p of WORLD_POINTS) {
          const ndc = worldToScreenNdc(p, canvasSize, windowSize, pan, zoom);
          const back = screenNdcToWorld(ndc, canvasSize, windowSize, pan, zoom);
          const label = `p=${p} cs=${canvasSize} ws=${windowSize} pan=${pan} zoom=${zoom}`;
          assertCloseVec2(back, p, label);
        }
      }
    }
  }
});

// The full pixel chain, which exercises the y flip in both directions --
// something the ndc-only round trip above never touches.
test('screenToWorld inverts worldToScreenNdc composed with ndcToScreen', () => {
  for (const canvasSize of CANVAS_SIZES) {
    for (const windowSize of WINDOW_SIZES) {
      for (const { pan, zoom } of CAMERAS) {
        for (const p of WORLD_POINTS) {
          const ndc = worldToScreenNdc(p, canvasSize, windowSize, pan, zoom);
          const pixel = ndcToScreen(ndc, windowSize);
          // NOTE the argument order: pixel, WINDOW, CANVAS.
          const back = screenToWorld(pixel, windowSize, canvasSize, pan, zoom);
          assertCloseVec2(back, p, `p=${p} cs=${canvasSize} ws=${windowSize}`);
        }
      }
    }
  }
});

test('uvToWorld inverts worldToUv, ndcToWorld inverts worldToNdc', () => {
  for (const canvasSize of CANVAS_SIZES) {
    for (const p of WORLD_POINTS) {
      assertCloseVec2(uvToWorld(worldToUv(p, canvasSize), canvasSize), p, 'uv');
      assertCloseVec2(ndcToWorld(worldToNdc(p, canvasSize), canvasSize), p, 'ndc');
    }
  }
});

test('ndcToScreen inverts screenToNdc', () => {
  for (const windowSize of WINDOW_SIZES) {
    for (const pixel of [[0, 0], [400, 400], [123, 456]] as Vec2[]) {
      assertCloseVec2(ndcToScreen(screenToNdc(pixel, windowSize), windowSize), pixel, 'px');
    }
  }
});

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

// World space is area-preserving: (2*ex)(2*ey) == 4 for every aspect. This is
// what the module docstring claims and what would break if someone "simplified"
// the sqrt away.
test('world half-extent is area-preserving on every aspect', () => {
  for (const canvasSize of [...CANVAS_SIZES, [1920, 1080], [1, 37], [37, 1]] as CanvasSize[]) {
    const [ex, ey] = worldHalfExtent(canvasSize);
    assertClose(ex * ey, 1.0, `ex*ey for ${canvasSize}`);
  }
});

test('a square canvas reduces to the familiar [-1,1] box', () => {
  assert.deepEqual(worldHalfExtent([1024, 1024]), [1, 1]);
  assert.deepEqual(worldToNdc([0.5, -0.25], [512, 512]), [0.5, -0.25]);
});

// Pins the cancellation argument documented on UV_TO_WORLD_RADIUS: the aspect
// factors cancel, so only the factor of 2 survives and the result does not
// depend on the canvas at all.
test('uvRadiusToWorld doubles and is canvas-independent', () => {
  assert.equal(uvRadiusToWorld(0.0), 0.0);
  assert.equal(uvRadiusToWorld(0.25), 0.5);
  assert.equal(uvRadiusToWorld(1.0), 2.0);
});

// ---------------------------------------------------------------------------
// Letterboxing
// ---------------------------------------------------------------------------

test('letterboxScale returns identity for a degenerate window', () => {
  for (const bad of [[0, 100], [100, 0], [0, 0], [-5, 100], [100, -5]] as WindowSize[]) {
    assert.deepEqual(letterboxScale([1024, 1024], bad), [1, 1], `window ${bad}`);
  }
});

test('letterboxScale shrinks the overflowing axis and leaves the other exactly 1', () => {
  // Window wider than the canvas: bars left and right, x shrinks.
  const wide = letterboxScale([1024, 1024], [1920, 1080]);
  assert.equal(wide[1], 1.0, 'y must be exactly 1.0, not approximately');
  assert.ok(wide[0] < 1.0);

  // Window taller than the canvas: bars top and bottom, y shrinks.
  const tall = letterboxScale([1024, 1024], [600, 900]);
  assert.equal(tall[0], 1.0, 'x must be exactly 1.0, not approximately');
  assert.ok(tall[1] < 1.0);

  // Matching aspects: no bars at all. Equality falls into the `else` branch,
  // which yields exactly [1, 1].
  assert.deepEqual(letterboxScale([1024, 512], [1920, 960]), [1, 1]);
});

// ---------------------------------------------------------------------------
// The deliberately asymmetric guards
// ---------------------------------------------------------------------------

test('screenToNdc returns [0,0] for a degenerate window', () => {
  for (const bad of [[0, 100], [100, 0], [0, 0]] as WindowSize[]) {
    assert.deepEqual(screenToNdc([50, 50], bad), [0, 0], `window ${bad}`);
  }
});

// ndcToScreen has NO degenerate guard where screenToNdc does. That asymmetry is
// in the Python; this test documents it so nobody "fixes" it into symmetry.
test('ndcToScreen has no degenerate-window guard', () => {
  assert.deepEqual(ndcToScreen([0.5, 0.5], [0, 0]), [0, 0]);
  assert.deepEqual(ndcToScreen([-1, 1], [800, 600]), [0, 0]);
});

// The subtlest transcription trap in the file. A zero letterbox scale ZEROES
// the component; a zero zoom passes BOTH components through UNDIVIDED. A
// "tidier" per-axis rewrite would zero them instead, which is a different
// function.
test('screenNdcToWorld: zero zoom leaves both axes undivided, one guard for both', () => {
  const canvasSize: CanvasSize = [1024, 1024];
  const windowSize: WindowSize = [1024, 1024];
  const ndc: Vec2 = [0.5, 0.25];

  // With zoom 0 the divide is skipped entirely, so the result equals the zoom=1
  // result -- NOT [0, 0], which is what a per-axis `zoom ? x/zoom : 0` gives.
  const zeroZoom = screenNdcToWorld(ndc, canvasSize, windowSize, [0, 0], 0);
  const unitZoom = screenNdcToWorld(ndc, canvasSize, windowSize, [0, 0], 1);
  assert.deepEqual(zeroZoom, unitZoom);
  assert.notDeepEqual(zeroZoom, [0, 0]);

  // And crucially it affects BOTH axes together: neither is zeroed.
  assert.notEqual(zeroZoom[0], 0);
  assert.notEqual(zeroZoom[1], 0);
});

test('screenNdcToWorld: a zero letterbox scale zeroes that component', () => {
  // letterboxScale never returns 0 for a sane canvas, so drive the guard
  // directly through a canvas with a zero dimension: ca = 0 makes the wider
  // branch return [0/wa, 1] = [0, 1].
  const scale = letterboxScale([0, 1024], [1920, 1080]);
  assert.equal(scale[0], 0);

  const world = screenNdcToWorld([0.5, 0.5], [0, 1024], [1920, 1080], [0, 0], 1);
  // ex = sqrt(0) = 0, so x collapses regardless; the guard's job is to avoid
  // dividing by zero and producing NaN, which is what this asserts.
  assert.ok(Number.isFinite(world[0]), 'x must not be NaN or Infinity');
});

test('vec2Equals compares by value, not reference', () => {
  assert.ok(vec2Equals([0, 0], [0, 0]));
  assert.ok(vec2Equals([1.5, -2.5], [1.5, -2.5]));
  assert.ok(!vec2Equals([0, 0], [0, 1]));
  assert.ok(!vec2Equals([1, 0], [0, 0]));
  // Signed zero: Python's -0.0 == 0.0 is True and so is JavaScript's.
  assert.ok(vec2Equals([-0, 0], [0, -0]));
});

// ---------------------------------------------------------------------------
// Parity with the Python
// ---------------------------------------------------------------------------

test('parity: worldHalfExtent matches the Python', () => {
  for (const c of PARITY.coords.worldHalfExtent) {
    assertCloseVec2(worldHalfExtent(pair(c.canvasSize)), c.out, `cs=${c.canvasSize}`);
  }
});

test('parity: letterboxScale matches the Python', () => {
  for (const c of PARITY.coords.letterboxScale) {
    assertCloseVec2(
      letterboxScale(pair(c.canvasSize), pair(c.windowSize)),
      c.out,
      `cs=${c.canvasSize} ws=${c.windowSize}`,
    );
  }
});

test('parity: worldToUv and worldToNdc match the Python', () => {
  for (const c of PARITY.coords.worldToUv) {
    assertCloseVec2(worldToUv(pair(c.p), pair(c.canvasSize)), c.out, `uv p=${c.p}`);
  }
  for (const c of PARITY.coords.worldToNdc) {
    assertCloseVec2(worldToNdc(pair(c.p), pair(c.canvasSize)), c.out, `ndc p=${c.p}`);
  }
});

test('parity: worldToScreenNdc matches the Python', () => {
  for (const c of PARITY.coords.worldToScreenNdc) {
    assertCloseVec2(
      worldToScreenNdc(pair(c.p), pair(c.canvasSize), pair(c.windowSize), pair(c.pan), c.zoom),
      c.out,
      `p=${c.p} cs=${c.canvasSize} ws=${c.windowSize} pan=${c.pan} zoom=${c.zoom}`,
    );
  }
});

test('parity: screenToWorld matches the Python', () => {
  for (const c of PARITY.coords.screenToWorld) {
    assertCloseVec2(
      screenToWorld(pair(c.pixel), pair(c.windowSize), pair(c.canvasSize), pair(c.pan), c.zoom),
      c.out,
      `px=${c.pixel} ws=${c.windowSize} cs=${c.canvasSize} pan=${c.pan} zoom=${c.zoom}`,
    );
  }
});

test('parity: screenToNdc and uvRadiusToWorld match the Python', () => {
  for (const c of PARITY.coords.screenToNdc) {
    assertCloseVec2(screenToNdc(pair(c.pixel), pair(c.windowSize)), c.out, `px=${c.pixel}`);
  }
  for (const c of PARITY.coords.uvRadiusToWorld) {
    assertClose(uvRadiusToWorld(c.radius), c.out, `r=${c.radius}`);
  }
});
