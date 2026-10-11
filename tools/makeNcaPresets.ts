/**
 * Writes the shipped NCA presets into `configs/`, through `toDocument` so every
 * file is exactly what the app would save. Then run `npm run sync:configs`.
 *
 *   node tools/makeNcaPresets.ts
 *
 * Presets ship GENERATED (`weights: null`): each cohort is a fresh random
 * network keyed by the mutation seed. They are starting points for selection,
 * not trained creatures. Adopting any cohort turns it into a concrete base.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { toDocument } from '../src/config/persistence.ts';
import {
  ACTIVATION,
  BOUNDARY,
  DISPLAY,
  IC,
  PERCEPTION,
  STATE_BOUND,
  makeNcaConfig,
  makeNcaWorld,
  type NcaConfig,
  type NcaWorld,
} from '../src/nca/ncaConfig.ts';
import { paramCount } from '../src/nca/paramLayout.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Preset {
  readonly name: string;
  readonly notes: string;
  readonly config: Partial<NcaConfig>;
  readonly world?: Partial<NcaWorld>;
}

const PRESETS: Preset[] = [
  {
    name: 'Tiny',
    notes: 'Fluoddity-sized: 4 channels, 4 hidden units, fixed Sobel perception -- 72 parameters.',
    config: { channels: 4, hidden: 4, activation: ACTIVATION.TANH, gain: 2.0, mutationSeed: 0.11 },
  },
  {
    name: 'Small',
    notes: '8 channels, 32 hidden units: about a thousand parameters.',
    config: { channels: 8, hidden: 32, mutationSeed: 0.5 },
  },
  {
    name: 'Medium',
    notes: '12 channels, 64 hidden units: about three thousand parameters.',
    config: { channels: 12, hidden: 64, mutationSeed: 0.73 },
  },
  {
    name: 'Classic',
    notes:
      'The Growing-NCA architecture (16 channels, 128 hidden, Sobel perception, alive ' +
      'masking, 50% fire rate) -- untrained. About 8k parameters.',
    config: {
      channels: 16,
      hidden: 128,
      aliveMask: true,
      stateBound: STATE_BOUND.CLIP,
      fireRate: 0.5,
      dt: 1.0,
      mutationSeed: 0.31,
      seedRadius: 1,
    },
    world: { displayMode: DISPLAY.RGBA },
  },
  {
    name: 'Learned',
    notes:
      'A single-layer NCA with two learned 3x3 kernels per channel: the perception ' +
      'itself is under selection.',
    config: {
      channels: 4,
      hidden: 0,
      perception: PERCEPTION.LEARNED,
      learnedKernels: 2,
      activation: ACTIVATION.TANH,
      mutationSeed: 0.62,
    },
  },
  {
    name: 'Soup',
    notes: 'Noise initial conditions, no fences: the cohorts compete for the whole torus.',
    config: {
      channels: 6,
      hidden: 16,
      activation: ACTIVATION.SIN,
      initialConditions: IC.NOISE,
      icAmplitude: 0.5,
      cohortFences: false,
      cohorts: 4,
      stateBound: STATE_BOUND.TANH,
      mutationSeed: 0.9,
    },
    world: { boundary: BOUNDARY.WRAP },
  },
];

for (const preset of PRESETS) {
  const config = makeNcaConfig(preset.config);
  const doc = toDocument([config], makeNcaWorld(preset.world ?? {}), preset.notes);
  const file = path.join(ROOT, 'configs', `${preset.name}.json`);
  await fs.writeFile(file, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, file)}  (${paramCount(config)} params)`);
}
