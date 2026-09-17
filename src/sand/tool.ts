/**
 * What a palette square does when you drag on the canvas.
 *
 * ## Two kinds of square, one selection
 *
 * A square either paints PARTICLES from a config, or it selects one of the
 * engine's field tools -- Shove, Walls, Trails, which behave exactly as they do
 * in the studio. Both live in the same twenty squares and are chosen the same
 * way (click, or `1`-`0`), because from the user's side they are the same act:
 * "pick what the mouse does".
 *
 * That is why this is a property OF a square rather than a separate mode
 * selector beside the palette. A second selector would mean two things could be
 * armed at once and the app would need a rule for which wins.
 *
 * ## Why the field tools reuse the studio's `MouseMode` values
 *
 * `layerForMouseMode` in `orchestrator/commands.ts` is, in its own words, "the
 * one place that maps tool to layer". Reusing those string values means the sand
 * app asks that same function which layer a stroke writes, rather than carrying
 * a parallel mapping that could disagree about what "walls" means.
 */

import type { MouseMode } from '../orchestrator/commands.ts';

/** A square that paints particles from its config. */
export const TOOL_CONFIG = 'config';

/**
 * What a square is.
 *
 * `config` squares carry a `SimulationConfig`; the rest carry nothing and drive
 * the engine directly. `select` is deliberately absent -- there is no selection
 * tool in this modality, so the three field tools are the whole of the borrowed
 * set.
 */
export type SandTool = typeof TOOL_CONFIG | Extract<MouseMode, 'shove' | 'walls' | 'trails'>;

/** The field tools, in the order the load menu lists them above Core. */
export const FIELD_TOOLS = ['shove', 'walls', 'trails'] as const satisfies readonly SandTool[];

/** Display names for the load menu and the hint bar. */
export const TOOL_LABELS: Readonly<Record<SandTool, string>> = {
  config: 'Config',
  shove: 'Shove',
  walls: 'Walls',
  trails: 'Trails',
};

/** True for the tools that paint the user-drawn field. */
export function isFieldTool(tool: SandTool): tool is 'walls' | 'trails' {
  return tool === 'walls' || tool === 'trails';
}

/**
 * True for every tool whose stroke is a CONTINUOUS gesture over the canvas,
 * i.e. everything. Kept as a named question anyway because the next tool added
 * here may well not be -- a stamp would be a click, not a drag.
 */
export function isDragTool(_tool: SandTool): boolean {
  return true;
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
