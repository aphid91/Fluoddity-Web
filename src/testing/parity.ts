/**
 * The parity goldens, for tests only.
 *
 * ## These are a fossil, deliberately
 *
 * Every value in `parity.fixture.json` was produced by calling the Python
 * desktop app's own `coords`, `sizing`, `camera_state` and `pack_configs`
 * functions. That app has been removed -- it was this port's executable spec,
 * and the spec's job ended when the port did. So these numbers can no longer be
 * regenerated, and NOTHING SHOULD TRY TO. Recomputing them from the TypeScript
 * would convert an independent record into a tautology.
 *
 * ## What they catch that round-trips do not
 *
 * A round-trip test checks the port against ITSELF. If `worldHalfExtent`
 * returned `[1/s, s]` instead of `[s, 1/s]`, every round-trip would still close
 * perfectly -- forward and inverse would be wrong in cancelling directions.
 * Only externally-sourced values catch a symmetric error like that, which is
 * why these outlived the implementation that produced them.
 *
 * A golden that fails now means the port changed, not that the fixture is
 * stale. Treat a diff to `parity.fixture.json` as a claim that the reference
 * implementation was wrong -- rare, and worth arguing for in the commit message.
 *
 * This module lives outside `particleSystem/` so nothing shippable imports it.
 */

import assert from 'node:assert/strict';

import parity from './parity.fixture.json' with { type: 'json' };

export const PARITY = parity;

/**
 * Assert two floats agree to within a relative tolerance.
 *
 * Python and JavaScript both compute in IEEE-754 float64, so these should agree
 * to the last bit or two -- but `Math.sqrt` and `**` are not bit-guaranteed
 * identical across implementations, so an exact comparison would be testing the
 * runtime rather than the port. 1e-12 relative is tight enough that any real
 * transcription error fails.
 */
export function assertClose(
  actual: number,
  expected: number,
  message: string,
  tolerance = 1e-12,
): void {
  if (actual === expected) return;
  const scale = Math.max(Math.abs(expected), 1.0);
  const delta = Math.abs(actual - expected);
  assert.ok(
    delta / scale <= tolerance,
    `${message}: got ${actual}, expected ${expected} (delta ${delta})`,
  );
}

/** `assertClose` over a pair. */
export function assertCloseVec2(
  actual: readonly [number, number],
  expected: readonly number[],
  message: string,
  tolerance = 1e-12,
): void {
  assertClose(actual[0], expected[0]!, `${message} [x]`, tolerance);
  assertClose(actual[1], expected[1]!, `${message} [y]`, tolerance);
}

/** Narrow a golden's `[number, number]`-shaped array to a tuple. */
export function pair(values: readonly number[]): readonly [number, number] {
  return [values[0]!, values[1]!];
}
