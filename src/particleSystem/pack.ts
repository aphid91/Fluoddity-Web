/**
 * Turning configs into GPU bytes.
 * The port of `particle_system/config.py`'s `to_record` / `pack_configs`.
 *
 * Split out from `config.ts` so that the value types stay dependency-free:
 * only this file needs the layout descriptor, and only this file knows about
 * bytes. Later steps' UI and persistence code import config types without
 * dragging either along.
 *
 * ## The int lanes
 *
 * Four `ConfigData` lanes and two `WorldData` lanes hold an INT, not a float --
 * the shader reads them back with `bitcast<i32>` (GLSL `floatBitsToInt`). The
 * Python smuggles the int in as a bit-identical float via `_int_lane`
 * (`config.py:35-37`), because numpy structured-array assignment goes through a
 * float32 field and leaves no other route. The values that produces are
 * denormals: `cohorts = 3` becomes 4.2038954e-45.
 *
 * TypeScript has no such constraint. Two views over one `ArrayBuffer` say
 * "these four bytes are an i32" exactly and directly, so **the ints are written
 * through an `Int32Array` and the denormals never exist**. That also means no
 * `Math.fround` subtleties and no risk of a NaN bit pattern being canonicalized
 * in transit.
 *
 * The same aliasing technique is what a later step's pick readback needs in the
 * other direction (`bitcast<i32>` on `Entity.misc.y` for `config_index`), so
 * this is one idiom used both ways rather than a local trick.
 *
 * ## On float32 truncation
 *
 * Configs are JavaScript numbers (float64) and the record is float32. Assigning
 * into a `Float32Array` rounds to nearest-even, which is exactly what
 * `np.float32` assignment does -- so the two agree bit for bit. This is checked
 * empirically: `pack.test.ts` compares a full 416-byte record against a hex
 * golden produced by the desktop Python.
 */

import {
  type SimulationConfig,
  type WorldConfig,
  LANE,
  RULE_FLOAT_COUNT,
  WORLD_LANE,
} from './config.ts';
import { CONFIG_DATA_FLOATS, CONFIG_DATA_STRIDE, WORLD_DATA_SIZE } from './layout.ts';

export { CONFIG_DATA_STRIDE, WORLD_DATA_SIZE };

/**
 * Write one `SimulationConfig` into `target` at `byteOffset`.
 *
 * Takes a target buffer rather than returning a fresh one so a single-config
 * edit can rewrite its own 416-byte slice in place and upload just that range,
 * which is what the desktop's per-config path does. `packConfigs` builds on it.
 *
 * Throws if the rule is not exactly 80 floats, mirroring `config.py:110-113`.
 * The caller is expected to have a complete config; a short rule is a bug, not
 * a condition to tolerate.
 */
export function writeConfigRecord(
  config: SimulationConfig,
  target: ArrayBuffer,
  byteOffset: number,
): void {
  if (config.rule.length !== RULE_FLOAT_COUNT) {
    throw new Error(
      `rule must be ${RULE_FLOAT_COUNT} floats (10 centers x 8), got ` +
        `${config.rule.length}`,
    );
  }
  if (byteOffset % 4 !== 0) {
    throw new Error(`byteOffset must be 4-byte aligned, got ${byteOffset}`);
  }
  if (byteOffset + CONFIG_DATA_STRIDE > target.byteLength) {
    throw new Error(
      `writing a ${CONFIG_DATA_STRIDE}-byte record at offset ${byteOffset} ` +
        `overruns a ${target.byteLength}-byte buffer`,
    );
  }

  // Two views over the SAME bytes: floats for the value lanes, ints for the
  // bit-punned ones. Indexed from `base` rather than sliced, so no copy.
  const f32 = new Float32Array(target);
  const i32 = new Int32Array(target);
  const base = byteOffset / 4;

  // The rule is a straight 80-float copy. The Python reshapes to (10, 2, 4) and
  // assigns through the nested FourierCenter dtype, but numpy's C-order makes
  // that layout-identical to a contiguous write -- so the nesting never has to
  // appear here. `layout.test.ts` asserts the stride that makes this valid.
  f32.set(config.rule, base + LANE.rule);

  // sensor: gain, angle, distance, mutation_scale
  f32[base + LANE.sensor + 0] = config.sensorGain;
  f32[base + LANE.sensor + 1] = config.sensorAngle;
  f32[base + LANE.sensor + 2] = config.sensorDistance;
  f32[base + LANE.sensor + 3] = config.mutationScale;

  // force: global_mult, drag, strafe, axial
  f32[base + LANE.force + 0] = config.globalForceMult;
  f32[base + LANE.force + 1] = config.drag;
  f32[base + LANE.force + 2] = config.strafePower;
  f32[base + LANE.force + 3] = config.axialForce;

  // misc: lateral, hazard_rate, cohorts(i), mutation_seed
  f32[base + LANE.misc + 0] = config.lateralForce;
  f32[base + LANE.misc + 1] = config.hazardRate;
  i32[base + LANE.misc + 2] = config.cohorts; // read by cfg_cohorts()
  f32[base + LANE.misc + 3] = config.mutationSeed;

  // force2: gravity_force, gravity_strafe, initial_conditions(i), cohort_fences(i)
  f32[base + LANE.force2 + 0] = config.gravityForce;
  f32[base + LANE.force2 + 1] = config.gravityStrafe;
  i32[base + LANE.force2 + 2] = config.initialConditions; // cfg_initial_conditions()
  i32[base + LANE.force2 + 3] = config.cohortFences ? 1 : 0; // cfg_cohort_fences()

  // misc2: color_sensitivity, color_by_cohort(i), sensor jitters
  f32[base + LANE.misc2 + 0] = config.colorSensitivity;
  i32[base + LANE.misc2 + 1] = config.colorByCohort ? 1 : 0; // cfg_color_by_cohort()
  f32[base + LANE.misc2 + 2] = config.sensorAngleJitter;
  f32[base + LANE.misc2 + 3] = config.sensorDistanceJitter;

  // misc3: radial_gravity(i), three reserved lanes.
  //
  // The reserved lanes are NOT written. An ArrayBuffer is zero-initialized by
  // spec, which reproduces the Python's `np.zeros` exactly -- so misc3.yzw are
  // already 0.0. (Only true for a fresh buffer: `writeConfigRecord` into a
  // reused buffer would leave stale bytes there. `packConfigs` always allocates.)
  i32[base + LANE.misc3 + 0] = config.radialGravity ? 1 : 0; // cfg_radial_gravity()
}

/**
 * Pack a list of configs into ConfigBuffer bytes.
 * The port of `config.py:209-214`.
 *
 * Tightly packed at stride 416, which is the stride the shader's ConfigBuffer
 * indexing assumes. Zero-filled, so reserved lanes are 0.0 without being
 * written.
 */
export function packConfigs(configs: readonly SimulationConfig[]): ArrayBuffer {
  const buffer = new ArrayBuffer(configs.length * CONFIG_DATA_STRIDE);
  for (let i = 0; i < configs.length; i++) {
    writeConfigRecord(configs[i]!, buffer, i * CONFIG_DATA_STRIDE);
  }
  return buffer;
}

/**
 * Pack a `WorldConfig` into `WorldData` bytes.
 * The port of `WorldConfig.to_record` (`config.py:190-195`).
 *
 * On the desktop this record is exploded back into per-member uniform values by
 * `as_uniform_value()`, because GLSL struct uniforms are set a member at a
 * time. WebGPU has no such path -- `WorldData` becomes a real uniform buffer --
 * so the bytes are the whole story here and `as_uniform_value` has no port.
 */
export function packWorldConfig(world: WorldConfig): ArrayBuffer {
  const buffer = new ArrayBuffer(WORLD_DATA_SIZE);
  const f32 = new Float32Array(buffer);
  const i32 = new Int32Array(buffer);

  // trail: persistence, diffusion, sqrt_world_size, config_count(i)
  f32[WORLD_LANE.trail + 0] = world.trailPersistence;
  f32[WORLD_LANE.trail + 1] = world.trailDiffusion;
  f32[WORLD_LANE.trail + 2] = world.sqrtWorldSize;
  i32[WORLD_LANE.trail + 3] = world.configCount; // read by world_config_count()

  // bounds: boundary_conditions(i), yzw reserved (left zero by the allocation)
  i32[WORLD_LANE.bounds + 0] = world.boundaryConditions; // world_boundary_conditions()

  return buffer;
}

/** Float32 lanes per ConfigData record. Re-exported for callers doing offsets. */
export { CONFIG_DATA_FLOATS };
