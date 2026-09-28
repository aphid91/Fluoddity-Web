/**
 * EXPERIMENT: ablation switches for the entity update pass.
 *
 * On most machines the brush splat is the frame's biggest pass; on at least one
 * phone it is entity update, and nothing in the shader says why. Each switch
 * here removes one part of `entityUpdate.wgsl` so the `?debug` overlay's
 * `entity-update` timing can be read with and without it.
 *
 * ## Pipeline constants, not uniforms
 *
 * Every switch is a WGSL `override`, so a disabled part is COMPILED OUT rather
 * than branched around. A uniform branch would leave the skipped code's
 * registers allocated, and register pressure -- occupancy -- is one of the
 * things being measured. Changing a switch therefore rebuilds the pipeline.
 *
 * ## Each stand-in keeps its inputs alive
 *
 * Removing a stage outright would let the compiler delete everything that only
 * fed it (no black box, and the sensor reads become dead code too), so each
 * ablation substitutes something cheap that still consumes what the real stage
 * consumed. The simulation looks wrong while any of these is on; that is fine,
 * the timings are the point.
 *
 * TEMPORARY. Meant to be reverted once the phone's bottleneck is found.
 */

export interface EntityExperiment {
  /**
   * 0 off; 1 return right after the bounds check; 2 read, move, write, return.
   * Both still run the reset frame -- see `main` in entityUpdate.wgsl.
   */
  readonly earlyOut: number;
  /** Build the config local without its 320-byte Rule (behaviour unchanged). */
  readonly slimConfig: boolean;
  /** Replace both canvas samples with arithmetic on the sensor position. */
  readonly noSensors: boolean;
  /** Fourier centers evaluated, 0..10. 10 is the real black box. */
  readonly blackBoxCenters: number;
  /** Skip hazard, stall rescue, jitter, gravity, walls, shove and fences. */
  readonly noExtras: boolean;
  /** Entity update's @workgroup_size. */
  readonly workgroupSize: number;
}

/** The workgroup sizes on offer, indexed by the preference's stored value. */
export const EXPERIMENT_WORKGROUP_SIZES: readonly number[] = [256, 128, 64];

export const NO_EXPERIMENT: EntityExperiment = Object.freeze({
  earlyOut: 0,
  slimConfig: false,
  noSensors: false,
  blackBoxCenters: 10,
  noExtras: false,
  workgroupSize: 256,
});

/** The `override` values for `entityUpdate.wgsl`, as pipeline `constants`. */
export function experimentConstants(e: EntityExperiment): Record<string, number> {
  return {
    EXP_EARLY_OUT: e.earlyOut,
    EXP_SLIM_CONFIG: e.slimConfig ? 1 : 0,
    EXP_NO_SENSORS: e.noSensors ? 1 : 0,
    EXP_BB_CENTERS: e.blackBoxCenters,
    EXP_NO_EXTRAS: e.noExtras ? 1 : 0,
    EXP_WORKGROUP_SIZE: e.workgroupSize,
  };
}

export function sameExperiment(a: EntityExperiment, b: EntityExperiment): boolean {
  return (
    a.earlyOut === b.earlyOut &&
    a.slimConfig === b.slimConfig &&
    a.noSensors === b.noSensors &&
    a.blackBoxCenters === b.blackBoxCenters &&
    a.noExtras === b.noExtras &&
    a.workgroupSize === b.workgroupSize
  );
}

/** One line for the `?debug` overlay, so a reading is labelled with what produced it. */
export function describeExperiment(e: EntityExperiment): string {
  if (sameExperiment(e, NO_EXPERIMENT)) return 'off';
  const parts: string[] = [];
  if (e.earlyOut === 1) parts.push('EMPTY');
  if (e.earlyOut === 2) parts.push('MOVE-ONLY');
  if (e.slimConfig) parts.push('slim-config');
  if (e.noSensors) parts.push('no-sensors');
  if (e.blackBoxCenters !== 10) parts.push(`bb=${e.blackBoxCenters}`);
  if (e.noExtras) parts.push('no-extras');
  if (e.workgroupSize !== 256) parts.push(`wg=${e.workgroupSize}`);
  return parts.join(' ');
}
