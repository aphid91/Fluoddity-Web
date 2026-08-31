/**
 * Packing `strafeDraw.wgsl`'s uniform buffer.
 *
 * The desktop sets these as loose GLSL uniforms through moderngl's `tryset`, one
 * member at a time (`strafe_field.py:205-209`). WebGPU has no such path: a
 * uniform is a buffer, so the pass gets one struct and one `writeBuffer`.
 *
 * ## WHY THIS IS NOT IN particleSystem/uniforms.ts
 *
 * Every struct there begins with `WorldData` at offset 0, and `withWorld` is the
 * one piece of code that knows that layout. `strafeDraw.wgsl` needs none of it --
 * it is a fullscreen brush pass that knows nothing about trail persistence or
 * boundary conditions. Putting a world-less struct in that file would mean either
 * a second construction idiom there or a `WorldData` prefix carried for nothing.
 *
 * What IS shared with that file is the convention, and this follows it exactly:
 * vec4 members only (so the uniform and storage address spaces agree by
 * construction), and ints bit-punned through an `Int32Array` view onto the same
 * `ArrayBuffer`, read back with `bitcast<i32>`.
 */

import { BRUSH_MODE_INDEX, LAYER_INDEX, type BrushMode, type FieldLayer } from './fieldLayer.ts';

/**
 * `StrafeDrawUniforms` -- 64 bytes.
 *
 *   field_res : vec4f  (16)  offset 0   xy: FIELD resolution   zw: reserved
 *   stroke    : vec4f  (16)  offset 16  xy: mouse uv   zw: previous mouse uv
 *   brush     : vec4f  (16)  offset 32  x: draw_size  y: draw_power
 *                                       z: erase_mode(i)  w: brush_mode(i)
 *   layer     : vec4f  (16)  offset 48  x: layer_index(i)  y: draw_angle
 *                                       z: line_gain  w: reserved
 *
 * The fourth vec4 is the "add a whole vec4" half of invariant 7 -- `brush` had
 * exactly one spare lane and this addition needed three.
 */
export const STRAFE_DRAW_UNIFORM_SIZE = 64;

/** Everything the brush pass needs that is not geometry. */
export interface BrushParams {
  readonly drawSize: number;
  readonly drawPower: number;
  readonly mode: BrushMode;
  readonly layer: FieldLayer;
  /**
   * Radians, 0 = up (+y in world space). Read only by the `fixed` mode; packed
   * unconditionally because a branch here would save nothing.
   */
  readonly drawAngle: number;
  /**
   * A flat multiplier on the deposited vector, for the LINE TOOL only.
   *
   * A freehand stroke deposits once per rendered frame, so dragging slowly over
   * a spot builds it up. A line commits in ONE pass, so without this an identical
   * line reads as a faint ghost of the hand-drawn equivalent. 1.0 for freehand;
   * `LINE_STROKE_GAIN` for a committed line.
   */
  readonly lineGain: number;
}

/**
 * Pack the airbrush pass's uniforms.
 *
 * ## `fieldRes` IS THE FIELD'S RESOLUTION, NOT THE CANVAS'S
 *
 * The GLSL names this uniform `canvas_resolution` (`strafe_draw.frag:27`) because
 * it shares `aspect_correct_uv` with the assembler, whose copy really is fed the
 * canvas. What it means in the BRUSH shader is "the resolution of the texture I
 * am drawing into" -- the field's, deliberately (`strafe_field.py:144-150`).
 *
 * Renamed here rather than carrying the misnomer across, because the misnomer is
 * the trap: fed the canvas size, `aspect_correct_uv` computes against the wrong
 * ratio and the brush becomes a slight oval. That is invisible at the default 1:1
 * canvas and only appears once `MAX_FIELD_DIM` bites or the aspect is changed --
 * i.e. it would ship.
 *
 * `drawSize` is the gaussian's sigma in the aspect-corrected metric; `erase`
 * selects the shader's zero-writing branch (the BLEND STATE and the COLOUR WRITE
 * MASK are per-pipeline and are not carried here -- see `strafeField.ts`).
 */
export function packStrafeDrawUniforms(
  fieldRes: readonly [number, number],
  uv: readonly [number, number],
  prevUv: readonly [number, number],
  brush: BrushParams,
  erase: boolean,
): ArrayBuffer {
  const buffer = new ArrayBuffer(STRAFE_DRAW_UNIFORM_SIZE);
  const f32 = new Float32Array(buffer);
  const i32 = new Int32Array(buffer);

  // field_res: xy the field's own resolution, zw reserved
  f32[0] = fieldRes[0];
  f32[1] = fieldRes[1];

  // stroke: xy this frame's cursor, zw the previous frame's. A segment, not a
  // point -- painting only the current position visibly breaks into dots on a
  // fast drag (`strafe_draw.frag:37-41`). The LINE TOOL packs its anchor as
  // `prevUv` and its endpoint as `uv`, so one segment covers both gestures and
  // the shader needs no line-versus-freehand branch at all.
  f32[4] = uv[0];
  f32[5] = uv[1];
  f32[6] = prevUv[0];
  f32[7] = prevUv[1];

  // brush: x sigma, y power, z erase_mode(i), w brush_mode(i)
  f32[8] = brush.drawSize;
  f32[9] = brush.drawPower;
  i32[10] = erase ? 1 : 0;
  i32[11] = BRUSH_MODE_INDEX[brush.mode];

  // layer: x layer_index(i), y draw angle, z line gain, w reserved
  i32[12] = LAYER_INDEX[brush.layer];
  f32[13] = brush.drawAngle;
  f32[14] = brush.lineGain;

  return buffer;
}
