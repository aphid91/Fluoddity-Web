/**
 * The two-stage selection: click to aim, click again to commit.
 *
 * WHY THIS TEST EXISTS. This module decides whether a click changes the project,
 * and it is the only thing standing between "you always see what you are about
 * to select" and two much worse behaviours: a first click that silently adopts a
 * rule the user was only pointing at, or a second click that refuses to commit
 * and leaves the feature feeling broken. Both are user-visible and neither
 * raises anything, so every transition of the three-outcome rule is pinned here.
 *
 * No GPU: this is the decision, which is where those mistakes would live.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CohortHighlight,
  NO_COHORT,
  type PickSample,
} from './cohortHighlight.ts';

/** A hit on `cohort`. The index only has to be non-negative to count as one. */
function hit(cohort: number, index = 7): PickSample {
  return { index, cohort };
}

/** A miss. `cohort` is set to a real-looking value on purpose: nothing may read
 *  it once the index says miss. */
const MISS: PickSample = { index: -1, cohort: 3 };

// ---------------------------------------------------------------------------
// The three outcomes
// ---------------------------------------------------------------------------

test('the first click on a cohort aims, it does not commit', () => {
  // THE WHOLE POINT OF THE FEATURE. If this ever returned 'commit', a single
  // click would adopt a rule the user was only pointing at -- which is exactly
  // the behaviour the two-stage design replaced.
  const h = new CohortHighlight();
  assert.equal(h.apply(hit(4)), 'highlight');
  assert.equal(h.cohort, 4);
  assert.equal(h.isHighlighted, true);
});

test('a second click inside the lit cohort commits', () => {
  const h = new CohortHighlight();
  h.apply(hit(4));
  assert.equal(h.apply(hit(4)), 'commit');
});

test('a click on a DIFFERENT cohort re-aims rather than committing', () => {
  const h = new CohortHighlight();
  h.apply(hit(4));
  assert.equal(h.apply(hit(5)), 'highlight');
  assert.equal(h.cohort, 5, 'the new cohort replaces the old one');
});

test('a miss unhighlights', () => {
  const h = new CohortHighlight();
  h.apply(hit(4));
  assert.equal(h.apply(MISS), 'unhighlight');
  assert.equal(h.cohort, NO_COHORT);
});

test('a miss with nothing lit is still an unhighlight, and harmless', () => {
  // Clicking empty space with no aim in progress must not commit or throw --
  // it is simply a click that does nothing.
  const h = new CohortHighlight();
  assert.equal(h.apply(MISS), 'unhighlight');
  assert.equal(h.cohort, NO_COHORT);
});

test('a miss can never be mistaken for the unlit sentinel', () => {
  // THE COLLISION THIS GUARDS. `pick.ts` gives a real MISS `cohort: -1`, which
  // is the SAME NUMBER as `NO_COHORT` -- deliberately, since both mean "no
  // cohort". That makes `sample.cohort === this.highlighted` true for a miss
  // arriving while nothing is lit, so on the cohort test alone a miss would read
  // as a commit and adopt a rule from a click that hit nothing.
  //
  // Two things prevent it: the miss test runs first, and `classify` also
  // requires `isHighlighted`. Either alone suffices today, so this pins the
  // OUTCOME rather than the implementation -- it must stay green however those
  // two are arranged, and red if both go.
  //
  // The sample is built with the colliding value explicitly, rather than reusing
  // the fixture at the top of this file, because the collision is the whole
  // point of the test.
  const missAtSentinel: PickSample = { index: -1, cohort: NO_COHORT };

  const cold = new CohortHighlight();
  assert.equal(cold.classify(missAtSentinel), 'unhighlight', 'a miss on a cold state');
  assert.equal(cold.apply(missAtSentinel), 'unhighlight');

  // And after a commit, which returns the state to unlit by that same sentinel.
  const used = new CohortHighlight();
  used.apply(hit(4));
  used.apply(hit(4));
  assert.equal(used.classify(missAtSentinel), 'unhighlight', 'a miss after a commit');
  assert.equal(used.apply(missAtSentinel), 'unhighlight');
});

// ---------------------------------------------------------------------------
// The commit clears
// ---------------------------------------------------------------------------

test('committing puts the highlight out', () => {
  // Adoption changes what every particle is chasing, so the lit cohort no longer
  // names what it did. Left lit, the field would stay dimmed against a
  // historical answer AND the very next click inside it would commit again --
  // a second rule change the user never aimed.
  const h = new CohortHighlight();
  h.apply(hit(4));
  h.apply(hit(4));
  assert.equal(h.cohort, NO_COHORT);
  assert.equal(h.isHighlighted, false);
});

test('the click after a commit aims afresh', () => {
  const h = new CohortHighlight();
  h.apply(hit(4));
  h.apply(hit(4));
  // Same cohort, but nothing is lit now -- so this aims rather than committing.
  assert.equal(h.apply(hit(4)), 'highlight');
});

test('three clicks on one cohort are: aim, commit, aim', () => {
  // The full cycle in one place, because the alternating property is the thing a
  // user actually experiences and it is easy to break by one state assignment.
  const h = new CohortHighlight();
  assert.deepEqual(
    [h.apply(hit(4)), h.apply(hit(4)), h.apply(hit(4))],
    ['highlight', 'commit', 'highlight'],
  );
});

// ---------------------------------------------------------------------------
// Cohort 0
// ---------------------------------------------------------------------------

test('cohort 0 aims and commits like any other', () => {
  // A regression guard with teeth: 0 is falsy, so any `if (cohort)` in this path
  // makes the first cohort the one that can never be selected -- and it is the
  // cohort a user is most likely to click first.
  const h = new CohortHighlight();
  assert.equal(h.apply(hit(0)), 'highlight');
  assert.equal(h.cohort, 0);
  assert.equal(h.isHighlighted, true, 'cohort 0 must count as highlighted');
  assert.equal(h.apply(hit(0)), 'commit');
});

// ---------------------------------------------------------------------------
// Any member of the cohort confirms
// ---------------------------------------------------------------------------

test('the confirming click may be a DIFFERENT particle of the same cohort', () => {
  // THE AFFORDANCE. A cohort is scattered across the screen, and after the first
  // click every one of its members is dimmed-out-of-dimming and therefore a
  // valid confirm target. Testing entity identity instead of cohort membership
  // would mean hunting for the exact pixel you clicked before.
  const h = new CohortHighlight();
  h.apply(hit(4, 100));
  assert.equal(h.apply(hit(4, 20_000)), 'commit');
});

// ---------------------------------------------------------------------------
// classify does not mutate
// ---------------------------------------------------------------------------

test('classify answers without changing anything', () => {
  // The caller branches on the outcome before committing to it, so asking must
  // be free. If classify mutated, merely inspecting a pick would consume the
  // aim -- and the commit that followed would find nothing lit.
  const h = new CohortHighlight();
  h.apply(hit(4));

  assert.equal(h.classify(hit(4)), 'commit');
  assert.equal(h.classify(hit(4)), 'commit', 'asking twice must give one answer');
  assert.equal(h.cohort, 4, 'classify must not disturb the lit cohort');

  assert.equal(h.classify(MISS), 'unhighlight');
  assert.equal(h.cohort, 4, 'classifying a miss must not clear anything');
});

test('classify and apply agree', () => {
  // apply is defined in terms of classify, and this pins that they cannot drift
  // -- a divergence would mean the project changed for a reason the highlight
  // did not record, or vice versa.
  for (const sample of [hit(4), hit(9), MISS]) {
    const a = new CohortHighlight();
    const b = new CohortHighlight();
    a.apply(hit(4));
    b.apply(hit(4));
    assert.equal(a.classify(sample), b.apply(sample));
  }
});

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

test('clear puts the highlight out', () => {
  // For the paths that change the rule from somewhere else -- the rerolls,
  // undo/redo -- and for leaving the Select tool or rebuilding the system.
  const h = new CohortHighlight();
  h.apply(hit(4));
  h.clear();
  assert.equal(h.cohort, NO_COHORT);
  assert.equal(h.isHighlighted, false);
  // ...and the next click aims rather than committing, which is the point: a
  // cleared aim must not still be armed.
  assert.equal(h.apply(hit(4)), 'highlight');
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
