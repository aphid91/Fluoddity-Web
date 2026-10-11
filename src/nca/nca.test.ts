import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVATION,
  BOUNDARY,
  IC,
  PERCEPTION,
  STATE_BOUND,
  makeNcaConfig,
  type NcaConfig,
} from './ncaConfig.ts';
import { paramCount, paramLayout } from './paramLayout.ts';
import { gaussian, hash3, pcgHash, seedToU32, unit } from './rng.ts';
import {
  allCohortWeights,
  cohortWeights,
  embedWeights,
  initWeights,
  toStored,
} from './weights.ts';
import {
  cohortAt,
  cohortIndexMap,
  cohortRects,
  neighbourIndex,
} from './cohortLayout.ts';
import { cpuInit, cpuStep, type GridContext } from './cpuStep.ts';

// --- rng --------------------------------------------------------------------

/** The PCG hash in BigInt arithmetic: an independent check of the Math.imul port. */
function pcgBig(seed: number): number {
  const M = 0xffffffffn;
  const state = (BigInt(seed >>> 0) * 747796405n + 2891336453n) & M;
  const word = (((state >> ((state >> 28n) + 4n)) ^ state) * 277803737n) & M;
  return Number((word >> 22n) ^ word);
}

test('pcgHash matches a BigInt reference', () => {
  for (const s of [0, 1, 2, 12345, 0xdeadbeef, 0xffffffff, 2 ** 31]) {
    assert.equal(pcgHash(s), pcgBig(s));
  }
});

test('unit stays in [0,1) and seeds map to u32', () => {
  for (let i = 0; i < 1000; i++) {
    const u = unit(hash3(i, 7, 9));
    assert.ok(u >= 0 && u < 1);
  }
  assert.ok(unit(0xffffffff) < 1);
  assert.equal(seedToU32(0), 0);
  assert.equal(seedToU32(0.5), 2 ** 31);
  assert.equal(seedToU32(1.5), 2 ** 31);
});

test('gaussian has roughly unit variance', () => {
  let sum = 0;
  let sq = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) {
    const g = gaussian(1, 2, i);
    sum += g;
    sq += g * g;
  }
  assert.ok(Math.abs(sum / n) < 0.05);
  assert.ok(Math.abs(sq / n - 1) < 0.05);
});

// --- layout -----------------------------------------------------------------

test('param counts at the two ends of the scale', () => {
  // Fluoddity-sized: C=4, H=4, fixed (id, sx, sy) -> P=12.
  assert.equal(paramCount({ channels: 4, hidden: 4, perception: 0, learnedKernels: 1, laplacian: false }), 72);
  // The classic Growing-NCA: C=16, H=128.
  assert.equal(paramCount({ channels: 16, hidden: 128, perception: 0, learnedKernels: 1, laplacian: false }), 8336);
  // Single layer.
  assert.equal(paramCount({ channels: 4, hidden: 0, perception: 0, learnedKernels: 1, laplacian: false }), 4 * 12 + 4);
  // Learned: K=2 kernels -> kinds (id, k0, k1); perc is K*C*9.
  const L = paramLayout({ channels: 4, hidden: 4, perception: PERCEPTION.LEARNED, learnedKernels: 2, laplacian: false });
  assert.deepEqual(L.kinds, ['id', 'k0', 'k1']);
  assert.equal(L.count, 2 * 4 * 9 + 12 * 4 + 4 + 4 * 4 + 4);
  assert.equal(L.tensors[0]!.name, 'perc');
});

// --- cohorts ----------------------------------------------------------------

test('cohort rects tile the grid exactly, and cohortAt agrees with the map', () => {
  for (const [W, H] of [[64, 64], [97, 53], [256, 144], [17, 31]] as const) {
    for (let n = 1; n <= 64; n++) {
      const rects = cohortRects(n, W, H);
      assert.equal(rects.length, n);
      const map = cohortIndexMap(n, W, H);
      const seen = new Uint8Array(W * H);
      rects.forEach((r) => {
        for (let y = r.y0; y < r.y0 + r.h; y++)
          for (let x = r.x0; x < r.x0 + r.w; x++) seen[y * W + x]!++;
      });
      assert.ok(seen.every((v) => v === 1), `n=${n} ${W}x${H} not an exact tiling`);
      for (let i = 0; i < 200; i++) {
        const x = (i * 37) % W;
        const y = (i * 53) % H;
        assert.equal(cohortAt(n, W, H, x, y), map[y * W + x]);
      }
    }
  }
});

test('9 cohorts are a 3x3 grid', () => {
  const rects = cohortRects(9, 90, 90);
  assert.deepEqual(rects[4], { x0: 30, y0: 30, w: 30, h: 30 });
});

test('fences wrap inside the cohort; no fences wrap the grid', () => {
  const rect = { x0: 30, y0: 30, w: 30, h: 30 };
  // Left edge of the rect, stepping left: lands on the rect's right edge.
  assert.equal(neighbourIndex(30, 40, -1, 0, 90, 90, rect, true), 40 * 90 + 59);
  // Unfenced, the same step crosses into the neighbouring cohort.
  assert.equal(neighbourIndex(30, 40, -1, 0, 90, 90, null, true), 40 * 90 + 29);
  // Grid edge: wrap vs zero.
  assert.equal(neighbourIndex(0, 0, -1, -1, 90, 90, null, true), 89 * 90 + 89);
  assert.equal(neighbourIndex(0, 0, -1, 0, 90, 90, null, false), -1);
});

// --- weights ----------------------------------------------------------------

const TINY = { channels: 4, hidden: 4, perception: PERCEPTION.FIXED, learnedKernels: 1, laplacian: false };

test('cohort weights are deterministic, mutated per cohort, exact at scale 0', () => {
  const base = toStored(initWeights(TINY, 99));
  const cfg = makeNcaConfig({ ...TINY, weights: base, mutationScale: 0.3, cohorts: 4 });
  assert.deepEqual(cohortWeights(cfg, 2), cohortWeights(cfg, 2));
  assert.notDeepEqual(cohortWeights(cfg, 1), cohortWeights(cfg, 2));
  assert.deepEqual(Array.from(cohortWeights({ ...cfg, mutationScale: 0 }, 3)), base);
  // A reseed changes the children.
  assert.notDeepEqual(cohortWeights(cfg, 1), cohortWeights({ ...cfg, mutationSeed: 0.9 }, 1));
  assert.equal(allCohortWeights(cfg).length, 4 * 72);
});

test('generated configs give each cohort a different fresh network', () => {
  const cfg = makeNcaConfig({ ...TINY, weights: null, cohorts: 4 });
  const a = cohortWeights(cfg, 0);
  const b = cohortWeights(cfg, 1);
  assert.equal(a.length, 72);
  assert.notDeepEqual(a, b);
  // A wrong-length base is treated as generated rather than read out of range.
  assert.deepEqual(cohortWeights({ ...cfg, weights: [1, 2, 3] }, 0), a);
});

function ctxFor(config: NcaConfig, W = 24, H = 24): GridContext {
  return { W, H, config, boundary: BOUNDARY.WRAP };
}

function run(config: NcaConfig, steps: number, W = 24, H = 24): Float32Array {
  const ctx = ctxFor(config, W, H);
  const weights = allCohortWeights(config);
  let s = cpuInit(ctx);
  for (let i = 0; i < steps; i++) s = cpuStep(s, weights, i, ctx);
  return s;
}

/** The first `C` channels of every cell. */
function channels(state: Float32Array, Cfrom: number, C: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < state.length / Cfrom; i++)
    for (let c = 0; c < C; c++) out.push(state[i * Cfrom + c]!);
  return out;
}

function assertClose(a: number[], b: number[], tol = 1e-5): void {
  assert.equal(a.length, b.length);
  let worst = 0;
  a.forEach((v, i) => (worst = Math.max(worst, Math.abs(v - b[i]!))));
  assert.ok(worst < tol, `max diff ${worst}`);
}

const DYN: Partial<NcaConfig> = {
  activation: ACTIVATION.TANH,
  stateBound: STATE_BOUND.CLIP,
  fireRate: 0.7,
  dt: 0.5,
  cohorts: 4,
  cohortFences: false,
  initialConditions: IC.NOISE,
  mutationScale: 0.5,
};

test('growing channels and hidden units preserves the old channels exactly', () => {
  const small = makeNcaConfig({ ...DYN, ...TINY, weights: toStored(initWeights(TINY, 5)) });
  // Mutation off: mutation noise is keyed by flat offset, which the embed
  // moves, so mutated children of the two layouts are not comparable.
  const a = { ...small, mutationScale: 0 };
  const bigArch = { channels: 6, hidden: 9, perception: PERCEPTION.FIXED, learnedKernels: 1, laplacian: false };
  const grown = embedWeights(a.weights!, a, bigArch);
  assert.ok(grown !== null);
  const b = { ...a, ...bigArch, weights: grown };
  // NOISE IC hashes `idx * C + c`, so the initial states differ between the
  // two channel counts: use SEED, which writes the same value everywhere.
  const sa = run({ ...a, initialConditions: IC.SEED, seedRadius: 3 }, 6);
  const sb = run({ ...b, initialConditions: IC.SEED, seedRadius: 3 }, 6);
  assertClose(channels(sa, 4, 4), channels(sb, 6, 4));
});

test('switching fixed -> learned perception is exact', () => {
  const lapArch = { ...TINY, laplacian: true };
  const fixed = makeNcaConfig({ ...DYN, ...lapArch, mutationScale: 0, weights: toStored(initWeights(lapArch, 8)), initialConditions: IC.SEED });
  const learnedArch = { ...lapArch, perception: PERCEPTION.LEARNED, learnedKernels: 3 };
  const w = embedWeights(fixed.weights!, fixed, learnedArch);
  assert.ok(w !== null);
  const learned = { ...fixed, ...learnedArch, weights: w };
  assertClose(Array.from(run(fixed, 5)), Array.from(run(learned, 5)));
});

test('hidden 0 <-> hidden > 0 has no embedding', () => {
  const w = toStored(initWeights(TINY, 1));
  assert.equal(embedWeights(w, TINY, { ...TINY, hidden: 0 }), null);
});

test('fences isolate cohorts; without them information crosses', () => {
  const base = makeNcaConfig({
    ...DYN,
    ...TINY,
    cohorts: 4,
    weights: toStored(initWeights(TINY, 3)),
    mutationScale: 0,
    initialConditions: IC.ZERO,
    fireRate: 1,
  });
  const W = 16;
  const ctxF = ctxFor({ ...base, cohortFences: true }, W, W);
  const ctxN = ctxFor({ ...base, cohortFences: false }, W, W);
  const weights = allCohortWeights(base);
  // Zero everywhere except a blob in cohort 0 (top-left 8x8).
  const blob = (ctx: GridContext): Float32Array => {
    const s = cpuInit(ctx);
    for (let c = 0; c < 4; c++) s[(4 * W + 7) * 4 + c] = 1;
    return s;
  };
  const evolve = (ctx: GridContext): Float32Array => {
    let s = blob(ctx);
    const zero = cpuInit(ctx);
    // Subtract the blob-free evolution so a nonzero bias does not count as
    // "information": what matters is whether the BLOB is felt next door.
    let z = zero;
    for (let i = 0; i < 6; i++) {
      s = cpuStep(s, weights, i, ctx);
      z = cpuStep(z, weights, i, ctx);
    }
    return s.map((v, i) => v - z[i]!);
  };
  const cellOf = (s: Float32Array, x: number, y: number): number =>
    Math.abs(s[(y * W + x) * 4]!) + Math.abs(s[(y * W + x) * 4 + 1]!);
  const fenced = evolve(ctxF);
  const open = evolve(ctxN);
  // Cell (9, 4) is in cohort 1, two cells right of the blob.
  assert.equal(cellOf(fenced, 9, 4), 0);
  assert.ok(cellOf(open, 9, 4) > 0);
});

test('cpuStep is deterministic and stays bounded', () => {
  const cfg = makeNcaConfig({ ...DYN, ...TINY, weights: null, noise: 0.1, gain: 4, stateBound: STATE_BOUND.CLIP });
  const a = run(cfg, 4);
  const b = run(cfg, 4);
  assert.deepEqual(a, b);
  assert.ok(a.every((v) => v >= -1 && v <= 1));
});
