/**
 * Simulation configuration: the typed presets that drive the simulation.
 * A direct port of `particle_system/config.py`'s value types.
 *
 * Two distinct things live here, and the split is deliberate:
 *
 *   - `SimulationConfig` -> packs into the WGSL `ConfigData` struct, which
 *     lives in the ConfigBuffer storage buffer. These are PER-PARTICLE-
 *     POPULATION settings: each entity picks one via its own config_index.
 *     Behavior (the Fourier `Rule`) and physics parameters are unified here,
 *     because they are the same kind of thing and separating them is what made
 *     the reference sprawl.
 *
 *   - `WorldSettings`/`WorldConfig` -> pack into the WGSL `WorldData` struct.
 *     These are settings that would be meaningless to vary between two
 *     particles sharing a canvas: trail decay, world scale.
 *
 * This module holds the types, the defaults, the mode enums and the lane
 * ORDERING. Turning any of it into bytes is `pack.ts`'s job -- which is why
 * this file imports nothing but the lane assertion. Keeping it dependency-free
 * is what lets later steps' UI and persistence code import config types without
 * dragging the layout descriptor along.
 *
 * ## Field naming, and a note for the persistence step
 *
 * Python's `snake_case` becomes `camelCase` here (`sensor_gain` ->
 * `sensorGain`). This is the one place the port deliberately breaks its
 * one-to-one correspondence with the Python.
 *
 * Whoever ports `persistence.py` will need an explicit name mapping at the file
 * boundary -- and note that the saved format uses a THIRD set of names again
 * (`sensor.gain`, `force.global_mult`, `misc.lateral`), so a mapping is needed
 * regardless of this rename. It is not extra work caused by camelCasing.
 */

import { assertLaneMap } from './layout.ts';

/**
 * Mode enums, mirroring the `BC_` and `IC_` defines in `common.wgsl` BY VALUE.
 * The shader is the definition; these exist so host code and the settings
 * registry can name the modes instead of writing bare integers.
 *
 * Const objects rather than TypeScript `enum`s: `verbatimModuleSyntax` and
 * `isolatedModules` make real enums awkward (and ban `const enum` outright).
 */
export const BC = { BOUNCE: 0, WRAP: 1, RESET: 2 } as const;
export type BoundaryCondition = (typeof BC)[keyof typeof BC];

export const IC = { GRID: 0, RANDOM: 1, CENTER: 2, RING: 3 } as const;
export type InitialConditions = (typeof IC)[keyof typeof IC];

/**
 * Float32 lane indices within a `ConfigData` record.
 *
 * Lane MEANINGS (which float is which) are stated here; the OFFSETS come from
 * the generated descriptor. That is the same split `config.py:99-105` describes:
 * "The dtype itself comes from parsing that file, so only the lane *ordering*
 * is stated here."
 *
 * The `(i)` markers are carried verbatim from `common.glsl`'s lane comments and
 * mark lanes holding an INT via bit reinterpretation, not a float. See
 * `pack.ts` for how those are written.
 */
export const LANE = {
  rule: 0, //     80 floats -- 10 FourierCenters, frequency(4) + amplitude(4)
  sensor: 80, //  x: gain          y: angle          z: distance    w: mutation_scale
  force: 84, //   x: global_mult   y: drag           z: strafe      w: axial
  misc: 88, //    x: lateral       y: hazard_rate    z: cohorts(i)  w: mutation_seed
  force2: 92, //  x: gravity_force y: gravity_strafe z: initial_conditions(i) w: cohort_fences
  misc2: 96, //   x: color_sensitivity   y: color_by_cohort(i)
  //              z: sensor_angle_jitter w: sensor_distance_jitter
  misc3: 100, //  x: radial_gravity(i)   yzw: reserved
} as const;

/** Float32 lane indices within a `WorldData` record. */
export const WORLD_LANE = {
  trail: 0, //   x: persistence  y: diffusion  z: sqrt_world_size  w: config_count(i)
  bounds: 4, //  x: boundary_conditions(i)  yzw: reserved
} as const;

// Checked against the generated descriptor at module load. This is the guard
// the whole build-time-descriptor design exists for: if a vec4 is added to
// ConfigData in common.wgsl and the tables above are not updated, every lane
// after the insertion point shifts by four floats and the port would silently
// write each field into the wrong place. See `assertLaneMap`.
assertLaneMap('ConfigData', LANE);
assertLaneMap('WorldData', WORLD_LANE);

/** 10 FourierCenters x (frequency vec4 + amplitude vec4). */
export const RULE_FLOAT_COUNT = 80;

/**
 * Typed, immutable preset. Mirrors the WGSL `ConfigData` struct.
 *
 * A `readonly` interface rather than a class: the dominant operation on a
 * config is the equivalent of Python's `dataclasses.replace` -- an edit
 * funnelled through the project's `edited()`, which in TypeScript is
 * `{ ...config, [field]: value }`. That is clean on a plain object and a
 * footgun on a class instance, which would lose its prototype. `readonly` is
 * the compile-time form of the Python's `frozen=True`.
 */
export interface SimulationConfig {
  // settings
  readonly cohorts: number;
  /**
   * Which random variation the rule mutation uses. A float in [0,1] -- it is
   * fed straight into the hash function, so fractional values are meaningful.
   */
  readonly mutationSeed: number;
  // physics
  readonly sensorGain: number;
  readonly sensorAngle: number;
  readonly sensorDistance: number;
  readonly mutationScale: number;
  readonly globalForceMult: number;
  readonly drag: number;
  readonly strafePower: number;
  readonly axialForce: number;
  readonly lateralForce: number;
  readonly hazardRate: number;
  /**
   * Uniform pull on the whole population, one per motion channel. LINEAR
   * -1..1 controls -- the shader expands them logarithmically via
   * `gravity_expand()`.
   */
  readonly gravityForce: number;
  readonly gravityStrafe: number;
  /** How particles are arranged on reset. Indexes the IC_* modes. */
  readonly initialConditions: InitialConditions;
  /** How tightly each particle is held near its own spawn point. 0 is off. */
  readonly cohortFences: number;
  /**
   * How strongly the particle's colour signal swings its hue, in PARTICLES
   * view. A RENDERING setting that happens to be per-config: it never touches
   * the simulation, so dragging it re-colours without disturbing anything.
   * Negative values simply run the hue backwards.
   */
  readonly colorSensitivity: number;
  /**
   * Colour each population flat by cohort instead of by its brain's output.
   * Applied in entity_update (it changes what gets stored), not the renderer.
   */
  readonly colorByCohort: boolean;
  /**
   * Random wobble on where each particle looks, RESAMPLED EVERY PHYSICS STEP
   * -- a shimmer rather than a fixed per-particle trait. 0..1, where 1.0 spans
   * the full range of the parameter it perturbs (see the accessors in
   * `common.wgsl`).
   */
  readonly sensorAngleJitter: number;
  readonly sensorDistanceJitter: number;
  /**
   * Whether the two gravity values above pull along the fixed screen axis
   * (false) or along each particle's own position vector (true), making them
   * pull towards or away from the origin.
   */
  readonly radialGravity: boolean;
  /** 80 floats -> 10 FourierCenters, each frequency(4) + amplitude(4). */
  readonly rule: readonly number[];
}

/** The 12 fields a config cannot be built without. */
export type SimulationConfigRequired = Pick<
  SimulationConfig,
  | 'cohorts'
  | 'mutationSeed'
  | 'sensorGain'
  | 'sensorAngle'
  | 'sensorDistance'
  | 'mutationScale'
  | 'globalForceMult'
  | 'drag'
  | 'strafePower'
  | 'axialForce'
  | 'lateralForce'
  | 'hazardRate'
>;

/**
 * Defaults for every field that has one.
 *
 * **These are a compatibility contract, not conveniences.** Each one is the
 * value that makes a config saved BEFORE that field existed behave exactly as
 * it did then. The Python states this per field, and those statements are
 * preserved below:
 *
 *   gravityForce/gravityStrafe  "Default 0 (no pull), so configs saved before
 *                                these existed behave exactly as they did."
 *   initialConditions           "Defaults to IC_CENTER, which is what this app
 *                                did before the mode was selectable, so
 *                                existing configs look unchanged."
 *   sensorAngleJitter/          "Default 0, so configs saved before these
 *   sensorDistanceJitter         existed are unchanged."
 *   radialGravity               "False is what every config saved before this
 *                                existed meant."
 *
 * Exported as ONE object, not scattered through a function signature, so the
 * config reader can spread it (`{ ...SIMULATION_CONFIG_DEFAULTS, ...parsed }`)
 * and reproduce Python's dataclass-default semantics exactly. Python's reader
 * relies on `.get(key, default)` falling back to these; the port's must too.
 */
export const SIMULATION_CONFIG_DEFAULTS = {
  gravityForce: 0.0,
  gravityStrafe: 0.0,
  initialConditions: IC.CENTER,
  cohortFences: 0.0,
  colorSensitivity: 0.5,
  colorByCohort: false,
  sensorAngleJitter: 0.0,
  sensorDistanceJitter: 0.0,
  radialGravity: false,
  rule: [] as readonly number[],
} as const satisfies Omit<SimulationConfig, keyof SimulationConfigRequired>;

/**
 * Build a config from its required fields, filling the rest with the defaults.
 *
 * Note the default `rule` is empty, matching the Python's
 * `field(default_factory=tuple)`. A config with no rule packs into nothing --
 * `writeConfigRecord` rejects it -- which is the Python's behaviour too.
 */
export function makeSimulationConfig(
  required: SimulationConfigRequired,
  overrides: Partial<SimulationConfig> = {},
): SimulationConfig {
  return { ...SIMULATION_CONFIG_DEFAULTS, ...required, ...overrides };
}

/**
 * The world half of a project: settings shared by every particle.
 *
 * One canvas, one decay rate -- these are properties of the world, not of any
 * config, and there is exactly one instance per project. They used to be
 * carried on every `SimulationConfig` because the preset format put them beside
 * the physics parameters, which made config 0 secretly authoritative and left
 * slots 1+ holding values that were silently ignored.
 *
 * Saved with the project. Sizing values (`sqrtWorldSize`, `configCount`) are
 * NOT here: they are properties of the running system, so they join at upload
 * time in `WorldConfig`.
 */
export interface WorldSettings {
  readonly trailPersistence: number;
  readonly trailDiffusion: number;
  /**
   * What happens at the edge of the world. Indexes the BC_* modes. A world
   * setting rather than a per-config one: the trail field obeys the same
   * boundary, and there is only one trail field.
   */
  readonly boundaryConditions: BoundaryCondition;
}

/** Defaults matching the Python dataclass, for the same compatibility reason. */
export const WORLD_SETTINGS_DEFAULTS = {
  trailPersistence: 0.94,
  trailDiffusion: 1.0,
  /** BC_WRAP -- the behavior before the mode was selectable. */
  boundaryConditions: BC.WRAP,
} as const satisfies WorldSettings;

export function makeWorldSettings(
  overrides: Partial<WorldSettings> = {},
): WorldSettings {
  return { ...WORLD_SETTINGS_DEFAULTS, ...overrides };
}

/**
 * `WorldSettings` plus runtime sizing. Mirrors the WGSL `WorldData` struct.
 *
 * The GPU-facing value: saved settings combined with properties of the running
 * system that no save file should dictate.
 */
export interface WorldConfig extends WorldSettings {
  readonly sqrtWorldSize: number;
  readonly configCount: number;
}

/** `WorldSettings` -> `WorldConfig`, joining the runtime sizing. */
export function forUpload(
  settings: WorldSettings,
  sqrtWorldSize: number,
  configCount: number,
): WorldConfig {
  return { ...settings, sqrtWorldSize, configCount };
}

// `WorldConfig.as_uniform_value()` (config.py:197-206) is deliberately NOT
// ported. It exists only because GLSL struct uniforms are set one member at a
// time through moderngl's `tryset`, which has no WebGPU analogue -- WebGPU
// validates bind groups rather than silently dropping optimized-out uniforms.
// WorldData becomes a real uniform buffer written by a single writeBuffer of
// the 32-byte record, so `packWorldConfig` in pack.ts is the whole replacement.
// Do not restore it.
