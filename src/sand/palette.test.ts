import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MASTER_SLOT,
  Palette,
  type PaletteSlot,
  ROW_SIZE,
  SLOT_COUNT,
  positionForDigit,
  paintsParticles,
  positionOf,
  rowOf,
  slotForKey,
  toolSlot,
} from './palette.ts';
import { makeSimulationConfig, makeWorldSettings } from '../particleSystem/config.ts';
import { TOOL_CONFIG } from './tool.ts';
import { COMPATIBILITY_TOLERANCE, isCompatible } from './compatibility.ts';

// Values are arbitrary -- nothing here reads them. What matters is that this is
// a real `SimulationConfig`, so the palette is exercised against the type it
// actually carries.
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
const WORLD = makeWorldSettings();

function entry(name: string): PaletteSlot {
  return { tool: TOOL_CONFIG, config: CONFIG, world: WORLD, name };
}

// ---------------------------------------------------------------------------
// Key mapping -- the Factorio convention
// ---------------------------------------------------------------------------

test('digits map 1-9 then 0 to positions 0-9', () => {
  assert.equal(positionForDigit('1'), 0);
  assert.equal(positionForDigit('9'), 8);
  // `0` is the TENTH slot, not the first -- the printed digit is one-based.
  assert.equal(positionForDigit('0'), 9);
  assert.equal(positionForDigit('x'), null);
});

test('slotForKey addresses the active row', () => {
  assert.equal(slotForKey(0, true), 0);
  assert.equal(slotForKey(9, true), 9);
  assert.equal(slotForKey(0, false), ROW_SIZE);
  assert.equal(slotForKey(9, false), ROW_SIZE + 9);
});

test('rowOf and positionOf invert slotForKey', () => {
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    assert.equal(slotForKey(positionOf(slot), rowOf(slot) === 0), slot);
  }
});

// ---------------------------------------------------------------------------
// The master slot and row swapping
//
// THE REQUIREMENT: the green master highlight follows the ELEMENT through a row
// swap, showing which palette element is the master one. That works because
// nothing moves in storage -- `X` changes which row the keys address, not where
// configs live.
// ---------------------------------------------------------------------------

test('the master is slot 0 regardless of which row is active', () => {
  const p = new Palette();
  p.set(MASTER_SLOT, entry('master'));
  assert.equal(p.master.name, 'master');

  p.swapRows();
  // Still the same element. The highlight follows it because the slot index
  // never changed -- only which row the number keys reach.
  assert.equal(p.master.name, 'master');
  assert.equal(MASTER_SLOT, 0);
});

test('swapping rows keeps the same POSITION selected', () => {
  const p = new Palette();
  p.selectPosition(3);
  assert.equal(p.selected, 3);

  p.swapRows();
  // Same column, other row -- flipping a toolbar, not jumping somewhere new.
  assert.equal(p.selected, ROW_SIZE + 3);

  p.swapRows();
  assert.equal(p.selected, 3);
});

test('swapping rows does not move any config', () => {
  const p = new Palette();
  p.set(0, entry('a'));
  p.set(ROW_SIZE, entry('b'));

  p.swapRows();

  assert.equal(p.at(0).name, 'a', 'storage order is stable');
  assert.equal(p.at(ROW_SIZE).name, 'b');
});

test('clicking a square on the other row makes that row active', () => {
  const p = new Palette();
  assert.equal(p.topRowActive, true);

  p.select(ROW_SIZE + 2);

  // Otherwise `1` would select a top-row square while a bottom-row one is lit.
  assert.equal(p.topRowActive, false);
  assert.equal(p.selected, ROW_SIZE + 2);

  p.selectPosition(0);
  assert.equal(p.selected, ROW_SIZE);
});

test('out-of-range selections and writes are ignored', () => {
  const p = new Palette();
  p.select(-1);
  assert.equal(p.selected, 0);
  p.select(SLOT_COUNT);
  assert.equal(p.selected, 0);
  p.set(SLOT_COUNT, entry('nope'));
  assert.equal(p.at(SLOT_COUNT).config, null);
});

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

test('every slot gets a config, so a slot index IS its config_index', () => {
  const p = new Palette();
  p.set(5, entry('five'));

  const configs = p.configsForUpload(CONFIG);

  // Dense: compacting would renumber live slots and repoint every particle
  // already painted from a slot above a gap.
  assert.equal(configs.length, SLOT_COUNT);
  assert.equal(configs[5], CONFIG);
});

test('an empty palette reports itself empty', () => {
  const p = new Palette();
  assert.equal(p.isEmpty, true);
  p.set(0, entry('a'));
  assert.equal(p.isEmpty, false);
});

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

test('a config is compatible with itself', () => {
  const w = makeWorldSettings({ trailPersistence: 0.94 });
  assert.equal(isCompatible(w, w), true);
});

test('compatibility is symmetric', () => {
  const a = makeWorldSettings({ trailPersistence: 0.94 });
  const b = makeWorldSettings({ trailPersistence: 0.9 });
  assert.equal(isCompatible(a, b), isCompatible(b, a));
});

test('it compares DECAY, not persistence', () => {
  // 0.99 and 0.999 are a hair apart as persistences and 10x apart as decay
  // rates -- and it is the decay rate that decides how long a trail lives.
  const a = makeWorldSettings({ trailPersistence: 0.99 });
  const b = makeWorldSettings({ trailPersistence: 0.999 });
  assert.equal(isCompatible(a, b), false);
});

test('the tolerance is a fraction of the larger decay', () => {
  const master = makeWorldSettings({ trailPersistence: 0.9 }); // decay 0.1
  // Just inside: decay 0.1 vs 0.089 -> diff 0.011, tolerance 0.012.
  const near = makeWorldSettings({ trailPersistence: 1 - 0.1 * (1 - COMPATIBILITY_TOLERANCE + 0.01) });
  assert.equal(isCompatible(near, master), true);
  // Well outside.
  const far = makeWorldSettings({ trailPersistence: 0.5 });
  assert.equal(isCompatible(far, master), false);
});

test('two zero-decay configs do not divide by zero', () => {
  const w = makeWorldSettings({ trailPersistence: 1 });
  assert.equal(isCompatible(w, w), true);
});

// ---------------------------------------------------------------------------
// Tool squares
//
// A square is either a CONFIG square or one of the engine's field tools. Both
// live in the same twenty squares and are chosen the same way, so "is this
// empty" and "which tool is this" must stay separate questions.
// ---------------------------------------------------------------------------

test('a tool square is not mistaken for an empty one', () => {
  const p = new Palette();
  p.set(3, toolSlot('walls'));

  const slot = p.at(3);
  assert.equal(slot.tool, 'walls');
  assert.equal(slot.config, null, 'a field tool carries no config');
  // The distinction that matters: both have a null config, but only one is an
  // unloaded square waiting to be filled.
  assert.equal(paintsParticles(slot), false);
  assert.equal(slot.name, 'Walls', 'tool squares are named');
});

test('only a LOADED config square paints particles', () => {
  const p = new Palette();
  assert.equal(paintsParticles(p.at(0)), false, 'empty');

  p.set(0, toolSlot('shove'));
  assert.equal(paintsParticles(p.at(0)), false, 'field tool');

  p.set(0, entry('real'));
  assert.equal(paintsParticles(p.at(0)), true);
});

test('a tool square still counts as empty for the palette', () => {
  const p = new Palette();
  p.set(0, toolSlot('trails'));
  // `isEmpty` asks whether any CONFIG is loaded -- a palette of nothing but
  // tools has no species in it.
  assert.equal(p.isEmpty, true);
});

test('editing preserves which tool a square is', () => {
  const p = new Palette();
  p.set(2, entry('x'));
  p.edit(2, CONFIG, WORLD);
  assert.equal(p.at(2).tool, TOOL_CONFIG);
});

test('a generation bump marks a REPLACEMENT, not an edit', () => {
  const p = new Palette();
  p.set(1, entry('a'));
  const afterSet = p.generationOf(1);

  p.edit(1, CONFIG, WORLD);
  assert.equal(p.generationOf(1), afterSet, 'an edit does not rebuild the tab');

  p.set(1, entry('b'));
  assert.ok(p.generationOf(1) > afterSet, 'a load does');
});
