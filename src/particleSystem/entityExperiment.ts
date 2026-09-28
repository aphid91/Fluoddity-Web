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
  /** 0 hand-unrolled pair; 1 one loop, both terms; 2 base loop then mirror loop. */
  readonly blackBoxForm: number;
  /** Replace sin/cos with a cheap bounded parabola. */
  readonly cheapTrig: boolean;
  /** One sin/cos pair per term: the op count of the angle-addition rewrite. */
  readonly halfTrig: boolean;
  /** Every thread reads its rule from config slot 0. */
  readonly ruleSlotZero: boolean;

  // --- the canvas update pass (canvas.wgsl) ---
  /** Record the canvas update and the brush splat in ONE render pass. */
  readonly fuseCanvasSplat: boolean;
  /** Texels read per fragment: 5 (the real cross), 1 or 0. */
  readonly canvasTaps: number;
  /** textureLoad exact texels instead of sampling through the filter. */
  readonly canvasLoad: boolean;
  /** Run the canvas update every Nth sub-step, with persistence^N. */
  readonly canvasEvery: number;

  // --- probes for the compute-to-graphics switch ---
  /** Record no entity update pass at all, except on the reset frame. */
  readonly skipEntityPass: boolean;
  /** An empty 1x1 render pass straight after the entity update. */
  readonly renderProbe: boolean;
}

/** The choices on offer, indexed by the preferences' stored values. */
export const EXPERIMENT_CANVAS_TAPS: readonly number[] = [5, 1, 0];
export const EXPERIMENT_CANVAS_EVERY: readonly number[] = [1, 2, 3, 5];

/** The workgroup sizes on offer, indexed by the preference's stored value. */
export const EXPERIMENT_WORKGROUP_SIZES: readonly number[] = [256, 128, 64];

export const NO_EXPERIMENT: EntityExperiment = Object.freeze({
  earlyOut: 0,
  slimConfig: false,
  noSensors: false,
  blackBoxCenters: 10,
  noExtras: false,
  workgroupSize: 256,
  blackBoxForm: 0,
  cheapTrig: false,
  halfTrig: false,
  ruleSlotZero: false,
  fuseCanvasSplat: false,
  canvasTaps: 5,
  canvasLoad: false,
  canvasEvery: 1,
  skipEntityPass: false,
  renderProbe: false,
});

/** The `override` values for `canvas.wgsl`, as pipeline `constants`. */
export function canvasExperimentConstants(e: EntityExperiment): Record<string, number> {
  return {
    EXP_CANVAS_TAPS: e.canvasTaps,
    EXP_CANVAS_LOAD: e.canvasLoad ? 1 : 0,
    EXP_CANVAS_EVERY: e.canvasEvery,
  };
}

/** Whether two sets of pipeline constants would build the same pipeline. */
export function sameConstants(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/** The `override` values for `entityUpdate.wgsl`, as pipeline `constants`. */
export function experimentConstants(e: EntityExperiment): Record<string, number> {
  return {
    EXP_EARLY_OUT: e.earlyOut,
    EXP_SLIM_CONFIG: e.slimConfig ? 1 : 0,
    EXP_NO_SENSORS: e.noSensors ? 1 : 0,
    EXP_BB_CENTERS: e.blackBoxCenters,
    EXP_NO_EXTRAS: e.noExtras ? 1 : 0,
    EXP_WORKGROUP_SIZE: e.workgroupSize,
    EXP_BB_FORM: e.blackBoxForm,
    EXP_CHEAP_TRIG: e.cheapTrig ? 1 : 0,
    EXP_HALF_TRIG: e.halfTrig ? 1 : 0,
    EXP_RULE_SLOT0: e.ruleSlotZero ? 1 : 0,
  };
}

export function sameExperiment(a: EntityExperiment, b: EntityExperiment): boolean {
  return (
    a.earlyOut === b.earlyOut &&
    a.slimConfig === b.slimConfig &&
    a.noSensors === b.noSensors &&
    a.blackBoxCenters === b.blackBoxCenters &&
    a.noExtras === b.noExtras &&
    a.workgroupSize === b.workgroupSize &&
    a.blackBoxForm === b.blackBoxForm &&
    a.cheapTrig === b.cheapTrig &&
    a.halfTrig === b.halfTrig &&
    a.ruleSlotZero === b.ruleSlotZero &&
    a.fuseCanvasSplat === b.fuseCanvasSplat &&
    a.canvasTaps === b.canvasTaps &&
    a.canvasLoad === b.canvasLoad &&
    a.canvasEvery === b.canvasEvery &&
    a.skipEntityPass === b.skipEntityPass &&
    a.renderProbe === b.renderProbe
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
  if (e.blackBoxForm === 1) parts.push('loop');
  if (e.blackBoxForm === 2) parts.push('two-loops');
  if (e.cheapTrig) parts.push('cheap-trig');
  if (e.halfTrig) parts.push('half-trig');
  if (e.ruleSlotZero) parts.push('rule-slot0');
  if (e.fuseCanvasSplat) parts.push('fuse-canvas');
  if (e.canvasTaps !== 5) parts.push(`taps=${e.canvasTaps}`);
  if (e.canvasLoad) parts.push('canvas-load');
  if (e.canvasEvery !== 1) parts.push(`canvas-every=${e.canvasEvery}`);
  if (e.skipEntityPass) parts.push('skip-entity');
  if (e.renderProbe) parts.push('render-probe');
  return parts.join(' ');
}
