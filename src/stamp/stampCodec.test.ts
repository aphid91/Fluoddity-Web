import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FORMAT_VERSION,
  MAGIC,
  StampFormatError,
  decodeStamp,
  encodeStamp,
  f16BitsToF32,
  f32ToF16Bits,
  fromHalfBits,
  toHalfBits,
} from './stampCodec.ts';
import {
  type StampData,
  STAMP_PARTICLE_STRIDE,
  CANVAS_CHANNELS,
  FIELD_CHANNELS,
  emptyLayer,
  particleCount,
} from './stampData.ts';
import { makeStampBox } from './stampBox.ts';

// ---------------------------------------------------------------------------
// Half-float conversion.
//
// The textures are float16 on the GPU, so narrowing on the way to disk is
// lossless -- but only if the conversion is right in the ranges that actually
// occur. Denormals are the faintest trails; infinities are a blown-up field.
// ---------------------------------------------------------------------------

test('half-float round-trips every exactly-representable value', () => {
  for (const value of [0, 1, -1, 0.5, 2, -2, 1024, -1024, 65504, -65504, 2 ** -14]) {
    assert.equal(f16BitsToF32(f32ToF16Bits(value)), value, `value ${value}`);
  }
});

test('half-float preserves signed zero', () => {
  assert.ok(Object.is(f16BitsToF32(f32ToF16Bits(-0)), -0));
  assert.ok(Object.is(f16BitsToF32(f32ToF16Bits(0)), 0));
});

test('half-float carries denormals rather than flushing them to zero', () => {
  // THE FAINTEST TRAILS LIVE HERE. A naive exponent shift produces zero for
  // everything below 2^-14, which would silently erase most of a decayed field.
  const denormal = 2 ** -20;
  const out = f16BitsToF32(f32ToF16Bits(denormal));
  assert.ok(out > 0, 'a denormal must not flush to zero');
  assert.equal(out, denormal);
});

test('half-float keeps the infinities and NaN a blown-up field can hold', () => {
  assert.equal(f16BitsToF32(f32ToF16Bits(Infinity)), Infinity);
  assert.equal(f16BitsToF32(f32ToF16Bits(-Infinity)), -Infinity);
  assert.ok(Number.isNaN(f16BitsToF32(f32ToF16Bits(NaN))));
});

test('half-float saturates past the f16 range instead of wrapping', () => {
  // Wrapping to a nonsense exponent would turn an overbright texel into a
  // random small value, which reads as data rather than as saturation.
  assert.equal(f16BitsToF32(f32ToF16Bits(1e30)), Infinity);
  assert.equal(f16BitsToF32(f32ToF16Bits(-1e30)), -Infinity);
});

test('half-float below the smallest denormal flushes to a signed zero', () => {
  assert.ok(Object.is(f16BitsToF32(f32ToF16Bits(1e-30)), 0));
  assert.ok(Object.is(f16BitsToF32(f32ToF16Bits(-1e-30)), -0));
});

test('array conversion round-trips through both directions', () => {
  const source = new Float32Array([0, 1, -0.5, 2 ** -18, 65504, -3.25]);
  const back = fromHalfBits(toHalfBits(source));
  assert.deepEqual(Array.from(back), Array.from(source));
});

// ---------------------------------------------------------------------------
// The container.
// ---------------------------------------------------------------------------

/** A stamp with distinguishable contents in every block. */
function sampleStamp(): StampData {
  // Two particles, filled with recognisable bytes so a mis-sliced block shows up
  // as wrong values rather than as plausible ones.
  const particles = new ArrayBuffer(2 * STAMP_PARTICLE_STRIDE);
  const floats = new Float32Array(particles);
  floats[0] = 0.25;
  floats[1] = -0.5;
  floats[8] = 1.5;
  floats[9] = -2.25;

  const canvasTexels = 3 * 2 * CANVAS_CHANNELS;
  const canvasData = new Float32Array(canvasTexels);
  for (let i = 0; i < canvasTexels; i++) canvasData[i] = i / 4;

  const fieldTexels = 2 * 2 * FIELD_CHANNELS;
  const fieldData = new Float32Array(fieldTexels);
  for (let i = 0; i < fieldTexels; i++) fieldData[i] = -i / 8;

  return {
    box: makeStampBox([-1, -0.5], [1, 0.5]),
    particles,
    canvas: { width: 3, height: 2, channels: CANVAS_CHANNELS, data: canvasData },
    field: { width: 2, height: 2, channels: FIELD_CHANNELS, data: fieldData },
    palette: [
      { slot: 0, name: 'Tangle' },
      { slot: 7, name: '' },
    ],
  };
}

test('a stamp survives an encode/decode round trip intact', () => {
  const original = sampleStamp();
  const decoded = decodeStamp(encodeStamp(original));

  assert.deepEqual(decoded.box, original.box);
  assert.deepEqual(
    Array.from(new Float32Array(decoded.particles)),
    Array.from(new Float32Array(original.particles)),
    'particles are stored verbatim',
  );
  assert.equal(decoded.canvas.width, 3);
  assert.equal(decoded.canvas.height, 2);
  assert.deepEqual(Array.from(decoded.canvas.data), Array.from(original.canvas.data));
  assert.deepEqual(Array.from(decoded.field.data), Array.from(original.field.data));
  assert.deepEqual(decoded.palette, original.palette);
  assert.equal(particleCount(decoded), 2);
});

test('the file starts with the magic and the version', () => {
  const bytes = new Uint8Array(encodeStamp(sampleStamp()));
  const magic = String.fromCharCode(...bytes.subarray(0, 8));
  assert.equal(magic, MAGIC);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(8, true), FORMAT_VERSION);
});

test('a stamp with no particles round-trips', () => {
  // The ordinary case for a world whose scene is walls only.
  const stamp: StampData = { ...sampleStamp(), particles: new ArrayBuffer(0) };
  const decoded = decodeStamp(encodeStamp(stamp));
  assert.equal(particleCount(decoded), 0);
  assert.equal(decoded.canvas.width, 3, 'the other blocks still decode');
});

test('a stamp with empty layers round-trips', () => {
  const stamp: StampData = {
    ...sampleStamp(),
    canvas: emptyLayer(CANVAS_CHANNELS),
    field: emptyLayer(FIELD_CHANNELS),
  };
  const decoded = decodeStamp(encodeStamp(stamp));
  assert.equal(decoded.canvas.width, 0);
  assert.equal(decoded.field.data.length, 0);
  assert.equal(particleCount(decoded), 2, 'particles are unaffected');
});

test('a non-stamp buffer is rejected by name', () => {
  const bytes = new Uint8Array(64);
  assert.throws(() => decodeStamp(bytes.buffer, 'world1'), (e: unknown) => {
    assert.ok(e instanceof StampFormatError);
    assert.match(e.message, /world1/);
    assert.match(e.message, /not a FWLDSTMP file/);
    return true;
  });
});

test('a buffer too short to hold a preamble is rejected rather than read past', () => {
  assert.throws(() => decodeStamp(new ArrayBuffer(4)), StampFormatError);
});

test('an unrecognized version is refused, naming both versions', () => {
  const buffer = encodeStamp(sampleStamp());
  new DataView(buffer).setUint32(8, FORMAT_VERSION + 1, true);
  assert.throws(() => decodeStamp(buffer), (e: unknown) => {
    assert.ok(e instanceof StampFormatError);
    assert.match(e.message, /version 2/);
    return true;
  });
});

test('a truncated file is reported as truncated, not as a RangeError', () => {
  // THE REGRESSION GUARD for the failure mode a partial download produces. A
  // typed array built past the end of its buffer throws a RangeError naming
  // neither the file nor the block, which is useless to a user.
  const full = encodeStamp(sampleStamp());
  const cut = full.slice(0, full.byteLength - 8);
  assert.throws(() => decodeStamp(cut, 'world3'), (e: unknown) => {
    assert.ok(e instanceof StampFormatError, `got ${String(e)}`);
    assert.match(e.message, /world3/);
    assert.match(e.message, /truncated/);
    return true;
  });
});

test('encoding refuses a stamp whose layer dimensions disagree with its data', () => {
  // Writing it would produce a file that decodes into NaN, and the failure would
  // surface as a world rendering black days later.
  const broken: StampData = {
    ...sampleStamp(),
    canvas: { width: 4, height: 4, channels: CANVAS_CHANNELS, data: new Float32Array(8) },
  };
  assert.throws(() => encodeStamp(broken), (e: unknown) => {
    assert.ok(e instanceof StampFormatError);
    assert.match(e.message, /canvas layer/);
    return true;
  });
});

test('encoding refuses a particle block that is not a whole number of entities', () => {
  const broken: StampData = {
    ...sampleStamp(),
    particles: new ArrayBuffer(STAMP_PARTICLE_STRIDE + 4),
  };
  assert.throws(() => encodeStamp(broken), (e: unknown) => {
    assert.ok(e instanceof StampFormatError);
    assert.match(e.message, /entity stride/);
    return true;
  });
});

test('decoded layer data is copied, not a view onto the whole file', () => {
  // A view would keep the whole multi-megabyte file alive for as long as any
  // layer is referenced -- for a world held in memory, the entire session.
  const buffer = encodeStamp(sampleStamp());
  const decoded = decodeStamp(buffer);
  assert.ok(
    decoded.canvas.data.buffer.byteLength < buffer.byteLength,
    'the layer must own a buffer of its own size',
  );
});

test('a header claiming more bytes than the file holds is refused', () => {
  const buffer = encodeStamp(sampleStamp());
  new DataView(buffer).setUint32(12, 0xffff, true);
  assert.throws(() => decodeStamp(buffer), StampFormatError);
});

test('the box survives exactly, so a restored scene is not offset', () => {
  // The box drives where every particle lands on paste. A lossy round trip here
  // would shift a restored scene by a fraction of the world.
  const stamp = sampleStamp();
  const decoded = decodeStamp(encodeStamp(stamp));
  assert.equal(decoded.box.min[0], stamp.box.min[0]);
  assert.equal(decoded.box.min[1], stamp.box.min[1]);
  assert.equal(decoded.box.max[0], stamp.box.max[0]);
  assert.equal(decoded.box.max[1], stamp.box.max[1]);
});
