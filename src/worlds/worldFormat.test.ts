import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WORLD_FORMAT_VERSION,
  WORLD_PREFERENCE_KEYS,
  WorldFormatError,
  applyWorldPreferences,
  defaultWorldPreferences,
  isWorldPreferenceKey,
  makeWorldDocument,
  readWorld,
} from './worldFormat.ts';
import { DEFAULT_PREFERENCES, type Preferences } from '../prefs/preferences.ts';
import { SLOT_COUNT } from '../sand/palette.ts';

/** A palette array with documents in a few scattered slots. */
function samplePalette(): { name: string; document: unknown | null }[] {
  const slots: { name: string; document: unknown | null }[] = Array.from(
    { length: SLOT_COUNT },
    () => ({ name: '', document: null }),
  );
  slots[0] = { name: 'Tangle', document: { version: 8, marker: 'master' } };
  slots[3] = { name: 'Sand', document: { version: 8, marker: 'three' } };
  slots[17] = { name: 'Smoke', document: { version: 8, marker: 'seventeen' } };
  return slots;
}

// ---------------------------------------------------------------------------
// THE SLOT INDEX.
//
// Every painted particle stores its swatch index as `config_index`, and the
// scene stamp stores those particles verbatim. A palette saved densely would
// renumber every material on load and every particle would point at the wrong
// one -- a world that looks like a colour bug rather than a malformed save.
// ---------------------------------------------------------------------------

test('a sparse palette keeps each material at its own slot', () => {
  const doc = makeWorldDocument({
    slots: samplePalette(),
    preferences: DEFAULT_PREFERENCES,
    visibleCount: 20,
  });
  assert.deepEqual(
    doc.slots.map((s) => s.slot),
    [0, 3, 17],
    'the indices must survive, not be compacted to 0,1,2',
  );
  assert.equal(doc.slots[1]?.name, 'Sand');
});

test('empty slots are dropped rather than written as nulls', () => {
  const doc = makeWorldDocument({
    slots: samplePalette(),
    preferences: DEFAULT_PREFERENCES,
    visibleCount: 20,
  });
  assert.equal(doc.slots.length, 3, 'only the filled slots are stored');
});

test('a slot index round-trips through read', () => {
  const doc = makeWorldDocument({
    slots: samplePalette(),
    preferences: DEFAULT_PREFERENCES,
    visibleCount: 20,
  });
  const back = readWorld(JSON.parse(JSON.stringify(doc)));
  assert.deepEqual(back.slots.map((s) => s.slot), [0, 3, 17]);
  assert.equal(back.slots[2]?.name, 'Smoke');
});

test('a slot index past the palette is refused, not silently dropped later', () => {
  // `Palette.set` would ignore it, but silently -- and the particles pointing at
  // it would render as the fallback material.
  const back = readWorld({
    version: WORLD_FORMAT_VERSION,
    slots: [
      { slot: SLOT_COUNT, name: 'Past the end', document: {} },
      { slot: -1, name: 'Negative', document: {} },
      { slot: 2.5, name: 'Fractional', document: {} },
      { slot: 5, name: 'Fine', document: {} },
    ],
    preferences: {},
    visibleCount: 10,
  });
  assert.deepEqual(back.slots.map((s) => s.slot), [5], 'only the legal slot survives');
});

test('a malformed slot costs only itself', () => {
  // One bad material must not cost the user the other thirty-nine.
  const back = readWorld({
    version: WORLD_FORMAT_VERSION,
    slots: [
      { slot: 0, name: 'Good', document: { a: 1 } },
      'not an object',
      { slot: 1 },
      { slot: 2, name: 'Also good', document: { b: 2 } },
    ],
    preferences: {},
    visibleCount: 10,
  });
  assert.deepEqual(back.slots.map((s) => s.slot), [0, 2]);
});

// ---------------------------------------------------------------------------
// Preferences.
// ---------------------------------------------------------------------------

test('a world states simulation preferences and not editor ones', () => {
  // A downloaded world has no business turning off someone's FPS counter or
  // switching them to the touch layout.
  for (const editorOnly of [
    'showFpsCounter',
    'showPhysicsSlider',
    'physicsSliderOpen',
    'advancedProject',
    'mobileMode',
    'calibrated',
    'strongLogging',
  ]) {
    assert.ok(
      !isWorldPreferenceKey(editorOnly),
      `${editorOnly} describes the reader, not the world`,
    );
  }
});

test('the preferences a world does state are the simulation ones', () => {
  for (const key of ['worldSize', 'canvasAspect', 'physicsSteps', 'brightness']) {
    assert.ok(isWorldPreferenceKey(key), `${key} defines how the world runs`);
  }
});

test('every world preference key is a real preference', () => {
  // `satisfies` enforces this at compile time; this catches it at run time too,
  // which is what protects a hand-edited constant list.
  for (const key of WORLD_PREFERENCE_KEYS) {
    assert.ok(key in DEFAULT_PREFERENCES, `${key} must exist in Preferences`);
  }
});

test('applying a world sets what it states and leaves the rest alone', () => {
  const current: Preferences = Object.freeze({
    ...DEFAULT_PREFERENCES,
    physicsSteps: 9,
    showFpsCounter: false,
    brightness: 1.0,
  });
  const next = applyWorldPreferences(current, { physicsSteps: 3, brightness: 2.5 });
  assert.equal(next.physicsSteps, 3, 'stated: adopted');
  assert.equal(next.brightness, 2.5);
  assert.equal(
    next.showFpsCounter,
    false,
    'not stated and not a world preference: untouched',
  );
});

test('a world that states nothing changes nothing', () => {
  // THE REGRESSION GUARD for an older world resetting preferences it predates.
  // Filling missing keys from defaults at read time would make every such load
  // silently undo whatever the user had chosen.
  const current: Preferences = Object.freeze({
    ...DEFAULT_PREFERENCES,
    physicsSteps: 9,
    brightness: 3.5,
  });
  const next = applyWorldPreferences(current, {});
  assert.equal(next.physicsSteps, 9);
  assert.equal(next.brightness, 3.5);
});

test('a preference of the wrong type is dropped, not coerced into nonsense', () => {
  // A NaN physics rate reaching a uniform freezes the simulation, with no error
  // anywhere -- the same failure `preferences.ts` validates against.
  const back = readWorld({
    version: WORLD_FORMAT_VERSION,
    slots: [],
    preferences: { physicsSteps: 'lots', brightness: 2.0 },
    visibleCount: 10,
  });
  assert.equal(back.preferences.physicsSteps, undefined, 'the bad key is absent');
  assert.equal(back.preferences.brightness, 2.0, 'the good one survives');

  const applied = applyWorldPreferences(DEFAULT_PREFERENCES, back.preferences);
  assert.equal(
    applied.physicsSteps,
    DEFAULT_PREFERENCES.physicsSteps,
    'the reader keeps their own rate',
  );
});

test('an editor preference smuggled into a world document is ignored', () => {
  const back = readWorld({
    version: WORLD_FORMAT_VERSION,
    slots: [],
    preferences: { showFpsCounter: false, mobileMode: 2 },
    visibleCount: 10,
  });
  assert.deepEqual(back.preferences, {}, 'neither key is a world preference');
});

test('an unknown preference key is dropped, so a downgrade survives', () => {
  const back = readWorld({
    version: WORLD_FORMAT_VERSION,
    slots: [],
    preferences: { somethingFromTheFuture: 1, brightness: 2.0 },
    visibleCount: 10,
  });
  assert.equal(back.preferences.brightness, 2.0);
});

test('defaultWorldPreferences covers exactly the world keys', () => {
  const defaults = defaultWorldPreferences();
  assert.deepEqual(Object.keys(defaults).sort(), [...WORLD_PREFERENCE_KEYS].sort());
});

// ---------------------------------------------------------------------------
// The envelope.
// ---------------------------------------------------------------------------

test('a version that is not the current one is refused by name', () => {
  assert.throws(
    () => readWorld({ version: 99, slots: [], preferences: {} }, 'world2'),
    (e: unknown) => {
      assert.ok(e instanceof WorldFormatError);
      assert.match(e.message, /world2/);
      assert.match(e.message, /99/);
      return true;
    },
  );
});

test('a non-object is refused rather than read as empty', () => {
  assert.throws(() => readWorld(null), WorldFormatError);
  assert.throws(() => readWorld([1, 2, 3]), WorldFormatError);
  assert.throws(() => readWorld('a world'), WorldFormatError);
});

test('the visible count survives, because a world may show empty swatches', () => {
  // Deriving it from `slots.length` would overrule an author who deliberately
  // left room for the user to add a material.
  const doc = makeWorldDocument({
    slots: samplePalette(),
    preferences: DEFAULT_PREFERENCES,
    visibleCount: 24,
  });
  assert.equal(doc.visibleCount, 24, 'not 3');
  assert.equal(readWorld(JSON.parse(JSON.stringify(doc))).visibleCount, 24);
});

test('a document with no slots at all is legal', () => {
  // A world that is only preferences is what an author has before painting.
  const back = readWorld({
    version: WORLD_FORMAT_VERSION,
    slots: [],
    preferences: { brightness: 1.0 },
    visibleCount: 10,
  });
  assert.deepEqual(back.slots, []);
});
