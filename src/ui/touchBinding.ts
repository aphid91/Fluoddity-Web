/**
 * Touch listeners: pointer events in, tracker and camera calls out.
 *
 * `touchGestures.ts` is the half that DECIDES; this is the half that listens and
 * dispatches, holding no rules of its own. The same split as
 * `inputTracker.ts`/`inputBinding.ts`, for the same reason -- see those headers.
 *
 * =============================================================================
 * INSTALLED ONLY ON TOUCH, AND THAT IS WHAT PROTECTS THE DESKTOP
 * =============================================================================
 *
 * `main.ts` calls this instead of nothing when the mobile layout is resolved;
 * on a desktop it is never constructed and not one of its listeners exists. The
 * mouse path in `inputBinding.ts` is untouched either way -- this file adds
 * handlers, it does not modify them.
 *
 * **WHICH MAKES THE TWO PATHS OVERLAP A HAZARD.** Pointer Events deliver touch
 * and mouse through the SAME `pointerdown`/`pointermove`/`pointerup` names, so
 * without care a single finger would be interpreted twice: once here as a
 * gesture and once there as a mouse press. Every listener in this file therefore
 * filters on `pointerType === 'touch'`, and the ones that must suppress the
 * mouse path call `stopPropagation` -- see `swallow`.
 *
 * =============================================================================
 * WHAT EACH GESTURE MEANS, PER TOOL
 * =============================================================================
 *
 * The tool arbitrates the ONE-finger gesture, exactly as it arbitrates the left
 * mouse button on the desktop (`orchestrator.applyCanvasInput`). Two fingers
 * always mean the camera, in every tool, because navigation is not a tool.
 *
 *   SELECT   one finger pans the view; a TAP selects. The two are separated by
 *            distance, not by mode -- see `TAP_SLOP_PX`. This is the one tool
 *            where a drag is navigation rather than an edit, which is why it is
 *            also the only one where a long press is free to mean something.
 *
 *   SHOVE    one finger drags as a mouse button held down, so the existing
 *   DRAW     `shoveState`/`strokeFor` paths see exactly what they see on the
 *            desktop and need no touch-awareness at all. WHICH button is decided
 *            by the context toggle -- that is the whole of the mobile
 *            push/pull and draw/erase story, and it lives in the caller's
 *            `dragButton()` rather than here.
 *
 *   ANY      two fingers pan and zoom together.
 *
 * =============================================================================
 * THE SECOND FINGER RETRACTS THE FIRST
 * =============================================================================
 *
 * A pinch begins as a one-finger gesture that has already started doing
 * something -- panning the view, or painting a stroke. When the second finger
 * lands, that first gesture must be UNDONE rather than completed: `cancel()` on
 * the tracker, and a synthetic pointer-up so a held button is released. Without
 * it every pinch in Draw mode leaves a stroke painted across the canvas on the
 * way into the zoom.
 */

import type { InputTracker } from './inputTracker.ts';
import { LEFT_BUTTON, RIGHT_BUTTON } from './inputTracker.ts';
import type { MouseMode } from '../orchestrator/commands.ts';
import type { Surface } from '../app/surface.ts';
import type { CameraState } from '../camera/cameraState.ts';
import type { CanvasSize } from '../particleSystem/coords.ts';
import { ZOOM_PER_NOTCH } from '../camera/cameraState.ts';
import {
  PinchTracker,
  type Point,
  TouchGesture,
  pinchToNotches,
} from './touchGestures.ts';

export interface TouchBindingOptions {
  readonly surface: Surface;
  readonly tracker: InputTracker;
  /** The live camera, panned and zoomed directly. See `applyPinch`. */
  readonly camera: () => CameraState;
  /** World dimensions, for the pan/zoom conversions. Read per gesture. */
  readonly canvasSize: () => CanvasSize;
  /** The active tool, which arbitrates the one-finger gesture. */
  readonly mouseMode: () => MouseMode;
  /**
   * Which mouse button a one-finger drag imitates in Shove and Draw.
   *
   * A CALLBACK, because it is a live toggle the user flips from the hint bar
   * mid-session -- and deliberately not read in Select, where a drag is
   * navigation rather than a button.
   */
  readonly dragButton: () => typeof LEFT_BUTTON | typeof RIGHT_BUTTON;
  /**
   * A long press landed on the canvas. Select tool only -- see the header.
   *
   * The caller decides what it does (undo, or cancel a selection); this file
   * only decides WHEN, because the timing is a gesture question and the meaning
   * is an application one.
   */
  readonly onLongPress: () => void;
}

/**
 * Attach the touch listeners. Returns a per-frame pump and a teardown.
 *
 * The pump exists because a long press is the one gesture that fires from the
 * PASSAGE OF TIME rather than from an event -- there is no `pointerhold`. It
 * could have been a `setTimeout`, and is not: the frame loop is already running
 * and already owns the clock, so polling it there keeps this file free of timers
 * for the same reason `TouchGesture` is free of them.
 */
export function bindTouch(opts: TouchBindingOptions): {
  /** Call once per frame. Fires a long press when one has come due. */
  pump(now: number): void;
  dispose(): void;
} {
  const { surface, tracker, camera, canvasSize, mouseMode, dragButton, onLongPress } =
    opts;
  const canvas = surface.canvas;

  const gesture = new TouchGesture();
  const pinch = new PinchTracker();

  /**
   * Live touches, keyed by `pointerId`, in framebuffer pixels.
   *
   * A MAP RATHER THAN A COUNT, because a pinch needs both positions and the
   * browser reports them in separate events -- one `pointermove` carries one
   * finger. Keeping the last known position of each is what lets the second
   * event of a pair compute a distance at all.
   */
  const touches = new Map<number, Point>();

  /** Which button a Shove/Draw drag is currently holding, or `null`. */
  let heldButton: number | null = null;

  /**
   * Where the last pan step ended, so the next one is a delta rather than a jump.
   *
   * `drag-start` reports the ORIGIN, which is the correct first anchor -- the
   * view should move by everything the finger has travelled since touch-down,
   * including the slop it crossed to become a drag. Every step after measures
   * from here.
   */
  let lastPanPoint: Point = [0, 0];

  /**
   * CSS pixels to framebuffer pixels.
   *
   * The same conversion `inputBinding.ts` documents at length, and load-bearing
   * for the same reason: picks and strokes land where this says they land. Kept
   * as its own copy rather than exported from there because the two files are
   * deliberately independent -- the mouse path must not grow a touch import.
   */
  const toFramebuffer = (event: PointerEvent): Point => {
    const rect = canvas.getBoundingClientRect();
    const [fbWidth, fbHeight] = surface.size();
    const scaleX = fbWidth / (rect.width || 1);
    const scaleY = fbHeight / (rect.height || 1);
    return [(event.clientX - rect.left) * scaleX, (event.clientY - rect.top) * scaleY];
  };

  /**
   * Keep the browser's own gesture handling off this event.
   *
   * **NOT what separates this file from the mouse path** -- that is done at the
   * source, by `inputBinding.ts` declining touch pointers (`ignoreTouch`).
   * Propagation tricks could not do it: `stopImmediatePropagation` only silences
   * listeners registered after the caller, and the mouse path is registered
   * first.
   *
   * What this DOES prevent is the browser's default action -- text selection
   * from a drag, the synthetic `mousedown`/`click` pair that follows a tap, and
   * the double-tap zoom. `touch-action: none` in `index.html` already stops
   * scroll and pinch from being claimed; this covers the rest.
   */
  const swallow = (event: PointerEvent): void => {
    event.preventDefault();
  };

  /** Release whatever button a Shove/Draw drag was holding. */
  const releaseHeld = (): void => {
    if (heldButton === null) return;
    tracker.onPointerUp(heldButton);
    heldButton = null;
  };

  // --- one finger ----------------------------------------------------------

  const beginOneFinger = (at: Point, now: number): void => {
    gesture.start(at, now);
    // POSITION FIRST, ALWAYS. A tap that arrives before any movement still has
    // to pick at the right place, and in Shove/Draw the press below is acted on
    // at the position the tracker currently holds.
    tracker.onPointerMove(at[0], at[1]);

    // SELECT DOES NOT PRESS ANYTHING YET. Whether this is a tap (select) or a
    // drag (pan) is not known at touch-down, and pressing here would pick a
    // particle at the start of every pan. The press is synthesized on LIFT
    // instead, once the gesture has proven to be a tap -- see `onPointerUp`.
    if (mouseMode() === 'select') return;

    // Shove and Draw have no such ambiguity: a finger down IS a button down,
    // and the stroke should begin immediately rather than after 10px of travel.
    heldButton = dragButton();
    tracker.onPointerDown(heldButton, false, false);
  };

  const applyPan = (from: Point, to: Point): void => {
    camera().panByPixels(
      [to[0] - from[0], to[1] - from[1]],
      surface.size(),
      canvasSize(),
    );
  };

  // --- two fingers ---------------------------------------------------------

  /**
   * Give up the one-finger gesture because a second finger arrived.
   *
   * See the header: retracting rather than completing is what keeps a pinch from
   * leaving a stray tap or a stray stroke behind it.
   */
  const yieldToPinch = (): void => {
    gesture.cancel();
    releaseHeld();
  };

  const applyPinch = (a: Point, b: Point): void => {
    const update = pinch.update(a, b);
    if (update === null) return;

    // PAN FIRST, THEN ZOOM ABOUT THE MIDPOINT. The order matters: `zoomAtPixel`
    // anchors on a screen position, and anchoring on a midpoint that the pan has
    // not yet been applied to would fight the pan by a frame -- the view would
    // creep whenever the fingers both spread and drifted, which is most of the
    // time.
    if (update.panBy[0] !== 0 || update.panBy[1] !== 0) {
      applyPan([0, 0], [update.panBy[0], update.panBy[1]]);
    }
    const notches = pinchToNotches(update.scale, ZOOM_PER_NOTCH);
    if (notches !== 0) {
      camera().zoomAtPixel(
        notches,
        [update.center[0], update.center[1]],
        surface.size(),
        canvasSize(),
      );
    }
  };

  /** The two live touch positions, or `null` when there are not exactly two. */
  const twoTouches = (): readonly [Point, Point] | null => {
    if (touches.size !== 2) return null;
    const [a, b] = [...touches.values()];
    return a !== undefined && b !== undefined ? [a, b] : null;
  };

  // --- listeners -----------------------------------------------------------

  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') return;
    swallow(event);

    const at = toFramebuffer(event);
    touches.set(event.pointerId, at);

    const pair = twoTouches();
    if (pair !== null) {
      // The second finger. Retract the first one's gesture and start the pinch.
      yieldToPinch();
      pinch.start(pair[0], pair[1]);
      return;
    }
    // A THIRD FINGER IS IGNORED, deliberately: it is recorded in `touches` so
    // that lifting it cannot leave a stale entry, but it neither starts a
    // gesture nor disturbs the pinch already running. Resting a palm should not
    // cancel a zoom in progress.
    if (touches.size > 2) return;

    canvas.setPointerCapture(event.pointerId);
    beginOneFinger(at, event.timeStamp);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') return;
    if (!touches.has(event.pointerId)) return;
    swallow(event);

    const at = toFramebuffer(event);
    touches.set(event.pointerId, at);

    const pair = twoTouches();
    if (pair !== null) {
      applyPinch(pair[0], pair[1]);
      return;
    }
    if (touches.size > 2) return;

    const outcome = gesture.move(at);
    if (outcome.kind === 'pending' || outcome.kind === 'multi') return;

    // The tracker follows the finger in every tool, so a Shove/Draw drag reaches
    // the existing paths as an ordinary moving press.
    tracker.onPointerMove(at[0], at[1]);

    // ONLY SELECT PANS. In Shove and Draw the drag IS the edit, and moving the
    // camera under it would smear the stroke across a view that is sliding.
    if (mouseMode() !== 'select') return;
    applyPan(
      outcome.kind === 'drag-start' ? outcome.from : lastPanPoint,
      outcome.to,
    );
    lastPanPoint = outcome.to;
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') return;
    if (!touches.has(event.pointerId)) return;
    swallow(event);

    const hadPinch = touches.size === 2;
    touches.delete(event.pointerId);

    if (hadPinch) {
      // One finger of a pinch lifted. END THE PINCH RATHER THAN DEMOTING IT to a
      // one-finger pan: the remaining finger has not "started" a gesture, and
      // treating it as one would send the view lurching from wherever that
      // finger happens to be resting.
      pinch.end();
      return;
    }
    if (touches.size > 0) return;

    const outcome = gesture.end(event.timeStamp);

    // SHOVE AND DRAW: the button comes up however the gesture ended. A stroke
    // that never moved is still a dab, and the release is what the existing
    // paths use to finish it.
    if (mouseMode() !== 'select') {
      releaseHeld();
      return;
    }

    // SELECT: only a tap picks. A drag was a pan and has already done its work,
    // and a consumed long press did its work through `onLongPress`.
    if (outcome.kind !== 'tap') return;
    tracker.onPointerMove(outcome.at[0], outcome.at[1]);
    // SYNTHESIZED AS A PRESS AND A RELEASE, both, in the same frame. The press
    // is what `applyCanvasInput` reads as `leftPressed`; without the matching
    // release the tracker would hold `leftDragging` forever and the next frame
    // would look like a button stuck down.
    tracker.onPointerDown(LEFT_BUTTON, false, false);
    tracker.onPointerUp(LEFT_BUTTON);
  };

  /**
   * The browser took the pointer away. Treated as a hard stop, not a lift.
   *
   * No tap is synthesized and no long press can still fire: a cancelled gesture
   * is one the user did not finish, and acting on it would fire an edit they
   * did not ask for.
   */
  const onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') return;
    touches.delete(event.pointerId);
    gesture.cancel();
    pinch.end();
    releaseHeld();
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  // ON THE CANVAS, not the window, unlike the mouse path -- `setPointerCapture`
  // above already routes a moving finger back here even when it leaves the
  // element, and a window listener would additionally see touches that began on
  // the panel and drag across the canvas.
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);

  return {
    pump(now: number): void {
      // SELECT ONLY. In Shove and Draw a finger resting mid-stroke is a normal
      // thing to do, and firing an action under it would change the tool
      // beneath a stroke in progress -- see `touchGestures.ts`.
      if (mouseMode() !== 'select') return;
      if (gesture.longPressDue(now)) onLongPress();
    },
    dispose(): void {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
    },
  };
}
