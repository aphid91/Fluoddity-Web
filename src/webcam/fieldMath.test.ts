/**
 * The camera field's geometry. Every function here becomes a uniform lane, and
 * a wrong one does not error -- it squashes a face, stretches a gradient along
 * the world's long axis, or reads every edge as flat. These pin the arithmetic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CAMERA_FIELD_DIM, blurStep, coverScale, stencilRadius } from './fieldMath.ts';

const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-12;

test('cover: a camera wider than the world loses its sides', () => {
  // 16:9 camera over a square world: the middle 9/16 of the width is shown.
  const [sx, sy] = coverScale([1600, 900], 1);
  assert.ok(close(sx, 9 / 16));
  assert.equal(sy, 1);
});

test('cover: a camera taller than the world loses top and bottom', () => {
  // 4:3 camera over a 16:9 world.
  const [sx, sy] = coverScale([640, 480], 16 / 9);
  assert.equal(sx, 1);
  assert.ok(close(sy, (4 / 3) / (16 / 9)));
});

test('cover never squashes: the shown region has the world’s aspect', () => {
  for (const [w, h] of [[640, 480], [1280, 720], [480, 640], [100, 100]] as const) {
    for (const aspect of [0.5, 1, 4 / 3, 16 / 9, 2.4]) {
      const [sx, sy] = coverScale([w, h], aspect);
      assert.ok(sx <= 1 && sy <= 1, 'never reaches outside the picture');
      assert.ok(sx === 1 || sy === 1, 'fills the world along one axis');
      // Camera-pixel width over height of the region shown equals the world's.
      assert.ok(close((sx * w) / (sy * h), aspect));
    }
  }
});

test('cover: degenerate input is the identity, not a NaN', () => {
  assert.deepEqual(coverScale([0, 0], 1), [1, 1]);
  assert.deepEqual(coverScale([640, 480], 0), [1, 1]);
});

test('blur steps the same WORLD distance on both axes', () => {
  const aspect = 16 / 9;
  const x = blurStep(8, aspect, 'x')!;
  const y = blurStep(8, aspect, 'y')!;
  assert.equal(x[1], 0);
  assert.equal(y[0], 0);
  // u spans `aspect` times as much world as v, so the same world distance is
  // 1/aspect as much u.
  assert.ok(close(x[0] * aspect, y[1]));
  // 12 taps each side cover 3 sigma.
  assert.ok(close(y[1] * 12, (3 * 8) / CAMERA_FIELD_DIM));
});

test('a blur under half a texel is skipped, not run as a 25-tap no-op', () => {
  assert.equal(blurStep(0, 1, 'x'), null);
  assert.equal(blurStep(0.49, 1, 'y'), null);
  assert.notEqual(blurStep(0.5, 1, 'y'), null);
});

test('the stencil never steps under one texel on EITHER axis', () => {
  for (const aspect of [0.4, 1, 16 / 9, 3]) {
    const r = stencilRadius(0, aspect);
    // v step is r; u step is r / aspect. Both must be >= one texel.
    assert.ok(r * CAMERA_FIELD_DIM >= 1 - 1e-9, `v step at aspect ${aspect}`);
    assert.ok((r / aspect) * CAMERA_FIELD_DIM >= 1 - 1e-9, `u step at aspect ${aspect}`);
  }
});

test('the stencil widens with the blur', () => {
  assert.ok(close(stencilRadius(10, 1), 10 / CAMERA_FIELD_DIM));
  assert.ok(stencilRadius(10, 1) > stencilRadius(2, 1));
});
