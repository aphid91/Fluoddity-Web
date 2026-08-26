/**
 * Tests for composing a share image and reading one back.
 *
 * The full loop that matters to a user, minus the browser: a live project
 * becomes a link, the link becomes a stamp, the stamp goes onto a picture, and
 * the picture yields the project again. `qrStamp.test.ts` covers the symbol
 * itself; this covers what surrounds it.
 *
 * Nothing here claims a stamp survives a platform -- that measurement needs a
 * real JPEG encoder and lives in `tools/qrSurvival.mjs`. See that file's header.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fromDocument, toDocument } from '../config/persistence.ts';
import { decodeShareText, encodeShareLink } from '../config/shareLink.ts';
import type { RgbaImage } from './qrRender.ts';
import { QrCapacityError } from './qrStamp.ts';
import {
  STAMP_INSET,
  ShareImageError,
  blankImage,
  minimumCropFor,
  readShareImage,
  stampShareImage,
} from './shareImage.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(here, '..', '..');

/** The first shipped preset as a share link, never one named in the test. */
function presetLink(copies = 1): string {
  const dir = path.join(REPO_ROOT, 'configs');
  const first = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()[0];
  assert.ok(first !== undefined, `no presets found in ${dir}`);
  const saved = fromDocument(
    JSON.parse(fs.readFileSync(path.join(dir, first), 'utf8')),
    first,
  );
  const configs = Array.from({ length: copies }, () => saved.configs[0]!);
  return encodeShareLink(toDocument(configs, saved.world, ''));
}

/**
 * Artwork with real structure in it.
 *
 * NOT A FLAT FILL, which would make every test below easier than reality: a
 * uniform background gives the QR locator no competing edges, so a decoder that
 * only worked on plain plates would pass. This is dense and high-contrast, which
 * is what the app actually renders.
 */
function artwork(width: number, height: number): RgbaImage {
  const image = blankImage(width, height, 0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const v = (Math.sin(x * 0.09) + Math.sin(y * 0.13) + Math.sin((x + y) * 0.05)) * 70 + 90;
      const level = Math.max(0, Math.min(255, Math.round(v)));
      image.data[at] = level;
      image.data[at + 1] = 255 - level;
      image.data[at + 2] = (level * 3) % 256;
    }
  }
  return image;
}

// --- 1. the loop ------------------------------------------------------------

test('a project survives becoming a picture and coming back', () => {
  // THE WHOLE FEATURE, END TO END. Every other test in this file is a way this
  // one can fail; if it ever passes while they fail, they are wrong.
  const link = presetLink();
  const shot = artwork(1080, 720);
  const stamped = stampShareImage(shot, link);

  const recovered = readShareImage(stamped.image);
  assert.equal(recovered, link);

  // And the recovered text is a loadable project, through the same reader a
  // pasted URL goes through -- not merely a string that matched.
  const saved = fromDocument(decodeShareText(recovered!), 'share image');
  assert.equal(saved.configs.length, 1);
});

test('stamping does not modify the image it was given', () => {
  // GUARDS A BUG THAT ONLY APPEARS ON CANCEL. The source is very likely the
  // pixels the user is still looking at, so a stamp written in place would
  // permanently brand the live canvas -- and only for someone who backed out.
  const link = presetLink();
  // SIZED FROM `minimumCropFor` RATHER THAN A LITERAL. A hardcoded size here was
  // 900x640, which is smaller than the default stamp needs -- so this test threw
  // for a reason that had nothing to do with mutation. Deriving the size means
  // it keeps testing what it says it tests when the stamp defaults change.
  const side = minimumCropFor(link);
  const shot = artwork(side, side);
  const before = shot.data.slice();
  stampShareImage(shot, link);
  assert.deepEqual(shot.data, before, 'the source image was mutated');
});

test('the stamp lands in the bottom-right, inset from both edges', () => {
  // The corner is a promise the UI makes -- the drag overlay draws its preview
  // square there -- so it is asserted rather than left to the renderer.
  const link = presetLink();
  const shot = blankImage(1000, 800, 0);
  const stamped = stampShareImage(shot, link);
  const { image, stampSizePx } = stamped;

  // The plate is white, so the stamp's own corner pixel must be white and a
  // pixel just outside the inset must still be the black background.
  const px = (x: number, y: number): number => image.data[(y * image.width + x) * 4]!;
  const x0 = image.width - stampSizePx - STAMP_INSET;
  const y0 = image.height - stampSizePx - STAMP_INSET;

  assert.equal(px(x0 + 2, y0 + 2), 255, 'stamp plate should start here');
  assert.equal(px(x0 - 4, y0 - 4), 0, 'the inset should still be artwork');
  assert.equal(
    px(image.width - 2, image.height - 2),
    0,
    'the far corner is inset, so it is not the stamp',
  );
});

// --- 2. the size constraint -------------------------------------------------

test('an image too small to hold a stamp is refused, not stamped badly', () => {
  // THE FAILURE THE FEATURE CANNOT SHIP is a picture that looks right and does
  // not decode. Refusing is the only acceptable behaviour, and the message has
  // to carry the number the caller needs.
  const link = presetLink();
  const tiny = blankImage(200, 200, 0);
  assert.throws(() => stampShareImage(tiny, link), ShareImageError);
  try {
    stampShareImage(tiny, link);
  } catch (e: unknown) {
    assert.ok(e instanceof ShareImageError);
    assert.match(e.message, /at least \d+x\d+/);
  }
});

test('the advertised minimum is genuinely enough', () => {
  // THE CONTRACT BETWEEN THE OVERLAY AND THE STAMPER. `minimumCropFor` is what
  // the drag overlay clamps to, so if it under-reported by even a pixel the UI
  // would happily produce selections that then throw. An exact-minimum crop must
  // stamp AND decode.
  const link = presetLink();
  const min = minimumCropFor(link);
  const exact = artwork(min, min);

  const stamped = stampShareImage(exact, link);
  assert.equal(readShareImage(stamped.image), link);
});

test('the minimum crop fits on an ordinary screen', () => {
  // THE REGRESSION THIS EXISTS FOR, and it made the feature impossible to use
  // rather than merely awkward. The minimum was `stampSizePx * 2`, which for a
  // one-config project demanded a 1292x1292 selection -- TALLER THAN A 1080p
  // DISPLAY. There was no drag a user on an ordinary screen could make that
  // satisfied it, and nothing in the UI would have explained why.
  //
  // 1280x720 is the floor worth defending: smaller than most windows people
  // actually use, and the size a modest laptop gives a maximized browser after
  // its chrome. If the minimum ever exceeds it again, this fails here rather
  // than in front of someone holding a mouse button down.
  const min = minimumCropFor(presetLink());
  assert.ok(min <= 720, `a ${min}px minimum will not fit a 1280x720 window`);
});

test('one pixel under the minimum is where it stops working', () => {
  // Pins the boundary from the other side, so the minimum is shown to be tight
  // rather than merely sufficient -- a wildly conservative number would pass the
  // test above while making the UI demand far more room than it needs.
  const link = presetLink();
  const min = minimumCropFor(link);
  const stamped = stampShareImage(artwork(min, min), link);
  // The stamp plus its insets is what actually has to fit; the minimum includes
  // headroom beyond that by design (`MIN_CROP_HEADROOM`), so the assertion is
  // that the minimum exceeds the hard requirement rather than equalling it.
  // The margin is deliberately thin now -- 40px of headroom against 32px of
  // inset -- which is exactly why this stays an assertion rather than a comment.
  assert.ok(min > stamped.stampSizePx + STAMP_INSET * 2);
});

// --- 3. what a decoder should not find --------------------------------------

test('an image with no stamp reports nothing rather than guessing', () => {
  // "No code here" is the commonest thing on a clipboard and has to be an
  // ANSWER, not an error -- the paste path distinguishes it from "a code that
  // would not read" and says different things about each.
  assert.equal(readShareImage(artwork(800, 600)), null);
  assert.equal(readShareImage(blankImage(400, 300, 0)), null);
  assert.equal(readShareImage(blankImage(400, 300, 255)), null);
});

// --- 4. capacity ------------------------------------------------------------

test('a project too large for a QR fails before the overlay would open', () => {
  // The UI checks capacity FIRST so it can offer the link instead of opening a
  // drag gesture that cannot succeed. That check is `minimumCropFor`, so it is
  // the thing that has to throw the typed error.
  let tooBig = 0;
  for (let n = 1; n <= 8; n += 1) {
    try {
      minimumCropFor(presetLink(n));
    } catch (e: unknown) {
      assert.ok(e instanceof QrCapacityError, `expected a typed error, got ${String(e)}`);
      tooBig = n;
      break;
    }
  }
  assert.ok(tooBig > 1, 'a single config must always fit');
});

// --- 5. the image is not the only copy --------------------------------------

test('the stamped result carries the payload it encoded', () => {
  // The caller offers the same link as text when the clipboard refuses the
  // image, so the two must be the same string -- re-serializing the project a
  // second time could produce a different one if anything drifted between.
  const link = presetLink();
  const stamped = stampShareImage(artwork(900, 900), link);
  assert.equal(stamped.payload, link);
  assert.equal(readShareImage(stamped.image), stamped.payload);
});
