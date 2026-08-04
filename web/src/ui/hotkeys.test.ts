/**
 * The hotkey table: no ambiguity, no dead bindings, and the focus gate.
 *
 * WHY THIS TEST EXISTS. A table is data, and data rots differently from code.
 * Two rows can quietly come to claim the same keystroke, at which point which
 * one wins is decided by array order -- a property nobody intended to be
 * semantic. A row can name a command that no longer exists, which the compiler
 * catches, or a key that no longer reaches it, which it does not.
 *
 * The focus gate gets its own group because it is the single thing standing
 * between a user typing a preset name and the `r` resetting their simulation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_HOTKEYS,
  hotkeyLabel,
  isEditableTarget,
  matchHotkey,
  type Hotkey,
} from './hotkeys.ts';
import { MOUSE_MODES } from '../orchestrator/commands.ts';

// --- 1. the table is unambiguous ------------------------------------------

test('no two bindings can match the same keystroke', () => {
  // Every (code, shift) a user could actually produce, checked against the
  // whole table rather than pairwise -- a `shift: undefined` row overlaps an
  // explicit one in a way a naive pairwise comparison misses.
  const codes = new Set(DEFAULT_HOTKEYS.map((h) => h.code));
  for (const code of codes) {
    for (const shift of [false, true]) {
      const matches = DEFAULT_HOTKEYS.filter(
        (h) => h.code === code && (h.shift === undefined || h.shift === shift),
      );
      assert.ok(
        matches.length <= 1,
        `${matches.length} bindings claim ${shift ? 'Shift+' : ''}${code}; ` +
          `array order would decide the winner`,
      );
    }
  }
});

test('every binding does exactly one thing', () => {
  for (const entry of DEFAULT_HOTKEYS) {
    const hasCommand = entry.command !== undefined;
    const hasLocal = entry.local !== undefined;
    assert.ok(
      hasCommand !== hasLocal,
      `${entry.code} must set exactly one of command/local, not both or neither`,
    );
  }
});

// --- 2. the deliberate divergence from the desktop ------------------------
// These assert a DECISION, not a mechanism: the table is Ctrl-free so that the
// browser keeps Ctrl+C/V/R/Z. A later edit that "restores" a desktop binding
// would break the thing the decision bought.

test('the table binds nothing the browser owns', () => {
  // Ctrl-ness is not expressible in a `Hotkey` at all -- there is no modifier
  // field but `shift` -- so this asserts the ABSENCE of the four codes that
  // only ever made sense with Ctrl held.
  const bound = new Set(DEFAULT_HOTKEYS.map((h) => h.code));
  assert.equal(bound.has('Tab'), false, 'Tab belongs to DOM focus traversal');
});

test('undo and redo are discriminated by shift, not by table order', () => {
  const undo = matchHotkey(DEFAULT_HOTKEYS, 'KeyZ', false);
  const redo = matchHotkey(DEFAULT_HOTKEYS, 'KeyZ', true);

  assert.deepEqual(undo?.command, { kind: 'undo' });
  assert.deepEqual(redo?.command, { kind: 'redo' });
});

test('the moved colliders land on their chosen keys', () => {
  // The four the plan deferred. Named individually because each is a decision
  // someone could reasonably try to revert without realising why it was made.
  assert.deepEqual(matchHotkey(DEFAULT_HOTKEYS, 'KeyC', false)?.command, {
    kind: 'setCheckpoint',
  });
  assert.deepEqual(matchHotkey(DEFAULT_HOTKEYS, 'KeyV', false)?.command, {
    kind: 'loadLatestCheckpoint',
  });
  assert.deepEqual(matchHotkey(DEFAULT_HOTKEYS, 'KeyM', false)?.command, {
    kind: 'toggleCameraMode',
  });
});

// --- 3. what did NOT move keeps its desktop key ---------------------------

test('the uncollided desktop bindings are unchanged', () => {
  const expected: readonly (readonly [string, string])[] = [
    ['Space', 'togglePause'],
    ['KeyR', 'reset'],
    ['KeyF', 'randomizeSeed'],
    ['KeyB', 'randomizeBehavior'],
    ['ArrowRight', 'nextPreset'],
    ['ArrowLeft', 'prevPreset'],
    ['Home', 'resetCamera'],
  ];
  for (const [code, kind] of expected) {
    assert.equal(
      matchHotkey(DEFAULT_HOTKEYS, code, false)?.command?.kind,
      kind,
      `${code} should still be ${kind}`,
    );
  }
});

test('the number keys follow MOUSE_MODES order', () => {
  // `commands.ts:67`: "MEMBER ORDER IS THE TOOLBAR ORDER and the 1/2/3 key
  // order". Adding a tool must add its key here and nowhere else.
  MOUSE_MODES.forEach((mode, index) => {
    const hit = matchHotkey(DEFAULT_HOTKEYS, `Digit${index + 1}`, false);
    assert.deepEqual(
      hit?.command,
      { kind: 'setMouseMode', mode },
      `Digit${index + 1} should select ${mode}`,
    );
  });
});

test('X is handled locally rather than dispatched', () => {
  const hit = matchHotkey(DEFAULT_HOTKEYS, 'KeyX', false);
  assert.equal(hit?.local, 'toggleUi');
  assert.equal(hit?.command, undefined, 'hiding the panel is not simulation state');
});

// --- 3b. hotkeyLabel: the shortcut hints in the overlay --------------------
//
// The mutation overlay advertises its shortcuts -- "Reroll Mutations (F)",
// "Shove tool (2)". These assert the labels come from THIS table, so a rebind
// moves them. A hand-written "(F)" would be a second copy of the binding that
// goes stale silently, which is the exact failure the table exists to prevent.

test('hotkeyLabel reads the real binding, stripped for display', () => {
  assert.equal(hotkeyLabel({ kind: 'randomizeSeed' }), 'F');
  assert.equal(hotkeyLabel({ kind: 'randomizeBehavior' }), 'B');
  // Not a Key*/Digit* code: shown verbatim, because "Space" and "Home" already
  // read correctly and "Sp"/"Ho" would not.
  assert.equal(hotkeyLabel({ kind: 'togglePause' }), 'Space');
  assert.equal(hotkeyLabel({ kind: 'resetCamera' }), 'Home');
});

test('hotkeyLabel discriminates same-kind rows by their payload', () => {
  // Three rows share `setMouseMode`; matching on `kind` alone would give every
  // tool the first one's key, and all three would read "(1)".
  MOUSE_MODES.forEach((mode, index) => {
    assert.equal(hotkeyLabel({ kind: 'setMouseMode', mode }), String(index + 1));
  });
});

test('hotkeyLabel returns empty for an unbound command', () => {
  // Appended harmlessly by callers, so an unbound action loses its hint rather
  // than rendering "( )".
  assert.equal(hotkeyLabel({ kind: 'clearStrafeField' }), '');
});

test('hotkeyLabel follows a rebound table rather than the default', () => {
  const rebound: readonly Hotkey[] = [
    { code: 'KeyQ', command: { kind: 'randomizeSeed' } },
  ];
  assert.equal(hotkeyLabel({ kind: 'randomizeSeed' }, rebound), 'Q');
});

// --- 4. matchHotkey itself ------------------------------------------------

test('an unbound key matches nothing', () => {
  assert.equal(matchHotkey(DEFAULT_HOTKEYS, 'KeyJ', false), null);
});

test('a "dont care" row matches either shift state', () => {
  const table: readonly Hotkey[] = [{ code: 'KeyR', command: { kind: 'reset' } }];
  assert.notEqual(matchHotkey(table, 'KeyR', false), null);
  assert.notEqual(matchHotkey(table, 'KeyR', true), null, 'Shift+R should still reset');
});

test('an explicit shift requirement must agree', () => {
  const table: readonly Hotkey[] = [{ code: 'KeyZ', shift: true, command: { kind: 'redo' } }];
  assert.equal(matchHotkey(table, 'KeyZ', false), null);
  assert.notEqual(matchHotkey(table, 'KeyZ', true), null);
});

// --- 5. the focus gate ----------------------------------------------------
// Structural stubs rather than DOM nodes: `node --test` has no document, which
// is why `isEditableTarget` takes a shape rather than an HTMLElement.

test('editable targets are recognised', () => {
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    assert.equal(isEditableTarget({ tagName }), true, `${tagName} should swallow hotkeys`);
  }
  assert.equal(
    isEditableTarget({ tagName: 'DIV', isContentEditable: true }),
    true,
    'contenteditable is a text field in every way that matters here',
  );
});

test('the canvas and ordinary elements are not editable', () => {
  assert.equal(isEditableTarget({ tagName: 'CANVAS' }), false);
  assert.equal(isEditableTarget({ tagName: 'DIV' }), false);
  assert.equal(isEditableTarget({ tagName: 'BUTTON' }), false, 'a button is not a text field');
});

test('a lowercase tagName is still matched', () => {
  // `tagName` is uppercase in HTML documents but not in XML/SVG ones, and a
  // stub is easy to write either way. Case-folding costs nothing.
  assert.equal(isEditableTarget({ tagName: 'input' }), true);
});

test('a missing target is not editable', () => {
  assert.equal(isEditableTarget(null), false);
  assert.equal(isEditableTarget(undefined), false);
  assert.equal(isEditableTarget({}), false, 'a target with no tagName must not throw');
});
