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
  CAM_BRUSH_UNIFORM_SIZE,
  CAMERA_VIEW_UNIFORM_SIZE,
  PARTICLE_ALPHA,
  SPRITE_SIZE,
  packAccumulateUniforms,
  packCamBrushUniforms,
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
    CAM_BRUSH_UNIFORM_SIZE,
    ACCUMULATE_UNIFORM_SIZE,
  ]) {
    assert.equal(size % 16, 0, `uniform size ${size} is not a multiple of 16`);
  }
});

test('the View block lands identically in both camera modes', () => {
  // This is what makes TRAIL and PARTICLES agree about where a world point
  // lands (invariant 9, and `camera.py:292-294`). If the two modes packed pan
  // or zoom differently, toggling between them would shift the image -- which
  // is precisely the thing the mode-toggle A/B checks for.
  const trail = new Float32Array(packCameraViewUniforms(VIEW));
  const particles = new Float32Array(packCamBrushUniforms(VIEW, 0.5, false));

  for (let lane = 0; lane < 8; lane++) {
    assert.equal(
      trail[lane],
      particles[lane],
      `View lane ${lane} differs between the two camera modes`,
    );
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

test('camBrush carries the sprite constants and the colour settings', () => {
  // `Math.fround` where the value is not exact in binary32 -- the idiom
  // `uniforms.test.ts` uses, rather than an arbitrary epsilon.
  const buffer = packCamBrushUniforms(VIEW, 0.75, false);
  const f32 = new Float32Array(buffer);
  assert.equal(f32[8], SPRITE_SIZE);
  assert.equal(f32[9], Math.fround(PARTICLE_ALPHA));
  assert.equal(f32[10], 0.75, 'color_sensitivity');
});

test('colorByCohort rides an INT lane, not a float one', () => {
  // The `bitcast<i32>` idiom (`uniforms.ts:29-36`). Checked as bits through the
  // int view rather than as a number, because the float interpretation of the
  // bit pattern for 1 is a denormal -- reading it as a float would compare
  // ~1.4e-45 against 1 and fail confusingly.
  const on = new Int32Array(packCamBrushUniforms(VIEW, 0.5, true));
  const off = new Int32Array(packCamBrushUniforms(VIEW, 0.5, false));
  assert.equal(on[12], 1, 'colorByCohort true');
  assert.equal(off[12], 0, 'colorByCohort false');
});

test('the sprite constants match camera.py', () => {
  // Transcribed values, so a typo here is silent: 0.45 instead of 0.045 is a
  // ten-times-too-bright particle field that looks like a brightness bug.
  assert.equal(SPRITE_SIZE, 1.5, 'camera.py:52');
  assert.equal(PARTICLE_ALPHA, 0.045, 'camera.py:56');
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
