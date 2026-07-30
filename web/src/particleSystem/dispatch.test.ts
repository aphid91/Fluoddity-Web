/**
 * Dispatch arithmetic.
 *
 * Small, but the failure it guards is invisible: too few workgroups leaves a
 * tail of entities never updated, and they freeze mid-flight while the rest of
 * the population carries on. That looks like a physics quirk, not a bug.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WORKGROUP_SIZE, workgroupsFor } from './dispatch.ts';
import { ENTITY_COUNT, sizingFor } from './sizing.ts';

test('workgroup size is 256', () => {
  // Also the default maxComputeInvocationsPerWorkgroup, so no limit request is
  // needed. shaders.test.ts checks the shader agrees.
  assert.equal(WORKGROUP_SIZE, 256);
});

test('every entity is covered, at every boundary', () => {
  for (const n of [1, 255, 256, 257, 511, 512, 600_000, 2_400_000]) {
    const groups = workgroupsFor(n);
    assert.ok(
      groups * WORKGROUP_SIZE >= n,
      `${n} entities need more than ${groups} workgroups`,
    );
    // And not wastefully many: dropping one group must leave someone uncovered.
    assert.ok(
      (groups - 1) * WORKGROUP_SIZE < n,
      `${n} entities dispatch ${groups} workgroups, one more than needed`,
    );
  }
});

test('exact multiples do not allocate a spare group', () => {
  assert.equal(workgroupsFor(256), 1);
  assert.equal(workgroupsFor(512), 2);
  assert.equal(workgroupsFor(2560), 10);
});

test('the default entity count dispatches 2344 groups', () => {
  // 600,000 / 256 = 2343.75. The 64 extra invocations are why the shader's
  // `index >= arrayLength(&entities)` guard is load-bearing rather than
  // defensive.
  assert.equal(ENTITY_COUNT, 600_000);
  assert.equal(workgroupsFor(ENTITY_COUNT), 2344);
  assert.equal(2344 * WORKGROUP_SIZE - 600_000, 64);
});

test('the supported world sizes stay under maxComputeWorkgroupsPerDimension', () => {
  // 65535 is the guaranteed minimum. World size 4 is the largest the plan's A/B
  // protocol exercises; this records how much headroom is left, so a future
  // world-size expansion fails a test rather than dropping entities.
  for (const worldSize of [0.25, 1.0, 4.0]) {
    const [entities] = sizingFor(worldSize);
    assert.ok(
      workgroupsFor(entities) <= 65535,
      `world size ${worldSize} needs ${workgroupsFor(entities)} workgroups`,
    );
  }
  // Where a single dimension stops being enough: 65535 * 256 / 600000 ~= 27.96,
  // so world size 27 fits and 28 does not. Far beyond anything the UI offers --
  // recorded so the number is a measured fact rather than a guess.
  assert.ok(workgroupsFor(sizingFor(27.0)[0]) <= 65535);
  assert.ok(workgroupsFor(sizingFor(28.0)[0]) > 65535);
});

test('zero entities dispatch nothing', () => {
  assert.equal(workgroupsFor(0), 0);
});
