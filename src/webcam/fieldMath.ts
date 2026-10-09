/**
 * The camera field's geometry, as pure arithmetic.
 *
 * Split from `webcamField.ts` so `node --test` can reach it -- that file imports
 * WGSL, which only Vite can resolve. Everything here becomes a uniform lane in
 * one of the three passes, and each function names the shader that reads it.
 *
 * ## The one fact behind all three
 *
 * The camera field is a FIXED square texture (`CAMERA_FIELD_DIM`) stretched
 * over a world of any aspect. Fixed, so that one texture serves every
 * `ParticleSystem` the session builds and nothing reallocates when the world
 * reshapes -- which in sand is every window resize. The price is that a texel is
 * not square in the world, and every function here exists to pay it: the crop
 * covers the WORLD's aspect, and the blur and the derivative stencil step a
 * fixed WORLD distance on each axis rather than a fixed number of texels.
 */

/** Texels along each side of the camera field. */
export const CAMERA_FIELD_DIM = 256;

/**
 * The cover crop: how much of the camera's uv range one field uv spans, per
 * axis. `cameraIngest.wgsl`'s `params.xy`.
 *
 * Exactly one axis is 1 (the camera fills the world along it) and the other is
 * <= 1 (the overflow is cropped off, centred). A camera wider than the world
 * loses its sides; a taller one loses top and bottom. Never squashed -- a face
 * stays a face whatever shape the window is.
 */
export function coverScale(
  videoSize: readonly [number, number],
  worldAspect: number,
): readonly [number, number] {
  const [w, h] = videoSize;
  if (!(w > 0 && h > 0 && worldAspect > 0)) return [1, 1];
  const cameraAspect = w / h;
  return cameraAspect > worldAspect
    ? [worldAspect / cameraAspect, 1]
    : [1, cameraAspect / worldAspect];
}

/**
 * One blur pass's tap spacing in field uv. `cameraBlur.wgsl`'s `params.xy`.
 *
 * `sigmaTexels` is in texels of the field's HEIGHT (world-height / DIM), so the
 * vertical pass steps `sigma / 4` texels and the horizontal pass steps the same
 * WORLD distance, which is `1 / aspect` as much field-u. 4 because the shader's
 * 12 taps each side cover 3 sigma.
 *
 * Returns null below half a texel -- the pass then copies through rather than
 * spend 25 taps on a kernel narrower than the texture can show.
 */
export function blurStep(
  sigmaTexels: number,
  worldAspect: number,
  axis: 'x' | 'y',
): readonly [number, number] | null {
  if (!(sigmaTexels >= 0.5) || !(worldAspect > 0)) return null;
  const v = sigmaTexels / CAMERA_FIELD_DIM / 4;
  return axis === 'y' ? [0, v] : [v / worldAspect, 0];
}

/**
 * The derivative stencil's radius in field-v units. `cameraMap.wgsl`'s
 * `params.w`; the shader steps `radius` along v and `radius / aspect` along u.
 *
 * Follows the blur, so a slope is measured ACROSS a blurred feature rather than
 * along a sliver of it -- which keeps the mapped field O(1) at every blur
 * setting. Floored so that NEITHER axis steps less than one texel: on a wide
 * world the u step is the short one, and a sub-texel stencil would difference a
 * texel against itself through the linear filter and read every edge as flat.
 */
export function stencilRadius(sigmaTexels: number, worldAspect: number): number {
  const aspect = worldAspect > 0 ? worldAspect : 1;
  const floor = Math.max(1, aspect) / CAMERA_FIELD_DIM;
  const fromBlur = Math.max(0, sigmaTexels) / CAMERA_FIELD_DIM;
  return Math.max(floor, fromBlur);
}
