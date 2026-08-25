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
 * world 0.1 -> 0.25, physics 1 -> 10, world 0.25 -> 0.6, physics 10 -> 15,
 * world 0.6 -> 1.0, physics 15 -> 20. Spatial extent comes first because a tiny
 * world reads as a broken app no matter how smoothly it simulates; past a
 * usable size, temporal fidelity buys more than more area does.
 *
 * WHY THIS IS ITS OWN LEAF MODULE
 * Same rationale as `particleSystem/sizing.ts`: it imports nothing, holds no
 * state and touches no GPU resource, so tests and UI can read the progression
 * without dragging the GPU stack into their import graph.
 */

/** One point on the path: a world size paired with a physics rate. */
export interface Rung {
  readonly worldSize: number;
  readonly physicsSteps: number;
}

/**
 * The path, ascending. Index 0 is the floor and is never probed -- if a machine
 * cannot manage 60k particles at one sub-step there is nothing lighter to fall
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
  Object.freeze({ worldSize: 0.1, physicsSteps: 1 }),
  Object.freeze({ worldSize: 0.25, physicsSteps: 1 }),
  Object.freeze({ worldSize: 0.25, physicsSteps: 10 }),
  Object.freeze({ worldSize: 0.6, physicsSteps: 10 }),
  Object.freeze({ worldSize: 0.6, physicsSteps: 15 }),
  Object.freeze({ worldSize: 1.0, physicsSteps: 15 }),
  Object.freeze({ worldSize: 1.0, physicsSteps: 20 }),
]);

/**
 * The world size below which first-run calibration turns bloom OFF.
 *
 * **A STATEMENT ABOUT THE MACHINE, READ OFF THE RUNG IT REACHED.** The ladder
 * probes physics only, so it never prices bloom -- but where it stops is a
 * decent proxy for how much frame there is left over, and a machine that could
 * not hold world 0.6 is one whose remaining ~5 ms (see `HEADROOM`) bloom would
 * comfortably eat. Turning it off there buys back the headroom the rate tuning
 * is about to measure into.
 *
 * 0.5 rather than 0.6 -- the rung boundary -- deliberately: the shipped default
 * world size IS 0.5 (`DEFAULT_PREFERENCES`), so an inclusive comparison at 0.5
 * means the default configuration keeps bloom, and only machines the ladder
 * pushed BELOW the default lose it. Stated as "less than" so the threshold value
 * itself is on the keeping side.
 *
 * At or above it, bloom is left at whatever the default says. Calibration does
 * not turn bloom ON: it only ever removes a cost a weak machine cannot afford,
 * so a user who has it is a user the default gave it to.
 */
export const BLOOM_MIN_WORLD_SIZE = 0.5;

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
