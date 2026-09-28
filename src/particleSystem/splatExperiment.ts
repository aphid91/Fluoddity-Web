/**
 * EXPERIMENT: two ways to cut the brush splat's cost, which dominates on fast
 * hardware at high physics rates.
 *
 * ## Atomic splat
 *
 * The desktop's atomic deposit (Fluoddity `experiments2`, ca7b4a5) on the web:
 * each live particle adds its trail deposit to a fixed-point accumulator with
 * `atomicAdd` at the end of the entity update, and the canvas pass drains it.
 * No brush pass is recorded at all. The pixel and amount are brush.wgsl's own,
 * so trails match in expectation; the deposit moves from the brush-splat timing
 * into entity-update, and the drain into canvas-update.
 *
 * A pipeline constant on both shaders, so switching it rebuilds those two
 * pipelines and (re)allocates the accumulator.
 *
 * ## Monte Carlo cull
 *
 * The brush pass drops each particle with probability p and scales the
 * survivors by 1/(1-p): the same expected splat, fewer points, more noise. A
 * uniform rather than a constant, so the slider moves without a rebuild. The
 * raster path only -- the atomic path does not read it.
 *
 * TEMPORARY. Meant to be reverted once the question is answered.
 */

export interface SplatExperiment {
  readonly atomicSplat: boolean;
  /** Probability of dropping a particle's splat, 0 <= p <= MAX_CULL. */
  readonly cullProbability: number;
}

/** Past this the 1/(1-p) boost makes single splats huge; the slider stops here. */
export const MAX_CULL = 0.95;

export const NO_SPLAT_EXPERIMENT: SplatExperiment = Object.freeze({
  atomicSplat: false,
  cullProbability: 0,
});

export function sameSplatExperiment(a: SplatExperiment, b: SplatExperiment): boolean {
  return a.atomicSplat === b.atomicSplat && a.cullProbability === b.cullProbability;
}

/** One line for the `?debug` overlay, so a reading is labelled with what produced it. */
export function describeSplatExperiment(e: SplatExperiment): string {
  const parts: string[] = [];
  if (e.atomicSplat) parts.push('atomic-splat');
  if (e.cullProbability > 0) parts.push(`cull p=${e.cullProbability.toFixed(2)}`);
  return parts.length === 0 ? 'off' : parts.join(' ');
}
