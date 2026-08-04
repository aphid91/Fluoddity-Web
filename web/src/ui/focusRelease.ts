/**
 * Handing the keyboard back after the panel has taken it.
 *
 * =============================================================================
 * WHY THIS FILE EXISTS
 * =============================================================================
 *
 * The desktop had no analogue, because imgui does not use real focus: it draws
 * the panel itself and reports `want_capture_keyboard` per frame, so a widget
 * stops claiming the keyboard the moment you stop interacting with it. The DOM
 * has no such notion. Focus is a persistent property of an element, and it
 * survives the gesture that set it -- indefinitely, until something else takes
 * it.
 *
 * Tweakpane leans on that hard, and three separate consequences all read to a
 * user as "the keyboard stopped working":
 *
 *   1. DRAGGING A SLIDER focuses the TRACK, not the input. `PointerHandler`'s
 *      mousedown calls `currentTarget.focus()` (`tweakpane.js:3293`) on the
 *      `tp-sldv_t` div, which `bindTabIndex` has made focusable
 *      (`tweakpane.js:3563`, `:2408-2411`). The track then keeps focus after
 *      the drag ends, and its own `onKeyDown_` (`tweakpane.js:3622-3629`) steps
 *      the value on ArrowLeft/ArrowRight WITHOUT calling `preventDefault`. A
 *      focused `<div>` is not an editable target, so the app's arrow bindings
 *      fire too: one arrow press nudged the slider AND changed preset.
 *
 *   2. THE READ-ONLY READOUTS. Fixed in `hotkeys.ts` rather than here -- see
 *      the comment on `isEditableTarget`.
 *
 *   3. A NUMBER FIELD keeps focus after its Enter commit (`controls.ts:464`),
 *      so the editable-target gate (`inputBinding.ts:177`) then swallows every
 *      subsequent keystroke.
 *
 * The fix is to release focus at the moments a gesture has demonstrably ended:
 * a pointer release, or Enter/Escape. `X` (hide panel) is not one of them --
 * `setHidden` already makes focus unreachable by hiding the container.
 *
 * =============================================================================
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * =============================================================================
 *
 * **No `mouseleave`/`pointerleave` release.** It is the obvious fourth trigger
 * and it is a trap: `addInput`'s blur handler treats any blur as abandonment
 * and reverts the text (`controls.ts:481-484`, and that is the right meaning
 * for Escape). Cursor drift off a 320px panel is not an intentional gesture --
 * people move the mouse aside to SEE what they are typing -- so releasing on it
 * would silently discard a half-typed World Size. That is a data-loss bug
 * traded for an inconvenience one. The three triggers above cover the workflow
 * completely: drag, release, press `R`.
 *
 * **No knowledge of this module in `inputBinding.ts`.** That file states at
 * its `capturedByUi` (`inputBinding.ts:70-79`) that it deliberately does not
 * know the panel exists, and it holds no state. Panel-DOM awareness belongs to
 * the panel, so `Panel` owns the binding and this module owns the decision.
 */

/**
 * The shape `shouldReleaseFocus` needs from the focused element.
 *
 * Structural rather than `HTMLElement`, for the same reason `isEditableTarget`
 * is: `node --test` has no DOM, and the decision is the part worth testing.
 */
export interface FocusedShape {
  readonly tagName?: string;
  readonly isContentEditable?: boolean;
  readonly readOnly?: boolean;
}

/** What ended the gesture. Enter and Escape differ for the CALLER, not here. */
export type ReleaseReason = 'pointerup' | 'enter' | 'escape';

/** The attribute marking a container whose focus this module manages. */
export const PANEL_ATTRIBUTE = 'data-fluoddity-panel';

/**
 * Whether focus should be released from this element, given what just happened.
 *
 * **The one rule that carries the whole file: a POINTERUP must never blur a
 * writable text field.** Clicking into a number field is a pointerdown followed
 * immediately by a pointerup, so a blanket "release on pointerup" would blur
 * the field between the click and the first keystroke -- making every number
 * field in the panel impossible to type into. That failure is far worse than
 * the one being fixed, and it is invisible to any test that does not assert it
 * explicitly (`focusRelease.test.ts` does).
 *
 * Enter and Escape are unconditional by contrast, because both are explicit
 * "I am done here" gestures rather than incidental ones. What they mean for the
 * VALUE differs -- Enter commits first (`controls.ts:464-477`), Escape lets the
 * blur handler revert -- but that is settled by the field's own listeners
 * before this decision is ever consulted.
 */
export function shouldReleaseFocus(
  focused: FocusedShape | null | undefined,
  reason: ReleaseReason,
): boolean {
  if (focused === null || focused === undefined) return false;

  const tag = (focused.tagName ?? '').toUpperCase();
  // Nothing is focused in any meaningful sense: `document.activeElement` falls
  // back to `<body>` when focus is already where we want it, and blurring that
  // is a no-op with a misleading name.
  if (tag === 'BODY' || tag === 'HTML') return false;

  if (reason === 'enter' || reason === 'escape') return true;

  // --- pointerup -----------------------------------------------------------
  // A `<select>` is excluded: a pointerup on one is part of OPENING it, so
  // blurring here would make the dropdown unusable with the mouse. The tool
  // selector solves the same problem on `change` instead, and says why
  // (`mutationOverlay.ts:178-184`).
  if (tag === 'SELECT') return false;
  if (focused.isContentEditable === true) return false;
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    // Read-only is the readout case: there is nothing to type, so holding
    // focus is pure loss. Writable means the user just clicked in to type.
    return focused.readOnly === true;
  }

  // Everything else -- crucially the focusable `tp-sldv_t` track div, which is
  // the entire reason this function exists.
  return true;
}

/** Whether an element sits inside a container this module manages. */
export function isInsidePanel(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof Element)) return false;
  return target.closest(`[${PANEL_ATTRIBUTE}]`) !== null;
}

/**
 * Release focus if the currently focused element is inside a managed panel.
 *
 * Scoped to the panel on purpose, and that scope is what keeps the modal
 * dialogs correct: they are appended to `document.body`, never inside a
 * container (`dialogs.ts:196`), so `closest` cannot reach one and this never
 * fires for them. Native Escape-to-cancel and the Enter-to-save at
 * `dialogs.ts:68-70` keep working untouched, with no dialog-specific check
 * here to fall out of date.
 */
function releaseIfInPanel(reason: ReleaseReason): void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return;
  if (!isInsidePanel(active)) return;
  if (!shouldReleaseFocus(active, reason)) return;
  active.blur();
}

/**
 * Watch one panel container. Returns a disposer.
 *
 * Delegated on the container rather than wired per blade: it covers `addInput`,
 * both readout boxes, every slider track and every future blade kind with no
 * per-control wiring, in a codebase where a new control kind is a normal thing
 * to add.
 */
export function bindFocusRelease(container: HTMLElement): () => void {
  container.setAttribute(PANEL_ATTRIBUTE, 'true');

  /**
   * **BUBBLE PHASE, and this is load-bearing.**
   *
   * `addInput` registers its Enter handler on the input itself
   * (`controls.ts:464`), which is the event's target. In the bubble phase the
   * target's own listeners have already run by the time this one sees the
   * event, so the commit has completed -- and `live` has moved with it (step 1
   * of the fix) -- before focus goes anywhere. Registering with
   * `{ capture: true }` would reverse that order and blur the field BEFORE it
   * could read its own value, turning every Enter into an abandonment.
   */
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      releaseIfInPanel('enter');
    } else if (event.key === 'Escape') {
      releaseIfInPanel('escape');
    }
  };

  /**
   * `lostpointercapture` alongside `pointerup`, for the reason `gatedControl`
   * already documents for its own session (`gatedControl.ts:57-63`): a gesture
   * interrupted by a context menu or a window switch never gets its
   * `pointerup`, and focus would stay stuck with no second chance to clear it.
   */
  const onPointerUp = (): void => {
    releaseIfInPanel('pointerup');
  };

  container.addEventListener('keydown', onKeyDown);
  container.addEventListener('pointerup', onPointerUp);
  container.addEventListener('lostpointercapture', onPointerUp);

  return (): void => {
    container.removeEventListener('keydown', onKeyDown);
    container.removeEventListener('pointerup', onPointerUp);
    container.removeEventListener('lostpointercapture', onPointerUp);
    container.removeAttribute(PANEL_ATTRIBUTE);
  };
}
