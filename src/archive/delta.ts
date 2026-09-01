/**
 * What changed between two project states, in as few bytes as will replay.
 *
 * ## Derived by DIFFING, not by intercepting commands
 *
 * The archive hooks `Orchestrator.recordHistory`, which holds `before` and the
 * live project and nothing else. It does not see the `Command` that caused the
 * change, and that is the right side of the trade:
 *
 *   - `randomizeSeed` draws from `Math.random()` INSIDE `settingsCommands.ts`
 *     and the drawn value survives only in the resulting `Project`. Intercepting
 *     the command would capture `{kind:'randomizeSeed'}` and lose the number.
 *     Diffing reads the seed straight out of the after-state.
 *   - One code path covers every command, including ones added later. A command
 *     that forgets to tag itself still archives correctly; only its LABEL is
 *     less specific.
 *
 * The exception is `commitSelection`, whose cohort number is not recoverable
 * from the diff -- see `ArchiveTag` below.
 *
 * ## Why a cohort selection is four bytes and not 1.4 kB
 *
 * `derive_entity_rule` (`rule.wgsl`) is a pure function of the parent's rule,
 * `mutationSeed`, `mutationScale` and the cohort. So an adopted rule is fully
 * determined by the parent state plus one integer, and storing the 80 resulting
 * floats would be storing a value the reconstructor can compute. At the measured
 * mix -- reroll and cohort selection being the two commonest acts -- that is the
 * difference between ~1.4 kB and ~40 bytes on the second-commonest event.
 *
 * **THE RECONSTRUCTOR MUST DERIVE IT THROUGH THE REAL SHADER.** `rule.wgsl`'s
 * header is emphatic that host-side mirrors of that function are a mistake the
 * desktop made and the port deleted: `pow(h, 2.0)` versus `h*h` differs by 1 ULP
 * and the chaotic hash amplifies it into a completely different rule, and the
 * generator relies on a GPU fused multiply-add. A rule reconstructed by
 * approximate arithmetic looks legitimate and is wrong. The export therefore
 * ships `rule.wgsl` and its content hash (`export.ts`) so the offline
 * reconstruction can run that exact code rather than re-implement it.
 *
 * ## Sizes
 *
 * A scalar edit or a reroll is one field: `{c, f, v}` plus the node's own
 * bookkeeping, ~40 bytes as a structured clone. A cohort selection is `{cohort}`.
 * A whole-rule replacement that is NOT derivable -- a paste, a load -- falls back
 * to `full`, which is the honest answer rather than a lossy one.
 */

import type { Project } from '../project/project.ts';
import type { SimulationConfig, WorldSettings } from '../particleSystem/config.ts';

/**
 * The structured half of an event, supplied by the call site when the diff
 * cannot recover it.
 *
 * **ONLY `commitSelection` NEEDS ONE**, and the reason is specific: the adopted
 * rule is derivable from the cohort number, but the cohort number is not
 * derivable from the rule -- inverting `mutate_rule` is not a thing. The
 * orchestrator knows it (`result.cohort` comes back from the pick), so it passes
 * it down rather than making the archive guess.
 *
 * Every other command is left untagged on purpose. Adding a tag per command
 * would rebuild the `Command` union inside the archive and give every future
 * command a second place to be registered; the diff already describes them.
 */
export type ArchiveTag = { readonly kind: 'commitSelection'; readonly cohort: number };

/**
 * One config field changing, named by index so it can be replayed without
 * `selected`.
 *
 * The index is explicit because `hash.ts` deliberately excludes `selected` from
 * state identity: an edit lands on `project.selected`, so a delta that did not
 * carry the index would be unreplayable against a state that does not record
 * which slot was live.
 */
export interface ConfigFieldDelta {
  readonly kind: 'configField';
  readonly config: number;
  readonly field: keyof SimulationConfig;
  /** Post-edit value. Rules are excluded here -- see `ruleDelta`. */
  readonly value: number | boolean;
}

/** One world setting changing. `world` is in the hash, so these are real nodes. */
export interface WorldFieldDelta {
  readonly kind: 'worldField';
  readonly field: keyof WorldSettings;
  readonly value: number | boolean;
}

/**
 * A rule adopted from a picked particle.
 *
 * Carries the cohort ONLY. The 80 floats are `derive_entity_rule(parent.rule,
 * cohort, parent config)` and are recomputed offline -- see the header.
 */
export interface SelectionDelta {
  readonly kind: 'selection';
  readonly config: number;
  readonly cohort: number;
}

/**
 * The rule zeroed to the sentinel and the seed moved: Randomize Behavior.
 *
 * `ZERO_RULE` is not a rule, it is the "no target given" signal that makes
 * `derive_entity_rule` take its generate branch (`settingsCommands.ts`,
 * `rule.wgsl`). So the 80 zeros are a constant, and the only real payload is the
 * new seed.
 */
export interface RandomizeDelta {
  readonly kind: 'randomize';
  readonly config: number;
  readonly seed: number;
}

/**
 * A rule that arrived from outside -- a load, a paste, a checkpoint.
 *
 * The only delta that stores 80 floats, and it does so because there is nothing
 * to derive them FROM: the rule did not come from the parent state. Rare by
 * construction; the two common paths above are the ones that were worth
 * compressing.
 */
export interface RuleDelta {
  readonly kind: 'rule';
  readonly config: number;
  readonly rule: readonly number[];
}

/**
 * Everything changed at once, or changed in a way no narrower delta describes.
 *
 * The escape hatch, and it must exist: a preset load replaces every config and a
 * multi-field change has no single field to name. Storing the full state is
 * bigger, and it is CORRECT, which is the property that matters -- a delta that
 * silently described only part of a change would corrupt every descendant.
 */
export interface FullDelta {
  readonly kind: 'full';
  readonly configs: readonly SimulationConfig[];
  readonly world: WorldSettings;
}

export type Delta =
  | ConfigFieldDelta
  | WorldFieldDelta
  | SelectionDelta
  | RandomizeDelta
  | RuleDelta
  | FullDelta;

/** Fields compared scalar-wise. `rule` is handled separately; it is an array. */
const SCALAR_CONFIG_FIELDS = [
  'cohorts',
  'mutationSeed',
  'sensorGain',
  'sensorAngle',
  'sensorDistance',
  'mutationScale',
  'globalForceMult',
  'drag',
  'strafePower',
  'axialForce',
  'lateralForce',
  'hazardRate',
  'gravityForce',
  'gravityStrafe',
  'initialConditions',
  'cohortFences',
  'colorSensitivity',
  'colorByCohort',
  'sensorAngleJitter',
  'sensorDistanceJitter',
  'radialGravity',
] as const satisfies readonly (keyof SimulationConfig)[];

const WORLD_FIELDS = [
  'trailPersistence',
  'trailDiffusion',
  'boundaryConditions',
] as const satisfies readonly (keyof WorldSettings)[];

/** True when two rules differ. Length first, so a reshape counts. */
function ruleDiffers(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return true;
  return a.some((v, i) => v !== b[i]);
}

/** Every zero, which is how `ZERO_RULE` reads without importing it. */
function isZeroRule(rule: readonly number[]): boolean {
  return rule.length > 0 && rule.every((v) => v === 0);
}

/** Which config slots differ, by reference first -- untouched slots share identity. */
function changedSlots(before: Project, after: Project): number[] {
  const slots: number[] = [];
  for (let i = 0; i < after.configs.length; i++) {
    if (before.configs[i] !== after.configs[i]) slots.push(i);
  }
  return slots;
}

/** Which world fields differ. */
function changedWorldFields(before: Project, after: Project): (keyof WorldSettings)[] {
  if (before.world === after.world) return [];
  return WORLD_FIELDS.filter((f) => before.world[f] !== after.world[f]);
}

/**
 * The narrowest delta that fully describes `before -> after`.
 *
 * **FALLS BACK TO `full` WHENEVER IT CANNOT BE SURE.** A delta is a promise that
 * replaying it reproduces the state exactly; a narrow delta that missed a second
 * changed field would corrupt not just its own node but every descendant, and it
 * would do so silently. So every case that is not positively recognized returns
 * the whole state. `full` is ~1.8 kB against ~40 bytes, which is why the
 * recognized cases are the ones that actually happen.
 *
 * `tag` supplies what the diff cannot recover -- today, a selection's cohort.
 */
export function deriveDelta(
  before: Project,
  after: Project,
  tag: ArchiveTag | null = null,
): Delta {
  // A slot count change reshapes the project; nothing narrower can express it.
  if (before.configs.length !== after.configs.length) {
    return { kind: 'full', configs: after.configs, world: after.world };
  }

  const slots = changedSlots(before, after);
  const worldFields = changedWorldFields(before, after);

  // World-only, single field. `world` is in the hash, so this is a real node.
  if (slots.length === 0 && worldFields.length === 1) {
    const field = worldFields[0]!;
    return { kind: 'worldField', field, value: after.world[field] };
  }
  // Config and world both moved, or several world fields did: no single name.
  if (slots.length !== 1 || worldFields.length > 0) {
    return { kind: 'full', configs: after.configs, world: after.world };
  }

  const index = slots[0]!;
  const a = before.configs[index]!;
  const b = after.configs[index]!;

  const scalars = SCALAR_CONFIG_FIELDS.filter((f) => a[f] !== b[f]);
  const rule = ruleDiffers(a.rule, b.rule);

  // The overwhelmingly common case: one scalar moved. A reroll lands here, with
  // `field: 'mutationSeed'` and the drawn value read out of the after-state --
  // which is exactly what makes intercepting the RNG unnecessary.
  if (!rule && scalars.length === 1) {
    const field = scalars[0]!;
    return { kind: 'configField', config: index, field, value: b[field] };
  }

  if (rule) {
    // Randomize Behavior: rule zeroed to the sentinel AND the seed moved, as one
    // act (`settingsCommands.ts` keeps them together deliberately).
    if (
      isZeroRule(b.rule) &&
      scalars.length === 1 &&
      scalars[0] === 'mutationSeed'
    ) {
      return { kind: 'randomize', config: index, seed: b.mutationSeed };
    }
    // A commit adopts a rule and touches nothing else (`adoptRule` moves ONLY
    // the rule, deliberately, so undo has one field to restore). The cohort has
    // to come from the tag; without it the rule is not derivable and the 80
    // floats are the only honest record.
    if (scalars.length === 0) {
      if (tag?.kind === 'commitSelection') {
        return { kind: 'selection', config: index, cohort: tag.cohort };
      }
      return { kind: 'rule', config: index, rule: b.rule.slice() };
    }
  }

  // Nothing changed that this function recognizes -- including the genuinely
  // empty diff, which `recordHistory`'s identity guard should already have
  // filtered. `full` is correct for both.
  return { kind: 'full', configs: after.configs, world: after.world };
}
