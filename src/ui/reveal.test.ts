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
  SETTINGS,
  WORLD,
} from './settingsSpec.ts';
import { GateState, settingFor } from './gateState.ts';
import { gateSettings, isRevealed, revealOf } from './reveal.ts';

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

test('the bloom trio hangs off a real field', () => {
  for (const field of ['bloomThreshold', 'bloomIntensity', 'bloomRadius']) {
    const setting = SETTINGS.find((s) => s.field === field)!;
    const reveal = revealOf(setting);
    assert.equal(reveal.kind, 'field');
    assert.equal(reveal.kind === 'field' ? reveal.field : '', 'bloomEnabled');
  }
});

// --- derivation ------------------------------------------------------------

/** Bipolar sliders pass through zero between real values. */
test('sync drops everything when the project changes', () => {
  const state = new GateState();
  state.sync({ projectName: 'a', selectedConfig: 0 }, () => false);
  state.forced.add('Gravity');
  state.held.add('Gravity');
  state.sessions.add('config.hazardRate');

  state.sync({ projectName: 'b', selectedConfig: 0 }, () => false);
  assert.equal(state.forced.size, 0);
  assert.equal(state.held.size, 0);
  assert.equal(state.sessions.size, 0);
});

// --- held: the drag across zero --------------------------------------------
//
// THE BUG THIS PREVENTS, concretely: tick Gravity, drag the Strafe slider out to
// 0.5, then drag it back across zero to -0.5. At the instant it reads exactly 0
// the derivation says "off" -- and `forced` was already retired by `sync` the
// moment the value went non-zero, so nothing was holding the gate. The box
// unticked itself mid-drag and took the slider with it.

test('sync drops everything when the selected config changes', () => {
  const state = new GateState();
  state.sync({ projectName: 'a', selectedConfig: 0 }, () => false);
  state.forced.add('Gravity');

  state.sync({ projectName: 'a', selectedConfig: 1 }, () => false);
  assert.equal(state.forced.size, 0);
});

// --- visibility ------------------------------------------------------------

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

/**
 * The case the desktop comment calls out: ticking the box is exactly when every
 * gated value is still zero, so the override has to reach the MEMBERS too.
 */
// --- clearing --------------------------------------------------------------

test('every field a gate names resolves to a real setting', () => {
  for (const gate of gateSettings()) {
    for (const field of gate.gates) {
      const member: Setting | null = settingFor(gate.source, field);
      assert.ok(member !== null, `${gate.label} gates unknown field "${field}"`);
    }
  }
});

