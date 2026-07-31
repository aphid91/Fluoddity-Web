/**
 * The hotkey table.
 *
 * The port of `ui.py:422-491` (`_dispatch_hotkeys`) -- but a TABLE rather than
 * that function's straight-line `if` chain, because the port plan asks Step 8
 * for "a focus-aware rebindable table" and only data can be rebound. Dispatch
 * reads the table; nothing about dispatch knows which key does what.
 *
 * =============================================================================
 * THIS TABLE IS DELIBERATELY CTRL-FREE, AND DIVERGES FROM THE DESKTOP
 * =============================================================================
 *
 * The plan (Step 8, "Hotkey collisions -- deferred by decision") lists four
 * desktop bindings that collide with things the browser already owns, and
 * defers the choice to whoever builds the table. **The choice made was to move
 * every collider to a bare key** rather than to intercept a browser
 * combination:
 *
 *   | Key       | Command               | Desktop was |
 *   |-----------|-----------------------|-------------|
 *   | `C`       | setCheckpoint         | Ctrl+C      |
 *   | `V`       | loadLatestCheckpoint  | Ctrl+V      |
 *   | `M`       | toggleCameraMode      | Tab         |
 *   | `Z`       | undo                  | Ctrl+Z      |
 *   | `Shift+Z` | redo                  | Ctrl+Shift+Z / Ctrl+Y |
 *
 * The consequence, and the reason it is worth the divergence: **no app hotkey
 * ever calls `preventDefault` on a Ctrl combination**, so the browser keeps
 * Ctrl+C, Ctrl+V, Ctrl+R and Ctrl+Z entirely and unconditionally. The failure
 * the plan warns about -- "`preventDefault` then breaks copying text out of
 * Tweakpane fields" -- cannot occur, because there is nothing to prevent.
 *
 * Two bindings are intentionally ABSENT rather than moved:
 *
 *   - **Ctrl+R (revert to saved)** is not bound at all. It needs Step 9's
 *     storage to have anything to revert TO, and the browser reloads the page.
 *   - **Tab** is left to DOM focus traversal. The plan calls this collision
 *     "worse than with imgui, since Tweakpane is real focusable DOM" -- and
 *     that cuts the other way too: keyboard traversal of a real panel is worth
 *     more than a second binding for a command that now has `M`.
 *
 * Everything that did NOT collide keeps its desktop key exactly: `1`/`2`/`3`
 * tool, `X` hide UI, `Space` pause, `R` reset, `B` behaviour, `F` seed,
 * arrows for presets, `Home` reset camera.
 *
 * ## What is not here: WASD and Q/E
 *
 * Continuous motion is not a hotkey. It reads `keysHeld` against `dt` in
 * `orchestrator.applyCameraKeys`, and routing it through this table would make
 * it one step per key-REPEAT, whose rate is an OS setting (`ui.py:477-479`).
 */

import { MOUSE_MODES, type Command } from '../orchestrator/commands.ts';

/**
 * Something the UI does to itself, with no simulation state behind it.
 *
 * `X` is the desktop's one locally-handled key and the reason this exists:
 * hiding the panel changes nothing the Orchestrator owns, so there is nothing
 * to broker and inventing a `Command` for it would put UI chrome in the
 * simulation's vocabulary. `ui.py:471-473` says the same -- "rule 10 cuts both
 * ways".
 */
export type LocalAction = 'toggleUi';

/** One binding. Exactly one of `command`/`local` is set. */
export interface Hotkey {
  /** `KeyboardEvent.code`, so the binding follows the physical key. */
  readonly code: string;
  /**
   * Shift requirement. `undefined` means "don't care", which is how every bare
   * desktop key behaves; `true`/`false` discriminate a pair.
   *
   * `Z`/`Shift+Z` is the only pair, and both entries state it explicitly --
   * leaving `undefined` on the `Z` row would make it match Shift+Z as well, and
   * which of undo/redo won would come down to table order. Order is not
   * semantics here and should not become so.
   */
  readonly shift?: boolean;
  /** Dispatched through the command bus. */
  readonly command?: Command;
  /** Handled by the UI itself. */
  readonly local?: LocalAction;
}

/**
 * The default bindings.
 *
 * Exported as data so a later step can persist an override without touching
 * dispatch -- that is what "rebindable" buys, and it is the whole reason this
 * is a table.
 */
export const DEFAULT_HOTKEYS: readonly Hotkey[] = [
  // --- transport, unchanged from the desktop -------------------------------
  { code: 'Space', command: { kind: 'togglePause' } },
  { code: 'KeyR', command: { kind: 'reset' } },
  { code: 'KeyF', command: { kind: 'randomizeSeed' } },
  { code: 'KeyB', command: { kind: 'randomizeBehavior' } },

  // --- history. MOVED off Ctrl; see the file header ------------------------
  // Both rows name `shift` explicitly so neither can match the other.
  { code: 'KeyZ', shift: false, command: { kind: 'undo' } },
  { code: 'KeyZ', shift: true, command: { kind: 'redo' } },

  // --- the config clipboard. MOVED off Ctrl+C/Ctrl+V -----------------------
  // These are the app's OWN checkpoint stack, never the OS clipboard -- the
  // desktop comment at `ui.py:436-439` is emphatic that Ctrl+C/V were chosen
  // as "the familiar keys for the familiar idea", which is precisely the reason
  // they cannot keep them here: on the web there IS another clipboard.
  { code: 'KeyC', command: { kind: 'setCheckpoint' } },
  { code: 'KeyV', command: { kind: 'loadLatestCheckpoint' } },

  // --- presets, unchanged --------------------------------------------------
  { code: 'ArrowRight', command: { kind: 'nextPreset' } },
  { code: 'ArrowLeft', command: { kind: 'prevPreset' } },

  // --- camera. `M` for mode; Tab stays with the DOM ------------------------
  { code: 'KeyM', command: { kind: 'toggleCameraMode' } },
  { code: 'Home', command: { kind: 'resetCamera' } },

  // --- tools ---------------------------------------------------------------
  // Zipped against MOUSE_MODES, whose "MEMBER ORDER IS THE TOOLBAR ORDER and
  // the 1/2/3 key order" (`commands.ts:67`). Built rather than written out so
  // adding a tool needs one array member and nothing here -- the desktop zips
  // for the same reason (`ui.py:466-469`).
  ...MOUSE_MODES.map(
    (mode, index): Hotkey => ({
      code: `Digit${index + 1}`,
      command: { kind: 'setMouseMode', mode },
    }),
  ),

  // --- the UI's own ---------------------------------------------------------
  { code: 'KeyX', local: 'toggleUi' },
];

/**
 * Find the binding for a keystroke, or `null`.
 *
 * Pure, so the table can be unit-tested without a DOM. A `shift` of `undefined`
 * on a row matches either state; an explicit one must agree.
 */
export function matchHotkey(
  table: readonly Hotkey[],
  code: string,
  shift: boolean,
): Hotkey | null {
  for (const entry of table) {
    if (entry.code !== code) continue;
    if (entry.shift !== undefined && entry.shift !== shift) continue;
    return entry;
  }
  return null;
}

/**
 * Whether a keystroke aimed at this element should be left to the browser.
 *
 * THE FOCUS GATE the plan requires: "The table must gate every app hotkey on
 * 'no editable element focused.'" Without it, typing `Starcrossed` into a save
 * dialog would reset the simulation on the `r`, checkpoint on the `c` and swap
 * the camera on the `M`.
 *
 * Tested against the EVENT TARGET rather than `document.activeElement`. The two
 * disagree during focus transitions, and the target is what actually received
 * the keystroke -- which is the question being asked.
 *
 * Typed structurally rather than as `HTMLElement` so `node --test` can call it
 * with a plain object; there is no DOM in the test environment.
 */
export function isEditableTarget(
  target: { tagName?: string; isContentEditable?: boolean } | null | undefined,
): boolean {
  if (target === null || target === undefined) return false;
  if (target.isContentEditable === true) return true;
  const tag = (target.tagName ?? '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
