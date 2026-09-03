/**
 * Drawing: translating mouse gestures into strokes on the user-drawn field.
 *
 * A port of the deciding half of `orchestrator/drawing_commands.py` (132 lines),
 * since extended with the line tool. The field itself -- texture, shader,
 * blending -- lives in `strafeField/`. This is the half that decides WHEN to
 * paint and WHERE, which is the Orchestrator's job, because it is the only thing
 * that can see the camera, the input snapshot and the field at once.
 *
 * STROKE CONTINUITY
 * A stroke is a chain of segments, one per rendered frame, each running from
 * where the cursor was last frame to where it is now. `strokePrevUv` is that
 * memory, and clearing it on button release is what makes the next press start a
 * fresh stroke rather than drawing a line from wherever the last one ended.
 *
 * CADENCE
 * Once per RENDERED frame, never per physics sub-step. The physics loop runs 30
 * times a frame by default; painting inside it would make the brush 30x stronger
 * and would couple stroke weight to the simulation rate, so that moving the
 * Physics Rate slider changed how hard you were drawing.
 *
 * A pure function that takes the stroke memory in and hands it back, rather than
 * a mixin reaching through `self`. That is what makes the two asymmetries below
 * testable without a DOM or a GPU -- and both of them fail silently.
 */

import type { InputState } from '../ui/inputState.ts';

/** One frame's segment: where the brush is, where it was, and what it does. */
export interface PendingStroke {
  readonly uv: readonly [number, number];
  readonly prevUv: readonly [number, number];
  readonly erasing: boolean;
  /**
   * True for a committed LINE, false for one frame of a freehand drag.
   *
   * The only thing downstream reads it for is `lineGain` -- a line deposits once
   * where a drag deposits every frame, so without a boost the same gesture reads
   * as a faint ghost. The shader itself cannot tell the two apart, and should
   * not: a segment is a segment.
   */
  readonly isLine: boolean;
}

/** `strokeFor`'s answer: the segment to paint, and the memory for next frame. */
export interface StrokeStep {
  readonly stroke: PendingStroke | null;
  /** `null` ends the stroke, so the next press starts a fresh one. */
  readonly prevUv: readonly [number, number] | null;
  /**
   * The line tool's anchor for next frame, or `null` for "no line pending".
   *
   * Carried through the same way `prevUv` is, and for the same reason: this
   * function is pure, so all of its memory has to travel in and back out.
   */
  readonly lineAnchor: readonly [number, number] | null;
}

/**
 * The line tool's state between frames.
 *
 * Held by the Orchestrator, threaded through `strokeFor`. `null` means no line
 * is pending -- either Shift is up, or a drag is in progress and has suppressed
 * it.
 */
export type LineAnchor = readonly [number, number] | null;

/**
 * Decide what this frame paints.
 *
 * `toFieldUv` converts a screen pixel to field uv -- injected rather than
 * imported so this stays pure; the Orchestrator supplies the one that composes
 * `screenToWorld` with the FIELD's own size.
 *
 * Reads `*Dragging` rather than `*Held`: a drag belongs to whoever received the
 * press, so a stroke that began on the canvas survives the cursor crossing a
 * panel, and a press that landed on a panel never starts one. That is the same
 * reason navigation uses it.
 *
 * ## THE LINE TOOL, AND WHY DRAGGING WINS
 *
 * Holding Shift arms a line: the cursor's position at that moment becomes an
 * anchor, and the next press commits a single stroke from there to wherever the
 * cursor is. Between those two events the Orchestrator draws a half-opacity
 * preview, which is why the anchor is returned rather than kept here.
 *
 * **A DRAG IN PROGRESS SUPPRESSES ALL OF IT.** If the button is already down
 * when Shift goes down, the user is mid-stroke and freehand painting continues
 * unchanged; the anchor is only taken once that drag ends. Any other rule would
 * have Shift hijack a stroke someone is in the middle of making -- and the
 * modifier is easy to hit by accident while reaching for a neighbouring key.
 */
export function strokeFor(
  state: InputState,
  strokePrevUv: readonly [number, number] | null,
  toFieldUv: (pixel: readonly [number, number]) => readonly [number, number],
  lineAnchor: LineAnchor = null,
): StrokeStep {
  const drawing = state.leftDragging;
  // LEFT WINS when both buttons are down, so a stray right-click mid-stroke
  // cannot punch a hole in what is being painted.
  const erasing = state.rightDragging && !drawing;
  const uv = toFieldUv(state.mousePos);

  // ---- the line tool -----------------------------------------------------
  // Checked BEFORE the freehand branch, because a committed line is a press and
  // the freehand branch would otherwise treat that same press as the first frame
  // of a new drag.
  if (state.shift) {
    if (lineAnchor === null) {
      // ARMING. The anchor is taken the moment Shift goes down -- but NOT while a
      // drag is running, or Shift would seize a stroke in progress. The anchor is
      // then taken when that drag ends, on the first frame Shift is down and no
      // button is held, which is exactly this branch.
      //
      // EITHER BUTTON SUPPRESSES IT, not just the left: a right-drag is an erase
      // in progress and has the same claim to not being hijacked mid-gesture.
      if (drawing || erasing) {
        return { stroke: null, prevUv: uv, lineAnchor: null };
      }
      return { stroke: null, prevUv: null, lineAnchor: uv };
    }

    // ARMED. A press COMMITS the line, anchor -> cursor, in one segment.
    //
    // ON PRESS, not on release: the press is the moment the user has chosen the
    // endpoint, and waiting for the release would let them drag the endpoint
    // after committing to it.
    //
    // **BOTH BUTTONS COMMIT, and the button decides whether the line draws or
    // erases** -- the same left/right split the freehand brush already has, so
    // the line tool is a modifier on the gesture rather than a separate mode with
    // its own rules. Erasing a straight corridor through a painted field is
    // exactly as useful as drawing one.
    const pressed = state.leftPressed || state.rightPressed;
    if (pressed) {
      return {
        stroke: {
          uv,
          prevUv: lineAnchor,
          // LEFT WINS if somehow both arrive on one frame, matching the freehand
          // rule directly above.
          erasing: !state.leftPressed,
          isLine: true,
        },
        // `prevUv` STAYS NULL so the press that committed this line does not also
        // seed a freehand drag from the same point. Without this, holding the
        // button after committing would smear a second stroke out of the endpoint.
        prevUv: null,
        // POLYLINE: the endpoint becomes the next anchor, so a run of clicks
        // draws a connected path. Chaining is the behaviour every vector tool
        // has, and re-arming from scratch would make a three-segment path take
        // six gestures.
        lineAnchor: uv,
      };
    }

    // Armed and waiting. The Orchestrator previews `lineAnchor -> cursor`.
    return { stroke: null, prevUv: null, lineAnchor };
  }

  // Shift is up: DISCARD THE ANCHOR. Releasing Shift without clicking abandons
  // the line, and the preview vanishes with it -- there is no half-committed
  // state.
  if (!drawing && !erasing) {
    return { stroke: null, prevUv: null, lineAnchor: null };
  }

  // FIRST FRAME OF A STROKE: the segment collapses to a point, which is exactly
  // the right splat -- `dist_to_stroke`'s degenerate branch handles it. Seeding
  // from the CURRENT position is what prevents a phantom streak across the
  // canvas from wherever the previous stroke ended, which was a real bug in the
  // reference implementation. Seeding from the origin would streak from the
  // middle of the world instead, which is the same bug wearing a different hat.
  const prevUv = strokePrevUv ?? uv;

  return {
    stroke: { uv, prevUv, erasing, isLine: false },
    prevUv: uv,
    lineAnchor: null,
  };
}
