/**
 * The path first-run calibration walks, from cheapest to most expensive.
 *
 * WHY A FIXED PATH RATHER THAN A SEARCH
 * World size and physics rate are each roughly linear in GPU cost, so the space
 * they span is two-dimensional and most points in it are equivalent in price
 * but not in character: (world 1.0, physics 5) and (world 0.25, physics 20)
 * cost about the same and look nothing alike. Searching that space would need a
 * rule for which of two equal-cost settings is BETTER, and that rule is a taste
 * judgement, not a measurement.
 *
 * So the taste is written down once, here, as a single ascending path. Each
 * rung is a point someone decided is the best use of that much GPU, and
 * calibration's only job is to find how far along the path the machine can go.
 * That collapses a 2-D search into "walk until it hurts".
 *
 * THE ORDER ENCODES A PREFERENCE. The path alternates which knob it raises --
 * world 0.05 -> 0.25, physics 1 -> 10, world 0.25 -> 0.6, physics 10 -> 15,
 * world 0.6 -> 1.0, physics 15 -> 20. Spatial extent comes first because a tiny
 * world reads as a broken app no matter how smoothly it simulates; past a
 * usable size, temporal fidelity buys more than more area does.
 *
 * WHY THIS IS ITS OWN LEAF MODULE
 * Same rationale as `particleSystem/sizing.ts`: it imports nothing, holds no
 * state and touches no GPU resource, so tests and UI can read the progression
 * without dragging the GPU stack into their import graph.
 */

/**
 * DEVELOPMENT ONLY: re-run the splash and calibration on every single visit,
 * ignoring the stored `calibrated` flag.
 *
 * **SET THIS BACK TO `false` BEFORE SHIPPING.** With it on, every load is a
 * first load: the welcome splash comes up, the ladder walks, and the result is
 * committed over whatever was there. That is exactly wrong for a real user --
 * they get a modal and a rebuild every time they open the app -- and exactly
 * right while working on calibration itself, where the alternative is clearing
 * `localStorage` by hand between every test run.
 *
 * ONE FLAG, ONE LINE, NO OTHER MACHINERY. Deliberately not a URL parameter, an
 * env var or a build define: those all have a way of surviving into production
 * unnoticed. A literal `true` in the source is visible in review and in a diff,
 * and turning it off is a one-character edit.
 *
 * `?nocalibrate` still wins over this -- the verification tools depend on that,
 * and a debug convenience must not be able to break the screenshot comparisons.
 */
export const ALWAYS_CALIBRATE = true;

/** One point on the path: a world size paired with a physics rate. */
export interface Rung {
  readonly worldSize: number;
  readonly physicsSteps: number;
}

/**
 * The path, ascending. Index 0 is the floor and is never probed -- if a machine
 * cannot manage 30k particles at one sub-step there is nothing lighter to fall
 * back to, so it is accepted unconditionally rather than tested.
 *
 * Every rung sits inside the `settingsSpec` bounds for its field (world size
 * 0.05..4.0, physics 1..120), so a calibrated result is always something the
 * user could also have dialled in by hand. `progression.test.ts` asserts that.
 *
 * The top rung deliberately stops at world 1.0 rather than the slider's 4.0.
 * Calibration measures physics cost on ONE preset and then commits the result
 * for every preset the user will open; betting the whole 4x range on that
 * single sample would strand people on settings their next project cannot hold.
 * 1.0 is the documented design density (`sizing.ts:29-31`) and a safe ceiling to
 * hand someone automatically -- going beyond it stays a deliberate choice.
 */
export const PROGRESSION: readonly Rung[] = Object.freeze([
  Object.freeze({ worldSize: 0.05, physicsSteps: 1 }),
  Object.freeze({ worldSize: 0.25, physicsSteps: 1 }),
  Object.freeze({ worldSize: 0.25, physicsSteps: 10 }),
  Object.freeze({ worldSize: 0.6, physicsSteps: 10 }),
  Object.freeze({ worldSize: 0.6, physicsSteps: 15 }),
  Object.freeze({ worldSize: 1.0, physicsSteps: 15 }),
  Object.freeze({ worldSize: 1.0, physicsSteps: 20 }),
]);

/**
 * The frame time calibration aims at: 60 fps.
 *
 * FIXED AT 60 REGARDLESS OF THE DISPLAY. `requestAnimationFrame` runs at the
 * panel's refresh rate, so a 120 Hz machine could instead be tuned to an 8.3 ms
 * budget -- and that is deliberately NOT what happens. Halving the budget to
 * double the frame rate would buy smoothness this app does not especially need
 * and pay for it in particle count, which is the thing it is actually for. A
 * 120 Hz user gets a heavier simulation at 60 rather than a thinner one at 120.
 */
export const TARGET_FRAME_MS = 16.7;

/**
 * The fraction of the frame calibration is allowed to spend on physics.
 *
 * A probe times `runFrame` and nothing else, but a real frame also pays for the
 * camera resolve, motion blur, bloom and the browser's own compositing -- none
 * of which are in the measurement and all of which come out of the same 16.7 ms.
 * Calibrating to the full budget would therefore pick a rung that is exactly
 * affordable in isolation and over budget in practice, on every machine.
 *
 * 0.7 leaves ~5 ms for the rest of the frame. That is generous for the default
 * preset (bloom off, one blur sample) and about right once someone turns bloom
 * on, which is the case worth protecting -- being slightly conservative costs a
 * rung, being optimistic costs a smooth first impression.
 */
export const HEADROOM = 0.7;

/** The per-probe budget: how long one `runFrame` may take and still pass. */
export function budgetMs(): number {
  return TARGET_FRAME_MS * HEADROOM;
}

/**
 * Relative GPU cost of a rung.
 *
 * Both knobs are close enough to linear that their product orders the path
 * correctly, which is the only property anything depends on: the ladder needs
 * the rungs to ASCEND so that the first failure implies every rung above it
 * would fail too. Nothing converts this number to milliseconds -- the probe
 * measures time directly, so this is for ordering and for the test that proves
 * the ordering holds.
 */
export function cost(rung: Rung): number {
  return rung.worldSize * rung.physicsSteps;
}
