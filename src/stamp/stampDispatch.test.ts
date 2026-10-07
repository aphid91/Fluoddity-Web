import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COPY_ROW_ALIGNMENT,
  STAMP_CLEAR_WORKGROUP_SIZE,
  STAMP_PASTE_WORKGROUP_SIZE,
  STAMP_WORKGROUP_SIZE,
  alignedBytesPerRow,
  packRows,
  particleBlockBytes,
  stampGroups,
  unpackRows,
} from './stampDispatch.ts';
import {
  COMPACT_WORKGROUP_SIZE,
  ENTITIES_PER_PARTIAL,
  partialCount,
} from '../particleSystem/compactPlan.ts';
import { CANVAS_CHANNELS, FIELD_CHANNELS, STAMP_PARTICLE_STRIDE } from './stampData.ts';

// ---------------------------------------------------------------------------
// The shared partition.
//
// The stamp copy reuses `compactScan.wgsl` and `compactPlan.partialCount` for
// its prefix sum. That reuse is only sound if the stamp's count pass partitions
// the entity buffer exactly as the compaction's does -- otherwise the host
// allocates a partials buffer of one length while the count pass writes another.
// ---------------------------------------------------------------------------

test('the stamp count pass partitions the buffer as the compaction does', () => {
  assert.equal(
    STAMP_WORKGROUP_SIZE,
    COMPACT_WORKGROUP_SIZE,
    'the shared scan assumes this partition',
  );
  assert.equal(STAMP_WORKGROUP_SIZE, ENTITIES_PER_PARTIAL);
});

test('the stamp partials buffer is sized by the shared plan', () => {
  // The number of workgroups the count pass launches must equal the number of
  // partials the scan expects, at every size including a ragged tail.
  for (const count of [1, 255, 256, 257, 100_000, 6_000_000]) {
    assert.equal(
      stampGroups(count, STAMP_WORKGROUP_SIZE),
      partialCount(count),
      `entity count ${count}`,
    );
  }
});

test('the sweep and paste passes declare their own sizes', () => {
  assert.equal(STAMP_CLEAR_WORKGROUP_SIZE, 256);
  assert.equal(STAMP_PASTE_WORKGROUP_SIZE, 256);
});

test('workgroups round up so a ragged tail is still covered', () => {
  assert.equal(stampGroups(1, 256), 1);
  assert.equal(stampGroups(256, 256), 1);
  assert.equal(stampGroups(257, 256), 2, 'the tail gets its own group');
});

test('an empty dispatch is zero groups, not one', () => {
  assert.equal(stampGroups(0, 256), 0);
  assert.equal(stampGroups(-5, 256), 0);
  assert.equal(stampGroups(NaN, 256), 0);
});

// ---------------------------------------------------------------------------
// Buffer sizing.
// ---------------------------------------------------------------------------

test('an empty stamp still allocates a bindable particle block', () => {
  // THE REGRESSION GUARD for a frame that never renders again. A zero-sized
  // storage buffer fails WebGPU's minimum binding size, and that error rejects
  // every submit for the whole frame -- the canvas holds its last good frame
  // forever, which reads as the app freezing. `freeListSize` documents the same
  // trap.
  //
  // An empty stamp is ordinary: a box dragged over bare canvas holds nothing.
  assert.equal(particleBlockBytes(0, STAMP_PARTICLE_STRIDE), STAMP_PARTICLE_STRIDE);
  assert.ok(particleBlockBytes(0, STAMP_PARTICLE_STRIDE) > 0);
});

test('a particle block is exactly stride-by-count when non-empty', () => {
  assert.equal(particleBlockBytes(10, STAMP_PARTICLE_STRIDE), 10 * STAMP_PARTICLE_STRIDE);
});

// ---------------------------------------------------------------------------
// ROW ALIGNMENT.
//
// `copyTextureToBuffer` requires a 256-byte row multiple. Getting this wrong
// either rejects the copy outright or -- worse -- reads back an image sheared
// diagonally, because every row is offset from the last by a few bytes.
// ---------------------------------------------------------------------------

// The row arithmetic is generic; these use the field's four channels of f32.
const STAMP_TEXEL_CHANNELS = FIELD_CHANNELS;
const BYTES_PER_TEXEL = STAMP_TEXEL_CHANNELS * 4;

test('every aligned row is a multiple of the copy alignment', () => {
  for (const width of [1, 3, 15, 16, 17, 64, 100, 512, 1000, 1280]) {
    const bytes = alignedBytesPerRow(width, BYTES_PER_TEXEL);
    assert.equal(
      bytes % COPY_ROW_ALIGNMENT,
      0,
      `width ${width} produced ${bytes}, not a multiple of ${COPY_ROW_ALIGNMENT}`,
    );
    assert.ok(
      bytes >= width * BYTES_PER_TEXEL,
      `width ${width} must have room for its own row`,
    );
  }
});

test('a width that is already aligned gains no padding', () => {
  // 16 texels * 16 bytes = 256 exactly.
  assert.equal(alignedBytesPerRow(16, BYTES_PER_TEXEL), 256);
  assert.equal(alignedBytesPerRow(32, BYTES_PER_TEXEL), 512);
});

test('a width that is not aligned is padded up, never truncated', () => {
  // 17 texels * 16 = 272, which must round to 512 rather than down to 256.
  assert.equal(alignedBytesPerRow(17, BYTES_PER_TEXEL), 512);
});

test('unpacking drops exactly the padding, leaving a tight layer', () => {
  // A 3x2 layer: 3 * 4 channels = 12 floats per row, padded to 64 floats.
  const width = 3;
  const height = 2;
  const padded = alignedBytesPerRow(width, BYTES_PER_TEXEL);
  const paddedFloatsPerRow = padded / 4;

  const source = new Float32Array(paddedFloatsPerRow * height);
  // Fill the real texels with recognisable values and the padding with a
  // sentinel that must NOT survive.
  source.fill(-999);
  for (let row = 0; row < height; row++) {
    for (let i = 0; i < width * STAMP_TEXEL_CHANNELS; i++) {
      source[row * paddedFloatsPerRow + i] = row * 100 + i;
    }
  }

  const tight = unpackRows(source, width, height, STAMP_TEXEL_CHANNELS, padded);
  assert.equal(tight.length, width * height * STAMP_TEXEL_CHANNELS);
  assert.ok(!tight.includes(-999), 'no padding may survive the unpack');
  assert.equal(tight[0], 0);
  assert.equal(tight[11], 11, 'the last texel of row 0');
  assert.equal(tight[12], 100, 'row 1 starts immediately after row 0');
});

test('pack and unpack are exact inverses at every awkward width', () => {
  // A round trip that does not return the original is the cheapest possible
  // detection of a stride bug, and stride bugs here are invisible by nature.
  for (const [width, height] of [[1, 1], [3, 2], [15, 4], [16, 3], [17, 5], [100, 7]] as const) {
    const padded = alignedBytesPerRow(width, BYTES_PER_TEXEL);
    const tight = new Float32Array(width * height * STAMP_TEXEL_CHANNELS);
    for (let i = 0; i < tight.length; i++) tight[i] = i + 0.5;

    const back = unpackRows(
      packRows(tight, width, height, STAMP_TEXEL_CHANNELS, padded),
      width,
      height,
      STAMP_TEXEL_CHANNELS,
      padded,
    );
    assert.deepEqual(Array.from(back), Array.from(tight), `${width}x${height}`);
  }
});

test('pack and unpack round-trip a two-channel (canvas) layer too', () => {
  for (const [width, height] of [[1, 1], [3, 2], [17, 5], [100, 7]] as const) {
    const padded = alignedBytesPerRow(width, CANVAS_CHANNELS * 2);
    const tight = new Float32Array(width * height * CANVAS_CHANNELS);
    for (let i = 0; i < tight.length; i++) tight[i] = i + 0.5;
    const back = unpackRows(
      packRows(tight, width, height, CANVAS_CHANNELS, padded * 2),
      width,
      height,
      CANVAS_CHANNELS,
      padded * 2,
    );
    assert.deepEqual(Array.from(back), Array.from(tight), `${width}x${height}`);
  }
});

test('unpacking a degenerate layer yields an empty array rather than throwing', () => {
  const padded = alignedBytesPerRow(0, BYTES_PER_TEXEL);
  assert.equal(unpackRows(new Float32Array(0), 0, 0, STAMP_TEXEL_CHANNELS, padded).length, 0);
  assert.equal(unpackRows(new Float32Array(0), 5, 0, STAMP_TEXEL_CHANNELS, padded).length, 0);
});
