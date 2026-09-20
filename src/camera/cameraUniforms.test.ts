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
  CAM_BRUSH_SWATCH_COUNT,
  CAM_BRUSH_UNIFORM_SIZE,
  CAMERA_VIEW_UNIFORM_SIZE,
  PARTICLE_ALPHA,
  SPRITE_SIZE,
  packAccumulateUniforms,
  packCamBrushUniforms,
  packCameraViewUniforms,
  type CameraView,
  type SwatchAppearance,
} from './cameraUniforms.ts';
// The palette's own count, so the two are asserted equal rather than both
// being written out here and agreeing by luck.
import { SLOT_COUNT } from '../sand/palette.ts';

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
  const particles = new Float32Array(packCamBrushUniforms(VIEW, 0));

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

test('camBrush carries the sprite constants', () => {
  // `Math.fround` where the value is not exact in binary32 -- the idiom
  // `uniforms.test.ts` uses, rather than an arbitrary epsilon.
  const buffer = packCamBrushUniforms(VIEW, 0);
  const f32 = new Float32Array(buffer);
  assert.equal(f32[8], SPRITE_SIZE);
  assert.equal(f32[9], Math.fround(PARTICLE_ALPHA));
  // THE OLD FRAME-WIDE SENSITIVITY LANE, now unwritten. Pinned at zero rather
  // than left untested: if this lane is ever reused, a shader still reading it
  // as sensitivity gets a value that visibly does nothing instead of a
  // plausible number from an unrelated setting.
  assert.equal(f32[10], 0, 'sprite.z is no longer written');
});

test('the colour mode rides an INT lane, not a float one', () => {
  // The `bitcast<i32>` idiom (`uniforms.ts:29-36`). Checked as bits through the
  // int view rather than as a number, because the float interpretation of the
  // bit pattern for 1 is a denormal -- reading it as a float would compare
  // ~1.4e-45 against 1 and fail confusingly.
  //
  // A float here would be read back by the shader as a huge integer, match no
  // mode, and fall through to Behavior -- so every particle would render in the
  // original look regardless of the dropdown.
  for (const mode of [0, 1, 2]) {
    const i32 = new Int32Array(packCamBrushUniforms(VIEW, mode));
    assert.equal(i32[12], mode, `mode ${mode}`);
  }
});

// ---------------------------------------------------------------------------
// The per-slot appearance table
// ---------------------------------------------------------------------------

/** A distinguishable entry per slot, so a misplaced lane names itself. */
function appearance(i: number): SwatchAppearance {
  return {
    hue: 0.25 * i,
    saturation: 1 - 0.25 * i,
    colorSensitivity: 0.5 - 0.5 * i,
    colorOffset: 0.125 * i,
  };
}

test('each slot lands four floats on a 16-byte stride', () => {
  // The stride is what the shader's `array<vec4f, 40>` indexes by. Packing
  // these tightly as vec2f would put slot N's hue where the shader looks for
  // slot N/2's, colouring every material as another one.
  //
  // ALL FOUR LANES ARE DATA NOW. zw were padding while the table held only a
  // colour; they carry the two hue coefficients since appearance became
  // per-config, so a packer that still zeroed them would silently render every
  // material at sensitivity 0 -- a flat hue with no response to the signal.
  const entries = [appearance(0), appearance(1), appearance(2)];
  const f32 = new Float32Array(packCamBrushUniforms(VIEW, 2, -1, entries));

  for (let i = 0; i < entries.length; i++) {
    const base = 16 + i * 4;
    assert.equal(f32[base + 0], entries[i]?.hue, `slot ${i} hue`);
    assert.equal(f32[base + 1], entries[i]?.saturation, `slot ${i} saturation`);
    assert.equal(
      f32[base + 2],
      entries[i]?.colorSensitivity,
      `slot ${i} color_sensitivity`,
    );
    assert.equal(f32[base + 3], entries[i]?.colorOffset, `slot ${i} color_offset`);
  }
});

test('one slot’s coefficients do not disturb another’s', () => {
  // THE WHOLE POINT OF THE TABLE. A frame-wide sensitivity is what this
  // replaced, so the regression to guard is any packing that lets one slot's
  // value reach a neighbour -- which would look exactly like the master
  // governing everything, the bug being fixed.
  const entries = [appearance(0), appearance(1), appearance(2)];
  const f32 = new Float32Array(packCamBrushUniforms(VIEW, 0, -1, entries));

  assert.equal(f32[16 + 0 * 4 + 2], 0.5, 'slot 0 sensitivity');
  assert.equal(f32[16 + 1 * 4 + 2], 0, 'slot 1 sensitivity');
  assert.equal(f32[16 + 2 * 4 + 2], -0.5, 'slot 2 sensitivity');
  assert.notEqual(f32[16 + 0 * 4 + 3], f32[16 + 2 * 4 + 3], 'offsets stay distinct');
});

test('the appearance table holds one entry per palette slot', () => {
  // The table is indexed by `config_index`, whose range is SLOT_COUNT. A
  // shorter table would read out of bounds for the materials above the cut.
  assert.equal(CAM_BRUSH_SWATCH_COUNT, SLOT_COUNT);
  assert.equal(CAM_BRUSH_UNIFORM_SIZE, 64 + CAM_BRUSH_SWATCH_COUNT * 16);
});

test('more entries than slots are dropped rather than overflowing', () => {
  const tooMany = Array.from({ length: CAM_BRUSH_SWATCH_COUNT + 8 }, () =>
    appearance(1),
  );
  assert.doesNotThrow(() => packCamBrushUniforms(VIEW, 2, -1, tooMany));
  const buffer = packCamBrushUniforms(VIEW, 2, -1, tooMany);
  assert.equal(buffer.byteLength, CAM_BRUSH_UNIFORM_SIZE, 'the buffer did not grow');
});

test('a caller with no appearance entries leaves the table zeroed', () => {
  // The tests pass none. A zeroed entry is hue 0 with no signal response, which
  // is unreachable rather than wrong: a particle can only carry the index of a
  // slot something was loaded into.
  const f32 = new Float32Array(packCamBrushUniforms(VIEW, 0));
  for (let lane = 16; lane < f32.length; lane++) {
    assert.equal(f32[lane], 0, `lane ${lane}`);
  }
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
