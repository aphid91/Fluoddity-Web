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
 * One binding is WEB-ONLY: `H` / `?` opens the guide. The desktop has no
 * equivalent because it has no Help menu to mirror.
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
export type LocalAction =
  | 'toggleUi'
  | 'copyShareLink'
  | 'pasteShareLink'
  | 'showGuide';

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
  // **ONE KEY, ONE COMMAND.** `F` reaches `randomizeSeed` and nothing else.
  // The Orchestrator used to redirect it to `randomizeBehavior` whenever the
  // rule was the all-zero sentinel, which made `F` a second key for `B` in a
  // state the user could not see -- while the Reroll button and menu row that
  // `F` belongs to were greyed. That redirect is gone: `F` is now inert
  // wherever Reroll is greyed (`rerollIsNoOp`), and `B` is the only key that
  // randomizes behavior. See the `randomizeSeed` case in `orchestrator.ts`.
  { code: 'KeyF', command: { kind: 'randomizeSeed' } },
  { code: 'KeyB', command: { kind: 'randomizeBehavior' } },

  // --- history. MOVED off Ctrl; see the file header ------------------------
  // Both rows name `shift` explicitly so neither can match the other.
  //
  // **THE MOUSE MIRRORS THIS PAIR AND IS NOT IN THIS TABLE.** Right-click undoes
  // and Shift+Right-click redoes, decided in `applyCanvasInput` -- the canvas
  // reads the buttons directly and is not rebindable, so those gestures cannot
  // be expressed here. The shift convention is deliberately the same, which is
  // why this note lives beside the rows it copies rather than only there.
  { code: 'KeyZ', shift: false, command: { kind: 'undo' } },
  { code: 'KeyZ', shift: true, command: { kind: 'redo' } },

  // --- the config clipboard. MOVED off Ctrl+C/Ctrl+V -----------------------
  // These are the app's OWN checkpoint stack, never the OS clipboard -- the
  // desktop comment at `ui.py:436-439` is emphatic that Ctrl+C/V were chosen
  // as "the familiar keys for the familiar idea", which is precisely the reason
  // they cannot keep them here: on the web there IS another clipboard.
  //
  // `shift: false` IS LOAD-BEARING, exactly as it is on the `Z` pair above. An
  // omitted `shift` means "don't care" (`matchHotkey`), so without it this row
  // would claim Shift+C as well and the share link below would never fire.
  //
  // That failure used to be INVISIBLE, because setting a checkpoint showed
  // nothing on screen -- it would have looked like the clipboard silently
  // failed. It now raises a "Checkpoint set: <name>" toast, so the wrong one
  // firing would at least be legible; the guard stays because a toast naming a
  // checkpoint is still the wrong answer to a request for a share link.
  { code: 'KeyC', shift: false, command: { kind: 'setCheckpoint' } },
  // `shift: false` here for the same reason as `KeyC` above: Shift+V is the
  // share link's paste, and an omitted `shift` would claim both.
  { code: 'KeyV', shift: false, command: { kind: 'loadLatestCheckpoint' } },

  // --- the cohort stepper --------------------------------------------------
  //
  // **THE ARROWS NO LONGER CYCLE PRESETS.** They did, and it was the wrong home
  // for them: LEFT/RIGHT next to a lit cohort reads as "move along the cohorts",
  // and loading an entirely different preset is a far larger act than an arrow
  // key should perform -- it replaces every particle's behaviour, and doing that
  // by a stray keypress is how someone loses the state they were watching.
  // Presets remain on the Simulation menu, which is where a deliberate act
  // belongs.
  //
  // **NO CONDITION IS EXPRESSED HERE, and none is needed.** These fire always;
  // `setHighlightedCohort` is documented to REFUSE when no cohort is lit (and
  // when highlighting is off at all), so the keys are inert in exactly the state
  // the specification calls for. Encoding "only when highlighted" in this table
  // would be a second copy of that rule, and the two would drift.
  //
  // The `cohort` values are deltas ONLY because the Orchestrator wraps them:
  // `wrapCohort` resolves them against the live count, so -1 from cohort 0 lands
  // on the last cohort rather than off the end. Same command the `‹`/`›` buttons
  // on the hint bar send, so the two routes cannot disagree.
  { code: 'ArrowRight', command: { kind: 'stepHighlightedCohort', delta: 1 } },
  { code: 'ArrowLeft', command: { kind: 'stepHighlightedCohort', delta: -1 } },
  // Enter COMMITS what the arrows aimed. Together the three make selection
  // reachable without the mouse at all: an arrow lights cohort 0, the arrows
  // walk to the one you want, Enter adopts it.
  //
  // Refused by the Orchestrator outside Select mode and with nothing lit, for
  // the same reason the arrows are -- the condition lives with the state it
  // reads rather than being restated here.
  //
  // **`Enter`, NOT `NumpadEnter` as well.** `matchHotkey` compares `code`, and
  // the numpad key reports its own; adding it is one more row here whenever
  // someone asks. Left out for now rather than guessed at, since a keypad Enter
  // landing on a text field is the more likely thing a user is doing with it.
  { code: 'Enter', command: { kind: 'confirmSelection' } },

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
  // `local`, not a `Command`, for the reason `toggleUi` is: the clipboard is
  // the browser's and the Orchestrator has no DOM in it at all. It hands over a
  // document when asked (`CommandBus.projectDocument`) and never learns that a
  // clipboard exists. Rule 10 cuts both ways.
  //
  // Shift+C rather than a bare key because plain C is the checkpoint, and the
  // two are close enough in spirit -- "keep this" -- that pairing them under
  // one physical key is a mnemonic rather than a collision.
  //
  // Shift+C / Shift+V then inherit the SHAPE of the pair below them: C and V
  // are copy and restore for the in-session checkpoint stack, and shifted they
  // are copy and restore for the clipboard. The same gesture, one step further
  // out -- which is a mnemonic worth more than either key on its own.
  { code: 'KeyC', shift: true, local: 'copyShareLink' },
  { code: 'KeyV', shift: true, local: 'pasteShareLink' },

  // The guide, on the two keys everyone tries. `local` for the same reason as
  // the rest of this block: the overlay is the panel's, and the Orchestrator
  // has no DOM in it.
  //
  // **TWO ROWS, and `KeyH` is listed FIRST on purpose.** `keyLabel` reads the
  // first match, so `H` is what any generated hint will say -- `Slash` would
  // render as the literal word. The copy in `splash.ts` names both.
  //
  // `Slash` with `shift: undefined`, so it matches `/` as well as `?`. The two
  // are one physical key on a US layout and `code` cannot tell them apart
  // anyway; demanding Shift would leave `/` doing nothing, and `/` is not bound
  // to anything else to collide with.
  { code: 'KeyH', local: 'showGuide' },
  { code: 'Slash', local: 'showGuide' },
];

/**
 * The key that triggers `command`, as a short display string, or `''`.
 *
 * **So a label can say "(F)" without anyone typing "F" twice.** The overlay's
 * Reroll button and its tool dropdown both advertise their shortcuts, and a
 * hand-written hint is a second copy of the binding that goes stale silently the
 * first time the table is edited -- exactly the failure the table exists to
 * prevent. This reads the table, so a rebind moves the label with it.
 *
 * Matched on the command's `kind` plus whatever discriminates its variants,
 * because two rows can share a kind (`setMouseMode` has one per tool). Returns
 * `''` for an unbound command, which callers append harmlessly.
 *
 * `KeyboardEvent.code` is a physical-key name (`KeyF`, `Digit1`), so the prefix
 * comes off for display. Anything that is neither is shown verbatim: `Space`,
 * `Home` and the arrows already read correctly.
 */
export function hotkeyLabel(
  command: Command,
  table: readonly Hotkey[] = DEFAULT_HOTKEYS,
): string {
  const row = table.find((entry) => entry.command !== undefined && sameCommand(entry.command, command));
  if (row === undefined) return '';
  return keyLabel(row);
}

/**
 * The same, for an action the UI handles itself.
 *
 * A `LocalAction` has no `Command`, so `hotkeyLabel` cannot reach it -- which
 * left `X` and the share link as the only bindings whose labels had to be typed
 * by hand, the exact staleness the function above exists to prevent. Splitting
 * on the two kinds of binding is cheaper than making `hotkeyLabel` take a union
 * and narrow it at every call site.
 */
export function localHotkeyLabel(
  action: LocalAction,
  table: readonly Hotkey[] = DEFAULT_HOTKEYS,
): string {
  const row = table.find((entry) => entry.local === action);
  if (row === undefined) return '';
  return keyLabel(row);
}

/**
 * One row as a display string.
 *
 * `KeyboardEvent.code` is a physical-key name (`KeyF`, `Digit1`), so the prefix
 * comes off. Anything else is shown verbatim: `Space`, `Home` and the arrows
 * already read correctly.
 *
 * THE SHIFT PREFIX IS NOT COSMETIC. Without it this returned `Z` for both undo
 * and redo, and would now return `C` for both the checkpoint and the share link
 * -- a label that names a DIFFERENT binding than the one it sits on, which is
 * worse than no label at all. Nothing asked for redo's label before, so the bug
 * was real but unreachable; the share link reaches it.
 */
function keyLabel(row: Hotkey): string {
  const key = row.code.replace(/^(Key|Digit)/, '');
  return row.shift === true ? `Shift+${key}` : key;
}

/**
 * Whether two commands name the same action, for label lookup only.
 *
 * NOT a general command equality: it compares `kind` and the one extra field
 * that distinguishes same-kind rows in the table. A structural deep-compare
 * would be wrong here anyway, since `editSetting` carries a whole `Setting`.
 */
function sameCommand(a: Command, b: Command): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'setMouseMode' && b.kind === 'setMouseMode') return a.mode === b.mode;
  return true;
}

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
 * **A READ-ONLY field is not editable, and gating on one is pure loss.** The
 * curved and gated sliders write their number into the blade's own input and
 * set `readOnly` on it (`controls.ts:394-397`, `gatedControl.ts:140-144`) -- it
 * is a readout, and the handle is the control. But a read-only input is still
 * focusable and still reports `tagName === 'INPUT'`, so clicking that number
 * used to deaden EVERY hotkey until the canvas was clicked, while offering
 * nothing to type in exchange. A field that cannot receive text protects no
 * keystroke, so there is nothing for the gate to defend.
 *
 * Typed structurally rather than as `HTMLElement` so `node --test` can call it
 * with a plain object; there is no DOM in the test environment.
 */
export function isEditableTarget(
  target:
    | { tagName?: string; isContentEditable?: boolean; readOnly?: boolean }
    | null
    | undefined,
): boolean {
  if (target === null || target === undefined) return false;
  // `contentEditable` wins first: it is meaningless on the elements that carry
  // `readOnly`, and a stub in a test could carry both.
  if (target.isContentEditable === true) return true;
  const tag = (target.tagName ?? '').toUpperCase();
  // NOT `SELECT`: it has no `readOnly` property at all, so the check below
  // would be answering a question the element never asks.
  if (tag === 'INPUT' || tag === 'TEXTAREA') return target.readOnly !== true;
  return tag === 'SELECT';
}
