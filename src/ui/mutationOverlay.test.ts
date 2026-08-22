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
  canUndo?: boolean;
  undoLabel?: string;
}): Status {
  return {
    highlightedCohort: NO_COHORT,
    highlightEnabled: true,
    selectionIsNoOp: false,
    // THE DEFAULT IS A NON-EMPTY STACK, deliberately, because the interesting
    // failure is the button going missing rather than it saying the wrong thing:
    // an empty default would let every test below pass against a `hintFor` that
    // never read the stack at all.
    canUndo: true,
    undoLabel: 'Reroll behavior',
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
  // The undo half of this sentence is a BUTTON now, so the lead keeps only the
  // clause that has nowhere else to go.
  assert.equal(hint.lead, 'Left click a particle to select its cohort');
  assert.equal(hint.cohort, null, 'nothing to step through yet');
  assert.equal(hint.tail, '');
  assert.equal(hint.undo, 'Reroll behavior', 'and the undo button names the stack top');
});

// ---------------------------------------------------------------------------
// Select, a cohort lit
// ---------------------------------------------------------------------------

test('a lit cohort names itself and offers the stepper', () => {
  const hint = hintFor(status({ mouseMode: 'select', highlightedCohort: 7 }));
  assert.equal(hint.lead, 'Currently selected cohort:');
  assert.equal(hint.cohort, 7, 'the stepper shows the lit cohort');
  assert.equal(hint.cancelSelection, true, 'and the way to back out of it');
});

test('cohort 0 shows the stepper like any other', () => {
  // The falsy-zero guard, at the UI layer this time. `cohort: 0` with a `||`
  // anywhere in the chain would render as no stepper at all, and cohort 0 is
  // the one a user is most likely to select first.
  const hint = hintFor(status({ mouseMode: 'select', highlightedCohort: 0 }));
  assert.equal(hint.cohort, 0);
  assert.equal(hint.cancelSelection, true, 'cohort 0 can be cancelled like any other');
});

test('the right-click wording changes with the state, because the binding does', () => {
  // `applyCanvasInput` routes right-click to cancel-the-aim while a cohort is
  // lit and to undo otherwise. The user is told which one is live, so the two
  // have to move together with that branch.
  //
  // BOTH HALVES ARE BUTTONS NOW -- "Cancel selection (Right click)" while lit,
  // and the undo button while not -- so this asserts the two FLAGS are exact
  // opposites. That is the invariant that keeps one right-click from being
  // claimed by two controls at once.
  const lit = hintFor(status({ mouseMode: 'select', highlightedCohort: 2 }));
  const unlit = hintFor(status({ mouseMode: 'select' }));

  assert.equal(lit.cancelSelection, true);
  assert.equal(lit.undo, null, 'while a cohort is lit, right click cancels rather than undoing');
  assert.equal(unlit.cancelSelection, false, 'nothing to cancel with none lit');
  assert.notEqual(unlit.undo, null, 'with none lit, right click undoes -- and says what');
  assert.ok(
    !/undo/i.test(lit.lead + lit.tail),
    'the lit wording must not claim undo either',
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
  // THE SENTENCE IS A BUTTON NOW. What used to be prose about an immediate
  // adoption is `generateChild`, whose label lives in the overlay -- so what is
  // asserted here is that this state offers that button and does NOT fall back
  // to promising a cohort selection that will never appear.
  assert.equal(hint.generateChild, true, 'the one-click state offers the button');
  assert.equal(hint.lead, '', 'the button carries the words; nothing is left to say');
  assert.equal(hint.commit, false, 'the commit button belongs to the lit state, not this one');
  assert.equal(hint.cohort, null, 'no stepper when there is no highlighting');
});

test('the generate-a-child button is the one-click state alone', () => {
  // It sends the same `confirmSelection` the commit button does, so a state
  // offering BOTH would put two gold buttons for one command on a row that must
  // not wrap. They are mutually exclusive by construction -- one needs
  // highlighting off, the other needs a cohort lit -- but that falls out of two
  // separate branches, which is worth pinning rather than assuming.
  for (const mouseMode of ['select', 'shove', 'draw'] as const) {
    for (const highlightEnabled of [true, false]) {
      for (const highlightedCohort of [NO_COHORT, 2]) {
        for (const selectionIsNoOp of [false, true]) {
          const hint = hintFor(
            status({ mouseMode, highlightEnabled, highlightedCohort, selectionIsNoOp }),
          );
          const where = `${mouseMode}/${String(highlightEnabled)}/${String(highlightedCohort)}/${String(selectionIsNoOp)}`;
          assert.ok(!(hint.generateChild && hint.commit), where);
          if (mouseMode !== 'select') {
            assert.equal(hint.generateChild, false, `${mouseMode} adopts nothing`);
          }
          // NEITHER GOLD BUTTON SURVIVES A REFUSED COMMIT. Both send
          // `confirmSelection`, and the Orchestrator declines it at mutation
          // scale 0 with an authored rule -- so a button offered here would be
          // one that does nothing when pressed, in either state.
          if (selectionIsNoOp) {
            assert.ok(!hint.generateChild && !hint.commit, `refused, so no button: ${where}`);
          }
        }
      }
    }
  }
});

test('the undo button says so rather than vanishing when the stack is empty', () => {
  // EMPTY STRING, NOT `null`: `null` hides the button, and a control that
  // disappears as the stack empties makes the row twitch and teaches nothing
  // about why. The overlay words the empty case -- what matters here is that the
  // state stays distinguishable from "no button at all".
  const empty = hintFor(status({ mouseMode: 'select', canUndo: false, undoLabel: '' }));
  assert.equal(empty.undo, '', 'offered, with nothing to name');

  // A stack whose top has no label -- entry 0 carries `label: ''` (see
  // `history.ts`) -- reads the same way, which is correct: there is nothing to
  // name in either case.
  const unlabelled = hintFor(status({ mouseMode: 'select', canUndo: true, undoLabel: '' }));
  assert.equal(unlabelled.undo, '');
});

test('the undo button is withheld wherever right click means something else', () => {
  // Draw erases, Shove pulls, and a lit Select cancels the aim. In all three the
  // button would name a gesture that does something else -- worse than silence,
  // because it is always on screen and looks correct.
  for (const mouseMode of ['shove', 'draw'] as const) {
    assert.equal(hintFor(status({ mouseMode })).undo, null, mouseMode);
  }
  for (const selectionIsNoOp of [false, true]) {
    assert.equal(
      hintFor(status({ mouseMode: 'select', highlightedCohort: 2, selectionIsNoOp })).undo,
      null,
      `lit, no-op ${String(selectionIsNoOp)}`,
    );
  }

  // Every unlit Select state DOES offer it -- both highlight modes, and at
  // either mutation scale. Right click genuinely undoes in all of them, and the
  // button must not come and go with a slider that has nothing to do with it.
  for (const highlightEnabled of [true, false]) {
    for (const selectionIsNoOp of [false, true]) {
      assert.notEqual(
        hintFor(status({ mouseMode: 'select', highlightEnabled, selectionIsNoOp })).undo,
        null,
        `unlit ${String(highlightEnabled)}/${String(selectionIsNoOp)}`,
      );
    }
  }
});

test('the undo button never shares the row with the other two reds', () => {
  // All three wear `CLEAR_FIELD_BUTTON_CSS`, and the row must not wrap
  // (`HINT_CSS` is `nowrap`). Two of them side by side would also mean two red
  // controls both naming the right mouse button.
  for (const mouseMode of ['select', 'shove', 'draw'] as const) {
    for (const highlightEnabled of [true, false]) {
      for (const highlightedCohort of [NO_COHORT, 2]) {
        const hint = hintFor(
          status({ mouseMode, highlightEnabled, highlightedCohort }),
        );
        const reds = [hint.undo !== null, hint.cancelSelection, hint.clearField];
        assert.ok(
          reds.filter(Boolean).length <= 1,
          `${mouseMode}/${String(highlightEnabled)}/${String(highlightedCohort)}`,
        );
      }
    }
  }
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
  // AND WHAT WOULD HAPPEN IF THEY DID NOT RAISE IT. "Increase Mutation Scale"
  // alone names the remedy without naming the symptom, which leaves the user to
  // work out why a commit they can still see offered would be pointless.
  assert.match(hint.tail, /These children are all identical to their parent/);
  // CANCELLING IS STILL OFFERED, and this is the state that most needs it: the
  // commit is refused here, so backing out is the one action fully available.
  assert.equal(hint.cancelSelection, true, 'cancelling still works');
});

test('the one-click state withdraws its button at scale 0 and says why', () => {
  // The same refusal the lit branch above makes, in the state that has no
  // stepper: `confirmSelection` installs a rule identical to the one already
  // there, so a button that declines when pressed would be worse than prose.
  const hint = hintFor(
    status({ mouseMode: 'select', highlightEnabled: false, selectionIsNoOp: true }),
  );
  assert.equal(hint.generateChild, false, 'the button is refused, so it is withdrawn');
  assert.equal(
    hint.lead,
    'Increase Mutation Scale for variations. This child is identical to its parent',
  );
  // SINGULAR, against the lit branch's plural: one cohort makes one child, and
  // the plural would describe a spread this config cannot produce.
  assert.ok(!/These children/.test(hint.lead), 'one cohort, one child');
  // THE UNDO BUTTON SURVIVES. Only the gold button is refused -- right click
  // still undoes here, and dropping it because a different action became
  // unavailable would make it flicker as the slider crosses zero.
  assert.notEqual(hint.undo, null, 'undo is unaffected by mutation scale');
});

test('the sentinel keeps its button at scale 0, because the GPU generates', () => {
  // `selectionIsNoOp` is FALSE for a generated rule whatever the mutation scale:
  // the shader takes its generate branch, each cohort gets a genuinely different
  // rule from the seed, and adopting one is the only way to capture it. The
  // overlay must not re-derive that exemption -- it reads the one flag, so this
  // pins that a false flag leaves the button in place.
  const hint = hintFor(
    status({ mouseMode: 'select', highlightEnabled: false, selectionIsNoOp: false }),
  );
  assert.equal(hint.generateChild, true, 'a generated rule still has a child to give');
  assert.equal(hint.lead, '', 'the button carries the words');
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
  assert.equal(hint.cancelSelection, true, 'cancelling survives');
  // BOTH CLAUSES ARE BUTTONS in this state, so the tail has nothing left to
  // say. Asserted rather than left implicit: a stray separator or a leftover
  // fragment would show as a bare "|" floating after the stepper.
  assert.equal(hint.tail, '', 'nothing is left for the tail once both are buttons');
});

test('cancelling is offered exactly while a cohort is lit', () => {
  // IT TRACKS THE HIGHLIGHT, NOT THE COMMIT -- which is the one way this flag
  // differs from `commit`, and the difference worth pinning. There is an aim to
  // throw away in both lit states, including the no-op one where committing is
  // refused; there is none in any unlit state, and a button offering to cancel
  // nothing would be a control that does nothing when pressed.
  for (const highlightedCohort of [0, 5]) {
    for (const selectionIsNoOp of [false, true]) {
      const hint = hintFor(
        status({ mouseMode: 'select', highlightedCohort, selectionIsNoOp }),
      );
      assert.equal(
        hint.cancelSelection,
        true,
        `cohort ${String(highlightedCohort)}, no-op ${String(selectionIsNoOp)}`,
      );
    }
  }

  // Nothing lit, highlighting switched off, and the two other tools: no aim
  // exists in any of them.
  assert.equal(hintFor(status({ mouseMode: 'select' })).cancelSelection, false);
  assert.equal(
    hintFor(status({ mouseMode: 'select', highlightEnabled: false })).cancelSelection,
    false,
  );
  for (const mouseMode of ['shove', 'draw'] as const) {
    assert.equal(hintFor(status({ mouseMode })).cancelSelection, false, mouseMode);
  }
});

test('the cancel button never shares the row with clear-barriers', () => {
  // They are the two red buttons and would sit side by side on a row that must
  // not wrap (`HINT_CSS` is `nowrap`). They cannot co-occur -- one is Select,
  // the other Draw -- but that is a consequence of two separate branches, so it
  // is worth asserting rather than assuming.
  for (const mouseMode of ['select', 'shove', 'draw'] as const) {
    for (const highlightedCohort of [NO_COHORT, 2]) {
      const hint = hintFor(status({ mouseMode, highlightedCohort }));
      assert.ok(
        !(hint.cancelSelection && hint.clearField),
        `${mouseMode} with cohort ${String(highlightedCohort)} offers both red buttons`,
      );
    }
  }
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
  // The undo half is a button now, and it is offered here for the same reason:
  // right-click still undoes in this state, so nothing about it changed.
  assert.equal(noOp.undo, plain.undo);
  assert.notEqual(noOp.undo, null);
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
