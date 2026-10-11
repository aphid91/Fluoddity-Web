/**
 * The CPU reference implementation of one NCA step and of the initial
 * conditions. THE SPEC the generated shaders (`ncaShaders.ts`) implement.
 *
 * Slow and clear on purpose: it exists for tests (determinism, the
 * architecture embed's behaviour preservation, fences) and for the in-browser
 * GPU parity check (`tools/ncaParityCheck.mjs`). The fire mask, the noise and
 * the initial conditions use the same hashes as the GPU, so the two agree to
 * f32 rounding.
 *
 * State layout: `state[(y * W + x) * C + c]`.
 */

import { type CohortRect, cohortIndexMap, cohortRects, neighbourIndex } from './cohortLayout.ts';
import {
  ACTIVATION,
  BOUNDARY,
  IC,
  type NcaConfig,
  PERCEPTION,
  STATE_BOUND,
  archOf,
} from './ncaConfig.ts';
import { FIXED_KERNELS, paramLayout } from './paramLayout.ts';
import { SALT, hash3, seedToU32, unit } from './rng.ts';

/** Largest seed radius honoured, in cells. Bounds the init shader's loop. */
export const MAX_SEED_RADIUS = 16;
/** |state| clamp under STATE_BOUND.NONE, so a runaway network stays finite. */
export const UNBOUNDED_LIMIT = 1e4;
/** tanh's argument clamp: WGSL's tanh can overflow to NaN for large |x|. */
export const TANH_CLAMP = 15;

export interface GridContext {
  readonly W: number;
  readonly H: number;
  readonly config: NcaConfig;
  readonly boundary: number;
  /** Optional per-cell wall mask: non-zero cells are held at zero. */
  readonly walls?: Uint8Array | null;
}

interface Prepared {
  readonly C: number;
  readonly rects: CohortRect[];
  readonly map: Uint32Array;
  readonly seed: number;
}

function prepare(ctx: GridContext): Prepared {
  const C = archOf(ctx.config).channels;
  const n = Math.max(1, Math.round(ctx.config.cohorts));
  return {
    C,
    rects: cohortRects(n, ctx.W, ctx.H),
    map: cohortIndexMap(n, ctx.W, ctx.H),
    seed: seedToU32(ctx.config.icSeed),
  };
}

function neighbour(ctx: GridContext, p: Prepared, x: number, y: number, dx: number, dy: number): number {
  const fenced = ctx.config.cohortFences ? p.rects[p.map[y * ctx.W + x]!]! : null;
  return neighbourIndex(x, y, dx, dy, ctx.W, ctx.H, fenced, ctx.boundary === BOUNDARY.WRAP);
}

export function activate(kind: number, x: number): number {
  switch (kind) {
    case ACTIVATION.TANH:
      return Math.tanh(Math.max(-TANH_CLAMP, Math.min(TANH_CLAMP, x)));
    case ACTIVATION.SIN:
      return Math.sin(x);
    default:
      return Math.max(0, x);
  }
}

export function bound(kind: number, v: number): number {
  if (Number.isNaN(v)) return 0;
  switch (kind) {
    case STATE_BOUND.CLIP:
      return Math.max(-1, Math.min(1, v));
    case STATE_BOUND.CLIP01:
      return Math.max(0, Math.min(1, v));
    case STATE_BOUND.TANH:
      return Math.tanh(Math.max(-TANH_CLAMP, Math.min(TANH_CLAMP, v)));
    default:
      return Math.max(-UNBOUNDED_LIMIT, Math.min(UNBOUNDED_LIMIT, v));
  }
}

/** The initial state. */
export function cpuInit(ctx: GridContext): Float32Array {
  const p = prepare(ctx);
  const { W, H, config } = ctx;
  const C = p.C;
  const state = new Float32Array(W * H * C);
  const amp = config.icAmplitude;
  const r = Math.max(0, Math.min(MAX_SEED_RADIUS, Math.round(config.seedRadius)));
  const r2 = r * r;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (ctx.walls?.[idx]) continue;
      let lit = false;
      switch (config.initialConditions) {
        case IC.SEED: {
          const rect = p.rects[p.map[idx]!]!;
          const cx = rect.x0 + Math.floor(rect.w / 2);
          const cy = rect.y0 + Math.floor(rect.h / 2);
          lit = (x - cx) ** 2 + (y - cy) ** 2 <= r2;
          break;
        }
        case IC.NOISE:
          for (let c = 0; c < C; c++) {
            const u = unit(hash3(idx * C + c, 0, p.seed ^ SALT.ic));
            state[idx * C + c] = Math.fround(amp * (2 * u - 1));
          }
          break;
        case IC.SPARSE: {
          // Lit when ANY seed centre lies within the radius, reached the same
          // way a step reaches neighbours (fences and boundary included).
          const density = Math.fround(config.icDensity);
          for (let dy = -r; dy <= r && !lit; dy++) {
            for (let dx = -r; dx <= r && !lit; dx++) {
              if (dx * dx + dy * dy > r2) continue;
              const n = neighbour(ctx, p, x, y, dx, dy);
              if (n < 0) continue;
              lit = unit(hash3(n, 0, p.seed ^ SALT.icSparse)) < density;
            }
          }
          break;
        }
        default:
          break;
      }
      if (lit) for (let c = 0; c < C; c++) state[idx * C + c] = Math.fround(amp);
    }
  }
  return state;
}

/**
 * One step. `weights` holds every cohort's vector back to back
 * (`allCohortWeights`); `step` is the step counter since reset, which keys the
 * fire mask and noise.
 */
export function cpuStep(
  state: Float32Array,
  weights: Float32Array,
  step: number,
  ctx: GridContext,
): Float32Array {
  const p = prepare(ctx);
  const { W, H, config } = ctx;
  const arch = archOf(config);
  const layout = paramLayout(arch);
  const C = p.C;
  const Hn = layout.hidden;
  const P = layout.features;
  const stride = layout.count;
  const off = (name: string): number => layout.tensors.find((t) => t.name === name)?.offset ?? 0;
  const learned = arch.perception === PERCEPTION.LEARNED;
  const kinds = layout.kinds;
  const aliveCh = Math.min(3, C - 1);
  const fireRate = Math.fround(config.fireRate);

  const out = new Float32Array(state.length);
  const feats = new Float64Array(P);
  const taps = new Float64Array(9);
  const delta = new Float64Array(C);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (ctx.walls?.[idx]) continue; // walls hold zero

      const nb: number[] = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) nb.push(neighbour(ctx, p, x, y, dx, dy));
      }
      const read = (n: number, c: number): number => (n < 0 ? 0 : state[n * C + c]!);

      const w = p.map[idx]! * stride;

      // Perception.
      for (let c = 0; c < C; c++) {
        for (let t = 0; t < 9; t++) taps[t] = read(nb[t]!, c);
        kinds.forEach((kind, k) => {
          let v: number;
          if (kind === 'id') v = taps[4]!;
          else if (learned) {
            const kk = k - 1; // kinds are ['id', 'k0', ...]
            const base = w + off('perc') + (kk * C + c) * 9;
            v = 0;
            for (let t = 0; t < 9; t++) v += weights[base + t]! * taps[t]!;
          } else {
            const kernel = FIXED_KERNELS[kind as 'sx' | 'sy' | 'lap'];
            v = 0;
            for (let t = 0; t < 9; t++) v += kernel[t]! * taps[t]!;
          }
          feats[k * C + c] = v;
        });
      }

      // Update network.
      delta.fill(0);
      if (Hn > 0) {
        const w0 = w + off('fc0.w');
        const b0 = w + off('fc0.b');
        const w1 = w + off('fc1.w');
        const b1 = w + off('fc1.b');
        for (let h = 0; h < Hn; h++) {
          let acc = weights[b0 + h]!;
          for (let f = 0; f < P; f++) acc += weights[w0 + h * P + f]! * feats[f]!;
          const a = activate(config.activation, config.gain * acc);
          for (let c = 0; c < C; c++) delta[c] = delta[c]! + weights[w1 + c * Hn + h]! * a;
        }
        for (let c = 0; c < C; c++) delta[c] = delta[c]! + weights[b1 + c]!;
      } else {
        const wf = w + off('fc.w');
        const bf = w + off('fc.b');
        for (let c = 0; c < C; c++) {
          let acc = weights[bf + c]!;
          for (let f = 0; f < P; f++) acc += weights[wf + c * P + f]! * feats[f]!;
          delta[c] = activate(config.activation, config.gain * acc);
        }
      }

      const fire = unit(hash3(idx, step >>> 0, p.seed ^ SALT.fire)) < fireRate;

      let alive = true;
      if (config.aliveMask) {
        let m = -Infinity;
        for (let t = 0; t < 9; t++) m = Math.max(m, read(nb[t]!, aliveCh));
        alive = m > config.aliveThreshold;
      }

      for (let c = 0; c < C; c++) {
        let v = state[idx * C + c]!;
        if (fire) v += config.dt * delta[c]!;
        v *= 1 - config.leak;
        if (config.noise !== 0) {
          const u = unit(hash3(idx * C + c, step >>> 0, p.seed ^ SALT.noise));
          v += config.noise * (2 * u - 1);
        }
        v = bound(config.stateBound, v);
        out[idx * C + c] = alive ? v : 0;
      }
    }
  }
  return out;
}
