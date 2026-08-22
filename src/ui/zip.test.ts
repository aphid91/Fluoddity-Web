/**
 * Tests for the store-only ZIP writer.
 *
 * ## WHY THIS IS TESTED AT ALL, when it is only the fallback path
 *
 * Because nothing else can catch it. A ZIP with a wrong CRC, a bad offset or a
 * miscounted central directory is still a `Blob` of plausible size that
 * downloads without complaint -- the failure appears only when the user tries to
 * open it, in an extractor, on a browser that does not have the directory picker
 * and so is not the one being developed on. This file's first draft had exactly
 * that bug: the CRC polynomial was written `0xed88320`, one digit short of
 * `0xEDB88320`, which produces an archive every extractor rejects.
 *
 * So the assertions are on the BYTES: signatures, counts, offsets and a CRC
 * checked against a known-good value rather than against this file's own output.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'node:zlib';

import { buildZipBytes } from './zip.ts';

/** Little-endian readers, mirroring the writers under test. */
const u16 = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8);
const u32 = (b: Uint8Array, at: number): number =>
  (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;

test('an empty archive is still a valid one', () => {
  const bytes = buildZipBytes([]);
  assert.equal(u32(bytes, 0), END, 'starts with the end-of-central-directory record');
  assert.equal(u16(bytes, 8), 0, 'claims no entries');
});

test('each entry gets a local header and the file bytes', () => {
  const bytes = buildZipBytes([{ filename: 'Krill.json', text: '{"version":8}' }]);
  assert.equal(u32(bytes, 0), LOCAL);
  assert.equal(u16(bytes, 8), 0, 'method 0 -- stored, not deflated');

  const nameLength = u16(bytes, 26);
  assert.equal(nameLength, 'Krill.json'.length);
  const name = new TextDecoder().decode(bytes.subarray(30, 30 + nameLength));
  assert.equal(name, 'Krill.json');

  const stored = new TextDecoder().decode(
    bytes.subarray(30 + nameLength, 30 + nameLength + u32(bytes, 22)),
  );
  assert.equal(stored, '{"version":8}', 'the bytes are stored verbatim');
});

/**
 * THE BUG THIS FILE EXISTS FOR. Checked against `zlib.crc32`, an independent
 * implementation, rather than against a value this module produced -- otherwise
 * the test would happily ratify a wrong polynomial.
 */
test('the CRC matches an independent implementation', () => {
  const text = '{"version":8}';
  const bytes = buildZipBytes([{ filename: 'a.json', text }]);
  assert.equal(u32(bytes, 14), zlib.crc32(text));
});

test('sizes are recorded, uncompressed equal to compressed', () => {
  const text = '{"version":8}';
  const bytes = buildZipBytes([{ filename: 'a.json', text }]);
  const size = new TextEncoder().encode(text).length;
  assert.equal(u32(bytes, 18), size, 'compressed size');
  assert.equal(u32(bytes, 22), size, 'uncompressed size');
});

test('the central directory counts every entry and points at each header', () => {
  const entries = [
    { filename: 'a.json', text: '{"version":8}' },
    { filename: 'b.json', text: '{"version":8,"notes":"x"}' },
    { filename: 'c.json', text: '{}' },
  ];
  const bytes = buildZipBytes(entries);

  // The end record is the last 22 bytes when there is no archive comment.
  const end = bytes.length - 22;
  assert.equal(u32(bytes, end), END);
  assert.equal(u16(bytes, end + 10), entries.length, 'total entry count');

  const centralAt = u32(bytes, end + 16);
  assert.equal(u32(bytes, centralAt), CENTRAL, 'the offset locates the directory');

  // Walk the directory and check each recorded offset lands on a local header
  // whose filename matches. A wrong offset is the other silent corruption.
  let at = centralAt;
  for (const entry of entries) {
    assert.equal(u32(bytes, at), CENTRAL);
    const nameLength = u16(bytes, at + 28);
    const localAt = u32(bytes, at + 42);
    assert.equal(u32(bytes, localAt), LOCAL, `${entry.filename}: offset finds a header`);
    const name = new TextDecoder().decode(
      bytes.subarray(localAt + 30, localAt + 30 + nameLength),
    );
    assert.equal(name, entry.filename);
    at += 46 + nameLength;
  }
  assert.equal(at, end, 'the directory ends exactly where the end record begins');
});

test('timestamps are zeroed, so identical input produces identical bytes', () => {
  const entries = [{ filename: 'a.json', text: '{"version":8}' }];
  assert.deepEqual(buildZipBytes(entries), buildZipBytes(entries));
});
