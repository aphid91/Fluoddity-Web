import test from 'node:test';
import assert from 'node:assert/strict';

import { auditPool, formatAudit, summarizeAudit } from './poolAudit.ts';

/**
 * THE AUDITOR IS ONLY USEFUL IF IT IS TRUSTED, so it is tested against worlds
 * whose correct verdict is obvious by inspection. Each case below is a shape
 * one of the real compaction bugs produced.
 */

/** A world of `capacity` slots with `live` indices alive, packed at the front. */
function packed(capacity: number, live: number) {
  const liveFlags = Array.from({ length: capacity }, (_, i) => i < live);
  const poolSlots = Array.from({ length: capacity - live }, (_, i) => live + i);
  return { liveFlags, poolSlots, mark: live, capacity };
}

test('a packed world passes every invariant', () => {
  const audit = auditPool(packed(10, 4));
  assert.ok(audit.ok, formatAudit(audit));
  assert.equal(audit.liveCount, 4);
  assert.equal(audit.poolCount, 6);
  assert.equal(audit.highestLive, 3);
});

test('a fragmented but consistent world passes', () => {
  // Live at 0, 3, 7. Everything else free. This is the NORMAL state after
  // erasing -- fragmentation is not itself a violation.
  const liveFlags = [true, false, false, true, false, false, false, true, false, false];
  const poolSlots = [1, 2, 4, 5, 6, 8, 9];
  const audit = auditPool({ liveFlags, poolSlots, mark: 8, capacity: 10 });
  assert.ok(audit.ok, formatAudit(audit));
  assert.equal(audit.liveCount, 3);
});

test('an empty world passes', () => {
  const audit = auditPool({
    liveFlags: new Array(5).fill(false),
    poolSlots: [0, 1, 2, 3, 4],
    mark: 0,
    capacity: 5,
  });
  assert.ok(audit.ok, formatAudit(audit));
  assert.equal(audit.highestLive, -1);
});

// --- invariant 1 -----------------------------------------------------------
// THE MOST SEVERE: a brush taking one of these overwrites a live particle, so
// user work is destroyed with no error anywhere.

test('a live index offered by the pool is caught', () => {
  const liveFlags = [true, true, false, false];
  // 1 is alive and must not be offered.
  const poolSlots = [1, 2, 3];
  const audit = auditPool({ liveFlags, poolSlots, mark: 2, capacity: 4 });
  assert.ok(!audit.ok);
  const v = audit.violations.find((x) => x.kind === 'live-in-pool');
  assert.ok(v, 'the live-in-pool violation is reported');
  assert.deepEqual(v.samples, [1]);
});

// --- invariant 2 -----------------------------------------------------------

test('a double free is caught', () => {
  const liveFlags = [false, false, false];
  const poolSlots = [0, 1, 1, 2];
  const audit = auditPool({ liveFlags, poolSlots, mark: 0, capacity: 3 });
  const v = audit.violations.find((x) => x.kind === 'duplicate-in-pool');
  assert.ok(v, 'the duplicate is reported');
  assert.deepEqual(v.samples, [1]);
});

// --- invariant 3 -----------------------------------------------------------
// THE PHANTOM-PARTICLE SHAPE. Dead slots missing from the pool are leaked, and
// because the UI derives the live count from the head, they read as live and no
// amount of erasing brings them back.

test('leaked dead slots are caught', () => {
  const liveFlags = [true, false, false, false];
  // 2 and 3 are dead but not offered -- they will read as live forever.
  const poolSlots = [1];
  const audit = auditPool({ liveFlags, poolSlots, mark: 1, capacity: 4 });
  const v = audit.violations.find((x) => x.kind === 'unaccounted');
  assert.ok(v, 'the leak is reported');
  assert.equal(v.count, 2);
  assert.deepEqual(v.samples, [2, 3]);
});

test('the leak size matches the phantom count exactly', () => {
  // A 1000-slot world, 100 truly live, but the pool only offers 200 -- so the
  // UI computes 1000 - 200 = 800 live. The 700 phantoms ARE the leak.
  const capacity = 1000;
  const liveFlags = Array.from({ length: capacity }, (_, i) => i < 100);
  const poolSlots = Array.from({ length: 200 }, (_, i) => 800 + i);
  const audit = auditPool({ liveFlags, poolSlots, mark: 100, capacity });
  const leak = audit.violations.find((x) => x.kind === 'unaccounted');
  const uiWouldReport = capacity - audit.poolCount;
  assert.equal(uiWouldReport - audit.liveCount, leak?.count, 'leak == phantoms');
});

// --- invariant 4 -----------------------------------------------------------
// THE BLACK-SCREEN SHAPE. A live particle at or above the mark is skipped by
// every pass and drawn by nothing.

test('live particles above the mark are caught', () => {
  const liveFlags = [false, false, true, true];
  const poolSlots = [0, 1];
  // The mark says nothing lives at 2 or above. Two particles do.
  const audit = auditPool({ liveFlags, poolSlots, mark: 2, capacity: 4 });
  const v = audit.violations.find((x) => x.kind === 'mark-too-low');
  assert.ok(v, 'the invisible particles are reported');
  assert.equal(v.count, 2);
  assert.deepEqual(v.samples, [2, 3]);
});

test('a mark exactly at the highest live index plus one is fine', () => {
  const liveFlags = [true, true, false, false];
  const poolSlots = [2, 3];
  const audit = auditPool({ liveFlags, poolSlots, mark: 2, capacity: 4 });
  assert.ok(audit.ok, formatAudit(audit));
});

// --- the host's belief ------------------------------------------------------

test('a cached head wildly out of step is caught', () => {
  // Far past anything readback lag could explain: the two describe different
  // worlds, so the brush is budgeting against a number the pool disowns.
  const audit = auditPool({ ...packed(1_000_000, 4), cachedHead: 1 });
  const v = audit.violations.find((x) => x.kind === 'head-mismatch');
  assert.ok(v, 'the divergence is reported');
});

test('a matching cached head is not a violation', () => {
  const audit = auditPool({ ...packed(10, 4), cachedHead: 6 });
  assert.ok(audit.ok, formatAudit(audit));
  assert.equal(audit.headDrift, 0);
});

// THE REGRESSION GUARD for drowning the real invariants in noise.
//
// The cached head is a readback and lags by design, and BC_KILL returns an
// index to the pool on EVERY physics sub-step -- so a small drift is the normal
// state of a running world. Reporting it as a violation marked a compaction
// BROKEN that had in fact satisfied all four invariants, with the actual
// numbers (live == mark, live + pool == capacity) sitting right there in the
// same report saying it was fine.
test('a small cached-head drift is lag, not a violation', () => {
  const audit = auditPool({ ...packed(1_000_000, 4), cachedHead: 999_996 - 300 });
  assert.ok(audit.ok, formatAudit(audit));
  assert.equal(audit.headDrift, 300, 'still reported, just not as a fault');
});

test('the drift is shown in the report even when healthy', () => {
  // A drift that GROWS across successive audits is a signal while each one
  // still passes, and hiding it would make the tolerance itself invisible.
  const audit = auditPool({ ...packed(1_000_000, 4), cachedHead: 999_996 - 50 });
  assert.match(formatAudit(audit), /cached head drift: 50/);
});

// --- garbage ----------------------------------------------------------------

test('out-of-range pool entries are caught before anything else', () => {
  const audit = auditPool({
    liveFlags: [false, false],
    poolSlots: [0, 1, 4294967295],
    mark: 0,
    capacity: 2,
  });
  assert.equal(audit.violations[0]?.kind, 'out-of-range');
});

// --- reporting --------------------------------------------------------------

test('the summary states the counts even when healthy', () => {
  const line = summarizeAudit(auditPool(packed(10, 4)));
  assert.match(line, /POOL OK/);
  assert.match(line, /live 4/);
});

test('the report shows the accounting identity', () => {
  // live + pool == capacity is the single clearest signal, so it is always
  // printed -- seeing it hold is how a reader learns to trust the rest.
  const report = formatAudit(auditPool(packed(10, 4)));
  assert.match(report, /live \+ pool = 10/);
  assert.match(report, /✓/);
});

test('a broken report names the worst violation in its first line', () => {
  const liveFlags = [true, true, false];
  const audit = auditPool({ liveFlags, poolSlots: [1, 2], mark: 2, capacity: 3 });
  assert.match(summarizeAudit(audit), /POOL BROKEN/);
  assert.match(formatAudit(audit), /MISMATCH|live-in-pool/);
});
