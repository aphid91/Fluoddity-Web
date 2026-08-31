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
  type FieldStrengths,
  alignTo,
  BRUSH_UNIFORM_SIZE,
  CANVAS_UNIFORM_SIZE,
  ENTITY_UPDATE_UNIFORM_SIZE,
  packBrushUniforms,
  packCanvasUniforms,
  packEntityUpdateUniforms,
  packPickUniforms,
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

/**
 * Field strengths for the tests that are not about them.
 *
 * Deliberately NOT the defaults: distinctive values make a packer that ignored
 * the argument and wrote a constant visible, where 0.01/1.0 would look correct
 * either way.
 */
const STRENGTHS: FieldStrengths = { walls: 0.03, trails: 2.5 };

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
    packEntityUpdateUniforms(WORLD, [1024, 1024], [512, 512], 7, null, false, STRENGTHS),
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
    packEntityUpdateUniforms(WORLD, [1024, 768], [512, 256], 3, null, false, STRENGTHS),
  );
  const base = WORLD_DATA_SIZE / 4;
  assert.deepEqual([...f32.slice(base, base + 4)], [1024, 768, 512, 256]);
});

test('a null shove writes zeroes, not stale values', () => {
  const f32 = new Float32Array(
    packEntityUpdateUniforms(WORLD, [1024, 1024], [1, 1], 5, null, false, STRENGTHS),
  );
  const base = WORLD_DATA_SIZE / 4 + 4;
  assert.deepEqual([...f32.slice(base, base + 4)], [0, 0, 0, 0]);
});

test('a live shove writes centre, strength and size', () => {
  const shove = { center: [0.25, -0.5] as const, strength: -0.004, size: 0.1 };
  const f32 = new Float32Array(
    packEntityUpdateUniforms(WORLD, [1024, 1024], [1, 1], 5, shove, true, STRENGTHS),
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
    packEntityUpdateUniforms(WORLD, [1, 1], [1, 1], 0, null, false, STRENGTHS),
  );
  const on = new Int32Array(
    packEntityUpdateUniforms(WORLD, [1, 1], [1, 1], 0, null, true, STRENGTHS),
  );
  assert.equal(off[base + 1], 0);
  assert.equal(on[base + 1], 1);
});

test('the two field strengths ride the flags vec4 as floats, in order', () => {
  // THE ORDER IS THE ASSERTION. Both are floats in the same range, so a
  // transposed pair packs cleanly and produces a simulation where the walls
  // slider moves the trails -- which is exactly why `FieldStrengths` is a named
  // pair rather than two positional numbers. This checks the last hop.
  const base = WORLD_DATA_SIZE / 4 + 8;
  const f32 = new Float32Array(
    packEntityUpdateUniforms(WORLD, [1, 1], [1, 1], 0, null, true, {
      walls: 0.03,
      trails: 2.5,
    }),
  );
  assert.equal(f32[base + 2], Math.fround(0.03), 'walls strength');
  assert.equal(f32[base + 3], 2.5, 'trails strength');
});

test('the strength lanes are floats, not the int lanes beside them', () => {
  // They share a vec4 with two bit-punned ints, and both views alias the same
  // ArrayBuffer. Reading a float lane as an int (or the reverse) is the mistake
  // this shape invites, so the packed bytes are checked to be a real float32
  // rather than an integer that happens to sit in the lane.
  const base = WORLD_DATA_SIZE / 4 + 8;
  const buffer = packEntityUpdateUniforms(WORLD, [1, 1], [1, 1], 0, null, true, {
    walls: 1.0,
    trails: 1.0,
  });
  // 1.0f is 0x3f800000, which as an int is 1065353216 -- not 1. If these lanes
  // were written through the Int32Array view, this would read back as 1.
  assert.equal(new Int32Array(buffer)[base + 2], 0x3f800000);
  assert.equal(new Float32Array(buffer)[base + 2], 1.0);
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

// ---------------------------------------------------------------------------
// The pick uniforms
// ---------------------------------------------------------------------------

test('packPickUniforms lays out target, radius and the highlighted cohort', () => {
  // BINARY FRACTIONS, so the assertions can be exact: the buffer is f32 and a
  // value like 0.08 does not survive the narrowing (it comes back as
  // 0.07999999821186066). Using representable values keeps this a test of the
  // LANE ORDER, which is what it is for, rather than of float precision.
  const f32 = new Float32Array(packPickUniforms(WORLD, [0.25, -0.5], 0.0625, 6));
  const base = WORLD_DATA_SIZE / 4;
  assert.equal(f32[base + 0], 0.25, 'params.x is the target x');
  assert.equal(f32[base + 1], -0.5, 'params.y is the target y');
  assert.equal(f32[base + 2], 0.0625, 'params.z is the search radius');
  // params.w WAS RESERVED and now carries the highlight. The reduce pass reads
  // it to give the lit cohort priority near the cursor, so a lane that stayed
  // zero would silently mean "cohort 0 is highlighted" -- which is a real
  // cohort, and would bias every pick in an unhighlighted session toward it.
  assert.equal(f32[base + 3], 6, 'params.w is the highlighted cohort');
});

test('packPickUniforms defaults the highlight to the negative sentinel', () => {
  // Not zero, which is a real cohort. Callers that have no highlight -- and the
  // shader's own `highlighted_cohort() >= 0.0` guard -- depend on this being
  // out of range rather than merely unset.
  const f32 = new Float32Array(packPickUniforms(WORLD, [0, 0], 0.05));
  assert.ok(f32[WORLD_DATA_SIZE / 4 + 3]! < 0, 'no highlight must pack as negative');
});
