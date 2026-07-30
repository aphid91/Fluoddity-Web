/**
 * Bloom's mip geometry. A port of the sizing half of `assembler/bloom.py`.
 *
 * A leaf so it stays testable under `node --test` -- `bloom.ts` imports `.wgsl`
 * and cannot be. See `particleSystem/dispatch.ts` for the same reasoning.
 */

/**
 * Halvings below the source. Five reaches 1/32, which at any sane window size
 * is a handful of texels -- wide enough for the diffuse halo, and past the
 * point where another level would add anything visible. `bloom.py:37`.
 */
export const MIP_LEVELS = 5;

/**
 * The chain's texture sizes, largest first, derived from the SOURCE size.
 *
 * The first entry is already halved, so `mipSizes(w,h)[0]` is half-res -- that
 * is `bloom.py:152-157`, where the loop halves *before* allocating. The
 * assembler samples that half-res result with linear filtering, and half res is
 * not a compromise: bloom is a wide, soft signal and there is nothing at full
 * resolution for it to represent.
 *
 * `Math.max(1, ...)` is load-bearing: a very small or very thin window would
 * otherwise ask for a zero-sized texture partway down, which is not a legal
 * texture size. `Math.floor(x / 2)` rather than `x >> 1` to mirror Python's
 * `//` for the reader; the inputs are integers so they agree.
 */
export function mipSizes(
  width: number,
  height: number,
): readonly (readonly [number, number])[] {
  const sizes: (readonly [number, number])[] = [];
  let w = width;
  let h = height;
  for (let i = 0; i < MIP_LEVELS; i++) {
    w = Math.max(1, Math.floor(w / 2));
    h = Math.max(1, Math.floor(h / 2));
    sizes.push([w, h]);
  }
  return sizes;
}
