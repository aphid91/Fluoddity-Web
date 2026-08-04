/**
 * Drawing: translating mouse gestures into strokes on the strafe field.
 *
 * A port of the deciding half of `orchestrator/drawing_commands.py` (132 lines).
 * The field itself -- texture, shader, blending -- lives in `strafeField/`. This
 * is the half that decides WHEN to paint and WHERE, which is the Orchestrator's
 * job, because it is the only thing that can see the camera, the input snapshot
 * and the field at once.
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

/** One frame's segment: where the brush is, where it was, and which tool. */
export interface PendingStroke {
  readonly uv: readonly [number, number];
  readonly prevUv: readonly [number, number];
  readonly erasing: boolean;
}

/** `strokeFor`'s answer: the segment to paint, and the memory for next frame. */
export interface StrokeStep {
  readonly stroke: PendingStroke | null;
  /** `null` ends the stroke, so the next press starts a fresh one. */
  readonly prevUv: readonly [number, number] | null;
}

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
 */
export function strokeFor(
  state: InputState,
  strokePrevUv: readonly [number, number] | null,
  toFieldUv: (pixel: readonly [number, number]) => readonly [number, number],
): StrokeStep {
  const drawing = state.leftDragging;
  // LEFT WINS when both buttons are down, so a stray right-click mid-stroke
  // cannot punch a hole in what is being painted.
  const erasing = state.rightDragging && !drawing;

  if (!drawing && !erasing) {
    return { stroke: null, prevUv: null };
  }

  const uv = toFieldUv(state.mousePos);
  // FIRST FRAME OF A STROKE: the segment collapses to a point, which is exactly
  // the right splat -- `dist_to_stroke`'s degenerate branch handles it. Seeding
  // from the CURRENT position is what prevents a phantom streak across the
  // canvas from wherever the previous stroke ended, which was a real bug in the
  // reference implementation. Seeding from the origin would streak from the
  // middle of the world instead, which is the same bug wearing a different hat.
  const prevUv = strokePrevUv ?? uv;

  return { stroke: { uv, prevUv, erasing }, prevUv: uv };
}
