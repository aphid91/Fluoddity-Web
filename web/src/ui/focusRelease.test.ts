/**
 * The focus-release decision.
 *
 * WHY THIS TEST EXISTS. The rule this file pins is asymmetric in a way that is
 * easy to "simplify" into a bug: a pointerup releases focus from a slider track
 * but MUST NOT release it from a writable text field. Both are elements inside
 * the panel that just received a pointerup, and the difference between them is
 * invisible unless someone wrote it down. Collapse the two cases into one and
 * every number field in the panel silently becomes impossible to type into --
 * a regression no other test in the suite would notice, because nothing else
 * asserts that focus STAYED somewhere.
 *
 * Structural stubs rather than DOM nodes, as in `hotkeys.test.ts`: `node --test`
 * has no document, which is why the decision takes a shape.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldReleaseFocus } from './focusRelease.ts';

// --- 1. the workflow this whole change exists for -------------------------

test('a pointerup releases the slider track', () => {
  // `tp-sldv_t` is a plain focusable div (`tweakpane.js:3563`). Releasing it is
  // what makes "drag a slider, then press R" work.
  assert.equal(shouldReleaseFocus({ tagName: 'DIV' }, 'pointerup'), true);
});

test('a pointerup MUST NOT release a writable text field', () => {
  // THE ASSERTION THIS FILE IS FOR. Clicking into a number field is a
  // pointerdown then a pointerup; releasing on that would blur the field
  // between the click and the first keystroke.
  assert.equal(
    shouldReleaseFocus({ tagName: 'INPUT', readOnly: false }, 'pointerup'),
    false,
    'blurring here makes every number field untypable',
  );
  assert.equal(
    shouldReleaseFocus({ tagName: 'INPUT' }, 'pointerup'),
    false,
    'an absent readOnly must read as writable, never as a readout',
  );
  assert.equal(shouldReleaseFocus({ tagName: 'TEXTAREA' }, 'pointerup'), false);
});

test('a pointerup releases a read-only readout', () => {
  // The curved and gated sliders' number boxes (`controls.ts:394-397`,
  // `gatedControl.ts:140-144`): nothing to type, so focus is pure loss.
  assert.equal(shouldReleaseFocus({ tagName: 'INPUT', readOnly: true }, 'pointerup'), true);
});

test('a pointerup leaves a select alone', () => {
  // The pointerup is part of opening the dropdown; blurring closes it. The
  // tool selector handles the same problem on `change` (`mutationOverlay.ts:178`).
  assert.equal(shouldReleaseFocus({ tagName: 'SELECT' }, 'pointerup'), false);
});

test('a pointerup leaves a contenteditable alone', () => {
  assert.equal(
    shouldReleaseFocus({ tagName: 'DIV', isContentEditable: true }, 'pointerup'),
    false,
    'a contenteditable is a text field the user just clicked into',
  );
});

// --- 2. enter and escape are unconditional --------------------------------

test('enter and escape release anything focused', () => {
  // Both are explicit "I am done" gestures. What they mean for the VALUE is
  // settled by the field's own listeners first (`controls.ts:464-484`).
  for (const reason of ['enter', 'escape'] as const) {
    assert.equal(shouldReleaseFocus({ tagName: 'INPUT' }, reason), true);
    assert.equal(shouldReleaseFocus({ tagName: 'INPUT', readOnly: true }, reason), true);
    assert.equal(shouldReleaseFocus({ tagName: 'DIV' }, reason), true);
    assert.equal(shouldReleaseFocus({ tagName: 'SELECT' }, reason), true);
    assert.equal(
      shouldReleaseFocus({ tagName: 'DIV', isContentEditable: true }, reason),
      true,
    );
  }
});

// --- 3. nothing focused ---------------------------------------------------

test('a missing element releases nothing', () => {
  for (const reason of ['pointerup', 'enter', 'escape'] as const) {
    assert.equal(shouldReleaseFocus(null, reason), false);
    assert.equal(shouldReleaseFocus(undefined, reason), false);
  }
});

test('the body is not worth blurring', () => {
  // `document.activeElement` falls back to `<body>` when focus is already where
  // we want it. Blurring that is a no-op under a misleading name.
  for (const reason of ['pointerup', 'enter', 'escape'] as const) {
    assert.equal(shouldReleaseFocus({ tagName: 'BODY' }, reason), false);
    assert.equal(shouldReleaseFocus({ tagName: 'HTML' }, reason), false);
  }
});

test('a lowercase tagName is still matched', () => {
  // As in `hotkeys.test.ts`: `tagName` is uppercase in HTML documents but not
  // in XML/SVG ones, and the readout case must not turn on document type.
  assert.equal(shouldReleaseFocus({ tagName: 'input', readOnly: false }, 'pointerup'), false);
  assert.equal(shouldReleaseFocus({ tagName: 'select' }, 'pointerup'), false);
});
