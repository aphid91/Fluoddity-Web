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
  cycleSlot,
  isLoaded,
  keyLabel,
  slotForDigit,
} from './palette.ts';
import { makeSimulationConfig, makeWorldSettings } from '../particleSystem/config.ts';
import { TOOL_CONFIG } from './tool.ts';
import { COMPATIBILITY_TOLERANCE, isCompatible } from './compatibility.ts';
import { defaultSwatchColor } from './swatchColor.ts';

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

// ---------------------------------------------------------------------------
// Scroll cycling -- the wheel gesture, which has no end stop
// ---------------------------------------------------------------------------

test('cycleSlot steps forward and back within the visible range', () => {
  assert.equal(cycleSlot(0, 1, 10), 1);
  assert.equal(cycleSlot(5, 1, 10), 6);
  assert.equal(cycleSlot(5, -1, 10), 4);
});

// THE WHOLE POINT OF THE HELPER. A clamp at either end would read as the wheel
// having broken, so both ends roll over.
test('cycleSlot wraps at both ends', () => {
  assert.equal(cycleSlot(9, 1, 10), 0, 'past the last visible swatch');
  assert.equal(cycleSlot(0, -1, 10), 9, 'back past the first');
});

// Scrolling must not select a swatch that has no button -- it would look
// exactly like the scroll having done nothing.
test('cycleSlot never leaves the visible range', () => {
  for (let step = -50; step <= 50; step++) {
    const landed = cycleSlot(3, step, 12);
    assert.ok(landed >= 0 && landed < 12, `step ${step} landed at ${landed}`);
  }
});

// A step larger than the range is not special-cased anywhere, so it is pinned.
test('cycleSlot handles steps larger than the range', () => {
  assert.equal(cycleSlot(0, 25, 10), 5);
  assert.equal(cycleSlot(0, -25, 10), 5);
});

// Degenerate counts must not produce NaN or divide by zero -- the palette
// always shows at least MIN_VISIBLE_COUNT, but the helper is defensive.
test('cycleSlot survives a non-positive visible count', () => {
  assert.equal(cycleSlot(0, 1, 0), 0);
  assert.equal(cycleSlot(0, -1, -5), 0);
});

// The visible range is what has buttons, but capacity is still the ceiling.
test('cycleSlot clamps a visible count above capacity', () => {
  assert.equal(cycleSlot(SLOT_COUNT - 1, 1, SLOT_COUNT + 10), 0);
});

// ---------------------------------------------------------------------------
// Swatch colours -- a property of the SLOT, not of the material in it
// ---------------------------------------------------------------------------

test('a palette starts with a full set of spaced default colours', () => {
  const palette = new Palette();
  assert.equal(palette.colorsForUpload().length, SLOT_COUNT, 'one per slot');
  // Indexed by `config_index` on the GPU, so it must be dense and full length.
  assert.deepEqual(palette.colorOf(7), defaultSwatchColor(7));
});

test('a colour survives the material in its slot being replaced', () => {
  // The bug this prevents: `set` bumps the generation and rewrites the slot, so
  // a colour stored ON the slot record would be reset by every right-click
  // load -- exactly when an author is filling a palette they already coloured.
  const palette = new Palette();
  palette.setColor(4, { hue: 0.25, saturation: 0.6 });
  palette.set(4, entry('Sand'));
  assert.deepEqual(palette.colorOf(4), { hue: 0.25, saturation: 0.6 });

  palette.set(4, entry('Smoke'));
  assert.deepEqual(palette.colorOf(4), { hue: 0.25, saturation: 0.6 }, 'and again');
});

// A colour is a display property the Config tab shows nothing of, so rebuilding
// that tab on every drag of the picker would reset the gesture.
test('setting a colour does not bump the generation', () => {
  const palette = new Palette();
  const before = palette.generationOf(2);
  palette.setColor(2, { hue: 0.9, saturation: 1 });
  assert.equal(palette.generationOf(2), before);
});

test('a colour set out of bounds is ignored rather than growing the table', () => {
  const palette = new Palette();
  palette.setColor(SLOT_COUNT + 5, { hue: 0.5, saturation: 1 });
  palette.setColor(-1, { hue: 0.5, saturation: 1 });
  assert.equal(palette.colorsForUpload().length, SLOT_COUNT);
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

// ---------------------------------------------------------------------------
// Icons -- a picture of the material, so it goes when the material does
// ---------------------------------------------------------------------------

const ICON = 'data:image/jpeg;base64,AAAA';

test('an icon survives a settings edit and a rename', () => {
  const palette = new Palette();
  palette.set(3, entry('Sand'));
  palette.setIcon(3, ICON);
  palette.edit(3, CONFIG, WORLD);
  assert.equal(palette.at(3).icon, ICON, 'edit');
  palette.set(3, { ...palette.at(3), name: 'Renamed' });
  assert.equal(palette.at(3).icon, ICON, 'rename');
});

test('loading a different config, or clearing, drops the icon', () => {
  const palette = new Palette();
  palette.set(3, entry('Sand'));
  palette.setIcon(3, ICON);
  palette.set(3, entry('Smoke'));
  assert.equal(palette.at(3).icon, undefined, 'load');
  palette.setIcon(3, ICON);
  palette.clear(3);
  assert.equal(palette.at(3).icon, undefined, 'clear');
});

test('setting a null icon puts the colour back; an empty swatch takes none', () => {
  const palette = new Palette();
  palette.set(3, entry('Sand'));
  palette.setIcon(3, ICON);
  const generation = palette.generationOf(3);
  palette.setIcon(3, null);
  assert.equal(palette.at(3).icon, undefined);
  assert.equal(palette.generationOf(3), generation, 'no Config tab rebuild');
  palette.setIcon(5, ICON);
  assert.equal(palette.at(5).icon, undefined);
});
