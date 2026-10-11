/**
 * Host packing for the shaders' `Params` struct (`ncaShaders.ts`), plus the
 * grid <-> uv mapping the brush, the display and the host pick share.
 *
 * A PURE LEAF, testable under `node --test`.
 */

import { type NcaConfig, type NcaWorld, archOf } from './ncaConfig.ts';
import { PARAMS_SIZE } from './ncaShaders.ts';
import { seedToU32 } from './rng.ts';

export interface BrushStroke {
  /** Segment start and end, in canvas uv (v up). */
  readonly a: readonly [number, number];
  readonly b: readonly [number, number];
  /** Radius in the aspect-corrected uv metric (the reticle's). */
  readonly radius: number;
  /** What PAINT writes into every channel. */
  readonly value: number;
  /** `BRUSH` in `ncaShaders.ts`. */
  readonly mode: number;
}

export interface ParamsInput {
  readonly W: number;
  readonly H: number;
  readonly config: NcaConfig;
  readonly world: NcaWorld;
  readonly step: number;
  /** -1 for none. */
  readonly highlighted: number;
  readonly brush?: BrushStroke | null;
}

export function packParams(p: ParamsInput): ArrayBuffer {
  const buf = new ArrayBuffer(PARAMS_SIZE);
  const u = new Uint32Array(buf);
  const f = new Float32Array(buf);
  const c = p.config;
  const w = p.world;
  const cohorts = Math.max(1, Math.round(c.cohorts));

  u.set([p.W, p.H, cohorts, p.step >>> 0], 0);
  u.set([c.cohortFences ? 1 : 0, w.boundary === 0 ? 1 : 0, seedToU32(c.icSeed), c.aliveMask ? 1 : 0], 4);
  u.set([c.activation >>> 0, c.stateBound >>> 0, c.initialConditions >>> 0, p.highlighted < 0 ? 0 : p.highlighted + 1], 8);
  f.set([c.dt, c.fireRate, c.gain, c.leak], 12);
  f.set([c.noise, c.aliveThreshold, c.icAmplitude, c.icDensity], 16);
  f.set(
    [
      c.seedRadius,
      w.displayGain,
      w.displayMode,
      Math.max(0, Math.min(archOf(c).channels - 1, Math.round(w.displayChannel))),
    ],
    20,
  );
  const b = p.brush;
  if (b) {
    f.set([b.a[0], b.a[1], b.b[0], b.b[1]], 24);
    f.set([b.radius, b.value, b.mode], 28);
  } else {
    // A degenerate segment far outside the grid with zero radius: touches nothing.
    f.set([-10, -10, -10, -10], 24);
    f.set([0, 0, 0], 28);
  }
  f[31] = w.showCohortBorders ? 1 : 0;
  return buf;
}

/** Canvas uv (v up) -> the grid cell under it (y down), clamped. */
export function uvToCell(uv: readonly [number, number], W: number, H: number): [number, number] {
  const x = Math.min(W - 1, Math.max(0, Math.floor(uv[0] * W)));
  const y = Math.min(H - 1, Math.max(0, Math.floor((1 - uv[1]) * H)));
  return [x, y];
}

/** The centre of cell (x, y) in canvas uv. Inverse of `uvToCell`. */
export function cellToUv(x: number, y: number, W: number, H: number): [number, number] {
  return [(x + 0.5) / W, 1 - (y + 0.5) / H];
}
