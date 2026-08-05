/**
 * Tests for the share link.
 *
 * ## THE TWO TRAPS ARE THE POINT
 *
 * `shareLink.ts`'s header documents two failures that were found by experiment
 * and that both fail SILENTLY. They get a case each, and each case names what
 * breaks without it:
 *
 *   - `URLSearchParams` decodes `+` as a space, and the compressor's alphabet
 *     contains `+`. A payload routed through it comes back subtly wrong -- not
 *     rejected, WRONG -- and the app parses its query string with exactly that
 *     class, so the wrong instinct is close at hand. `a whole URL round-trips`
 *     is the guard, and it is deliberately written against a payload known to
 *     contain a `+` rather than against whatever the fixture happens to produce.
 *
 *   - A truncated payload decompresses to `''` rather than raising, so a bare
 *     `try`/`catch` would let the commonest real-world failure -- a link cut
 *     short by a chat client -- through as a silent no-op.
 *
 * ## WHAT THIS FILE DOES NOT TEST
 *
 * What a document MEANS. `fromDocument` is the only interpreter of these bytes
 * and stays that way, so the version case below asserts the LAYERING: a v9
 * payload decodes here without complaint and is rejected by `fromDocument`. A
 * version check in this file would be a second reader, which is the thing
 * `persistence.ts` exists to prevent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BC, IC } from '../particleSystem/config.ts';
import { ConfigFormatError, fromDocument } from './persistence.ts';
import {
  SHARE_LINK_WARN_LENGTH,
  ShareLinkError,
  buildShareUrl,
  decodeShareLink,
  encodeShareLink,
} from './shareLink.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/config -> src -> repo root, which is where `configs/` lives.
const REPO_ROOT = path.join(here, '..', '..');

/** A minimal valid v8 document. Mirrors `persistence.test.ts:46`. */
function validDocument(): Record<string, unknown> {
  return {
    version: 8,
    world: {
      trail_persistence: 0.9,
      trail_diffusion: 1.0,
      boundary_conditions: BC.WRAP,
    },
    configs: [oneConfig(0.01)],
  };
}

/** One config block, its rule lane scaled so callers can tell copies apart. */
function oneConfig(step: number): Record<string, unknown> {
  return {
    rule: Array.from({ length: 80 }, (_, i) => i * step),
    sensor: { gain: 0.3, angle: 0.2, distance: 2.4, mutation_scale: 0.1 },
    force: { global_mult: 0.15, drag: 0.5, strafe: 0.38, axial: 0.37 },
    misc: { lateral: -0.7, hazard_rate: 0.0, cohorts: 1, mutation_seed: 0.82 },
    force2: {
      gravity_force: 0.0,
      gravity_strafe: 0.0,
      initial_conditions: IC.GRID,
      cohort_fences: 0.11,
    },
    misc2: {
      color_sensitivity: 0.5,
      color_by_cohort: false,
      sensor_angle_jitter: 0.0,
      sensor_distance_jitter: 0.16,
    },
    misc3: { radial_gravity: false },
  };
}

const LOC = { origin: 'https://example.github.io', pathname: '/Fluoddity2/', search: '' };

// --- 1. the round trip ------------------------------------------------------

test('a document survives encode/decode byte for byte', () => {
  const doc = validDocument();
  const back = decodeShareLink(encodeShareLink(doc));
  // Byte-exact, not merely equivalent: the whole premise is that a link and a
  // save are the same bytes, so "close enough" is not the claim being made.
  assert.equal(JSON.stringify(back), JSON.stringify(doc));
});

test('the decoded document is still a loadable config', () => {
  // The round trip is only worth anything if what comes out the far end goes
  // through the real reader, which is what actually runs on a shared link.
  const saved = fromDocument(decodeShareLink(encodeShareLink(validDocument())));
  assert.equal(saved.configs.length, 1);
  assert.equal(saved.world.boundaryConditions, BC.WRAP);
  assert.equal(saved.configs[0]!.mutationSeed, 0.82);
});

test('the leading # is optional on the way in', () => {
  const hash = encodeShareLink(validDocument());
  assert.ok(hash.startsWith('#'), 'encode should emit the # so callers concatenate');
  assert.deepEqual(decodeShareLink(hash), decodeShareLink(hash.slice(1)));
});

test('every config survives, not just the first', () => {
  // GUARDS THE OPTIMIZATION NOBODY SHOULD MAKE. `toDocument`'s header records
  // that saving only the selected slot was already removed once on the desktop
  // because it silently dropped the others; a share link that carried config 0
  // alone would reintroduce exactly that, and a single-config fixture would
  // never notice.
  const doc = { ...validDocument(), configs: [0.01, 0.02, 0.03, 0.04].map(oneConfig) };
  const saved = fromDocument(decodeShareLink(encodeShareLink(doc)));
  assert.equal(saved.configs.length, 4);
  // Distinguishable, so a decoder that duplicated one config four times fails.
  const seconds = saved.configs.map((c) => c.rule[1]);
  assert.deepEqual(seconds, [0.01, 0.02, 0.03, 0.04]);
});

// --- 2. trap 1: the URL must not mangle the payload -------------------------

test('a whole URL round-trips, including a payload containing "+"', () => {
  const doc = validDocument();
  const url = buildShareUrl(LOC, doc);
  const hash = url.slice(url.indexOf('#'));

  // THE REGRESSION THIS EXISTS FOR: the compressor's alphabet includes `+`, and
  // `URLSearchParams` turns `+` into a space. Testing encode/decode in isolation
  // would pass even if a caller routed the fragment through that class, so the
  // assertion is made against a payload known to contain the character.
  assert.ok(hash.includes('+'), 'fixture must exercise the "+" case to be worth anything');
  assert.equal(JSON.stringify(decodeShareLink(hash)), JSON.stringify(doc));

  // And the demonstration, so the reason is on the record rather than in a
  // comment: this is what the tempting shortcut actually does to the payload.
  const viaSearchParams = new URLSearchParams(hash.slice(1)).get('c');
  assert.notEqual(viaSearchParams, hash.slice(3), 'URLSearchParams corrupts the payload');
});

test('the URL keeps the origin, path and query', () => {
  const url = buildShareUrl({ ...LOC, search: '?debug' }, validDocument());
  assert.ok(url.startsWith('https://example.github.io/Fluoddity2/?debug#c='));
  // Dropping the query would hand the recipient a different app than the one
  // the sharer was looking at.
  assert.ok(url.includes('?debug#'));
});

test('an empty query produces no stray "?"', () => {
  const url = buildShareUrl(LOC, validDocument());
  assert.ok(!url.includes('?'), url.slice(0, 60));
});

// --- 3. fragments that are not ours -----------------------------------------

test('a fragment without our key is not ours, and is not an error', () => {
  // Every one of these is a real thing a browser or a copied link can produce.
  // Reporting any of them as a damaged share link would blame us for someone
  // else's anchor.
  for (const hash of ['', '#', '#about', '#section-2', '#c', '#config=x', '#cc=x']) {
    assert.equal(decodeShareLink(hash), null, `expected null for ${JSON.stringify(hash)}`);
  }
});

// --- 4. trap 2: ours, but broken --------------------------------------------

test('a truncated payload is reported, not silently ignored', () => {
  // THE COMMONEST REAL FAILURE, and the one with no natural exception behind
  // it: decompressing half a payload returns `''` rather than raising, so
  // without the explicit empty check this link would load nothing and say
  // nothing.
  const payload = encodeShareLink(validDocument()).slice(3);
  const truncated = `#c=${payload.slice(0, Math.floor(payload.length / 2))}`;
  assert.throws(() => decodeShareLink(truncated), ShareLinkError);
});

test('our key with an empty or unreadable payload throws', () => {
  assert.throws(() => decodeShareLink('#c='), ShareLinkError);
  assert.throws(() => decodeShareLink('#c=!!!not-a-payload!!!'), ShareLinkError);
});

test('a payload that decompresses to JSON that is not a document still decodes', () => {
  // `42` is valid JSON, so it comes back from this layer intact -- and is
  // refused by the reader. The split of responsibility is the assertion.
  const hash = encodeShareLink(42);
  assert.equal(decodeShareLink(hash), 42);
  assert.throws(() => fromDocument(decodeShareLink(hash)), ConfigFormatError);
});

// --- 5. the layering --------------------------------------------------------

test('a future version decodes here and is rejected by the reader', () => {
  // NOT A VERSION CHECK IN THIS FILE. Transport does not get an opinion about
  // meaning; `fromDocument` is the one interpreter and gives the message that
  // actually says what is wrong.
  const hash = encodeShareLink({ ...validDocument(), version: 9 });
  const doc = decodeShareLink(hash);
  assert.equal((doc as Record<string, unknown>)['version'], 9);
  assert.throws(() => fromDocument(doc, 'shared link'), {
    name: 'ConfigFormatError',
    message: /shared link.*version 9/,
  });
});

// --- 6. the shipped presets -------------------------------------------------

test('a real shipped preset round-trips and stays comfortably short', () => {
  const file = path.join(REPO_ROOT, 'configs', 'Angles2.json');
  const doc: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  const hash = encodeShareLink(doc);

  assert.equal(JSON.stringify(decodeShareLink(hash)), JSON.stringify(doc));

  // PINS THE MEASUREMENT the warning threshold was chosen against (~1800
  // characters for a one-config project). If the format grows enough to put a
  // typical preset near the threshold, that is a decision to make deliberately
  // rather than to discover from a user whose link got cut in half.
  assert.ok(
    hash.length < SHARE_LINK_WARN_LENGTH / 2,
    `a one-config preset encoded to ${hash.length} chars; the threshold is ${SHARE_LINK_WARN_LENGTH}`,
  );
});
