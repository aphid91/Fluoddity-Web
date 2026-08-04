/**
 * Tests for the v8 save format.
 *
 * Absorbs `defaultConfig.test.ts`, retargeted at the document form. Those
 * assertions are not thrown away: they were the only check that the shipped
 * preset values are the ones the desktop actually runs, and that job now belongs
 * to the reader.
 *
 * ## THE TOLERANCE MATRIX IS THE POINT
 *
 * Every `??` in `persistence.ts` reproduces one from the Python, and every one
 * of them fails SILENTLY when dropped -- a missing block loads as defaults and
 * the config simply behaves differently. `mutation_seed` is the worst: seed 0.0
 * is a completely different rule, which looks like a legitimate result. So each
 * fallback gets a case, and each case names what breaks without it.
 *
 * ## THE SHIPPED PRESETS
 *
 * `parses the real shipped presets` reads `configs/*.json` off disk through this
 * reader and checks the parsed values against literals. Those literals were
 * proved, while the Python app still existed, against what ITS reader produced
 * from the same files -- so they are a record of the reference behaviour, not a
 * transcription of this reader's own output.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BC, IC, makeSimulationConfig, makeWorldSettings } from '../particleSystem/config.ts';
import {
  ConfigFormatError,
  FORMAT_VERSION,
  fromDocument,
  sanitizeName,
  toDocument,
} from './persistence.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/config -> src -> repo root, which is where `configs/` lives.
const REPO_ROOT = path.join(here, '..', '..');

/** A minimal valid v8 document, which each case below perturbs. */
function validDocument(): Record<string, unknown> {
  return {
    version: 8,
    world: {
      trail_persistence: 0.9,
      trail_diffusion: 1.0,
      boundary_conditions: BC.WRAP,
    },
    configs: [
      {
        rule: Array.from({ length: 80 }, (_, i) => i * 0.01),
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
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

test('a config round-trips through toDocument and back', () => {
  const config = makeSimulationConfig(
    {
      cohorts: 64,
      mutationSeed: 0.8259,
      sensorGain: 0.379,
      sensorAngle: 0.206,
      sensorDistance: 2.421,
      mutationScale: 0.117,
      globalForceMult: 0.1538,
      drag: 0.504,
      strafePower: 0.389,
      axialForce: 0.371,
      lateralForce: -0.707,
      hazardRate: 0.25,
    },
    {
      gravityForce: 0.3,
      gravityStrafe: -0.2,
      initialConditions: IC.RING,
      cohortFences: 0.113,
      colorSensitivity: 0.75,
      colorByCohort: true,
      sensorAngleJitter: 0.05,
      sensorDistanceJitter: 0.166,
      radialGravity: true,
      rule: Array.from({ length: 80 }, (_, i) => Math.sin(i)),
    },
  );
  const world = makeWorldSettings({
    trailPersistence: 0.938,
    trailDiffusion: 0.5,
    boundaryConditions: BC.BOUNCE,
  });

  const back = fromDocument(toDocument([config], world));
  assert.equal(back.configs.length, 1);
  assert.deepEqual(back.configs[0], config);
  assert.deepEqual(back.world, world);
});

test('the whole config buffer round-trips, not just the selected slot', () => {
  // `project_commands.py:108-110`: saving only config 0 was REMOVED on the
  // desktop because it silently dropped the other slots.
  const doc = validDocument();
  const c = (doc['configs'] as unknown[])[0];
  doc['configs'] = [c, c, c];
  assert.equal(fromDocument(doc).configs.length, 3);

  const parsed = fromDocument(doc);
  const again = fromDocument(toDocument(parsed.configs, parsed.world));
  assert.equal(again.configs.length, 3);
});

test('camera and notes are omitted when absent, and survive when present', () => {
  const doc = fromDocument(validDocument());

  // ABSENCE MUST BE DISTINGUISHABLE from a default: the reader's contract is
  // that a file with no camera leaves the camera alone (`persistence.py:58-70`).
  const bare = toDocument(doc.configs, doc.world) as Record<string, unknown>;
  assert.equal('camera' in bare, false);
  assert.equal('notes' in bare, false);
  assert.equal(fromDocument(bare).camera, null);

  const withCamera = toDocument(
    doc.configs,
    doc.world,
    { pan: [0.5, -0.25], zoom: 2.03, mode: 'particles' },
    'a note',
  );
  const back = fromDocument(withCamera);
  assert.deepEqual(back.camera, { pan: [0.5, -0.25], zoom: 2.03, mode: 'particles' });
  assert.equal(back.notes, 'a note');
});

test('each camera member is independently optional', () => {
  // `_apply_saved_camera` (`project_commands.py:241-253`) reads all three with
  // `.get()`. A file with a pan and no zoom must not lose the pan.
  const doc = validDocument();
  doc['camera'] = { pan: [1, 2] };
  assert.deepEqual(fromDocument(doc).camera, { pan: [1, 2] });

  doc['camera'] = { zoom: 3 };
  assert.deepEqual(fromDocument(doc).camera, { zoom: 3 });

  // A malformed pan is dropped rather than throwing: the rest of the block is
  // still usable, and a camera is not worth failing a load over.
  doc['camera'] = { pan: [1], zoom: 3 };
  assert.deepEqual(fromDocument(doc).camera, { zoom: 3 });
});

// ---------------------------------------------------------------------------
// The tolerance matrix
// ---------------------------------------------------------------------------

test('mutation_seed falls back to rule_seed, then to zero', () => {
  // THE MOST DANGEROUS FALLBACK (`persistence.py:128-129`). Without it, files
  // written before the rename load with seed 0.0 -- and the chaotic hash turns
  // that into a completely different rule that still looks legitimate.
  const doc = validDocument();
  const config = (doc['configs'] as Record<string, unknown>[])[0]!;
  const misc = config['misc'] as Record<string, unknown>;

  delete misc['mutation_seed'];
  misc['rule_seed'] = 0.3088;
  assert.equal(fromDocument(doc).configs[0]!.mutationSeed, 0.3088);

  delete misc['rule_seed'];
  assert.equal(fromDocument(doc).configs[0]!.mutationSeed, 0.0);
});

test('misc2 is read under its old name "appearance"', () => {
  // `persistence.py:119-124`: the block was renamed when the sensor jitters
  // landed in it. Without this, colour settings silently revert to defaults.
  const doc = validDocument();
  const config = (doc['configs'] as Record<string, unknown>[])[0]!;
  config['appearance'] = config['misc2'];
  delete config['misc2'];

  const parsed = fromDocument(doc).configs[0]!;
  assert.equal(parsed.colorSensitivity, 0.5);
  assert.equal(parsed.sensorDistanceJitter, 0.16);
});

test('an absent force2 block defaults to no gravity and IC_CENTER', () => {
  // `persistence.py:140-148`. Without it, every pre-gravity file throws.
  const doc = validDocument();
  delete (doc['configs'] as Record<string, unknown>[])[0]!['force2'];

  const parsed = fromDocument(doc).configs[0]!;
  assert.equal(parsed.gravityForce, 0.0);
  assert.equal(parsed.gravityStrafe, 0.0);
  assert.equal(parsed.initialConditions, IC.CENTER);
  assert.equal(parsed.cohortFences, 0.0);
});

test('an absent misc2 block defaults colour sensitivity to the slider middle', () => {
  // `persistence.py:149-157`. 0.5 is what the reference shipped, so those
  // configs look like it intended rather than like a bug.
  const doc = validDocument();
  delete (doc['configs'] as Record<string, unknown>[])[0]!['misc2'];

  const parsed = fromDocument(doc).configs[0]!;
  assert.equal(parsed.colorSensitivity, 0.5);
  assert.equal(parsed.colorByCohort, false);
  assert.equal(parsed.sensorAngleJitter, 0.0);
  assert.equal(parsed.sensorDistanceJitter, 0.0);
});

test('an absent misc3 block defaults radial gravity to off', () => {
  // `persistence.py:158-161`: those files were written when gravity only pulled
  // along the fixed screen axis, so they keep falling the way they did.
  const doc = validDocument();
  delete (doc['configs'] as Record<string, unknown>[])[0]!['misc3'];
  assert.equal(fromDocument(doc).configs[0]!.radialGravity, false);
});

test('an absent boundary_conditions defaults to WRAP, not to zero', () => {
  // `persistence.py:205-207`. BC.BOUNCE is 0, so a naive `?? 0` would load every
  // pre-boundary file as BOUNCE -- visibly different physics, and no error.
  const doc = validDocument();
  delete (doc['world'] as Record<string, unknown>)['boundary_conditions'];
  assert.equal(fromDocument(doc).world.boundaryConditions, BC.WRAP);
});

// ---------------------------------------------------------------------------
// Rejection
// ---------------------------------------------------------------------------

test('v7 is rejected, with no v7 code path to reject it', () => {
  // `WEB_PORT_PLAN.md:657-659` scopes v7 for removal: "the spec that port
  // follows is the v8 format alone". So this is the generic unrecognized-version
  // message, NOT a friendlier one from a `version <= 7` arm -- such an arm would
  // be a v7 code path carrying v7 assumptions.
  const doc = validDocument();
  doc['version'] = 7;
  assert.throws(() => fromDocument(doc), ConfigFormatError);

  doc['version'] = 9;
  assert.throws(() => fromDocument(doc), ConfigFormatError);

  delete doc['version'];
  assert.throws(() => fromDocument(doc), ConfigFormatError);
});

test('an empty configs list is rejected here, not downstream', () => {
  // `persistence.py:200-201`. Caught at parse so the failure names the file,
  // rather than surfacing later as an undefined in the packer.
  const doc = validDocument();
  doc['configs'] = [];
  assert.throws(() => fromDocument(doc), ConfigFormatError);
});

test('required fields are required, and the message locates them', () => {
  for (const drop of ['sensor', 'force', 'misc'] as const) {
    const doc = validDocument();
    delete (doc['configs'] as Record<string, unknown>[])[0]![drop];
    assert.throws(
      () => fromDocument(doc, 'x.json'),
      (e: Error) => e instanceof ConfigFormatError && e.message.includes('configs[0]'),
      `dropping "${drop}" must throw a located ConfigFormatError`,
    );
  }
});

test('a present-but-malformed field throws rather than silently defaulting', () => {
  // The distinction that makes the tolerances safe: ABSENT means "an older file
  // that predates this", PRESENT-BUT-WRONG means corruption. Only the first
  // gets a default.
  const doc = validDocument();
  ((doc['configs'] as Record<string, unknown>[])[0]!['force2'] as Record<string, unknown>)[
    'gravity_force'
  ] = 'lots';
  assert.throws(() => fromDocument(doc), ConfigFormatError);
});

test('an out-of-range enum is rejected', () => {
  // Per invariant 9 a wrong boundary mode looks like a physics quirk, not an
  // error, so it must be loud here.
  const doc = validDocument();
  (doc['world'] as Record<string, unknown>)['boundary_conditions'] = 7;
  assert.throws(() => fromDocument(doc), ConfigFormatError);

  const doc2 = validDocument();
  ((doc2['configs'] as Record<string, unknown>[])[0]!['force2'] as Record<string, unknown>)[
    'initial_conditions'
  ] = 9;
  assert.throws(() => fromDocument(doc2), ConfigFormatError);
});

test('a non-numeric rule is rejected', () => {
  const doc = validDocument();
  (doc['configs'] as Record<string, unknown>[])[0]!['rule'] = [1, 2, 'three'];
  assert.throws(() => fromDocument(doc), ConfigFormatError);
});

// ---------------------------------------------------------------------------
// sanitizeName
// ---------------------------------------------------------------------------

test('sanitizeName removes the nine forbidden characters', () => {
  // REMOVES rather than replaces (`persistence.py:310-318`): substituting an
  // underscore would make "a/b" and "a_b" collide.
  assert.equal(sanitizeName('a\\b/c:d*e?f"g<h>i|j'), 'abcdefghij');
});

test('sanitizeName trims, strips trailing dots, and truncates to 120', () => {
  assert.equal(sanitizeName('  spaced  '), 'spaced');
  assert.equal(sanitizeName('windows...'), 'windows');
  assert.equal(sanitizeName('x'.repeat(200)).length, 120);
});

test('sanitizeName CAN return empty, which the caller must check', () => {
  // The case `_cmd_save_config` guards (`project_commands.py:113-115`): a name
  // with no usable characters would otherwise be written under an empty key and
  // be unreachable from the menu.
  assert.equal(sanitizeName('...'), '');
  assert.equal(sanitizeName('///'), '');
  assert.equal(sanitizeName('   '), '');
});

test('FORMAT_VERSION is 8 and is what the writer emits', () => {
  assert.equal(FORMAT_VERSION, 8);
  const doc = toDocument(
    fromDocument(validDocument()).configs,
    fromDocument(validDocument()).world,
  ) as Record<string, unknown>;
  assert.equal(doc['version'], 8);
});

// ---------------------------------------------------------------------------
// THE SHIPPED PRESETS -- see the file header
// ---------------------------------------------------------------------------

test('parses the real shipped presets to the values the reference reader produced', () => {
  // Reads `configs/*.json` off disk through THIS reader and compares against
  // `presets.fixture.json`, which the retired Python app produced from the same
  // files through ITS reader. Every other test in this file builds a document
  // in memory and reads it back, which cannot catch a fallback that is wrong in
  // the same direction on both sides. This one can: the expected values came
  // from somewhere else.
  const expectedByName = (
    JSON.parse(fs.readFileSync(path.join(here, 'presets.fixture.json'), 'utf8')) as {
      presets: Record<
        string,
        { config: Record<string, number | boolean>; world: Record<string, number> }
      >;
    }
  ).presets;

  // Guards against the fixture silently emptying and the loop below passing
  // vacuously -- which is exactly what happened when its predecessor was
  // deleted and this test early-returned instead of failing.
  assert.equal(Object.keys(expectedByName).length, 7);

  for (const [name, expected] of Object.entries(expectedByName)) {
    const raw = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'configs', `${name}.json`), 'utf8'),
    );
    const parsed = fromDocument(raw, `${name}.json`);
    const config = parsed.configs[0]!;

    for (const [key, value] of Object.entries(expected.config)) {
      if (key === 'rule') continue; // compared below, as an array
      assert.equal(
        (config as unknown as Record<string, number | boolean>)[key],
        value,
        `${name}.${key}`,
      );
    }
    assert.deepEqual(
      [...config.rule],
      expected.config['rule'] as unknown as number[],
      `${name}.rule`,
    );
    assert.equal(parsed.world.trailPersistence, expected.world['trailPersistence'], name);
    assert.equal(parsed.world.trailDiffusion, expected.world['trailDiffusion'], name);
    assert.equal(parsed.world.boundaryConditions, expected.world['boundaryConditions'], name);
  }
});
