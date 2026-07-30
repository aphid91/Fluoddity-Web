/**
 * Access to the Python-generated parity goldens, for tests only.
 *
 * `web/tools/parity.generated.json` is produced by CALLING the desktop Python
 * functions (see `web/tools/generate_web_data.py`), so these values cannot
 * drift from the desktop app without the regeneration diff showing it.
 *
 * ## Why goldens here, when the port decided against them
 *
 * `docs/WEB_PORT_PLAN.md` decides that fidelity is verified by visual A/B, not
 * numeric golden vectors. That decision is about THE DYNAMICS -- chaotic
 * emergent behaviour that cannot be compared frame to frame. Step 2 is
 * deterministic arithmetic, and the same plan explicitly asks to "check
 * sizing.ts against the Python values". These are that instruction.
 *
 * ## What they catch that round-trips do not
 *
 * A round-trip test checks the port against ITSELF. If `worldHalfExtent`
 * returned `[1/s, s]` instead of `[s, 1/s]`, every round-trip would still close
 * perfectly -- forward and inverse would be wrong in cancelling directions.
 * Only Python-sourced values catch a symmetric error like that.
 *
 * This module lives outside `particleSystem/` so nothing shippable can import
 * it: it reaches up into `tools/`, which is build tooling, not app code.
 */

import assert from 'node:assert/strict';

import parity from '../../tools/parity.generated.json' with { type: 'json' };

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
