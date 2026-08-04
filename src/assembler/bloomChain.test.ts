/**
 * Bloom's mip geometry.
 *
 * Small, but the `max(1, ...)` floor is the difference between a thin window
 * rendering and a zero-sized-texture validation error, and the floor-not-round
 * halving is what keeps the chain matching the desktop's texel offsets.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MIP_LEVELS, mipSizes } from './bloomChain.ts';

test('five levels, matching bloom.py', () => {
  assert.equal(MIP_LEVELS, 5);
  assert.equal(mipSizes(1920, 1080).length, MIP_LEVELS);
});

test('mip 0 is HALF the source, not the source', () => {
  // `bloom.py:152-157` halves before allocating, so the chain's largest texture
  // is already half res -- which is what the assembler samples. Off by one
  // level here and the bloom is either a full-res copy (wasteful, and the
  // upsample offsets all shift) or one level too small.
  const [first] = mipSizes(1920, 1080);
  assert.deepEqual(first, [960, 540]);
});

test('1920x1080 halves the way the desktop does', () => {
  assert.deepEqual(mipSizes(1920, 1080), [
    [960, 540],
    [480, 270],
    [240, 135],
    [120, 67], // 135 // 2 == 67, floored
    [60, 33], //   67 // 2 == 33, floored
  ]);
});

test('the max(1,...) floor holds at tiny and thin sizes', () => {
  // A 1x1 source must still produce five legal textures rather than descending
  // into zero. `bloom.py:154-157`.
  assert.deepEqual(mipSizes(1, 1), [
    [1, 1],
    [1, 1],
    [1, 1],
    [1, 1],
    [1, 1],
  ]);

  // A very thin window bottoms out on one axis while the other keeps halving.
  assert.deepEqual(mipSizes(3, 7), [
    [1, 3],
    [1, 1],
    [1, 1],
    [1, 1],
    [1, 1],
  ]);
});

test('halving floors rather than rounds', () => {
  // Python's `//` truncates; `Math.round` would give 68 and 34 below and the
  // texel offsets would drift a fraction of a texel from the desktop's.
  const sizes = mipSizes(270, 135);
  assert.deepEqual(sizes[0], [135, 67]);
  assert.deepEqual(sizes[1], [67, 33]);
});
