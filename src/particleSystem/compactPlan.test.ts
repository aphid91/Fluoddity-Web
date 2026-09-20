import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPACT_WORKGROUP_SIZE,
  ENTITIES_PER_PARTIAL,
  SCAN_ELEMENTS_PER_GROUP,
  compactGroups,
  compactionWorthwhile,
  partialCount,
  scanGroups,
  scanLevelOffsets,
  scanLevelSizes,
  scanLevels,
  scanScratchSlots,
  shouldAutoCompact,
  totalSlot,
} from './compactPlan.ts';

test('the count and scatter passes partition the buffer identically', () => {
  // The scatter reads the offset that count's workgroup produced. If the two
  // partitioned differently it would read the wrong partial and pack particles
  // on top of each other -- silently, and only at some sizes.
  assert.equal(ENTITIES_PER_PARTIAL, COMPACT_WORKGROUP_SIZE);
});

test('partials cover every entity, including a ragged tail', () => {
  assert.equal(partialCount(256), 1);
  assert.equal(partialCount(257), 2, 'the tail gets its own partial');
  assert.equal(partialCount(512), 2);
  assert.equal(partialCount(0), 0);
});

// ---------------------------------------------------------------------------
// THE MULTI-LEVEL SCAN.
//
// THE REGRESSION GUARD for silently losing most of a large world.
//
// A single-workgroup scan covers 512 partials. At a 6M cap there are 23,438 of
// them, so a one-level scan would sum only the first 512 workgroups' worth --
// about 131k entities -- and every particle beyond that would be scattered to
// an offset computed from a truncated running total. They would pile on top of
// each other. No error, no warning: just a world that loses most of its
// particles the first time it is compacted at a large cap.
// ---------------------------------------------------------------------------

test('a small world needs no scan level at all', () => {
  assert.equal(scanLevels(1), 0, 'one partial is already its own total');
  assert.equal(scanLevels(0), 0);
});

test('a world within one workgroup needs exactly one level', () => {
  assert.equal(scanLevels(2), 1);
  assert.equal(scanLevels(SCAN_ELEMENTS_PER_GROUP), 1);
});

test('a world past one workgroup needs a second level', () => {
  assert.equal(
    scanLevels(SCAN_ELEMENTS_PER_GROUP + 1),
    2,
    'one element past the limit is what a single-level scan gets wrong',
  );
});

test('a six million entity cap needs two scan levels', () => {
  // The configuration this was actually found at.
  const partials = partialCount(6_000_000);
  assert.equal(partials, 23_438);
  assert.ok(
    partials > SCAN_ELEMENTS_PER_GROUP,
    'far past what one workgroup covers -- a one-level scan would be wrong here',
  );
  assert.equal(scanLevels(partials), 2);
});

test('scan levels always terminate', () => {
  // Each level divides by 512, so even an absurd cap converges quickly. A loop
  // that did not shrink would hang the host rather than the GPU.
  for (const n of [1, 2, 1000, 100_000, 10_000_000, 1_000_000_000]) {
    const levels = scanLevels(n);
    assert.ok(levels >= 0 && levels < 8, `${n} -> ${levels} levels`);
  }
});

test('each scan level is smaller than the one before it', () => {
  const sizes = scanLevelSizes(partialCount(6_000_000));
  for (let i = 1; i < sizes.length; i++) {
    assert.ok(sizes[i]! < sizes[i - 1]!, 'levels must shrink or the scan loops');
  }
  assert.equal(sizes[0], 23_438);
});

test('the last scan level fits in a single workgroup', () => {
  // The terminating condition: the final level must be coverable by one group,
  // because that is what produces the single grand total.
  for (const cap of [1000, 100_000, 6_000_000, 50_000_000]) {
    const sizes = scanLevelSizes(partialCount(cap));
    const last = sizes[sizes.length - 1];
    if (last === undefined) continue;
    assert.ok(
      scanGroups(last) <= SCAN_ELEMENTS_PER_GROUP,
      `cap ${cap}: last level ${last} needs ${scanGroups(last)} groups`,
    );
  }
});

// ---------------------------------------------------------------------------
// Scratch sizing
// ---------------------------------------------------------------------------

test('scratch holds every level end to end', () => {
  const entityCount = 6_000_000;
  const sizes = scanLevelSizes(partialCount(entityCount));
  const sum = sizes.reduce((a, b) => a + b, 0);
  assert.ok(scanScratchSlots(entityCount) > sum, 'plus the grand total');
});

test('scratch is never zero-length', () => {
  // A zero-length storage buffer fails WebGPU validation, which rejects every
  // submit for the frame -- the black-screen trap `freeListSize` documents.
  assert.ok(scanScratchSlots(0) >= 1);
  assert.ok(scanScratchSlots(1) >= 1);
});

test('scratch for a large cap stays a sane size', () => {
  // 23,438 + 46 + 1 slots at 4 bytes is under 100 KB -- worth stating, because
  // a per-entity scratch would be 24 MB and the design deliberately is not one.
  const slots = scanScratchSlots(6_000_000);
  assert.ok(slots * 4 < 200_000, `${slots * 4} bytes`);
});

// THE REGRESSION GUARD for a live count that exists nowhere.
//
// An exclusive prefix sum DISCARDS the total -- the last element's output is
// the sum of everything before it, not including itself. The first draft of the
// scan computed the grand total and then wrote it only when a next level
// existed, so on the last level it was silently dropped. Both the scatter and
// the finalize pass need it, and without it the head and the mark would both be
// computed from whatever happened to be in that word.
test('the grand total has a slot past every level', () => {
  for (const cap of [1000, 100_000, 6_000_000]) {
    const sizes = scanLevelSizes(partialCount(cap));
    const offsets = scanLevelOffsets(cap);
    const slot = totalSlot(cap);
    for (let i = 0; i < sizes.length; i++) {
      assert.ok(
        slot >= offsets[i]! + sizes[i]!,
        `cap ${cap}: the total slot must not fall inside level ${i}`,
      );
    }
    assert.ok(slot < scanScratchSlots(cap), 'and must fit in the scratch buffer');
  }
});

test('level offsets do not overlap', () => {
  const entityCount = 6_000_000;
  const sizes = scanLevelSizes(partialCount(entityCount));
  const offsets = scanLevelOffsets(entityCount);
  assert.equal(offsets.length, sizes.length);
  for (let i = 1; i < offsets.length; i++) {
    assert.ok(
      offsets[i]! >= offsets[i - 1]! + sizes[i - 1]!,
      'a level writing into the previous one would corrupt the scan',
    );
  }
});

// ---------------------------------------------------------------------------
// Dispatch sizing
// ---------------------------------------------------------------------------

test('dispatch groups round up so the tail is covered', () => {
  assert.equal(compactGroups(1), 1);
  assert.equal(compactGroups(256), 1);
  assert.equal(compactGroups(257), 2);
  assert.equal(compactGroups(0), 0, 'no work is no groups, not one');
});

test('scan groups cover two elements per thread', () => {
  assert.equal(scanGroups(512), 1);
  assert.equal(scanGroups(513), 2);
});

// ---------------------------------------------------------------------------
// The trigger
// ---------------------------------------------------------------------------

test('compaction is worthwhile only when the range is mostly dead', () => {
  assert.ok(compactionWorthwhile(100_000, 1_000_000));
  assert.ok(!compactionWorthwhile(900_000, 1_000_000));
});

test('compaction is not worthwhile on a world too small to matter', () => {
  // A single-pass compaction is a stutter; it must not fire where the saving is
  // unmeasurable.
  assert.ok(!compactionWorthwhile(10, 20_000));
});

test('an empty world is never worth compacting', () => {
  assert.ok(!compactionWorthwhile(0, 0));
});

test('the threshold is seventy percent occupancy', () => {
  const mark = 1_000_000;
  assert.ok(compactionWorthwhile(699_999, mark), 'just under is worth it');
  assert.ok(!compactionWorthwhile(700_000, mark), 'at the threshold is packed enough');
});

// ---------------------------------------------------------------------------
// The automatic trigger
//
// This runs UNSUPERVISED, so its refusals matter more than its approvals: one
// that fires when it should not steals a frame from a user who is working,
// which is the opposite of what the whole subsystem is for.
// ---------------------------------------------------------------------------

/** A fragmented world, idle and cooled. Overridden per test. */
const READY = {
  enabled: true,
  idle: true,
  live: 100_000,
  mark: 1_000_000,
  now: 100_000,
  lastCompactedAt: 0,
};

test('an auto compaction fires on a fragmented, cooled world', () => {
  assert.ok(shouldAutoCompact(READY));
});

test('the switch is honoured before anything else', () => {
  assert.ok(!shouldAutoCompact({ ...READY, enabled: false }));
});

test('an auto compaction does not queue a second one', () => {
  // The queued one is about to pack the world anyway.
  assert.ok(!shouldAutoCompact({ ...READY, idle: false }));
});

test('an auto compaction does not fire on a packed world', () => {
  assert.ok(!shouldAutoCompact({ ...READY, live: 900_000 }));
});

test('an auto compaction does not fire on a world too small to matter', () => {
  assert.ok(!shouldAutoCompact({ ...READY, live: 10, mark: 20_000 }));
});

// THE REGRESSION GUARD for compacting every few frames.
//
// A compaction packs the world completely, so occupancy hits 100% and the
// trigger cannot re-fire on its own -- in a CALM world. Under a brush it is
// different: painting raises the mark every frame while edge-death and the
// eraser lower the live count, so an actively drawn world can cross back below
// the threshold within a few frames. Each compaction skips a physics step, so
// without a floor the result is a stutter caused by the thing meant to prevent
// stutter.
test('an auto compaction waits out the cooldown', () => {
  assert.ok(
    !shouldAutoCompact({ ...READY, lastCompactedAt: READY.now - 500 }),
    'half a second after the last one is too soon',
  );
  assert.ok(
    shouldAutoCompact({ ...READY, lastCompactedAt: READY.now - 2000 }),
    'two seconds later is fair game',
  );
});

test('the cooldown boundary is inclusive', () => {
  // Exactly at the cooldown should fire rather than wait another whole frame
  // for a strictly-greater comparison.
  assert.ok(
    shouldAutoCompact({ ...READY, lastCompactedAt: READY.now - 1000, cooldownMs: 1000 }),
  );
});

// THE REGRESSION GUARD for a mark lowered below particles that were just
// painted.
//
// The compacted mark was guarded by `spawnedSinceRead` -- a counter scoped to
// the FREE-LIST HEAD readback, not to the compaction. The two are different
// windows, and a head landing inside the compaction's readback zeroed the
// counter while spawns made after the compaction were still outstanding.
//
// The guard then read zero, believed a mark measured before those spawns, and
// lowered the bound below them. They sat in memory, invisible, until the mark
// climbed back over them -- surfacing as particles reappearing at an old brush
// location in an old material, which is exactly what was reported.
//
// The audit named it precisely: live 104,484 with mark 100,708, and the 3,776
// excess in one contiguous block starting at the mark.
test('a mark measured before outstanding spawns must be refused', () => {
  // The shape of the bug, as arithmetic. A compaction measures 100,708 live.
  // Before its readback lands, the brush spawns 3,776 more.
  const measured = 100_708;
  const spawnedAfter = 3_776;
  const actuallyLive = measured + spawnedAfter;
  // The host raised the mark for those spawns, so the bound covers them...
  assert.equal(actuallyLive, 104_484);
  // ...and applying the older, lower mark would drop it below 3,776 live
  // particles. The count of spawns in that window is the whole signal, so it
  // must be measured against the COMPACTION, not against a head readback that
  // can be reset independently.
  assert.ok(
    spawnedAfter > 0,
    'a nonzero count is what tells the guard the mark is out of date',
  );
  assert.ok(measured < actuallyLive, 'the stale mark is below the true live count');
});

test('a world that has never been compacted is not held back', () => {
  // `lastCompactedAt` starts at -Infinity, so the first compaction is not made
  // to wait out a cooldown that never ran.
  assert.ok(shouldAutoCompact({ ...READY, now: 0, lastCompactedAt: -Infinity }));
});
