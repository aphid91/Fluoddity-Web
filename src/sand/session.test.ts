import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_SESSION,
  SESSION_KEY,
  type SandSession,
  type SessionStorage,
  loadSession,
  parseSession,
  readSlotDocument,
  saveSession,
  slotDocument,
} from './session.ts';
import { TOOL_CONFIG } from './tool.ts';
import { SLOT_COUNT } from './palette.ts';
import { makeSimulationConfig, makeWorldSettings } from '../particleSystem/config.ts';

const CONFIG = makeSimulationConfig({
  cohorts: 4,
  mutationSeed: 0.5,
  sensorGain: 1,
  sensorAngle: 0.4,
  sensorDistance: 8,
  mutationScale: 0.1,
  globalForceMult: 1,
  drag: 0.9,
  strafePower: 0.2,
  axialForce: 0.3,
  lateralForce: 0.1,
  hazardRate: 0,
});

/** An in-memory `localStorage`, so these tests need no browser. */
function memory(): SessionStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

// ---------------------------------------------------------------------------
// The point of the whole module: a square's LIVE values round-trip
// ---------------------------------------------------------------------------

test('an EDITED square restores as edited, not as the file it came from', () => {
  // This is the requirement: "the palette elements might have been altered
  // since they were loaded". Storing a reference to the source file would
  // silently discard every Config-tab edit on reload.
  const edited = { ...CONFIG, drag: 0.42, sensorGain: 7.5 };
  const world = makeWorldSettings({ trailPersistence: 0.77 });

  const restored = readSlotDocument(slotDocument(edited, world));

  assert.ok(restored);
  assert.equal(restored.configs[0]?.drag, 0.42);
  assert.equal(restored.configs[0]?.sensorGain, 7.5);
  assert.equal(restored.world.trailPersistence, 0.77);
});

test('an empty square stores no document', () => {
  assert.equal(slotDocument(null, null), null);
  assert.equal(readSlotDocument(null), null);
});

test('a malformed document costs one square, not the palette', () => {
  // One bad entry should not take the other nineteen with it.
  assert.equal(readSlotDocument({ nonsense: true }), null);
  assert.equal(readSlotDocument('not an object'), null);
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

test('a session round-trips through storage', () => {
  const storage = memory();
  const session: SandSession = {
    slots: [
      { tool: TOOL_CONFIG, name: 'Tangle', document: slotDocument(CONFIG, makeWorldSettings()) },
      { tool: 'walls', name: 'Walls', document: null },
    ],
    selected: 5,
    topRowActive: false,
    brushSize: 4,
    weight: 2.5,
    maxParticles: 50_000,
  };

  saveSession(session, storage);
  const back = loadSession(storage);

  assert.equal(back.selected, 5);
  assert.equal(back.topRowActive, false);
  assert.equal(back.brushSize, 4);
  assert.equal(back.weight, 2.5);
  assert.equal(back.maxParticles, 50_000);
  assert.equal(back.slots[1]?.tool, 'walls');
  assert.ok(readSlotDocument(back.slots[0]?.document));
});

test('a tool square round-trips without a config', () => {
  const storage = memory();
  saveSession(
    { ...EMPTY_SESSION, slots: [{ tool: 'shove', name: 'Shove', document: null }] },
    storage,
  );
  const back = loadSession(storage);
  assert.equal(back.slots[0]?.tool, 'shove');
  assert.equal(back.slots[0]?.document, null);
});

// ---------------------------------------------------------------------------
// Degradation -- never fatal, matching preferences.ts
// ---------------------------------------------------------------------------

test('no stored session is an empty one', () => {
  assert.deepEqual(loadSession(memory()), EMPTY_SESSION);
});

test('unparseable JSON falls back rather than throwing', () => {
  const storage = memory();
  storage.setItem(SESSION_KEY, '{ not json');
  assert.deepEqual(loadSession(storage), EMPTY_SESSION);
});

test('unknown keys are ignored and missing ones defaulted', () => {
  // A downgrade must not break on a field a newer build wrote.
  const parsed = parseSession(JSON.stringify({ somethingNew: 1, weight: 3 }));
  assert.equal(parsed.weight, 3);
  assert.equal(parsed.brushSize, EMPTY_SESSION.brushSize);
  assert.deepEqual(parsed.slots, []);
});

test('non-finite numbers are rejected, not stored', () => {
  // A NaN brush size is not a visible mistake -- it is a control that silently
  // stops working.
  const parsed = parseSession(JSON.stringify({ weight: null, brushSize: 'x' }));
  assert.equal(parsed.weight, EMPTY_SESSION.weight);
  assert.equal(parsed.brushSize, EMPTY_SESSION.brushSize);
});

test('the selected slot is clamped into the palette', () => {
  assert.equal(parseSession(JSON.stringify({ selected: 999 })).selected, SLOT_COUNT - 1);
  assert.equal(parseSession(JSON.stringify({ selected: -4 })).selected, 0);
});

test('more stored slots than the palette holds are truncated', () => {
  const slots = Array.from({ length: SLOT_COUNT + 5 }, () => ({
    tool: TOOL_CONFIG,
    name: 'x',
    document: null,
  }));
  assert.equal(parseSession(JSON.stringify({ slots })).slots.length, SLOT_COUNT);
});

test('an unknown tool name degrades to a config square', () => {
  const parsed = parseSession(
    JSON.stringify({ slots: [{ tool: 'teleport', name: 'x', document: null }] }),
  );
  assert.equal(parsed.slots[0]?.tool, TOOL_CONFIG);
});

test('a storage that throws does not take the app down', () => {
  const hostile: SessionStorage = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('quota');
    },
  };
  assert.deepEqual(loadSession(hostile), EMPTY_SESSION);
  // Quota exceeded on a twenty-config write is plausible; losing the session is
  // survivable, crashing is not.
  assert.doesNotThrow(() => saveSession(EMPTY_SESSION, hostile));
});

test('no storage at all is handled', () => {
  assert.deepEqual(loadSession(null), EMPTY_SESSION);
  assert.doesNotThrow(() => saveSession(EMPTY_SESSION, null));
});

test('a negative or zero particle cap is treated as unset', () => {
  assert.equal(parseSession(JSON.stringify({ maxParticles: 0 })).maxParticles, null);
  assert.equal(parseSession(JSON.stringify({ maxParticles: -5 })).maxParticles, null);
});
