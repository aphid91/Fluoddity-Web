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
import { type BrushAction, type SandTool, BRUSH_ERASE } from './tool.ts';

/**
 * What a brush does with the button that is down.
 *
 * DECLARED IN `tool.ts` and re-exported here, which is where every caller still
 * imports them from. They moved because `actionFor` -- the rule deciding which
 * of these a button produces -- belongs beside the other tool predicates, and
 * this module already imports `SandTool` from there; declaring them here and
 * importing them back would close a runtime cycle. See the note at their
 * declaration.
 */
export { BRUSH_ERASE, BRUSH_SPAWN, type BrushAction } from './tool.ts';

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
 *
 * ## SCALED DOWN 35% from the values that first shipped
 *
 * They were `[0.01, 0.025, 0.05, 0.1, 0.2]` and every one of them painted too
 * broadly to place anything deliberately -- the smallest still covered a
 * noticeable patch of the world. The ratio between steps is unchanged, so the
 * ramp still reads the same; the whole set simply moved down. `SIZE_SCALE` is
 * named rather than folded into the literals so the original tuning stays
 * legible and a future re-scale is one number.
 *
 * ## FOUR, not five
 *
 * The largest (0.2) was dropped with the layout-bench UI, whose size picker is
 * a 2×2 grid. A stored session still pointing at index 4 is refused by
 * `setSize` and keeps the default.
 */
const SIZE_SCALE = 0.65;

export const BRUSH_SIZES: readonly number[] = [0.01, 0.025, 0.05, 0.1].map(
  (r) => r * SIZE_SCALE,
);

/** Default index into `BRUSH_SIZES`. The middle one. */
export const DEFAULT_BRUSH_SIZE = 2;

/** Whether `value` is a usable index into `BRUSH_SIZES`. */
export function isBrushSizeIndex(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < BRUSH_SIZES.length
  );
}

/**
 * The tools a brush size means something to: all but Stamp, which places a
 * shape of its own size.
 */
export type SizedTool = Exclude<SandTool, 'stamp'>;

export function isSizedTool(tool: SandTool): tool is SizedTool {
  return tool !== 'stamp';
}

/**
 * Brush size per tool, as indices into `BRUSH_SIZES`.
 *
 * PER TOOL for the reason `ToolStrengths` is: the useful size depends on the
 * job. Walls want a fine line and Shove a broad sweep, and one shared size had
 * to be re-picked on every tool change.
 */
export type ToolSizes = Readonly<Record<SizedTool, number>>;

/** Every tool at the default size. Written out for the reason `defaultStrengths` is. */
export function defaultSizes(): ToolSizes {
  return {
    brush: DEFAULT_BRUSH_SIZE,
    erase: DEFAULT_BRUSH_SIZE,
    shove: DEFAULT_BRUSH_SIZE,
    walls: DEFAULT_BRUSH_SIZE,
    trails: DEFAULT_BRUSH_SIZE,
  };
}

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
 * Default Strength. 1.0 means exactly `SPAWN_RATE`, and the studio's own default
 * draw power and shove gain.
 */
export const DEFAULT_BRUSH_RATE = 1.0;

/**
 * Strength per tool, rather than one number for all of them.
 *
 * ## Why this had to be split
 *
 * It was a single `weight` multiplying three quantities with three unrelated
 * natural scales: `SPAWN_RATE` (particles per second), `drawPower` (field ink)
 * and `SHOVE_GAIN` (an impulse). A value that made the Brush deposit pleasantly
 * made Shove either imperceptible or violent, so the control had to be re-dialled
 * on every tool change -- which is not a preference, it is three preferences
 * wearing one field.
 *
 * Erase has an entry for uniformity and nothing reads it: the eraser is a hard
 * radius kill with no gain term. `usesStrength` is what the UI asks before
 * enabling the field.
 */
export type ToolStrengths = Readonly<Record<SandTool, number>>;

/**
 * Every tool at the default. The shape a fresh session starts from.
 *
 * Written out rather than built from `TOOLS`, because `TOOLS` is the RAIL's
 * list and `SandTool` is the type's -- `trails` is a real tool that the rail
 * does not currently show a button for. Deriving from the rail would leave it
 * undefined and push a `?? DEFAULT` onto every read.
 */
export function defaultStrengths(): ToolStrengths {
  return {
    brush: DEFAULT_BRUSH_RATE,
    erase: DEFAULT_BRUSH_RATE,
    shove: DEFAULT_BRUSH_RATE,
    walls: DEFAULT_BRUSH_RATE,
    trails: DEFAULT_BRUSH_RATE,
    stamp: DEFAULT_BRUSH_RATE,
  };
}

/** What the orchestrator should do this frame. */
export interface BrushCommand {
  readonly action: BrushAction;
  readonly stroke: Stroke;
  /** Only meaningful for `spawn`. */
  readonly count: number;
}

export class BrushInput {
  /** Each tool's index into `BRUSH_SIZES`. See `ToolSizes`. */
  private sizes: Record<SizedTool, number> = defaultSizes();
  /** Last frame's cursor, or null when no stroke is in progress. */
  private previous: Vec2 | null = null;

  /**
   * STRENGTH, per tool -- how much of itself a stroke deposits.
   *
   * One number PER TOOL rather than one overall: the three things it multiplies
   * have unrelated natural scales, so a shared value could not be right for more
   * than one of them at a time. See `ToolStrengths`.
   *
   *   - `SPAWN_RATE`, so the Brush paints denser;
   *   - `drawPower`, so a Walls or Trails stroke paints stronger;
   *   - `SHOVE_GAIN`, so a shove pushes harder.
   *
   * DELIBERATELY UNCLAMPED. It is a dev number-drag under the size buttons, and
   * the useful range is not yet known -- clamping now would pick a ceiling by
   * guess and hide whatever is past it.
   */
  private strengths: Record<SandTool, number> = defaultStrengths();

  /**
   * Which tool the left rail has armed.
   *
   * Lives here rather than in the palette because it is brush state, not swatch
   * state -- see `tool.ts` on the split. `spawnCount` and the orchestrator both
   * read it to decide what a stroke means.
   */
  tool: SandTool = 'brush';

  /** The armed tool's Strength. What every gain term multiplies by. */
  get weight(): number {
    return this.strengths[this.tool];
  }

  /** Read one tool's Strength without arming it -- for the session snapshot. */
  strengthFor(tool: SandTool): number {
    return this.strengths[tool];
  }

  /** Every tool's Strength, for the session snapshot. */
  allStrengths(): ToolStrengths {
    return { ...this.strengths };
  }

  /**
   * Set one tool's Strength.
   *
   * Non-finite and non-positive values are refused rather than stored: a zero
   * gain is a tool that silently does nothing, and a NaN one propagates into
   * the spawn count and the shove impulse.
   */
  setStrength(tool: SandTool, value: number): void {
    if (!Number.isFinite(value) || value <= 0) return;
    this.strengths[tool] = value;
  }

  /** Re-apply strengths restored from a previous session. */
  restoreStrengths(values: Partial<Record<SandTool, number>>): void {
    for (const [tool, value] of Object.entries(values)) {
      if (typeof value === 'number') this.setStrength(tool as SandTool, value);
    }
  }

  /**
   * The brush radius in UV space -- the studio's `drawSize`.
   *
   * What Walls, Trails, Shove and the reticle all take directly. The particle
   * brushes want world units; `worldRadius` converts.
   */
  get radius(): number {
    return BRUSH_SIZES[this.sizeSlot ?? DEFAULT_BRUSH_SIZE] ?? BRUSH_SIZES[DEFAULT_BRUSH_SIZE] ?? 0.05;
  }

  /**
   * The brush's VISIBLE EXTENT in uv -- what the reticle ring is drawn at.
   *
   * Two sigma of the painting brush's gaussian, and exactly the eraser's hard
   * radius (`strafeDraw.wgsl` tests `hit.dist < draw_size * 2.0`). The studio
   * computes the identical `2.0 * prefs.drawSize`.
   *
   * THE RING IS THE CONTRACT: whatever a tool actually reaches must match this,
   * or the circle lies about what a stroke will do.
   */
  get reticleRadius(): number {
    return 2.0 * this.radius;
  }

  /**
   * The same circle the reticle promises, in world units, for the spawn and
   * kill shaders.
   *
   * ## Why the factor of two is HERE and not only in the reticle
   *
   * Those two shaders use their radius as a HARD cutoff -- spawn scatters
   * inside it, kill takes everything within it -- so to affect exactly what the
   * ring encloses they need the ring's radius, not the gaussian's sigma.
   *
   * This returned `uvRadiusToWorld(radius)` (sigma, not extent), which made the
   * particle brushes cover a quarter of the area the ring showed while the
   * field tools covered all of it. Deriving both from `reticleRadius` is what
   * keeps every tool honest about the same circle.
   *
   * `uvRadiusToWorld` is the one conversion and lives in `coords.ts` rather than
   * here (invariant 9: only that module and `common.wgsl` may write this math).
   */
  get worldRadius(): number {
    return uvRadiusToWorld(this.reticleRadius);
  }

  /** The armed tool's size, or null under Stamp, which has none. */
  get sizeSlot(): number | null {
    return isSizedTool(this.tool) ? this.sizes[this.tool] : null;
  }

  /** Set the ARMED tool's size. Out-of-range indices, and Stamp, are ignored. */
  setSize(index: number): void {
    if (!isSizedTool(this.tool) || !isBrushSizeIndex(index)) return;
    this.sizes[this.tool] = index;
  }

  /** Every tool's size, for the session snapshot. */
  allSizes(): ToolSizes {
    return { ...this.sizes };
  }

  /** Re-apply sizes restored from a previous session. */
  restoreSizes(values: Partial<Record<SizedTool, number>>): void {
    for (const [tool, value] of Object.entries(values)) {
      if (tool in this.sizes && isBrushSizeIndex(value)) {
        this.sizes[tool as SizedTool] = value;
      }
    }
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
