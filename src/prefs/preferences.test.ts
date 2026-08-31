/**
 * Preferences: the coercion map, and `load()`'s promise never to throw.
 *
 * ## Why the storage is faked rather than mocked out
 *
 * `localStorage` does not exist under `node --test`, which is exactly why
 * `loadPreferences` and `savePreferences` take a storage object. Faking it also
 * makes the two failure modes testable rather than merely asserted: a store
 * that THROWS (Safari private mode) and a store holding CORRUPT text (a
 * hand-edited entry, or a half-written one).
 *
 * That second case is the one worth caring about. A corrupt entry in
 * `localStorage` **outlives a page reload**, so a `load()` that threw would
 * make the app permanently unstartable until the user cleared site data by
 * hand. The desktop's equivalent risk is smaller -- a bad `preferences.json`
 * can be deleted with a file manager.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  type PreferenceStorage,
  DEFAULT_PREFERENCES,
  PREFERENCE_KEYS,
  PREFERENCE_KINDS,
  STORAGE_KEY,
  coerce,
  fieldStrengthsFor,
  isPreferenceKey,
  loadPreferences,
  requiresRestart,
  savePreferences,
  withValue,
} from './preferences.ts';
import { DEFAULT_FIELD_STRENGTHS } from '../particleSystem/uniforms.ts';

/** A `localStorage` stand-in over a plain map. */
function fakeStorage(initial: string | null = null): PreferenceStorage & { value: string | null } {
  return {
    value: initial,
    getItem(key: string): string | null {
      return key === STORAGE_KEY ? this.value : null;
    },
    setItem(key: string, value: string): void {
      if (key === STORAGE_KEY) this.value = value;
    },
  };
}

/** A store that throws from both methods, as a disabled one does. */
const hostileStorage: PreferenceStorage = {
  getItem(): string | null {
    throw new Error('SecurityError: storage is disabled');
  },
  setItem(): void {
    throw new Error('QuotaExceededError');
  },
};

// ---------------------------------------------------------------------------
// Coercion -- the explicit type map the plan asks for
// ---------------------------------------------------------------------------

test('every preference has a declared kind', () => {
  // The `satisfies` clause enforces this at compile time; asserting it at
  // runtime too catches a default added without a kind, which `satisfies` on a
  // partial object would not.
  for (const key of Object.keys(DEFAULT_PREFERENCES)) {
    assert.ok(isPreferenceKey(key), `${key} has no declared kind`);
  }
  assert.equal(PREFERENCE_KEYS.length, Object.keys(DEFAULT_PREFERENCES).length);
});

test('int preferences truncate rather than round', () => {
  // A slider handing back 30.7 must become 30 sub-steps, not 31. The desktop
  // gets this from `int()`, which truncates.
  assert.equal(coerce('physicsSteps', 30.7), 30);
  assert.equal(coerce('motionBlurSamples', 8.9), 8);
  assert.equal(coerce('physicsSteps', -2.5), -2);
});

test('bool preferences reject numbers, and floats reject booleans', () => {
  // The specific bug `drawing_commands.py:110` records in reverse: a blanket
  // float() lands `1.0` where `true` belongs. Here the map keeps them apart in
  // both directions.
  assert.equal(coerce('bloomEnabled', 1), null);
  assert.equal(coerce('bloomEnabled', true), true);
  assert.equal(coerce('brightness', true), null);
});

test('non-finite numbers are rejected', () => {
  // A NaN brightness is not a visible mistake -- it propagates through the
  // assembler into a black screen with no error anywhere.
  assert.equal(coerce('brightness', NaN), null);
  assert.equal(coerce('brightness', Infinity), null);
  assert.equal(coerce('physicsSteps', NaN), null);
});

// ---------------------------------------------------------------------------
// load(): never throws
// ---------------------------------------------------------------------------

test('an absent store gives the defaults', () => {
  assert.deepEqual(loadPreferences(null), DEFAULT_PREFERENCES);
});

test('an empty store gives the defaults', () => {
  assert.deepEqual(loadPreferences(fakeStorage()), DEFAULT_PREFERENCES);
});

test('corrupt JSON gives the defaults rather than throwing', () => {
  assert.deepEqual(loadPreferences(fakeStorage('{not json')), DEFAULT_PREFERENCES);
});

test('a non-object payload gives the defaults', () => {
  assert.deepEqual(loadPreferences(fakeStorage('[1,2,3]')), DEFAULT_PREFERENCES);
  assert.deepEqual(loadPreferences(fakeStorage('null')), DEFAULT_PREFERENCES);
  assert.deepEqual(loadPreferences(fakeStorage('42')), DEFAULT_PREFERENCES);
});

test('a store that throws gives the defaults rather than propagating', () => {
  assert.deepEqual(loadPreferences(hostileStorage), DEFAULT_PREFERENCES);
});

test('unknown keys are dropped so a downgrade survives', () => {
  // A newer version wrote a field this build has never heard of. Dropping it
  // is what keeps the rest of the file usable (`preferences.py:112-113`).
  const stored = loadPreferences(
    fakeStorage(JSON.stringify({ brightness: 2.5, futureSetting: 'whatever' })),
  );
  assert.equal(stored.brightness, 2.5);
  assert.equal((stored as unknown as Record<string, unknown>)['futureSetting'], undefined);
});

test('known keys of the wrong type fall back to their default', () => {
  // The port validates where the Python does not: a hand-edited
  // `"physicsSteps": "lots"` reaches a uniform as NaN and freezes the screen.
  const stored = loadPreferences(
    fakeStorage(JSON.stringify({ physicsSteps: 'lots', brightness: 2.0 })),
  );
  assert.equal(stored.physicsSteps, DEFAULT_PREFERENCES.physicsSteps);
  assert.equal(stored.brightness, 2.0, 'one bad key must not discard the good ones');
});

test('stored values round-trip through save and load', () => {
  const storage = fakeStorage();
  const edited = withValue(DEFAULT_PREFERENCES, 'bloomEnabled', true);
  savePreferences(edited, storage);
  assert.deepEqual(loadPreferences(storage), edited);
});

test('save on a hostile store does not throw', () => {
  // Losing the ability to PERSIST a preference must not lose the ability to
  // SET one -- the in-memory value is already adopted by this point.
  assert.doesNotThrow(() => {
    savePreferences(DEFAULT_PREFERENCES, hostileStorage);
  });
});

// ---------------------------------------------------------------------------
// withValue: reference identity, same contract as Project's mutators
// ---------------------------------------------------------------------------

test('withValue returns the receiver when nothing changed', () => {
  // Not an optimization: a slider reports "changed" on frames where the value
  // did not move, and each of those would otherwise be a localStorage write
  // (`drawing_commands.py:107-110`).
  const prefs = DEFAULT_PREFERENCES;
  assert.equal(withValue(prefs, 'brightness', prefs.brightness), prefs);
  // DERIVED FROM THE DEFAULT, not a literal: the point is that a fractional
  // value truncating onto the CURRENT int is a no-op, and a hardcoded probe
  // stops testing that the moment someone changes the default out from under it.
  assert.equal(
    withValue(prefs, 'physicsSteps', prefs.physicsSteps + 0.4),
    prefs,
    'truncates to the same int',
  );
});

test('withValue returns the receiver for an unknown or unusable value', () => {
  const prefs = DEFAULT_PREFERENCES;
  assert.equal(withValue(prefs, 'noSuchPreference', 1), prefs);
  assert.equal(withValue(prefs, 'brightness', NaN), prefs);
  assert.equal(withValue(prefs, 'bloomEnabled', 1), prefs);
});

test('withValue returns a new object for a real change', () => {
  const prefs = DEFAULT_PREFERENCES;
  // DERIVED FROM THE DEFAULT, for the reason the truncation case above gives.
  // This test hardcoded `2.0` and asserted the original still read `1.0` -- so
  // it broke the day the default brightness BECAME 2.0, and it broke by
  // asserting the opposite of the contract: setting a preference to the value it
  // already holds is a no-op, and `withValue` correctly returned the receiver.
  // The probe has to be a value the default is not, whatever the default is.
  const before = prefs.brightness;
  const changed = before + 1.0;
  const next = withValue(prefs, 'brightness', changed);
  assert.notEqual(next, prefs);
  assert.equal(next.brightness, changed);
  assert.equal(prefs.brightness, before, 'the original must be untouched');
});

// ---------------------------------------------------------------------------
// requiresRestart
// ---------------------------------------------------------------------------

test('only world size and canvas aspect require a rebuild', () => {
  // These two determine the GPU allocation, which is why they are typed INPUTs
  // rather than sliders -- dragging would rebuild on every frame of the drag.
  const prefs = DEFAULT_PREFERENCES;
  assert.equal(requiresRestart(prefs, withValue(prefs, 'worldSize', 2.0)), true);
  assert.equal(requiresRestart(prefs, withValue(prefs, 'canvasAspect', 1.5)), true);
  assert.equal(requiresRestart(prefs, withValue(prefs, 'brightness', 2.0)), false);
  assert.equal(requiresRestart(prefs, withValue(prefs, 'physicsSteps', 60)), false);
});

test('the per-panel tiers persist, default to Basic, and are independent', () => {
  // They are view state, but they are SAVED view state -- unlike the single
  // global tier they replaced, which deliberately reset each session. A
  // per-panel choice is a lasting statement about how you work, and re-ticking
  // three boxes every reload is worse than starting where you left off.
  const prefs = DEFAULT_PREFERENCES;
  assert.equal(prefs.advancedProject, false, 'first run is Basic');
  assert.equal(prefs.advancedPreferences, false, 'first run is Basic');
  assert.equal(prefs.advancedDrawing, false, 'first run is Basic');

  // Independence is the whole point of there being three: setting one must not
  // disturb the others. That is what the old global tier could not do.
  const next = withValue(prefs, 'advancedDrawing', true);
  assert.equal(next.advancedDrawing, true);
  assert.equal(next.advancedProject, false);
  assert.equal(next.advancedPreferences, false);

  // A tier never reallocates the simulation.
  assert.equal(requiresRestart(prefs, next), false);

  // Round-trips through storage like any other preference.
  const storage = fakeStorage();
  savePreferences(next, storage);
  assert.equal(loadPreferences(storage).advancedDrawing, true);
});

test('the kind map covers exactly the preference keys', () => {
  // Guards the `satisfies` from the other direction: a kind declared for a
  // field that no longer exists would leave a control bound to nothing.
  assert.deepEqual(
    Object.keys(PREFERENCE_KINDS).sort(),
    Object.keys(DEFAULT_PREFERENCES).sort(),
  );
});

test('the default field strengths reproduce the gains that replaced constants', () => {
  // `DEFAULT_FIELD_STRENGTHS` restates these two numbers in `particleSystem/`,
  // which may not import `prefs/` (invariant 3: the simulation does not read the
  // editor's settings). THIS TEST IS WHAT KEEPS THE DUPLICATION HONEST -- a
  // retune of either gain that missed the other would leave the simulation
  // running one value until the Orchestrator's first push and another after it,
  // which looks like a one-frame flicker and reproduces on nothing.
  assert.deepEqual(fieldStrengthsFor(DEFAULT_PREFERENCES), DEFAULT_FIELD_STRENGTHS);
});

test('a walls strength of 1.0 is exactly the retired STRAFE_FIELD_GAIN', () => {
  // The whole promise of the default: a field painted before these sliders
  // existed must displace particles by precisely what it did then. 0.01 is the
  // constant that used to live in common.wgsl.
  assert.equal(fieldStrengthsFor(DEFAULT_PREFERENCES).walls, 0.01);
  // And the slider is linear in it, so 0 mutes and 4 is four times the old feel.
  const muted = { ...DEFAULT_PREFERENCES, wallsStrength: 0 };
  assert.equal(fieldStrengthsFor(muted).walls, 0);
  const loud = { ...DEFAULT_PREFERENCES, wallsStrength: 4 };
  assert.equal(fieldStrengthsFor(loud).walls, 0.04);
});

test('brushMode coerces like the index it is, not like a string', () => {
  // An INDEX into BRUSH_MODES, declared 'int' -- so a fractional value truncates
  // rather than landing a non-integer where an array lookup goes. The read side
  // (`brushModeFor`) is what handles an index past the end.
  assert.equal(coerce('brushMode', 2.7), 2);
  assert.equal(withValue(DEFAULT_PREFERENCES, 'brushMode', 3).brushMode, 3);
});
