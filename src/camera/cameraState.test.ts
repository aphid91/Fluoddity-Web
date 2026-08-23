/**
 * Tests for the camera.
 *
 * `zoomAtPixel` is the behavioural heart of this file: it reads pan and zoom
 * twice around a mutation, so a transcription error shows up as a slowly
 * drifting anchor rather than an obviously wrong number. Most of the cases
 * below exist to pin that.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAMERA_MODES,
  CameraState,
  MAX_ZOOM,
  MIN_ZOOM,
  PAN_PER_SECOND,
  ZOOM_PER_NOTCH,
  ZOOM_PER_SECOND,
  nextCameraMode,
} from './cameraState.ts';
import {
  type CanvasSize,
  type Vec2,
  type WindowSize,
  screenToWorld,
  worldHalfExtent,
} from '../particleSystem/coords.ts';
import { PARITY, assertClose, assertCloseVec2, pair } from '../testing/parity.ts';

const WINDOW: WindowSize = [1920, 1080];
const CANVAS: CanvasSize = [1448, 724];

// ---------------------------------------------------------------------------
// zoomAtPixel: the anchor
// ---------------------------------------------------------------------------

test('zoomAtPixel keeps the world point under the cursor fixed', () => {
  const pixels: Vec2[] = [[960, 540], [100, 900], [0, 0], [1919, 1079]];
  const starts: Array<{ pan: Vec2; zoom: number }> = [
    { pan: [0, 0], zoom: 1 },
    { pan: [0.5, -0.3], zoom: 2.5 },
    { pan: [-1.25, 0.75], zoom: 0.5 },
  ];

  for (const pixel of pixels) {
    for (const start of starts) {
      for (const notches of [1, -1, 3, -3, 0.5]) {
        const camera = new CameraState({ pan: start.pan, zoom: start.zoom });
        const before = screenToWorld(pixel, WINDOW, CANVAS, camera.pan, camera.zoom);
        camera.zoomAtPixel(notches, pixel, WINDOW, CANVAS);
        const after = screenToWorld(pixel, WINDOW, CANVAS, camera.pan, camera.zoom);
        assertCloseVec2(
          after,
          before,
          `anchor drifted: pixel=${pixel} start=${JSON.stringify(start)} notches=${notches}`,
          1e-9,
        );
      }
    }
  }
});

// setZoom clamps BEFORE `after` is computed, so at a limit before === after and
// the pan correction is a no-op. A port that computed `after` from the
// unclamped zoom would drift the view on every further scroll at the limit.
test('zoomAtPixel does not move pan once the zoom is clamped', () => {
  const pixel: Vec2 = [200, 800];

  const atMax = new CameraState({ pan: [0.3, -0.2], zoom: MAX_ZOOM });
  atMax.zoomAtPixel(5, pixel, WINDOW, CANVAS);
  assert.equal(atMax.zoom, MAX_ZOOM);
  assert.deepEqual(atMax.pan, [0.3, -0.2], 'pan drifted while clamped at MAX_ZOOM');

  const atMin = new CameraState({ pan: [0.3, -0.2], zoom: MIN_ZOOM });
  atMin.zoomAtPixel(-5, pixel, WINDOW, CANVAS);
  assert.equal(atMin.zoom, MIN_ZOOM);
  assert.deepEqual(atMin.pan, [0.3, -0.2], 'pan drifted while clamped at MIN_ZOOM');
});

test('zoomAtPixel applies the per-notch multiplier', () => {
  const camera = new CameraState({ pan: [0, 0], zoom: 1 });
  camera.zoomAtPixel(1, [960, 540], WINDOW, CANVAS);
  assertClose(camera.zoom, ZOOM_PER_NOTCH, 'one notch');

  const three = new CameraState({ pan: [0, 0], zoom: 1 });
  three.zoomAtPixel(3, [960, 540], WINDOW, CANVAS);
  assertClose(three.zoom, ZOOM_PER_NOTCH ** 3, 'three notches');
});

test('zoomAtPixel with zero notches is a no-op', () => {
  const camera = new CameraState({ pan: [0.4, 0.6], zoom: 2 });
  camera.zoomAtPixel(0, [100, 100], WINDOW, CANVAS);
  assert.deepEqual(camera.pan, [0.4, 0.6]);
  assert.equal(camera.zoom, 2);
});

// ---------------------------------------------------------------------------
// panByPixels: the touch-drag pan
// ---------------------------------------------------------------------------

// THE ONE PROPERTY THAT MATTERS, and the reason this method differences two
// `screenToWorld` calls instead of scaling the delta by something. A finger drag
// must keep the content under the finger: if the world point under the touch
// moves, the map slides against the hand and the gesture feels like ice.
//
// Swept across zooms because the pixel-to-world scale depends on zoom -- an
// implementation that got the conversion right at 1x and wrong elsewhere is
// exactly what this catches, and is what any hand-rolled arithmetic would give.
test('panByPixels keeps the world point under a dragging finger fixed', () => {
  const deltas: Vec2[] = [[40, 0], [0, -30], [-25, 55], [200, 120]];
  const starts: Array<{ pan: Vec2; zoom: number }> = [
    { pan: [0, 0], zoom: 1 },
    { pan: [0.5, -0.3], zoom: 2.5 },
    { pan: [-1.25, 0.75], zoom: 0.5 },
    { pan: [0.1, 0.2], zoom: 12 },
  ];
  const grab: Vec2 = [700, 400];

  for (const delta of deltas) {
    for (const start of starts) {
      const camera = new CameraState({ pan: start.pan, zoom: start.zoom });
      // The world point the finger grabbed, before the drag.
      const before = screenToWorld(grab, WINDOW, CANVAS, camera.pan, camera.zoom);
      camera.panByPixels(delta, WINDOW, CANVAS);
      // After the drag that same world point must sit under the finger's NEW
      // screen position -- which is the grab point plus the delta.
      const movedGrab: Vec2 = [grab[0] + delta[0], grab[1] + delta[1]];
      const after = screenToWorld(movedGrab, WINDOW, CANVAS, camera.pan, camera.zoom);
      assertCloseVec2(
        after,
        before,
        `content slipped under the finger: delta=${delta} start=${JSON.stringify(start)}`,
        1e-9,
      );
    }
  }
});

// Sign, not magnitude. Dragging is GRABBING THE WORLD, so a finger moving right
// pulls content right and the CAMERA moves left. Dropping the negation gives an
// inverted map, which reads as the gesture being backwards rather than as a
// sign error -- and would still pass a test that only checked distance.
test('panByPixels moves the camera opposite to the finger', () => {
  const camera = new CameraState({ pan: [0, 0], zoom: 1 });
  camera.panByPixels([50, 0], WINDOW, CANVAS);
  assert.ok(camera.pan[0] < 0, 'dragging right must move the camera left');

  const vertical = new CameraState({ pan: [0, 0], zoom: 1 });
  // Screen y is DOWN and world y is UP, so a downward drag raises world y.
  vertical.panByPixels([0, 50], WINDOW, CANVAS);
  assert.ok(vertical.pan[1] > 0, 'screen-down must move the camera world-up');
});

// Zoomed in, the same finger travel covers less world -- the counterpart of
// `panByFraction scales as 1/zoom`, arrived at through the coordinate chain
// rather than through an explicit division.
test('panByPixels covers less world distance when zoomed in', () => {
  const atOne = new CameraState({ pan: [0, 0], zoom: 1 });
  atOne.panByPixels([100, 0], WINDOW, CANVAS);
  const atFour = new CameraState({ pan: [0, 0], zoom: 4 });
  atFour.panByPixels([100, 0], WINDOW, CANVAS);
  assertClose(atFour.pan[0], atOne.pan[0] / 4, 'zoomed in 4x should cover 1/4 as much');
});

test('panByPixels early-outs on a zero delta, compared by value', () => {
  // The same by-value trap `panByFraction` documents: `delta === [0, 0]`
  // compiles and is always false.
  const camera = new CameraState({ pan: [0.25, 0.75], zoom: 2 });
  camera.panByPixels([0, 0], WINDOW, CANVAS);
  assert.deepEqual(camera.pan, [0.25, 0.75]);
});

// ---------------------------------------------------------------------------
// panByFraction
// ---------------------------------------------------------------------------

// The rule that looks like a bug: BOTH axes use the canvas's half-height. Using
// each axis's own extent would make diagonal movement faster on a wide canvas.
test('panByFraction steps both axes by the visible HEIGHT, not each axis extent', () => {
  const canvas: CanvasSize = [1448, 724]; // wide: ex ~1.414, ey ~0.707
  const [ex, ey] = worldHalfExtent(canvas);
  assert.ok(ex > ey, 'test canvas must be non-square for this to mean anything');

  const camera = new CameraState({ pan: [0, 0], zoom: 1 });
  camera.panByFraction([1, 1], canvas);

  assertClose(camera.pan[0], camera.pan[1], 'x and y must move by the SAME amount');
  assertClose(camera.pan[0], 2.0 * ey, 'step must be 2*extent_y');
  // The wrong implementation would give 2*ex on the x axis.
  assert.ok(Math.abs(camera.pan[0] - 2.0 * ex) > 1e-6, 'x used its own extent');
});

test('panByFraction scales as 1/zoom', () => {
  const atOne = new CameraState({ pan: [0, 0], zoom: 1 });
  atOne.panByFraction([1, 0], CANVAS);
  const atFour = new CameraState({ pan: [0, 0], zoom: 4 });
  atFour.panByFraction([1, 0], CANVAS);
  assertClose(atFour.pan[0], atOne.pan[0] / 4, 'zoomed in 4x should step 1/4 as far');
});

test('panByFraction accumulates onto the existing pan', () => {
  const camera = new CameraState({ pan: [1, -1], zoom: 1 });
  camera.panByFraction([0.5, 0], CANVAS);
  const [, ey] = worldHalfExtent(CANVAS);
  assertClose(camera.pan[0], 1 + 0.5 * 2.0 * ey, 'x');
  assert.equal(camera.pan[1], -1, 'y must be untouched');
});

// Python compares the tuple by value. The direct transcription
// `fraction === [0, 0]` compiles and is always false, silently removing this
// early-out -- harmless here, but the same trap bites elsewhere.
test('panByFraction early-outs on a zero fraction, compared by value', () => {
  const camera = new CameraState({ pan: [0.25, 0.75], zoom: 2 });
  camera.panByFraction([0, 0], CANVAS);
  assert.deepEqual(camera.pan, [0.25, 0.75]);
  // A fresh array with equal contents must also early-out.
  camera.panByFraction([0.0, -0.0], CANVAS);
  assert.deepEqual(camera.pan, [0.25, 0.75]);
});

// ---------------------------------------------------------------------------
// zoomByFactor and setZoom
// ---------------------------------------------------------------------------

test('zoomByFactor multiplies and leaves pan untouched', () => {
  const camera = new CameraState({ pan: [0.5, -0.5], zoom: 2 });
  camera.zoomByFactor(3);
  assert.equal(camera.zoom, 6);
  assert.deepEqual(camera.pan, [0.5, -0.5], 'centre zoom must not pan');
});

test('zoomByFactor of exactly 1 is a no-op', () => {
  const camera = new CameraState({ pan: [0, 0], zoom: 2.5 });
  camera.zoomByFactor(1.0);
  assert.equal(camera.zoom, 2.5);
});

test('setZoom clamps to the documented limits', () => {
  const camera = new CameraState();
  camera.setZoom(1000);
  assert.equal(camera.zoom, MAX_ZOOM);
  camera.setZoom(0.0001);
  assert.equal(camera.zoom, MIN_ZOOM);
  camera.setZoom(-5);
  assert.equal(camera.zoom, MIN_ZOOM);
  camera.setZoom(3.5);
  assert.equal(camera.zoom, 3.5);
});

// The deliberate divergence. Python's max/min absorb NaN into MAX_ZOOM by
// accident; JavaScript's propagate it, which would break the camera forever
// with no error. The port rejects the update instead.
test('setZoom rejects a non-finite zoom rather than propagating it', () => {
  const camera = new CameraState({ pan: [0, 0], zoom: 2.5 });

  camera.setZoom(Number.NaN);
  assert.equal(camera.zoom, 2.5, 'NaN must not reach the zoom field');

  camera.setZoom(Number.POSITIVE_INFINITY);
  assert.equal(camera.zoom, 2.5);

  camera.setZoom(Number.NEGATIVE_INFINITY);
  assert.equal(camera.zoom, 2.5);

  // And a NaN zoom must never make it out through the transform chain.
  assert.ok(Number.isFinite(screenToWorld([10, 10], WINDOW, CANVAS, camera.pan, camera.zoom)[0]));
});

// ---------------------------------------------------------------------------
// Mode and reset
// ---------------------------------------------------------------------------

test('the default mode is particles', () => {
  assert.equal(new CameraState().mode, 'particles');
});

test('toggleMode cycles in declaration order', () => {
  const camera = new CameraState();
  assert.equal(camera.mode, 'particles');
  camera.toggleMode();
  assert.equal(camera.mode, 'trail');
  camera.toggleMode();
  assert.equal(camera.mode, 'particles');
});

test('nextCameraMode wraps over the ordered mode list', () => {
  assert.deepEqual([...CAMERA_MODES], ['trail', 'particles']);
  assert.equal(nextCameraMode('trail'), 'particles');
  assert.equal(nextCameraMode('particles'), 'trail');
});

// reset() deliberately leaves mode alone -- which view you are looking through
// is a display preference, not part of "where am I looking".
test('reset restores pan and zoom but NOT mode', () => {
  const camera = new CameraState({ pan: [3, -4], zoom: 7, mode: 'trail' });
  camera.reset();
  assert.deepEqual(camera.pan, [0, 0]);
  assert.equal(camera.zoom, 1.0);
  assert.equal(camera.mode, 'trail', 'reset must not touch mode');
});

// ---------------------------------------------------------------------------
// Parity with the Python
// ---------------------------------------------------------------------------

test('parity: camera constants match the Python', () => {
  const c = PARITY.camera.constants;
  assert.equal(MIN_ZOOM, c.MIN_ZOOM);
  assert.equal(MAX_ZOOM, c.MAX_ZOOM);
  assert.equal(ZOOM_PER_NOTCH, c.ZOOM_PER_NOTCH);
  assert.equal(PAN_PER_SECOND, c.PAN_PER_SECOND);
  assert.equal(ZOOM_PER_SECOND, c.ZOOM_PER_SECOND);
});

test('parity: zoomAtPixel transitions match the Python', () => {
  for (const c of PARITY.camera.zoomAtPixel) {
    const camera = new CameraState({ pan: pair(c.start.pan), zoom: c.start.zoom });
    camera.zoomAtPixel(c.notches, pair(c.pixel), pair(c.windowSize), pair(c.canvasSize));
    const label =
      `start=${JSON.stringify(c.start)} notches=${c.notches} pixel=${c.pixel}`;
    assertCloseVec2(camera.pan, c.end.pan, `${label} [pan]`, 1e-9);
    assertClose(camera.zoom, c.end.zoom, `${label} [zoom]`, 1e-9);
  }
});

test('parity: panByFraction transitions match the Python', () => {
  for (const c of PARITY.camera.panByFraction) {
    const camera = new CameraState({ pan: pair(c.start.pan), zoom: c.start.zoom });
    camera.panByFraction(pair(c.fraction), pair(c.canvasSize));
    const label = `start=${JSON.stringify(c.start)} fraction=${c.fraction} cs=${c.canvasSize}`;
    assertCloseVec2(camera.pan, c.end.pan, `${label} [pan]`, 1e-9);
    assertClose(camera.zoom, c.end.zoom, `${label} [zoom]`, 1e-9);
  }
});
