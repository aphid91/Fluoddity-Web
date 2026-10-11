/**
 * Grid resolution from the World Size and Canvas Aspect preferences.
 *
 * World Size scales the CELL COUNT linearly: 1 is 256 x 256 = 65,536 cells,
 * 4 is four times that (512 x 512). Aspect shapes it, holding the count.
 * Clamped to [8, 4096] per side.
 */

export const GRID_BASE = 256;
const MIN_SIDE = 8;
const MAX_SIDE = 4096;

export function gridDimensions(worldSize: number, aspect: number): [number, number] {
  const ws = Number.isFinite(worldSize) && worldSize > 0 ? worldSize : 1;
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const side = (v: number): number => Math.max(MIN_SIDE, Math.min(MAX_SIDE, Math.round(v)));
  return [side(GRID_BASE * Math.sqrt(ws * a)), side(GRID_BASE * Math.sqrt(ws / a))];
}
