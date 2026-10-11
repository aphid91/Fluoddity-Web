/**
 * Weight generation, mutation and architecture embedding. All host-side, all
 * deterministic.
 *
 * ## Why mutation moved off the GPU
 *
 * The particle studio derived each cohort's rule inside a shader and read the
 * winner back through the pick buffer. Here a cohort's weights are a pure
 * function of `(config, cohort)`, so selecting one is `cohortWeights(cfg, k)`
 * on the host -- no readback, no GPU-only lineage, and the same numbers in a
 * test, a save file and on screen.
 */

import { type NcaArch, type NcaConfig, PERCEPTION, archOf } from './ncaConfig.ts';
import {
  FIXED_KERNELS,
  type FeatureKind,
  type ParamLayout,
  type Tensor,
  paramLayout,
} from './paramLayout.ts';
import { SALT, gaussian, hash3, seedToU32 } from './rng.ts';

/** A fresh random network for `arch`, keyed by a u32 seed. */
export function initWeights(arch: NcaArch, seed: number): Float32Array<ArrayBuffer> {
  const layout = paramLayout(arch);
  const out = new Float32Array(layout.count);
  layout.tensors.forEach((t, ti) => {
    for (let i = 0; i < t.size; i++) {
      out[t.offset + i] = t.initStd * gaussian(seed >>> 0, ti ^ SALT.init, i);
    }
  });
  return out;
}

/** Whether `weights` is a usable base vector for `arch`. */
export function weightsFit(weights: readonly number[] | null, arch: NcaArch): boolean {
  return weights !== null && weights.length === paramLayout(arch).count;
}

/**
 * Cohort `k`'s weights.
 *
 *  - GENERATED (`weights` null, or the wrong length for the architecture):
 *    a fresh network from `mutationSeed` and `k`.
 *  - Otherwise the base plus `mutationScale * tensor.std * N(0,1)` per
 *    parameter. EVERY cohort is mutated, cohort 0 included, matching the
 *    particle studio: with scale 0 they are all the base exactly.
 */
export function cohortWeights(config: NcaConfig, k: number): Float32Array<ArrayBuffer> {
  const arch = archOf(config);
  const seed = seedToU32(config.mutationSeed);
  if (!weightsFit(config.weights, arch)) {
    return initWeights(arch, hash3(seed, k >>> 0, SALT.init));
  }
  const base = config.weights!;
  const layout = paramLayout(arch);
  const out = Float32Array.from(base);
  const scale = config.mutationScale;
  if (scale === 0) return out;
  for (const t of layout.tensors) {
    const amp = scale * t.std;
    for (let i = 0; i < t.size; i++) {
      const j = t.offset + i;
      out[j] = base[j]! + amp * gaussian(seed ^ SALT.mutate, k >>> 0, j);
    }
  }
  return out;
}

/** Every cohort's weights back to back, `cohorts * paramCount` floats. */
export function allCohortWeights(config: NcaConfig): Float32Array<ArrayBuffer> {
  const count = paramLayout(config).count;
  const n = Math.max(1, Math.round(config.cohorts));
  const out = new Float32Array(n * count);
  for (let k = 0; k < n; k++) out.set(cohortWeights(config, k), k * count);
  return out;
}

/** Plain numbers, rounded to f32 -- the form a config stores. */
export function toStored(weights: Float32Array): number[] {
  return Array.from(weights);
}

// ---------------------------------------------------------------------------
// Architecture embedding
// ---------------------------------------------------------------------------

const FIXED_ORDER = ['sx', 'sy', 'lap'] as const;

/** The old kind a new kind inherits from, or -1. */
function sourceKind(kind: FeatureKind, oldKinds: readonly FeatureKind[]): number {
  const same = oldKinds.indexOf(kind);
  if (same >= 0) return same;
  // A learned kernel kN inherits fixed filter N, and vice versa -- so switching
  // FIXED -> LEARNED initialises the learned kernels AS the fixed filters, and
  // the network behaves identically until mutation moves them.
  if (kind.startsWith('k')) {
    const fixed = FIXED_ORDER[Number(kind.slice(1))];
    return fixed === undefined ? -1 : oldKinds.indexOf(fixed);
  }
  const n = FIXED_ORDER.indexOf(kind as (typeof FIXED_ORDER)[number]);
  return n < 0 ? -1 : oldKinds.indexOf(`k${n}`);
}

/**
 * Carry `old` (laid out for `oldArch`) into `newArch`'s layout.
 *
 * The overlap is copied and every new connection starts at ZERO, so growing
 * channels, hidden units, filters or kernels leaves the existing channels'
 * dynamics unchanged: a zero-weight, zero-bias hidden unit outputs act(0) = 0,
 * and a new channel's zero rows mean it neither moves nor is read. Mutation
 * then fills the new capacity in. Shrinking truncates and does change
 * behaviour.
 *
 * Returns null when the two layouts have no meaningful correspondence --
 * switching between `hidden == 0` (one layer) and `hidden > 0` (two) -- and
 * the caller should fall back to generated weights.
 *
 * FIXED -> LEARNED is exact: the learned kernels inherit the Sobel/Laplacian
 * taps. LEARNED -> FIXED maps kernel N onto fixed filter N, which is only
 * exact when the learned kernels still equal those filters.
 */
export function embedWeights(
  old: readonly number[],
  oldArch: NcaArch,
  newArch: NcaArch,
): number[] | null {
  const oL = paramLayout(oldArch);
  const nL = paramLayout(newArch);
  if (old.length !== oL.count) return null;
  if ((oL.hidden > 0) !== (nL.hidden > 0)) return null;

  const out = new Float32Array(nL.count);
  const Co = oL.channels;
  const Cn = nL.channels;
  const Cmin = Math.min(Co, Cn);
  const t = tensorOffset;

  // Feature index map: new feature -> old feature, or -1.
  const fmap = new Int32Array(nL.features).fill(-1);
  nL.kinds.forEach((kind, nk) => {
    const ok = sourceKind(kind, oL.kinds);
    if (ok < 0) return;
    for (let c = 0; c < Cmin; c++) fmap[nk * Cn + c] = ok * Co + c;
  });

  // Learned kernels.
  if (nL.arch.perception === PERCEPTION.LEARNED) {
    const nOff = t(nL, 'perc');
    const K = nL.arch.learnedKernels;
    for (let k = 0; k < K; k++) {
      for (let c = 0; c < Cn; c++) {
        const dst = nOff + (k * Cn + c) * 9;
        if (c >= Co) continue; // new channel: zero kernel
        if (oL.arch.perception === PERCEPTION.LEARNED) {
          if (k < oL.arch.learnedKernels) {
            const src = t(oL, 'perc') + (k * Co + c) * 9;
            for (let i = 0; i < 9; i++) out[dst + i] = old[src + i]!;
          }
        } else {
          const fixed = FIXED_ORDER[k];
          if (fixed !== undefined && oL.kinds.includes(fixed)) {
            const taps = FIXED_KERNELS[fixed];
            for (let i = 0; i < 9; i++) out[dst + i] = taps[i]!;
          }
        }
      }
    }
  }

  if (nL.hidden > 0) {
    const Ho = oL.hidden;
    const Hn = nL.hidden;
    const Po = oL.features;
    const Pn = nL.features;
    const w0o = t(oL, 'fc0.w');
    const w0n = t(nL, 'fc0.w');
    for (let h = 0; h < Math.min(Ho, Hn); h++) {
      for (let f = 0; f < Pn; f++) {
        const of = fmap[f]!;
        if (of >= 0) out[w0n + h * Pn + f] = old[w0o + h * Po + of]!;
      }
      out[t(nL, 'fc0.b') + h] = old[t(oL, 'fc0.b') + h]!;
    }
    const w1o = t(oL, 'fc1.w');
    const w1n = t(nL, 'fc1.w');
    for (let c = 0; c < Cmin; c++) {
      for (let h = 0; h < Math.min(Ho, Hn); h++) {
        out[w1n + c * Hn + h] = old[w1o + c * Ho + h]!;
      }
      out[t(nL, 'fc1.b') + c] = old[t(oL, 'fc1.b') + c]!;
    }
  } else {
    const Po = oL.features;
    const Pn = nL.features;
    const wo = t(oL, 'fc.w');
    const wn = t(nL, 'fc.w');
    for (let c = 0; c < Cmin; c++) {
      for (let f = 0; f < Pn; f++) {
        const of = fmap[f]!;
        if (of >= 0) out[wn + c * Pn + f] = old[wo + c * Po + of]!;
      }
      out[t(nL, 'fc.b') + c] = old[t(oL, 'fc.b') + c]!;
    }
  }
  return Array.from(out);
}

function tensorOffset(layout: ParamLayout, name: Tensor['name']): number {
  const tensor = layout.tensors.find((x) => x.name === name);
  if (tensor === undefined) throw new Error(`no tensor ${name} in layout`);
  return tensor.offset;
}

/**
 * Apply an edit to an architecture field, carrying the weights across.
 *
 * Generated configs stay generated (there is nothing to carry). A layout with
 * no correspondence (see `embedWeights`) also becomes generated.
 */
export function withArchEdit(config: NcaConfig, next: NcaConfig): NcaConfig {
  if (config.weights === null) return next;
  const embedded = embedWeights(config.weights, archOf(config), archOf(next));
  return { ...next, weights: embedded };
}
