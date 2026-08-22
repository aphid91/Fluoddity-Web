/**
 * InputTracker: raw events in, one frozen `InputState` per frame out.
 *
 * The port of `ui.py`'s accumulator half -- the state at `ui.py:82-97`, the
 * five GLFW callbacks at `:141-190`, and the freeze/drain at `:196-255`.
 *
 * ## Why this is a separate file from the DOM listeners
 *
 * Everything that DECIDES anything lives here, and this file imports nothing
 * from `window`. `npm test` runs under `node --test` with no DOM, so a tracker
 * that touched `document` could not be tested at all -- and the three
 * asymmetries below are exactly the kind of thing that is silent when wrong and
 * miserable to debug in a browser. `inputBinding.ts` is the other half: it adds
 * listeners and translates their events into calls on this class, and holds no
 * state of its own.
 *
 * ## Capture is resolved by the CALLER, once, per event
 *
 * The `capturedByUi` parameters are the port of imgui's `want_capture_mouse` /
 * `want_capture_keyboard`. On the desktop those are free: `ui.py:66-80` installs
 * its handlers after imgui's and forwards to them, so each callback can ask
 * imgui what it just claimed. The DOM hit-tests before the handler runs, so
 * `inputBinding.ts` reconstructs the same answer from the event target.
 *
 * Either way the rule is the desktop's: by the time anything reads the frozen
 * state, the plain fields already mean "meant for the canvas", and **no
 * consumer downstream checks a capture flag**.
 *
 * ## The three asymmetries, which are the reason this class exists
 *
 * Documented at `inputState.ts:26-40` as properties of what the fields MEAN;
 * this is where they are implemented, each at its site:
 *
 *   1. A CAPTURED PRESS IS DROPPED ENTIRELY -- it sets neither `held` nor
 *      `dragging`, so a press that lands on the panel can never start a canvas
 *      drag (`ui.py:174-181`).
 *   2. A RELEASE IS NEVER CAPTURE-FILTERED -- it always clears `held` and
 *      `dragging`, whatever it landed on. This is what guarantees a drag
 *      terminates (`ui.py:182-185`).
 *   3. HELD STATE PERSISTS ACROSS FRAMES; one-shots drain. `freeze()` clears
 *      the events and leaves the conditions (`ui.py:244-252`).
 */

import type { InputState } from './inputState.ts';

/** Which pointer button. The values are `PointerEvent.button`. */
export const LEFT_BUTTON = 0;
export const MIDDLE_BUTTON = 1;
export const RIGHT_BUTTON = 2;

/**
 * Accumulates input events and freezes one `InputState` per frame.
 *
 * Not frozen itself and not immutable -- it is the mutable accumulator the
 * immutable snapshots come out of, exactly like the desktop's `Ui` object.
 */
export class InputTracker {
  // --- pointer ---------------------------------------------------------
  private mouseX = 0;
  private mouseY = 0;

  /**
   * Button is down AND the press landed on the canvas.
   *
   * The desktop keeps `_held` and `_dragging` as separate dicts (`ui.py:88-89`).
   * They are merged here because nothing in the port reads `held`: the desktop's
   * only consumer is its debug panel (`ui.py:299-382`), and `InputState` never
   * carried the field. Two flags that are always written together and read by
   * nobody is worse than one.
   */
  private leftDown = false;
  private rightDown = false;

  /** One-shots, drained by `freeze()`. */
  private leftPressed = false;
  private rightPressed = false;

  private scroll = 0;

  // --- keyboard --------------------------------------------------------
  private readonly keysHeld = new Set<string>();
  private readonly keysPressed = new Set<string>();
  private shift = false;

  /**
   * The cursor moved. NEVER capture-filtered, matching `ui.py:162-164`.
   *
   * `mousePos` is always the true cursor position even over the panel, because
   * a drag that began on the canvas has to keep tracking the mouse while it
   * wanders (asymmetry 2 would be pointless otherwise), and the `?debug`
   * readout should not freeze when the cursor crosses the UI.
   *
   * **Framebuffer pixels, top-left origin** -- the caller converts. See
   * `inputBinding.ts`, where getting this wrong is a real hazard.
   */
  onPointerMove(x: number, y: number): void {
    this.mouseX = x;
    this.mouseY = y;
  }

  /**
   * A button went down. `capturedByUi` means it landed on the UI, not the canvas.
   *
   * ASYMMETRY 1 lives here: a captured press returns having recorded nothing, so
   * it can neither fire a one-shot nor open a drag. The desktop does the same at
   * `ui.py:174-181`, and records an unfiltered `_any_pressed` first -- omitted
   * here because `InputState` has no `anyLeftPressed`, its desktop counterpart
   * having no consumer either.
   */
  onPointerDown(button: number, capturedByUi: boolean, shift = false): void {
    if (capturedByUi) return;
    // **RECORDED FROM THE MOUSE EVENT, NOT LEFT TO THE KEYBOARD.** `shift` was
    // written only by `onKeyDown`/`onKeyUp` when its one consumer was the
    // `Shift+Z` hotkey pair. Shift+Right-click has no such key event to ride on:
    // holding Shift does fire a keydown, but a user who presses the modifier
    // while the pointer is already down -- or whose keydown went to a focused
    // panel field -- would right-click with `shift` reading false. Taking it
    // from the pointer event asks the browser what was actually held AT THE
    // CLICK, which is the only moment that decides undo from redo.
    //
    // DEFAULTED so the parameter is optional: `onPointerUp` has no equivalent
    // and the tests that predate this call it with two arguments.
    this.shift = shift;
    if (button === LEFT_BUTTON) {
      this.leftPressed = true;
      this.leftDown = true;
    } else if (button === RIGHT_BUTTON) {
      this.rightPressed = true;
      this.rightDown = true;
    }
  }

  /**
   * A button came up. **Deliberately has no `capturedByUi` parameter.**
   *
   * ASYMMETRY 2, and the missing parameter is the point: there is no way to
   * write a capture-filtered release through this API, so the bug cannot be
   * reintroduced by an edit to the caller. A button that went down on the canvas
   * must be able to come up over the panel or the drag never ends and the canvas
   * stays grabbed (`ui.py:182-185`).
   */
  onPointerUp(button: number): void {
    if (button === LEFT_BUTTON) {
      this.leftDown = false;
    } else if (button === RIGHT_BUTTON) {
      this.rightDown = false;
    }
  }

  /**
   * Wheel movement, in notches, positive up.
   *
   * ACCUMULATES within the frame (`+=`, as `ui.py:189`) rather than replacing:
   * `zoomAtPixel` takes notches as an exponent, so a fast flick that delivers
   * three events between two frames should be worth three notches of zoom
   * rather than one.
   */
  onWheel(notches: number, capturedByUi: boolean): void {
    if (capturedByUi) return;
    this.scroll += notches;
  }

  /**
   * A key went down. `code` is `KeyboardEvent.code`, not `.key`.
   *
   * `capturedByUi` here means "an editable element has it" -- typing `r` into a
   * preset-name field must not reset the simulation (`ui.py:423-425`).
   *
   * Auto-repeat is NOT filtered, matching the desktop, which cannot tell PRESS
   * from REPEAT and does not try (`ui.py:154-156`). See `keysPressed` in
   * `inputState.ts` for why that is the right default.
   */
  onKeyDown(code: string, shift: boolean, capturedByUi: boolean): void {
    // Written before the capture check, as `ui.py:143` does: the modifier is a
    // property of the keyboard rather than of who owns the keystroke.
    this.shift = shift;
    if (capturedByUi) return;
    this.keysPressed.add(code);
    this.keysHeld.add(code);
  }

  /**
   * A key came up. Not capture-filtered, same reason as `onPointerUp`.
   *
   * A key that went down on the canvas and comes up after a text field took
   * focus would otherwise stay in `keysHeld` forever -- and since `keysHeld`
   * drives continuous panning, "forever" means the view slides away on its own
   * with nothing held down (`ui.py:148-152`).
   */
  onKeyUp(code: string, shift: boolean): void {
    this.shift = shift;
    this.keysHeld.delete(code);
  }

  /**
   * The window lost focus. **No desktop analogue, and genuinely needed.**
   *
   * A browser tab that loses focus stops delivering `keyup` entirely, so a held
   * `KeyW` at alt-tab time would still be in `keysHeld` on return and the view
   * would pan by itself with the keyboard untouched. GLFW keeps delivering to
   * an unfocused window, so `ui.py` never had to think about this.
   *
   * Drags are dropped for the same reason: the `pointerup` may never arrive.
   */
  onFocusLost(): void {
    this.keysHeld.clear();
    this.keysPressed.clear();
    this.leftDown = false;
    this.rightDown = false;
  }

  /**
   * Freeze this frame's input, then drain the one-shots.
   *
   * The port of `ui.py:196-255`. `dt` is passed in rather than measured because
   * the frame loop owns the clock -- and because a tracker that called
   * `performance.now()` would not be testable.
   *
   * WHAT DRAINS AND WHAT DOES NOT (`ui.py:244-252`): the one-shots and the
   * scroll accumulator are EVENTS and reset; held/dragging state are CONDITIONS
   * and persist until their release arrives. Getting this backwards gives either
   * a click that fires every frame or a drag that ends after one.
   *
   * The two sets are COPIED into the snapshot before `keysPressed` is cleared,
   * so draining cannot reach back into a state a consumer still holds.
   */
  freeze(dt: number): InputState {
    const state: InputState = {
      mousePos: [this.mouseX, this.mouseY],
      dt,
      leftPressed: this.leftPressed,
      rightPressed: this.rightPressed,
      leftDragging: this.leftDown,
      rightDragging: this.rightDown,
      scroll: this.scroll,
      keysHeld: new Set(this.keysHeld),
      keysPressed: new Set(this.keysPressed),
      shift: this.shift,
    };

    this.leftPressed = false;
    this.rightPressed = false;
    this.scroll = 0;
    this.keysPressed.clear();

    return state;
  }
}
