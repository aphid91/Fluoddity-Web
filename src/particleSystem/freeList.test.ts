import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEAD_CONFIG,
  FREE_LIST_HEADER_BYTES,
  FREE_LIST_SLOT_BYTES,
  deadEntityBytes,
  freeListAfterMigration,
  freeListSize,
  initialFreeList,
  spawnCountFor,
} from './freeList.ts';
import { ENTITY, ENTITY_STRIDE } from './layout.ts';

test('freeListSize is a header plus one u32 per entity', () => {
  assert.equal(freeListSize(0), FREE_LIST_HEADER_BYTES);
  assert.equal(freeListSize(10), FREE_LIST_HEADER_BYTES + 10 * FREE_LIST_SLOT_BYTES);
});

test('the studio dummy is still a legal buffer', () => {
  // A zero-sized storage buffer is invalid in WebGPU, and the binding must exist
  // in both apps. The header alone is what keeps the dummy allocatable.
  assert.ok(freeListSize(0) > 0);
});

test('initialFreeList marks every index available exactly once', () => {
  const list = initialFreeList(5);
  assert.equal(list[0], 5, 'head is the count of available slots');
  assert.deepEqual([...list.slice(1)].sort((a, b) => a - b), [0, 1, 2, 3, 4]);
});

test('an empty pool has a zero head', () => {
  assert.deepEqual([...initialFreeList(0)], [0]);
});

// ---------------------------------------------------------------------------
// The lane offsets `deadEntityBytes` writes are the ones `common.wgsl` reads.
// Hardcoding them would be a silent corruption if Entity ever moved: the buffer
// would be written to the wrong lane and every particle would read as alive.
// ---------------------------------------------------------------------------

test('deadEntityBytes writes config_index where the layout says it is', () => {
  const misc = ENTITY.members.find((m) => m.name === 'misc');
  assert.ok(misc, 'Entity has a misc member');
  // config_index is misc.y -- the second lane of that vec4.
  const configIndexLane = misc.floatIndex + 1;
  assert.equal(configIndexLane, 5, 'the lane deadEntityBytes hardcodes');
  assert.equal(ENTITY_STRIDE / 4, 8, 'floats per entity');

  const bytes = deadEntityBytes(3);
  assert.equal(bytes.byteLength, 3 * ENTITY_STRIDE);

  const ints = new Int32Array(bytes);
  for (let i = 0; i < 3; i++) {
    assert.equal(ints[i * 8 + configIndexLane], DEAD_CONFIG, `entity ${i} is dead`);
  }
});

test('deadEntityBytes zeroes every lane except config_index', () => {
  // The trap this guards: a naively zeroed buffer is a buffer of LIVE particles
  // on config 0, not an empty world.
  const ints = new Int32Array(deadEntityBytes(2));
  for (let i = 0; i < ints.length; i++) {
    if (i % 8 === 5) continue;
    assert.equal(ints[i], 0, `lane ${i % 8} of entity ${Math.floor(i / 8)} is zero`);
  }
});

test('a dead config index is negative', () => {
  // The whole convention: `e_is_dead` tests `< 0`, so any negative value works
  // and zero must never be used.
  assert.ok(DEAD_CONFIG < 0);
});

// ---------------------------------------------------------------------------
// spawnCountFor
// ---------------------------------------------------------------------------

test('spawn count is proportional to AREA, not radius', () => {
  // The rate cancels pi so both counts are exact integers. Rounding happens per
  // call, so comparing two independently-rounded counts would fail on the
  // rounding rather than on the relationship (52.36 -> 52 but 209.44 -> 209,
  // and 52*4 is 208).
  const rate = 100 / Math.PI;
  const small = spawnCountFor(1, rate, 1, Infinity); // area*rate = 100
  const big = spawnCountFor(2, rate, 1, Infinity); //  area*rate = 400
  assert.equal(small, 100);
  assert.equal(big, 400);
  // Twice the radius covers four times the canvas, so it deposits four times
  // the material -- requirement 5, and what makes a big brush feel like a wide
  // nozzle rather than a thin one dragged faster.
  assert.equal(big, small * 4);
});

test('spawn count is clamped to what the pool can supply', () => {
  assert.equal(spawnCountFor(100, 10_000, 1, 7), 7);
});

test('spawn count is zero for degenerate inputs', () => {
  assert.equal(spawnCountFor(0, 1000, 1, 100), 0);
  assert.equal(spawnCountFor(5, 0, 1, 100), 0);
  assert.equal(spawnCountFor(5, 1000, 0, 100), 0);
  assert.equal(spawnCountFor(5, 1000, 1, 0), 0);
});

test('spawn count scales with dt, so a drag is frame-rate independent', () => {
  // The rate is chosen so `area * rate` is exactly 1800, making the counts whole
  // numbers at both frame rates. The count is ROUNDED, so a rate landing near a
  // half would make this assert a rounding artifact rather than the
  // proportionality it exists to pin.
  const radius = 3;
  const rate = 1800 / (Math.PI * radius * radius);
  const at30 = spawnCountFor(radius, rate, 1 / 30, Infinity);
  const at60 = spawnCountFor(radius, rate, 1 / 60, Infinity);
  assert.equal(at30, 60);
  assert.equal(at60, 30);
  assert.equal(at30, at60 * 2);
});

// ---------------------------------------------------------------------------
// Migration -- rebuilding the pool after a Max Particles change
// ---------------------------------------------------------------------------

test('after migration the head is the number of free slots', () => {
  const list = freeListAfterMigration(10, 4);
  assert.equal(list[0], 6, '10 slots, 4 live');
});

test('the migrated pool holds exactly the slots past the live block', () => {
  const list = freeListAfterMigration(10, 4);
  const slots = [...list.slice(1, 1 + 6)].sort((a, b) => a - b);
  assert.deepEqual(slots, [4, 5, 6, 7, 8, 9]);
});

test('the lowest free index is on top, so allocation runs upward', () => {
  const list = freeListAfterMigration(10, 4);
  const head = list[0]!;
  // The stack pops slots[head-1]; that should be the first slot after the live
  // block, so a migrated world fills contiguously rather than scattering.
  assert.equal(list[head], 4);
});

test('a full buffer after migration has an empty pool', () => {
  const list = freeListAfterMigration(5, 5);
  assert.equal(list[0], 0);
});

test('migration clamps a live count past the buffer', () => {
  // Truncation is silent and specified: more live particles than slots means
  // the excess is dropped, and the pool is simply empty.
  const list = freeListAfterMigration(5, 99);
  assert.equal(list[0], 0);
});
