/**
 * Uniform packing for the spawn and kill passes.
 *
 * Deliberately the same shape as `particleSystem/uniforms.ts`: every struct
 * begins with `WorldData`, packed by `packWorldConfig` rather than re-derived,
 * so the lane order lives in exactly one place. This module is a LEAF -- it
 * imports only value modules, so it is testable under `node --test`.
 */

import type { WorldConfig } from '../particleSystem/config.ts';
import { packWorldConfig } from '../particleSystem/pack.ts';
import { WORLD_DATA_SIZE } from '../particleSystem/layout.ts';

/** Float-lane index of the first member after `world`. 32 bytes / 4 = 8. */
const AFTER_WORLD = WORLD_DATA_SIZE / 4;

/** `WorldData` + `stroke` vec4 + `params` vec4 = 32 + 16 + 16. */
export const SPAWN_UNIFORM_SIZE = WORLD_DATA_SIZE + 32;
/** Same shape as the spawn struct -- world, stroke, params. */
export const KILL_UNIFORM_SIZE = WORLD_DATA_SIZE + 32;

/**
 * A brush stroke for one frame: where the cursor was, and where it is now.
 *
 * BOTH ENDS, NOT ONE POINT. The passes paint along the segment, so a fast drag
 * lays a continuous stream rather than one clump per frame. On the first frame
 * of a stroke `from` and `to` are the same point, which both shaders handle (the
 * kill shader guards the zero-length case explicitly).
 */
export interface Stroke {
  readonly from: readonly [number, number];
  readonly to: readonly [number, number];
  /** Brush radius in WORLD units. */
  readonly radius: number;
}

function withWorld(world: WorldConfig, size: number) {
  const buffer = new ArrayBuffer(size);
  new Uint8Array(buffer).set(new Uint8Array(packWorldConfig(world)), 0);
  return { buffer, f32: new Float32Array(buffer), i32: new Int32Array(buffer) };
}

function writeStroke(f32: Float32Array, stroke: Stroke): void {
  f32[AFTER_WORLD + 0] = stroke.from[0];
  f32[AFTER_WORLD + 1] = stroke.from[1];
  f32[AFTER_WORLD + 2] = stroke.to[0];
  f32[AFTER_WORLD + 3] = stroke.to[1];
}

/**
 * Pack the spawn pass's uniforms.
 *
 * `count` is the CPU's decision about HOW MANY to create; the shader's bounds
 * check against it is what sizes the work. `configIndex` is the palette slot the
 * new particles will obey -- a real index, never negative, since a negative one
 * is the dead sentinel.
 */
export function packSpawnUniforms(
  world: WorldConfig,
  stroke: Stroke,
  count: number,
  configIndex: number,
  frame: number,
): ArrayBuffer {
  const { buffer, f32, i32 } = withWorld(world, SPAWN_UNIFORM_SIZE);
  writeStroke(f32, stroke);
  // params: x count(i), y radius, z config_index(i), w frame(i)
  //
  // The f32 and i32 views alias one buffer, so lane 5 as a float and lane 5 as
  // an int are the same four bytes -- which is safe only because each lane is
  // written through exactly one view. Mirrors the note in uniforms.ts.
  i32[AFTER_WORLD + 4] = Math.max(0, Math.trunc(count));
  f32[AFTER_WORLD + 5] = stroke.radius;
  i32[AFTER_WORLD + 6] = Math.trunc(configIndex);
  i32[AFTER_WORLD + 7] = Math.trunc(frame);
  return buffer;
}

/** Pack the kill pass's uniforms. */
export function packKillUniforms(world: WorldConfig, stroke: Stroke): ArrayBuffer {
  const { buffer, f32 } = withWorld(world, KILL_UNIFORM_SIZE);
  writeStroke(f32, stroke);
  // params: x radius, yzw reserved
  f32[AFTER_WORLD + 4] = stroke.radius;
  return buffer;
}
