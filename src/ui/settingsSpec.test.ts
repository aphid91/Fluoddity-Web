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
  seedSetting,
  settingFor,
  visible,
} from './settingsSpec.ts';
import {
  BC,
  IC,
  makeSimulationConfig,
  makeWorldSettings,
} from '../particleSystem/config.ts';
import { DEFAULT_PREFERENCES } from '../prefs/preferences.ts';

/** A fully-populated config, so `in` sees every optional field. */
const CONFIG_FIELDS = new Set(
  Object.keys(
    makeSimulationConfig({
      cohorts: 1,
      mutationSeed: 0,
      sensorGain: 0,
      sensorAngle: 0,
      sensorDistance: 0,
      mutationScale: 0,
      globalForceMult: 0,
      drag: 0,
      strafePower: 0,
      axialForce: 0,
      lateralForce: 0,
      hazardRate: 0,
    }),
  ),
);
const WORLD_FIELDS = new Set(Object.keys(makeWorldSettings()));
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

test('the registry has the same 35 entries the desktop does, plus the web-only ones', () => {
  // A count rather than a list: the point is that porting dropped none of them.
  //
  // WEB-ONLY ENTRIES ARE SUBTRACTED RATHER THAN FOLDED INTO THE TOTAL, so this
  // keeps asserting what it was written to assert -- that the port carried all
  // 35 desktop settings across. Bumping the literal to 36 instead would have
  // quietly converted it into "the registry has however many it has", which
  // catches nothing. A setting with no desktop counterpart goes in the list.
  const WEB_ONLY = [
    // No desktop equivalent: the desktop has no cohort highlight and no
    // click-to-select reset to govern.
    'resetOnBehaviorChange',
    'oneClickSelection',
  ];
  const ported = SETTINGS.filter((s) => !WEB_ONLY.includes(s.field));
  assert.equal(ported.length, 35);

  // The names in WEB_ONLY must actually be in the registry, or a rename would
  // silently subtract nothing and the count above would drift.
  for (const field of WEB_ONLY) {
    assert.ok(
      SETTINGS.some((s) => s.field === field),
      `${field} is listed as web-only but is not in the registry`,
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

test('boundary dropdown order matches the BC_* constants', () => {
  // Each label's INDEX is the value uploaded to the GPU. A reorder here changes
  // what every saved config means, with no error anywhere.
  const modes = DROPDOWN_MODES.boundaryConditions;
  assert.equal(modes.indexOf('Bounce'), BC.BOUNCE);
  assert.equal(modes.indexOf('Wrap'), BC.WRAP);
  assert.equal(modes.indexOf('Reset'), BC.RESET);
  assert.equal(modes.length, 3);
});

test('initial-conditions dropdown order matches the IC_* constants', () => {
  const modes = DROPDOWN_MODES.initialConditions;
  assert.equal(modes.indexOf('Grid'), IC.GRID);
  assert.equal(modes.indexOf('Random'), IC.RANDOM);
  assert.equal(modes.indexOf('Center'), IC.CENTER);
  assert.equal(modes.indexOf('Ring'), IC.RING);
  assert.equal(modes.length, 4);
});

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

test('the two non-default gate bases are the ones the desktop records', () => {
  // Named explicitly because both are easy to "tidy" to zero, and both would
  // then gate at a value the slider never reaches.
  const byLabel = (label: string): Setting => {
    const found = SETTINGS.find((s) => s.label === label);
    assert.ok(found !== undefined, `no setting labelled ${label}`);
    return found;
  };
  assert.equal(byLabel('Motion Blur').gateBase, 1.0);
  assert.equal(byLabel('Trail Stiffness').gateBase, 1.0);
  assert.equal(byLabel('Trail Stiffness').inverted, true);
});

test('the curved control is Hazard Rate, cubed', () => {
  // The only entry with a non-linear slider. Its travel shape is what makes the
  // bottom few percent usable, and Step 10 needs it to still be here.
  const curved = SETTINGS.filter((s) => s.curve !== 1.0);
  assert.equal(curved.length, 1);
  assert.equal(curved[0]!.label, 'Hazard Rate');
  assert.equal(curved[0]!.curve, 3.0);
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

test('there is exactly one SEED control and it is the mutation seed', () => {
  // Looked up by KIND rather than by field name, so the field name lives in
  // exactly one place (`settings_commands.py:114-124`).
  assert.equal(SETTINGS.filter((s) => s.kind === SEED).length, 1);
  const seed = seedSetting();
  assert.ok(seed !== null);
  assert.equal(seed.field, 'mutationSeed');
  assert.equal(seed.source, CONFIG);
});

test('basic is a strict subset of advanced', () => {
  const basic = visible(false);
  const all = visible(true);
  // NOT `SETTINGS.length`: `visible()` also drops `panel: false` entries, whose
  // widget is built somewhere the registry does not reach. See the next test.
  assert.equal(all.length, SETTINGS.filter((s) => s.panel).length);
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

test('grouped preserves declaration order and omits empty groups', () => {
  // Groups come out in the order their first member appears, and a group whose
  // members are all Advanced disappears in Basic mode rather than rendering
  // empty (`settings_spec.py:429-446`).
  const advanced = grouped(true, [CONFIG, WORLD, PREFS]);
  // 'Mutation' is absent, and that is the point: both its members are
  // `panel: false`, so the group empties itself through `visible()` and is
  // omitted for exactly the same reason an all-Advanced group is in Basic.
  // 'Behavior' is LAST because its one member is declared last, which is how
  // "Reset on Behavior Change" ends up at the bottom of the Preferences panel.
  // That placement is the reason it is a group of its own, so it is pinned here.
  assert.deepEqual(
    advanced.map(([name]) => name),
    ['Population', 'Sensors', 'Forces', 'Trails', 'Appearance',
     'Advanced', 'Simulation', 'Display', 'Behavior'],
  );
  // 'Trails' holds one ADVANCED entry, so Basic must not render it.
  const basic = grouped(false, [CONFIG, WORLD, PREFS]);
  assert.ok(!basic.map(([name]) => name).includes('Trails'));
  for (const [, settings] of basic) {
    assert.ok(settings.length > 0, 'an empty group must be omitted, not rendered');
  }
});

test('grouped filters by source', () => {
  const prefsOnly = grouped(true, [PREFS]);
  for (const [, settings] of prefsOnly) {
    assert.ok(settings.every((s) => s.source === PREFS));
  }
  assert.equal(bySource(SETTINGS, WORLD).length, 3);
});
