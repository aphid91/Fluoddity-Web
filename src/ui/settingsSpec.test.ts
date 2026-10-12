/**
 * The settings registry: every entry names a real field on its real source.
 *
 * ## The failure this exists to catch
 *
 * A `Setting` is a data table entry, so `field` is a plain string and **the
 * compiler cannot check it**. An entry naming a field that does not exist
 * produces a control that renders, moves, and does nothing at all -- and it
 * does nothing SILENTLY, because `editSelected` and `withValue` both return the
 * receiver unchanged for an unknown field (which is the right behaviour, and
 * exactly what makes the failure quiet).
 *
 * Renaming a config field is the realistic way to reach it: nothing in the type
 * system connects `SimulationConfig.sensorGain` to the string `'sensorGain'` in
 * this table. So this test is the connection, for all 35 entries at once.
 *
 * ## And the enum lockstep
 *
 * `DROPDOWN_MODES`' ORDER IS THE ENUM: each label's index is the value stored
 * and uploaded to the GPU. Reordering a tuple there silently changes what every
 * saved config means -- a config that said Wrap now says Bounce, and the
 * simulation just behaves differently. Asserted against `BC` and `IC`
 * themselves rather than against a transcription.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  type Setting,
  ADVANCED,
  BASIC,
  BOOL,
  CHOICE,
  CONFIG,
  DROPDOWN_MODES,
  GATED,
  GATED_INT,
  INPUT,
  INT,
  PREFS,
  SEED,
  SETTINGS,
  SLIDER,
  WORLD,
  bySource,
  grouped,
  outsideMinMagnitude,
  seedSetting,
  settingFor,
  visible,
} from './settingsSpec.ts';
import {
  ACTIVATION,
  BOUNDARY,
  DISPLAY,
  IC,
  PERCEPTION,
  STATE_BOUND,
  makeNcaConfig,
  makeNcaWorld,
} from '../nca/ncaConfig.ts';
import { DEFAULT_PREFERENCES } from '../prefs/preferences.ts';

const CONFIG_FIELDS = new Set(Object.keys(makeNcaConfig()));
const WORLD_FIELDS = new Set(Object.keys(makeNcaWorld()));
const PREFS_FIELDS = new Set(Object.keys(DEFAULT_PREFERENCES));

function fieldsFor(setting: Setting): Set<string> {
  if (setting.source === CONFIG) return CONFIG_FIELDS;
  if (setting.source === WORLD) return WORLD_FIELDS;
  return PREFS_FIELDS;
}

// ---------------------------------------------------------------------------
// Every entry names something real
// ---------------------------------------------------------------------------

test('every setting names a real field on its source', () => {
  for (const setting of SETTINGS) {
    // The Gravity gate stores nothing itself -- "not itself a saved setting"
    // (`settings_spec.py:263`) -- so an empty field is legal and is the ONLY
    // legal empty one.
    if (setting.field === '') {
      assert.equal(setting.kind, BOOL, `${setting.label} has no field but is not a gate`);
      assert.ok(setting.gates.length > 0, `${setting.label} has no field and gates nothing`);
      continue;
    }
    assert.ok(
      fieldsFor(setting).has(setting.field),
      `${setting.label} names "${setting.field}", which is not a field on ${setting.source}`,
    );
  }
});

test('labels are unique', () => {
  // `revealsOn` names its gate BY LABEL (`gravityStrafe` reveals on 'Gravity'),
  // so a duplicate label makes that reference ambiguous in Step 10.
  const labels = SETTINGS.map((s) => s.label);
  assert.equal(new Set(labels).size, labels.length);
});

test('every gated field is named by a real entry', () => {
  // `gates` lists FIELDS, unlike `revealsOn` which names a LABEL. Both are
  // string references into this same table, so both can rot.
  const fields = new Set(SETTINGS.map((s) => s.field));
  const labels = new Set(SETTINGS.map((s) => s.label));
  for (const setting of SETTINGS) {
    for (const gated of setting.gates) {
      assert.ok(fields.has(gated), `${setting.label} gates "${gated}", which no entry declares`);
    }
    if (setting.revealsOn !== '') {
      assert.ok(
        labels.has(setting.revealsOn) || fields.has(setting.revealsOn),
        `${setting.label} reveals on "${setting.revealsOn}", which no entry declares`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// The enum lockstep
// ---------------------------------------------------------------------------

test('choice controls declare bounds matching their option count', () => {
  // `hi` is the last valid index. A mismatch would let a control produce a
  // value no BC_*/IC_* mode claims.
  for (const setting of SETTINGS.filter((s) => s.kind === CHOICE)) {
    assert.equal(setting.lo, 0, `${setting.label}`);
    assert.equal(setting.hi, setting.options.length - 1, `${setting.label}`);
  }
});

// ---------------------------------------------------------------------------
// Bounds and kinds
// ---------------------------------------------------------------------------

test('numeric controls have lo < hi', () => {
  const numeric = [SLIDER, INT, INPUT, GATED, GATED_INT];
  for (const setting of SETTINGS.filter((s) => numeric.includes(s.kind))) {
    assert.ok(setting.lo < setting.hi, `${setting.label} has lo >= hi`);
  }
});

test('gated controls gate at a value inside their range', () => {
  // `gateBase` is not always zero: Blur Samples counts renders, so its off is 1,
  // and Trail Stiffness is inverted so its base is the TOP of the range.
  for (const setting of SETTINGS.filter((s) => s.kind === GATED || s.kind === GATED_INT)) {
    assert.ok(
      setting.gateBase >= setting.lo && setting.gateBase <= setting.hi,
      `${setting.label} gates at ${setting.gateBase}, outside [${setting.lo}, ${setting.hi}]`,
    );
  }
});

test('disruptive settings are typed inputs, not sliders', () => {
  // A slider would rebuild the simulation on every frame of the drag. This is
  // why `kind` and `disruptive` are not independent in practice.
  for (const setting of SETTINGS.filter((s) => s.disruptive)) {
    assert.equal(setting.kind, INPUT, `${setting.label} is disruptive but draggable`);
  }
  assert.deepEqual(
    SETTINGS.filter((s) => s.disruptive).map((s) => s.field).sort(),
    ['canvasAspect', 'worldSize'],
  );
});

test('every entry is currently implemented', () => {
  // `implemented=False` is the mechanism for staging layout ahead of wiring
  // (the plan, Step 10). Zero entries use it today; this asserts that, so its
  // first use is a deliberate change rather than an accident.
  assert.equal(SETTINGS.every((s) => s.implemented), true);
});

// ---------------------------------------------------------------------------
// Selection helpers
// ---------------------------------------------------------------------------

test('basic is a strict subset of advanced', () => {
  const basic = visible(false);
  const all = visible(true);
  // NOT `SETTINGS.length`: `visible()` also drops `panel: false` entries, whose
  // widget is built somewhere the registry does not reach (see the next test),
  // and `studio: false` ones, which only sand renders.
  assert.equal(all.length, SETTINGS.filter((s) => s.panel && s.studio).length);
  assert.ok(basic.length < all.length);
  assert.ok(basic.every((s) => s.tier === BASIC));
  assert.ok(all.some((s) => s.tier === ADVANCED));
});

test('panel:false entries are real settings that no panel renders', () => {
  // Mutation Scale and its seed are the only two, and they are not vestigial:
  // the field is still packed, saved and undoable, and `randomizeSeed` still
  // finds the seed through `seedSetting()`. What moved is the WIDGET, to
  // `ui/mutationOverlay.ts`. Pinned because "the registry knows about it but
  // does not render it" is a distinction that rots quietly.
  const offPanel = SETTINGS.filter((s) => !s.panel).map((s) => s.field);
  assert.deepEqual(offPanel, ['mutationScale', 'mutationSeed']);

  // Absent from every tier of every source, which is the whole point.
  for (const tier of [false, true]) {
    const fields = visible(tier).map((s) => s.field);
    for (const field of offPanel) {
      assert.ok(!fields.includes(field), `${field} rendered at tier ${String(tier)}`);
    }
  }

  // ...and still reachable by the lookups that need them.
  assert.equal(seedSetting()?.field, 'mutationSeed');
  assert.equal(settingFor(CONFIG, 'mutationScale')?.label, 'Mutation Scale');
});

// ---------------------------------------------------------------------------
// Trail Weight
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// The NCA registry
// ---------------------------------------------------------------------------

test('dropdown order matches the NCA enums', () => {
  // The stored value is the option's INDEX, so each label must sit at its enum.
  const at = (list: readonly string[], i: number): string => list[i]!;
  assert.equal(at(DROPDOWN_MODES.boundary, BOUNDARY.ZERO), 'Zero');
  assert.equal(at(DROPDOWN_MODES.initialConditions, IC.SPARSE), 'Sparse');
  assert.equal(at(DROPDOWN_MODES.stateBound, STATE_BOUND.TANH), 'Tanh');
  assert.equal(at(DROPDOWN_MODES.activation, ACTIVATION.SIN), 'Sin');
  assert.equal(at(DROPDOWN_MODES.perception, PERCEPTION.LEARNED), 'Learned');
  assert.equal(at(DROPDOWN_MODES.displayMode, DISPLAY.CHANNEL), 'Channel');
});

test('the FIRST SEED control is the mutation seed, which Reroll Mutations moves', () => {
  const seed = seedSetting();
  assert.ok(seed !== null);
  assert.equal(seed.field, 'mutationSeed');
  assert.equal(seed.source, CONFIG);
  // The run seed is a SEED too, with its own Randomize button.
  assert.ok(SETTINGS.some((s) => s.kind === SEED && s.field === 'icSeed'));
});

test('architecture fields are typed inputs, so a drag cannot truncate the network', () => {
  for (const field of ['channels', 'hidden', 'learnedKernels']) {
    assert.equal(settingFor(CONFIG, field)?.kind, INPUT, field);
  }
});

test('grouped preserves declaration order, omits empty groups, and filters by source', () => {
  const advanced = grouped(true, [CONFIG, WORLD]);
  // 'Mutation' is absent: both its members are `panel: false`.
  assert.deepEqual(
    advanced.map(([name]) => name),
    ['Cohorts', 'Dynamics', 'Architecture', 'Initial Conditions', 'Display'],
  );
  for (const [, settings] of grouped(false, [CONFIG, WORLD, PREFS])) {
    assert.ok(settings.length > 0, 'an empty group must be omitted, not rendered');
  }
  for (const [, settings] of grouped(true, [PREFS])) {
    assert.ok(settings.every((s) => s.source === PREFS));
  }
  assert.equal(bySource(SETTINGS, WORLD).length, 7);
});

test('outsideMinMagnitude passes everything through for a setting with no floor', () => {
  const plain = settingFor(CONFIG, 'gain');
  assert.ok(plain !== null);
  assert.equal(outsideMinMagnitude(plain, 0), 0);
  assert.equal(outsideMinMagnitude(plain, -1), -1);
});
