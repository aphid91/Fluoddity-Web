/**
 * Byte-level checks on the camera passes' uniform packing.
 *
 * The lane positions here are the contract between these packers and the WGSL
 * structs; nothing checks them at runtime, because a uniform buffer is opaque
 * bytes. A swapped lane does not error -- it feeds the shader a sprite size
 * where it expected an alpha.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCUMULATE_UNIFORM_SIZE,
  CAMERA_VIEW_UNIFORM_SIZE,
  packAccumulateUniforms,
  packCameraViewUniforms,
  type CameraView,
} from './cameraUniforms.ts';

const VIEW: CameraView = {
  canvasSize: [1024, 768],
  windowSize: [1920, 1080],
  pan: [0.25, -0.5],
  zoom: 2.5,
};

test('every camera struct is 16-byte aligned', () => {
  // WGSL's uniform address space aligns structs to 16. The vec4-only rule makes
  // this automatic, so a failure means a struct grew a non-vec4 member.
  for (const size of [
    CAMERA_VIEW_UNIFORM_SIZE,
    ACCUMULATE_UNIFORM_SIZE,
  ]) {
    assert.equal(size % 16, 0, `uniform size ${size} is not a multiple of 16`);
  }
});

test('the View block carries both resolutions, pan and zoom', () => {
  const f32 = new Float32Array(packCameraViewUniforms(VIEW));
  assert.equal(f32[0], 1024, 'canvas width');
  assert.equal(f32[1], 768, 'canvas height');
  assert.equal(f32[2], 1920, 'window width');
  assert.equal(f32[3], 1080, 'window height');
  assert.equal(f32[4], 0.25, 'pan x');
  assert.equal(f32[5], -0.5, 'pan y');
  assert.equal(f32[6], 2.5, 'zoom');
  assert.equal(f32[7], 0, 'reserved lane must be zero');
});


test('inv_samples is 1/N and never non-finite', () => {
  // 1 and 1/4 are exact in binary32; 1/10 is not, hence `Math.fround`.
  assert.equal(new Float32Array(packAccumulateUniforms(1))[0], 1.0);
  assert.equal(new Float32Array(packAccumulateUniforms(4))[0], 0.25);
  assert.equal(new Float32Array(packAccumulateUniforms(10))[0], Math.fround(0.1));

  // `camera.py:149`'s `max(1, int(samples))`. A zero count must not write
  // Infinity into the buffer: the accumulator would saturate to white on the
  // first sample and stay there.
  for (const bad of [0, -3, Number.NaN]) {
    const w = new Float32Array(packAccumulateUniforms(bad))[0]!;
    assert.ok(Number.isFinite(w), `samples=${bad} gave ${w}`);
    assert.equal(w, 1.0, `samples=${bad}`);
  }
});
