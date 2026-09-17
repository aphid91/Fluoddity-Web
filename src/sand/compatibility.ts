/**
 * Whether two configs can share a world.
 *
 * ## The problem this exists for
 *
 * A config carries both per-particle physics (`ConfigData`, which the engine
 * happily varies per particle) and WORLD settings -- trail persistence,
 * diffusion, boundary -- of which the engine has exactly one. Painting two
 * species into one sand world therefore means one of them is running under a
 * trail decay it was not tuned for, and a species tuned for fast-fading trails
 * looks completely different on a canvas that holds them for seconds.
 *
 * The palette's master slot owns the world settings; every other slot
 * contributes physics only. This function is what warns the user, in the load
 * menu, which configs will survive that.
 *
 * ## It is deliberately crude, and deliberately isolated
 *
 * Trail persistence is compared as its complement -- `1 - persistence`, the
 * per-step decay -- because that is the quantity with a meaningful ratio: 0.99
 * and 0.999 are a hair apart as persistences and a factor of ten apart as decay
 * rates, and it is the decay rate that decides how long a trail lives.
 *
 * This is a FIRST PASS and is expected to be replaced by something that also
 * weighs sensor gain, force scale and diffusion. It is one exported function
 * with one call site for exactly that reason -- swapping it should touch this
 * file and nothing else.
 */

import type { WorldSettings } from '../particleSystem/config.ts';

/**
 * How far apart two decay rates may be and still count as compatible, as a
 * fraction of the larger.
 *
 * 12% is a judgement call: wide enough that configs authored independently
 * around the same feel pass, narrow enough that a fast-fade config and a
 * long-persistence one do not.
 */
export const COMPATIBILITY_TOLERANCE = 0.12;

/**
 * Whether `candidate` can be painted into a world governed by `master`.
 *
 * Compares within 12% on the per-step trail decay. Reflexive (a config is always
 * compatible with itself) and symmetric, because the comparison is against the
 * larger of the two -- `abs(a-b) <= tol * max(a,b)` does not depend on which
 * argument is which, unlike dividing by one side.
 *
 * Two configs with zero decay -- infinite trails -- compare equal rather than
 * dividing by zero.
 */
export function isCompatible(candidate: WorldSettings, master: WorldSettings): boolean {
  const a = 1 - candidate.trailPersistence;
  const b = 1 - master.trailPersistence;
  const scale = Math.max(a, b);
  // Both are exactly zero: identical, and nothing to divide by.
  if (scale <= 0) return true;
  return Math.abs(a - b) <= COMPATIBILITY_TOLERANCE * scale;
}
