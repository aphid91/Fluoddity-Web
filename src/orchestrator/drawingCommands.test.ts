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
