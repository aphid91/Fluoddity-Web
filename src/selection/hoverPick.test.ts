/**
 * The cohort highlight's debounce: when two hover picks agree.
 *
 * WHY THIS TEST EXISTS. The highlight decides two things the user sees
 * immediately -- which particles get dimmed, and which cohort a click takes --
 * from a rule with several ways to be subtly wrong: a miss must break the
 * agreement rather than be skipped over, a raw cohort must never be compared
 * against a floored one, and the "no highlight" sentinel must not collide with
 * a real cohort. Each of those fails as a wrong-looking screen rather than as an
 * error, so each is pinned here.
 *
 * No GPU: this is the decision, which is where those mistakes would live.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CohortHighlight,
  HOVER_PICK_INTERVAL_MS,
  NO_COHORT,
  type HoverSample,
  hoverPickDue,
} from './hoverPick.ts';

/** A hit on `cohort`. The index only has to be non-negative to count as one. */
function hit(cohort: number, index = 7): HoverSample {
  return { index, cohort };
}

/** A miss. `cohort` is meaningless here, and set to a real-looking value on
 *  purpose: nothing may read it once the index says miss. */
const MISS: HoverSample = { index: -1, cohort: 3 };

// ---------------------------------------------------------------------------
// Agreement
// ---------------------------------------------------------------------------

test('two hits on one cohort highlight it', () => {
  const h = new CohortHighlight();
  h.observe(hit(4));
  h.observe(hit(4));
  assert.equal(h.cohort, 4);
  assert.equal(h.isHighlighted, true);
});

test('one pick is never enough', () => {
  // The debounce is the whole reason there are two: a single pick would let the
  // highlight chase the cursor through every particle it passes over.
  const h = new CohortHighlight();
  h.observe(hit(4));
  assert.equal(h.cohort, NO_COHORT);
  assert.equal(h.isHighlighted, false);
});

test('two hits on different cohorts highlight nothing', () => {
  const h = new CohortHighlight();
  h.observe(hit(4));
  h.observe(hit(5));
  assert.equal(h.cohort, NO_COHORT);
});

test('cohort 0 highlights like any other', () => {
  // A regression guard with teeth: 0 is falsy, so any `if (cohort)` anywhere in
  // this path makes the first cohort the one that cannot be highlighted -- and
  // it is the cohort a user is most likely to click first.
  const h = new CohortHighlight();
  h.observe(hit(0));
  h.observe(hit(0));
  assert.equal(h.cohort, 0);
  assert.equal(h.isHighlighted, true);
});

// ---------------------------------------------------------------------------
// Misses
// ---------------------------------------------------------------------------

test('a miss on either side highlights nothing', () => {
  const before = new CohortHighlight();
  before.observe(MISS);
  before.observe(hit(4));
  assert.equal(before.cohort, NO_COHORT, 'miss then hit');

  const after = new CohortHighlight();
  after.observe(hit(4));
  after.observe(MISS);
  assert.equal(after.cohort, NO_COHORT, 'hit then miss');
});

test('two misses agree on nothing', () => {
  // Not "they agree, so highlight cohort 3" -- a miss carries no cohort at all,
  // and the sample above sets a real-looking one precisely to catch that read.
  const h = new CohortHighlight();
  h.observe(MISS);
  h.observe(MISS);
  assert.equal(h.cohort, NO_COHORT);
});

test('a miss CLEARS an established highlight', () => {
  // Moving the mouse off the particles must put the highlight out. This is why
  // misses are observed rather than discarded: dropping them would leave the
  // last two hits agreeing forever, and the highlight would stick to whatever
  // the mouse last passed over.
  const h = new CohortHighlight();
  h.observe(hit(4));
  h.observe(hit(4));
  assert.equal(h.cohort, 4);

  h.observe(MISS);
  assert.equal(h.cohort, NO_COHORT);
});

test('the highlight re-forms after two fresh agreeing picks', () => {
  const h = new CohortHighlight();
  h.observe(hit(4));
  h.observe(MISS);
  h.observe(hit(9));
  assert.equal(h.cohort, NO_COHORT, 'still one pick short');
  h.observe(hit(9));
  assert.equal(h.cohort, 9);
});

// ---------------------------------------------------------------------------
// Only the last two matter
// ---------------------------------------------------------------------------

test('a third pick evicts the first', () => {
  const h = new CohortHighlight();
  h.observe(hit(4));
  h.observe(hit(4));
  h.observe(hit(5));
  // 4 and 5 disagree; the older 4 is gone and cannot rescue the agreement.
  assert.equal(h.cohort, NO_COHORT);
  h.observe(hit(5));
  assert.equal(h.cohort, 5);
});

// ---------------------------------------------------------------------------
// lastResult -- what a click adopts
// ---------------------------------------------------------------------------

test('lastResult is the most recent pick, and null before any', () => {
  const h = new CohortHighlight();
  assert.equal(h.lastResult, null);

  const first = hit(4, 11);
  const second = hit(4, 12);
  h.observe(first);
  h.observe(second);
  // The result whose agreement lit the highlight -- this is the exact object a
  // click adopts instead of firing its own pick, so identity matters, not just
  // the cohort.
  assert.equal(h.lastResult, second);
});

test('clear forgets both samples', () => {
  // Called when the premise changes rather than the answer: leaving Select, or
  // a click that adopts a rule (after which every particle obeys something new,
  // so the highlighted cohort is historical).
  const h = new CohortHighlight();
  h.observe(hit(4));
  h.observe(hit(4));
  h.clear();
  assert.equal(h.cohort, NO_COHORT);
  assert.equal(h.lastResult, null);

  // And one pick after a clear is still one short, exactly as from cold.
  h.observe(hit(4));
  assert.equal(h.cohort, NO_COHORT);
});

// ---------------------------------------------------------------------------
// The sentinel
// ---------------------------------------------------------------------------

test('NO_COHORT is negative, so it cannot collide with a real cohort', () => {
  // `get_cohort` is a non-negative ramp and the shader floors it, so every real
  // cohort is >= 0. The shader reads this same sentinel out of a float uniform
  // lane (`highlighted_cohort() >= 0.0`), which is only sound while this holds.
  assert.ok(NO_COHORT < 0);
});

// ---------------------------------------------------------------------------
// The interval
// ---------------------------------------------------------------------------

test('hoverPickDue fires at the interval, not before', () => {
  assert.equal(hoverPickDue(0, 0), false);
  assert.equal(hoverPickDue(HOVER_PICK_INTERVAL_MS - 1, 0), false);
  // `>=`, so a tick landing exactly on the boundary is not skipped.
  assert.equal(hoverPickDue(HOVER_PICK_INTERVAL_MS, 0), true);
  assert.equal(hoverPickDue(10_000, 9_000), true);
});

test('the interval is the half second the feature asks for', () => {
  assert.equal(HOVER_PICK_INTERVAL_MS, 500);
});
