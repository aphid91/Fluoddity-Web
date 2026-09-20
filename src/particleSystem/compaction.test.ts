import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canDropMarkToZero,
  liveCountFrom,
  markAfterSpawnReach,
  occupancy,
  sortBudgetFor,
  sortedFreeList,
} from './compaction.ts';
import { initialFreeList } from './freeList.ts';

// ---------------------------------------------------------------------------
// The sort direction is the whole contract: the stack pops from slots[head-1],
// so DESCENDING is what makes the lowest index come out first. Getting this
// backwards would be silent -- the pool would still be valid, still hand out
// every index exactly once, and the mark would creep exactly as it does now.
// ---------------------------------------------------------------------------


test('sortedFreeList puts the lowest index on top of the stack', () => {
  // head = 4, slots scattered as the eraser would have left them.
  const image = new Uint32Array([4, 7, 2, 9, 5]);
  const out = sortedFreeList(image);
  assert.equal(out[0], 4, 'the head is untouched');
  assert.deepEqual([...out.slice(1, 5)], [9, 7, 5, 2]);
  assert.equal(out[4], 2, 'slots[head-1] pops first and is the lowest');
});

test('sortedFreeList preserves the multiset of available indices', () => {
  const image = new Uint32Array([5, 11, 3, 8, 1, 6]);
  const out = sortedFreeList(image);
  assert.deepEqual(
    [...out.slice(1, 6)].sort((a, b) => a - b),
    [1, 3, 6, 8, 11],
    'sorting must not invent, drop or duplicate a slot',
  );
});

// THE REGRESSION GUARD for a double-allocation.
//
// Slots at or above the head are stale residue -- indices that were taken and
// are now LIVE. Sorting the whole array would mix them back into the available
// region, and the pool would hand a live particle's index to a brush.
test('sortedFreeList never touches slots at or above the head', () => {
  // head = 2, so slots[0..2) is available and 99/98 are residue from takes.
  const image = new Uint32Array([2, 4, 1, 99, 98]);
  const out = sortedFreeList(image);
  assert.deepEqual([...out.slice(1, 3)], [4, 1], 'the live region is sorted');
  assert.deepEqual(
    [...out.slice(3)],
    [99, 98],
    'residue above the head must stay exactly where it was',
  );
});

test('sortedFreeList leaves an empty pool alone', () => {
  const image = new Uint32Array([0, 3, 1, 2]);
  assert.deepEqual([...sortedFreeList(image)], [0, 3, 1, 2]);
});

// A torn read during the shader's own overflow-undo can report a head past the
// array. `pollFreeListRead` discards such a value rather than believing it, and
// this takes the same stance rather than sorting a region that does not exist.
test('sortedFreeList discards an impossible head rather than sorting on it', () => {
  const image = new Uint32Array([99, 3, 1, 2]);
  assert.deepEqual([...sortedFreeList(image)], [99, 3, 1, 2]);
});

test('a freshly seeded pool is already in sorted order', () => {
  const fresh = initialFreeList(6);
  assert.deepEqual(
    [...sortedFreeList(fresh)],
    [...fresh],
    'initialFreeList fills descending, which is what the sort produces',
  );
});

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

test('sortBudgetFor is flat regardless of pool size', () => {
  assert.equal(sortBudgetFor(3_000_000, 16_384), 16_384);
  assert.equal(sortBudgetFor(50_000, 16_384), 16_384);
});

test('sortBudgetFor never runs past the head', () => {
  assert.equal(sortBudgetFor(100, 16_384), 100);
});

test('sortBudgetFor does nothing on a pool too small to reorder', () => {
  assert.equal(sortBudgetFor(1, 16_384), 0);
  assert.equal(sortBudgetFor(0, 16_384), 0);
});

// ---------------------------------------------------------------------------
// The mark drop -- the one place Tier 1 changes a bound the passes read.
// ---------------------------------------------------------------------------

test('the mark drops to zero only when the pool is provably empty', () => {
  assert.ok(canDropMarkToZero(1000, 1000, 0));
});

test('a partially full pool never drops the mark', () => {
  assert.ok(!canDropMarkToZero(999, 1000, 0));
});

// THE REGRESSION GUARD for a frozen particle.
//
// The head is a readback and lags a frame or two. A head captured BEFORE a
// spawn still reads full after it, so trusting it alone would zero the mark
// while a freshly painted particle sits above it -- alive in memory, skipped by
// every pass, drawn by nothing.
test('a stale full head is not trusted while spawns are outstanding', () => {
  assert.ok(
    !canDropMarkToZero(1000, 1000, 1),
    'one spawn the readback has not seen is enough to refuse',
  );
});

test('an empty world cannot drop a mark it does not have', () => {
  assert.ok(!canDropMarkToZero(0, 0, 0));
});

// THE RESTORE HAZARD, recorded here because the guard for it lives in the
// orchestrator and this is where a reader will look for the reasoning.
//
// `canDropMarkToZero` is NOT sufficient on its own, and the gap is not a bug in
// it -- it is a limit of what its three arguments can express. A restore
// replaces the whole free list through the encoder, so for a frame or two the
// head describes a pool that no longer exists. Clear a world (head goes full),
// then restore a painted scene, and every argument here looks safe:
//
//     head === entityCount      (stale: from before the restore)
//     spawnedSinceRead === 0    (the restore zeroed it; a restore is not a spawn)
//
// ...so this returns true and the mark the restore just put back would be
// zeroed, leaving the restored particles above the bound: alive in memory,
// skipped by every pass, drawn by nothing.
//
// `spawnedSinceRead` cannot close it. It counts SPAWNS the readback has not
// seen; a wholesale pool replacement is not something it can represent. The
// orchestrator's `markDropHeld` is what closes it, by suppressing the drop
// until a head taken AFTER the restore arrives.
test('a stale full head after a pool rewrite still looks safe here', () => {
  assert.ok(
    canDropMarkToZero(1000, 1000, 0),
    'this returning true is exactly why the caller needs its own hold — see ' +
      '`markDropHeld` in sandOrchestrator.ts',
  );
});

// ---------------------------------------------------------------------------
// The readouts
// ---------------------------------------------------------------------------

test('liveCountFrom is the pool complement', () => {
  assert.equal(liveCountFrom(400, 1000), 600);
  assert.equal(liveCountFrom(1000, 1000), 0);
});

test('liveCountFrom clamps a torn head rather than reporting a negative', () => {
  assert.equal(liveCountFrom(4_294_967_295, 1000), 0);
});

test('occupancy is the fraction of the swept range that is live', () => {
  assert.equal(occupancy(500, 1000), 0.5);
  assert.equal(occupancy(1000, 1000), 1);
});

// An empty world is not fragmented -- it is the best case, not the worst, and
// reporting 0% for it would read as the worst.
test('occupancy calls an empty world packed rather than dividing by zero', () => {
  assert.equal(occupancy(0, 0), 1);
});


// THE REGRESSION GUARD for a sweep that completes on a lie.
//
// The target is chosen from a live count that is ALREADY STALE and that the
// eraser can move again during the many frames a sweep takes. Aiming at exactly
// `live` means a target the sweep may be unable to reach -- `hi` walks all the
// way down with live particles still above it, and completing there sets a mark
// that skips them. They would be alive in memory and invisible.
//
// The headroom is what makes "the sweep finished" and "everything live is below
// the target" the same statement.
// ---------------------------------------------------------------------------
// THE SPAWN REACH.
//
// The mark used to be raised by a COUNT, which assumes the brush took
// contiguous indices from the mark upward. That is true only in a fresh world;
// once the eraser has scattered the pool a stroke takes high indices while the
// mark barely moves, and everything above the bound becomes invisible.
//
// These cover the raise-only rule that replaces it. The GPU measures the reach
// and the readback lags, so the lag has to be safe by construction rather than
// by a guard counter.
// ---------------------------------------------------------------------------

test('a measured reach above the mark raises it', () => {
  // The whole point: a stroke that landed at index 599,998 needs a bound of
  // 599,999, whatever the count said.
  assert.equal(markAfterSpawnReach(150_238, 599_999, 600_000), 599_999);
});

test('a measured reach below the mark leaves it alone', () => {
  // THE REGRESSION GUARD for the fix reintroducing the bug from the other side.
  // The readback lags a frame or two, so a measurement can describe a stroke
  // older than the mark already reflects. Lowering to it would hide the later
  // stroke's particles -- the same failure, arrived at backwards.
  assert.equal(markAfterSpawnReach(500_000, 1_000, 600_000), 500_000);
});

test('an equal reach is a no-op', () => {
  assert.equal(markAfterSpawnReach(1234, 1234, 600_000), 1234);
});

test('the reach is clamped to capacity, never past it', () => {
  // A torn read or a corrupt buffer must not produce a bound past the end of
  // the entity buffer, which every pass would then sweep off the edge of.
  assert.equal(markAfterSpawnReach(0, 999_999, 600_000), 600_000);
});

test('a non-finite reach is discarded rather than believed', () => {
  // NaN compares false against everything, so an unguarded Math.max would
  // propagate it into the bound and every pass would sweep nothing at all.
  //
  // INFINITY IS REFUSED TOO, rather than clamped to capacity. Both mean the same
  // thing here -- the buffer did not report a usable number -- and a corrupt
  // read is not evidence that the world is full. Clamping would invent a
  // whole-buffer bound from garbage; keeping the current mark leaves the world
  // exactly as correct as it was a moment ago.
  assert.equal(markAfterSpawnReach(1000, NaN, 600_000), 1000);
  assert.equal(markAfterSpawnReach(1000, Infinity, 600_000), 1000);
});

test('a negative reach cannot lower the mark below zero', () => {
  assert.equal(markAfterSpawnReach(1000, -5, 600_000), 1000);
  assert.equal(markAfterSpawnReach(0, -5, 600_000), 0);
});

test('the mark itself is clamped, so a stale one cannot exceed capacity', () => {
  // A Max Particles shrink can leave the mark above the new capacity for a
  // frame; the bound handed back must still describe the buffer that exists.
  assert.equal(markAfterSpawnReach(900_000, 10, 600_000), 600_000);
});
