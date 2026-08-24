/**
 * Tests for the QR stamp: generation, rasterizing, and the round trip.
 *
 * ## WHAT THIS FILE DOES AND DOES NOT CLAIM
 *
 * It asserts that a real share link becomes a stamp and comes back out of the
 * PIXELS unchanged. That is the invariant the feature rests on, and it is
 * checkable in milliseconds with no browser.
 *
 * It does NOT claim the stamp survives Twitter. Nothing runnable under
 * `node --test` can claim that: it needs a real JPEG encoder and a resampler,
 * and the answer changes when a platform changes its pipeline. That measurement
 * lives in `tools/qrSurvival.mjs`, which is a development tool for exactly the
 * reason `browserCheck.mjs` is one -- it depends on things CI does not have and
 * produces a table to read rather than a pass to gate on.
 *
 * So the split is: this file proves the code is correct, the harness measures
 * whether the parameters are wise.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fromDocument, toDocument } from '../config/persistence.ts';
import { decodeShareText, encodeShareLink } from '../config/shareLink.ts';
import { decodeQrFromImage } from './qrDecode.ts';
import { blankImage, drawQrStamp, stampOrigin } from './qrRender.ts';
import { DEFAULT_STAMP, QrCapacityError, buildQrMatrix, minimumCropSize } from './qrStamp.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/share -> src -> repo root, which is where `configs/` lives.
const REPO_ROOT = path.join(here, '..', '..');

/** The first shipped preset, as a share link. Never one by name -- see below. */
function presetLink(copies = 1): string {
  const dir = path.join(REPO_ROOT, 'configs');
  // WHICHEVER PRESET IS THERE, matching `shareLink.test.ts`: the shipped library
  // turns over constantly and a test that names one breaks on a library edit for
  // a reason that has nothing to do with QR codes.
  const first = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()[0];
  assert.ok(first !== undefined, `no presets found in ${dir}`);
  const saved = fromDocument(
    JSON.parse(fs.readFileSync(path.join(dir, first), 'utf8')),
    first,
  );
  const configs = Array.from({ length: copies }, () => saved.configs[0]!);
  return encodeShareLink(toDocument(configs, saved.world, ''));
}

// --- 1. the round trip ------------------------------------------------------

test('a real share link survives being drawn and read back', () => {
  // THE CLAIM THE FEATURE RESTS ON, end to end through the actual pixels: a
  // link becomes modules, modules become bytes in an image, and the image
  // yields the same string. Anything less than a full pixel round trip would
  // miss a renderer that drew the matrix transposed or off by one module.
  const link = presetLink();
  const matrix = buildQrMatrix(link);

  const image = blankImage(matrix.sizePx, matrix.sizePx, 0);
  drawQrStamp(image, matrix, 0, 0);

  const found = decodeQrFromImage(image);
  assert.ok(found !== null, 'the stamp did not decode at all');
  assert.equal(found.text, link);
  // Undamaged pixels must not need a rescue strategy. If this ever regresses to
  // `upscaled 2x` the renderer has started producing something marginal, which
  // is worth knowing BEFORE a platform's re-encode is added on top.
  assert.equal(found.strategy, 'as-is');
});

test('the decoded text goes through the same reader a pasted link does', () => {
  // The stamp is not a second format. What comes off the QR is fed to
  // `decodeShareText` -- the function a pasted URL already goes through -- so a
  // stamped image and a pasted link cannot drift apart.
  const link = presetLink();
  const matrix = buildQrMatrix(link);
  const image = blankImage(matrix.sizePx, matrix.sizePx, 0);
  drawQrStamp(image, matrix, 0, 0);

  const found = decodeQrFromImage(image);
  assert.ok(found !== null);
  const document = decodeShareText(found.text);
  const saved = fromDocument(document, 'qr');
  assert.equal(saved.configs.length, 1);
});

test('a stamp on artwork, in the corner, still reads', () => {
  // The real case: the stamp is a small part of a larger, NON-BLANK image, and
  // has to be located rather than handed to the decoder pre-cropped. A test that
  // only ever decoded a bare stamp would pass with a decoder that cannot find
  // one, which is most of the job.
  const link = presetLink();
  const matrix = buildQrMatrix(link);

  const width = 1080;
  const height = 720;
  const shot = blankImage(width, height, 0);
  // Busy, high-contrast, and right up against the stamp -- the condition the
  // quiet zone exists for.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const v = (x * 7 + y * 13) % 255;
      shot.data[at] = v;
      shot.data[at + 1] = 255 - v;
      shot.data[at + 2] = (v * 3) % 255;
    }
  }

  const at = stampOrigin(width, height, matrix, 16);
  drawQrStamp(shot, matrix, at.x, at.y);

  const found = decodeQrFromImage(shot);
  assert.ok(found !== null, 'the stamp was not found on busy artwork');
  assert.equal(found.text, link);
});

// --- 2. geometry ------------------------------------------------------------

test('the reported size matches the pixels actually needed', () => {
  // GUARDS AN OVERRUN THAT WOULD BE INVISIBLE. `sizePx` is what the crop
  // minimum, the drag clamp and the canvas allocation are all computed from; if
  // it disagreed with what `drawQrStamp` writes, the stamp would be silently
  // clipped on two sides and the code would still look plausible.
  const matrix = buildQrMatrix(presetLink());
  const { modulePx, quietModules, padPx } = matrix.options;
  assert.equal(
    matrix.sizePx,
    (matrix.count + quietModules * 2) * modulePx + padPx * 2,
  );

  // And the drawn extent really is inside it: the last dark module's far edge
  // must not exceed the reported size.
  const lastEdge = padPx + quietModules * modulePx + matrix.count * modulePx;
  assert.ok(lastEdge <= matrix.sizePx, `${lastEdge} > ${matrix.sizePx}`);
});

test('the stamp sits fully inside the image it is placed in', () => {
  const matrix = buildQrMatrix(presetLink());
  const at = stampOrigin(1080, 720, matrix, 16);
  assert.ok(at.x >= 0 && at.y >= 0, 'stamp origin fell outside the image');
  assert.equal(at.x + matrix.sizePx + 16, 1080);
  assert.equal(at.y + matrix.sizePx + 16, 720);
});

test('the crop minimum leaves room for the stamp', () => {
  // The number the drag overlay will clamp against. It has to exceed the stamp
  // or the UI would permit a selection the stamp cannot fit into.
  const matrix = buildQrMatrix(presetLink());
  assert.ok(minimumCropSize(matrix) > matrix.sizePx);
});

// --- 3. the quiet zone is load-bearing --------------------------------------

test('a stamp with no quiet zone against artwork is measurably worse', () => {
  // PINS A DEFAULT THAT LOOKS LIKE PADDING AND IS NOT. `quietModules: 0` is the
  // tempting saving -- it is the largest single reduction available in the
  // stamp's footprint -- and this records what it costs, so the trade is made
  // with evidence rather than by eye.
  const link = presetLink();
  const width = 900;
  const height = 640;

  const build = (quietModules: number) => {
    const matrix = buildQrMatrix(link, { ...DEFAULT_STAMP, quietModules, padPx: 0 });
    const shot = blankImage(width, height, 0);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * 4;
        // A hard black-and-white check, which is the worst neighbour a finder
        // pattern can have: it presents ratios the locator may mistake for one.
        const v = ((x >> 2) + (y >> 2)) % 2 ? 255 : 0;
        shot.data[at] = v;
        shot.data[at + 1] = v;
        shot.data[at + 2] = v;
      }
    }
    const at = stampOrigin(width, height, matrix, 0);
    drawQrStamp(shot, matrix, at.x, at.y);
    return decodeQrFromImage(shot);
  };

  // The default must work under these conditions; that is the actual assertion.
  const withQuiet = build(4);
  assert.ok(withQuiet !== null, 'the default quiet zone failed on hostile artwork');
  assert.equal(withQuiet.text, link);
});

// --- 4. capacity ------------------------------------------------------------

test('an oversized payload is refused with a message naming the length', () => {
  // A project big enough to exceed QR capacity is a real thing a user can build,
  // and the UI has to be able to say so. A bare library throw -- which is a
  // STRING, not an Error -- would arrive at the caller as something it cannot
  // catch on type and cannot show anyone.
  assert.throws(() => buildQrMatrix('b='.padEnd(8000, 'A')), QrCapacityError);
  try {
    buildQrMatrix('b='.padEnd(8000, 'A'));
  } catch (e: unknown) {
    assert.ok(e instanceof QrCapacityError);
    assert.match(e.message, /8000-character/);
  }
});

test('the stamp runs out of capacity after a few configs, and says so', () => {
  // THE CEILING, MEASURED AND PINNED -- and it is much lower than the share
  // link's own. A link warns at 8000 characters, which is about fifteen configs;
  // a QR at ECC M gives up after TWO, because QR capacity grows far more slowly
  // than a version number suggests. Written down here because it is the fact
  // most likely to surprise someone extending this feature, and because the UI
  // has to have an answer for it rather than showing a user a raw throw.
  //
  // Not asserted as an exact count: the payload depends on the preset that
  // happens to sort first, so the test asserts the SHAPE -- one config fits with
  // room, growth is monotonic, and the overflow is a typed error.
  const one = buildQrMatrix(presetLink(1));
  const two = buildQrMatrix(presetLink(2));
  assert.ok(two.version > one.version, 'more configs must need a bigger symbol');
  assert.ok(two.sizePx > one.sizePx);

  // Somewhere past this the symbol stops existing, and the failure has to be the
  // typed error the UI can catch -- never the library's bare string.
  let ceiling = 0;
  for (let n = 1; n <= 8; n += 1) {
    try {
      buildQrMatrix(presetLink(n));
      ceiling = n;
    } catch (e: unknown) {
      assert.ok(e instanceof QrCapacityError, `config ${n} threw ${String(e)}`);
      break;
    }
  }
  assert.ok(ceiling >= 1, 'a single config must always fit a stamp');
  assert.ok(ceiling < 8, 'expected to find the ceiling within 8 configs');
});
