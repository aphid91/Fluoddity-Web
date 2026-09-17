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

/** What a brush does with the button that is down. */
export const BRUSH_SPAWN = 'spawn';
export const BRUSH_ERASE = 'erase';
export type BrushAction = typeof BRUSH_SPAWN | typeof BRUSH_ERASE;

/**
 * The five brush sizes, as world-space radii.
 *
 * Five discrete buttons rather than a slider, per requirement 4. Roughly
 * geometric so each step is a visible change -- a linear ramp would make the
 * top two indistinguishable and the bottom two both tiny. World units, where the
 * world is 2 across at aspect 1, so 0.4 is a fifth of the world.
 */
export const BRUSH_SIZES: readonly number[] = [0.02, 0.05, 0.1, 0.2, 0.4];

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

/** Default for the dev panel's Brush Rate. 1.0 means exactly `SPAWN_RATE`. */
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

  /** Multiplier on `SPAWN_RATE`, driven by the dev panel. */
  rate = DEFAULT_BRUSH_RATE;

  get radius(): number {
    return BRUSH_SIZES[this.sizeIndex] ?? BRUSH_SIZES[DEFAULT_BRUSH_SIZE] ?? 0.1;
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

    const stroke: Stroke = { from, to: cursor, radius: this.radius };

    if (action === BRUSH_ERASE) {
      // No count: the eraser dispatches over every particle, because only the
      // GPU knows which ones have drifted under the brush.
      return { action, stroke, count: 0 };
    }

    // The stroke memory is still advanced above, so releasing over an empty
    // square and selecting a real one mid-drag resumes from the cursor rather
    // than from wherever the last real stroke ended.
    if (!canSpawn) return null;

    const count = spawnCountFor(this.radius, SPAWN_RATE * this.rate, dt, available);
    if (count <= 0) return null;
    return { action, stroke, count };
  }
}
