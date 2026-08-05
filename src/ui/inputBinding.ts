/**
 * The DOM listeners: events in, `InputTracker` calls out.
 *
 * The port of `ui.py:141-190` -- the five GLFW callbacks. This file is
 * deliberately the ONLY one in the input path that touches `window` or
 * `document`, and it holds no state, so that everything with a decision in it
 * stays testable under `node --test` (see `inputTracker.ts`).
 *
 * =============================================================================
 * CAPTURE, AND WHY THE BROWSER MAKES THIS THE INTERESTING FILE
 * =============================================================================
 *
 * The desktop gets capture arbitration free. `ui.py:66-80` installs its GLFW
 * callbacks AFTER imgui's and keeps imgui's bound methods, so every handler
 * forwards the event to imgui and then reads `want_capture_mouse` -- imgui has
 * already updated it, mid-callback, synchronously.
 *
 * The DOM has no such flag, because it hit-tests BEFORE dispatching: by the
 * time a handler runs, the browser has already decided which element the event
 * belongs to. So capture here is reconstructed from that decision --
 * `event.target` being inside the canvas, or not. Same answer, arrived at from
 * the opposite direction.
 *
 * Three listeners are on `window` rather than the canvas, and each for a
 * reason that is one of the desktop's asymmetries:
 *
 *   - `pointerup` -- a release must be seen wherever it lands, or a drag that
 *     ends over the panel never terminates.
 *   - `pointermove` -- position is never capture-filtered, so a drag keeps
 *     tracking the cursor across the UI.
 *   - `keydown`/`keyup` -- the canvas has no `tabindex` and cannot hold focus,
 *     so keys arrive at `document.body` and there is nothing else to listen on.
 */

import { DEFAULT_HOTKEYS, isEditableTarget, matchHotkey, type Hotkey } from './hotkeys.ts';
import { InputTracker } from './inputTracker.ts';
import type { Surface } from '../app/surface.ts';
import type { Command } from '../orchestrator/commands.ts';

export interface InputBindingOptions {
  readonly surface: Surface;
  /** Where app commands go. */
  readonly dispatch: (command: Command) => void;
  /** Handle the `toggleUi` local action -- the `X` key. */
  readonly toggleUi: () => void;
  /**
   * Handle the `copyShareLink` local action -- `Shift+C`.
   *
   * Local rather than dispatched for the reason `toggleUi` is: the clipboard
   * belongs to the browser, not to the simulation.
   */
  readonly copyShareLink: () => void;
  /** Defaults to `DEFAULT_HOTKEYS`; a parameter so a test or Step 10 can swap it. */
  readonly hotkeys?: readonly Hotkey[];
}

/**
 * A `WheelEvent.deltaMode` of LINE or PAGE reports in rows/screens, not pixels.
 *
 * Firefox uses LINE for a real mouse wheel where Chrome uses PIXEL, so without
 * this a wheel notch would zoom by ~100x more in one browser than the other.
 * The divisors convert each mode to roughly one notch per detent.
 */
const PIXELS_PER_NOTCH = 100;
const LINES_PER_NOTCH = 3;

/** Attach every input listener. Returns a tracker to `freeze()` each frame. */
export function bindInput(opts: InputBindingOptions): {
  readonly tracker: InputTracker;
  dispose(): void;
} {
  const { surface, dispatch, toggleUi, copyShareLink } = opts;
  const canvas = surface.canvas;
  const tracker = new InputTracker();
  const table = opts.hotkeys ?? DEFAULT_HOTKEYS;

  /**
   * Whether an event belongs to the UI rather than the canvas.
   *
   * The canvas is the only surface the simulation owns, so anything that is not
   * on it is the UI's -- which covers the Tweakpane panel without this file
   * having to know the panel exists. (`#thin-panel` is `position: fixed`,
   * z-index 20; the `?debug` overlay is `pointer-events: none` and never
   * becomes a target at all.)
   */
  const capturedByUi = (event: Event): boolean => event.target !== canvas;

  /**
   * CSS pixels to framebuffer pixels.
   *
   * **This conversion is load-bearing and easy to get subtly wrong.**
   * `clientX/Y` are CSS pixels; `zoomAtPixel` and `screenToWorld` take the
   * framebuffer's device pixels (`surface.size()`, per `surface.ts:26-34`).
   *
   * Scaled by the ratio of the backing store to the element's laid-out box --
   * NOT by `devicePixelRatio`. They agree at 100% browser zoom and drift at
   * fractional zoom, which is exactly why `surface.ts:88-91` prefers
   * `devicePixelContentBoxSize` for the same measurement. Using `dpr` here
   * would put picks near-but-not-on the cursor, with an error that grows with
   * distance from the origin -- the kind of thing that reads as "picking is a
   * bit imprecise" rather than as a bug.
   */
  const toFramebuffer = (event: PointerEvent): [number, number] => {
    const rect = canvas.getBoundingClientRect();
    const [fbWidth, fbHeight] = surface.size();
    // A zero-width rect means the canvas is not laid out; fall back to 1 so the
    // division cannot produce NaN and poison the camera transform.
    const scaleX = fbWidth / (rect.width || 1);
    const scaleY = fbHeight / (rect.height || 1);
    return [(event.clientX - rect.left) * scaleX, (event.clientY - rect.top) * scaleY];
  };

  // --- pointer -------------------------------------------------------------

  const onPointerDown = (event: PointerEvent): void => {
    // Position first: a click that arrives before any movement (a tap, or the
    // very first interaction after load) must still pick at the right place.
    tracker.onPointerMove(...toFramebuffer(event));

    const captured = capturedByUi(event);
    if (!captured) {
      // The drag keeps receiving move/up events even when the cursor leaves the
      // canvas, which is the DOM's version of "a drag belongs to whoever
      // received the press". The tracker enforces that too; this makes the
      // browser cooperate rather than relying on the window listeners alone.
      canvas.setPointerCapture(event.pointerId);
    }
    tracker.onPointerDown(event.button, captured);
  };

  // On WINDOW, and never capture-filtered. See the header.
  const onPointerUp = (event: PointerEvent): void => {
    tracker.onPointerMove(...toFramebuffer(event));
    tracker.onPointerUp(event.button);
  };

  const onPointerMove = (event: PointerEvent): void => {
    tracker.onPointerMove(...toFramebuffer(event));
  };

  /**
   * `pointercancel` is a release the desktop has no equivalent for.
   *
   * The browser fires it instead of `pointerup` when it takes the pointer away
   * -- a touch becoming a scroll gesture, or the window losing the device. It
   * is still a drag that must end, so it routes to the same place.
   */
  const onPointerCancel = (event: PointerEvent): void => {
    tracker.onPointerUp(event.button);
  };

  const onWheel = (event: WheelEvent): void => {
    if (capturedByUi(event)) return; // Let the panel scroll.
    // The canvas would otherwise scroll the page. `{ passive: false }` at the
    // registration is what makes this legal.
    event.preventDefault();

    const perNotch =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? LINES_PER_NOTCH
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? 1
          : PIXELS_PER_NOTCH;
    // NEGATED: `deltaY` is positive DOWN, and `InputState.scroll` is notches
    // positive UP (`inputState.ts:63-69`) because that is what `zoomAtPixel`
    // reads as "zoom in".
    tracker.onWheel(-event.deltaY / perNotch, false);
  };

  /**
   * Right-dragging on the canvas would otherwise raise the browser's menu
   * mid-stroke -- and right-drag is the ERASE gesture for Step 9's field, so
   * this is not merely cosmetic.
   */
  const onContextMenu = (event: MouseEvent): void => {
    if (!capturedByUi(event)) event.preventDefault();
  };

  // --- keyboard ------------------------------------------------------------

  const onKeyDown = (event: KeyboardEvent): void => {
    const captured = isEditableTarget(event.target as { tagName?: string } | null);
    tracker.onKeyDown(event.code, event.shiftKey, captured);
    if (captured) return;

    // A hotkey fires on the DOWN edge, from the event rather than from the
    // frozen snapshot. The desktop reads `keys_pressed` at the top of the next
    // frame instead (`ui.py:254`); dispatching here is the same one-shot a
    // frame earlier, and it keeps the table's `preventDefault` decision at the
    // one place that still has an event to prevent.
    //
    // `keysPressed` is still carried on `InputState` -- Step 10's UI reads it
    // for keystrokes the table does not own.
    const hit = matchHotkey(table, event.code, event.shiftKey);
    if (hit === null) return;

    // Ctrl/Meta combinations are the browser's, without exception. The table is
    // Ctrl-free (see `hotkeys.ts`), so this is not a rule the bindings need --
    // it is what keeps Ctrl+R reloading and Ctrl+C copying even though `KeyR`
    // and `KeyC` are both bound bare.
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    // Space scrolls the page and the arrows move focus. Prevented only once a
    // binding has actually matched, so unbound keys keep their browser meaning.
    event.preventDefault();

    // A SWITCH WITH A `never` ARM, so adding a `LocalAction` without handling it
    // is a compile error rather than a key that silently does nothing -- which
    // is the failure mode a chain of `else if`s would have given, and an
    // especially bad one here: a bound key that no-ops looks like a broken
    // keyboard, not like missing code.
    if (hit.local !== undefined) {
      switch (hit.local) {
        case 'toggleUi':
          toggleUi();
          break;
        case 'copyShareLink':
          copyShareLink();
          break;
        default: {
          const unreachable: never = hit.local;
          throw new Error(`Unhandled local action: ${String(unreachable)}`);
        }
      }
    } else if (hit.command !== undefined) {
      dispatch(hit.command);
    }
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    tracker.onKeyUp(event.code, event.shiftKey);
  };

  const onBlur = (): void => {
    tracker.onFocusLost();
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  return {
    tracker,
    dispose(): void {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    },
  };
}
