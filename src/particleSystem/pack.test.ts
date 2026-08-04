/**
 * Tests for config -> GPU bytes.
 *
 * The strongest assertion here is the hex comparison against a record produced
 * by the desktop Python: one equality covers all 104 float lanes, the 80-float
 * rule copy, the four bit-punned int lanes and the zero-fill of the reserved
 * ones simultaneously. The lane-by-lane tests exist so that a failure of that
 * one says *where* rather than just *that*.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  type SimulationConfig,
  type WorldConfig,
  BC,
  IC,
  LANE,
  RULE_FLOAT_COUNT,
  WORLD_LANE,
  forUpload,
  makeSimulationConfig,
  makeWorldSettings,
} from './config.ts';
import {
  CONFIG_DATA_STRIDE,
  WORLD_DATA_SIZE,
  packConfigs,
  packWorldConfig,
  writeConfigRecord,
} from './pack.ts';
import { PARITY } from '../testing/parity.ts';

/** A rule of 80 distinct values, so a mis-ordered copy cannot pass. */
function distinctRule(): number[] {
  return Array.from({ length: RULE_FLOAT_COUNT }, (_, i) => i);
}

/** A config whose every scalar field is distinguishable from every other. */
function distinctConfig(overrides: Partial<SimulationConfig> = {}): SimulationConfig {
  return makeSimulationConfig(
    {
      cohorts: 7,
      mutationSeed: 0.125,
      sensorGain: 1.25,
      sensorAngle: 2.25,
      sensorDistance: 3.25,
      mutationScale: 4.25,
      globalForceMult: 5.25,
      drag: 6.25,
      strafePower: 7.25,
      axialForce: 8.25,
      lateralForce: 9.25,
      hazardRate: 10.25,
    },
    {
      gravityForce: 11.25,
      gravityStrafe: 12.25,
      initialConditions: IC.RING,
      cohortFences: 13.25,
      colorSensitivity: 14.25,
      colorByCohort: true,
      sensorAngleJitter: 15.25,
      sensorDistanceJitter: 16.25,
      radialGravity: true,
      rule: distinctRule(),
      ...overrides,
    },
  );
}

const views = (buffer: ArrayBuffer) => ({
  f32: new Float32Array(buffer),
  i32: new Int32Array(buffer),
});

// ---------------------------------------------------------------------------
// Sizes and striding
// ---------------------------------------------------------------------------

test('a config record is exactly 416 bytes and n configs are n x 416', () => {
  assert.equal(CONFIG_DATA_STRIDE, 416);
  assert.equal(packConfigs([distinctConfig()]).byteLength, 416);
  assert.equal(packConfigs([distinctConfig(), distinctConfig()]).byteLength, 832);
  assert.equal(packConfigs([]).byteLength, 0);
});

test('packConfigs of an empty list produces zero bytes without throwing', () => {
  assert.doesNotThrow(() => packConfigs([]));
});

test('consecutive configs are packed at stride 416 with no overlap', () => {
  const a = distinctConfig({ sensorGain: 111 });
  const b = distinctConfig({ sensorGain: 222 });
  const { f32 } = views(packConfigs([a, b]));

  const floatsPerRecord = CONFIG_DATA_STRIDE / 4; // 104
  assert.equal(f32[LANE.sensor], 111);
  assert.equal(f32[floatsPerRecord + LANE.sensor], 222);
  // The second record's rule must start right after the first record ends.
  assert.equal(f32[floatsPerRecord + LANE.rule], 0);
  assert.equal(f32[floatsPerRecord + LANE.rule + 79], 79);
});

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

// The claim that lets pack.ts treat the rule as a flat memcpy instead of
// modelling the (10, 2, 4) FourierCenter nesting the Python assigns through.
test('the rule lands as a contiguous 80-float copy in order', () => {
  const { f32 } = views(packConfigs([distinctConfig({ rule: distinctRule() })]));
  for (let i = 0; i < RULE_FLOAT_COUNT; i++) {
    assert.equal(f32[LANE.rule + i], i, `rule float ${i}`);
  }
  // And it stops at 80: lane 80 is `sensor`, not more rule.
  assert.notEqual(f32[80], 80);
});

test('a rule that is not exactly 80 floats is rejected', () => {
  for (const length of [0, 79, 81, 160]) {
    const config = distinctConfig({
      rule: Array.from({ length }, (_, i) => i),
    });
    assert.throws(
      () => packConfigs([config]),
      /rule must be 80 floats \(10 centers x 8\)/,
      `length ${length} should have thrown`,
    );
  }
});

// ---------------------------------------------------------------------------
// Float lanes
// ---------------------------------------------------------------------------

test('every float lane holds the field the lane table names', () => {
  const config = distinctConfig();
  const { f32 } = views(packConfigs([config]));

  assert.equal(f32[LANE.sensor + 0], config.sensorGain);
  assert.equal(f32[LANE.sensor + 1], config.sensorAngle);
  assert.equal(f32[LANE.sensor + 2], config.sensorDistance);
  assert.equal(f32[LANE.sensor + 3], config.mutationScale);

  assert.equal(f32[LANE.force + 0], config.globalForceMult);
  assert.equal(f32[LANE.force + 1], config.drag);
  assert.equal(f32[LANE.force + 2], config.strafePower);
  assert.equal(f32[LANE.force + 3], config.axialForce);

  assert.equal(f32[LANE.misc + 0], config.lateralForce);
  assert.equal(f32[LANE.misc + 1], config.hazardRate);
  assert.equal(f32[LANE.misc + 3], config.mutationSeed);

  assert.equal(f32[LANE.force2 + 0], config.gravityForce);
  assert.equal(f32[LANE.force2 + 1], config.gravityStrafe);
  assert.equal(f32[LANE.force2 + 3], config.cohortFences);

  assert.equal(f32[LANE.misc2 + 0], config.colorSensitivity);
  assert.equal(f32[LANE.misc2 + 2], config.sensorAngleJitter);
  assert.equal(f32[LANE.misc2 + 3], config.sensorDistanceJitter);
});

// ---------------------------------------------------------------------------
// Int lanes
// ---------------------------------------------------------------------------

// Read back through Int32Array: these lanes are bit patterns the shader reads
// with bitcast<i32>, not quantities.
test('int lanes hold raw ints readable by bitcast<i32>', () => {
  const config = distinctConfig({
    cohorts: 12,
    initialConditions: IC.RANDOM,
    colorByCohort: true,
    radialGravity: false,
  });
  const { i32 } = views(packConfigs([config]));

  assert.equal(i32[LANE.misc + 2], 12, 'misc.z = cohorts');
  assert.equal(i32[LANE.force2 + 2], IC.RANDOM, 'force2.z = initial_conditions');
  assert.equal(i32[LANE.misc2 + 1], 1, 'misc2.y = color_by_cohort');
  assert.equal(i32[LANE.misc3 + 0], 0, 'misc3.x = radial_gravity');
});

test('booleans pack as 0 and 1', () => {
  const on = views(packConfigs([distinctConfig({ colorByCohort: true, radialGravity: true })])).i32;
  assert.equal(on[LANE.misc2 + 1], 1);
  assert.equal(on[LANE.misc3 + 0], 1);

  const off = views(packConfigs([distinctConfig({ colorByCohort: false, radialGravity: false })])).i32;
  assert.equal(off[LANE.misc2 + 1], 0);
  assert.equal(off[LANE.misc3 + 0], 0);
});

// Proves the Float32Array and Int32Array views really alias the same bytes: the
// int written through one view reads back through the other as the denormal the
// Python's _int_lane() produces. If the views did not alias, this would be 0.
test('the int and float views alias, producing the Python denormal', () => {
  const { f32, i32 } = views(packConfigs([distinctConfig({ cohorts: 3 })]));
  assert.equal(i32[LANE.misc + 2], 3);

  const expected = PARITY.packing.intLaneBitPatterns.find((p) => p.int === 3);
  assert.ok(expected?.float != null, 'parity data must carry the int-lane float for 3');
  assert.equal(f32[LANE.misc + 2], expected.float);
});

// ---------------------------------------------------------------------------
// Reserved lanes
// ---------------------------------------------------------------------------

test('reserved lanes are zero without being written', () => {
  const { f32 } = views(packConfigs([distinctConfig()]));
  assert.equal(f32[LANE.misc3 + 1], 0, 'misc3.y');
  assert.equal(f32[LANE.misc3 + 2], 0, 'misc3.z');
  assert.equal(f32[LANE.misc3 + 3], 0, 'misc3.w');

  const world = views(packWorldConfig(referenceWorld())).f32;
  assert.equal(world[WORLD_LANE.bounds + 1], 0, 'bounds.y');
  assert.equal(world[WORLD_LANE.bounds + 2], 0, 'bounds.z');
  assert.equal(world[WORLD_LANE.bounds + 3], 0, 'bounds.w');
});

// ---------------------------------------------------------------------------
// writeConfigRecord's guards
// ---------------------------------------------------------------------------

test('writeConfigRecord writes in place at an offset', () => {
  const buffer = new ArrayBuffer(CONFIG_DATA_STRIDE * 3);
  writeConfigRecord(distinctConfig({ sensorGain: 42 }), buffer, CONFIG_DATA_STRIDE);

  const { f32 } = views(buffer);
  const floats = CONFIG_DATA_STRIDE / 4;
  assert.equal(f32[floats + LANE.sensor], 42, 'slot 1 was written');
  assert.equal(f32[LANE.sensor], 0, 'slot 0 untouched');
  assert.equal(f32[2 * floats + LANE.sensor], 0, 'slot 2 untouched');
});

test('writeConfigRecord rejects an overrun or a misaligned offset', () => {
  const buffer = new ArrayBuffer(CONFIG_DATA_STRIDE);
  assert.throws(
    () => writeConfigRecord(distinctConfig(), buffer, 4),
    /overruns/,
  );
  assert.throws(
    () => writeConfigRecord(distinctConfig(), new ArrayBuffer(CONFIG_DATA_STRIDE + 2), 2),
    /4-byte aligned/,
  );
});

// ---------------------------------------------------------------------------
// WorldData
// ---------------------------------------------------------------------------

function referenceWorld(): WorldConfig {
  return forUpload(
    makeWorldSettings({
      trailPersistence: 0.9371,
      trailDiffusion: 0.618,
      boundaryConditions: BC.RESET,
    }),
    1.2599,
    5,
  );
}

test('WorldData is 32 bytes with the documented lane assignment', () => {
  const world = referenceWorld();
  const buffer = packWorldConfig(world);
  assert.equal(buffer.byteLength, WORLD_DATA_SIZE);
  assert.equal(buffer.byteLength, 32);

  const { f32, i32 } = views(buffer);
  assert.equal(f32[WORLD_LANE.trail + 0], Math.fround(world.trailPersistence));
  assert.equal(f32[WORLD_LANE.trail + 1], Math.fround(world.trailDiffusion));
  assert.equal(f32[WORLD_LANE.trail + 2], Math.fround(world.sqrtWorldSize));
  assert.equal(i32[WORLD_LANE.trail + 3], 5, 'trail.w = config_count');
  assert.equal(i32[WORLD_LANE.bounds + 0], BC.RESET, 'bounds.x = boundary_conditions');
});

// ---------------------------------------------------------------------------
// Parity with the Python: the byte-exact goldens
// ---------------------------------------------------------------------------

/** Rebuild the Python's reference config from the generated parity data. */
function parityConfig(): SimulationConfig {
  const r = PARITY.packing.referenceConfig;
  return {
    cohorts: r.cohorts,
    mutationSeed: r.mutationSeed,
    sensorGain: r.sensorGain,
    sensorAngle: r.sensorAngle,
    sensorDistance: r.sensorDistance,
    mutationScale: r.mutationScale,
    globalForceMult: r.globalForceMult,
    drag: r.drag,
    strafePower: r.strafePower,
    axialForce: r.axialForce,
    lateralForce: r.lateralForce,
    hazardRate: r.hazardRate,
    gravityForce: r.gravityForce,
    gravityStrafe: r.gravityStrafe,
    initialConditions: r.initialConditions as SimulationConfig['initialConditions'],
    cohortFences: r.cohortFences,
    colorSensitivity: r.colorSensitivity,
    colorByCohort: r.colorByCohort,
    sensorAngleJitter: r.sensorAngleJitter,
    sensorDistanceJitter: r.sensorDistanceJitter,
    radialGravity: r.radialGravity,
    rule: r.rule,
  };
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// THE assertion of this file. Compared exactly, not approximately: both
// np.float32 assignment and Float32Array assignment round to nearest-even, so
// a faithful port is bit-identical to the desktop's bytes.
test('parity: a packed config record is byte-identical to the Python', () => {
  assert.equal(toHex(packConfigs([parityConfig()])), PARITY.packing.configRecordHex);
});

test('parity: two packed configs are byte-identical to the Python', () => {
  const config = parityConfig();
  assert.equal(toHex(packConfigs([config, config])), PARITY.packing.twoConfigHex);
});

test('parity: a packed WorldData record is byte-identical to the Python', () => {
  const w = PARITY.packing.referenceWorld;
  const world = forUpload(
    makeWorldSettings({
      trailPersistence: w.trailPersistence,
      trailDiffusion: w.trailDiffusion,
      boundaryConditions: w.boundaryConditions as WorldConfig['boundaryConditions'],
    }),
    w.sqrtWorldSize,
    w.configCount,
  );
  assert.equal(toHex(packWorldConfig(world)), PARITY.packing.worldRecordHex);
});

test('parity: the mode enums match the Python by value', () => {
  const e = PARITY.packing.enums;
  assert.equal(BC.BOUNCE, e.BC_BOUNCE);
  assert.equal(BC.WRAP, e.BC_WRAP);
  assert.equal(BC.RESET, e.BC_RESET);
  assert.equal(IC.GRID, e.IC_GRID);
  assert.equal(IC.RANDOM, e.IC_RANDOM);
  assert.equal(IC.CENTER, e.IC_CENTER);
  assert.equal(IC.RING, e.IC_RING);
});

// The int-lane bit patterns, written through Int32Array and read back as the
// bytes the Python's _int_lane() produces.
test('parity: int-lane bit patterns match the Python', () => {
  for (const c of PARITY.packing.intLaneBitPatterns) {
    const buffer = new ArrayBuffer(4);
    new Int32Array(buffer)[0] = c.int;
    assert.equal(toHex(buffer), c.hex, `int ${c.int}`);
  }
});
