/**
 * The config buffer's slot layout. See configSlots.ts.
 *
 * The shader indexes slots blind -- a studio particle's slot is its cohort, a
 * sand particle's is its config_index -- so a layout that drifts from what the
 * shader assumes gives particles the wrong rule, which looks like legitimate
 * behaviour rather than a bug.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { SimulationConfig } from './config.ts';
import { MAX_COHORT_SLOTS, cohortSlotCount, configSlots } from './configSlots.ts';

// Only `cohorts` is read, so a partial config is enough.
const withCohorts = (cohorts: number, tag = ''): SimulationConfig =>
  ({ cohorts, tag }) as unknown as SimulationConfig;

test('the studio gets one slot per cohort, all of them the parent', () => {
  const parent = withCohorts(5);
  const slots = configSlots([parent], true);
  assert.equal(slots.length, 5);
  for (const slot of slots) assert.equal(slot, parent);
});

test('the studio expands configs[0] and ignores the rest', () => {
  // configs[0] is what the studio has always simulated.
  const slots = configSlots([withCohorts(3, 'first'), withCohorts(9, 'second')], true);
  assert.equal(slots.length, 3);
  assert.ok(slots.every((s) => (s as unknown as { tag: string }).tag === 'first'));
});

test('sand gets one slot per config, each forced to one cohort', () => {
  const single = withCohorts(1);
  const slots = configSlots([withCohorts(8), single, withCohorts(3)], false);
  assert.deepEqual(
    slots.map((s) => s.cohorts),
    [1, 1, 1],
  );
  // Untouched configs pass through as themselves.
  assert.equal(slots[1], single);
});

test('sand does not modify the configs it was given', () => {
  const config = withCohorts(8);
  configSlots([config], false);
  assert.equal(config.cohorts, 8);
});

test('a slot count is always at least one and never unbounded', () => {
  assert.equal(cohortSlotCount(withCohorts(0)), 1);
  assert.equal(cohortSlotCount(withCohorts(-4)), 1);
  assert.equal(cohortSlotCount(withCohorts(Number.NaN)), 1);
  assert.equal(cohortSlotCount(withCohorts(2.9)), 2);
  assert.equal(cohortSlotCount(withCohorts(1e9)), MAX_COHORT_SLOTS);
});
