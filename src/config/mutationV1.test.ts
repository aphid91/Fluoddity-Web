/**
 * Tests for the host mirror of the v8 `mutate_rule`.
 *
 * The fixture's expected rules are GPU output: the pre-v9 shader, run through
 * `tools/deriveRules.mjs`, which this mirror matched bit-for-bit across the
 * whole shipped corpus before the migration was committed. So a failure here is
 * the mirror drifting from what the shader did, not a transcription of itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mutateRuleV1, ruleSeedV1 } from './mutationV1.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'mutationV1.fixture.json'), 'utf8')) as {
  cases: {
    name: string;
    mutationScale: number;
    mutationSeed: number;
    rule: number[];
    expected: number[];
  }[];
};

test('reproduces the v8 shader bit-for-bit on the fixture presets', () => {
  for (const c of fixture.cases) {
    const got = mutateRuleV1(c.rule, c.mutationScale, ruleSeedV1(c.mutationSeed, 0));
    assert.deepEqual(got, c.expected, c.name);
  }
});

test('amount 0 is the exact identity', () => {
  // The property the migration leans on: a baked config has scale 0, so the
  // shader's own mutation must leave its rule untouched.
  const c = fixture.cases[0]!;
  const got = mutateRuleV1(c.rule, 0, ruleSeedV1(c.mutationSeed, 0));
  assert.deepEqual(got, c.rule.map(Math.fround));
});

test('the seed is chaotic: a tiny change in it is a different rule', () => {
  // Pins that the mirror consumes the seed through the hash's BITS, which is
  // the property that makes an inexact mirror dangerous -- and this one exact.
  // Not ONE f32 step: the seed is first added to `hash(...)`, a larger value,
  // and that add can round a single step away. 2^-16 survives it.
  const c = fixture.cases[0]!;
  const next = ruleSeedV1(c.mutationSeed + 2 ** -16, 0);
  assert.notDeepEqual(mutateRuleV1(c.rule, c.mutationScale, next), c.expected);
});

test('ruleSeedV1 adds the floor of the cohort to the f32 seed', () => {
  assert.equal(ruleSeedV1(0.25, 0.9), Math.fround(0.25));
  assert.equal(ruleSeedV1(0.25, 3.5), Math.fround(Math.fround(0.25) + 3));
});

test('a rule of the wrong length throws', () => {
  assert.throws(() => mutateRuleV1([1, 2, 3], 0.1, 0));
});
