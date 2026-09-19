import test from 'node:test';
import assert from 'node:assert/strict';

import {
  type SweepState,
  canDropMarkToZero,
  liveCountFrom,
  nextSweepChunk,
  occupancy,
  sortBudgetFor,
  sortedFreeList,
  sweepComplete,
  sweepProgress,
  sweepTargetFor,
  sweepWorthwhile,
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

// ---------------------------------------------------------------------------
// TIER 2 -- the sweep
// ---------------------------------------------------------------------------

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
test('the sweep target leaves headroom above the live count', () => {
  const target = sweepTargetFor(100_000, 1_000_000, 16_384);
  assert.ok(target > 100_000, 'a target at or below live could not be reached');
});

test('the sweep target never exceeds the mark it is packing under', () => {
  // Nothing is gained by aiming above the current bound -- that is where the
  // particles already are.
  assert.equal(sweepTargetFor(900_000, 1_000_000, 16_384), 1_000_000);
});

test('the sweep target is a whole number of budget chunks', () => {
  const budget = 16_384;
  const target = sweepTargetFor(100_000, 1_000_000, budget);
  assert.equal(target % budget, 0, 'a ragged final chunk is avoidable, so avoid it');
});

test('an empty world has a zero target', () => {
  assert.equal(sweepTargetFor(0, 0, 16_384), 0);
});

test('a sweep is worthwhile only when the range is mostly dead', () => {
  assert.ok(sweepWorthwhile(100_000, 1_000_000), 'ten percent live: worth packing');
  assert.ok(!sweepWorthwhile(900_000, 1_000_000), 'ninety percent live: already packed');
});

// A sweep over a small world costs more than it saves: the passes are cheap at
// that scale whatever the occupancy, and the relocation is not free.
test('a sweep is not worthwhile on a world too small to matter', () => {
  assert.ok(!sweepWorthwhile(10, 20_000), 'below the mark floor, however sparse');
});

test('the sweep walks downward in budgeted chunks', () => {
  const budget = 1000;
  let state: SweepState = { hi: 10_000, target: 5000 };
  const first = nextSweepChunk(state, budget);
  assert.deepEqual(first?.lo, 9000);
  assert.deepEqual(first?.hi, 10_000);
  state = first!.next;
  assert.equal(state.hi, 9000, 'the next chunk resumes where this one stopped');
});

// The region BELOW the target is where particles are being packed to. Examining
// it would relocate particles that are already where they belong, and could
// move one out from under a destination another invocation had claimed.
test('the sweep never walks below its target', () => {
  const chunk = nextSweepChunk({ hi: 5500, target: 5000 }, 1000);
  assert.equal(chunk?.lo, 5000, 'the final chunk is clamped, not overshot');
});

test('a finished sweep yields no further chunks', () => {
  assert.equal(nextSweepChunk({ hi: 5000, target: 5000 }, 1000), null);
  assert.ok(sweepComplete({ hi: 5000, target: 5000 }));
  assert.ok(!sweepComplete({ hi: 5001, target: 5000 }));
});

test('a sweep walked to its target completes', () => {
  let state: SweepState = { hi: 10_000, target: 5000 };
  let guard = 0;
  while (!sweepComplete(state) && guard++ < 100) {
    state = nextSweepChunk(state, 1000)!.next;
  }
  assert.ok(sweepComplete(state), 'the walk terminates');
  assert.equal(state.hi, 5000, 'and lands exactly on the target');
});

test('sweep progress spans the walked range, not the whole buffer', () => {
  const mark = 10_000;
  assert.equal(sweepProgress({ hi: 10_000, target: 5000 }, mark), 0);
  assert.equal(sweepProgress({ hi: 7500, target: 5000 }, mark), 0.5);
  assert.equal(sweepProgress({ hi: 5000, target: 5000 }, mark), 1);
});

test('sweep progress is complete when there is no range to walk', () => {
  assert.equal(sweepProgress({ hi: 5000, target: 5000 }, 5000), 1);
});
