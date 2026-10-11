/**
 * Setting edits and the behaviour commands, as pure functions over a Project.
 *
 * Each takes the state it needs and returns the new state; the Orchestrator
 * owns applying it (`setProject`), recording it (`recordHistory`) and any
 * restart. Nothing here touches the GPU.
 *
 * ## Architecture edits carry the weights across
 *
 * Editing `channels`, `hidden`, `perception`, `learnedKernels` or `laplacian`
 * changes the weight vector's LAYOUT, so a plain field write would leave
 * `weights` the wrong length (which `cohortWeights` would then treat as
 * generated -- a new random network). `applySettingEdit` routes those fields
 * through `withArchEdit`, which zero-pads the old network into the new shape:
 * growing keeps the behaviour, and mutation fills the new capacity in.
 */

import { type Preferences, withValue } from '../prefs/preferences.ts';
import {
  type Project,
  editSelected,
  editWorld,
  selectedConfig,
  withConfigs,
} from '../project/project.ts';
import {
  ARCH_FIELDS,
  ARCH_LIMITS,
  type NcaArch,
  type NcaConfig,
  type NcaWorld,
} from '../nca/ncaConfig.ts';
import { withArchEdit } from '../nca/weights.ts';
import { type Setting, CONFIG, PREFS, WORLD, seedSetting, settingFor } from '../ui/settingsSpec.ts';

export type SettingEditResult =
  | { readonly kind: 'project'; readonly project: Project }
  | { readonly kind: 'prefs'; readonly prefs: Preferences };

export interface SettingEditSources {
  readonly project: Project;
  readonly prefs: Preferences;
}

function isArchField(field: string): field is keyof NcaArch {
  return (ARCH_FIELDS as readonly string[]).includes(field);
}

/** An architecture value as the layout will read it. */
function archValue(field: keyof NcaArch, value: number | boolean): number | boolean {
  if (field === 'laplacian') return !!value;
  const n = Math.round(Number(value));
  const limits = (ARCH_LIMITS as Record<string, readonly [number, number]>)[field];
  return limits === undefined ? n : Math.max(limits[0], Math.min(limits[1], n));
}

/** Route one registry edit to the project or the preferences. */
export function applySettingEdit(
  sources: SettingEditSources,
  setting: Setting,
  value: number | boolean,
): SettingEditResult {
  if (setting.source === CONFIG) {
    const project = sources.project;
    if (isArchField(setting.field)) {
      const config = selectedConfig(project);
      const v = archValue(setting.field, value);
      if (config[setting.field] === v) return { kind: 'project', project };
      const next = withArchEdit(config, { ...config, [setting.field]: v });
      const configs = project.configs.slice();
      configs[project.selected] = next;
      return { kind: 'project', project: withConfigs(project, configs) };
    }
    const field = setting.field as keyof NcaConfig;
    return {
      kind: 'project',
      project: editSelected(project, field, value as NcaConfig[typeof field]),
    };
  }
  if (setting.source === WORLD) {
    const field = setting.field as keyof NcaWorld;
    return {
      kind: 'project',
      project: editWorld(sources.project, field, value as NcaWorld[typeof field]),
    };
  }
  if (setting.source === PREFS) {
    return { kind: 'prefs', prefs: withValue(sources.prefs, setting.field, value) };
  }
  return { kind: 'project', project: sources.project };
}

/**
 * Reroll Mutations: a new mutation seed, so every cohort gets a new child of
 * the same base. Looked up by KIND through the registry so the field name
 * lives in one place. Null when the registry has no config SEED.
 */
export function randomizeSeed(
  project: Project,
  rng: () => number = Math.random,
): Project | null {
  const setting = seedSetting();
  if (setting === null || setting.source !== CONFIG) return null;
  const field = setting.field as keyof NcaConfig;
  return editSelected(project, field, rng() as NcaConfig[typeof field]);
}

/**
 * Randomize Behavior: drop the base network so every cohort gets a fresh
 * random one (`weights: null`), under a new seed.
 */
export function randomizeBehavior(
  project: Project,
  rng: () => number = Math.random,
): Project {
  const generated = editSelected(project, 'weights', null);
  return editSelected(generated, 'mutationSeed', rng());
}

/** Set the cohort count from the overlay's layout buttons. */
export function setPopulationLayout(project: Project, cohorts: number): Project {
  const setting = settingFor(CONFIG, 'cohorts');
  const clamped =
    setting === null
      ? cohorts
      : Math.min(Math.max(Math.round(cohorts), setting.lo), setting.hi);
  return editSelected(project, 'cohorts', clamped);
}

/**
 * Whether every cohort is currently a fresh random network rather than a
 * mutation of a base -- the state Randomize Behavior leaves.
 */
export function weightsAreGenerated(project: Project): boolean {
  return selectedConfig(project).weights === null;
}

/**
 * Whether committing a cohort would change nothing: every cohort runs the
 * base network exactly (mutation scale 0 on a concrete base). Generated
 * cohorts always differ, so selecting one always does something.
 */
export function selectionIsNoOp(project: Project): boolean {
  if (weightsAreGenerated(project)) return false;
  return selectedConfig(project).mutationScale === 0;
}

/**
 * Whether Reroll Mutations would do nothing visible. Under generated weights a
 * new seed IS a new random population, but that act is Randomize Behavior's,
 * and `F` deliberately only ever rerolls mutations -- see the Orchestrator.
 */
export function rerollIsNoOp(project: Project): boolean {
  if (weightsAreGenerated(project)) return true;
  return selectedConfig(project).mutationScale === 0;
}
