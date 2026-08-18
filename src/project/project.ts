/**
 * Project: the state the save/load system stores and restores.
 * A direct port of `project/project.py` (141 lines).
 *
 * ## Why this type exists
 *
 * A project is what a save file contains, and its parts must always move
 * together:
 *
 *     configs   the ConfigBuffer contents
 *     world     settings shared by every particle (trail decay, boundary mode)
 *     name      what the file is called
 *     selected  which config the Project panel is editing
 *
 * Before this type they were separate attributes on the Orchestrator, and every
 * operation that touched the buffer had to remember all three -- a triple that
 * appeared at seventeen call sites. Missing the clamp gives an index past the
 * end of the buffer; missing the rename leaves the panel titled after a project
 * that is no longer loaded. Exactly that bug shipped once on the desktop: the
 * clipboard restored configs without restoring the name.
 *
 * ## Immutable, and why that matters here specifically
 *
 * Every operation returns a NEW Project, so snapshotting for undo or
 * hover-preview is just holding a reference. That is what `history.ts` needs,
 * and it is what `SelectionController` already assumes: `_record_history`
 * guards on `before is not self.project` -- REFERENCE IDENTITY
 * (`selection_commands.py:198`), ported as `!==`.
 *
 * **A spread copy anywhere in the chain silently breaks that guard.** Every
 * mutator below therefore returns the receiver unchanged when nothing would
 * change (`edited` on an unknown field, `editWorld` on an unknown field), which
 * is what makes `before !== after` mean "something actually happened".
 *
 * ## What is NOT here
 *
 *   - GPU state. A Project is plain data; `ParticleSystem` uploads it.
 *   - Preferences. Editor state is deliberately separate (see `prefs/`).
 *   - Camera. Saved alongside a project, but not part of one.
 */

import {
  type SimulationConfig,
  type WorldSettings,
  makeWorldSettings,
} from '../particleSystem/config.ts';

/** Name used before anything has been saved or loaded. */
export const UNTITLED = 'Untitled';

/**
 * An immutable snapshot of everything a save file contains, plus which config
 * is being edited.
 *
 * `readonly` fields are the compile-time form of the Python's `frozen=True`.
 * Construct through `makeProject`, never as an object literal: the invariants
 * (`configs` non-empty, `selected` in range) are enforced there, the way
 * `__post_init__` enforces them on the desktop.
 */
export interface Project {
  readonly configs: readonly SimulationConfig[];
  readonly world: WorldSettings;
  readonly name: string;
  readonly selected: number;
}

/**
 * Build a Project, enforcing both invariants.
 *
 * A project always has at least one config, and `selected` always points at a
 * real one. Enforcing it here means no caller has to -- which is the entire
 * argument for the type.
 *
 * The empty-configs case THROWS rather than substituting a default, matching
 * `project.py:62-63`. There is no sensible default config to invent, and a
 * project with none is a bug upstream.
 */
export function makeProject(init: {
  readonly configs: readonly SimulationConfig[];
  readonly world?: WorldSettings;
  readonly name?: string;
  readonly selected?: number;
}): Project {
  if (init.configs.length === 0) {
    throw new Error('a Project must contain at least one config');
  }
  const selected = Math.max(
    0,
    Math.min(init.selected ?? 0, init.configs.length - 1),
  );
  return Object.freeze({
    configs: init.configs,
    world: init.world ?? makeWorldSettings(),
    name: init.name ?? UNTITLED,
    selected,
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The config currently being edited.
 *
 * A function rather than a getter because `Project` is an interface, not a
 * class -- which is what lets `makeProject` hand back a frozen plain object
 * that structural-equality tests and JSON round-trips both understand.
 */
export function selectedConfig(project: Project): SimulationConfig {
  const config = project.configs[project.selected];
  if (config === undefined) {
    // Unreachable while makeProject is the only constructor; asserted rather
    // than non-null-asserted so a hand-built literal fails loudly here instead
    // of as `undefined.rule` inside the packer.
    throw new Error(
      `Project.selected is ${project.selected} with ${project.configs.length} configs`,
    );
  }
  return config;
}

/** How many configs the buffer holds. */
export function configCount(project: Project): number {
  return project.configs.length;
}

// ---------------------------------------------------------------------------
// Writes -- each returns a NEW Project
// ---------------------------------------------------------------------------

/**
 * Replace the buffer, and optionally the name and world settings.
 *
 * `selected` is re-clamped automatically. This is the operation that used to
 * need three hand-written lines at every call site.
 */
export function withConfigs(
  project: Project,
  configs: readonly SimulationConfig[],
  opts: { readonly name?: string; readonly world?: WorldSettings } = {},
): Project {
  return makeProject({
    configs,
    world: opts.world ?? project.world,
    name: opts.name ?? project.name,
    selected: project.selected,
  });
}

export function renamed(project: Project, name: string): Project {
  return makeProject({ ...project, name });
}

/**
 * Change one field of one config.
 *
 * Returns the receiver UNCHANGED for an out-of-range index or an unknown field,
 * exactly as `project.py:101-104` does. That is not defensive padding: it is
 * what keeps reference identity meaningful, since `_recordHistory` reads
 * `before !== after` as "a real edit happened".
 */
export function edited<K extends keyof SimulationConfig>(
  project: Project,
  index: number,
  field: K,
  value: SimulationConfig[K],
): Project {
  const target = project.configs[index];
  if (target === undefined) return project;
  if (!(field in target)) return project;
  const configs = project.configs.slice();
  configs[index] = { ...target, [field]: value };
  return makeProject({ ...project, configs });
}

export function editSelected<K extends keyof SimulationConfig>(
  project: Project,
  field: K,
  value: SimulationConfig[K],
): Project {
  return edited(project, project.selected, field, value);
}

/**
 * Make `rule` the selected config's base rule.
 *
 * What particle selection does: the picked particle's mutated rule becomes the
 * rule the whole population now varies around.
 *
 * ONLY THE RULE CHANGES. `mutationScale` is deliberately left alone, so the
 * population re-mutates around the adopted rule rather than locking to it --
 * and undo has exactly one field to restore.
 */
export function adoptRule(project: Project, rule: readonly number[]): Project {
  return editSelected(project, 'rule', rule.slice());
}

/**
 * Whether moving between these two projects changes what particles are TRYING
 * TO DO -- any config's rule or mutation seed.
 *
 * Exists for undo/redo. Every other behavior-change path knows what it did, but
 * undo is one code path replaying steps of every kind, so the only way to tell a
 * rule adoption from a brightness tweak is to look. See
 * `Orchestrator.resetIfRuleChanged`, its only caller.
 *
 * **THE SEED COUNTS AS MUCH AS THE RULE.** Reroll Mutations moves ONLY
 * `mutationSeed` (`randomizeSeed`), and the GPU derives every particle's actual
 * rule from `rule` and the seed together (`rule.wgsl`'s `derive_entity_rule`).
 * A rule-only comparison would report "nothing changed" for a reroll, which is
 * one of the three cases this was built for.
 *
 * **EVERY CONFIG, NOT THE SELECTED ONE.** An undo can move `selected` as well as
 * edit a config, so comparing `selectedConfig(before)` against
 * `selectedConfig(after)` compares two DIFFERENT slots and reports a change
 * whenever the selection moved -- resetting on an undo that merely switched
 * which config was on screen. Comparing slot for slot asks the question actually
 * meant: did any behaviour in this project change?
 *
 * A LENGTH CHANGE COUNTS. Nothing in the app adds or removes a slot today (see
 * the note at the bottom of this file), but a project of a different shape is
 * not one whose behaviours can be said to be unchanged, and answering `false`
 * there would be a claim this function cannot support.
 */
export function ruleChanged(before: Project, after: Project): boolean {
  if (before === after) return false;
  if (before.configs.length !== after.configs.length) return true;

  return before.configs.some((a, i) => {
    const b = after.configs[i]!;
    if (a === b) return false; // the common case: untouched slots share identity
    if (a.mutationSeed !== b.mutationSeed) return true;
    if (a.rule.length !== b.rule.length) return true;
    return a.rule.some((v, j) => v !== b.rule[j]);
  });
}

/**
 * Change one world setting.
 *
 * A real edit of the project's single `WorldSettings` -- not, as it once was on
 * the desktop, a disguised edit of config 0.
 */
export function editWorld<K extends keyof WorldSettings>(
  project: Project,
  field: K,
  value: WorldSettings[K],
): Project {
  if (!(field in project.world)) return project;
  return makeProject({ ...project, world: { ...project.world, [field]: value } });
}

// NO SLOT MUTATORS HERE, deliberately. Growing and shrinking the buffer went
// out with the desktop's Config Manager window: nothing in the app can add or
// remove a slot, so those methods had no callers. `configs` is still an array
// of arbitrary length and `selected` still indexes it, so re-exposing slot
// management means adding mutators back here -- not reworking the type.
