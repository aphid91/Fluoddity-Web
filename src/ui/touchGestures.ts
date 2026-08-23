/**
 * Touch pointers in, gestures out. The DOM-free half of touch input.
 *
 * This is to `inputBinding.ts` what `inputTracker.ts` is to it: everything that
 * DECIDES anything lives here and imports nothing from `window`, so the rules
 * below are testable under `node --test`. That matters more here than it does
 * for the mouse, because a touch gesture is a CLASSIFICATION rather than an
 * event -- the browser reports "a finger moved" and this file decides whether
 * that was a tap, a pan, a pinch, or the beginning of a long press. Every one of
 * those decisions is a threshold, and a threshold that is wrong by a little is
 * invisible in code review and maddening in the hand.
 *
 * =============================================================================
 * THE CENTRAL PROBLEM: A TAP IS A DRAG THAT WAS TOO SMALL
 * =============================================================================
 *
 * A mouse has separate signals for these -- `click` fires only when press and
 * release land on the same element, and a drag is a press with movement between.
 * A finger has no such distinction. Every tap moves a few pixels, because
 * fingers are soft and people are not steady, and every drag begins as a press
 * that has not moved yet. So the same opening event has to be able to become
 * either one, and the decision is deferred until enough has happened to make it.
 *
 * That is why this is a state machine and not three independent handlers. The
 * three outcomes are mutually exclusive and each one CANCELS the others:
 *
 *   - moving past `TAP_SLOP_PX` promotes a press to a drag, and kills the
 *     pending long-press (you are dragging, not holding);
 *   - `LONG_PRESS_MS` elapsing without that movement fires the long press, and
 *     kills the pending tap (the finger has been down too long to be a tap);
 *   - lifting before either fires the tap.
 *
 * ## Why the slop is checked against the ORIGIN, not the last position
 *
 * Accumulating per-move distance would let a slow, wandering finger stay under
 * the threshold forever while travelling right across the screen -- each step is
 * small even though the journey is not. Distance from where the finger STARTED
 * is the quantity that actually means "this stopped being a tap".
 *
 * ## Multi-touch: the second finger changes what the first one meant
 *
 * A pinch does not begin with two fingers. It begins with one finger that was
 * already panning (or already looked like a tap), and then a second arrives.
 * When that happens the one-finger gesture is RETRACTED rather than completed --
 * `secondPointerDown` returns the cancellation so the caller can undo whatever
 * the first finger had started. Without that, every pinch would leave a stray
 * pan or a stray tap behind it, and in Draw mode that means a stray stroke
 * painted across the canvas before the zoom begins.
 */

/** How far a finger may travel and still count as a tap, in CSS pixels. */
export const TAP_SLOP_PX = 10;

/**
 * How long a finger must be still before the press counts as long.
 *
 * Matches `tooltip.ts`'s hover delay, deliberately: on touch this gesture is
 * what REPLACES hover, so the wait before help appears should be the same
 * either way.
 *
 * **DELIBERATELY NOT SHORTER THAN THE OS THRESHOLD.** An earlier plan was to
 * undercut the platform's own long-press (~500ms) so ours fires first and the
 * text-selection callout never appears. That is a race, and it is lost on slow
 * frames. The CSS in `index.html` suppresses selection outright instead, which
 * makes the timing ours to choose on comfort alone.
 */
export const LONG_PRESS_MS = 500;

/**
 * Longest a touch can last and still be a tap, in milliseconds.
 *
 * Strictly greater than `LONG_PRESS_MS` would be unreachable -- the long press
 * would already have fired -- so this exists for the case where the long press
 * was CONSUMED and the finger stayed down. See `pointerUp`.
 */
export const TAP_MAX_MS = LONG_PRESS_MS;

/** A point in framebuffer pixels, the space `inputBinding.ts` converts to. */
export type Point = readonly [number, number];

/** What a completed one-finger gesture turned out to be. */
export type TouchOutcome =
  | { readonly kind: 'tap'; readonly at: Point }
  | { readonly kind: 'drag-end' }
  /** The finger lifted after a long press had already fired. Nothing to do. */
  | { readonly kind: 'consumed' };

/** What `pointerMove` decided this movement means. */
export type MoveOutcome =
  /** Still could be a tap. The caller does nothing. */
  | { readonly kind: 'pending' }
  /**
   * The gesture just became a drag. Carries the ORIGIN, because a caller that
   * has been ignoring movement needs to start the drag from where the finger
   * went down rather than from where it has reached.
   */
  | { readonly kind: 'drag-start'; readonly from: Point; readonly to: Point }
  /** An established drag continued. */
  | { readonly kind: 'drag-move'; readonly from: Point; readonly to: Point }
  /** Two or more fingers: `PinchTracker` owns this now. */
  | { readonly kind: 'multi' };

/**
 * One finger's journey, from touch to lift.
 *
 * Holds no timers: `LONG_PRESS_MS` is checked against a timestamp the caller
 * supplies, so this class never calls `setTimeout` or reads a clock. The caller
 * owns both, exactly as `InputTracker.freeze` takes `dt` rather than measuring
 * it -- and for the same reason, which is that a class that read the clock could
 * not be tested.
 */
export class TouchGesture {
  private origin: Point = [0, 0];
  private latest: Point = [0, 0];
  private startedAt = 0;
  private active = false;
  /** Past the slop: this is a drag and can no longer become a tap. */
  private dragging = false;
  /** The long press fired; the lift must not also produce a tap. */
  private consumed = false;

  /** Whether a finger is currently down and being tracked. */
  get isActive(): boolean {
    return this.active;
  }

  /** Whether this gesture has been promoted to a drag. */
  get isDragging(): boolean {
    return this.dragging;
  }

  /** Where the finger went down. Meaningless while inactive. */
  get startPoint(): Point {
    return this.origin;
  }

  /** Begin tracking. `now` is a monotonic timestamp in milliseconds. */
  start(at: Point, now: number): void {
    this.origin = at;
    this.latest = at;
    this.startedAt = now;
    this.active = true;
    this.dragging = false;
    this.consumed = false;
  }

  /**
   * The finger moved. Says whether that changed what the gesture is.
   *
   * Returns `drag-start` EXACTLY ONCE per gesture, on the move that crosses the
   * threshold, and `drag-move` for every one after. The caller needs the two
   * distinguished because starting a drag and continuing one are different acts
   * -- in Draw mode the first lays down a stroke origin and the rest extend it.
   */
  move(to: Point): MoveOutcome {
    if (!this.active) return { kind: 'pending' };
    this.latest = to;

    if (this.dragging) return { kind: 'drag-move', from: this.origin, to };

    // AGAINST THE ORIGIN, not the previous point -- see the header.
    if (distance(this.origin, to) <= TAP_SLOP_PX) return { kind: 'pending' };

    this.dragging = true;
    // The long press is off the table now: a finger that has travelled is
    // being dragged, however long it has been down.
    return { kind: 'drag-start', from: this.origin, to };
  }

  /**
   * Whether the long press should fire NOW, given the current time.
   *
   * Polled by the caller rather than scheduled here, so this class stays free of
   * timers. Returns true at most once per gesture: it sets `consumed`, which is
   * also what stops the eventual lift producing a tap.
   *
   * REFUSES ONCE DRAGGING, which is the interaction that makes this a state
   * machine rather than two independent checks. A finger held still for 600ms
   * and THEN dragged must not fire a long press mid-drag -- and in Draw mode
   * that is not hypothetical: pausing at the end of a stroke is a completely
   * natural thing to do, and it would otherwise flip the tool under the user.
   */
  longPressDue(now: number): boolean {
    if (!this.active || this.dragging || this.consumed) return false;
    if (now - this.startedAt < LONG_PRESS_MS) return false;
    this.consumed = true;
    return true;
  }

  /**
   * The finger lifted. Says what the whole gesture was.
   *
   * `consumed` wins over everything: once the long press has fired, the lift is
   * the end of a gesture that already did its work. Without that check a long
   * press would fire its action AND then a tap, so a long-press-to-undo would
   * undo twice.
   */
  end(now: number): TouchOutcome {
    if (!this.active) return { kind: 'consumed' };
    this.active = false;

    if (this.consumed) return { kind: 'consumed' };
    if (this.dragging) return { kind: 'drag-end' };
    // A finger that never moved but sat there past the long-press window with
    // nobody polling is not a tap either -- the caller may have been busy. The
    // window is the same one, so the two paths agree about what "too long"
    // means.
    if (now - this.startedAt > TAP_MAX_MS) return { kind: 'consumed' };
    return { kind: 'tap', at: this.latest };
  }

  /**
   * Abandon the gesture without producing an outcome.
   *
   * For `pointercancel`, and for the second finger arriving -- both are cases
   * where the gesture stops being what it was through no decision of the user's.
   */
  cancel(): void {
    this.active = false;
    this.dragging = false;
    this.consumed = false;
  }
}

/** What a two-finger movement asks the camera to do. */
export interface PinchUpdate {
  /**
   * Zoom factor since the last update: >1 is fingers spreading (zoom in).
   *
   * A RATIO rather than a delta, because zoom is multiplicative -- the camera's
   * `zoomAtPixel` takes notches as an exponent, and pinch distance relates to
   * scale the same way. A subtraction here would zoom differently depending on
   * how far in the view already was.
   */
  readonly scale: number;
  /** How far the midpoint moved, in framebuffer pixels. The pan component. */
  readonly panBy: readonly [number, number];
  /** The midpoint itself: the fixed point the zoom happens about. */
  readonly center: Point;
}

/**
 * Two fingers, tracked as a distance and a midpoint.
 *
 * **PAN AND ZOOM COME FROM THE SAME GESTURE, ALWAYS.** They are not separate
 * modes to switch between: a two-finger movement almost always contains some of
 * each, because fingers that spread also drift. Reporting both every update, and
 * letting either be ~0, is what makes the gesture feel like it is tracking the
 * hand rather than snapping to whichever it decided you meant.
 */
export class PinchTracker {
  private lastDistance = 0;
  private lastCenter: Point = [0, 0];
  private active = false;

  get isActive(): boolean {
    return this.active;
  }

  /** Begin, from the two current touch points. */
  start(a: Point, b: Point): void {
    this.lastDistance = Math.max(distance(a, b), 1e-6);
    this.lastCenter = midpoint(a, b);
    this.active = true;
  }

  /**
   * Both fingers moved. Returns the change since the last call.
   *
   * Returns `null` before `start`, so a stray move cannot produce a NaN scale
   * from a zero baseline distance and send the camera somewhere unrecoverable.
   */
  update(a: Point, b: Point): PinchUpdate | null {
    if (!this.active) return null;

    // FLOORED AWAY FROM ZERO. Two fingers can report identical positions -- at
    // touch-down on some digitizers, or when they physically meet -- and the
    // ratio below would be Infinity or NaN. `cameraState.setZoom` refuses
    // non-finite input, so the zoom would silently stop responding rather than
    // fail loudly.
    const dist = Math.max(distance(a, b), 1e-6);
    const center = midpoint(a, b);

    const update: PinchUpdate = {
      scale: dist / this.lastDistance,
      panBy: [center[0] - this.lastCenter[0], center[1] - this.lastCenter[1]],
      center,
    };

    this.lastDistance = dist;
    this.lastCenter = center;
    return update;
  }

  end(): void {
    this.active = false;
  }
}

/**
 * A pinch `scale` ratio as wheel notches, for `zoomAtPixel`.
 *
 * The camera's only zoom entry point takes notches, where each notch is a fixed
 * multiplicative step -- so converting means asking how many notches produce
 * this ratio, which is a logarithm rather than a scaling. `ZOOM_PER_NOTCH` here
 * must match the camera's own step or a pinch would zoom at a different rate
 * than the wheel; it is asserted in the tests rather than trusted to a comment.
 *
 * Returns 0 for a non-finite or non-positive ratio, which cannot come from
 * `PinchTracker` (it floors the distance) but can come from a caller that built
 * one by hand. Zero is the harmless answer: no zoom this frame.
 */
export function pinchToNotches(scale: number, zoomPerNotch: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 0;
  return Math.log(scale) / Math.log(zoomPerNotch);
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function midpoint(a: Point, b: Point): Point {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}
