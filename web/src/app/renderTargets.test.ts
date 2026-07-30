/**
 * The resize policy for the HDR and accumulation targets.
 *
 * Only the pure decision is testable here -- allocation needs a device. But the
 * decision is where the two real hazards live: a zero-sized window (minimizing
 * reports 0x0, which is not a legal texture size) and a needless reallocation
 * every frame, which would churn the bind groups that reference these views.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HDR_FORMAT, targetsNeedRebuild } from './renderTargets.ts';

test('the first ensure() allocates', () => {
  assert.equal(targetsNeedRebuild(null, [1920, 1080]), true);
});

test('an unchanged size is a no-op', () => {
  // Called every frame, so a `true` here would reallocate two window-sized
  // textures 60 times a second and invalidate every dependent bind group.
  assert.equal(targetsNeedRebuild([1920, 1080], [1920, 1080]), false);
});

test('a changed size on either axis rebuilds', () => {
  assert.equal(targetsNeedRebuild([1920, 1080], [1920, 1081]), true);
  assert.equal(targetsNeedRebuild([1920, 1080], [1921, 1080]), true);
});

test('a zero or negative size is REFUSED, not clamped', () => {
  // `camera.py:254-258`: minimizing reports 0x0. The buffers are left alone and
  // rendering no-ops until the window comes back -- clamping to 1x1 instead
  // would reallocate twice per minimize/restore for a frame nobody sees.
  for (const bad of [[0, 1080], [1920, 0], [0, 0], [-1, 100]] as const) {
    assert.equal(targetsNeedRebuild([1920, 1080], bad), false, `size ${bad.join('x')}`);
    assert.equal(targetsNeedRebuild(null, bad), false, `size ${bad.join('x')} from null`);
  }
});

test('a non-finite size is refused', () => {
  assert.equal(targetsNeedRebuild([1920, 1080], [Number.NaN, 1080]), false);
  assert.equal(targetsNeedRebuild([1920, 1080], [1920, Number.POSITIVE_INFINITY]), false);
});

test('the HDR format is filterable and blendable in base WebGPU', () => {
  // rgba16float is `camera.py`'s `_HDR_DTYPE = 'f2'` with 4 components. Not
  // rgba32float: that is neither filterable nor blendable without optional
  // features, and the accumulator blends while bloom filters.
  assert.equal(HDR_FORMAT, 'rgba16float');
});
