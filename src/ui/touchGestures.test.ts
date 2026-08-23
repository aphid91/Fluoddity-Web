/**
 * The tap/drag/long-press classification.
 *
 * WHY THIS TEST EXISTS. On a mouse the browser tells us which gesture happened;
 * on a finger we have to decide, and every one of those decisions is a threshold
 * whose failure mode is behavioural rather than structural. Nothing throws when
 * these are wrong -- the app simply becomes unpleasant in a way that is hard to
 * attribute, and impossible to notice from a desktop.
 *
 * The four rules that are easy to write, easy to "simplify", and wrong when
 * simplified:
 *
 *   1. Slop is measured from the ORIGIN. Accumulating per-move distance instead
 *      lets a slow wandering finger cross the whole screen while still counting
 *      as a tap.
 *   2. A long press cannot fire once dragging. Pausing at the end of a stroke is
 *      natural, and firing there would flip the tool mid-draw -- the exact
 *      booby-trap that kept long-press-to-toggle out of Draw mode.
 *   3. A consumed long press must not ALSO produce a tap on lift, or every
 *      long-press action happens twice.
 *   4. The second finger RETRACTS the first one's gesture rather than completing
 *      it, or every pinch leaves a stray tap or stroke behind it.
 *
 * No DOM and no clock: `TouchGesture` takes timestamps rather than reading them,
 * which is what makes the timing rules testable at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ZOOM_PER_NOTCH } from '../camera/cameraState.ts';
import {
  LONG_PRESS_MS,
  PinchTracker,
  TAP_SLOP_PX,
  TouchGesture,
  pinchToNotches,
} from './touchGestures.ts';

// --- 1. the tap/drag boundary ---------------------------------------------

test('a still finger that lifts quickly is a tap', () => {
  const g = new TouchGesture();
  g.start([100, 100], 0);
  // A real finger always jitters a little. That must not cost a tap.
  assert.equal(g.move([102, 103]).kind, 'pending');
  assert.deepEqual(g.end(50), { kind: 'tap', at: [102, 103] });
});

test('crossing the slop promotes to a drag, once', () => {
  const g = new TouchGesture();
  g.start([100, 100], 0);
  assert.equal(g.move([100 + TAP_SLOP_PX, 100]).kind, 'pending', 'at the threshold');

  const started = g.move([140, 100]);
  assert.equal(started.kind, 'drag-start');
  assert.deepEqual(
    started.kind === 'drag-start' ? started.from : null,
    [100, 100],
    'a drag must start from the ORIGIN, not from where the finger has reached',
  );

  // Every subsequent move is a continuation, not another start.
  assert.equal(g.move([160, 100]).kind, 'drag-move');
  assert.equal(g.move([180, 100]).kind, 'drag-move');
  assert.equal(g.end(300).kind, 'drag-end');
});

test('slop is measured from the origin, not step to step', () => {
  // THE ASSERTION FOR RULE 1. Each step here is 4px -- comfortably under the
  // threshold -- but the journey is 40px. Summing per-move deltas would call
  // this a tap and the canvas would never pan.
  const g = new TouchGesture();
  g.start([0, 0], 0);
  let outcome = g.move([4, 0]);
  for (let x = 8; x <= 40; x += 4) outcome = g.move([x, 0]);
  assert.equal(
    outcome.kind,
    'drag-move',
    'accumulating per-move distance lets a slow finger drag without ever becoming a drag',
  );
});

// --- 2. the long press, and the two things that must suppress it ----------

test('a still finger past the window fires a long press', () => {
  const g = new TouchGesture();
  g.start([50, 50], 1000);
  assert.equal(g.longPressDue(1000 + LONG_PRESS_MS - 1), false, 'not yet');
  assert.equal(g.longPressDue(1000 + LONG_PRESS_MS), true);
});

test('a long press fires at most once', () => {
  const g = new TouchGesture();
  g.start([50, 50], 0);
  assert.equal(g.longPressDue(LONG_PRESS_MS), true);
  assert.equal(
    g.longPressDue(LONG_PRESS_MS + 500),
    false,
    'polling again must not re-fire the action',
  );
});

test('a DRAGGING finger never fires a long press, however long it is held', () => {
  // THE ASSERTION FOR RULE 2, and the reason long-press-to-toggle was kept out
  // of Draw mode entirely. Resting at the end of a stroke is normal; flipping
  // push into pull there would make the next stroke erase the last one.
  const g = new TouchGesture();
  g.start([0, 0], 0);
  g.move([100, 0]);
  assert.equal(
    g.longPressDue(10_000),
    false,
    'a long press mid-drag would change the tool under a stroke in progress',
  );
});

test('a consumed long press does NOT also produce a tap', () => {
  // THE ASSERTION FOR RULE 3. Without this, long-press-to-undo undoes twice.
  const g = new TouchGesture();
  g.start([50, 50], 0);
  assert.equal(g.longPressDue(LONG_PRESS_MS), true);
  assert.deepEqual(
    g.end(LONG_PRESS_MS + 20),
    { kind: 'consumed' },
    'the lift after a long press must produce nothing',
  );
});

test('a finger held too long with nobody polling is not a tap either', () => {
  // The caller polls per frame and may be busy. Both paths have to agree about
  // what "too long" means, or a dropped frame turns a long press into a tap.
  const g = new TouchGesture();
  g.start([50, 50], 0);
  assert.equal(g.end(LONG_PRESS_MS + 200).kind, 'consumed');
});

// --- 3. cancellation ------------------------------------------------------

test('a cancelled gesture produces nothing on lift', () => {
  // `pointercancel` and the arrival of a second finger both land here.
  const g = new TouchGesture();
  g.start([10, 10], 0);
  g.move([200, 200]);
  g.cancel();
  assert.equal(g.end(100).kind, 'consumed');
  assert.equal(g.isActive, false);
  assert.equal(g.isDragging, false);
});

test('moves before a start are inert', () => {
  const g = new TouchGesture();
  assert.equal(g.move([5, 5]).kind, 'pending');
  assert.equal(g.longPressDue(10_000), false);
});

// --- 4. pinch -------------------------------------------------------------

test('spreading fingers zoom in and report the midpoint', () => {
  const p = new PinchTracker();
  p.start([100, 100], [200, 100]); // 100px apart, centred at 150,100
  const update = p.update([50, 100], [250, 100]); // now 200px apart
  assert.ok(update !== null);
  assert.equal(update.scale, 2, 'the distance doubled');
  assert.deepEqual(update.center, [150, 100], 'the midpoint did not move');
  assert.deepEqual(update.panBy, [0, 0], 'a pure zoom contributes no pan');
});

test('drifting fingers pan without zooming', () => {
  const p = new PinchTracker();
  p.start([100, 100], [200, 100]);
  const update = p.update([140, 130], [240, 130]);
  assert.ok(update !== null);
  assert.equal(update.scale, 1, 'the separation is unchanged');
  assert.deepEqual(update.panBy, [40, 30]);
});

test('pan and zoom are reported together, because real gestures contain both', () => {
  const p = new PinchTracker();
  p.start([100, 100], [200, 100]);
  const update = p.update([100, 140], [300, 140]);
  assert.ok(update !== null);
  assert.equal(update.scale, 2);
  assert.deepEqual(update.panBy, [50, 40]);
});

test('coincident fingers cannot produce a non-finite scale', () => {
  // Digitizers do report two identical points, and `cameraState.setZoom`
  // refuses non-finite input -- so the failure would be a zoom that silently
  // stops working rather than an error anyone could trace.
  const p = new PinchTracker();
  p.start([100, 100], [100, 100]);
  const update = p.update([100, 100], [100, 100]);
  assert.ok(update !== null);
  assert.ok(Number.isFinite(update.scale), 'scale must never be NaN or Infinity');
});

test('an update before start is refused', () => {
  const p = new PinchTracker();
  assert.equal(p.update([0, 0], [10, 10]), null);
});

// --- 5. the pinch/wheel rate must agree -----------------------------------

test('one notch of pinch equals one notch of wheel', () => {
  // THE TIE TO THE CAMERA. Pinch and wheel reach `zoomAtPixel` through the same
  // parameter, so if this conversion drifts, the two gestures zoom at different
  // rates and the pinch feels wrong in a way nothing else would explain.
  assert.ok(
    Math.abs(pinchToNotches(ZOOM_PER_NOTCH, ZOOM_PER_NOTCH) - 1) < 1e-9,
    'a scale of exactly one notch must convert to exactly one notch',
  );
  assert.ok(
    Math.abs(pinchToNotches(ZOOM_PER_NOTCH ** 3, ZOOM_PER_NOTCH) - 3) < 1e-9,
  );
  assert.equal(pinchToNotches(1, ZOOM_PER_NOTCH), 0, 'no change is no zoom');
});

test('a doubling pinch zooms in, a halving pinch zooms out', () => {
  // Sign, not magnitude: an inverted conversion would make pinch-to-zoom-in
  // zoom out, which is the kind of thing that reads as "the gesture is
  // backwards" rather than as a maths error.
  assert.ok(pinchToNotches(2, ZOOM_PER_NOTCH) > 0);
  assert.ok(pinchToNotches(0.5, ZOOM_PER_NOTCH) < 0);
});

test('a degenerate ratio is a no-op rather than a NaN', () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(pinchToNotches(bad, ZOOM_PER_NOTCH), 0, `${bad} must not zoom`);
  }
});
