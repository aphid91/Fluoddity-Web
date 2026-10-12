/**
 * The NCA save format: reader, writer, and filename sanitizer.
 *
 * PURE. No fetch, no IndexedDB, no DOM -- it turns a parsed JSON document into a
 * `SavedConfig` and back, so the whole format is testable under `node --test`
 * and the storage layers above (`manifest.ts`, `idb.ts`, `configStore.ts`) hold
 * no knowledge of it. There is exactly one interpreter of these bytes, whether
 * they came off the network, out of a database, or out of a share link.
 *
 * ## The document
 *
 *     {
 *       "format": "nca", "version": 1,
 *       "world": { "boundary": "wrap", "display_mode": "signed", ... },
 *       "configs": [{
 *         "architecture": { "channels": 8, "hidden": 32, "perception": "fixed", ... },
 *         "activation": "relu",
 *         "dynamics": { "dt": 0.5, "fire_rate": 0.5, ... },
 *         "mutation": { "scale": 0.2, "seed": 0.5, "cohorts": 9, "cohort_fences": true },
 *         "initial_conditions": { "mode": "seed", "seed_radius": 2, ... },
 *         "weights": [ ... ]            // or "weights_b64", or null = generated
 *       }],
 *       "notes": "..."
 *     }
 *
 * Enums are written as NAMES so a file is readable and hand-editable; the
 * reader also accepts the numeric index. Weights are a plain array for small
 * networks and little-endian f32 base64 (`weights_b64`) above
 * `INLINE_WEIGHTS_MAX`, where a JSON array would be several times larger.
 * The layout is `paramLayout.ts`'s -- PyTorch Growing-NCA order.
 *
 * ## Tolerant reads
 *
 * Every field falls back to `NCA_CONFIG_DEFAULTS` / `NCA_WORLD_DEFAULTS`, so a
 * hand-written file need only say what it changes. Weights whose length does
 * not match the architecture are dropped to `null` (generated) rather than
 * misread: a misaligned network would load as a plausible-looking wrong one.
 *
 * Particle-era (v8/v9) Fluoddity files are rejected with a clear error.
 */

import {
  ACTIVATION,
  BOUNDARY,
  DISPLAY,
  IC,
  NCA_CONFIG_DEFAULTS,
  NCA_WORLD_DEFAULTS,
  PERCEPTION,
  STATE_BOUND,
  type NcaConfig,
  type NcaWorld,
  archOf,
} from '../nca/ncaConfig.ts';
import { paramCount } from '../nca/paramLayout.ts';

export const FORMAT_NAME = 'nca';
export const FORMAT_VERSION = 1;

/** Above this many parameters, weights are written as base64 f32. */
export const INLINE_WEIGHTS_MAX = 256;

/** Thrown for anything this reader will not accept. */
export class ConfigFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigFormatError';
  }
}

/** A parsed save file. */
export interface SavedConfig {
  readonly configs: readonly NcaConfig[];
  readonly world: NcaWorld;
  readonly notes: string;
}

// ---------------------------------------------------------------------------
// Enum names
// ---------------------------------------------------------------------------

const NAMES = {
  perception: { fixed: PERCEPTION.FIXED, learned: PERCEPTION.LEARNED },
  activation: { relu: ACTIVATION.RELU, tanh: ACTIVATION.TANH, sin: ACTIVATION.SIN },
  stateBound: {
    none: STATE_BOUND.NONE,
    clip: STATE_BOUND.CLIP,
    clip01: STATE_BOUND.CLIP01,
    tanh: STATE_BOUND.TANH,
  },
  ic: { seed: IC.SEED, noise: IC.NOISE, sparse: IC.SPARSE, zero: IC.ZERO },
  boundary: { wrap: BOUNDARY.WRAP, zero: BOUNDARY.ZERO },
  display: { rgb: DISPLAY.RGB, rgba: DISPLAY.RGBA, signed: DISPLAY.SIGNED, channel: DISPLAY.CHANNEL },
} as const;

type EnumTable = Readonly<Record<string, number>>;

function nameOf(table: EnumTable, value: number): string {
  for (const [name, v] of Object.entries(table)) if (v === value) return name;
  return Object.keys(table)[0]!;
}

function enumOf(table: EnumTable, value: unknown, fallback: number): number {
  if (typeof value === 'string' && value in table) return table[value]!;
  if (typeof value === 'number' && Object.values(table).includes(value)) return value;
  return fallback;
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

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return fallback;
}

export function encodeWeights(weights: readonly number[]): string {
  const bytes = new Uint8Array(Float32Array.from(weights).buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function decodeWeights(b64: string): number[] {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return Array.from(new Float32Array(bytes.buffer, 0, Math.floor(bytes.length / 4)));
}

function readWeights(raw: Record<string, unknown>, where: string): number[] | null {
  if (typeof raw['weights_b64'] === 'string') {
    try {
      return decodeWeights(raw['weights_b64']);
    } catch {
      throw new ConfigFormatError(`${where}: weights_b64 is not valid base64`);
    }
  }
  const w = raw['weights'];
  if (w === null || w === undefined) return null;
  if (!Array.isArray(w) || !w.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw new ConfigFormatError(`${where}: weights must be an array of finite numbers`);
  }
  return (w as number[]).map((v) => Math.fround(v));
}

function configFromDocument(raw: unknown, where: string): NcaConfig {
  const r = block(raw);
  const d = NCA_CONFIG_DEFAULTS;
  const arch = block(r['architecture']);
  const dyn = block(r['dynamics']);
  const mut = block(r['mutation']);
  const ic = block(r['initial_conditions']);

  const shape = archOf({
    channels: num(arch['channels'], d.channels),
    hidden: num(arch['hidden'], d.hidden),
    perception: enumOf(NAMES.perception, arch['perception'], d.perception),
    learnedKernels: num(arch['learned_kernels'], d.learnedKernels),
    laplacian: bool(arch['laplacian'], d.laplacian),
  });

  let weights = readWeights(r, where);
  if (weights !== null && weights.length !== paramCount(shape)) {
    console.warn(
      `${where}: ${weights.length} weights do not fit the architecture ` +
        `(${paramCount(shape)} expected); loading as generated.`,
    );
    weights = null;
  }

  return {
    ...shape,
    activation: enumOf(NAMES.activation, r['activation'], d.activation),
    weights,
    mutationScale: num(mut['scale'], d.mutationScale),
    mutationSeed: num(mut['seed'], d.mutationSeed),
    cohorts: Math.max(1, Math.round(num(mut['cohorts'], d.cohorts))),
    cohortFences: bool(mut['cohort_fences'], d.cohortFences),
    dt: num(dyn['dt'], d.dt),
    fireRate: num(dyn['fire_rate'], d.fireRate),
    gain: num(dyn['gain'], d.gain),
    stateBound: enumOf(NAMES.stateBound, dyn['state_bound'], d.stateBound),
    leak: num(dyn['leak'], d.leak),
    noise: num(dyn['noise'], d.noise),
    aliveMask: bool(dyn['alive_mask'], d.aliveMask),
    aliveThreshold: num(dyn['alive_threshold'], d.aliveThreshold),
    initialConditions: enumOf(NAMES.ic, ic['mode'], d.initialConditions),
    seedRadius: num(ic['seed_radius'], d.seedRadius),
    icAmplitude: num(ic['amplitude'], d.icAmplitude),
    icDensity: num(ic['density'], d.icDensity),
    icSeed: num(ic['seed'], d.icSeed),
  };
}

function worldFromDocument(raw: unknown): NcaWorld {
  const w = block(raw);
  const d = NCA_WORLD_DEFAULTS;
  return {
    boundary: enumOf(NAMES.boundary, w['boundary'], d.boundary),
    displayMode: enumOf(NAMES.display, w['display_mode'], d.displayMode),
    displayChannel: Math.max(0, Math.round(num(w['display_channel'], d.displayChannel))),
    displayGain: num(w['display_gain'], d.displayGain),
    showCohortBorders: bool(w['show_cohort_borders'], d.showCohortBorders),
    scrollX: num(w['scroll_x'], d.scrollX),
    scrollY: num(w['scroll_y'], d.scrollY),
  };
}

/** Parse a document. Throws `ConfigFormatError` for anything unreadable. */
export function fromDocument(data: unknown, where = 'config'): SavedConfig {
  const doc = block(data);
  if (doc['format'] !== FORMAT_NAME) {
    if (typeof doc['version'] === 'number' && 'configs' in doc) {
      throw new ConfigFormatError(
        `${where}: this is a particle-era Fluoddity file (v${String(doc['version'])}); ` +
          'the NCA studio cannot load it.',
      );
    }
    throw new ConfigFormatError(`${where}: not an NCA document`);
  }
  if (doc['version'] !== FORMAT_VERSION) {
    throw new ConfigFormatError(`${where}: unsupported NCA format version ${String(doc['version'])}`);
  }
  const rawConfigs = doc['configs'];
  if (!Array.isArray(rawConfigs) || rawConfigs.length === 0) {
    throw new ConfigFormatError(`${where}: no configs`);
  }
  return {
    configs: rawConfigs.map((c, i) => configFromDocument(c, `${where} config ${i}`)),
    world: worldFromDocument(doc['world']),
    notes: typeof doc['notes'] === 'string' ? doc['notes'] : '',
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function configToDocument(c: NcaConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {
    architecture: {
      channels: c.channels,
      hidden: c.hidden,
      perception: nameOf(NAMES.perception, c.perception),
      learned_kernels: c.learnedKernels,
      laplacian: c.laplacian,
    },
    activation: nameOf(NAMES.activation, c.activation),
    dynamics: {
      dt: c.dt,
      fire_rate: c.fireRate,
      gain: c.gain,
      state_bound: nameOf(NAMES.stateBound, c.stateBound),
      leak: c.leak,
      noise: c.noise,
      alive_mask: c.aliveMask,
      alive_threshold: c.aliveThreshold,
    },
    mutation: {
      scale: c.mutationScale,
      seed: c.mutationSeed,
      cohorts: c.cohorts,
      cohort_fences: c.cohortFences,
    },
    initial_conditions: {
      mode: nameOf(NAMES.ic, c.initialConditions),
      seed_radius: c.seedRadius,
      amplitude: c.icAmplitude,
      density: c.icDensity,
      seed: c.icSeed,
    },
  };
  if (c.weights === null) out['weights'] = null;
  else if (c.weights.length > INLINE_WEIGHTS_MAX) out['weights_b64'] = encodeWeights(c.weights);
  else out['weights'] = Array.from(c.weights);
  return out;
}

export function toDocument(
  configs: readonly NcaConfig[],
  world: NcaWorld,
  notes = '',
): unknown {
  const doc: Record<string, unknown> = {
    format: FORMAT_NAME,
    version: FORMAT_VERSION,
    world: {
      boundary: nameOf(NAMES.boundary, world.boundary),
      display_mode: nameOf(NAMES.display, world.displayMode),
      display_channel: world.displayChannel,
      display_gain: world.displayGain,
      show_cohort_borders: world.showCohortBorders,
      scroll_x: world.scrollX,
      scroll_y: world.scrollY,
    },
    configs: configs.map(configToDocument),
  };
  if (notes) doc['notes'] = notes;
  return doc;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Characters Windows forbids in a filename. Kept for IndexedDB keys too. */
const FORBIDDEN = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|']);

/**
 * A user-typed name, made safe to use as a key. REMOVES rather than replaces,
 * so two different names cannot collide. CAN RETURN THE EMPTY STRING, and the
 * caller must check.
 */
export function sanitizeName(name: string): string {
  const cleaned = [...name.trim()].filter((c) => !FORBIDDEN.has(c)).join('').trim();
  return cleaned.replace(/\.+$/, '').slice(0, 120);
}
