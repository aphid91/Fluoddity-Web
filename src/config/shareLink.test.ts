/**
 * Share links, NCA edition: the document travels as lz-string JSON (`#c=`).
 *
 * The transport only promises to deliver the document intact; `fromDocument`
 * decides what it means, so the reader's refusals are tested through it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  ShareLinkError,
  buildShareUrl,
  decodeShareLink,
  decodeShareText,
  encodeShareLink,
} from './shareLink.ts';
import { ConfigFormatError, fromDocument, toDocument } from './persistence.ts';
import { makeNcaConfig, makeNcaWorld } from '../nca/ncaConfig.ts';
import { initWeights, toStored } from '../nca/weights.ts';

const ARCH = { channels: 4, hidden: 4, perception: 0, learnedKernels: 1, laplacian: false };

function validDocument(): unknown {
  return toDocument(
    [makeNcaConfig({ ...ARCH, weights: toStored(initWeights(ARCH, 1)), cohorts: 4 })],
    makeNcaWorld({ displayGain: 2 }),
  );
}

test('a document survives encode/decode exactly, and is still loadable', () => {
  const doc = validDocument();
  const back = decodeShareLink(encodeShareLink(doc));
  assert.deepEqual(back, JSON.parse(JSON.stringify(doc)));
  const saved = fromDocument(back);
  assert.equal(saved.configs[0]!.weights!.length, 72);
});

test('the leading # is optional on the way in', () => {
  const link = encodeShareLink(validDocument());
  assert.deepEqual(decodeShareLink(link.slice(1)), decodeShareLink(link));
});

test('every config survives, not just the first', () => {
  const doc = toDocument([makeNcaConfig({ dt: 0.1 }), makeNcaConfig({ dt: 0.2 })], makeNcaWorld());
  const saved = fromDocument(decodeShareLink(encodeShareLink(doc)));
  assert.deepEqual(saved.configs.map((c) => c.dt), [0.1, 0.2]);
});

test('a whole URL round-trips and keeps origin, path and query', () => {
  const loc = { origin: 'https://x.example', pathname: '/app/', search: '?nosplash' };
  const url = buildShareUrl(loc, validDocument());
  assert.ok(url.startsWith('https://x.example/app/?nosplash#c='));
  const hash = new URL(url).hash;
  assert.deepEqual(decodeShareLink(hash), JSON.parse(JSON.stringify(validDocument())));
});

test('decodeShareText accepts a bare fragment, a full URL, and surrounding whitespace', () => {
  const link = encodeShareLink(validDocument());
  const expected = decodeShareLink(link);
  assert.deepEqual(decodeShareText(link), expected);
  assert.deepEqual(decodeShareText(`  https://a.b/c${link}\n`), expected);
  assert.equal(decodeShareText('just some text'), null);
  assert.equal(decodeShareText(''), null);
});

test('a fragment without our key is not ours, and is not an error', () => {
  assert.equal(decodeShareLink('#section-2'), null);
});

test('a truncated or empty payload is reported, not silently ignored', () => {
  const link = encodeShareLink(validDocument());
  assert.throws(() => decodeShareLink(link.slice(0, link.length / 2)), ShareLinkError);
  assert.throws(() => decodeShareLink('#c='), ShareLinkError);
});

test('a particle-era document decodes here and is rejected by the reader', () => {
  const legacy = { version: 9, world: {}, configs: [{ rule: [] }] };
  const doc = decodeShareLink(encodeShareLink(legacy));
  assert.throws(() => fromDocument(doc, 'shared link'), /particle-era/);
});

test('a document with no configs decodes here and is rejected by the reader', () => {
  const doc = decodeShareLink(encodeShareLink({ format: 'nca', version: 1, configs: [] }));
  assert.throws(() => fromDocument(doc, 'shared link'), ConfigFormatError);
});

test('every shipped preset round-trips', () => {
  const dir = path.join(import.meta.dirname, '..', '..', 'configs');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const saved = fromDocument(raw, f);
    const doc = toDocument(saved.configs, saved.world, saved.notes);
    assert.deepEqual(fromDocument(decodeShareLink(encodeShareLink(doc))), saved, f);
  }
});
