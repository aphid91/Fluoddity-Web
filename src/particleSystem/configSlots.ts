/**
 * What goes in the GPU's config buffer: the project's configs, laid out as SLOTS.
 *
 * ## Why slots are not configs
 *
 * Each slot's rule is the one its particles OBEY: the parent rule with that
 * slot's cohort mutation already applied. The `cohortRules.wgsl` pass bakes it
 * in, in place, once per upload. Particles then read their rule straight out of
 * the buffer instead of deriving it every step -- which is not only the mutation
 * maths saved. Deriving meant every thread held a whole 320-byte Rule as a local
 * and indexed it in a loop, which the browser's shader compilers spill to slow
 * per-thread memory. That copy cost ~5x the entity update on its own.
 *
 * So a slot is a config PER COHORT, and the two modalities fill them differently:
 *
 *   STUDIO  (perCohort)  one parent config, repeated once per cohort. Slot `i`
 *                        is cohort `i`, and entityUpdate.wgsl recomputes each
 *                        particle's slot from its index every step, so the
 *                        Cohorts slider still acts live.
 *
 *   SAND                 one slot per palette config, each forced to ONE cohort.
 *                        Particles keep the `config_index` their spawn gave
 *                        them, and every one of them is cohort 0 of its config.
 *
 * THE PROJECT NEVER SEES ANY OF THIS. Saves, share links, undo and the archive
 * all hold the parent configs; the expansion exists only between here and the
 * GPU, and is rebuilt from scratch on every upload.
 *
 * ## Why the studio expands `configs[0]`, not the selected config
 *
 * Because that is the config the studio has always simulated: before slots,
 * `assign_config_index` returned 0 for every particle. A studio project can carry
 * several configs in its file, but only the first ever reached the physics.
 */

import type { SimulationConfig } from './config.ts';

/**
 * The most slots one config may expand into.
 *
 * Far above the Cohorts slider's 64 -- this is not a product limit but a guard
 * against a hand-edited or hostile file asking for a million cohorts and a
 * 400 MB buffer. A config past it still runs: its extra cohorts clamp onto the
 * last slot in the shader, the same degradation any out-of-range index gets.
 */
export const MAX_COHORT_SLOTS = 4096;

/** How many slots one config's cohorts occupy. Always at least one. */
export function cohortSlotCount(config: SimulationConfig): number {
  const n = Math.trunc(config.cohorts);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), MAX_COHORT_SLOTS) : 1;
}

/**
 * The configs to upload, one per slot. See the file header for the two layouts.
 *
 * Returns the SAME objects where nothing changes (every studio slot is the
 * parent itself), so this allocates one array and, in sand, only the configs
 * that were not already single-cohort.
 */
export function configSlots(
  configs: readonly SimulationConfig[],
  perCohort: boolean,
): readonly SimulationConfig[] {
  if (perCohort) {
    const parent = configs[0];
    if (parent === undefined) return [];
    return new Array<SimulationConfig>(cohortSlotCount(parent)).fill(parent);
  }
  return configs.map((c) => (c.cohorts === 1 ? c : { ...c, cohorts: 1 }));
}
