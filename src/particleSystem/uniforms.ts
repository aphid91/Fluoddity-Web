/**
 * Packing the per-pass uniform buffers.
 *
 * The desktop sets these as loose GLSL uniforms through moderngl's `tryset`,
 * one member at a time (`particle_system.py:180-182`, `:396-416`). WebGPU has
 * no such path: a uniform is a buffer, so each pass gets one struct and one
 * `writeBuffer`.
 *
 * ## Why this is not in `pack.ts`
 *
 * `pack.ts`'s header scopes it deliberately: it exists so `config.ts` can stay
 * dependency-free, and it is the only module that knows about *config* bytes.
 * Shader uniforms are a different concern, owned by the shaders' host module.
 * `packWorldConfig` is imported rather than reimplemented -- `WorldData` is
 * embedded verbatim at offset 0 of every struct below, so there is exactly one
 * piece of code that knows its layout.
 *
 * ## `uniform` address space vs `storage`
 *
 * WGSL's uniform address space has stricter alignment than storage: struct
 * members align to 16 and array strides must be a multiple of 16. That would
 * normally need an audit -- but the vec4-only rule (`common.wgsl:25-34`) means
 * every struct here is already built from `vec4f` alone, so uniform and storage
 * layouts agree by construction. This is the same argument the vec4 rule makes
 * for std430, applied one address space over. Nothing to check, but worth
 * writing down, because "uniform buffers lay out differently" is a real thing a
 * reader will worry about.
 *
 * ## Ints ride in float lanes
 *
 * `frameCount`, and the two booleans, are written through an `Int32Array` view
 * onto the same `ArrayBuffer` and read back with `bitcast<i32>` -- the idiom
 * `pack.ts:81-85` establishes and the same one `cfg_cohorts` and friends use.
 * A real `i32` member would also be legal here (the surrounding vec4s satisfy
 * its alignment), but it would be a SECOND packing convention for no gain.
 * One convention, used everywhere.
 */

import type { WorldConfig } from './config.ts';
import { packWorldConfig } from './pack.ts';
import { WORLD_DATA_SIZE } from './layout.ts';
import { PICK_UNIFORM_SIZE } from './pick.ts';

/**
 * `EntityUpdateUniforms` -- 80 bytes.
 *
 *   world      : WorldData  (32)  offset 0
 *   canvas_res : vec4f      (16)  offset 32   xy: canvas   zw: strafe field
 *   shove      : vec4f      (16)  offset 48   xy: center   z: strength  w: size
 *   flags      : vec4f      (16)  offset 64   x: frame_count(i)  y: strafe_active(i)
 *
 * `canvas_res` is THE `textureDimensions` HOIST. The GLSL calls
 * `textureSize(canvas_texture, 0)` at five sites per invocation
 * (`entity_update.glsl:151` twice via the two sensor taps, `:232` once or twice
 * via reset/fence, and `:384`); at 600k entities x 30 sub-steps that is not
 * free, and the value is constant for the whole pass anyway.
 */
export const ENTITY_UPDATE_UNIFORM_SIZE = 80;

/** `CanvasUniforms` -- 48 bytes. world (32) + flags (16). */
export const CANVAS_UNIFORM_SIZE = 48;

/** `BrushUniforms` -- 64 bytes. world (32) + canvas_res (16) + flags (16). */
export const BRUSH_UNIFORM_SIZE = 64;

/** The Shove tool's live state, or null while the button is not held. */
export interface ShoveState {
  /** Cursor in WORLD space. */
  readonly center: readonly [number, number];
  /** Signed: positive pushes away, negative pulls in. Zero is the off switch. */
  readonly strength: number;
  /** Gaussian sigma in WORLD units. */
  readonly size: number;
}

/**
 * Write `WorldData` at offset 0 and hand back the views for the rest.
 *
 * Every uniform struct starts with `world`, so this is the one place that
 * knows it -- and it delegates the 32 bytes themselves to `packWorldConfig`
 * rather than re-deriving the lane order.
 */
function withWorld(
  world: WorldConfig,
  size: number,
): { buffer: ArrayBuffer; f32: Float32Array; i32: Int32Array } {
  const buffer = new ArrayBuffer(size);
  new Uint8Array(buffer).set(new Uint8Array(packWorldConfig(world)), 0);
  return {
    buffer,
    f32: new Float32Array(buffer),
    i32: new Int32Array(buffer),
  };
}

/** Float-lane index of the first member after `world`. 32 bytes / 4 = 8. */
const AFTER_WORLD = WORLD_DATA_SIZE / 4;

/**
 * Pack the entity-update pass's uniforms.
 *
 * `shove` of null writes zero strength, which is the off switch -- matching
 * `particle_system.py:403-404`, where the common case is one uniform write
 * rather than a branch in the shader. Unlike the desktop, the centre and size
 * are zeroed too rather than left stale: `tryset` tolerated staleness because
 * a zero strength makes them unread, and reproducing the staleness would mean
 * the buffer's contents depended on history for no benefit.
 */
export function packEntityUpdateUniforms(
  world: WorldConfig,
  canvasRes: readonly [number, number],
  strafeFieldRes: readonly [number, number],
  frameCount: number,
  shove: ShoveState | null,
  strafeFieldActive: boolean,
): ArrayBuffer {
  const { buffer, f32, i32 } = withWorld(world, ENTITY_UPDATE_UNIFORM_SIZE);

  // canvas_res: xy canvas, zw strafe field
  f32[AFTER_WORLD + 0] = canvasRes[0];
  f32[AFTER_WORLD + 1] = canvasRes[1];
  f32[AFTER_WORLD + 2] = strafeFieldRes[0];
  f32[AFTER_WORLD + 3] = strafeFieldRes[1];

  // shove: xy center, z strength, w size
  f32[AFTER_WORLD + 4] = shove === null ? 0.0 : shove.center[0];
  f32[AFTER_WORLD + 5] = shove === null ? 0.0 : shove.center[1];
  f32[AFTER_WORLD + 6] = shove === null ? 0.0 : shove.strength;
  f32[AFTER_WORLD + 7] = shove === null ? 0.0 : shove.size;

  // flags: x frame_count(i), y strafe_field_active(i), zw reserved
  i32[AFTER_WORLD + 8] = frameCount;
  i32[AFTER_WORLD + 9] = strafeFieldActive ? 1 : 0;

  return buffer;
}

/** Pack the canvas decay/diffuse pass's uniforms. */
export function packCanvasUniforms(
  world: WorldConfig,
  frameCount: number,
): ArrayBuffer {
  const { buffer, i32 } = withWorld(world, CANVAS_UNIFORM_SIZE);
  // flags: x frame_count(i), yzw reserved
  i32[AFTER_WORLD + 0] = frameCount;
  return buffer;
}

/**
 * Pack the brush splat pass's uniforms.
 *
 * `canvas_resolution` is a vertex-stage value on the desktop
 * (`brush.vert:7`, set once at reload) and `world`/`frame_count` are
 * fragment-stage; here they share one buffer bound to both stages, because
 * splitting them would mean two buffers and two writes for 64 bytes.
 */
export function packBrushUniforms(
  world: WorldConfig,
  canvasRes: readonly [number, number],
  frameCount: number,
): ArrayBuffer {
  const { buffer, f32, i32 } = withWorld(world, BRUSH_UNIFORM_SIZE);

  // canvas_res: xy, zw reserved
  f32[AFTER_WORLD + 0] = canvasRes[0];
  f32[AFTER_WORLD + 1] = canvasRes[1];

  // flags: x frame_count(i), yzw reserved
  i32[AFTER_WORLD + 4] = frameCount;

  return buffer;
}

/**
 * Pack the pick passes' uniforms. Both passes share one buffer.
 *
 * `world` is not decoration: the DERIVE pass selects the winner's config with
 * `configs[clamp(i, 0, world_config_count(world) - 1)]`, exactly as
 * entityUpdate.wgsl:497 does. A different clamp bound could select a different
 * ConfigData than the physics used, and derive a rule the entity is not obeying
 * -- which is a wrong adopted rule, and looks like a legitimate result.
 *
 * The desktop needs no world here (`entity_pick.glsl` takes only `target` and
 * `max_dist`), because it does not derive the rule on the GPU at all.
 */
export function packPickUniforms(
  world: WorldConfig,
  target: readonly [number, number],
  maxDist: number,
): ArrayBuffer {
  const { buffer, f32 } = withWorld(world, PICK_UNIFORM_SIZE);

  // params: xy target (world space), z max_dist, w reserved
  f32[AFTER_WORLD + 0] = target[0];
  f32[AFTER_WORLD + 1] = target[1];
  f32[AFTER_WORLD + 2] = maxDist;

  return buffer;
}

/**
 * Round `size` up to a multiple of `alignment`.
 *
 * Used for the per-sub-step uniform stride: `advance()` runs `physics_steps`
 * times inside ONE command encoder, and `frame_count` is the only thing that
 * varies between them. `queue.writeBuffer` cannot be interleaved with an
 * encoder's passes, so each sub-step reads its own slice of one buffer through
 * a dynamic offset -- and dynamic offsets must be a multiple of
 * `minUniformBufferOffsetAlignment` (256 on most hardware).
 */
export function alignTo(size: number, alignment: number): number {
  return Math.ceil(size / alignment) * alignment;
}
