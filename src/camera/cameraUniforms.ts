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

/**
 * How many slots ride the cam-brush uniform's appearance table.
 *
 * MUST EQUAL `SLOT_COUNT` in `sand/palette.ts` and `SWATCH_COLOR_COUNT` in
 * `camBrush.wgsl`. Not imported from the palette: this module is the camera's,
 * and the camera has no business depending on the sand modality's palette --
 * the number is a property of the uniform's LAYOUT, which is this file's
 * subject. `shaders.test.ts` asserts all three agree, which is what keeps them
 * from drifting without creating the dependency.
 */
export const CAM_BRUSH_SWATCH_COUNT = 40;

/**
 * `CamBrushUniforms` -- 704 bytes.
 *
 *   canvas_res : vec4f  (16)  offset 0
 *   camera     : vec4f  (16)  offset 16
 *   sprite     : vec4f  (16)  offset 32   x size  y alpha  z unused
 *   flags      : vec4f  (16)  offset 48   x color_mode(i)
 *                                         y highlighted cohort (f32, <0 = none)
 *   swatches   : array<vec4f, 40>  (640)  offset 64
 *                                         xy hue, saturation
 *                                         z  color_sensitivity
 *                                         w  color_offset
 *
 * ## The table is PER-SLOT APPEARANCE, not just colour
 *
 * All four lanes are now data. The two spares were documented as padding when
 * the table held only hue and saturation; sensitivity and offset claimed them
 * when appearance became per-config, which is what the 16-byte stride was
 * costing us anyway (see below) and is why the struct did not grow a byte.
 *
 * SENSITIVITY USED TO BE A SINGLE `sprite.z` FOR THE WHOLE FRAME, read from the
 * master slot. That made the master's Color Sensitivity govern every material
 * on screen and every other slot's copy a silent no-op -- an author could drag
 * the knob on the square they were editing and watch nothing happen. Both
 * coefficients are per-slot now, looked up by the particle's own `config_index`
 * exactly as its hue already was, so a slot's appearance settings describe that
 * slot's particles and nothing else. `sprite.z` is left unwritten rather than
 * reused, so a stale reader gets 0.0 instead of a plausible wrong number.
 *
 * ## Why the table is 16 bytes per entry
 *
 * A uniform array's element stride is rounded up to 16 in WGSL's layout rules,
 * so an `array<vec2f, 40>` would occupy the same 640 bytes while declaring a
 * stride the implementation does not use. Declaring `vec4f` makes the shape
 * honest -- and left exactly the room this needed.
 *
 * 704 bytes is comfortably inside the 64KiB minimum guaranteed uniform binding
 * size, so this needs no storage-buffer promotion.
 */
export const CAM_BRUSH_UNIFORM_SIZE = 64 + CAM_BRUSH_SWATCH_COUNT * 16;

/** Where the appearance table starts, in floats. The one place that knows it. */
const SWATCH_FLOAT_BASE = 16;

/** `AccumulateUniforms` -- 16 bytes. `params: vec4f`, x = inv_samples. */
export const ACCUMULATE_UNIFORM_SIZE = 16;

/**
 * Quad size relative to the entity's own size, in PARTICLES mode.
 * `camera.py:52`.
 */
export const SPRITE_SIZE = 1.5;

/**
 * Per-particle brightness. Low because thousands of sprites accumulate.
 *
 * A bare constant on the desktop (`camera.py:53-56`) *because* brightness is
 * the assembler's job, applied once to the finished frame, so both camera modes
 * answer to it the same way. Kept as a host constant written into the uniform
 * rather than a WGSL `const` for the same reason: it is a property of the
 * camera, not of the shader, and it stays visible to the debug readout.
 */
export const PARTICLE_ALPHA = 0.045;

/** Write the 32-byte View block at offset 0. The one place that knows it. */
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
 * Everything the renderer needs to know about how ONE slot looks.
 *
 * Hue and saturation are the swatch's authored colour, read in Swatch mode.
 * Sensitivity and offset are the coefficient A and bias B in
 * `hue = A * signal + B`, read in the two signal modes. All four travel
 * together because they are looked up by the same index at the same moment --
 * splitting them into parallel arrays would let one fall out of step with the
 * other over the slot it describes.
 *
 * STRUCTURALLY TYPED and declared here rather than imported from
 * `sand/palette.ts`, for the reason `CAM_BRUSH_SWATCH_COUNT` gives: the camera
 * does not depend on the sand modality. The caller passes objects that happen
 * to have these fields.
 */
export interface SwatchAppearance {
  readonly hue: number;
  readonly saturation: number;
  readonly colorSensitivity: number;
  readonly colorOffset: number;
}

/**
 * Pack the PARTICLES pass's uniforms.
 *
 * `colorMode` arrives as an ARGUMENT rather than being read from the config
 * buffer, which belongs to ParticleSystem: it is a DISPLAY input, and it must
 * take effect immediately -- including while paused, when nothing is stepping
 * the physics. See `cam_brush.frag:26-30`.
 *
 * `swatches` is the per-slot appearance table and arrives the same way, for the
 * same reason. IT IS INDEXED BY `config_index`, so entry `i` describes the
 * particles painted from slot `i` and no others. This is what replaced the
 * single frame-wide sensitivity the desktop took (`camera.py:155-157`) -- see
 * the size constant on why that one was wrong.
 *
 * `highlightedCohort` is the cohort the mouse is resting on, or negative for
 * none -- `selection/cohortHighlight.ts` decides it and `NO_COHORT` is its spelling
 * of "none". A DISPLAY input like the others and arriving the same way: the
 * highlight must appear and clear immediately, and anything routed through the
 * config buffer would wait for a physics step.
 *
 * A PLAIN FLOAT LANE, not an int and not a bool-plus-value pair. Cohorts are
 * non-negative, so the sentinel fits in the same lane, and a second lane could
 * only ever disagree with this one. Defaulted so the callers that have no
 * highlight to report -- and the tests -- need not thread it through.
 */
export function packCamBrushUniforms(
  view: CameraView,
  colorMode: number,
  highlightedCohort = -1,
  swatches: readonly SwatchAppearance[] = [],
): ArrayBuffer {
  const buffer = new ArrayBuffer(CAM_BRUSH_UNIFORM_SIZE);
  const f32 = new Float32Array(buffer);
  const i32 = new Int32Array(buffer);

  writeView(f32, view);

  // sprite: x size, y alpha, zw unused.
  //
  // `z` HELD THE FRAME-WIDE COLOUR SENSITIVITY and is deliberately left at
  // zero now that sensitivity is per-slot. Left unwritten rather than reused:
  // if anything is still reading it, zero is a value that visibly does nothing
  // rather than a plausible number from an unrelated setting.
  f32[8] = SPRITE_SIZE;
  f32[9] = PARTICLE_ALPHA;

  // flags: x color_mode(i), y highlighted_cohort(f32), zw reserved
  //
  // AN INT LANE, as `color_by_cohort` was before it. The shader bitcasts it
  // back, so writing the mode as a float would be read as a huge integer and
  // match no mode -- landing on the `else` branch and rendering every particle
  // in Behavior regardless of the dropdown.
  i32[12] = colorMode;
  f32[13] = highlightedCohort;

  // The appearance table. A caller with fewer entries than slots leaves the
  // rest at zero -- black with no signal response, which is what an unpainted
  // material would render as anyway and is never reached: a particle can only
  // carry the index of a slot it was painted from. Extra entries past the table
  // are DROPPED rather than overflowing into whatever follows.
  const count = Math.min(swatches.length, CAM_BRUSH_SWATCH_COUNT);
  for (let i = 0; i < count; i++) {
    const swatch = swatches[i];
    if (swatch === undefined) continue;
    const base = SWATCH_FLOAT_BASE + i * 4;
    f32[base + 0] = swatch.hue;
    f32[base + 1] = swatch.saturation;
    f32[base + 2] = swatch.colorSensitivity;
    f32[base + 3] = swatch.colorOffset;
  }

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
