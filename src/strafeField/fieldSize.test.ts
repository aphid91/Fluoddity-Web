/**
 * Tests for the Strafe Field's texture sizing.
 *
 * THE DISCRIMINATING CASE IS A WIDE CANVAS UNDER BUDGET. Everything else here
 * passes under both the correct reading of `strafe_field.py:80` (cap the total
 * texel count) and the wrong one (clamp each edge to 512). Only a canvas whose
 * edge exceeds 512 while its area does not tells them apart -- so if one test in
 * this file survives a rewrite, it should be that one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_FIELD_DIM, fieldDimensions } from './fieldSize.ts';
import { canvasDimensions } from '../particleSystem/sizing.ts';

const BUDGET = MAX_FIELD_DIM * MAX_FIELD_DIM;

test('the cap is on total texels, not on either edge', () => {
  // 700x300 = 210,000 texels, comfortably under the 262,144 budget, but 700 > 512.
  // The correct answer is the canvas unchanged. A per-edge clamp gives [512, 300],
  // which is a DIFFERENT SHAPE -- and since world<->uv is normalized, that is a
  // silent skew rather than a visible error.
  assert.deepEqual(fieldDimensions([700, 300]), [700, 300]);
  assert.notDeepEqual(fieldDimensions([700, 300]), [512, 300]);

  // Taller than wide, same argument.
  assert.deepEqual(fieldDimensions([300, 700]), [300, 700]);
});

test('a canvas under budget is used at full resolution', () => {
  assert.deepEqual(fieldDimensions([256, 256]), [256, 256]);
  assert.deepEqual(fieldDimensions([64, 64]), [64, 64]);
  // The exact boundary: 512*512 is <= the budget, so it is NOT downscaled.
  assert.deepEqual(fieldDimensions([512, 512]), [512, 512]);
});

test('the default 1024x1024 canvas is capped to 512x512', () => {
  // World size 1 (`sizing.ts`'s CANVAS_DIM) -- 1,048,576 texels, 4x the budget.
  assert.deepEqual(fieldDimensions([1024, 1024]), [512, 512]);
});

test('an over-budget canvas keeps its aspect and spends the budget on shape', () => {
  // 2048x1024 is aspect 2. The capped field must stay aspect ~2, not become
  // square and not become 512x512.
  const [w, h] = fieldDimensions([2048, 1024]);
  assert.ok(w * h <= BUDGET, `${w}x${h} = ${w * h} exceeds the ${BUDGET} budget`);
  assert.ok(
    Math.abs(w / h - 2.0) < 0.01,
    `aspect ${w / h} drifted from the canvas's 2.0`,
  );
  // Composed from canvasDimensions rather than reimplemented, so assert the
  // composition rather than restating its arithmetic.
  assert.deepEqual(fieldDimensions([2048, 1024]), canvasDimensions(2.0, MAX_FIELD_DIM));
});

test('every over-budget canvas lands within the texel budget', () => {
  for (const canvas of [
    [1024, 1024],
    [2048, 2048],
    [2048, 512],
    [512, 2048],
    [4096, 1024],
  ] as const) {
    const [w, h] = fieldDimensions(canvas);
    assert.ok(
      w * h <= BUDGET,
      `${canvas[0]}x${canvas[1]} gave ${w}x${h} = ${w * h}, over the ${BUDGET} budget`,
    );
  }
});

test('MAX_FIELD_DIM has its documented value', () => {
  // 512 is `strafe_field.py:56`. rg16float is 4 bytes/texel, so this is the
  // 1 MB flat that comment claims.
  assert.equal(MAX_FIELD_DIM, 512);
  assert.equal(BUDGET * 4, 1024 * 1024);
});
