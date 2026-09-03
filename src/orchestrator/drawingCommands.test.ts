/**
 * Tests for stroke assembly.
 *
 * Both asymmetries here fail silently, which is why they are pulled out of the
 * Orchestrator into a pure function at all:
 *
 *  - THE SEED. On a stroke's first frame `prevUv` must be the CURRENT position,
 *    so the segment collapses to a point. Seeded from anywhere else -- the
 *    origin being the obvious wrong choice -- the first frame paints a streak
 *    from there to the cursor. The reference implementation had this bug.
 *  - THE RELEASE. Letting go must clear the memory, or the next press draws a
 *    line from wherever the last stroke ended.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EMPTY_INPUT, type InputState } from '../ui/inputState.ts';
import { strokeFor } from './drawingCommands.ts';

/** Field uv from a screen pixel, scaled so the arithmetic is easy to read. */
const toFieldUv = (p: readonly [number, number]): readonly [number, number] => [
  p[0] / 1000,
  p[1] / 1000,
];

const input = (over: Partial<InputState> = {}): InputState => ({
  ...EMPTY_INPUT,
  mousePos: [500, 500],
  ...over,
});

test('no button down paints nothing and ends the stroke', () => {
  // BOTH halves matter. Returning no stroke but keeping the memory would make
  // the next press draw a segment from where the last one ended.
  const step = strokeFor(input(), [0.1, 0.2], toFieldUv);
  assert.equal(step.stroke, null);
  assert.equal(step.prevUv, null);
});

test('HELD is not DRAGGING -- a press that landed on a panel paints nothing', () => {
  // A drag belongs to whoever received the press. `leftPressed` without
  // `leftDragging` is the case where the press was captured by the UI.
  const step = strokeFor(input({ leftPressed: true }), null, toFieldUv);
  assert.equal(step.stroke, null);
});

test("a stroke's first frame is a point, seeded from the CURRENT position", () => {
  const step = strokeFor(input({ mousePos: [500, 500], leftDragging: true }), null, toFieldUv);
  assert.ok(step.stroke !== null);
  assert.deepEqual(step.stroke.uv, [0.5, 0.5]);
  assert.deepEqual(
    step.stroke.prevUv,
    [0.5, 0.5],
    'the first frame must be a degenerate segment, not a streak from the origin',
  );
  // And it must NOT be the origin, which is the plausible wrong answer.
  assert.notDeepEqual(step.stroke.prevUv, [0, 0]);
});

test("a stroke's later frames run from the previous frame's position", () => {
  const first = strokeFor(input({ mousePos: [100, 100], leftDragging: true }), null, toFieldUv);
  const second = strokeFor(
    input({ mousePos: [400, 200], leftDragging: true }),
    first.prevUv,
    toFieldUv,
  );
  assert.ok(second.stroke !== null);
  assert.deepEqual(second.stroke.prevUv, [0.1, 0.1]);
  assert.deepEqual(second.stroke.uv, [0.4, 0.2]);
  // The memory advances to this frame's position, ready for the next.
  assert.deepEqual(second.prevUv, [0.4, 0.2]);
});

test('right-drag erases, and LEFT WINS when both buttons are down', () => {
  const erasing = strokeFor(input({ rightDragging: true }), null, toFieldUv);
  assert.ok(erasing.stroke !== null);
  assert.equal(erasing.stroke.erasing, true);

  // A stray right-click mid-stroke must not punch a hole in what is being
  // painted (`drawing_commands.py:64-66`).
  const both = strokeFor(
    input({ leftDragging: true, rightDragging: true }),
    null,
    toFieldUv,
  );
  assert.ok(both.stroke !== null);
  assert.equal(both.stroke.erasing, false);
});

test('a release between two drags starts a fresh stroke', () => {
  // The whole point of clearing on release: the second press must not connect
  // back to where the first one ended.
  const a = strokeFor(input({ mousePos: [100, 100], leftDragging: true }), null, toFieldUv);
  const released = strokeFor(input({ mousePos: [900, 900] }), a.prevUv, toFieldUv);
  const b = strokeFor(
    input({ mousePos: [900, 900], leftDragging: true }),
    released.prevUv,
    toFieldUv,
  );
  assert.ok(b.stroke !== null);
  assert.deepEqual(
    b.stroke.prevUv,
    [0.9, 0.9],
    'a new press must start a point at the cursor, not a line from the old stroke',
  );
});

// ---------------------------------------------------------------------------
// The line tool.
//
// Shift arms an anchor; a press commits one segment from it. The two rules that
// fail quietly are the drag suppression (Shift must never seize a stroke in
// progress) and the null `prevUv` on commit (a committed press must not also
// seed a freehand drag out of the endpoint).
// ---------------------------------------------------------------------------

test('holding shift arms an anchor at the cursor and paints nothing yet', () => {
  const step = strokeFor(input({ mousePos: [300, 400], shift: true }), null, toFieldUv, null);
  assert.equal(step.stroke, null, 'arming is not a stroke');
  assert.deepEqual(step.lineAnchor, [0.3, 0.4], 'the anchor is where the cursor was');
});

test('a press while armed commits one segment from anchor to cursor', () => {
  const step = strokeFor(
    input({ mousePos: [900, 100], shift: true, leftPressed: true }),
    null,
    toFieldUv,
    [0.1, 0.9],
  );
  assert.ok(step.stroke !== null);
  assert.deepEqual(step.stroke.prevUv, [0.1, 0.9], 'the segment starts at the anchor');
  assert.deepEqual(step.stroke.uv, [0.9, 0.1], 'and ends at the cursor');
  assert.equal(step.stroke.isLine, true, 'a line is flagged so it can be gain-compensated');
  assert.equal(step.stroke.erasing, false);
});

test('committing a line does NOT also seed a freehand drag', () => {
  // The press that commits is a real press, so the freehand path would happily
  // treat it as frame one of a drag and smear a second stroke out of the
  // endpoint as the user moves away. `prevUv: null` is what prevents that.
  const step = strokeFor(
    input({ mousePos: [900, 100], shift: true, leftPressed: true }),
    null,
    toFieldUv,
    [0.1, 0.9],
  );
  assert.equal(step.prevUv, null);
});

test('the endpoint becomes the next anchor, so clicks chain into a polyline', () => {
  const step = strokeFor(
    input({ mousePos: [900, 100], shift: true, leftPressed: true }),
    null,
    toFieldUv,
    [0.1, 0.9],
  );
  assert.deepEqual(step.lineAnchor, [0.9, 0.1]);
});

test('shift held DURING a drag does not seize the stroke', () => {
  // The user is mid-stroke and reaches for a neighbouring key. Freehand painting
  // must continue, and no anchor may be taken until the drag ends -- otherwise
  // the modifier hijacks a gesture already in progress.
  const step = strokeFor(
    input({ mousePos: [500, 500], shift: true, leftDragging: true }),
    null,
    toFieldUv,
    null,
  );
  assert.equal(step.lineAnchor, null, 'no anchor may be taken mid-drag');
  assert.deepEqual(step.prevUv, [0.5, 0.5], 'the drag keeps its stroke memory');
});

test('the anchor is taken on the first frame after the drag ends', () => {
  // Shift went down mid-drag (suppressed above). Releasing the button with Shift
  // still held is the moment the line tool arms.
  const midDrag = strokeFor(
    input({ mousePos: [500, 500], shift: true, leftDragging: true }),
    null,
    toFieldUv,
    null,
  );
  const released = strokeFor(
    input({ mousePos: [700, 200], shift: true }),
    midDrag.prevUv,
    toFieldUv,
    midDrag.lineAnchor,
  );
  assert.deepEqual(released.lineAnchor, [0.7, 0.2]);
});

test('releasing shift without clicking discards the anchor', () => {
  // No half-committed state: the preview vanishes and nothing is painted.
  const step = strokeFor(input({ mousePos: [500, 500] }), null, toFieldUv, [0.1, 0.1]);
  assert.equal(step.lineAnchor, null);
  assert.equal(step.stroke, null);
});

test('shift does not arm a line while the right button erases', () => {
  // A right-drag is an erase IN PROGRESS, and has the same claim as a left-drag
  // to not being hijacked mid-gesture. The anchor waits until the button is up.
  const step = strokeFor(
    input({ mousePos: [500, 500], shift: true, rightDragging: true }),
    null,
    toFieldUv,
    null,
  );
  assert.equal(step.lineAnchor, null);
  assert.ok(step.stroke === null, 'the line branch owns the frame while shift is held');
});

test('a right-press while armed commits an ERASING line', () => {
  // The button decides draw-versus-erase for a line exactly as it does for a
  // freehand stroke, so the line tool is a modifier on the gesture rather than a
  // mode with rules of its own.
  const step = strokeFor(
    input({ mousePos: [900, 100], shift: true, rightPressed: true }),
    null,
    toFieldUv,
    [0.1, 0.9],
  );
  assert.ok(step.stroke !== null);
  assert.equal(step.stroke.erasing, true);
  assert.equal(step.stroke.isLine, true);
  assert.deepEqual(step.stroke.prevUv, [0.1, 0.9], 'still runs from the anchor');
  assert.deepEqual(step.stroke.uv, [0.9, 0.1]);
  // And it chains, so a run of right-clicks erases a connected path.
  assert.deepEqual(step.lineAnchor, [0.9, 0.1]);
});

test('a left press still wins if both buttons commit on one frame', () => {
  // The same LEFT WINS rule the freehand branch carries: a stray right-click
  // must not turn a line the user is drawing into one that erases.
  const step = strokeFor(
    input({ mousePos: [900, 100], shift: true, leftPressed: true, rightPressed: true }),
    null,
    toFieldUv,
    [0.1, 0.9],
  );
  assert.ok(step.stroke !== null);
  assert.equal(step.stroke.erasing, false);
});

test('an armed line previews without painting until the press', () => {
  const step = strokeFor(
    input({ mousePos: [800, 800], shift: true }),
    null,
    toFieldUv,
    [0.2, 0.2],
  );
  assert.equal(step.stroke, null, 'moving the cursor while armed paints nothing');
  assert.deepEqual(step.lineAnchor, [0.2, 0.2], 'and the anchor stays put');
});
