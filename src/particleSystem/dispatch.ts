/**
 * Compute dispatch arithmetic.
 *
 * Its own module, and a leaf, for a mundane reason: `particleSystem.ts` imports
 * `.wgsl` files, which only resolve through the Vite plugin -- so nothing under
 * `node --test` can import it. Keeping the arithmetic here means the one piece
 * of `advance()` that is pure logic stays testable without a browser.
 */

/**
 * Invocations per workgroup. MUST match `@workgroup_size(256)` in
 * `entityUpdate.wgsl`.
 *
 * These live in different files, and drifting them under-dispatches silently:
 * the entities past the last covered index simply stop updating, freezing
 * mid-flight while everything around them keeps moving. That reads as a physics
 * quirk, not as a bug, which is why `shaders/shaders.test.ts` asserts the two
 * agree rather than leaving it to review.
 *
 * 256 is also the default `maxComputeInvocationsPerWorkgroup`, so it needs no
 * feature or limit request.
 */
export const WORKGROUP_SIZE = 256;

/**
 * Workgroups needed to cover `entityCount` entities.
 *
 * Rounds UP, so the last group is partly out of range -- the shader's
 * `if (index >= arrayLength(&entities)) { return; }` is what makes that safe,
 * and the two must be read together. At the default 600,000 entities this is
 * 2344 groups covering 600,064 invocations, so 64 of them return immediately.
 *
 * Ceiling, not `maxComputeWorkgroupsPerDimension`-clamped: at world size 4 this
 * is 9375, and the guaranteed 65535 limit is not reached until world size ~28
 * (16.8M entities) -- far beyond anything the UI offers. A clamp would silently
 * drop entities where a hard failure is the honest outcome; if that scale ever
 * arrives, the dispatch needs a second dimension, not a smaller number.
 */
export function workgroupsFor(entityCount: number): number {
  return Math.ceil(entityCount / WORKGROUP_SIZE);
}
