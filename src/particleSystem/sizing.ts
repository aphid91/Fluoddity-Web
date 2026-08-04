/**
 * How big the simulation is: entity count and canvas resolution.
 * A direct port of `particle_system/sizing.py`.
 *
 * WHY THIS IS ITS OWN MODULE
 * It is a leaf. It imports nothing, holds no state, and touches no GPU
 * resource -- so anything may import it without dragging the simulation in
 * behind it. The strafe field is the reason it exists: it needs
 * `canvasDimensions` to shape its own texture, and importing that from the
 * particle system pulled the whole GPU stack into the import graph of a module
 * that wanted one function of arithmetic.
 *
 * See ARCHITECTURE.md rule 1: modules never reference each other's *stateful*
 * classes, but the particle system's leaf modules (`coords`, `config`,
 * `sizing`) are sanctioned pure/value imports.
 *
 * WHY IT IS NOT IN gpu/
 * `gpu/` is this port's analogue of the desktop's `shared/`: infrastructure
 * with no domain meaning. This is domain code -- it encodes how big this
 * particular simulation is and how it scales -- so it belongs to the particle
 * system even though it is safe for others to read.
 */

/**
 * The two numbers that define the simulation's scale, named once. Everything
 * else about sizing is derived from them by `sizingFor()`.
 *
 * Density: entities per world unit of area. Resolution: the canvas edge at
 * world size 1. They are a matched pair -- 600k particles over a 1024x1024
 * canvas is the density the defaults are tuned around, so moving one without
 * the other changes how the whole simulation reads.
 */
export const ENTITIES_PER_WORLD_UNIT = 600_000;
export const BASE_CANVAS_DIM = 1024;

/**
 * Canvas aspect (width:height). 1.0 is square. Changing this changes the SHAPE
 * of the simulated world -- world space is area-preserving, so the canvas keeps
 * roughly the same pixel count and the same particle density; it just gets
 * wider and shorter. This is independent of the window: resizing the window
 * letterboxes, it does not reshape the world.
 */
export const CANVAS_ASPECT = 1.0;

/**
 * (entityCount, canvasDim) for a world size.
 *
 * World size scales particle count and canvas resolution together, so density
 * stays constant as the world grows -- the same simulation, larger. Canvas dim
 * goes as the square root because world size is an AREA and dim is an edge.
 *
 * `Math.trunc`, not `Math.floor` or `Math.round`: Python's `int()` truncates
 * toward zero. `trunc` and `floor` agree over the positive domain this is
 * called with, but `trunc` is the literal transcription. `Math.round` would be
 * wrong -- at world size 1.0000015 the product is 600000.9, which truncates to
 * 600000 and rounds to 600001.
 */
export function sizingFor(worldSize: number): readonly [number, number] {
  return [
    Math.max(1, Math.trunc(ENTITIES_PER_WORLD_UNIT * worldSize)),
    Math.max(16, Math.trunc(BASE_CANVAS_DIM * Math.sqrt(worldSize))),
  ];
}

/**
 * Sizing for a world size of 1 -- what a simulation built without explicit
 * sizing gets. Derived through `sizingFor` so the default and the scaled case
 * can never disagree.
 */
export const [ENTITY_COUNT, CANVAS_DIM] = sizingFor(1.0);

/**
 * Canvas (width, height) for an aspect, preserving total pixel count.
 *
 * Area-preserving to match world space: dim*dim pixels regardless of shape, so
 * changing aspect does not silently change simulation cost or the effective
 * resolution of the trails.
 *
 * `dim` defaults to `CANVAS_DIM` (world size 1); it is resolved at call time
 * rather than bound as a default parameter so the two stay in step. `??` not
 * `||`, so an explicit `dim` of 0 is not silently replaced by 1024.
 *
 * ## A known, accepted divergence from the Python
 *
 * Python's `round()` is half-to-EVEN; JavaScript's `Math.round` is half-up.
 * They differ only when `dim * sqrt(aspect)` lands exactly on .5, which is
 * reachable: at `aspect = (1024.5/1024)**2` the product is exactly 1024.5, and
 * the desktop returns 1024 where this returns 1025.
 *
 * This divergence is ACCEPTED, not overlooked. `CANVAS_ASPECT` is 1.0 and has
 * no runtime UI, so no tie is currently reachable in either app. If a later step
 * exposes aspect as a control, revisit this -- an off-by-one here is a silently
 * different simulation resolution, not a visible error. The parity goldens
 * deliberately contain no tie case, since such a case would fail by design.
 */
export function canvasDimensions(
  aspect: number = CANVAS_ASPECT,
  dim?: number,
): readonly [number, number] {
  const d = dim ?? CANVAS_DIM;
  const s = Math.sqrt(aspect);
  return [Math.max(1, Math.round(d * s)), Math.max(1, Math.round(d / s))];
}
