/**
 * The frame the simulation resumes at after a restore.
 *
 * ## ONE, NOT ZERO
 *
 * This is the single most load-bearing constant in the sand modality. Zero is
 * the STUDIO'S RESET SENTINEL, watched by all three simulation passes:
 * `entityUpdate` regenerates every entity from scratch, `canvas` zeroes the
 * trails, and `brush` discards its splats. Landing on it would destroy precisely
 * the scene being restored and repopulate the world with particles the user
 * never painted.
 *
 * One is the first ordinary frame -- every pass behaves as though the simulation
 * had simply been running, which is what makes a restored scene bit-identical to
 * the captured one.
 *
 * ## Why this is its own module
 *
 * A leaf, so `sceneState.test.ts` can assert against it under `node --test`.
 * `initialConditions.ts` is the natural home and cannot be: it imports
 * `particleSystem.ts`, which imports `.wgsl` files that only resolve through the
 * Vite plugin. Same split as `dispatch.ts` and `sandDispatch.ts`.
 */
export const RESTORE_FRAME = 1;
