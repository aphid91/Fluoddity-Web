import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CUSTOM_WORLD,
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
import { ASSIGNABLE_WORLDS, MIN_VISIBLE_COUNT, SLOT_COUNT } from './palette.ts';
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
    ...EMPTY_SESSION,
    slots: [
      { name: 'Tangle', document: slotDocument(CONFIG, makeWorldSettings()) },
      { name: '', document: null },
    ],
    selected: 5,
    brushSizes: { ...EMPTY_SESSION.brushSizes, walls: 0, shove: 3 },
    tool: 'shove',
    strengths: { ...EMPTY_SESSION.strengths, shove: 2.5, walls: 0.4 },
    visibleCount: 24,
    maxParticles: 50_000,
    theme: 'blueprint',
    autoCompact: true,
    compactionPaused: true,
    auditAfterSweep: true,
  };

  saveSession(session, storage);
  const back = loadSession(storage);

  assert.equal(back.selected, 5);
  assert.equal(back.brushSizes.walls, 0);
  assert.equal(back.brushSizes.shove, 3);
  assert.equal(back.tool, 'shove');
  assert.equal(back.strengths.shove, 2.5);
  assert.equal(back.strengths.walls, 0.4);
  assert.equal(back.visibleCount, 24);
  assert.equal(back.maxParticles, 50_000);
  assert.equal(back.theme, 'blueprint');
  assert.ok(readSlotDocument(back.slots[0]?.document));
  // The Dev tab's compaction switches, which used to be session-only.
  assert.equal(back.autoCompact, true);
  assert.equal(back.compactionPaused, true);
  assert.equal(back.auditAfterSweep, true);
});

// ---------------------------------------------------------------------------
// The Dev tab's compaction switches
// ---------------------------------------------------------------------------

// They govern a pass that rewrites both pool buffers, so a hand-edited or
// truthy-but-not-boolean entry falls back to off rather than being coerced.
test('the compaction switches accept booleans only', () => {
  const parsed = parseSession(
    JSON.stringify({
      autoCompact: 'true',
      compactionPaused: 1,
      auditAfterSweep: {},
    }),
  );
  assert.equal(parsed.autoCompact, false);
  assert.equal(parsed.compactionPaused, false);
  assert.equal(parsed.auditAfterSweep, false);
});

// A session written before these were persisted must not turn compaction off.
test('a session predating the compaction switches defaults them off', () => {
  const parsed = parseSession(JSON.stringify({ selected: 2 }));
  assert.equal(parsed.autoCompact, EMPTY_SESSION.autoCompact);
  assert.equal(parsed.compactionPaused, false, 'compaction must not start paused');
  assert.equal(parsed.auditAfterSweep, false, 'auditing must not start on');
});

// ---------------------------------------------------------------------------
// Swatch colours and the colour mode
// ---------------------------------------------------------------------------

// STORED EVEN FOR AN EMPTY SWATCH, unlike the world format's. A session is
// Custom's working state, and a palette being coloured before it is filled is
// work that must survive a reload.
test('an empty swatch keeps its colour', () => {
  const storage = memory();
  saveSession(
    {
      ...EMPTY_SESSION,
      slots: [{ name: '', document: null, color: { hue: 0.5, saturation: 0.25 } }],
    },
    storage,
  );
  const back = loadSession(storage);
  assert.equal(back.slots[0]?.document, null, 'still empty');
  assert.deepEqual(back.slots[0]?.color, { hue: 0.5, saturation: 0.25 });
});

test('a session predating swatch colours restores without one', () => {
  const parsed = parseSession(
    JSON.stringify({ slots: [{ name: 'Sand', document: null }] }),
  );
  assert.equal(parsed.slots[0]?.color, undefined, 'the caller substitutes a default');
});

test('a malformed colour is dropped without costing the swatch', () => {
  const parsed = parseSession(
    JSON.stringify({
      slots: [{ name: 'Sand', document: null, color: { hue: 'pink', saturation: 1 } }],
    }),
  );
  assert.equal(parsed.slots[0]?.name, 'Sand', 'the swatch survives');
  assert.equal(parsed.slots[0]?.color, undefined);
});

test('the colour mode round-trips and falls back when unrecognised', () => {
  const storage = memory();
  saveSession({ ...EMPTY_SESSION, colorMode: 'swatch' }, storage);
  assert.equal(loadSession(storage).colorMode, 'swatch');

  assert.equal(
    parseSession(JSON.stringify({ colorMode: 'ultraviolet' })).colorMode,
    EMPTY_SESSION.colorMode,
  );
  // A session written before the dropdown existed renders as it always did.
  assert.equal(parseSession(JSON.stringify({})).colorMode, 'behavior');
});

// ---------------------------------------------------------------------------
// Migration off the pre-rail model
// ---------------------------------------------------------------------------

test('a square that used to hold a field tool comes back EMPTY', () => {
  // Before the tool rail, a square could BE Shove or Walls. There is nothing to
  // convert that into: the verb now lives in the rail and the swatch is a noun
  // slot with no noun in it. Keeping it would resurrect the two-selectors-armed
  // ambiguity the split exists to remove.
  const parsed = parseSession(
    JSON.stringify({ slots: [{ tool: 'walls', name: 'Walls', document: null }] }),
  );
  assert.equal(parsed.slots[0]?.name, '', 'the tool name would be a lie on an empty swatch');
  assert.equal(parsed.slots[0]?.document, null);
});

test('a config square survives the migration untouched', () => {
  const doc = slotDocument(CONFIG, makeWorldSettings());
  const parsed = parseSession(
    JSON.stringify({ slots: [{ tool: TOOL_CONFIG, name: 'Tangle', document: doc }] }),
  );
  assert.equal(parsed.slots[0]?.name, 'Tangle');
  assert.ok(readSlotDocument(parsed.slots[0]?.document));
});

test('the pre-split single weight becomes the BRUSH strength', () => {
  // The old number was tuned against whatever tool was last touched, and Brush
  // is both the likeliest and the only one where a wrong guess is immediately
  // visible rather than subtly off.
  const parsed = parseSession(JSON.stringify({ weight: 3.5 }));
  assert.equal(parsed.strengths.brush, 3.5);
  assert.equal(parsed.strengths.shove, EMPTY_SESSION.strengths.shove, 'others default');
});

test('an explicit strengths block wins over the legacy weight', () => {
  const parsed = parseSession(
    JSON.stringify({ weight: 3.5, strengths: { brush: 1.25, shove: 8 } }),
  );
  assert.equal(parsed.strengths.brush, 1.25);
  assert.equal(parsed.strengths.shove, 8);
});

test('a nonsense strength is refused rather than stored', () => {
  // A zero gain is a tool that silently does nothing; a NaN one propagates into
  // the spawn count and the shove impulse.
  const parsed = parseSession(
    JSON.stringify({ strengths: { brush: 0, shove: null, walls: 'heavy' } }),
  );
  assert.equal(parsed.strengths.brush, EMPTY_SESSION.strengths.brush);
  assert.equal(parsed.strengths.shove, EMPTY_SESSION.strengths.shove);
  assert.equal(parsed.strengths.walls, EMPTY_SESSION.strengths.walls);
});

test('an unknown tool degrades to the default rather than arming nothing', () => {
  assert.equal(parseSession(JSON.stringify({ tool: 'teleport' })).tool, EMPTY_SESSION.tool);
  assert.equal(parseSession(JSON.stringify({ tool: 'shove' })).tool, 'shove');
});

test('the visible count is clamped on the way in', () => {
  assert.equal(parseSession(JSON.stringify({ visibleCount: 999 })).visibleCount, SLOT_COUNT);
  assert.equal(parseSession(JSON.stringify({ visibleCount: 0 })).visibleCount, MIN_VISIBLE_COUNT);
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
  const parsed = parseSession(JSON.stringify({ somethingNew: 1, visibleCount: 12 }));
  assert.equal(parsed.visibleCount, 12);
  assert.equal(parsed.tool, EMPTY_SESSION.tool);
  assert.deepEqual(parsed.slots, []);
});

test('non-finite numbers are rejected, not stored', () => {
  // A NaN brush size is not a visible mistake -- it is a control that silently
  // stops working.
  const parsed = parseSession(JSON.stringify({ visibleCount: null, brushSize: 'x' }));
  assert.equal(parsed.visibleCount, EMPTY_SESSION.visibleCount);
  assert.deepEqual(parsed.brushSizes, EMPTY_SESSION.brushSizes);
});

test('a pre-split brushSize seeds every tool', () => {
  const parsed = parseSession(JSON.stringify({ brushSize: 1 }));
  assert.deepEqual(parsed.brushSizes, { brush: 1, erase: 1, shove: 1, walls: 1, trails: 1 });
});

test('an explicit brushSizes block wins over the legacy brushSize', () => {
  const parsed = parseSession(JSON.stringify({ brushSize: 1, brushSizes: { walls: 0 } }));
  assert.equal(parsed.brushSizes.walls, 0);
  assert.equal(parsed.brushSizes.shove, 1, 'others take the legacy size');
});

test('out-of-range, fractional and unknown sizes are dropped', () => {
  const parsed = parseSession(
    JSON.stringify({ brushSizes: { brush: 4, erase: -1, shove: 1.5, walls: 'big', stamp: 0 } }),
  );
  assert.deepEqual(parsed.brushSizes, EMPTY_SESSION.brushSizes);
  assert.equal('stamp' in parsed.brushSizes, false);
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

// ---------------------------------------------------------------------------
// WORLDS: the five assignments, and which button is lit.
// ---------------------------------------------------------------------------

test('a session with no worlds block restores as unassigned custom', () => {
  // Every session written before worlds existed takes this path.
  const session = parseSession(JSON.stringify({ slots: [] }));
  assert.deepEqual(session.worlds, []);
  assert.equal(session.selectedWorld, CUSTOM_WORLD);
});

test('world assignments round-trip', () => {
  const session = parseSession(
    JSON.stringify({ worlds: ['Dunes', '', 'Reef'], selectedWorld: 2 }),
  );
  assert.deepEqual(session.worlds, ['Dunes', '', 'Reef']);
  assert.equal(session.selectedWorld, 2);
});

test('a non-string assignment becomes unassigned rather than reaching a dropdown', () => {
  // Tweakpane renders a value with no matching option as a blank selection,
  // which reads as a broken control rather than as a bad stored value.
  const session = parseSession(JSON.stringify({ worlds: ['Dunes', 42, null] }));
  assert.deepEqual(session.worlds, ['Dunes', '', '']);
});

test('a selection past the five buttons falls back to custom', () => {
  // THE REGRESSION GUARD for a panel with nothing lit. A stored index out of
  // range would match no button and leave the selector looking broken.
  for (const bad of [ASSIGNABLE_WORLDS, 99, -2, NaN, 'two', null]) {
    assert.equal(
      parseSession(JSON.stringify({ selectedWorld: bad })).selectedWorld,
      CUSTOM_WORLD,
      `selectedWorld ${String(bad)} must degrade to Custom`,
    );
  }
});

test('a fractional selection truncates rather than degrading', () => {
  // Truncation, not rejection: every other numeric field in this parser
  // truncates, and 1.5 unambiguously means button 1. Degrading it to Custom
  // would throw away a usable answer.
  assert.equal(parseSession(JSON.stringify({ selectedWorld: 1.5 })).selectedWorld, 1);
});

test('every assignable index is accepted', () => {
  for (let i = 0; i < ASSIGNABLE_WORLDS; i++) {
    assert.equal(parseSession(JSON.stringify({ selectedWorld: i })).selectedWorld, i);
  }
});

test('the custom sentinel is not a legal button index', () => {
  // -1 must never be mistaken for a real slot by arithmetic that forgets to
  // check, which is why it is negative rather than one past the end.
  assert.ok(CUSTOM_WORLD < 0);
});
