/**
 * What the mouse does, as a selection SEPARATE from what the brush paints.
 *
 * ## The split, and why it replaced the old model
 *
 * This file used to say the opposite: a palette square was either a config or a
 * field tool, and one selection answered both "what does the mouse do" and "what
 * does it paint". The argument was that a second selector would let two things
 * be armed at once, needing a rule for which wins.
 *
 * The MacPaint-style layout makes that argument the wrong way round. A tool
 * palette on the left and a swatch palette on the bottom is a shape people
 * already know, and in it the two questions are visibly independent: the tool is
 * the verb, the swatch is the noun. There is no "which wins" to decide because
 * they are not competing -- only BRUSH reads the swatch at all, and every other
 * tool ignores it the way a paint bucket ignores the pencil width.
 *
 * So: `activeTool` lives beside the palette rather than inside it, swatches are
 * config-only, and `paintsParticles` asks about the pair rather than about one
 * square. Sessions holding tool-squares from the old model migrate to empty --
 * see `session.ts`.
 *
 * ## Why the field tools reuse the studio's `MouseMode` values
 *
 * `layerForMouseMode` in `orchestrator/commands.ts` is, in its own words, "the
 * one place that maps tool to layer". Reusing those string values means the sand
 * app asks that same function which layer a stroke writes, rather than carrying
 * a parallel mapping that could disagree about what "walls" means.
 */

import type { MouseMode } from '../orchestrator/commands.ts';

/**
 * A square that paints particles from its config.
 *
 * Retained as the swatch's `tool` field so stored sessions keep their shape and
 * `PaletteSlot` keeps a single discriminator. Every swatch is a config swatch
 * now -- the field tools moved to the left rail -- so this is the only value
 * that field ever holds.
 */
export const TOOL_CONFIG = 'config';

/**
 * What the left rail arms.
 *
 * `brush` and `erase` are new as first-class tools: they were previously implied
 * by the mouse button (left paints, right erases) over a config square. Making
 * them explicit is what lets the swatch stop carrying a verb.
 *
 * `shove`, `walls` and `trails` keep the studio's `MouseMode` spellings so
 * `layerForMouseMode` can be asked directly -- see the header.
 */
export type SandTool =
  | 'brush'
  | 'erase'
  | 'stamp'
  | Extract<MouseMode, 'shove' | 'walls' | 'trails'>;

/**
 * The rail, top to bottom.
 *
 * Order is the UI's: the two painting verbs, then the field tools, then Stamp,
 * which is a placeholder -- see `isImplemented`.
 */
export const TOOLS = ['brush', 'erase', 'shove', 'walls', 'stamp'] as const satisfies
  readonly SandTool[];

/** The tool a fresh session arms. */
export const DEFAULT_TOOL: SandTool = 'brush';

/** Display names for the rail and the hint line. */
export const TOOL_LABELS: Readonly<Record<SandTool, string>> = {
  brush: 'Brush',
  erase: 'Erase',
  shove: 'Shove',
  walls: 'Walls',
  trails: 'Trails',
  stamp: 'Stamp',
};

/**
 * Declared but not built.
 *
 * Stamp is in the rail because the layout is being designed around it; it does
 * nothing yet. Selectable-but-inert is deliberate over hidden-until-ready: a
 * gap that appears later would move every button below it, and this is the
 * cheaper lie.
 */
export function isImplemented(tool: SandTool): boolean {
  return tool !== 'stamp';
}

/** True for the tools that paint the user-drawn field. */
export function isFieldTool(tool: SandTool): tool is 'walls' | 'trails' {
  return tool === 'walls' || tool === 'trails';
}

/**
 * Whether this tool deposits particles from the selected swatch.
 *
 * Only Brush does. Kept as a named question rather than an inline `=== 'brush'`
 * because the swatch-reading tools are exactly the set that has to consult the
 * palette at all, and that set is likely to grow (Stamp will join it).
 */
export function usesSwatch(tool: SandTool): boolean {
  return tool === 'brush';
}

/**
 * Whether the Strength control applies.
 *
 * FALSE FOR ERASE, which is the whole reason this exists. The eraser is a hard
 * radius kill -- `kill.wgsl` takes everything within the stroke, with no gain
 * term to scale -- so a Strength field beside it would be a control that
 * silently does nothing. The UI greys it out rather than hiding it, so the row
 * does not reflow when the tool changes.
 */
export function usesStrength(tool: SandTool): boolean {
  return tool !== 'erase';
}

/**
 * Whether the Shift line tool applies.
 *
 * Painting tools only, matching the studio: a line of shove would be a single
 * impulse along a segment, which is not what the gesture means, and a line of
 * particles is what dragging the spawn brush already does.
 */
export function supportsLineTool(tool: SandTool): boolean {
  return isFieldTool(tool);
}

/**
 * What this tool's Clear button wipes, or null when it leaves nothing behind.
 *
 * Shove is the null case: it displaces particles rather than depositing
 * anything, so there is no residue for a Clear to remove. Erase clears
 * particles because that is the bulk version of what it does one stroke at a
 * time.
 */
export function clearTargetFor(tool: SandTool): 'walls' | 'trails' | 'particles' | null {
  if (tool === 'walls' || tool === 'trails') return tool;
  if (tool === 'brush' || tool === 'erase') return 'particles';
  return null;
}
