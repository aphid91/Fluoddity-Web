/**
 * The NCA's saved settings: what a project holds in place of the particle
 * system's `SimulationConfig` / `WorldSettings`.
 *
 * A PURE LEAF -- no GPU, no `.wgsl` -- so everything that reasons about configs
 * (the settings registry, persistence, mutation, the CPU reference step) can be
 * unit-tested under `node --test`.
 *
 * ## The model these fields describe
 *
 * A W x H grid of cells, each holding `channels` floats. Every step, each cell:
 *
 *   1. PERCEIVES its 3x3 neighbourhood per channel -- through fixed filters
 *      (identity, Sobel x/y, optional Laplacian) or through learned depthwise
 *      3x3 kernels plus identity. See `paramLayout.ts` for the feature order.
 *   2. Runs a tiny MLP on those features: P -> hidden -> channels (or a single
 *      P -> channels layer when `hidden` is 0).
 *   3. With probability `fireRate`, adds `dt * output` to its state.
 *
 * Each COHORT is a rectangle of the grid running its own weights -- the base
 * weights mutated by `mutationScale` with a per-cohort seed. See `weights.ts`.
 *
 * ## Config vs world
 *
 * The same split the particle studio drew (ARCHITECTURE.md "three kinds of
 * state"): `NcaConfig` is per population and holds the weights and everything
 * that shapes behaviour; `NcaWorld` is one per project and holds how the grid
 * is bounded and how it is drawn.
 */

/** How cells perceive their neighbourhood. */
export const PERCEPTION = { FIXED: 0, LEARNED: 1 } as const;

/** Hidden-layer nonlinearity. Index order is the shader's `ACT` constant. */
export const ACTIVATION = { RELU: 0, TANH: 1, SIN: 2 } as const;

/** What keeps the state finite. Index order is the shader's `BOUND` constant. */
export const STATE_BOUND = { NONE: 0, CLIP: 1, CLIP01: 2, TANH: 3 } as const;

/** Initial conditions. Index order is the init shader's `ic_mode`. */
export const IC = { SEED: 0, NOISE: 1, SPARSE: 2, ZERO: 3 } as const;

/** What a cell sees past the edge of the world (when fences are off). */
export const BOUNDARY = { WRAP: 0, ZERO: 1 } as const;

/** How channels become pixels. Index order is the display shader's mode. */
export const DISPLAY = { RGB: 0, RGBA: 1, SIGNED: 2, CHANNEL: 3 } as const;

/** Bounds the architecture is clamped to. Shared by the UI, loaders and tests. */
export const ARCH_LIMITS = {
  channels: [1, 32],
  hidden: [0, 256],
  learnedKernels: [1, 8],
} as const;

/** The constants that decide the SHAPE of the weight vector. */
export interface NcaArch {
  readonly channels: number;
  readonly hidden: number;
  readonly perception: number;
  /** Learned kernels per channel. Read only when `perception` is LEARNED. */
  readonly learnedKernels: number;
  /** Add a Laplacian to the fixed filters. Read only when `perception` is FIXED. */
  readonly laplacian: boolean;
}

export interface NcaConfig extends NcaArch {
  readonly activation: number;

  /**
   * The base weights, laid out by `paramLayout(this)`; or null.
   *
   * NULL IS "GENERATED": every cohort gets a fresh random network from
   * `mutationSeed + cohort`, which is what Randomize Behavior produces -- the
   * NCA's version of the particle studio's all-zero rule sentinel, but an
   * explicit value rather than a magic pattern.
   */
  readonly weights: readonly number[] | null;

  // --- mutation / selection ---
  readonly mutationScale: number;
  /** In [0,1); hashed to a u32. See `rng.ts`'s `seedToU32`. */
  readonly mutationSeed: number;
  readonly cohorts: number;
  /** Each cohort's rectangle becomes its own torus. */
  readonly cohortFences: boolean;

  // --- dynamics ---
  readonly dt: number;
  readonly fireRate: number;
  /** Multiplies the hidden pre-activation: the "edge of chaos" knob. */
  readonly gain: number;
  readonly stateBound: number;
  /** Per-step multiplicative decay toward zero. */
  readonly leak: number;
  /** Per-step uniform noise amplitude added to every channel. */
  readonly noise: number;
  /** Growing-NCA alive masking on channel min(3, C-1). */
  readonly aliveMask: boolean;
  readonly aliveThreshold: number;

  // --- initial conditions ---
  readonly initialConditions: number;
  /** Seed disc radius in cells (SEED and SPARSE). */
  readonly seedRadius: number;
  /** Value a seed writes / noise amplitude. */
  readonly icAmplitude: number;
  /** Probability a cell becomes a seed (SPARSE). */
  readonly icDensity: number;
  /** In [0,1). Seeds the initial conditions, the fire mask and the noise. */
  readonly icSeed: number;
}

export interface NcaWorld {
  readonly boundary: number;
  readonly displayMode: number;
  /** First channel shown. */
  readonly displayChannel: number;
  readonly displayGain: number;
  readonly showCohortBorders: boolean;
}

export const NCA_CONFIG_DEFAULTS: NcaConfig = Object.freeze({
  channels: 8,
  hidden: 32,
  perception: PERCEPTION.FIXED,
  learnedKernels: 2,
  laplacian: false,
  activation: ACTIVATION.RELU,
  weights: null,
  mutationScale: 0.2,
  mutationSeed: 0.5,
  cohorts: 9,
  cohortFences: true,
  dt: 0.5,
  fireRate: 0.5,
  gain: 1.0,
  stateBound: STATE_BOUND.CLIP,
  leak: 0.0,
  noise: 0.0,
  aliveMask: false,
  aliveThreshold: 0.1,
  initialConditions: IC.SEED,
  seedRadius: 2,
  icAmplitude: 1.0,
  icDensity: 0.002,
  icSeed: 0.25,
});

export const NCA_WORLD_DEFAULTS: NcaWorld = Object.freeze({
  boundary: BOUNDARY.WRAP,
  displayMode: DISPLAY.SIGNED,
  displayChannel: 0,
  displayGain: 1.0,
  showCohortBorders: true,
});

export function makeNcaConfig(overrides: Partial<NcaConfig> = {}): NcaConfig {
  return { ...NCA_CONFIG_DEFAULTS, ...overrides };
}

export function makeNcaWorld(overrides: Partial<NcaWorld> = {}): NcaWorld {
  return { ...NCA_WORLD_DEFAULTS, ...overrides };
}

function clampInt(v: number, [lo, hi]: readonly [number, number]): number {
  return Math.max(lo, Math.min(hi, Math.round(Number.isFinite(v) ? v : lo)));
}

/** The architecture of a config, clamped to `ARCH_LIMITS`. */
export function archOf(config: NcaArch): NcaArch {
  return {
    channels: clampInt(config.channels, ARCH_LIMITS.channels),
    hidden: clampInt(config.hidden, ARCH_LIMITS.hidden),
    perception: config.perception === PERCEPTION.LEARNED ? PERCEPTION.LEARNED : PERCEPTION.FIXED,
    learnedKernels: clampInt(config.learnedKernels, ARCH_LIMITS.learnedKernels),
    laplacian: !!config.laplacian,
  };
}

/** Whether two architectures produce the same weight layout and shader. */
export function sameArch(a: NcaArch, b: NcaArch): boolean {
  const x = archOf(a);
  const y = archOf(b);
  return (
    x.channels === y.channels &&
    x.hidden === y.hidden &&
    x.perception === y.perception &&
    (x.perception === PERCEPTION.FIXED
      ? x.laplacian === y.laplacian
      : x.learnedKernels === y.learnedKernels)
  );
}

/** The fields that, when edited, change the weight layout. */
export const ARCH_FIELDS: readonly (keyof NcaArch)[] = [
  'channels',
  'hidden',
  'perception',
  'learnedKernels',
  'laplacian',
];
