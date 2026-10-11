/**
 * Slider arithmetic: the round trips, and the two entries that compose.
 *
 * ## The failure these exist to catch
 *
 * `position`/`valueAt` and `shown`/`stored` are INVERSE PAIRS, and each pair is
 * applied on opposite sides of a widget: one converts the stored value into
 * something to draw, the other converts what the user dragged back into
 * something to store. **Applying one without the other silently rewrites the
 * value every time the control is touched** -- a Trail Stiffness slider that
 * reads inverted and writes uninverted would flip the stored diffusion on every
 * drag, and every saved config would quietly mean something else.
 *
 * That is invisible on screen. The slider moves, the number changes, the
 * simulation responds. So the round trip is asserted for EVERY entry rather
 * than for the two that use these fields today -- a future `curve` or
 * `inverted` on any other entry inherits the coverage rather than needing to
 * remember it.
 *
 * ## And the nudge
 *
 * `nudged` has one hard requirement: it must land STRICTLY outside the off zone,
 * because `isOff` tests `<=`. A nudge that lands inside means ticking the
 * checkbox re-derives as "off" in the same frame and the control never opens --
 * a checkbox that visibly does nothing. Asserted for all six gated entries, and
 * the `gateBase: 1.0` pair are why the step direction is conditional at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  type Setting,
  GATED,
  GATED_INT,
  SETTINGS,
} from './settingsSpec.ts';
import {
  isGated,
  isOff,
  nudged,
  position,
  shown,
  stored,
  valueAt,
} from './gating.ts';

/** Numeric entries only: BOOL/CHOICE/SEED have no travel to speak of. */
const NUMERIC = SETTINGS.filter((s) => s.hi > s.lo);

/** Eleven evenly-spaced positions, ends included. */
const SAMPLES = Array.from({ length: 11 }, (_, i) => i / 10);

test('valueAt inverts position, for every entry', () => {
  for (const setting of NUMERIC) {
    for (const pos of SAMPLES) {
      const roundTripped = position(setting, valueAt(setting, pos));
      assert.ok(
        Math.abs(roundTripped - pos) < 1e-9,
        `${setting.label}: position(valueAt(${pos})) = ${roundTripped}`,
      );
    }
  }
});

test('position inverts valueAt, for every entry', () => {
  for (const setting of NUMERIC) {
    const span = setting.hi - setting.lo;
    for (const pos of SAMPLES) {
      const value = setting.lo + span * pos;
      const roundTripped = valueAt(setting, position(setting, value));
      assert.ok(
        Math.abs(roundTripped - value) < 1e-9 * Math.max(1, Math.abs(value)),
        `${setting.label}: valueAt(position(${value})) = ${roundTripped}`,
      );
    }
  }
});

test('stored inverts shown, for every entry', () => {
  for (const setting of NUMERIC) {
    const span = setting.hi - setting.lo;
    for (const pos of SAMPLES) {
      const value = setting.lo + span * pos;
      const roundTripped = stored(setting, shown(setting, value));
      assert.ok(
        Math.abs(roundTripped - value) < 1e-9 * Math.max(1, Math.abs(value)),
        `${setting.label}: stored(shown(${value})) = ${roundTripped}`,
      );
    }
  }
});

test('shown is the identity unless inverted', () => {
  for (const setting of NUMERIC) {
    if (setting.inverted) continue;
    assert.equal(shown(setting, setting.lo), setting.lo);
    assert.equal(shown(setting, setting.hi), setting.hi);
  }
});

/**
 * THE COMPOSITION AT THE CALL SITE, which the round trips above do NOT cover.
 *
 * `controls.ts` maps a stored value to a handle position and to a readout
 * string, and both must go through `shown` first. The round-trip tests pass
 * whether or not it does, because each pair is self-consistent in isolation --
 * so this asserts the actual chain instead.
 *
 * Caught a real bug: the readout printed the STORED value while the handle used
 * the DISPLAY one, so Trail Stiffness showed "1.0000" under a handle sitting at
 * 0.0. The control looked broken while behaving correctly.
 */
// --- the gated six ---------------------------------------------------------

const GATED_SETTINGS = SETTINGS.filter((s) => isGated(s));

// Cohort Fences was the sixth. It is a plain BOOL now: its radius is derived
// from the cohort count rather than dialled, so there is no slider left to gate.
test('a gated control reads as off at exactly its base', () => {
  for (const setting of GATED_SETTINGS) {
    assert.ok(
      isOff(setting, setting.gateBase),
      `${setting.label} is not off at its own base`,
    );
  }
});

/** The load-bearing one. See the file header. */
test('nudged lands strictly outside the off zone', () => {
  for (const setting of GATED_SETTINGS) {
    const value = nudged(setting);
    assert.ok(
      !isOff(setting, value),
      `${setting.label}: nudged() = ${value} still reads as off`,
    );
  }
});

test('nudged stays inside the slider bounds', () => {
  for (const setting of GATED_SETTINGS) {
    const value = nudged(setting);
    assert.ok(
      value >= setting.lo && value <= setting.hi,
      `${setting.label}: nudged() = ${value} is outside [${setting.lo}, ${setting.hi}]`,
    );
  }
});

test('a base at hi steps DOWN, a base at lo steps up', () => {
  for (const setting of GATED_SETTINGS) {
    const basePos = position(setting, setting.gateBase);
    const nudgedPos = position(setting, nudged(setting));
    if (basePos <= 0.5) {
      assert.ok(nudgedPos > basePos, `${setting.label} should step up`);
    } else {
      assert.ok(nudgedPos < basePos, `${setting.label} should step down`);
    }
  }
});

test('Motion Blur is the integer gate and compares exactly', () => {
  const setting = GATED_SETTINGS.find((s) => s.field === 'motionBlurSamples')!;
  assert.equal(setting.kind, GATED_INT);
  assert.equal(setting.gateBase, 1.0);
  // 1 sample IS blur switched off, so there is no separate enable flag.
  assert.ok(isOff(setting, 1));
  assert.ok(!isOff(setting, 2));
  // No "nearly 1 sample": exact comparison, via rounding.
  assert.ok(isOff(setting, 1.4));
  assert.equal(nudged(setting), 2);
});

test('gated controls that are not integers use the default epsilon', () => {
  for (const setting of GATED_SETTINGS) {
    assert.equal(setting.gateEpsilon, 1e-4, setting.label);
  }
});

test('isGated matches exactly the GATED and GATED_INT kinds', () => {
  for (const setting of SETTINGS) {
    const expected = setting.kind === GATED || setting.kind === GATED_INT;
    assert.equal(isGated(setting), expected, setting.label);
  }
});

test('a zero-span setting does not produce NaN', () => {
  const degenerate: Setting = { ...NUMERIC[0]!, lo: 1, hi: 1 };
  assert.equal(position(degenerate, 1), 0);
  assert.ok(Number.isFinite(valueAt(degenerate, 0.5)));
});
