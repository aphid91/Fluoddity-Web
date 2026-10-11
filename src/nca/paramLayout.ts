/**
 * The weight vector's layout: which named tensor lives at which offset.
 *
 * ONE FLAT `f32` ARRAY PER COHORT, tensors back to back, in this order:
 *
 *   perc     [K][C][9]   learned 3x3 kernels (LEARNED perception only)
 *   fc0.w    [H][P]      hidden layer        (hidden > 0)
 *   fc0.b    [H]
 *   fc1.w    [C][H]      output layer        (hidden > 0)
 *   fc1.b    [C]
 *   fc.w     [C][P]      single layer        (hidden == 0)
 *   fc.b     [C]
 *
 * Row-major, PyTorch `nn.Linear` convention (`weight[out][in]`), so a trained
 * Growing-NCA's `state_dict` maps across tensor by tensor.
 *
 * ## The feature order
 *
 * Feature `f = kind * C + c`: all channels' identity first, then all channels'
 * first filter, and so on -- the order `torch.cat([x, sobel_x(x), sobel_y(x)],
 * dim=1)` produces in the reference Growing-NCA. `featureKinds` names the kinds.
 *
 * Kernel taps are `t = (dy + 1) * 3 + (dx + 1)` with +y DOWN the grid.
 *
 * A PURE LEAF. The shader generator, the CPU reference step, mutation and the
 * architecture embed all read offsets from here, so they cannot disagree.
 */

import { type NcaArch, PERCEPTION, archOf } from './ncaConfig.ts';

/** A perception feature kind. `kN` is learned kernel N. */
export type FeatureKind = 'id' | 'sx' | 'sy' | 'lap' | `k${number}`;

/** The fixed filters, normalized the way the reference Growing-NCA does. */
export const FIXED_KERNELS: Readonly<Record<'sx' | 'sy' | 'lap', readonly number[]>> = {
  sx: [-1, 0, 1, -2, 0, 2, -1, 0, 1].map((v) => v / 8),
  sy: [-1, -2, -1, 0, 0, 0, 1, 2, 1].map((v) => v / 8),
  lap: [1, 2, 1, 2, -12, 2, 1, 2, 1].map((v) => v / 16),
};

export function featureKinds(arch: NcaArch): readonly FeatureKind[] {
  const a = archOf(arch);
  if (a.perception === PERCEPTION.LEARNED) {
    return ['id', ...Array.from({ length: a.learnedKernels }, (_, i) => `k${i}` as const)];
  }
  return a.laplacian ? ['id', 'sx', 'sy', 'lap'] : ['id', 'sx', 'sy'];
}

export interface Tensor {
  readonly name: 'perc' | 'fc0.w' | 'fc0.b' | 'fc1.w' | 'fc1.b' | 'fc.w' | 'fc.b';
  readonly offset: number;
  readonly shape: readonly number[];
  readonly size: number;
  /**
   * The unit mutation noise is measured in. Scaling noise per tensor is what
   * makes one Mutation Scale mean the same thing at 70 params and at 8000.
   */
  readonly std: number;
  /**
   * The std a fresh network is drawn with. Equal to `std` for weights; ZERO for
   * biases, so a fresh network maps an all-zero neighbourhood to a zero update
   * -- the quiescent background every seed-growing NCA relies on. With random
   * biases every empty cell drifts, and each cohort saturates to a flat colour
   * before any seed can matter.
   */
  readonly initStd: number;
}

export interface ParamLayout {
  readonly arch: NcaArch;
  readonly channels: number;
  readonly hidden: number;
  /** Features per channel. */
  readonly kinds: readonly FeatureKind[];
  /** Total perception features, `kinds.length * channels`. */
  readonly features: number;
  readonly tensors: readonly Tensor[];
  readonly count: number;
}

/** Std of the learned perception kernels (Sobel/8 taps are <= 0.25). */
export const KERNEL_STD = 0.25;
/** The unit biases are mutated in. They are initialised at zero. */
export const BIAS_STD = 0.02;

export function paramLayout(arch: NcaArch): ParamLayout {
  const a = archOf(arch);
  const C = a.channels;
  const H = a.hidden;
  const kinds = featureKinds(a);
  const P = kinds.length * C;

  const tensors: Tensor[] = [];
  let offset = 0;
  const add = (name: Tensor['name'], shape: number[], std: number, initStd = std): void => {
    const size = shape.reduce((x, y) => x * y, 1);
    tensors.push({ name, offset, shape, size, std, initStd });
    offset += size;
  };

  if (a.perception === PERCEPTION.LEARNED) add('perc', [a.learnedKernels, C, 9], KERNEL_STD);
  if (H > 0) {
    add('fc0.w', [H, P], 1 / Math.sqrt(P));
    add('fc0.b', [H], BIAS_STD, 0);
    add('fc1.w', [C, H], 1 / Math.sqrt(H));
    add('fc1.b', [C], BIAS_STD, 0);
  } else {
    add('fc.w', [C, P], 1 / Math.sqrt(P));
    add('fc.b', [C], BIAS_STD, 0);
  }

  return { arch: a, channels: C, hidden: H, kinds, features: P, tensors, count: offset };
}

export function paramCount(arch: NcaArch): number {
  return paramLayout(arch).count;
}

export function tensorNamed(layout: ParamLayout, name: Tensor['name']): Tensor | null {
  return layout.tensors.find((t) => t.name === name) ?? null;
}
