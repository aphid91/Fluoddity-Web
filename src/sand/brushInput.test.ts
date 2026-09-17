import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BRUSH_ERASE,
  BRUSH_SIZES,
  BRUSH_SPAWN,
  BrushInput,
  DEFAULT_BRUSH_RATE,
  DEFAULT_BRUSH_SIZE,
} from './brushInput.ts';

const DT = 1 / 60;
const PLENTY = 1_000_000;

test('brush sizes are ascending and all positive', () => {
  for (const r of BRUSH_SIZES) assert.ok(r > 0);
  for (let i = 1; i < BRUSH_SIZES.length; i++) {
    assert.ok(BRUSH_SIZES[i]! > BRUSH_SIZES[i - 1]!, `size ${i} is larger`);
  }
});

test('there are five sizes and the default is one of them', () => {
  assert.equal(BRUSH_SIZES.length, 5);
  assert.ok(DEFAULT_BRUSH_SIZE >= 0 && DEFAULT_BRUSH_SIZE < BRUSH_SIZES.length);
});

test('setSize ignores out-of-range indices', () => {
  const b = new BrushInput();
  const before = b.radius;
  b.setSize(-1);
  b.setSize(BRUSH_SIZES.length);
  assert.equal(b.radius, before);
  b.setSize(0);
  assert.equal(b.radius, BRUSH_SIZES[0]);
});

// ---------------------------------------------------------------------------
// Stroke continuity -- the part that is easy to get wrong
// ---------------------------------------------------------------------------

test('the first frame of a stroke paints a point', () => {
  const b = new BrushInput();
  const cmd = b.frame([1, 2], BRUSH_SPAWN, DT, PLENTY);
  assert.ok(cmd);
  // from === to. A click that has not moved deposits at the cursor, not along a
  // line from wherever the previous stroke ended.
  assert.deepEqual(cmd.stroke.from, [1, 2]);
  assert.deepEqual(cmd.stroke.to, [1, 2]);
});

test('the second frame paints from the previous cursor', () => {
  const b = new BrushInput();
  b.frame([0, 0], BRUSH_SPAWN, DT, PLENTY);
  const cmd = b.frame([1, 1], BRUSH_SPAWN, DT, PLENTY);
  assert.ok(cmd);
  // A segment, so a fast drag lays a continuous stream rather than clumps.
  assert.deepEqual(cmd.stroke.from, [0, 0]);
  assert.deepEqual(cmd.stroke.to, [1, 1]);
});

test('releasing ends the stroke, so the next press does not draw a line to it', () => {
  const b = new BrushInput();
  b.frame([0, 0], BRUSH_SPAWN, DT, PLENTY);
  b.release();

  const cmd = b.frame([9, 9], BRUSH_SPAWN, DT, PLENTY);
  assert.ok(cmd);
  // Without the release this would be a segment from [0,0] to [9,9] -- a stripe
  // of particles across the world that the user never drew.
  assert.deepEqual(cmd.stroke.from, [9, 9]);
});

test('a frame with no button releases the stroke', () => {
  const b = new BrushInput();
  b.frame([0, 0], BRUSH_SPAWN, DT, PLENTY);
  assert.equal(b.frame([5, 5], null, DT, PLENTY), null);

  const cmd = b.frame([9, 9], BRUSH_SPAWN, DT, PLENTY);
  assert.ok(cmd);
  assert.deepEqual(cmd.stroke.from, [9, 9], 'the gap ended the stroke');
});

test('a frame with no cursor releases the stroke', () => {
  const b = new BrushInput();
  b.frame([0, 0], BRUSH_SPAWN, DT, PLENTY);
  assert.equal(b.frame(null, BRUSH_SPAWN, DT, PLENTY), null);
  const cmd = b.frame([9, 9], BRUSH_SPAWN, DT, PLENTY);
  assert.deepEqual(cmd?.stroke.from, [9, 9]);
});

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

test('the eraser asks for no particles', () => {
  const b = new BrushInput();
  const cmd = b.frame([0, 0], BRUSH_ERASE, DT, PLENTY);
  assert.ok(cmd);
  assert.equal(cmd.action, BRUSH_ERASE);
  // It dispatches over every particle instead -- only the GPU knows which have
  // drifted under the brush.
  assert.equal(cmd.count, 0);
});

test('a bigger brush spawns proportionally more', () => {
  const b = new BrushInput();
  b.setSize(0);
  const small = b.frame([0, 0], BRUSH_SPAWN, DT, PLENTY)?.count ?? 0;
  b.release();
  b.setSize(4);
  const big = b.frame([0, 0], BRUSH_SPAWN, DT, PLENTY)?.count ?? 0;
  assert.ok(big > small * 10, 'area scaling, not radius scaling');
});

test('spawning is capped by what the pool holds', () => {
  const b = new BrushInput();
  const cmd = b.frame([0, 0], BRUSH_SPAWN, DT, 3);
  assert.ok(cmd);
  assert.equal(cmd.count, 3);
});

test('an exhausted pool produces no command', () => {
  const b = new BrushInput();
  // A full world with the brush still down is NORMAL, not an error.
  assert.equal(b.frame([0, 0], BRUSH_SPAWN, DT, 0), null);
});

// ---------------------------------------------------------------------------
// The empty-square guard
// ---------------------------------------------------------------------------

test('an empty palette square paints nothing', () => {
  const b = new BrushInput();
  // The palette fills empty slots with the master's config as a stand-in, so
  // without this guard an empty square silently painted master particles.
  assert.equal(b.frame([0, 0], BRUSH_SPAWN, DT, PLENTY, false), null);
});

test('the ERASER still works with an empty square selected', () => {
  const b = new BrushInput();
  const cmd = b.frame([0, 0], BRUSH_ERASE, DT, PLENTY, false);
  // Rubbing out does not care what is selected, which is what a user reaching
  // for the eraser expects.
  assert.ok(cmd);
  assert.equal(cmd.action, BRUSH_ERASE);
});

test('an empty square still advances the stroke memory', () => {
  const b = new BrushInput();
  b.frame([0, 0], BRUSH_SPAWN, DT, PLENTY, false);
  const cmd = b.frame([1, 0], BRUSH_SPAWN, DT, PLENTY, true);
  // Selecting a real square mid-drag resumes from the cursor rather than from
  // wherever the last real stroke ended.
  assert.deepEqual(cmd?.stroke.from, [0, 0]);
});

// ---------------------------------------------------------------------------
// The rate multiplier
// ---------------------------------------------------------------------------

test('the brush rate multiplier scales the count', () => {
  const b = new BrushInput();
  // dt of exactly 1 second, so the count is `area * SPAWN_RATE * rate` with no
  // frame-rate division -- comparing two INDEPENDENTLY rounded counts would
  // otherwise fail on the rounding rather than on the scaling.
  const atOne = b.frame([0, 0], BRUSH_SPAWN, 1, PLENTY)?.count ?? 0;
  b.release();
  b.weight = 2;
  const atTwo = b.frame([0, 0], BRUSH_SPAWN, 1, PLENTY)?.count ?? 0;
  assert.ok(atOne > 0);
  // Within one particle: doubling the rate doubles the deposit.
  assert.ok(Math.abs(atTwo - atOne * 2) <= 1, `${atTwo} vs ${atOne * 2}`);
});

test('the default rate is 1.0, meaning the tuned SPAWN_RATE', () => {
  assert.equal(new BrushInput().weight, DEFAULT_BRUSH_RATE);
  assert.equal(DEFAULT_BRUSH_RATE, 1.0);
});

test('an exhausted pool still advances the stroke memory', () => {
  const b = new BrushInput();
  b.frame([0, 0], BRUSH_SPAWN, DT, 0);
  const cmd = b.frame([1, 0], BRUSH_SPAWN, DT, PLENTY);
  assert.ok(cmd);
  // The cursor kept moving while the pool was empty; when it refills the stroke
  // must resume from where the cursor actually is, not from where it was when
  // the pool ran dry.
  assert.deepEqual(cmd.stroke.from, [0, 0]);
});
