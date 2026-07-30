/**
 * Checks the generated presets are usable simulation values.
 *
 * These come from `persistence.load()` on the real preset files, so this is
 * really a check that the generator's output still lines up with what
 * `config.ts` expects -- a renamed field or a renumbered enum would otherwise
 * surface as a silently wrong simulation rather than as an error.
 *
 * TODO(Step 9): delete alongside defaultConfig.ts and presets.generated.json.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BC, IC, RULE_FLOAT_COUNT } from './config.ts';
import { CONFIG_DATA_STRIDE, packConfigs, writeConfigRecord } from './pack.ts';
import { DEFAULT_PRESET_NAME, PRESETS, defaultPreset, preset } from './defaultConfig.ts';

const NAMES = Object.keys(PRESETS);

test('the three shipped presets are present', () => {
  assert.deepEqual(NAMES.sort(), ['9leafv8', 'Starcrossedv8', 'hatmanv8'].sort());
});

test('the default preset is the desktop default', () => {
  // particle_system.py:45 opens Starcrossedv8, so both halves of the A/B start
  // on the same config without anyone having to remember to pick it.
  assert.equal(DEFAULT_PRESET_NAME, 'Starcrossedv8');
  assert.equal(defaultPreset().name, DEFAULT_PRESET_NAME);
});

test('every preset packs into exactly one 416-byte record', () => {
  // The strongest single check available without a GPU: packing exercises the
  // rule length, every lane, and the int-bit lanes at once.
  for (const name of NAMES) {
    const bytes = packConfigs([preset(name).config]);
    assert.equal(bytes.byteLength, CONFIG_DATA_STRIDE, `${name} packed to the wrong size`);
  }
});

test('every preset has a full 80-float rule', () => {
  // writeConfigRecord throws on a short rule, so a preset whose rule failed to
  // come across would fail at first upload rather than here. Checked directly
  // so the message names the preset.
  for (const name of NAMES) {
    assert.equal(
      preset(name).config.rule.length,
      RULE_FLOAT_COUNT,
      `${name} does not have ${RULE_FLOAT_COUNT} rule floats`,
    );
  }
});

test('enum-valued fields hold real enum members', () => {
  const boundaries = Object.values(BC) as number[];
  const initials = Object.values(IC) as number[];
  for (const name of NAMES) {
    const p = preset(name);
    assert.ok(
      boundaries.includes(p.world.boundaryConditions),
      `${name} has boundaryConditions ${p.world.boundaryConditions}`,
    );
    assert.ok(
      initials.includes(p.config.initialConditions),
      `${name} has initialConditions ${p.config.initialConditions}`,
    );
  }
});

test('cohorts are positive integers', () => {
  // `get_cohort` divides by the entity count and multiplies by this; a zero or
  // fractional cohort count would not error, it would just place particles
  // somewhere unintended.
  for (const name of NAMES) {
    const { cohorts } = preset(name).config;
    assert.ok(Number.isInteger(cohorts) && cohorts >= 1, `${name} has cohorts=${cohorts}`);
  }
});

test('trail persistence sits inside the shaders clamp range', () => {
  // common.wgsl clamps to [1e-2, 0.999]. A preset outside that range would be
  // silently altered by the shader, so the saved value would stop describing
  // what runs.
  for (const name of NAMES) {
    const p = preset(name).world.trailPersistence;
    assert.ok(p >= 1e-2 && p <= 0.999, `${name} has trailPersistence=${p}`);
  }
});

test('every numeric config field is finite', () => {
  // A NaN would propagate through the physics and silently blank the canvas.
  for (const name of NAMES) {
    for (const [field, value] of Object.entries(preset(name).config)) {
      if (typeof value === 'number') {
        assert.ok(Number.isFinite(value), `${name}.${field} is ${value}`);
      }
    }
  }
});

test('the presets cover the code paths Step 4 needs exercised', () => {
  // Not a correctness assertion about the presets -- a guard on the A/B's
  // COVERAGE. hatmanv8 is the only preset with multiple cohorts and a grid
  // spawn, so if it were replaced by another single-cohort centre-spawn config,
  // the cohort, grid and per-cohort-mutation paths would go untested and the
  // visual A/B would still look fine.
  const configs = NAMES.map((n) => preset(n).config);
  assert.ok(
    configs.some((c) => c.cohorts > 1),
    'no preset has multiple cohorts; get_cohort and the fences go unexercised',
  );
  assert.ok(
    configs.some((c) => c.initialConditions === IC.GRID),
    'no preset spawns on a grid; initial_position GRID branch goes unexercised',
  );
});

test('a config packs into a shared buffer at a non-zero offset', () => {
  // Proves the presets work through the offset path the ConfigBuffer uses, not
  // just the single-record convenience path.
  const buffer = new ArrayBuffer(CONFIG_DATA_STRIDE * 2);
  writeConfigRecord(defaultPreset().config, buffer, CONFIG_DATA_STRIDE);
  const first = new Uint8Array(buffer, 0, CONFIG_DATA_STRIDE);
  assert.ok(first.every((b) => b === 0), 'writing at an offset touched the first record');
  const second = new Uint8Array(buffer, CONFIG_DATA_STRIDE, CONFIG_DATA_STRIDE);
  assert.ok(second.some((b) => b !== 0), 'the second record was not written');
});

test('an unknown preset name fails loudly', () => {
  assert.throws(() => preset('nope'), /no preset named "nope"/);
});
