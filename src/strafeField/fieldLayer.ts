/**
 * The two halves of the user-drawn field, and the brush modes that write them.
 *
 * A leaf beside `fieldSize.ts`, and a leaf for the same reason: these are the
 * value types that the field module, the Orchestrator, the UI and the brush
 * uniforms all have to agree about, and none of that agreement needs a GPU. The
 * shader's numbering is HERE, in one table, rather than restated as magic
 * integers at each site that packs a uniform.
 */

/**
 * Which channel pair a stroke writes.
 *
 * The field texture is `rgba16float` (see `FIELD_FORMAT`) and the two layers are
 * independent in every operation that touches it -- drawing, erasing, clearing
 * and displaying. `LAYER_WRITE_MASK` is what keeps them that way on the GPU.
 *
 * WHY THE TWO LAYERS DIFFER IN WHAT THEY MEAN, not just where they live:
 *
 *   walls  -- read by `get_walls`, added to POSITION. Advection: no rule can
 *             resist it and drag never damps it.
 *   trails -- read by `get_can`, added to the CANVAS SAMPLE the sensors see. It
 *             changes what a particle THINKS is there, so the rule decides what
 *             to do about it. Painted trails therefore steer; painted walls
 *             shove.
 */
export const FIELD_LAYERS = ['walls', 'trails'] as const;
export type FieldLayer = (typeof FIELD_LAYERS)[number];

/**
 * The colour write mask that confines a pass to one layer's channels.
 *
 * **THIS IS WHAT MAKES ERASE AND CLEAR LAYER-SCOPED.** Both write literal values
 * with blending off, so without a mask either one would clobber all four
 * channels -- erasing walls would silently take the trails with it. Drawing is
 * additively blended and a zero contribution to the other pair would be a no-op,
 * but the mask is applied to the draw pipelines too: relying on "adding zero
 * changes nothing" is an arithmetic accident, and it stops being true the moment
 * a NaN reaches the other pair.
 *
 * GPUColorWrite.RED|GREEN is 0x1|0x2; BLUE|ALPHA is 0x4|0x8. Spelled as literals
 * because `GPUColorWrite` is a runtime global that does not exist under Node,
 * where this module's tests run.
 */
export const LAYER_WRITE_MASK: Readonly<Record<FieldLayer, number>> = {
  walls: 0x1 | 0x2,
  trails: 0x4 | 0x8,
};

/**
 * Which of the four channels a layer occupies, as a shader-side selector.
 *
 * `strafeDraw.wgsl` builds a `vec4f` and lets the write mask discard the half it
 * does not own, so it needs to know which half to put the vector in. 0 = rg,
 * 1 = ba. Read by `bitcast<i32>` out of a uniform lane, matching how every other
 * int crosses this boundary (invariant 7).
 */
export const LAYER_INDEX: Readonly<Record<FieldLayer, number>> = {
  walls: 0,
  trails: 1,
};

/**
 * How a stroke decides which way its vectors point.
 *
 * All four share the brush's gaussian kernel, its radius and its power -- they
 * differ ONLY in the direction assigned to each texel, which is why this is a
 * mode on one shader rather than four shaders. `strafeDraw.wgsl`'s `fs_main`
 * branches on it once, on a uniform, and everything around the branch is common.
 *
 *   diverge -- away from the stroke. The original and only behaviour, so it is
 *              the default in every tool and the name is new, not the shape.
 *   converge -- toward the stroke. Literally `-diverge`.
 *   stroke  -- along the direction of travel, NORMALIZED. Magnitude comes from
 *              Brush Power alone, so a fast drag and a slow one paint equally
 *              hard and the result does not depend on the frame rate.
 *   fixed   -- one direction everywhere, from the Draw Angle preference.
 *
 * **MEMBER ORDER IS THE SHADER'S NUMBERING** and the dropdown's order, the same
 * way `MOUSE_MODES` is the toolbar's. `BRUSH_MODE_INDEX` is derived from it
 * rather than written out, so the two cannot disagree.
 */
export const BRUSH_MODES = ['diverge', 'converge', 'stroke', 'fixed'] as const;
export type BrushMode = (typeof BRUSH_MODES)[number];

/** The shader's integer for a mode. Derived from the array, never restated. */
export const BRUSH_MODE_INDEX: Readonly<Record<BrushMode, number>> = Object.fromEntries(
  BRUSH_MODES.map((mode, index) => [mode, index]),
) as Record<BrushMode, number>;

/**
 * How much harder a committed LINE deposits than one frame of a freehand drag.
 *
 * ## Why a line needs compensating at all
 *
 * A freehand stroke is painted once per RENDERED FRAME, so dragging across a spot
 * at 60fps lays down dozens of overlapping gaussians and the result builds up.
 * The line tool commits its whole segment in ONE pass. Without a boost, drawing a
 * line between two points produces a visibly fainter mark than tracing the same
 * path by hand -- which reads as the line tool being broken rather than as a
 * difference in deposition.
 *
 * ## Why it is a flat constant and not a real integral
 *
 * The honest compensation is "however many frames the hand-drawn equivalent would
 * have taken", which depends on how fast the user moves and on the frame rate --
 * neither of which the line tool has any business consulting. It would also make
 * an identical line deposit differently on a slow machine.
 *
 * So this is deliberately modest and length-independent: enough that a line reads
 * as a deliberate mark of the same family as a drawn one, without trying to match
 * a gesture that was never made. Tuned by eye; Brush Power remains the control
 * for how hard a line actually lands.
 */
export const LINE_STROKE_GAIN = 1.0;

/** Look up a brush mode by string value, or `null` if unknown. */
export function brushModeFromValue(value: string): BrushMode | null {
  return (BRUSH_MODES as readonly string[]).includes(value) ? (value as BrushMode) : null;
}

/** Look up a field layer by string value, or `null` if unknown. */
export function fieldLayerFromValue(value: string): FieldLayer | null {
  return (FIELD_LAYERS as readonly string[]).includes(value) ? (value as FieldLayer) : null;
}
