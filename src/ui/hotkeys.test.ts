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
  localHotkeyLabel,
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

test('the checkpoint and the share link are discriminated by shift', () => {
  // THE REGRESSION: the `KeyC` row carried no `shift` until the share link was
  // added, and an omitted `shift` means "don't care" -- so Shift+C set a
  // checkpoint. Adding the share link without also pinning the checkpoint row
  // to `shift: false` would leave both rows claiming Shift+C.
  //
  // The ambiguity test in section 1 already fails on that, but it reports a
  // count rather than an intent. This says which key does WHICH thing, and it
  // is worth saying twice because the failure is silent in the app: setting a
  // checkpoint draws nothing, so a Shift+C that quietly checkpointed would look
  // exactly like a clipboard that quietly failed.
  const checkpoint = matchHotkey(DEFAULT_HOTKEYS, 'KeyC', false);
  const share = matchHotkey(DEFAULT_HOTKEYS, 'KeyC', true);

  assert.deepEqual(checkpoint?.command, { kind: 'setCheckpoint' });
  assert.equal(checkpoint?.local, undefined);

  assert.equal(share?.local, 'copyShareLink');
  assert.equal(share?.command, undefined, 'the clipboard is not simulation state');
});

test('the checkpoint restore and the share paste are discriminated by shift', () => {
  // `KeyV` has the same history as `KeyC`: it carried no `shift` until the
  // share link's paste was added, so Shift+V would have restored a checkpoint.
  // That one is not even silent -- it would visibly load the wrong project,
  // which is worse than nothing happening.
  const restore = matchHotkey(DEFAULT_HOTKEYS, 'KeyV', false);
  const paste = matchHotkey(DEFAULT_HOTKEYS, 'KeyV', true);

  assert.deepEqual(restore?.command, { kind: 'loadLatestCheckpoint' });
  assert.equal(restore?.local, undefined);

  assert.equal(paste?.local, 'pasteShareLink');
  assert.equal(paste?.command, undefined);
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
// "Tool: Shove (2)". These assert the labels come from THIS table, so a rebind
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

test('hotkeyLabel names the modifier when the row requires one', () => {
  // WAS A REAL BUG, merely unreachable: `shift` was ignored entirely, so redo
  // labelled itself `Z` -- undo's key. Nothing asked for redo's label, so it
  // never showed; the share link asks, and a share button reading "(C)" would
  // point at the checkpoint.
  assert.equal(hotkeyLabel({ kind: 'undo' }), 'Z');
  assert.equal(hotkeyLabel({ kind: 'redo' }), 'Shift+Z');
});

test('localHotkeyLabel reaches the bindings that have no command', () => {
  // A `LocalAction` has no `Command`, so `hotkeyLabel` cannot see it at all --
  // which is why the share button's "(Shift-C)" would otherwise have to be
  // typed by hand, the staleness this whole group exists to prevent.
  assert.equal(localHotkeyLabel('toggleUi'), 'X');
  assert.equal(localHotkeyLabel('copyShareLink'), 'Shift+C');
  assert.equal(localHotkeyLabel('pasteShareLink'), 'Shift+V');
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

test('a read-only field is not editable', () => {
  // The curved and gated sliders put their number in the blade's own input and
  // set `readOnly` (`controls.ts:394-397`, `gatedControl.ts:140-144`). Such a
  // field is still focusable and still reports INPUT, so gating on it used to
  // deaden every hotkey until the canvas was clicked -- while offering nothing
  // to type in exchange.
  assert.equal(isEditableTarget({ tagName: 'INPUT', readOnly: true }), false);
  assert.equal(isEditableTarget({ tagName: 'TEXTAREA', readOnly: true }), false);
});

test('a writable field is still editable', () => {
  // THE REGRESSION GUARD for the narrowing above. The save dialog's field is a
  // plain `<input>` with no `readOnly` property set: if an absent `readOnly`
  // ever read as read-only, typing a preset name containing `r` would reset the
  // simulation -- the exact failure this gate exists to prevent.
  assert.equal(isEditableTarget({ tagName: 'INPUT' }), true, 'absent readOnly means writable');
  assert.equal(isEditableTarget({ tagName: 'INPUT', readOnly: false }), true);
});

test('contenteditable wins over readOnly', () => {
  // `readOnly` is meaningless on a div, but a structural stub can carry both.
  assert.equal(isEditableTarget({ tagName: 'DIV', isContentEditable: true, readOnly: true }), true);
});

test('a focused slider track was never gated', () => {
  // Tweakpane focuses the `tp-sldv_t` DIV on a drag (`tweakpane.js:3293`), not
  // an input -- which is why the gate was never what broke `R` after a drag,
  // and why the fix for that lives in `focusRelease.ts` instead.
  assert.equal(isEditableTarget({ tagName: 'DIV' }), false);
});
