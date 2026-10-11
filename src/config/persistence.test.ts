/**
 * The NCA save format: round trips, enum names, weight encodings, tolerant
 * defaults, and the refusals.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import {
  ConfigFormatError,
  INLINE_WEIGHTS_MAX,
  decodeWeights,
  encodeWeights,
  fromDocument,
  sanitizeName,
  toDocument,
} from './persistence.ts';
import {
  ACTIVATION,
  DISPLAY,
  IC,
  NCA_CONFIG_DEFAULTS,
  PERCEPTION,
  makeNcaConfig,
  makeNcaWorld,
} from '../nca/ncaConfig.ts';
import { initWeights, toStored } from '../nca/weights.ts';

const TINY = { channels: 4, hidden: 4, perception: PERCEPTION.FIXED, learnedKernels: 1, laplacian: false };
const BIG = { channels: 8, hidden: 32, perception: PERCEPTION.FIXED, learnedKernels: 1, laplacian: false };

test('a config round-trips exactly, inline and base64 weights alike', () => {
  for (const arch of [TINY, BIG]) {
    const config = makeNcaConfig({
      ...arch,
      weights: toStored(initWeights(arch, 3)),
      activation: ACTIVATION.SIN,
      initialConditions: IC.SPARSE,
      cohortFences: false,
      aliveMask: true,
    });
    const world = makeNcaWorld({ displayMode: DISPLAY.RGBA, displayChannel: 2 });
    const doc = toDocument([config], world, 'hello') as Record<string, unknown>;
    const back = fromDocument(JSON.parse(JSON.stringify(doc)));
    assert.deepEqual(back.configs[0], config);
    assert.deepEqual(back.world, world);
    assert.equal(back.notes, 'hello');
    const c0 = (doc['configs'] as Record<string, unknown>[])[0]!;
    assert.equal('weights_b64' in c0, config.weights!.length > INLINE_WEIGHTS_MAX);
  }
});

test('generated weights round-trip as null', () => {
  const back = fromDocument(toDocument([makeNcaConfig()], makeNcaWorld()));
  assert.equal(back.configs[0]!.weights, null);
});

test('enums are written as names and read as names or indices', () => {
  const doc = toDocument([makeNcaConfig({ activation: ACTIVATION.TANH })], makeNcaWorld()) as {
    configs: { activation: string }[];
  };
  assert.equal(doc.configs[0]!.activation, 'tanh');
  const byIndex = fromDocument({ format: 'nca', version: 1, configs: [{ activation: 2 }] });
  assert.equal(byIndex.configs[0]!.activation, ACTIVATION.SIN);
});

test('missing fields fall back to the defaults', () => {
  const back = fromDocument({ format: 'nca', version: 1, configs: [{}] });
  assert.deepEqual(back.configs[0], NCA_CONFIG_DEFAULTS);
});

test('weights that do not fit the architecture load as generated', () => {
  const back = fromDocument({
    format: 'nca',
    version: 1,
    configs: [{ architecture: { channels: 4, hidden: 4 }, weights: [1, 2, 3] }],
  });
  assert.equal(back.configs[0]!.weights, null);
});

test('refusals: particle-era files, other formats, versions, empty configs', () => {
  assert.throws(() => fromDocument({ version: 9, configs: [{}], world: {} }), /particle-era/);
  assert.throws(() => fromDocument({ hello: 1 }), ConfigFormatError);
  assert.throws(() => fromDocument({ format: 'nca', version: 2, configs: [{}] }), /version/);
  assert.throws(() => fromDocument({ format: 'nca', version: 1, configs: [] }), /no configs/);
  assert.throws(
    () => fromDocument({ format: 'nca', version: 1, configs: [{ weights: ['x'] }] }),
    /finite numbers/,
  );
});

test('base64 weights are exact f32', () => {
  const w = [0.1, -2.5, 1e-7, 3.4e38];
  assert.deepEqual(decodeWeights(encodeWeights(w)), w.map(Math.fround));
});

test('every shipped preset loads', () => {
  const dir = path.join(import.meta.dirname, '..', '..', 'configs');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0);
  for (const f of files) fromDocument(JSON.parse(readFileSync(path.join(dir, f), 'utf8')), f);
});

test('sanitizeName removes forbidden characters and trailing dots', () => {
  assert.equal(sanitizeName(' a/b:c. '), 'abc');
  assert.equal(sanitizeName('...'), '');
});
