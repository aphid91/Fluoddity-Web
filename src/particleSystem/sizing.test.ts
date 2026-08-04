/**
 * Tests for entity-count and canvas-resolution sizing.
 *
 * `docs/WEB_PORT_PLAN.md` step 2 names the specific check: "check sizing.ts
 * against the Python values for world sizes 0.25 / 1.0 / 4.0". Those are here
 * as explicit assertions AND covered by the generated parity goldens.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BASE_CANVAS_DIM,
  CANVAS_ASPECT,
  CANVAS_DIM,
  ENTITIES_PER_WORLD_UNIT,
  ENTITY_COUNT,
  canvasDimensions,
  sizingFor,
} from './sizing.ts';
import { PARITY } from '../testing/parity.ts';

// The plan's named check, spelled out rather than only reached through the
// goldens -- these three numbers are the ones a reader will want to see.
test('sizingFor matches the Python at the plan-named world sizes', () => {
  assert.deepEqual(sizingFor(0.25), [150_000, 512]);
  assert.deepEqual(sizingFor(1.0), [600_000, 1024]);
  assert.deepEqual(sizingFor(4.0), [2_400_000, 2048]);
});

// Canvas edge goes as sqrt because world size is an AREA: 4x the world is 2x
// the edge, and density (entities per pixel) stays constant.
test('quadrupling world size doubles the canvas edge and quadruples the count', () => {
  const [count1, dim1] = sizingFor(1.0);
  const [count4, dim4] = sizingFor(4.0);
  assert.equal(count4, count1 * 4);
  assert.equal(dim4, dim1 * 2);
});

// Python's int() truncates toward zero, so a fractional product is cut, not
// rounded. At world size 1.0000015 the product is 600000.9: trunc gives 600000
// where Math.round would give 600001. This is the case that pins the choice.
test('entity count truncates toward zero rather than rounding', () => {
  assert.equal(sizingFor(1.0000015)[0], 600_000);
  assert.notEqual(sizingFor(1.0000015)[0], Math.round(600_000 * 1.0000015));
  // Same for the canvas edge: 1024 * sqrt(1.5) is 1254.03..., cut to 1254.
  assert.equal(sizingFor(1.5)[1], 1254);
});

test('sizingFor clamps to at least one entity and a 16px canvas', () => {
  assert.deepEqual(sizingFor(0), [1, 16]);
  assert.deepEqual(sizingFor(1e-9), [1, 16]);
});

test('canvasDimensions matches the Python', () => {
  assert.deepEqual(canvasDimensions(), [1024, 1024]);
  assert.deepEqual(canvasDimensions(2.0), [1448, 724]);
  assert.deepEqual(canvasDimensions(0.5), [724, 1448]);
  assert.deepEqual(canvasDimensions(1.0, 512), [512, 512]);
});

// Area-preserving: width*height stays near dim*dim regardless of shape, which
// is what keeps simulation cost and trail resolution independent of aspect.
test('canvasDimensions preserves pixel count across aspects', () => {
  for (const aspect of [0.5, 1.0, 16 / 9, 2.0, 4.0]) {
    const [w, h] = canvasDimensions(aspect);
    const ratio = (w * h) / (CANVAS_DIM * CANVAS_DIM);
    assert.ok(
      Math.abs(ratio - 1) < 0.001,
      `aspect ${aspect} gave ${w}x${h} = ${w * h}, expected ~${CANVAS_DIM ** 2}`,
    );
  }
});

// `dim` is resolved at call time, and `??` means an explicit 0 is honoured
// (then clamped by max(1, ...)) rather than being swallowed by `||`.
test('canvasDimensions resolves dim at call time and honours an explicit 0', () => {
  assert.deepEqual(canvasDimensions(1.0, undefined), canvasDimensions(1.0));
  assert.deepEqual(canvasDimensions(1.0, 0), [1, 1]);
});

// sizing.py:57-59 says these are derived through sizing_for "so the default and
// the scaled case can never disagree". Assert the derivation, not the literals.
test('ENTITY_COUNT and CANVAS_DIM are derived, not restated', () => {
  assert.deepEqual([ENTITY_COUNT, CANVAS_DIM], sizingFor(1.0));
});

test('the two scale constants have their documented values', () => {
  assert.equal(ENTITIES_PER_WORLD_UNIT, 600_000);
  assert.equal(BASE_CANVAS_DIM, 1024);
  assert.equal(CANVAS_ASPECT, 1.0);
});

// ---------------------------------------------------------------------------
// Parity with the Python
// ---------------------------------------------------------------------------

test('parity: sizing constants match the Python', () => {
  const c = PARITY.sizing.constants;
  assert.equal(ENTITIES_PER_WORLD_UNIT, c.ENTITIES_PER_WORLD_UNIT);
  assert.equal(BASE_CANVAS_DIM, c.BASE_CANVAS_DIM);
  assert.equal(CANVAS_ASPECT, c.CANVAS_ASPECT);
  assert.equal(ENTITY_COUNT, c.ENTITY_COUNT);
  assert.equal(CANVAS_DIM, c.CANVAS_DIM);
});

test('parity: sizingFor matches the Python across the sampled world sizes', () => {
  for (const c of PARITY.sizing.sizingFor) {
    assert.deepEqual(
      sizingFor(c.worldSize),
      c.out,
      `worldSize=${c.worldSize}`,
    );
  }
});

// The goldens deliberately contain no rounding-tie case -- see the divergence
// note on canvasDimensions. Every case here is one where half-to-even and
// half-up agree.
test('parity: canvasDimensions matches the Python away from rounding ties', () => {
  for (const c of PARITY.sizing.canvasDimensions) {
    assert.deepEqual(
      canvasDimensions(c.aspect, c.dim ?? undefined),
      c.out,
      `aspect=${c.aspect} dim=${c.dim}`,
    );
  }
});
