/**
 * The shipped presets, as values the simulation can run.
 *
 * ===========================================================================
 * TEMPORARY. TODO(Step 9): DELETE THIS FILE AND presets.generated.json.
 * ===========================================================================
 * Step 9 owns config storage: a build-time `manifest.json` fetched read-only
 * plus IndexedDB for user saves, both behind a real v8 reader. NONE of that is
 * here -- there is no fetch, no directory enumeration, no version dispatch, no
 * `sanitize_filename`, and above all NO PARSER. Step 4 only needs real numbers
 * to compare against the desktop, and a parser written here would be the shape
 * Step 9 inherited.
 *
 * When Step 9 lands this is a clean subtraction: delete this file, delete
 * `presets.generated.json`, and drop `build_presets` from
 * `web/tools/generate_web_data.py`.
 *
 * ## Why the values come from Python rather than from the .json directly
 *
 * The saved format uses a THIRD set of names again (`sensor.gain`,
 * `force.global_mult`) -- neither the Python's `snake_case` nor this port's
 * `camelCase`. `persistence.load()` is what maps them onto `SimulationConfig`
 * and fills in defaults for fields a given file predates. So the generator
 * ships what the desktop actually RUNS, which is the other half of the A/B,
 * rather than a hand transcription of what the file says. Transcription is the
 * error class the parity goldens exist to eliminate; this follows the same rule.
 */

import presetsJson from './presets.generated.json' with { type: 'json' };
import {
  type BoundaryCondition,
  type InitialConditions,
  type SimulationConfig,
  type WorldSettings,
  BC,
  IC,
  makeSimulationConfig,
  makeWorldSettings,
} from './config.ts';

/** One preset: the config, the world settings, and how many configs it saved. */
export interface Preset {
  readonly name: string;
  readonly config: SimulationConfig;
  readonly world: WorldSettings;
}

/**
 * The generated shape. Declared rather than inferred from the JSON import so a
 * regenerated file with a changed shape fails here, at the boundary, instead of
 * surfacing as `undefined` somewhere in the packing code.
 */
interface GeneratedPreset {
  readonly config: Record<string, unknown>;
  readonly world: {
    readonly trailPersistence: number;
    readonly trailDiffusion: number;
    readonly boundaryConditions: number;
  };
  readonly configCount: number;
}

const generated = presetsJson.presets as unknown as Readonly<
  Record<string, GeneratedPreset>
>;

/**
 * Narrow a generated number to a `BoundaryCondition`.
 *
 * The generator writes whatever the desktop enum holds, and TypeScript cannot
 * check a JSON number against a union. Validating here means a renumbered enum
 * is a loud failure rather than a silently wrong boundary mode -- which per
 * invariant 9 would look like a physics quirk, not like an error.
 */
function asBoundaryCondition(value: number): BoundaryCondition {
  const valid: readonly number[] = [BC.BOUNCE, BC.WRAP, BC.RESET];
  if (!valid.includes(value)) {
    throw new Error(
      `presets.generated.json has boundaryConditions ${value}, which is not a ` +
        `BC_* mode. Either common.glsl renumbered them or the file is stale -- ` +
        `regenerate with \`npm run gen:web-data\`.`,
    );
  }
  return value as BoundaryCondition;
}

/** Same, for the initial-conditions enum. */
function asInitialConditions(value: number): InitialConditions {
  const valid: readonly number[] = [IC.GRID, IC.RANDOM, IC.CENTER, IC.RING];
  if (!valid.includes(value)) {
    throw new Error(
      `presets.generated.json has initialConditions ${value}, which is not an ` +
        `IC_* mode. Either common.glsl renumbered them or the file is stale -- ` +
        `regenerate with \`npm run gen:web-data\`.`,
    );
  }
  return value as InitialConditions;
}

function num(raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`preset field "${key}" is not a finite number: ${String(value)}`);
  }
  return value;
}

function bool(raw: Record<string, unknown>, key: string): boolean {
  const value = raw[key];
  if (typeof value !== 'boolean') {
    throw new Error(`preset field "${key}" is not a boolean: ${String(value)}`);
  }
  return value;
}

/**
 * Build a `SimulationConfig` from the generated record.
 *
 * Goes through `makeSimulationConfig` rather than casting the JSON, so the
 * defaults in `config.ts:202` apply to anything the generator omitted -- the
 * same compatibility contract a real reader would honour.
 */
function toConfig(raw: Record<string, unknown>): SimulationConfig {
  const rule = raw['rule'];
  if (!Array.isArray(rule) || rule.some((n) => typeof n !== 'number')) {
    throw new Error('preset field "rule" is not an array of numbers');
  }

  return makeSimulationConfig(
    {
      cohorts: num(raw, 'cohorts'),
      mutationSeed: num(raw, 'mutationSeed'),
      sensorGain: num(raw, 'sensorGain'),
      sensorAngle: num(raw, 'sensorAngle'),
      sensorDistance: num(raw, 'sensorDistance'),
      mutationScale: num(raw, 'mutationScale'),
      globalForceMult: num(raw, 'globalForceMult'),
      drag: num(raw, 'drag'),
      strafePower: num(raw, 'strafePower'),
      axialForce: num(raw, 'axialForce'),
      lateralForce: num(raw, 'lateralForce'),
      hazardRate: num(raw, 'hazardRate'),
    },
    {
      gravityForce: num(raw, 'gravityForce'),
      gravityStrafe: num(raw, 'gravityStrafe'),
      initialConditions: asInitialConditions(num(raw, 'initialConditions')),
      cohortFences: num(raw, 'cohortFences'),
      colorSensitivity: num(raw, 'colorSensitivity'),
      colorByCohort: bool(raw, 'colorByCohort'),
      sensorAngleJitter: num(raw, 'sensorAngleJitter'),
      sensorDistanceJitter: num(raw, 'sensorDistanceJitter'),
      radialGravity: bool(raw, 'radialGravity'),
      rule: rule as readonly number[],
    },
  );
}

/** Every shipped preset, keyed by filename stem. */
export const PRESETS: Readonly<Record<string, Preset>> = Object.freeze(
  Object.fromEntries(
    Object.entries(generated).map(([name, entry]) => [
      name,
      {
        name,
        config: toConfig(entry.config),
        world: makeWorldSettings({
          trailPersistence: entry.world.trailPersistence,
          trailDiffusion: entry.world.trailDiffusion,
          boundaryConditions: asBoundaryCondition(entry.world.boundaryConditions),
        }),
      } satisfies Preset,
    ]),
  ),
);

/**
 * The preset the app opens with -- the desktop's own default
 * (`particle_system.py:45`), so both halves of the A/B start on the same thing.
 */
export const DEFAULT_PRESET_NAME = 'Starcrossedv8';

/** Look up a preset by name, failing loudly rather than returning undefined. */
export function preset(name: string): Preset {
  const found = PRESETS[name];
  if (found === undefined) {
    throw new Error(
      `no preset named "${name}". Available: ${Object.keys(PRESETS).join(', ')}`,
    );
  }
  return found;
}

/** The default preset, resolved. */
export function defaultPreset(): Preset {
  return preset(DEFAULT_PRESET_NAME);
}
