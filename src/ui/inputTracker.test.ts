/**
 * The input tracker's asymmetries, which are silent when wrong.
 *
 * WHY THIS TEST EXISTS. Every property asserted here was learned on the desktop
 * from how drags actually behave (`ui.py:166-190`), and every one of them fails
 * QUIETLY: a capture-filtered release does not throw, it leaves the canvas
 * permanently grabbed; a one-shot that forgets to drain does not throw, it picks
 * a particle every frame for as long as the mouse is still. Each is a bug you
 * find by using the app for a while and being confused, which is exactly the
 * kind worth pinning in a test.
 *
 * There is no DOM here and the tracker imports none -- that split is the whole
 * reason `inputTracker.ts` and `inputBinding.ts` are separate files.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InputTracker, LEFT_BUTTON, RIGHT_BUTTON } from './inputTracker.ts';

/** A frame's worth of nothing, so a test can advance without adding input. */
const TICK = 1 / 60;

// --- 1. a captured press is dropped entirely ------------------------------
// The panel gets the click; the canvas must not see a press OR open a drag.

test('a press on the UI neither fires a one-shot nor starts a drag', () => {
  const tracker = new InputTracker();
  tracker.onPointerDown(LEFT_BUTTON, true);

  const state = tracker.freeze(TICK);
  assert.equal(state.leftPressed, false, 'a captured press must not select');
  assert.equal(state.leftDragging, false, 'a captured press must not open a drag');
});

test('moving onto the canvas mid-press does not retroactively start a drag', () => {
  const tracker = new InputTracker();
  // Press on the panel, then wander over the canvas with the button still down.
  tracker.onPointerDown(LEFT_BUTTON, true);
  tracker.onPointerMove(400, 300);

  assert.equal(
    tracker.freeze(TICK).leftDragging,
    false,
    'a drag belongs to whoever received the press -- and the panel did',
  );
});

// --- 2. a release is never capture-filtered -------------------------------
// The case the desktop comment calls out: a drag that ends over a panel must
// still end. There is deliberately no way to express a filtered release.

test('a drag that begins on the canvas and ends over the UI still ends', () => {
  const tracker = new InputTracker();
  tracker.onPointerDown(LEFT_BUTTON, false);
  assert.equal(tracker.freeze(TICK).leftDragging, true);

  // The cursor is over the panel now. The release arrives all the same.
  tracker.onPointerUp(LEFT_BUTTON);

  assert.equal(
    tracker.freeze(TICK).leftDragging,
    false,
    'the canvas would stay grabbed forever',
  );
});

test('a drag survives the cursor crossing the UI without ending', () => {
  const tracker = new InputTracker();
  tracker.onPointerDown(RIGHT_BUTTON, false);
  tracker.onPointerMove(10, 10);
  assert.equal(tracker.freeze(TICK).rightDragging, true);

  // Several frames pass with the cursor over the panel and the button down.
  for (let i = 0; i < 3; i += 1) {
    tracker.onPointerMove(900, 20);
    assert.equal(
      tracker.freeze(TICK).rightDragging,
      true,
      'a stroke must not break when the cursor passes over a panel',
    );
  }
});

// --- 3. one-shots drain, conditions persist -------------------------------

test('a press fires for exactly one frame', () => {
  const tracker = new InputTracker();
  tracker.onPointerDown(LEFT_BUTTON, false);

  assert.equal(tracker.freeze(TICK).leftPressed, true);
  assert.equal(
    tracker.freeze(TICK).leftPressed,
    false,
    'a held button would select a new particle every frame',
  );
});

test('dragging persists across frames but pressed does not', () => {
  const tracker = new InputTracker();
  tracker.onPointerDown(LEFT_BUTTON, false);
  tracker.freeze(TICK);

  const second = tracker.freeze(TICK);
  assert.equal(second.leftPressed, false, 'events drain');
  assert.equal(second.leftDragging, true, 'conditions do not');
});

test('the two buttons are independent', () => {
  const tracker = new InputTracker();
  tracker.onPointerDown(LEFT_BUTTON, false);
  tracker.onPointerDown(RIGHT_BUTTON, false);
  tracker.onPointerUp(LEFT_BUTTON);

  const state = tracker.freeze(TICK);
  assert.equal(state.leftDragging, false);
  assert.equal(state.rightDragging, true, 'releasing left must not end a right drag');
});

// --- 4. scroll accumulates within a frame ---------------------------------
// `zoomAtPixel` takes notches as an EXPONENT, so three events between two
// frames must be worth three notches rather than the last one.

test('scroll accumulates within the frame and resets after it', () => {
  const tracker = new InputTracker();
  tracker.onWheel(1, false);
  tracker.onWheel(1, false);
  tracker.onWheel(0.5, false);

  assert.equal(tracker.freeze(TICK).scroll, 2.5, 'a fast flick is worth more than one notch');
  assert.equal(tracker.freeze(TICK).scroll, 0, 'scroll is an event, not a condition');
});

test('scroll over the UI is dropped', () => {
  const tracker = new InputTracker();
  tracker.onWheel(3, true);
  assert.equal(tracker.freeze(TICK).scroll, 0, 'scrolling the panel must not zoom the camera');
});

test('opposite scroll directions cancel', () => {
  const tracker = new InputTracker();
  tracker.onWheel(2, false);
  tracker.onWheel(-2, false);
  assert.equal(tracker.freeze(TICK).scroll, 0);
});

// --- 5. keyboard ----------------------------------------------------------

test('keysHeld persists until the key comes up; keysPressed drains', () => {
  const tracker = new InputTracker();
  tracker.onKeyDown('KeyW', false, false);

  const first = tracker.freeze(TICK);
  assert.equal(first.keysHeld.has('KeyW'), true);
  assert.equal(first.keysPressed.has('KeyW'), true);

  const second = tracker.freeze(TICK);
  assert.equal(second.keysHeld.has('KeyW'), true, 'panning must continue while held');
  assert.equal(second.keysPressed.has('KeyW'), false, 'the one-shot already fired');

  tracker.onKeyUp('KeyW', false);
  assert.equal(tracker.freeze(TICK).keysHeld.has('KeyW'), false);
});

test('a key released while a text field has focus still leaves keysHeld', () => {
  const tracker = new InputTracker();
  tracker.onKeyDown('KeyW', false, false);
  tracker.freeze(TICK);

  // Focus moved to a panel input mid-hold; the keyup is not capture-filtered.
  tracker.onKeyUp('KeyW', false);

  assert.equal(
    tracker.freeze(TICK).keysHeld.has('KeyW'),
    false,
    'the view would pan by itself with nothing held down',
  );
});

test('keys typed into an editable element never reach the canvas', () => {
  const tracker = new InputTracker();
  tracker.onKeyDown('KeyR', false, true);

  const state = tracker.freeze(TICK);
  assert.equal(state.keysPressed.has('KeyR'), false, 'typing "r" must not reset');
  assert.equal(state.keysHeld.has('KeyR'), false);
});

test('auto-repeat re-enters keysPressed every frame, as on the desktop', () => {
  const tracker = new InputTracker();
  tracker.onKeyDown('KeyR', false, false);
  assert.equal(tracker.freeze(TICK).keysPressed.has('KeyR'), true);

  // The OS repeats. GLFW cannot tell PRESS from REPEAT and neither does this.
  tracker.onKeyDown('KeyR', false, false);
  assert.equal(tracker.freeze(TICK).keysPressed.has('KeyR'), true);
});

test('shift tracks the most recent key event, including the release', () => {
  const tracker = new InputTracker();
  tracker.onKeyDown('KeyZ', true, false);
  assert.equal(tracker.freeze(TICK).shift, true);

  tracker.onKeyUp('KeyZ', false);
  assert.equal(tracker.freeze(TICK).shift, false);
});

test('shift is recorded even when the keystroke went to a text field', () => {
  const tracker = new InputTracker();
  // `ui.py:143` writes the modifier before the capture check, deliberately.
  tracker.onKeyDown('ShiftLeft', true, true);
  assert.equal(tracker.freeze(TICK).shift, true);
});

test('a canvas press records shift too, so Shift+Right can mean redo', () => {
  // WITHOUT THIS THE GESTURE IS UNRELIABLE: `shift` was written only by the key
  // handlers, so a right-click would read whatever the last KEY event left
  // behind. Someone who presses Shift with the pointer already over the canvas
  // does fire a keydown -- but one swallowed by a focused panel field, or
  // simply never fired if the modifier was held since before the window had
  // focus, leaves it false at the click that decides undo from redo.
  const tracker = new InputTracker();
  tracker.onPointerDown(RIGHT_BUTTON, false, true);
  assert.equal(tracker.freeze(TICK).shift, true);

  // And an unmodified press clears it, or one shifted click would make every
  // later right-click a redo.
  tracker.onPointerDown(RIGHT_BUTTON, false, false);
  assert.equal(tracker.freeze(TICK).shift, false);
});

test('a press captured by the UI records no shift, like everything else', () => {
  // ASYMMETRY 1 covers the modifier as well: a press that landed on a panel is
  // not a canvas gesture, so it must not leave state behind that a later canvas
  // click would read. The early return is what guarantees it.
  const tracker = new InputTracker();
  tracker.onPointerDown(RIGHT_BUTTON, true, true);
  assert.equal(tracker.freeze(TICK).shift, false);
});

// --- 6. focus loss, which the desktop never had to handle -----------------

test('losing focus clears held keys and drags', () => {
  const tracker = new InputTracker();
  tracker.onKeyDown('KeyW', false, false);
  tracker.onPointerDown(LEFT_BUTTON, false);
  tracker.freeze(TICK);

  // Alt-tab. The browser stops delivering keyup and pointerup entirely.
  tracker.onFocusLost();

  const state = tracker.freeze(TICK);
  assert.equal(state.keysHeld.size, 0, 'the view would pan forever after alt-tab');
  assert.equal(state.leftDragging, false, 'the drag would never end');
});

// --- 7. the snapshot is a snapshot ----------------------------------------
// Every consumer in a frame must see identical input, so a later event cannot
// reach back into a state something is still holding.

test('a frozen state is not disturbed by later events', () => {
  const tracker = new InputTracker();
  tracker.onKeyDown('KeyW', false, false);
  tracker.onPointerMove(100, 200);
  const state = tracker.freeze(TICK);

  tracker.onKeyDown('KeyA', false, false);
  tracker.onKeyUp('KeyW', false);
  tracker.onPointerMove(999, 999);

  assert.equal(state.keysHeld.has('KeyW'), true, 'the snapshot must not alias live state');
  assert.equal(state.keysHeld.has('KeyA'), false);
  assert.deepEqual(state.mousePos, [100, 200]);
});

test('mousePos and dt come through as given', () => {
  const tracker = new InputTracker();
  tracker.onPointerMove(12.5, 640);
  const state = tracker.freeze(0.25);

  assert.deepEqual(state.mousePos, [12.5, 640]);
  assert.equal(state.dt, 0.25);
});
