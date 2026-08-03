/**
 * The gated control's visibility rule, and the session latch.
 *
 * `showsSlider` is the whole latch, expressed as one pure function:
 *
 *     show slider = value is off base  OR  a session is open on this control
 *
 * The DOM half -- which events open and close a session -- can only be checked
 * in a browser, and `tools/uiCheck.mjs` does that. What is testable here is the
 * rule itself, and the rule is where the interesting failures are:
 *
 *   - **without the session term**, a drag to the bottom folds the control away
 *     mid-gesture, because the value passes through the off zone long before
 *     the user lets go;
 *   - **without the value term**, a control whose config carries a real value
 *     opens as an unticked checkbox, hiding a setting that is doing something.
 *
 * Both are asserted below against all six gated entries rather than against one,
 * because the two `gateBase: 1.0` entries invert the direction of "off" and are
 * exactly the ones a rule written for the common case gets wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SETTINGS } from './settingsSpec.ts';
import { isGated, isOff, nudged } from './gating.ts';
import { showsSlider } from './gatedControl.ts';
import { settingKey } from './controls.ts';

const GATED_SETTINGS = SETTINGS.filter((s) => isGated(s));
const NO_SESSIONS: ReadonlySet<string> = new Set();

test('at base with no session, the checkbox shows', () => {
  for (const setting of GATED_SETTINGS) {
    assert.equal(
      showsSlider(setting, setting.gateBase, NO_SESSIONS),
      false,
      `${setting.label} should be folded at its base`,
    );
  }
});

test('off base with no session, the slider shows', () => {
  for (const setting of GATED_SETTINGS) {
    assert.equal(
      showsSlider(setting, nudged(setting), NO_SESSIONS),
      true,
      `${setting.label} should be open just off base`,
    );
  }
});

/**
 * THE REASON THE LATCH EXISTS. The value passes through the off zone during a
 * drag; without the session term the control folds away mid-gesture.
 */
test('at base WITH a session, the slider stays', () => {
  for (const setting of GATED_SETTINGS) {
    const sessions = new Set([settingKey(setting)]);
    assert.equal(
      showsSlider(setting, setting.gateBase, sessions),
      true,
      `${setting.label} folded away with a gesture in flight`,
    );
  }
});

test('a session on a DIFFERENT control does not hold this one open', () => {
  const [first, second] = GATED_SETTINGS;
  const sessions = new Set([settingKey(second!)]);
  assert.equal(showsSlider(first!, first!.gateBase, sessions), false);
});

test('the session key is the same string the DOM hook uses', () => {
  // Keeping these identical is what stops a session key and a `data-setting`
  // attribute drifting apart -- `uiCheck.mjs` finds a control by the latter and
  // reasons about the former.
  for (const setting of GATED_SETTINGS) {
    assert.equal(settingKey(setting), `${setting.source}.${setting.field}`);
  }
});

test('a config carrying a real value opens with the slider showing', () => {
  // The load-bearing property: on/off is derived from the value, so a loaded
  // config speaks for itself with nothing stored and no session open.
  const fences = GATED_SETTINGS.find((s) => s.field === 'cohortFences')!;
  assert.ok(showsSlider(fences, 0.5, NO_SESSIONS));

  const stiffness = GATED_SETTINGS.find((s) => s.field === 'trailDiffusion')!;
  // gateBase is 1.0 here, so 0.5 is OFF base and the slider must show.
  assert.ok(showsSlider(stiffness, 0.5, NO_SESSIONS));
  assert.ok(!showsSlider(stiffness, 1.0, NO_SESSIONS));
});

test('Motion Blur folds at 1 sample and opens at 2', () => {
  const blur = GATED_SETTINGS.find((s) => s.field === 'motionBlurSamples')!;
  assert.ok(!showsSlider(blur, 1, NO_SESSIONS));
  assert.ok(showsSlider(blur, 2, NO_SESSIONS));
});

test('showsSlider agrees with isOff wherever no session is open', () => {
  for (const setting of GATED_SETTINGS) {
    const span = setting.hi - setting.lo;
    for (let i = 0; i <= 10; i++) {
      const value = setting.lo + (span * i) / 10;
      assert.equal(
        showsSlider(setting, value, NO_SESSIONS),
        !isOff(setting, value),
        `${setting.label} at ${value}`,
      );
    }
  }
});
