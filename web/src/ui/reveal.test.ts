/**
 * The reveal resolver, and the GATES checkbox's derived state.
 *
 * ## The failure the resolution test exists to catch
 *
 * `revealsOn` is a plain string in a data table, so **the compiler cannot check
 * it** -- exactly the hazard `settingsSpec.test.ts` was written for on `field`.
 * A typo'd `revealsOn` produces a control that is hidden forever: it never
 * renders, nothing throws, and nothing logs. The only way to notice is for
 * someone to go looking for a slider they remember existing.
 *
 * `every revealsOn resolves to a real gate or a real field` is that check. It is
 * the reason resolution is eager rather than lazy.
 *
 * ## And the derivation
 *
 * A GATES checkbox stores nothing -- it is `field: ''` -- so its ticked state is
 * DERIVED from the fields it gates, plus the `forced` override. Both halves are
 * load-bearing and fail in opposite directions: without the derivation a config
 * that uses gravity opens with the box unticked and its sliders hidden; without
 * the override, ticking the box does nothing visible because everything it
 * reveals is still zero.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  type Setting,
  type Source,
  BOOL,
  CONFIG,
  PREFS,
  SETTINGS,
  WORLD,
} from './settingsSpec.ts';
import { GateState, gateByLabel, settingFor } from './gateState.ts';
import {
  fieldsToClear,
  gateChecked,
  gateOpen,
  gateSettings,
  isRevealed,
  revealOf,
} from './reveal.ts';

/** A `SourceValues` over three plain records. */
function sources(
  config: Record<string, number | boolean> = {},
  world: Record<string, number | boolean> = {},
  prefs: Record<string, number | boolean> = {},
) {
  return (source: Source) => {
    if (source === CONFIG) return config;
    if (source === WORLD) return world;
    return prefs;
  };
}

const gravity = gateSettings().find((s) => s.label === 'Gravity')!;

// --- resolution ------------------------------------------------------------

/** The load-bearing one. See the file header. */
test('every revealsOn resolves to a real gate or a real field', () => {
  for (const setting of SETTINGS) {
    if (setting.revealsOn === '') continue;
    const reveal = revealOf(setting);
    assert.notEqual(
      reveal.kind,
      'none',
      `${setting.label}: revealsOn "${setting.revealsOn}" resolved to nothing`,
    );
    if (reveal.kind === 'field') {
      // A field form must name a real BOOL on the SAME source, or it can never
      // be true and the control is hidden forever.
      const owner = settingFor(setting.source, reveal.field);
      assert.ok(
        owner !== null,
        `${setting.label}: revealsOn "${reveal.field}" is not a field on ${setting.source}`,
      );
      assert.equal(
        owner.kind,
        BOOL,
        `${setting.label}: revealsOn "${reveal.field}" is not a checkbox`,
      );
    }
  }
});

test('a setting with no revealsOn resolves to none', () => {
  const plain = SETTINGS.find((s) => s.revealsOn === '')!;
  assert.equal(revealOf(plain).kind, 'none');
});

test('the two forms are both present in the registry', () => {
  const kinds = SETTINGS.filter((s) => s.revealsOn !== '').map((s) => revealOf(s).kind);
  assert.ok(kinds.includes('gate'), 'no entry hangs off a GATES label');
  assert.ok(kinds.includes('field'), 'no entry hangs off a real bool field');
});

test('the bloom trio hangs off a real field', () => {
  for (const field of ['bloomThreshold', 'bloomIntensity', 'bloomRadius']) {
    const setting = SETTINGS.find((s) => s.field === field)!;
    const reveal = revealOf(setting);
    assert.equal(reveal.kind, 'field');
    assert.equal(reveal.kind === 'field' ? reveal.field : '', 'bloomEnabled');
  }
});

test('the gravity trio hangs off the Gravity gate', () => {
  for (const field of ['gravityStrafe', 'gravityForce', 'radialGravity']) {
    const setting = SETTINGS.find((s) => s.field === field)!;
    const reveal = revealOf(setting);
    assert.equal(reveal.kind, 'gate', field);
    assert.equal(reveal.kind === 'gate' ? reveal.gate.label : '', 'Gravity');
  }
});

test('gateByLabel finds only GATES entries', () => {
  assert.equal(gateByLabel('Gravity')?.field, '');
  // A real control's label must not resolve as a gate, or a `revealsOn` naming
  // a field would silently take the gate arm.
  assert.equal(gateByLabel('Sensor Angle'), null);
  assert.equal(gateByLabel(''), null);
});

test('there is exactly one GATES entry and it owns no field', () => {
  const gates = gateSettings();
  assert.equal(gates.length, 1);
  assert.equal(gates[0]!.field, '');
  assert.deepEqual([...gates[0]!.gates], ['gravityStrafe', 'gravityForce']);
});

// --- derivation ------------------------------------------------------------

test('a gate is open when any field it covers is non-zero', () => {
  assert.ok(gateOpen(gravity, sources({ gravityStrafe: 0.5, gravityForce: 0 })));
  assert.ok(gateOpen(gravity, sources({ gravityStrafe: 0, gravityForce: -0.2 })));
  assert.ok(!gateOpen(gravity, sources({ gravityStrafe: 0, gravityForce: 0 })));
});

/** Bipolar sliders pass through zero between real values. */
test('a gate uses exact zero, not a tolerance', () => {
  assert.ok(gateOpen(gravity, sources({ gravityStrafe: 1e-12 })));
  assert.ok(gateOpen(gravity, sources({ gravityStrafe: -1e-12 })));
});

test('a missing value counts as zero rather than throwing', () => {
  assert.ok(!gateOpen(gravity, sources({})));
});

test('forced holds a gate open while everything it gates is still zero', () => {
  const state = new GateState();
  const values = sources({ gravityStrafe: 0, gravityForce: 0 });
  assert.ok(!gateChecked(gravity, values, state));
  state.forced.add('Gravity');
  assert.ok(gateChecked(gravity, values, state));
});

test('sync retires a forced gate once its values speak for themselves', () => {
  const state = new GateState();
  const identity = { projectName: 'p', selectedConfig: 0 };
  state.sync(identity, () => false);
  state.forced.add('Gravity');

  // Still zero: the override is still doing work.
  state.sync(identity, () => false);
  assert.ok(state.forced.has('Gravity'));

  // Now non-zero: the derivation says open on its own, so the override goes.
  state.sync(identity, () => true);
  assert.ok(!state.forced.has('Gravity'));
});

test('sync drops everything when the project changes', () => {
  const state = new GateState();
  state.sync({ projectName: 'a', selectedConfig: 0 }, () => false);
  state.forced.add('Gravity');
  state.sessions.add('config.hazardRate');

  state.sync({ projectName: 'b', selectedConfig: 0 }, () => false);
  assert.equal(state.forced.size, 0);
  assert.equal(state.sessions.size, 0);
});

test('sync drops everything when the selected config changes', () => {
  const state = new GateState();
  state.sync({ projectName: 'a', selectedConfig: 0 }, () => false);
  state.forced.add('Gravity');

  state.sync({ projectName: 'a', selectedConfig: 1 }, () => false);
  assert.equal(state.forced.size, 0);
});

// --- visibility ------------------------------------------------------------

test('a control with no revealsOn is always visible', () => {
  const plain = SETTINGS.find((s) => s.field === 'sensorAngle')!;
  assert.ok(isRevealed(plain, sources({}), new GateState()));
});

test('a field-gated control follows its checkbox', () => {
  const threshold = SETTINGS.find((s) => s.field === 'bloomThreshold')!;
  const state = new GateState();
  assert.ok(!isRevealed(threshold, sources({}, {}, { bloomEnabled: false }), state));
  assert.ok(isRevealed(threshold, sources({}, {}, { bloomEnabled: true }), state));
});

/** The payload is empty while the panel is closed. */
test('a missing governing value hides rather than reveals', () => {
  const threshold = SETTINGS.find((s) => s.field === 'bloomThreshold')!;
  assert.ok(!isRevealed(threshold, sources({}, {}, {}), new GateState()));
});

test('a gate-gated control follows the derived checkbox', () => {
  const strafe = SETTINGS.find((s) => s.field === 'gravityStrafe')!;
  const state = new GateState();
  assert.ok(!isRevealed(strafe, sources({ gravityStrafe: 0, gravityForce: 0 }), state));
  assert.ok(isRevealed(strafe, sources({ gravityStrafe: 0.4, gravityForce: 0 }), state));
});

/**
 * The case the desktop comment calls out: ticking the box is exactly when every
 * gated value is still zero, so the override has to reach the MEMBERS too.
 */
test('forcing a gate reveals its members while they are all still zero', () => {
  const strafe = SETTINGS.find((s) => s.field === 'gravityStrafe')!;
  const state = new GateState();
  const values = sources({ gravityStrafe: 0, gravityForce: 0 });
  assert.ok(!isRevealed(strafe, values, state));
  state.forced.add('Gravity');
  assert.ok(isRevealed(strafe, values, state));
});

test('a config carrying gravity opens with the box already showing', () => {
  const strafe = SETTINGS.find((s) => s.field === 'gravityStrafe')!;
  // No forced entry, no session -- a freshly loaded config, nothing else.
  const state = new GateState();
  assert.ok(isRevealed(strafe, sources({ gravityStrafe: -0.3 }), state));
});

// --- clearing --------------------------------------------------------------

test('unticking clears only the non-zero fields', () => {
  const values = sources({ gravityStrafe: 0.5, gravityForce: 0 });
  const toClear = fieldsToClear(gravity, values);
  assert.deepEqual(
    toClear.map((s) => s.field),
    ['gravityStrafe'],
  );
});

test('unticking an already-empty gate clears nothing', () => {
  const values = sources({ gravityStrafe: 0, gravityForce: 0 });
  assert.equal(fieldsToClear(gravity, values).length, 0);
});

test('every field a gate names resolves to a real setting', () => {
  for (const gate of gateSettings()) {
    for (const field of gate.gates) {
      const member: Setting | null = settingFor(gate.source, field);
      assert.ok(member !== null, `${gate.label} gates unknown field "${field}"`);
    }
  }
});

test('settingFor is keyed on both source and field', () => {
  // `trailDiffusion` is WORLD; asking CONFIG for it must not find it.
  assert.equal(settingFor(WORLD, 'trailDiffusion')?.label, 'Trail Stiffness');
  assert.equal(settingFor(CONFIG, 'trailDiffusion'), null);
  assert.equal(settingFor(PREFS, 'trailDiffusion'), null);
});
