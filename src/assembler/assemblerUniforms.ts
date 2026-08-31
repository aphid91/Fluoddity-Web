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
 * `FrameAssemblyUniforms` -- 128 bytes.
 *
 *   canvas_res : vec4f  (16)  offset 0    xy canvas, zw window
 *   camera     : vec4f  (16)  offset 16   xy pan, z zoom
 *   tone       : vec4f  (16)  offset 32   x bloom_intensity  y brightness
 *                                         z tonemap_softness w field_opacity
 *   reticle    : vec4f  (16)  offset 48   xy center  z radius  w draw angle
 *   flags      : vec4f  (16)  offset 64   x reticle_style(i)  y trails_opacity
 *                                         z line_enable  w reserved
 *   crop       : vec4f  (16)  offset 80   xy half-extent  z enable  w dim
 *   capture    : vec4f  (16)  offset 96   xy uv scale  zw uv offset
 *   line       : vec4f  (16)  offset 112  xy anchor  zw cursor (canvas uv)
 *
 * The lane at 80 was reserved for Step 9's field state and Step 10's reticle
 * state; both landed in `tone` and `reticle` instead, and the recording crop box
 * claimed it. `capture` grew the struct once (96 -> 112); the TRAILS overlay and
 * the line tool grew it again (112 -> 128), after first claiming `reticle.w` and
 * two lanes of `flags` -- the "spend the reserved lanes, then add a vec4" order
 * invariant 7 asks for. Keeping this comment and the WGSL struct in step is the
 * whole cost, and `shaders.test.ts` checks both.
 */
export const FRAME_ASSEMBLY_UNIFORM_SIZE = 128;

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

/**
 * How the brush reticle is drawn.
 *
 * The ring itself is the same circle in every style -- what changes is the
 * decoration around it, which says what the brush is about to DO. That is worth
 * more than it sounds: the four brush modes differ only in the direction they
 * deposit, which is invisible until you have already painted something.
 *
 *   plain  -- bare ring. Stroke mode, whose direction is the mouse's own travel
 *             and so is already shown by the cursor moving.
 *   dashed -- Shove. THE ONE STYLE NOT ABOUT A BRUSH MODE: it distinguishes a
 *             different TOOL, and is deliberately unchanged by this feature.
 *   out    -- eight short rays pointing outward. Diverge.
 *   in     -- eight short rays pointing inward. Converge.
 *   fixed  -- one arrow at the Draw Angle, so the direction is readable before
 *             the first stroke rather than after it.
 *
 * **MEMBER ORDER IS THE SHADER'S NUMBERING**, the same convention `BRUSH_MODES`
 * follows. `frameAssembly.wgsl`'s `RETICLE_*` constants are the other half.
 */
export const RETICLE_STYLES = ['plain', 'dashed', 'out', 'in', 'fixed'] as const;
export type ReticleStyle = (typeof RETICLE_STYLES)[number];

/** The shader's integer for a reticle style. Derived, never restated. */
export const RETICLE_STYLE_INDEX: Readonly<Record<ReticleStyle, number>> =
  Object.fromEntries(RETICLE_STYLES.map((s, i) => [s, i])) as Record<ReticleStyle, number>;

/** The overlay state the assembler is handed, already decided by the caller. */
export interface OverlayState {
  /**
   * Whether the WALLS overlay belongs on screen AT ALL. Depends on the active
   * tool, which is the Orchestrator's to know -- `assembler.py:80-86`.
   */
  readonly showField: boolean;
  /**
   * Whether the TRAILS overlay belongs on screen.
   *
   * Independent of `showField`, so both, either or neither can be up. In the
   * painting tools the Orchestrator forces exactly the active layer on and the
   * other off -- you look at what you are painting -- and outside them both
   * follow their own preference. See `overlayState`.
   */
  readonly showTrails: boolean;
  /** Cursor in canvas uv. */
  readonly reticleCenter: readonly [number, number];
  /** The brush's visible extent, aspect-corrected. Zero means no reticle. */
  readonly reticleRadius: number;
  /** Which decoration the ring carries. See `ReticleStyle`. */
  readonly reticleStyle: ReticleStyle;
  /**
   * The direction the `fixed` reticle's arrow points, in radians. 0 is up.
   *
   * Read only by that style. Live from the Draw Angle slider, so dragging it
   * turns the arrow -- which is the entire reason the arrow exists.
   */
  readonly reticleAngle: number;
  /**
   * The line tool's pending segment in canvas uv, or null when none is armed.
   *
   * Drawn as a half-opacity capsule: the stroke's FOOTPRINT, not the vector field
   * it would deposit. The footprint is what the user is aiming, and it is
   * legible at a glance where a field of arrows would not be.
   */
  readonly linePreview: LinePreview | null;
  /**
   * The recording crop box, or null for no box.
   *
   * **Null on the capture pass, ALWAYS.** This marks which pixels will be in the
   * video; drawing it into that video would burn the annotation into the thing
   * it annotates. Same rule as the reticle, and the Orchestrator enforces both
   * at the same call site.
   *
   * Null also when the box covers the whole window, since a rule around the
   * screen edge and a surround of zero pixels is chrome with nothing to say.
   */
  readonly crop: CropOverlay | null;
  /**
   * Which sub-rectangle of the source this pass reads, or null for all of it.
   *
   * The INVERSE of `crop`'s role, and the two are never both set: the screen
   * pass draws the box and reads the whole source; the capture pass reads the
   * box's interior and draws nothing. Null means the identity remap.
   */
  readonly capture: CaptureRemap | null;
}

/** The crop box, as the shader wants it: half-extent from the window's centre. */
export interface CropOverlay {
  /** Half the box's size as a fraction of the window, per axis. */
  readonly halfExtent: readonly [number, number];
}

/** The line tool's pending segment, both endpoints in canvas uv. */
export interface LinePreview {
  readonly from: readonly [number, number];
  readonly to: readonly [number, number];
}

/** A uv remap: `uv * scale + offset`. See `frameAssembly.wgsl`'s `fs_main`. */
export interface CaptureRemap {
  readonly scale: readonly [number, number];
  readonly offset: readonly [number, number];
}

/** No overlays -- what Step 5 passes until Steps 8 and 9 provide the state. */
export const NO_OVERLAYS: OverlayState = {
  showField: false,
  showTrails: false,
  reticleCenter: [0.0, 0.0],
  reticleRadius: 0.0,
  reticleStyle: 'plain',
  reticleAngle: 0.0,
  linePreview: null,
  crop: null,
  capture: null,
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

  // reticle: xy center, z radius, w draw angle (the `fixed` arrow's direction)
  f32[12] = overlays.reticleCenter[0];
  f32[13] = overlays.reticleCenter[1];
  f32[14] = overlays.reticleRadius;
  f32[15] = overlays.reticleAngle;

  // flags: x reticle_style(i), y trails_opacity, zw reserved
  //
  // `reticle_style` REPLACED A BOOLEAN `reticle_dashed` in this lane. It is an
  // index into RETICLE_STYLES, and 'dashed' is deliberately NOT index 0 -- so a
  // stale build reading this as a bool would see 'plain' (0) as false and every
  // other style as true, i.e. dashed. That is wrong in an obvious way rather than
  // a subtle one, which is the right failure for a lane that changed meaning.
  i32[16] = RETICLE_STYLE_INDEX[overlays.reticleStyle];
  // The trails overlay's own opacity, gated by its own flag. Shares the
  // `fieldOpacity` preference with the walls overlay -- one control for how
  // strongly overlays draw, two flags for which ones do.
  f32[17] = overlays.showTrails ? Math.max(0.0, prefs.fieldOpacity) : 0.0;

  // line: xy the anchor, zw the cursor, both in canvas uv. z of `flags` is the
  // enable, because a zero-length segment is a legitimate preview (the frame the
  // line is armed, before the cursor moves) and so cannot double as "off".
  if (overlays.linePreview !== null) {
    f32[18] = 1.0;
    f32[28] = overlays.linePreview.from[0];
    f32[29] = overlays.linePreview.from[1];
    f32[30] = overlays.linePreview.to[0];
    f32[31] = overlays.linePreview.to[1];
  }

  // crop: xy half-extent as a fraction of the window, z enable, w dim amount.
  //
  // HALF-EXTENT FROM THE CENTRE rather than an origin plus a size, because the
  // box is always centred and the shader's test is then one symmetric compare
  // against `abs(uv - 0.5)`. Passing an origin would make the shader re-derive
  // the centring that `cropRect` already did, which is how the box and the
  // pixels it claims to contain drift apart.
  //
  // The capture pass passes `crop: null` and so packs zero here -- the box is
  // never drawn into the recording it describes. See `OverlayState.crop`.
  if (overlays.crop !== null) {
    f32[20] = overlays.crop.halfExtent[0];
    f32[21] = overlays.crop.halfExtent[1];
    f32[22] = 1.0;
    f32[23] = CROP_SURROUND_DIM;
  }

  // capture: xy uv scale, zw uv offset.
  //
  // **THE IDENTITY IS WRITTEN EXPLICITLY, not left as the buffer's zeros.** A
  // scale of zero collapses every fragment onto one texel, so the screen would
  // show a single flat colour -- and this is the DEFAULT path, taken on every
  // frame that is not a cropped capture. Forgetting it is not a subtle bug, but
  // it is one that only appears once something else writes this lane.
  const capture = overlays.capture ?? IDENTITY_CAPTURE;
  f32[24] = capture.scale[0];
  f32[25] = capture.scale[1];
  f32[26] = capture.offset[0];
  f32[27] = capture.offset[1];

  return buffer;
}

/** The whole source, unremapped: what the screen pass always uses. */
const IDENTITY_CAPTURE: CaptureRemap = { scale: [1, 1], offset: [0, 0] };

/**
 * How far the area outside the crop box is dimmed.
 *
 * Not black. The surround still has to show what is happening just beyond the
 * frame -- aiming a crop at something that is about to move into it is the
 * common case, and a blacked-out border makes that impossible. Two thirds is
 * enough that the boundary reads instantly without hiding the world.
 */
const CROP_SURROUND_DIM = 0.65;
