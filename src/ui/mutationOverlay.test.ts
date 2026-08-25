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
import {
  barKeySuffix,
  contextActionFor,
  contextLabelFor,
  hintFor,
  overlayTop,
  toolOptionLabel,
  type Rect,
} from './mutationOverlay.ts';
import { historyLabel } from './menuBar.ts';

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

// ---------------------------------------------------------------------------
// Where the bar sits
// ---------------------------------------------------------------------------
//
// WHY THESE EXIST. The bar is centred and the menu bar is a left-anchored strip,
// so on a wide window they never meet -- and the bar used to clear the menu bar
// unconditionally anyway, spending vertical space on a collision that was not
// happening. The rule that replaced it is a rectangle comparison, which is
// exactly the kind of thing that is right in the case you looked at and wrong at
// the boundary. `overlayTop` is pure so the boundary is testable; `reposition`
// needs a DOM and is not covered here, the same split `hintFor` above draws.
//
// ## NOTHING HERE PINS A DISTANCE, deliberately
//
// `MENU_BAR_GAP_PX` and `TOP_MARGIN_PX` are being tuned by eye, which is the
// right way to settle a margin and the wrong thing to write an assertion about:
// a test that hard-codes "top is 2" fails on every nudge and teaches nothing
// when it does. What these check is WHICH ARM FIRED -- did the bar go to the
// top, or did it drop below the menu bar -- which is the actual rule and is
// invariant under any spacing either constant is given.
//
// `dropped` is the discriminator. The two arms are separated by the menu bar's
// height (~26px), so "at least as low as the menu bar's bottom edge" tells them
// apart for any sane gap without naming one.

/** The menu bar as it actually measures: top-left, ~26px tall. */
const MENU: Rect = { left: 0, right: 300, bottom: 26 };

/** A centred bar of `width`, on a viewport of `viewport`. */
function centred(width: number, viewport: number): Rect {
  const left = (viewport - width) / 2;
  return { left, right: left + width, bottom: 0 };
}

/**
 * Whether `top` is the below-the-menu-bar arm rather than the top arm.
 *
 * SPACING-AGNOSTIC by construction: the top arm cannot reach the menu bar's
 * bottom edge without the top margin growing past the menu bar's whole height,
 * at which point "at the top" would have stopped being true anyway.
 */
const dropped = (top: number, menu: Rect = MENU): boolean => top >= menu.bottom;

test('a wide window puts the bar at the very top', () => {
  // The whole point of the change: 1920px wide, a 900px bar, so it starts at
  // 510 -- well clear of a menu bar that ends at 300.
  const top = overlayTop(centred(900, 1920), MENU);
  assert.ok(!dropped(top), `no collision, so no clearance to pay for (got ${String(top)})`);
});

test('a narrow window drops the bar below the menu bar', () => {
  // 1000px wide with a 900px bar starts at 50, which is under `File`.
  const top = overlayTop(centred(900, 1000), MENU);
  assert.ok(dropped(top), `an overlap has to clear the menu bar (got ${String(top)})`);
});

test('touching edges are not a collision', () => {
  // A bar starting at exactly the menu bar's right edge clears it, so the
  // comparison has to be strict. One pixel either side of this is the whole
  // difference between the two arms, which is what makes it worth a test.
  assert.ok(
    !dropped(overlayTop({ left: 300, right: 900, bottom: 0 }, MENU)),
    'starting exactly at the right edge is clear',
  );
  assert.ok(
    dropped(overlayTop({ left: 299, right: 900, bottom: 0 }, MENU)),
    'one pixel of overlap is an overlap',
  );
});

test('the drop tracks the menu bar rather than assuming its height', () => {
  // The clearance used to be a constant that happened to match a ~26px bar. A
  // menu bar that grows -- a bigger font, another row -- has to push this down
  // with it, or the thing the constant was protecting against comes back.
  //
  // Checks the RELATIONSHIP, not the number: the answer moves with `bottom`, and
  // by exactly as much as `bottom` moved. That holds for any gap.
  const short = { left: 0, right: 300, bottom: 26 };
  const tall = { left: 0, right: 300, bottom: 40 };
  const bar = centred(900, 1000);
  assert.equal(
    overlayTop(bar, tall) - overlayTop(bar, short),
    tall.bottom - short.bottom,
    'a taller menu bar pushes the overlay down by its own growth',
  );
  assert.ok(dropped(overlayTop(bar, tall), tall), 'and still clears it');
});

test('an unmeasurable menu bar falls back to clearing it', () => {
  // Both degradations pick the arm that CANNOT overlap: a bar sitting on top of
  // File and Share is unusable, and a bar lower than it needed to be is merely
  // not as good as it could have been. The wide viewport is the trap -- these
  // inputs would take the TOP arm if the fallback were decided by the overlap
  // test rather than short-circuited ahead of it.
  //
  // Asserts the arm, not the constant, like everything above.
  assert.ok(dropped(overlayTop(centred(900, 1920), null)), 'no menu bar found');
  assert.ok(
    dropped(overlayTop(centred(900, 1920), { left: 0, right: 0, bottom: 0 })),
    'a zero-width rect means it has not been laid out yet',
  );
});

// ---------------------------------------------------------------------------
// The touch context button
//
// WHY THESE EXIST. A finger has no right mouse button, so one control stands in
// for all four things right-click does -- and which one it means is decided
// entirely by `contextActionFor`. Getting that wrong is silent and expensive:
// the button keeps working, it just does the wrong act. Undoing when the user
// meant to cancel an aim throws away a completed edit rather than a selection.
//
// The mapping is deliberately READ OFF `hintFor`'S OWN STATES, so the pair
// cannot disagree about what right-click means where. These tests pin that
// agreement rather than the wording.
// ---------------------------------------------------------------------------

test('a lit cohort makes the context button cancel, not undo', () => {
  // THE EXPENSIVE CONFUSION. Right-click cancels the aim while a cohort is lit
  // (`applyCanvasInput`), and undoing here would step back through a COMPLETED
  // edit instead of dropping the selection the user is still aiming.
  assert.equal(
    contextActionFor(status({ mouseMode: 'select', highlightedCohort: 3 })),
    'cancel',
  );
  // And `hintFor` agrees about that state, which is the invariant that keeps
  // the touch button and the desktop button from meaning different things.
  assert.equal(
    hintFor(status({ mouseMode: 'select', highlightedCohort: 3 })).cancelSelection,
    true,
  );
});

test('select with nothing lit undoes', () => {
  assert.equal(
    contextActionFor(status({ mouseMode: 'select', highlightedCohort: NO_COHORT })),
    'undo',
  );
});

test('highlighting switched off still undoes, because nothing is lit to cancel', () => {
  // `highlightedCohort` arrives ALREADY GATED, so this state reports NO_COHORT
  // even though a cohort number exists behind it. Reading a raw cohort instead
  // would offer Cancel where there is no visible selection to cancel.
  assert.equal(
    contextActionFor(
      status({
        mouseMode: 'select',
        highlightEnabled: false,
        highlightedCohort: NO_COHORT,
      }),
    ),
    'undo',
  );
});

test('shove and draw toggle the drag button instead', () => {
  // These two tools use BOTH mouse buttons for real work, so there is nothing to
  // back out of -- what a finger lacks is the second button itself.
  for (const mode of ['shove', 'draw'] as const) {
    assert.equal(
      contextActionFor(status({ mouseMode: mode })),
      'toggleDragButton',
      `${mode} must offer the latch`,
    );
    // `hintFor` offers NEITHER red button in these tools, which is what leaves
    // the context control free to mean something else here.
    const hint = hintFor(status({ mouseMode: mode }));
    assert.equal(hint.cancelSelection, false, `${mode} has no aim to cancel`);
    assert.equal(hint.undo, null, `${mode} does not undo on right click`);
  }
});

test('a lit cohort in shove/draw does NOT hijack the latch', () => {
  // The tool is checked FIRST, deliberately. A cohort can still be lit from a
  // previous Select session, and if that were tested first the latch would
  // vanish mid-draw and the button would start cancelling a selection the user
  // cannot even see from here.
  assert.equal(
    contextActionFor(status({ mouseMode: 'draw', highlightedCohort: 5 })),
    'toggleDragButton',
    'a stale highlight must not steal the draw/erase toggle',
  );
});

test('the latch label names the state it is IN, not the one it moves to', () => {
  // A toggle labelled with its destination reads as a description of the
  // present to anyone who has not just pressed it, which is the classic way to
  // make a latch ambiguous.
  assert.equal(contextLabelFor('toggleDragButton', false), 'Draw / Push');
  assert.equal(contextLabelFor('toggleDragButton', true), 'Erase / Pull');
});

test('NO label claims the long press, because none of them can spare the width', () => {
  // THE GESTURE CANCELS AND NOTHING ELSE. It used to mirror the whole context
  // button, which meant an accidental long press -- a finger resting while the
  // user decides where to tap -- would UNDO real work with no visible cause. It
  // now cancels only, which costs a re-tap when triggered by accident.
  //
  // That left Cancel as the one label with a second route to name, and it named
  // it until the row had to fit three components on one line: "(Long Press)" is
  // two words that wrap again inside a ~68px button, producing three lines and a
  // control taller than the gold button beside it. The shortcut is documented in
  // Help > Controls instead.
  //
  // The assertion stands either way: what must never happen is a label promising
  // a gesture that does something else. Undo and the latch are unreachable by
  // long press, so a claim there would send people holding the canvas and
  // watching the wrong thing happen -- or nothing at all.
  const claimsLongPress = (label: string): boolean => /long press/i.test(label);
  assert.ok(
    !claimsLongPress(contextLabelFor('undo', false, 'reroll behavior')),
    'the long press no longer undoes, so the undo button must not claim it',
  );
  assert.ok(
    !claimsLongPress(contextLabelFor('toggleDragButton', false)),
    'the latch has no long-press route and must not claim one',
  );
});

test('the undo label names what it would take back, on a second line', () => {
  // The second line is the whole value of this button over a bare "Undo" -- it
  // says what pressing it costs. The newline is load-bearing: the CSS carries
  // `white-space:pre-line` so it renders as two lines inside a 44px button.
  const label = contextLabelFor('undo', false, 'reroll behavior');
  assert.equal(label, 'Undo:\nreroll behavior');
  assert.ok(label.includes('\n'), 'the two lines must be separated by a newline');
});

test('an empty undo stack says so rather than showing a bare "Undo:"', () => {
  // `undoLabel` is empty exactly when there is nothing to take back. Without
  // this the button would read "Undo:" with nothing after the colon, which
  // looks like a label that failed to load rather than an empty history.
  assert.equal(contextLabelFor('undo', false, ''), 'Nothing to undo');
});

// ---------------------------------------------------------------------------
// Key captions on the bottom bar
// ---------------------------------------------------------------------------

test('the touch bar names no keys, because a phone has none to press', () => {
  // The failure this guards is silent and looks fine in code review: a label
  // built with the desktop helper renders "(R)" on a device with no `R`, and
  // spends width on it in the one layout that has none to spare.
  assert.equal(barKeySuffix(['R'], true), '');
  assert.equal(barKeySuffix(['B', 'F'], true), '');
});

test('the desktop bar still names its keys', () => {
  // The other half of the same guard: suppressing on BOTH layouts would be an
  // easy way to make the test above pass while deleting the desktop's shortcuts.
  assert.equal(barKeySuffix(['R'], false), ' (R)');
  assert.equal(barKeySuffix(['B', 'F'], false), ' (B or F)');
});

test('an unbound command drops its key rather than rendering empty parens', () => {
  // `hotkeyLabel` returns '' for an unbound command, which is what feeds these.
  assert.equal(barKeySuffix([''], false), '');
  assert.equal(barKeySuffix(['', 'F'], false), ' (F)');
});

// ---------------------------------------------------------------------------
// The History menu's undo/redo rows
// ---------------------------------------------------------------------------

test('the history rows name what they would move, like the hint bar button', () => {
  // Same colon form the hint bar's tooltip uses (`contextLabelFor` above), so
  // the two places that name a history step do not word it differently.
  assert.equal(historyLabel('Undo', 'edit gain'), 'Undo: edit gain');
  assert.equal(historyLabel('Redo', 'edit gain'), 'Redo: edit gain');
});

test('an empty stack falls back to the bare verb, not to a dangling colon', () => {
  // The row is ALREADY greyed by `live.enabled` when this happens, so unlike the
  // hint bar's lone button it needs no "Nothing to undo" prose -- and a menu
  // whose rows rename themselves into sentences when idle reads as broken.
  assert.equal(historyLabel('Undo', ''), 'Undo');
  assert.equal(historyLabel('Redo', ''), 'Redo');
});

test('the tool options keep their names and drop only the number on touch', () => {
  // The NAME is the part that says what the option does, so suppression must
  // take the key and nothing else -- a bare "Tool:" would be a worse trade than
  // the caption ever was.
  assert.equal(toolOptionLabel('select', true), 'Tool: Select');
  assert.equal(toolOptionLabel('draw', true), 'Tool: Draw');
  assert.ok(toolOptionLabel('select', false).startsWith('Tool: Select'));
});
