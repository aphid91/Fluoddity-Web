/**
 * Byte-level checks on the airbrush pass's uniform packing.
 *
 * The assertion worth having here is that `field_res` carries the FIELD's
 * resolution. The desktop's uniform is named `canvas_resolution` and is fed the
 * field size deliberately (`strafe_field.py:144-150`); the only way to catch a
 * port that "fixed" the name back to the canvas is to pass two different sizes
 * and check which one lands.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STRAFE_DRAW_UNIFORM_SIZE, packStrafeDrawUniforms } from './strafeUniforms.ts';

const hex = (b: ArrayBuffer): string => Buffer.from(b).toString('hex');

test('the uniform struct is 16-byte aligned', () => {
  // WGSL's uniform address space aligns structs to 16. The vec4-only rule makes
  // this automatic, so a failure here means a struct grew a non-vec4 member.
  assert.equal(STRAFE_DRAW_UNIFORM_SIZE % 16, 0);
  assert.equal(STRAFE_DRAW_UNIFORM_SIZE, 48);
});

test('field_res carries the FIELD resolution, not the canvas', () => {
  // Deliberately different from any plausible canvas size, so a packer that
  // reached for the canvas would be caught rather than coincidentally right.
  const buffer = packStrafeDrawUniforms([700, 300], [0.5, 0.5], [0.5, 0.5], 0.03, 1.0, false);
  const f32 = new Float32Array(buffer);
  assert.equal(f32[0], 700);
  assert.equal(f32[1], 300);
});

test('the stroke lane carries both endpoints of the segment', () => {
  // A segment, not a point: `previous_mouse` is the other end, and losing it is
  // what makes a fast drag break into dots (`strafe_draw.frag:37-41`).
  const buffer = packStrafeDrawUniforms(
    [512, 512],
    [0.25, 0.75],
    [0.125, 0.625],
    0.03,
    1.0,
    false,
  );
  const f32 = new Float32Array(buffer);
  assert.equal(f32[4], 0.25);
  assert.equal(f32[5], 0.75);
  assert.equal(f32[6], 0.125);
  assert.equal(f32[7], 0.625);
});

test('erase_mode round-trips through its float lane as an i32', () => {
  // Written through an Int32Array and read back with bitcast<i32>, the same
  // convention `uniforms.ts:29-36` establishes. Read back as a float it is a
  // denormal, which is exactly why the shader must not compare it against 0.5.
  for (const erase of [false, true]) {
    const buffer = packStrafeDrawUniforms([512, 512], [0, 0], [0, 0], 0.03, 1.0, erase);
    assert.equal(new Int32Array(buffer)[10], erase ? 1 : 0);
  }
});

test('the brush lane carries sigma and power in order', () => {
  // 0.031 is `preferences.py:65`'s default brush size and is NOT representable
  // in float32, so this compares against `Math.fround` rather than the literal.
  // Nothing is lost -- the shader reads the f32 -- but asserting the literal
  // would be asserting that JS numbers are 32-bit, which they are not.
  const buffer = packStrafeDrawUniforms([512, 512], [0, 0], [0, 0], 0.031, 2.5, false);
  const f32 = new Float32Array(buffer);
  assert.equal(f32[8], Math.fround(0.031));
  assert.equal(f32[9], 2.5);
});

test('one fully-specified record, byte for byte', () => {
  // The strongest form of the assertions above: if any lane moves, this fails
  // even when the individual reads still happen to line up.
  const buffer = packStrafeDrawUniforms(
    [512, 512],
    [0.5, 0.25],
    [0.5, 0.5],
    0.03125,
    1.0,
    true,
  );
  assert.equal(
    hex(buffer),
    // field_res 512, 512, 0, 0
    '00000044000000440000000000000000' +
      // stroke 0.5, 0.25, 0.5, 0.5
      '0000003f0000803e0000003f0000003f' +
      // brush 0.03125, 1.0, 1(i32), 0
      '0000003d0000803f0100000000000000',
  );
});
