/**
 * InputState: one frame's input, frozen.
 * The type half of `ui/input_state.py` (86 lines, 24 fields).
 *
 * ## Why this exists in Step 7 when Step 8 owns input
 *
 * The frame loop consumes input, so it needs the TYPE to be written against --
 * `applyCanvasInput` and `applyCameraKeys` are ports of real desktop methods
 * and would otherwise have nothing to read. What Step 7 does NOT build is the
 * event plumbing: no `pointerdown` handlers, no `setPointerCapture`, no
 * capture arbitration, no hotkey table. That is Step 8's, and it is the larger
 * half.
 *
 * So this file is the contract plus `EMPTY_INPUT`. A Step 7 app is drivable
 * through the Tweakpane panel and shows a live simulation; it does not yet
 * respond to the mouse or the keyboard on the canvas.
 *
 * ## Rebuilt once per frame, never mutated
 *
 * The desktop's is a frozen dataclass rebuilt each frame, so **every consumer
 * within a frame sees identical input**. `readonly` is the port of that, and it
 * matters more than it looks: `applyCanvasInput` and `status()` both read
 * `mousePos`, and a value that could change between them would put the readout
 * and the pick at different pixels.
 *
 * ## The asymmetries Step 8 must keep
 *
 * Stated here rather than in Step 8's handler because they are properties of
 * what these FIELDS MEAN, and a handler written without them produces fields
 * that are subtly the wrong thing:
 *
 *   - **Releases are never capture-filtered.** A button that went down on the
 *     canvas must be able to come up over a panel, or the drag never ends.
 *   - **A drag belongs to whoever received the press.** `leftDragging` stays
 *     true while the cursor wanders over the UI. That is why the drawing and
 *     shove tools read `*Dragging` rather than `*Held`.
 *   - **Capture is resolved ONCE, at the event handler.** By the time input
 *     reaches here, plain fields already mean "meant for the canvas". **No
 *     consumer downstream checks a capture flag** -- if you find yourself
 *     wanting to, the filtering belongs upstream.
 */

/** One frame's input, already filtered for UI capture. */
export interface InputState {
  /** Cursor position in framebuffer pixels, top-left origin. */
  readonly mousePos: readonly [number, number];
  /** Seconds since the previous frame. Zero on the first frame. */
  readonly dt: number;

  /** Went down THIS frame, on the canvas. One-shot. */
  readonly leftPressed: boolean;
  readonly rightPressed: boolean;
  /**
   * A drag owned by the canvas is in progress.
   *
   * NOT the same as "the button is down": a press that landed on a panel never
   * starts one, and a drag that began on the canvas survives the cursor
   * crossing a panel.
   */
  readonly leftDragging: boolean;
  readonly rightDragging: boolean;

  /**
   * Scroll notches this frame, positive up. Zero when the wheel did not move.
   *
   * A NUMBER, not a boolean plus a direction, because `zoomAtPixel` takes
   * notches and a fast flick is worth more than one.
   */
  readonly scroll: number;

  /**
   * Physical key codes currently held (`KeyW`, `KeyA`, ...).
   *
   * **`KeyboardEvent.code`, not `.key`** -- the port reads WASD as physical
   * positions, so the same keys work on AZERTY and Dvorak. `.key` would give
   * `z` where `w` sits on a French layout, and the pan would go sideways.
   *
   * HELD, not pressed: continuous motion for as long as the key is down. See
   * `applyCameraKeys` for why these deliberately bypass the hotkey table.
   */
  readonly keysHeld: ReadonlySet<string>;
}

/**
 * No input at all. The first frame's value, and what a headless driver passes.
 *
 * `dt: 0` is load-bearing rather than a placeholder: `applyCameraKeys` returns
 * early on a non-positive `dt`, so a frame with no measured delta cannot move
 * the camera by an unscaled step. The desktop guards the same way
 * (`orchestrator.py:447-448`).
 */
export const EMPTY_INPUT: InputState = Object.freeze({
  mousePos: Object.freeze([0, 0]) as readonly [number, number],
  dt: 0,
  leftPressed: false,
  rightPressed: false,
  leftDragging: false,
  rightDragging: false,
  scroll: 0,
  keysHeld: Object.freeze(new Set<string>()),
});
