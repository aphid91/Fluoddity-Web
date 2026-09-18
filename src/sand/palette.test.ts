import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_VISIBLE_COUNT,
  KEYED_SLOTS,
  MASTER_SLOT,
  MIN_VISIBLE_COUNT,
  Palette,
  type PaletteSlot,
  SLOT_COUNT,
  clampVisibleCount,
  isLoaded,
  keyLabel,
  slotForDigit,
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

test('digits map 1-9 then 0 to the first ten slots', () => {
  assert.equal(slotForDigit('1'), 0);
  assert.equal(slotForDigit('9'), 8);
  // `0` is the TENTH slot, not the first -- the printed digit is one-based.
  assert.equal(slotForDigit('0'), 9);
  assert.equal(slotForDigit('x'), null);
});

test('only the first ten swatches carry a printed digit', () => {
  assert.equal(keyLabel(0), '1');
  assert.equal(keyLabel(KEYED_SLOTS - 1), '0');
  // Past the tenth there is no key to print, and labelling them anyway would
  // promise a shortcut that does nothing.
  assert.equal(keyLabel(KEYED_SLOTS), '');
  assert.equal(keyLabel(SLOT_COUNT - 1), '');
});

// ---------------------------------------------------------------------------
// The visible count
//
// THE INVARIANT: capacity is fixed and only the DISPLAY varies, because a slot's
// index in `configsForUpload` is its `config_index` on the GPU. See palette.ts.
// ---------------------------------------------------------------------------

test('the visible count never changes the upload length', () => {
  const p = new Palette();
  p.set(35, entry('far'));

  p.setVisibleCount(MIN_VISIBLE_COUNT);

  // Still forty configs, and the one in slot 35 is still at index 35 -- every
  // particle painted from it keeps pointing at the right species.
  const configs = p.configsForUpload(CONFIG);
  assert.equal(configs.length, SLOT_COUNT);
  assert.equal(configs[35], CONFIG);
  assert.equal(p.at(35).name, 'far', 'hiding a swatch does not clear it');
});

test('the visible count is clamped to what the palette can show', () => {
  assert.equal(clampVisibleCount(0), MIN_VISIBLE_COUNT);
  assert.equal(clampVisibleCount(1000), SLOT_COUNT);
  assert.equal(clampVisibleCount(Number.NaN), DEFAULT_VISIBLE_COUNT);
  assert.equal(clampVisibleCount(22), 22);
});

test('shrinking the bar pulls the selection back into view', () => {
  const p = new Palette();
  p.select(30);
  p.setVisibleCount(10);
  // Otherwise the selected swatch would be one nobody can see or click back to.
  assert.equal(p.selected, 9);
});

// ---------------------------------------------------------------------------
// The master slot
// ---------------------------------------------------------------------------

test('the master is slot 0', () => {
  const p = new Palette();
  p.set(MASTER_SLOT, entry('master'));
  assert.equal(p.master.name, 'master');
  assert.equal(MASTER_SLOT, 0);
});

test('the master refuses to be cleared', () => {
  const p = new Palette();
  p.set(MASTER_SLOT, entry('master'));

  p.clear(MASTER_SLOT);

  // The load menu hides "None" for the master; the model refuses it as well, so
  // the invariant does not depend on the menu being the only caller. The scene
  // needs one authored answer about trail persistence.
  assert.equal(p.master.name, 'master');
  assert.equal(p.master.config, CONFIG);
});

test('any other swatch clears to empty', () => {
  const p = new Palette();
  p.set(4, entry('x'));
  p.clear(4);
  assert.equal(p.at(4).config, null);
  assert.equal(p.at(4).name, '');
});

// ---------------------------------------------------------------------------
// firstEmpty -- what Shift+V fills
// ---------------------------------------------------------------------------

test('firstEmpty skips the master and finds the lowest free swatch', () => {
  const p = new Palette();
  // The master is empty here, and must still be skipped: quietly making a pasted
  // config govern the world is not what "put this somewhere free" asked for.
  p.set(1, entry('a'));
  assert.equal(p.firstEmpty(), 2);
});

test('firstEmpty searches only the VISIBLE range', () => {
  const p = new Palette();
  p.setVisibleCount(MIN_VISIBLE_COUNT);
  for (let slot = 1; slot < MIN_VISIBLE_COUNT; slot++) p.set(slot, entry(`s${slot}`));

  // Slots past the visible count are free, but filling one would look exactly
  // like the paste having failed.
  assert.equal(p.firstEmpty(), null);
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
// Swatches are config-only
//
// The verb moved to the left rail, so a swatch is a noun slot and nothing else
// -- see `tool.ts` on the split.
// ---------------------------------------------------------------------------

test('only a LOADED swatch has something to paint', () => {
  const p = new Palette();
  assert.equal(isLoaded(p.at(0)), false, 'empty');

  p.set(0, entry('real'));
  assert.equal(isLoaded(p.at(0)), true);
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
