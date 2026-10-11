/**
 * Deterministic hashing shared bit-for-bit with the shaders.
 *
 * `pcgHash` is the same function as `pcg_hash` in `src/shaders/hash.wgsl` and
 * in `ncaShaders.ts`'s prelude -- u32 multiplies wrap identically under
 * `Math.imul`. That is what lets the CPU reference step reproduce the GPU's
 * fire mask, noise and initial conditions exactly, and what makes mutation a
 * pure host function: a cohort's weights are `f(base, seed, cohort)` with no
 * GPU readback.
 */

export function pcgHash(seed: number): number {
  const state = (Math.imul(seed >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

/** Three u32s in, one u32 out. The shader's `hash3`. */
export function hash3(a: number, b: number, c: number): number {
  return pcgHash((a ^ pcgHash((b ^ pcgHash(c >>> 0)) >>> 0)) >>> 0);
}

/**
 * A u32 hash as a float in [0,1), computed as the shader does: `f32(h)` rounds
 * to the nearest f32, then an exact power-of-two divide. The rounding can land
 * on 2^32, so the result is clamped below 1 on both sides.
 */
export function unit(h: number): number {
  return Math.min(Math.fround(h >>> 0) / 4294967296, 0.99999994);
}

/** A seed field in [0,1) -> the u32 the hashes consume. */
export function seedToU32(seed: number): number {
  const s = Number.isFinite(seed) ? seed - Math.floor(seed) : 0;
  return Math.floor(s * 4294967296) >>> 0;
}

/** A standard normal draw keyed by three u32s (Box-Muller). Host-only. */
export function gaussian(a: number, b: number, c: number): number {
  const h1 = hash3(a, b, c);
  const h2 = pcgHash(h1 ^ 0x9e3779b9);
  const u1 = (h1 + 1) / 4294967297; // (0, 1]
  const u2 = h2 / 4294967296;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Salts that keep the shader's independent draws decorrelated. */
export const SALT = {
  fire: 0x1b873593,
  noise: 0x68bc21eb,
  ic: 0x2545f491,
  icSparse: 0x7feb352d,
  init: 0x846ca68b,
  mutate: 0x5bd1e995,
} as const;
