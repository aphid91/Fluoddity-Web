/**
 * Packing the camera passes' uniform buffers.
 *
 * Follows `particleSystem/uniforms.ts`: vec4-only lanes, ints written through
 * an `Int32Array` view onto the same `ArrayBuffer` and read back with
 * `bitcast<i32>`. Read that file's header for why uniform and storage layouts
 * agree here by construction (the vec4-only rule) and why there is exactly one
 * int-packing convention.
 *
 * ## THESE STRUCTS DO NOT START WITH `WorldData`, AND THAT IS DELIBERATE
 *
 * Every struct in `particleSystem/uniforms.ts` embeds `WorldData` at offset 0,
 * because those shaders call `world_trail_persistence`, `world_bc` and friends.
 * The camera shaders call NONE of them:
 *
 *   camera.wgsl     screen_ndc_to_canvas_uv, CANVAS_VALUE_SCALE
 *   camBrush.wgsl   world_to_screen_ndc, e_pos/e_vel/e_size/e_col_params
 *   accumulate.wgsl nothing from common.wgsl at all
 *
 * `camera/camera.py:36-37` states the rule this follows: "Camera holds no
 * simulation state: the entity buffer and canvas texture are handed to it per
 * frame by the Orchestrator." Embedding 32 unused bytes would mean importing
 * `WorldConfig` into `src/camera/`, coupling the camera to the simulation's
 * config type for zero benefit -- which is ARCHITECTURE.md rule 3 pointing the
 * other way. Do not "fix" this to match the engine's structs.
 *
 * ## The View block
 *
 * What these structs share instead is the four values `_set_view_uniforms`
 * pushes (`camera.py:292-298`), packed into 32 bytes:
 *
 *   +0   canvas_res : vec4f   xy canvas size, zw window size
 *   +16  camera     : vec4f   xy pan, z zoom, w reserved
 *
 * Both camera modes read the identical block, which is what makes them agree
 * pixel-for-pixel about where a world point lands (invariant 9). The assembler
 * gets the same four values for the same reason -- its overlays must land on
 * the world, not on the glass.
 */

/** The view half of every camera uniform: sizes, pan and zoom. */
export interface CameraView {
  readonly canvasSize: readonly [number, number];
  readonly windowSize: readonly [number, number];
  readonly pan: readonly [number, number];
  readonly zoom: number;
}

/**
 * `CameraViewUniforms` -- 48 bytes.
 *
 *   canvas_res : vec4f  (16)  offset 0
 *   camera     : vec4f  (16)  offset 16
 *   flags      : vec4f  (16)  offset 32   reserved; TRAIL has no int state
 *
 * The flags lane is kept although nothing uses it: every other struct in the
 * project has one, so its absence would read as an oversight rather than as a
 * fact about TRAIL mode.
 */
export const CAMERA_VIEW_UNIFORM_SIZE = 48;

/** `AccumulateUniforms` -- 16 bytes. `params: vec4f`, x = inv_samples. */
export const ACCUMULATE_UNIFORM_SIZE = 16;

function writeView(f32: Float32Array, view: CameraView): void {
  f32[0] = view.canvasSize[0];
  f32[1] = view.canvasSize[1];
  f32[2] = view.windowSize[0];
  f32[3] = view.windowSize[1];
  f32[4] = view.pan[0];
  f32[5] = view.pan[1];
  f32[6] = view.zoom;
  // f32[7] reserved
}

/** Pack the TRAIL present pass's uniforms. */
export function packCameraViewUniforms(view: CameraView): ArrayBuffer {
  const buffer = new ArrayBuffer(CAMERA_VIEW_UNIFORM_SIZE);
  writeView(new Float32Array(buffer), view);
  return buffer;
}

/**
 * Pack the accumulation pass's uniforms.
 *
 * `samples` MUST be the ACHIEVED count from `blurSchedule`, never the count the
 * user requested. `accumulate.frag:19-23` is emphatic about this and so is the
 * port plan: the two disagree at some slider positions and not others, so
 * weighting by the request darkens the image only sometimes -- a miserable bug
 * to find by eye.
 *
 * A zero or negative count yields 1.0 rather than Infinity. The desktop's
 * `1.0 / max(1, int(samples))` (`camera.py:149`) does the same, and the reason
 * is the same: `begin_frame` must tolerate a stray call before a real cycle
 * opens without poisoning the buffer with a non-finite weight.
 */
export function packAccumulateUniforms(samples: number): ArrayBuffer {
  const buffer = new ArrayBuffer(ACCUMULATE_UNIFORM_SIZE);
  const f32 = new Float32Array(buffer);
  f32[0] = 1.0 / (Math.max(1, Math.trunc(samples)) || 1);
  return buffer;
}
