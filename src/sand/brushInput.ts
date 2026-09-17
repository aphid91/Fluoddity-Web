/**
 * Brush state: which tool the buttons mean, and where the stroke has been.
 *
 * A LEAF -- no GPU, no DOM. It converts a per-frame snapshot of the pointer into
 * "spawn this many here" or "erase along this segment", and `SandOrchestrator`
 * turns that into passes. Keeping it separate is what makes the stroke logic
 * testable, and the stroke logic is where the subtle bugs live.
 *
 * ## Strokes are segments, not points
 *
 * Each frame paints from LAST frame's cursor to this one. A point brush visibly
 * breaks into dots on a fast drag, because nothing connects one frame to the
 * next -- the same problem `drawingCommands.ts` solves for the wall/trail
 * brushes, and the same fix. `previous` is that memory, and clearing it on
 * release is what makes the next press start a fresh stroke rather than drawing
 * a line from wherever the last one ended.
 */

import type { Vec2 } from '../particleSystem/coords.ts';
import type { Stroke } from './sandUniforms.ts';
import { spawnCountFor } from '../particleSystem/freeList.ts';
import { uvRadiusToWorld } from '../particleSystem/coords.ts';

/** What a brush does with the button that is down. */
export const BRUSH_SPAWN = 'spawn';
export const BRUSH_ERASE = 'erase';
export type BrushAction = typeof BRUSH_SPAWN | typeof BRUSH_ERASE;

/**
 * The five brush sizes, as `drawSize` in UV space.
 *
 * ## UV, NOT WORLD -- one radius for every tool
 *
 * These now measure in the studio's unit, because the same five buttons drive
 * four tools that historically used two different metrics: Walls, Trails and
 * Shove take a `drawSize` in uv, while the particle brushes took a world radius.
 *
 * `uvRadiusToWorld` converts, and it is a BARE FACTOR OF 2 -- the aspect terms in
 * the two metrics are identical and cancel. That cancellation is exactly why one
 * number can describe the same circle for a tool working in uv and one working
 * in world space, and it is why the reticle (drawn in uv) matches all four.
 *
 * Storing the uv value is the direction that removes work: the reticle and the
 * three field tools use it as-is, and only the particle brushes convert.
 *
 * Five discrete buttons rather than a slider. Roughly geometric so each step is
 * a visible change -- a linear ramp would make the top two indistinguishable and
 * the bottom two both tiny.
 */
export const BRUSH_SIZES: readonly number[] = [0.01, 0.025, 0.05, 0.1, 0.2];

/** Default index into `BRUSH_SIZES`. The middle one. */
export const DEFAULT_BRUSH_SIZE = 2;

/**
 * Particles created per unit of world area per second, at a rate multiplier of 1.
 *
 * Tuned by feel against the default density: the world has area 4 and carries
 * 300k particles at world size 0.5. Nothing derives from this number.
 *
 * QUADRUPLED from the first value that shipped (60k), which painted too thinly
 * to read as material. The multiplier below is what makes further tuning a
 * slider rather than an edit.
 */
export const SPAWN_RATE = 240_000;

/**
 * Default Weight. 1.0 means exactly `SPAWN_RATE`, and the studio's own default
 * draw power and shove gain.
 */
export const DEFAULT_BRUSH_RATE = 1.0;

/** What the orchestrator should do this frame. */
export interface BrushCommand {
  readonly action: BrushAction;
  readonly stroke: Stroke;
  /** Only meaningful for `spawn`. */
  readonly count: number;
}

export class BrushInput {
  /** Index into `BRUSH_SIZES`. */
  private sizeIndex = DEFAULT_BRUSH_SIZE;
  /** Last frame's cursor, or null when no stroke is in progress. */
  private previous: Vec2 | null = null;

  /**
   * WEIGHT -- how much of itself a stroke deposits, across every tool.
   *
   * One number rather than three, because from the user's side it is one
   * question: how heavy is this brush? It multiplies
   *
   *   - `SPAWN_RATE`, so a config square paints denser;
   *   - `drawPower`, so a Walls or Trails stroke paints stronger;
   *   - `SHOVE_GAIN`, so a shove pushes harder.
   *
   * DELIBERATELY UNCLAMPED. It is a number-drag beside the size buttons, and the
   * useful range is not yet known -- clamping now would pick a ceiling by guess
   * and hide whatever is past it.
   */
  weight = DEFAULT_BRUSH_RATE;

  /**
   * The brush radius in UV space -- the studio's `drawSize`.
   *
   * What Walls, Trails, Shove and the reticle all take directly. The particle
   * brushes want world units; `worldRadius` converts.
   */
  get radius(): number {
    return BRUSH_SIZES[this.sizeIndex] ?? BRUSH_SIZES[DEFAULT_BRUSH_SIZE] ?? 0.05;
  }

  /**
   * The same circle in world units, for the spawn and kill shaders.
   *
   * `uvRadiusToWorld` is the one conversion, and it lives in `coords.ts` rather
   * than here (invariant 9: only that module and `common.wgsl` may write this
   * math).
   */
  get worldRadius(): number {
    return uvRadiusToWorld(this.radius);
  }

  get sizeSlot(): number {
    return this.sizeIndex;
  }

  setSize(index: number): void {
    if (index < 0 || index >= BRUSH_SIZES.length) return;
    this.sizeIndex = index;
  }

  /** End the stroke. The next press starts fresh rather than joining to this. */
  release(): void {
    this.previous = null;
  }

  /**
   * Resolve this frame's pointer into a command, or null if nothing to do.
   *
   * `available` is how many dead particles the pool holds, which caps the spawn
   * count -- asking for more than exist would dispatch invocations that can only
   * fail their reservation.
   *
   * ## The first frame of a stroke paints a POINT
   *
   * `previous` is null on the press, so `from` and `to` are the same position
   * and the segment degenerates. Both shaders handle that (the eraser guards the
   * zero-length case explicitly), and it is the correct behaviour: a click that
   * has not moved should deposit at the cursor, not along a line from the origin.
   */
  frame(
    cursor: Vec2 | null,
    action: BrushAction | null,
    dt: number,
    available: number,
    /**
     * Whether the selected palette square actually holds a config.
     *
     * An empty square paints NOTHING. It used to paint whatever config happened
     * to occupy that ConfigData slot -- the palette fills empty slots with the
     * master's config as a harmless stand-in, so an empty square silently
     * painted master-config particles. Harmless as a data structure, wrong as a
     * brush: the square looks empty and must behave empty.
     *
     * The ERASER is deliberately exempt. It does not care what is selected --
     * rubbing out particles works with any square active, including an empty
     * one, which is what a user reaching for the eraser expects.
     */
    canSpawn = true,
  ): BrushCommand | null {
    if (cursor === null || action === null) {
      this.release();
      return null;
    }

    const from = this.previous ?? cursor;
    this.previous = cursor;

    // WORLD units: the spawn and kill shaders measure there. The five size
    // buttons store uv, which is what the field tools and the reticle want.
    const stroke: Stroke = { from, to: cursor, radius: this.worldRadius };

    if (action === BRUSH_ERASE) {
      // No count: the eraser dispatches over every particle, because only the
      // GPU knows which ones have drifted under the brush.
      return { action, stroke, count: 0 };
    }

    // The stroke memory is still advanced above, so releasing over an empty
    // square and selecting a real one mid-drag resumes from the cursor rather
    // than from wherever the last real stroke ended.
    if (!canSpawn) return null;

    const count = spawnCountFor(
      this.worldRadius,
      SPAWN_RATE * this.weight,
      dt,
      available,
    );
    if (count <= 0) return null;
    return { action, stroke, count };
  }
}
