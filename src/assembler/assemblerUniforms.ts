/**
 * Packing the assembler's uniform buffers.
 *
 * Same conventions as `camera/cameraUniforms.ts` -- read that file's header for
 * why these structs do not embed `WorldData`, and `particleSystem/uniforms.ts`
 * for the int-in-a-float-lane idiom.
 *
 * ## THE SWITCHES LIVE IN THE VALUES
 *
 * `assembler.py:102-109` and `:123-132` push the on/off decision INTO the
 * numbers: bloom off writes `bloom_intensity = 0.0`, and the shader's
 * `if (bloom_intensity > 0.0)` then skips the fetch entirely, so a stale
 * sampler binding is harmless. Same for `field_opacity` and `reticle_radius`.
 *
 * The desktop's motivation was that a stale GL sampler costs nothing when it is
 * never fetched. The port has a stronger one: WebGPU validates a bind group
 * whether or not the shader reads it, so those slots carry a 1x1 dummy texture
 * (see `assembler.ts`) and the zero is what guarantees the dummy is never
 * sampled for real. It is also what keeps `fwidth` legal in
 * `frameAssembly.wgsl` -- the derivative calls sit inside branches on these
 * uniforms, so control flow at them is uniform. Do not move these decisions
 * into the shader.
 */

import type { CameraView } from '../camera/cameraUniforms.ts';
import type { DisplayPreferences } from '../prefs/preferences.ts';

/** `BloomDownsampleUniforms` -- 16 bytes. */
export const BLOOM_DOWNSAMPLE_UNIFORM_SIZE = 16;

/** `BloomUpsampleUniforms` -- 16 bytes. */
export const BLOOM_UPSAMPLE_UNIFORM_SIZE = 16;

/**
 * `FrameAssemblyUniforms` -- 96 bytes.
 *
 *   canvas_res : vec4f  (16)  offset 0    xy canvas, zw window
 *   camera     : vec4f  (16)  offset 16   xy pan, z zoom
 *   tone       : vec4f  (16)  offset 32   x bloom_intensity  y brightness
 *                                         z tonemap_softness w field_opacity
 *   reticle    : vec4f  (16)  offset 48   xy center  z radius
 *   flags      : vec4f  (16)  offset 64   x reticle_dashed(i)
 *   reserved   : vec4f  (16)  offset 80
 *
 * The trailing reserved lane is room for Step 9's field state and Step 10's
 * reticle state to land without churning the bind group layout.
 */
export const FRAME_ASSEMBLY_UNIFORM_SIZE = 96;

/**
 * Pack one bloom downsample level.
 *
 * `texel` is `1 / SOURCE resolution` -- the level being read, not the level
 * being written (`bloom.py:113,121`, which takes `src.size`). Reversing them
 * halves the effective filter width and looks like a tuning difference.
 *
 * `applyThreshold` is true for the FIRST pass only: that is where the bloom
 * source is separated from the image, and every later mip is just blurring what
 * came out of it. Re-applying it would eat the glow it was meant to spread.
 */
export function packBloomDownsampleUniforms(
  texel: readonly [number, number],
  threshold: number,
  applyThreshold: boolean,
): ArrayBuffer {
  const buffer = new ArrayBuffer(BLOOM_DOWNSAMPLE_UNIFORM_SIZE);
  const f32 = new Float32Array(buffer);
  const i32 = new Int32Array(buffer);
  f32[0] = texel[0];
  f32[1] = texel[1];
  f32[2] = threshold;
  i32[3] = applyThreshold ? 1 : 0;
  return buffer;
}

/** Pack one bloom upsample level. `texel` is the lower-res SOURCE's. */
export function packBloomUpsampleUniforms(
  texel: readonly [number, number],
  radius: number,
): ArrayBuffer {
  const buffer = new ArrayBuffer(BLOOM_UPSAMPLE_UNIFORM_SIZE);
  const f32 = new Float32Array(buffer);
  f32[0] = texel[0];
  f32[1] = texel[1];
  f32[2] = radius;
  return buffer;
}

/** The overlay state the assembler is handed, already decided by the caller. */
export interface OverlayState {
  /**
   * Whether the field overlay belongs on screen AT ALL. Depends on the active
   * tool, which is the Orchestrator's to know -- `assembler.py:80-86`. Step 5
   * always passes false; Step 9 wires it.
   */
  readonly showField: boolean;
  /** Cursor in canvas uv. */
  readonly reticleCenter: readonly [number, number];
  /** The brush's visible extent, aspect-corrected. Zero means no reticle. */
  readonly reticleRadius: number;
  /** Dashed distinguishes SHOVE from DRAW; both share one brush and reticle. */
  readonly reticleDashed: boolean;
}

/** No overlays -- what Step 5 passes until Steps 8 and 9 provide the state. */
export const NO_OVERLAYS: OverlayState = {
  showField: false,
  reticleCenter: [0.0, 0.0],
  reticleRadius: 0.0,
  reticleDashed: false,
};

/**
 * Pack the frame assembly pass's uniforms.
 *
 * `bloomAvailable` is whether the mip chain actually produced a texture this
 * frame -- `bloom.process()` returns null when its shaders failed to compile,
 * which `assembler.py:92-95,104` reads as "no bloom this frame" rather than as
 * an error. Both that and the preference must be true for a non-zero intensity.
 */
export function packFrameAssemblyUniforms(
  view: CameraView,
  prefs: DisplayPreferences,
  bloomAvailable: boolean,
  overlays: OverlayState,
): ArrayBuffer {
  const buffer = new ArrayBuffer(FRAME_ASSEMBLY_UNIFORM_SIZE);
  const f32 = new Float32Array(buffer);
  const i32 = new Int32Array(buffer);

  // canvas_res + camera: the SAME four values the camera pushed, so the
  // overlays land exactly where the image did (invariant 9).
  f32[0] = view.canvasSize[0];
  f32[1] = view.canvasSize[1];
  f32[2] = view.windowSize[0];
  f32[3] = view.windowSize[1];
  f32[4] = view.pan[0];
  f32[5] = view.pan[1];
  f32[6] = view.zoom;

  // tone: x bloom_intensity, y brightness, z tonemap_softness, w field_opacity
  const bloomOn = prefs.bloomEnabled && prefs.bloomIntensity > 0.0 && bloomAvailable;
  f32[8] = bloomOn ? prefs.bloomIntensity : 0.0;
  f32[9] = prefs.brightness;
  // Clamped to >= 0 HERE rather than in the shader: `asinh_f32` uses the
  // non-negative form `log(x + sqrt(x*x+1))`, which is only asinh for x >= 0.
  // `preferences.py` enforces no lower bound, so the guard has to live
  // somewhere -- and the host is where a clamp is free.
  f32[10] = Math.max(0.0, prefs.tonemapSoftness);
  f32[11] = overlays.showField ? Math.max(0.0, prefs.fieldOpacity) : 0.0;

  // reticle: xy center, z radius, w reserved
  f32[12] = overlays.reticleCenter[0];
  f32[13] = overlays.reticleCenter[1];
  f32[14] = overlays.reticleRadius;

  // flags: x reticle_dashed(i), yzw reserved
  i32[16] = overlays.reticleDashed ? 1 : 0;

  return buffer;
}
