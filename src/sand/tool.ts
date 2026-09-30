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
 * What a brush does with the button that is down.
 *
 * ## THESE LIVE HERE, and `brushInput.ts` re-exports them
 *
 * They were declared there, which read naturally until `actionFor` moved into
 * this module: `brushInput.ts` already imports `SandTool` from here, so
 * importing the constants back the other way would close a runtime cycle. This
 * module imports nothing but a type, so it is the correct end of the pair to
 * hold them -- and the re-export keeps every existing `from './brushInput.ts'`
 * import working, since that is still where a reader looks for brush vocabulary.
 */
export const BRUSH_SPAWN = 'spawn';
export const BRUSH_ERASE = 'erase';
export type BrushAction = typeof BRUSH_SPAWN | typeof BRUSH_ERASE;

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

/**
 * The tool `steps` places along the rail from `from`, wrapping at both ends.
 *
 * ## Wraps, and INCLUDES Stamp
 *
 * Wrapping for the reason `cycleSlot` wraps: a scroll gesture has no natural
 * stop, so a clamp at either end reads as the wheel having broken.
 *
 * Stamp is in the cycle although `isImplemented` says it does nothing. Skipping
 * it would make the rail and the scroll disagree about how many tools there are
 * -- the button is visible and clickable, so a scroll that jumps over it is the
 * odd one out. It is being built shortly, and a cycle that changes shape when it
 * lands would be the surprise, not this.
 *
 * A tool the rail does not list returns the first step from the start of the
 * rail rather than throwing: `TOOLS` is the authority on what the cycle
 * contains, and an unlisted tool (a stored session from an older build) should
 * rejoin it rather than freeze the scroll.
 */
export function cycleTool(from: SandTool, steps: number): SandTool {
  const count = TOOLS.length;
  const at = TOOLS.indexOf(from as (typeof TOOLS)[number]);
  // `% count` twice -- JS `%` keeps the dividend's sign, so scrolling back past
  // the first tool would land negative without the second pass.
  const next = (((at + steps) % count) + count) % count;
  return TOOLS[next] ?? from;
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
 * The field tools, matching the studio: a line of shove would be a single
 * impulse along a segment, which is not what the gesture means, and a line of
 * particles is what dragging the spawn brush already does.
 *
 * ERASE JOINS THEM because it now erases walls (see `SandOrchestrator.
 * paintField`), and a straight run of wall is exactly the thing a user wants to
 * take back in one stroke rather than by tracing it freehand.
 */
export function supportsLineTool(tool: SandTool): boolean {
  return isFieldTool(tool) || tool === 'erase';
}

/**
 * What a pressed mouse button means for the armed tool, as a particle command.
 *
 * ## The button is a MODIFIER, not the verb
 *
 * It used to be the verb outright: left spawned, right erased, over whatever
 * square was selected. With Brush and Erase as separate tools that would leave
 * two ways to reach the same act and one of them contradicting the rail --
 * right-dragging with Brush armed would erase while the Brush button stayed lit.
 *
 * So the tool picks the verb and, for the Brush, the right button INVERTS it --
 * the convention the field tools already use (`paintField` erases on right) and
 * the one the studio uses throughout.
 *
 * ## ONLY THE PARTICLE BRUSHES GET AN ANSWER HERE
 *
 * It used to return the pressed button unchanged for every other tool, and
 * `SandOrchestrator` fed that straight into `BrushInput.frame` -- so a
 * right-drag with Walls or Shove armed produced a `BRUSH_ERASE` command and the
 * kill pass deleted particles under the stroke. Right-click erased particles
 * under EVERY tool, not just the ones whose verb is erasing.
 *
 * The field tools do their own painting in `paintField` and Shove reads the
 * button itself in `shoveFor`; neither needs a particle command at all. So the
 * particle brushes are the only case with a verb, and everything else returns
 * null -- which makes "no other tool touches particles" true by construction
 * rather than by each pass remembering to check.
 *
 * ERASE INVERTED IS NOT SPAWN. Erase's right button is the suck gesture (see
 * `shoveFor`), so it stays an erase: the kill pass runs either way and the pull
 * is layered on top. Inverting to spawn would have the eraser deposit particles
 * from whatever swatch happened to be selected, which is not something a user
 * reaching for the eraser ever means.
 *
 * ## Why it lives HERE rather than in the orchestrator
 *
 * It is a pure question about a tool and a button, which is what this module
 * is -- and this module imports nothing, so the rule is testable without a GPU.
 * In `sandOrchestrator.ts` it could only be reached through the whole engine
 * graph, `.wgsl` imports and all, which is precisely why the bug above went
 * uncovered.
 */
export function actionFor(
  tool: SandTool,
  pressed: BrushAction | null,
): BrushAction | null {
  if (pressed === null) return null;
  if (tool === 'brush') return pressed === BRUSH_SPAWN ? BRUSH_SPAWN : BRUSH_ERASE;
  if (tool === 'erase') return BRUSH_ERASE;
  return null;
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

/**
 * What the eraser takes: walls, particles, or both.
 *
 * The Erase tool's Mode button cycles these. Its reason to exist is the
 * one-sided cases -- rubbing out particles without nicking the walls they sit
 * against, or trimming a wall without thinning the crowd beside it. Both is the
 * default, because that is what an eraser with no qualifier is expected to do.
 *
 * The right-button pull is a particle gesture (see `SandOrchestrator.shoveFor`),
 * so it goes with `erasesParticles`: in Walls mode there is nothing for it to
 * feed.
 */
export const ERASE_MODES = ['walls+particles', 'particles', 'walls'] as const;
export type EraseMode = (typeof ERASE_MODES)[number];
export const DEFAULT_ERASE_MODE: EraseMode = 'walls+particles';

export const ERASE_MODE_LABELS: Readonly<Record<EraseMode, string>> = {
  'walls+particles': 'Walls+Particles',
  walls: 'Walls',
  particles: 'Particles',
};

/** A stored erase mode, or the default for anything unrecognised. */
export function asEraseMode(raw: unknown): EraseMode {
  return typeof raw === 'string' && (ERASE_MODES as readonly string[]).includes(raw)
    ? (raw as EraseMode)
    : DEFAULT_ERASE_MODE;
}

/** The mode after `mode`, wrapping -- what one press of the button does. */
export function nextEraseMode(mode: EraseMode): EraseMode {
  const i = ERASE_MODES.indexOf(mode);
  return ERASE_MODES[(i + 1) % ERASE_MODES.length] ?? DEFAULT_ERASE_MODE;
}

export function erasesWalls(mode: EraseMode): boolean {
  return mode !== 'particles';
}

export function erasesParticles(mode: EraseMode): boolean {
  return mode !== 'walls';
}
