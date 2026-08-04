/**
 * The v8 save format: reader, writer, and filename sanitizer.
 *
 * A port of `particle_system/persistence.py` (373 lines), minus everything v7.
 *
 * PURE. No fetch, no IndexedDB, no DOM -- it turns a parsed JSON document into a
 * `SavedConfig` and back. That is what makes the whole format testable under
 * `node --test`, and it is why the storage layers above (`manifest.ts`,
 * `idb.ts`, `configStore.ts`) hold no knowledge of the format at all: there is
 * exactly one interpreter of these bytes, whether they came off the network or
 * out of a database.
 *
 * ## v7 IS ABSENT BY CONSTRUCTION, not by an early return
 *
 * `persistence.py:213-282` carries a `LEGACY COMPATIBILITY` block and a
 * `_from_v7` reader, and its own docstring (`:216-219`) says they "must not
 * appear in the WebGPU port: the spec that port follows is the v8 format
 * alone." So there is no `version <= 7` arm here -- not even one that throws a
 * friendlier message, because that would be a v7 code path with a v7's worth of
 * assumptions about what those files contain. A version that is not 8 is
 * unrecognized, full stop.
 *
 * ## The tolerances are not optional
 *
 * Every `??` below reproduces one from the Python, and each has its line cited.
 * They exist because fields were ADDED to v8 after it shipped, so a file written
 * before a given field simply lacks it -- and every one of them fails SILENTLY
 * when dropped. The worst is `mutationSeed`: a missing fallback loads seed 0.0,
 * which the chaotic hash turns into a completely different rule. That is a wrong
 * adopted rule, which looks like a legitimate result.
 *
 * All eight files currently in `configs/` carry every optional block, so none of
 * these fallbacks is exercised by shipped data today. They guard files a user
 * still has locally, and they cost nothing.
 */

import {
  BC,
  IC,
  type BoundaryCondition,
  type InitialConditions,
  type SimulationConfig,
  type WorldSettings,
  makeSimulationConfig,
  makeWorldSettings,
} from '../particleSystem/config.ts';

/** The only version this port reads or writes. */
export const FORMAT_VERSION = 8;

/** Thrown for anything this reader will not accept. */
export class ConfigFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigFormatError';
  }
}

/**
 * The camera block, if the file recorded one.
 *
 * EVERY MEMBER IS INDEPENDENTLY OPTIONAL, matching
 * `_apply_saved_camera` (`project_commands.py:241-253`): a file may record a pan
 * and no zoom. `null` for the whole block means the file recorded no camera at
 * all, and the caller must then LEAVE THE CAMERA ALONE rather than snapping to a
 * default -- `persistence.py:58-70` is explicit about that.
 */
export interface SavedCamera {
  readonly pan?: readonly [number, number];
  readonly zoom?: number;
  readonly mode?: string;
}

/** A parsed save file. */
export interface SavedConfig {
  readonly configs: readonly SimulationConfig[];
  readonly world: WorldSettings;
  readonly camera: SavedCamera | null;
  readonly notes: string;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** A JSON object, or `{}` for anything else. Missing optional blocks land here. */
function block(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A required object block. Throws with the path, so the message locates itself. */
function required(raw: Record<string, unknown>, key: string, where: string): Record<string, unknown> {
  const value = raw[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigFormatError(`${where}: missing or malformed "${key}" block`);
  }
  return value as Record<string, unknown>;
}

function num(raw: Record<string, unknown>, key: string, where: string): number {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigFormatError(`${where}: "${key}" is not a finite number (${String(value)})`);
  }
  return value;
}

/** A number with a default, for the additive fields. Present-but-wrong still throws. */
function numOr(raw: Record<string, unknown>, key: string, fallback: number, where: string): number {
  return raw[key] === undefined ? fallback : num(raw, key, where);
}

function boolOr(raw: Record<string, unknown>, key: string, fallback: boolean, where: string): boolean {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new ConfigFormatError(`${where}: "${key}" is not a boolean (${String(value)})`);
  }
  return value;
}

/**
 * Narrow a saved number to a `BoundaryCondition`.
 *
 * Validated rather than cast: per invariant 9 a wrong boundary mode looks like a
 * physics quirk rather than an error, so an out-of-range value must be loud.
 */
function asBoundaryCondition(value: number, where: string): BoundaryCondition {
  const valid: readonly number[] = [BC.BOUNCE, BC.WRAP, BC.RESET];
  if (!valid.includes(value)) {
    throw new ConfigFormatError(`${where}: boundary_conditions ${value} is not a BC_* mode`);
  }
  return value as BoundaryCondition;
}

/** Same, for the initial-conditions enum. */
function asInitialConditions(value: number, where: string): InitialConditions {
  const valid: readonly number[] = [IC.GRID, IC.RANDOM, IC.CENTER, IC.RING];
  if (!valid.includes(value)) {
    throw new ConfigFormatError(`${where}: initial_conditions ${value} is not an IC_* mode`);
  }
  return value as InitialConditions;
}

/**
 * One `ConfigData` entry. The port of `_config_from_dict`
 * (`persistence.py:114-163`).
 *
 * Routed through `makeSimulationConfig` rather than assembled directly, so
 * `config.ts`'s own defaults apply to anything omitted -- the same compatibility
 * contract the Python gets from `SimulationConfig`'s dataclass defaults.
 */
function configFromDocument(raw: Record<string, unknown>, where: string): SimulationConfig {
  const sensor = required(raw, 'sensor', where);
  const force = required(raw, 'force', where);
  const misc = required(raw, 'misc', where);
  const force2 = block(raw['force2']);
  // RENAMED LANE (`persistence.py:119-124`): this block was "appearance" while
  // it held only the two colour settings. The sensor jitters are physics, so the
  // name had become a lie about half its contents. Both are read; only `misc2`
  // is written.
  const misc2 = raw['misc2'] !== undefined ? block(raw['misc2']) : block(raw['appearance']);
  const misc3 = block(raw['misc3']);

  const rule = raw['rule'];
  if (!Array.isArray(rule) || rule.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new ConfigFormatError(`${where}: "rule" is not an array of finite numbers`);
  }

  return makeSimulationConfig(
    {
      cohorts: num(misc, 'cohorts', where),
      // RENAMED FIELD (`persistence.py:128-129`): v8 files written before the
      // rename spell this "rule_seed". THE MOST DANGEROUS FALLBACK IN THE FILE:
      // without it those files load seed 0.0, and the chaotic hash turns that
      // into an entirely different rule that still looks legitimate.
      mutationSeed:
        misc['mutation_seed'] !== undefined
          ? num(misc, 'mutation_seed', where)
          : numOr(misc, 'rule_seed', 0.0, where),
      sensorGain: num(sensor, 'gain', where),
      sensorAngle: num(sensor, 'angle', where),
      sensorDistance: num(sensor, 'distance', where),
      mutationScale: num(sensor, 'mutation_scale', where),
      globalForceMult: num(force, 'global_mult', where),
      drag: num(force, 'drag', where),
      strafePower: num(force, 'strafe', where),
      axialForce: num(force, 'axial', where),
      lateralForce: num(misc, 'lateral', where),
      hazardRate: num(misc, 'hazard_rate', where),
    },
    {
      // Added after the format shipped: files predating gravity have no
      // `force2`, and zero means "no pull", which is what they meant.
      gravityForce: numOr(force2, 'gravity_force', 0.0, where),
      gravityStrafe: numOr(force2, 'gravity_strafe', 0.0, where),
      // Likewise. IC_CENTER and no fences are what those files were doing.
      initialConditions: asInitialConditions(
        numOr(force2, 'initial_conditions', IC.CENTER, where),
        where,
      ),
      cohortFences: numOr(force2, 'cohort_fences', 0.0, where),
      // Also additive. A file with neither block predates particle colouring
      // entirely, and 0.5 is the middle of the slider -- the same default the
      // reference shipped, so those configs look like it intended.
      colorSensitivity: numOr(misc2, 'color_sensitivity', 0.5, where),
      colorByCohort: boolOr(misc2, 'color_by_cohort', false, where),
      // Zero means "no jitter", which is what a file written before these
      // existed was doing.
      sensorAngleJitter: numOr(misc2, 'sensor_angle_jitter', 0.0, where),
      sensorDistanceJitter: numOr(misc2, 'sensor_distance_jitter', 0.0, where),
      // A file with no `misc3` was written when gravity only ever pulled along
      // the fixed screen axis, which is what `false` means -- so those configs
      // keep falling exactly the way they did.
      radialGravity: boolOr(misc3, 'radial_gravity', false, where),
      rule: rule as readonly number[],
    },
  );
}

/** The camera block, if there is one. Each member independently optional. */
function cameraFromDocument(value: unknown): SavedCamera | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const camera: { pan?: readonly [number, number]; zoom?: number; mode?: string } = {};

  const pan = raw['pan'];
  if (
    Array.isArray(pan) &&
    pan.length === 2 &&
    pan.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    camera.pan = [pan[0] as number, pan[1] as number];
  }
  if (typeof raw['zoom'] === 'number' && Number.isFinite(raw['zoom'])) {
    camera.zoom = raw['zoom'];
  }
  if (typeof raw['mode'] === 'string') camera.mode = raw['mode'];

  return camera;
}

/**
 * Parse a v8 document. The port of `from_dict` + `_from_v8`
 * (`persistence.py:184-210`).
 *
 * `where` names the source in error messages -- a filename for a fetched preset,
 * a `(category, name)` for an IndexedDB record. Worth carrying because the
 * message is the only thing a user sees when a save will not load.
 */
export function fromDocument(data: unknown, where = 'config'): SavedConfig {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ConfigFormatError(`${where}: not a JSON object`);
  }
  const raw = data as Record<string, unknown>;

  const version = raw['version'];
  if (version !== FORMAT_VERSION) {
    throw new ConfigFormatError(
      `${where}: unrecognized config version ${String(version)}; expected ${FORMAT_VERSION}`,
    );
  }

  const worldRaw = required(raw, 'world', where);
  const configsRaw = raw['configs'];
  if (!Array.isArray(configsRaw)) {
    throw new ConfigFormatError(`${where}: missing or malformed "configs" list`);
  }
  if (configsRaw.length === 0) {
    // `persistence.py:200-201`. Caught here rather than downstream, where
    // `configs[0]` would be undefined and the failure would surface in the
    // packer as something unrelated.
    throw new ConfigFormatError(`${where}: "configs" is empty`);
  }

  const configs = configsRaw.map((c, i) =>
    configFromDocument(block(c), `${where}: configs[${i}]`),
  );

  const world = makeWorldSettings({
    trailPersistence: num(worldRaw, 'trail_persistence', where),
    trailDiffusion: num(worldRaw, 'trail_diffusion', where),
    // Added after the format shipped: files without it predate selectable
    // boundaries, and wrap is what they ran (`persistence.py:205-207`).
    boundaryConditions: asBoundaryCondition(
      numOr(worldRaw, 'boundary_conditions', BC.WRAP, where),
      where,
    ),
  });

  return {
    configs,
    world,
    camera: cameraFromDocument(raw['camera']),
    notes: typeof raw['notes'] === 'string' ? raw['notes'] : '',
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** One `ConfigData` entry, grouped to mirror the GLSL struct's vec4 lanes. */
function configToDocument(config: SimulationConfig): unknown {
  return {
    rule: [...config.rule],
    sensor: {
      gain: config.sensorGain,
      angle: config.sensorAngle,
      distance: config.sensorDistance,
      mutation_scale: config.mutationScale,
    },
    force: {
      global_mult: config.globalForceMult,
      drag: config.drag,
      strafe: config.strafePower,
      axial: config.axialForce,
    },
    misc: {
      lateral: config.lateralForce,
      hazard_rate: config.hazardRate,
      cohorts: config.cohorts,
      mutation_seed: config.mutationSeed,
    },
    force2: {
      gravity_force: config.gravityForce,
      gravity_strafe: config.gravityStrafe,
      initial_conditions: config.initialConditions,
      cohort_fences: config.cohortFences,
    },
    misc2: {
      color_sensitivity: config.colorSensitivity,
      color_by_cohort: config.colorByCohort,
      sensor_angle_jitter: config.sensorAngleJitter,
      sensor_distance_jitter: config.sensorDistanceJitter,
    },
    misc3: {
      radial_gravity: config.radialGravity,
    },
  };
}

/**
 * Build a v8 document. The port of `to_dict` (`persistence.py:166-181`).
 *
 * WRITES THE WHOLE CONFIG BUFFER, not just the selected slot: saving only
 * config 0 was removed on the desktop because it silently dropped the others
 * (`project_commands.py:108-110`).
 *
 * `camera` and `notes` are OMITTED when absent rather than written as null,
 * matching the Python -- and the reader's "no camera means leave the camera
 * alone" contract depends on absence being distinguishable.
 */
export function toDocument(
  configs: readonly SimulationConfig[],
  world: WorldSettings,
  camera: SavedCamera | null = null,
  notes = '',
): unknown {
  const doc: Record<string, unknown> = {
    version: FORMAT_VERSION,
    world: {
      trail_persistence: world.trailPersistence,
      trail_diffusion: world.trailDiffusion,
      boundary_conditions: world.boundaryConditions,
    },
    configs: configs.map(configToDocument),
  };
  if (camera !== null) doc['camera'] = camera;
  if (notes) doc['notes'] = notes;
  return doc;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Characters Windows forbids in a filename. Kept for IndexedDB keys too. */
const FORBIDDEN = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|']);

/**
 * A user-typed name, made safe to use as a key. The port of
 * `sanitize_filename` (`persistence.py:310-318`).
 *
 * KEPT DESPITE THERE BEING NO FILESYSTEM, deliberately -- the plan says so
 * (`WEB_PORT_PLAN.md:667`) and the reason is that these names are still shown,
 * still typed, and still round-trip through a manifest that DOES name files. A
 * name that is legal here is legal in both places.
 *
 * REMOVES rather than replaces, so "a/b" becomes "ab" exactly as on the desktop
 * -- substituting an underscore would make two different names collide.
 *
 * CAN RETURN THE EMPTY STRING, and the caller must check: a name of "..." has no
 * usable characters left, and writing a record under an empty key would make it
 * unreachable from the menu.
 */
export function sanitizeName(name: string): string {
  const cleaned = [...name.trim()].filter((c) => !FORBIDDEN.has(c)).join('').trim();
  // Windows dislikes trailing dots; harmless for a key, kept so a name that
  // round-trips through the manifest keeps its identity.
  return cleaned.replace(/\.+$/, '').slice(0, 120);
}
