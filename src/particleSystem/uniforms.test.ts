/**
 * Byte-level checks on the per-pass uniform packing.
 *
 * The strongest assertion here is that `WorldData` lands at offset 0 of every
 * struct and is byte-identical to `packWorldConfig`'s own output. That is what
 * makes "one piece of code knows the WorldData layout" true rather than merely
 * intended -- a second, drifting copy would not error, it would just feed the
 * shader a different trail persistence than the host thinks it set.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BC, forUpload, makeWorldSettings, type WorldConfig } from './config.ts';
import { packWorldConfig } from './pack.ts';
import { WORLD_DATA_SIZE } from './layout.ts';
import {
  alignTo,
  BRUSH_UNIFORM_SIZE,
  CANVAS_UNIFORM_SIZE,
  ENTITY_UPDATE_UNIFORM_SIZE,
  packBrushUniforms,
  packCanvasUniforms,
  packEntityUpdateUniforms,
} from './uniforms.ts';

const WORLD: WorldConfig = forUpload(
  makeWorldSettings({
    trailPersistence: 0.9371,
    trailDiffusion: 0.618,
    boundaryConditions: BC.RESET,
  }),
  1.2599,
  3,
);

const hex = (b: ArrayBuffer): string => Buffer.from(b).toString('hex');

test('every uniform struct is 16-byte aligned', () => {
  // WGSL's uniform address space aligns structs to 16. The vec4-only rule makes
  // this automatic, so a failure here means a struct grew a non-vec4 member.
  for (const size of [
    ENTITY_UPDATE_UNIFORM_SIZE,
    CANVAS_UNIFORM_SIZE,
    BRUSH_UNIFORM_SIZE,
  ]) {
    assert.equal(size % 16, 0, `uniform size ${size} is not a multiple of 16`);
  }
});

test('WorldData occupies offset 0 of every struct, byte for byte', () => {
  const expected = hex(packWorldConfig(WORLD));
  assert.equal(expected.length / 2, WORLD_DATA_SIZE);

  const buffers = [
    packEntityUpdateUniforms(WORLD, [1024, 1024], [512, 512], 7, null, false),
    packCanvasUniforms(WORLD, 7),
    packBrushUniforms(WORLD, [1024, 1024], 7),
  ];
  for (const buffer of buffers) {
    assert.equal(
      hex(buffer.slice(0, WORLD_DATA_SIZE)),
      expected,
      'a uniform struct re-packed WorldData instead of embedding packWorldConfig',
    );
  }
});

test('frameCount round-trips through its float lane as an i32', () => {
  // It is written through an Int32Array and read back with bitcast<i32>. The
  // bit pattern for a small int is a denormal float, so reading the lane as a
  // float would give ~1e-44 rather than the count -- which is why this is
  // checked as bits, not as a number.
  for (const fc of [0, 1, 30, 13230, 2 ** 30]) {
    const buffer = packCanvasUniforms(WORLD, fc);
    const i32 = new Int32Array(buffer);
    assert.equal(i32[WORLD_DATA_SIZE / 4], fc, `frameCount ${fc} did not round-trip`);
  }
});

test('frame 0 is representable, because it is the reset sentinel', () => {
  // Belt and braces: frame 0 is what tells all three shaders to reset. If it
  // ever failed to survive packing the simulation would never spawn.
  const i32 = new Int32Array(packCanvasUniforms(WORLD, 0));
  assert.equal(i32[WORLD_DATA_SIZE / 4], 0);
});

test('the entity-update canvas_res lane carries both resolutions', () => {
  const f32 = new Float32Array(
    packEntityUpdateUniforms(WORLD, [1024, 768], [512, 256], 3, null, false),
  );
  const base = WORLD_DATA_SIZE / 4;
  assert.deepEqual([...f32.slice(base, base + 4)], [1024, 768, 512, 256]);
});

test('a null shove writes zeroes, not stale values', () => {
  const f32 = new Float32Array(
    packEntityUpdateUniforms(WORLD, [1024, 1024], [1, 1], 5, null, false),
  );
  const base = WORLD_DATA_SIZE / 4 + 4;
  assert.deepEqual([...f32.slice(base, base + 4)], [0, 0, 0, 0]);
});

test('a live shove writes centre, strength and size', () => {
  const shove = { center: [0.25, -0.5] as const, strength: -0.004, size: 0.1 };
  const f32 = new Float32Array(
    packEntityUpdateUniforms(WORLD, [1024, 1024], [1, 1], 5, shove, true),
  );
  const base = WORLD_DATA_SIZE / 4 + 4;
  // 0.25 and -0.5 are exact in binary, so these compare exactly.
  assert.equal(f32[base], 0.25);
  assert.equal(f32[base + 1], -0.5);
  // -0.004 and 0.1 are not. The lane is float32 and the input was float64, so
  // the stored value is the float32 ROUNDING of the input -- compare against
  // that, via Math.fround, rather than picking an arbitrary epsilon.
  assert.equal(f32[base + 2], Math.fround(-0.004));
  assert.equal(f32[base + 3], Math.fround(0.1));
});

test('strafeFieldActive is an int lane, and false really is 0', () => {
  const base = WORLD_DATA_SIZE / 4 + 8;
  const off = new Int32Array(
    packEntityUpdateUniforms(WORLD, [1, 1], [1, 1], 0, null, false),
  );
  const on = new Int32Array(
    packEntityUpdateUniforms(WORLD, [1, 1], [1, 1], 0, null, true),
  );
  assert.equal(off[base + 1], 0);
  assert.equal(on[base + 1], 1);
});

test('reserved lanes are left zero', () => {
  // An ArrayBuffer is zero-initialised by spec, which is what lets the packers
  // skip the reserved lanes entirely -- the same reasoning as pack.ts's misc3.
  const f32 = new Float32Array(packBrushUniforms(WORLD, [1024, 1024], 9));
  const base = WORLD_DATA_SIZE / 4;
  assert.deepEqual([...f32.slice(base + 2, base + 4)], [0, 0], 'canvas_res.zw must be zero');
  const i32 = new Int32Array(packBrushUniforms(WORLD, [1024, 1024], 9));
  assert.deepEqual([...i32.slice(base + 5, base + 8)], [0, 0, 0], 'flags.yzw must be zero');
});

test('alignTo rounds up to the next multiple, and leaves exact fits alone', () => {
  assert.equal(alignTo(80, 256), 256);
  assert.equal(alignTo(256, 256), 256);
  assert.equal(alignTo(257, 256), 512);
  assert.equal(alignTo(48, 16), 48);
  assert.equal(alignTo(0, 256), 0);
});
