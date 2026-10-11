/**
 * GPU vs CPU parity for the NCA kernels. Served by `npm run dev` at
 * `/tools/ncaParity.html`; driven headlessly by `tools/ncaParityCheck.mjs`.
 *
 * For each case: build an NcaSystem on a small grid, let it initialise, run a
 * few steps, read the state back, and compare against `cpuInit` + `cpuStep`
 * with the same config. Covers fixed and learned perception, hidden 0 and > 0,
 * every activation and bound, fences on and off, zero boundary, the alive mask,
 * noise, partial fire rates and walls.
 *
 * Writes `window.__ncaParity = { ok, results }` when done.
 */

import { NcaSystem } from '../src/nca/ncaSystem.ts';
import {
  ACTIVATION,
  BOUNDARY,
  IC,
  PERCEPTION,
  STATE_BOUND,
  makeNcaConfig,
  makeNcaWorld,
  type NcaConfig,
} from '../src/nca/ncaConfig.ts';
import { cpuInit, cpuStep } from '../src/nca/cpuStep.ts';
import { allCohortWeights, initWeights, toStored } from '../src/nca/weights.ts';

interface Case {
  readonly name: string;
  readonly config: Partial<NcaConfig>;
  readonly boundary?: number;
  readonly walls?: boolean;
  readonly W?: number;
  readonly H?: number;
  readonly steps?: number;
}

const CASES: Case[] = [
  { name: 'fixed relu clip seed', config: {} },
  { name: 'fixed tanh, fences off, noise ic', config: { activation: ACTIVATION.TANH, cohortFences: false, initialConditions: IC.NOISE } },
  { name: 'laplacian sin clip01', config: { laplacian: true, activation: ACTIVATION.SIN, stateBound: STATE_BOUND.CLIP01, initialConditions: IC.NOISE } },
  { name: 'learned K=3', config: { perception: PERCEPTION.LEARNED, learnedKernels: 3, initialConditions: IC.NOISE } },
  { name: 'hidden 0', config: { hidden: 0, activation: ACTIVATION.TANH, initialConditions: IC.NOISE } },
  { name: 'zero boundary, tanh bound, leak, noise', config: { cohortFences: false, stateBound: STATE_BOUND.TANH, leak: 0.05, noise: 0.03, initialConditions: IC.NOISE }, boundary: BOUNDARY.ZERO },
  { name: 'alive mask, sparse ic', config: { aliveMask: true, initialConditions: IC.SPARSE, icDensity: 0.02, seedRadius: 2 } },
  { name: 'unbounded, fire 1', config: { stateBound: STATE_BOUND.NONE, fireRate: 1, initialConditions: IC.NOISE, gain: 0.5 } },
  { name: 'walls, odd grid, 7 cohorts', config: { cohorts: 7, initialConditions: IC.NOISE }, walls: true, W: 37, H: 23 },
  { name: 'C=16 H=64 generated', config: { channels: 16, hidden: 64, weights: null, initialConditions: IC.NOISE } },
];

function configFor(c: Case): NcaConfig {
  const base = makeNcaConfig({
    channels: 6,
    hidden: 10,
    cohorts: 4,
    mutationScale: 0.4,
    fireRate: 0.6,
    dt: 0.7,
    gain: 1.3,
    icSeed: 0.37,
    ...c.config,
  });
  if ('weights' in c.config) return base;
  return { ...base, weights: toStored(initWeights(base, 1234)) };
}

async function runCase(device: GPUDevice, c: Case): Promise<{ name: string; maxDiff: number; maxAbs: number }> {
  const W = c.W ?? 32;
  const H = c.H ?? 24;
  const steps = c.steps ?? 6;
  const config = configFor(c);
  const world = makeNcaWorld({ boundary: c.boundary ?? BOUNDARY.WRAP });
  const system = await NcaSystem.create({ device, config, world, gridSize: [W, H], physicsSteps: steps });

  let walls: Uint8Array | null = null;
  if (c.walls) {
    walls = new Uint8Array(W * H);
    for (let y = 3; y < 15; y++) walls[y * W + 11] = 1;
    for (let x = 5; x < 30; x++) walls[17 * W + x] = 1;
    system.writeWalls(Uint32Array.from(walls));
  }

  // Frame 1: init only (0 steps) -- compare the initial conditions.
  let encoder = device.createCommandEncoder();
  system.physicsSteps = 0;
  system.prepareFrame(encoder, 0);
  system.runSteps(encoder);
  device.queue.submit([encoder.finish()]);
  const gpuInit = await system.readState();

  // Frame 2: `steps` steps.
  encoder = device.createCommandEncoder();
  system.physicsSteps = steps;
  system.prepareFrame(encoder, steps);
  system.runSteps(encoder);
  device.queue.submit([encoder.finish()]);
  const gpu = await system.readState();
  system.destroy();

  const ctx = { W, H, config, boundary: world.boundary, walls };
  let cpu = cpuInit(ctx);
  let maxDiff = 0;
  cpu.forEach((v, i) => (maxDiff = Math.max(maxDiff, Math.abs(v - gpuInit[i]!))));
  if (maxDiff > 1e-6) return { name: `${c.name} [INIT]`, maxDiff, maxAbs: 0 };

  const weights = allCohortWeights(config);
  for (let i = 0; i < steps; i++) cpu = cpuStep(cpu, weights, i, ctx);
  let maxAbs = 0;
  cpu.forEach((v, i) => {
    maxDiff = Math.max(maxDiff, Math.abs(v - gpu[i]!));
    maxAbs = Math.max(maxAbs, Math.abs(v));
  });
  return { name: c.name, maxDiff, maxAbs };
}

async function main(): Promise<void> {
  const out = document.getElementById('out')!;
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) {
    out.textContent = 'no WebGPU adapter';
    (window as unknown as Record<string, unknown>).__ncaParity = { ok: false, error: 'no adapter' };
    return;
  }
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));

  const results = [];
  for (const c of CASES) results.push(await runCase(device, c));
  // Relative tolerance: unbounded cases can grow large.
  const ok =
    errors.length === 0 &&
    results.every((r) => !r.name.includes('[INIT]') && r.maxDiff <= 1e-3 * Math.max(1, r.maxAbs));
  out.textContent = JSON.stringify({ ok, errors, results }, null, 2);
  (window as unknown as Record<string, unknown>).__ncaParity = { ok, errors, results };
}

void main();
