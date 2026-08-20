/**
 * The context hint under the mutation slider: what each tool tells you.
 *
 * WHY THIS TEST EXISTS. The hint is the only place the app says what the two
 * mouse buttons do, and a modal cursor whose modes are undocumented is exactly
 * the thing it was added to fix. A hint that describes the WRONG behaviour is
 * worse than none: it is confidently wrong, it is always on screen, and nothing
 * about it looks broken -- so it cannot be caught by seeing it.
 *
 * The overlay needs a DOM and cannot be built under `node --test`, so `hintFor`
 * is exported and pure and this drives it directly. That split is the same one
 * `selection/cohortHighlight.ts` draws: the decision is testable, the rendering
 * is not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Status } from '../orchestrator/commands.ts';
import { NO_COHORT } from '../selection/cohortHighlight.ts';
import { hintFor } from './mutationOverlay.ts';

/**
 * A Status with only the fields `hintFor` reads.
 *
 * Cast rather than built in full: Status has ~40 fields and this function
 * touches four, so a complete literal would be noise that also has to be
 * maintained. The cast is safe precisely because the function is pure and its
 * reads are visible -- and if it starts reading a fifth field, the tests below
 * exercise it with that field `undefined`, which fails loudly rather than
 * silently.
 */
function status(over: {
  mouseMode: Status['mouseMode'];
  highlightedCohort?: number;
  highlightEnabled?: boolean;
  selectionIsNoOp?: boolean;
}): Status {
  return {
    highlightedCohort: NO_COHORT,
    highlightEnabled: true,
    selectionIsNoOp: false,
    ...over,
  } as Status;
}

// ---------------------------------------------------------------------------
// The two non-select tools
// ---------------------------------------------------------------------------

test('shove says which button pushes and which pulls', () => {
  // Matches `shoveCommands.ts`: leftDragging pushes (positive strength),
  // rightDragging pulls (negated). Reversing these words would send people
  // dragging the wrong button at a structure they are trying to save.
  const hint = hintFor(status({ mouseMode: 'shove' }));
  assert.equal(
    hint.lead,
    'Left click to push particles away | Right click to pull them in',
  );
  assert.equal(hint.cohort, null, 'no stepper outside select');
  assert.equal(hint.tail, '');
});

test('draw says which button adds and which erases', () => {
  // Matches `drawingCommands.ts`: leftDragging draws, rightDragging erases.
  const hint = hintFor(status({ mouseMode: 'draw' }));
  assert.equal(hint.lead, 'Left click to add barriers | Right click to erase them');
  assert.equal(hint.cohort, null);
});

test('draw offers the clear-barriers button, and no other tool does', () => {
  // The button is the BULK FORM of the right-click the draw hint describes, so
  // it belongs beside that sentence and nowhere else. Under Select it would be
  // an unrelated destructive control in a row about cohort selection -- and it
  // is not undoable, which makes "somewhere it does not belong" the worst place
  // for it to be.
  assert.equal(hintFor(status({ mouseMode: 'draw' })).clearField, true);

  for (const mouseMode of ['select', 'shove'] as const) {
    assert.equal(
      hintFor(status({ mouseMode })).clearField,
      false,
      `${mouseMode} has no barriers to clear`,
    );
  }
  // Including the select states that show their own button, since the two share
  // a row and a stuck `display` would put both on it at once.
  assert.equal(
    hintFor(status({ mouseMode: 'select', highlightedCohort: 2 })).clearField,
    false,
  );
});

test('the clear-barriers button never shares the row with the commit button', () => {
  // They occupy the same strip of a row that must not wrap (`HINT_CSS` is
  // `nowrap`), and each is the one action its own tool offers -- so a state
  // offering both would be both crowded and confusing about which tool is live.
  for (const mouseMode of ['select', 'shove', 'draw'] as const) {
    for (const highlightedCohort of [NO_COHORT, 2]) {
      const hint = hintFor(status({ mouseMode, highlightedCohort }));
      assert.ok(
        !(hint.commit && hint.clearField),
        `${mouseMode} with cohort ${String(highlightedCohort)} offers both buttons`,
      );
    }
  }
});

test('neither non-select tool offers a stepper, whatever is lit', () => {
  // A highlight cannot exist outside select -- `setMouseMode` clears it -- but
  // the hint must not depend on that holding: a stepper under the Draw tool
  // would offer to change something the tool cannot act on.
  for (const mouseMode of ['shove', 'draw'] as const) {
    const hint = hintFor(status({ mouseMode, highlightedCohort: 4 }));
    assert.equal(hint.cohort, null, `${mouseMode} must not show the stepper`);
  }
});

// ---------------------------------------------------------------------------
// Select, nothing lit
// ---------------------------------------------------------------------------

test('select with nothing lit promises a cohort selection', () => {
  const hint = hintFor(status({ mouseMode: 'select' }));
  assert.equal(
    hint.lead,
    'Left click a particle to select its cohort | Right click to undo any action',
  );
  assert.equal(hint.cohort, null, 'nothing to step through yet');
  assert.equal(hint.tail, '');
});

// ---------------------------------------------------------------------------
// Select, a cohort lit
// ---------------------------------------------------------------------------

test('a lit cohort names itself and offers the stepper', () => {
  const hint = hintFor(status({ mouseMode: 'select', highlightedCohort: 7 }));
  assert.equal(hint.lead, 'Currently selected: Cohort');
  assert.equal(hint.cohort, 7, 'the stepper shows the lit cohort');
  assert.match(hint.tail, /Right click to cancel selection$/);
});

test('cohort 0 shows the stepper like any other', () => {
  // The falsy-zero guard, at the UI layer this time. `cohort: 0` with a `||`
  // anywhere in the chain would render as no stepper at all, and cohort 0 is
  // the one a user is most likely to select first.
  const hint = hintFor(status({ mouseMode: 'select', highlightedCohort: 0 }));
  assert.equal(hint.cohort, 0);
  assert.notEqual(hint.tail, '', 'the tail must still be shown for cohort 0');
});

test('the right-click wording changes with the state, because the binding does', () => {
  // `applyCanvasInput` routes right-click to cancel-the-aim while a cohort is
  // lit and to undo otherwise. These two strings are the only thing telling the
  // user that, so they have to move together with that branch.
  const lit = hintFor(status({ mouseMode: 'select', highlightedCohort: 2 }));
  const unlit = hintFor(status({ mouseMode: 'select' }));

  assert.match(lit.tail, /Right click to cancel selection/);
  assert.match(unlit.lead, /Right click to undo any action/);
  assert.ok(
    !/undo/i.test(lit.tail),
    'while a cohort is lit, right click cancels rather than undoing',
  );
});

// ---------------------------------------------------------------------------
// Highlighting switched off
// ---------------------------------------------------------------------------

test('with highlighting off, select promises an immediate adoption', () => {
  // Both exemptions -- the oneClickSelection preference and a single-cohort
  // config -- arrive as this one flag, and both make the FIRST click adopt. The
  // default wording would promise a cohort selection that never appears.
  const hint = hintFor(
    status({ mouseMode: 'select', highlightEnabled: false }),
  );
  // Matched loosely: this sentence is still being worded, and pinning it
  // verbatim would mean every rewrite is a test edit. What matters is that it
  // describes an IMMEDIATE adoption rather than promising a cohort selection.
  assert.match(hint.lead, /^Left click a particle to/);
  assert.ok(
    !/select its cohort/.test(hint.lead),
    'with highlighting off, the first click adopts -- it does not select a cohort',
  );
  assert.equal(hint.cohort, null, 'no stepper when there is no highlighting');
});

// ---------------------------------------------------------------------------
// Mutation scale 0: the selection is declined
// ---------------------------------------------------------------------------

test('at scale 0 the hint says what to do instead of promising an adoption', () => {
  // A REFUSED CLICK AND A BROKEN CLICK LOOK IDENTICAL unless the UI says which
  // it is. At mutation scale 0 with an authored rule every cohort obeys the same
  // rule, so the commit is declined -- and the ordinary wording would promise an
  // action that deliberately does not happen.
  const hint = hintFor(
    status({ mouseMode: 'select', highlightedCohort: 3, selectionIsNoOp: true }),
  );
  assert.equal(hint.cohort, 3, 'highlighting still works, so the stepper stays');
  assert.ok(
    !/apply its behavior/.test(hint.tail),
    'the hint must not promise an adoption that is refused',
  );
  assert.match(hint.tail, /Mutation Scale/, 'it should say what would enable it');
  assert.match(hint.tail, /Right click to cancel selection/, 'cancelling still works');
});

test('a lit cohort offers the commit BUTTON instead of the click prose', () => {
  // The button replaces the sentence rather than joining it: two answers to
  // "how do I apply this" is worse than either alone.
  const hint = hintFor(status({ mouseMode: 'select', highlightedCohort: 2 }));
  assert.equal(hint.commit, true, 'a lit cohort should offer the button');
  assert.ok(
    !/apply its behavior/.test(hint.tail),
    'the prose it replaces must be gone from the tail',
  );
  assert.match(hint.tail, /Right click to cancel selection/, 'cancelling survives');
});

test('the button is WITHHELD wherever the commit would be refused', () => {
  // At scale 0 the commit is declined (`selectionIsNoOp`), so a button that did
  // nothing when pressed would be worse than the sentence explaining why -- and
  // with nothing lit there is no cohort to commit at all.
  const noOp = hintFor(
    status({ mouseMode: 'select', highlightedCohort: 3, selectionIsNoOp: true }),
  );
  assert.equal(noOp.commit, false, 'no button while the commit is refused');

  const nothingLit = hintFor(status({ mouseMode: 'select' }));
  assert.equal(nothingLit.commit, false, 'no button with no cohort lit');

  for (const mouseMode of ['shove', 'draw'] as const) {
    assert.equal(
      hintFor(status({ mouseMode, highlightedCohort: 2 })).commit,
      false,
      `${mouseMode} has nothing to commit`,
    );
  }
});

test('at scale 0 with nothing lit, the hint is the ORDINARY one', () => {
  // The no-op only changes the commit clause, and there is no commit clause
  // here: aiming is not blocked, so this sentence was already accurate. Saying
  // more would put a caveat on the state a user spends most of their time in,
  // about a click that still works.
  const noOp = hintFor(status({ mouseMode: 'select', selectionIsNoOp: true }));
  const plain = hintFor(status({ mouseMode: 'select' }));
  assert.equal(noOp.lead, plain.lead);
  assert.match(noOp.lead, /Right click to undo any action/);
});

test('the no-op state does not change the shove or draw wording', () => {
  // Mutation scale has nothing to do with either tool, and a hint about
  // selection appearing under the Draw tool would be noise.
  for (const mouseMode of ['shove', 'draw'] as const) {
    const plain = hintFor(status({ mouseMode }));
    const noOp = hintFor(status({ mouseMode, selectionIsNoOp: true }));
    assert.equal(noOp.lead, plain.lead, `${mouseMode} wording must not change`);
  }
});
