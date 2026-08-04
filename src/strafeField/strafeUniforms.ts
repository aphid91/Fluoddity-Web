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

/**
 * `StrafeDrawUniforms` -- 48 bytes.
 *
 *   field_res : vec4f  (16)  offset 0   xy: FIELD resolution   zw: reserved
 *   stroke    : vec4f  (16)  offset 16  xy: mouse uv   zw: previous mouse uv
 *   brush     : vec4f  (16)  offset 32  x: draw_size  y: draw_power
 *                                       z: erase_mode(i)  w: reserved
 */
export const STRAFE_DRAW_UNIFORM_SIZE = 48;

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
 * selects the shader's zero-writing branch (the BLEND STATE is per-pipeline and
 * is not carried here -- see `strafeField.ts`).
 */
export function packStrafeDrawUniforms(
  fieldRes: readonly [number, number],
  uv: readonly [number, number],
  prevUv: readonly [number, number],
  drawSize: number,
  drawPower: number,
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
  // fast drag (`strafe_draw.frag:37-41`).
  f32[4] = uv[0];
  f32[5] = uv[1];
  f32[6] = prevUv[0];
  f32[7] = prevUv[1];

  // brush: x sigma, y power, z erase_mode(i), w reserved
  f32[8] = drawSize;
  f32[9] = drawPower;
  i32[10] = erase ? 1 : 0;

  return buffer;
}
