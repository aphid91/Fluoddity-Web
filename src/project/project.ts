/**
 * Project: the state the save/load system stores and restores.
 * A direct port of `project/project.py` (141 lines).
 *
 * ## Why this type exists
 *
 * A project is what a save file contains, and its parts must always move
 * together:
 *
 *     configs   the NCA configs (the studio simulates configs[0])
 *     world     settings shared by the whole grid (edge mode, display)
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
 *   - GPU state. A Project is plain data; `NcaSystem` uploads it.
 *   - Preferences. Editor state is deliberately separate (see `prefs/`).
 *   - Camera. Saved alongside a project, but not part of one.
 */

import { type NcaConfig, type NcaWorld, makeNcaWorld } from '../nca/ncaConfig.ts';

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
  readonly configs: readonly NcaConfig[];
  readonly world: NcaWorld;
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
  readonly configs: readonly NcaConfig[];
  readonly world?: NcaWorld;
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
    world: init.world ?? makeNcaWorld(),
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
export function selectedConfig(project: Project): NcaConfig {
  const config = project.configs[project.selected];
  if (config === undefined) {
    // Unreachable while makeProject is the only constructor; asserted rather
    // than non-null-asserted so a hand-built literal fails loudly here instead
    // of as `undefined.weights` inside the upload.
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
  configs: readonly NcaConfig[],
  opts: { readonly name?: string; readonly world?: NcaWorld } = {},
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
export function edited<K extends keyof NcaConfig>(
  project: Project,
  index: number,
  field: K,
  value: NcaConfig[K],
): Project {
  const target = project.configs[index];
  if (target === undefined) return project;
  if (!(field in target)) return project;
  const configs = project.configs.slice();
  configs[index] = { ...target, [field]: value };
  return makeProject({ ...project, configs });
}

export function editSelected<K extends keyof NcaConfig>(
  project: Project,
  field: K,
  value: NcaConfig[K],
): Project {
  return edited(project, project.selected, field, value);
}

/**
 * Make `weights` the selected config's base weights.
 *
 * What cohort selection does: the picked cohort's weights become the network
 * every cohort now varies around.
 *
 * ONLY THE WEIGHTS CHANGE. `mutationScale` and the seed are left alone, so
 * the cohorts re-mutate around the adopted network rather than locking to it --
 * and undo has exactly one field to restore.
 */
export function adoptWeights(project: Project, weights: readonly number[]): Project {
  return editSelected(project, 'weights', weights.slice());
}

/**
 * Whether moving between these two projects changes what the cells are DOING:
 * any config's base weights or mutation seed.
 *
 * Exists for undo/redo, which replays steps of every kind -- the only way to
 * tell a weights adoption from a brightness tweak is to look. THE SEED COUNTS
 * AS MUCH AS THE WEIGHTS: Reroll Mutations moves only `mutationSeed`, and every
 * cohort's network is derived from both (`weights.ts`'s `cohortWeights`).
 *
 * Slot for slot rather than selected-vs-selected, so an undo that only moved
 * `selected` is not mistaken for a behaviour change.
 */
export function ruleChanged(before: Project, after: Project): boolean {
  if (before === after) return false;
  if (before.configs.length !== after.configs.length) return true;

  return before.configs.some((a, i) => {
    const b = after.configs[i]!;
    if (a === b) return false; // the common case: untouched slots share identity
    if (a.mutationSeed !== b.mutationSeed) return true;
    if (a.weights === b.weights) return false;
    if (a.weights === null || b.weights === null) return true;
    if (a.weights.length !== b.weights.length) return true;
    return a.weights.some((v, j) => v !== b.weights![j]);
  });
}

/**
 * Whether moving between these two projects changes what only a RESTART can
 * show: the cohort count, the initial conditions, or the channel count (which
 * reallocates the state).
 *
 * The sibling of `ruleChanged`, separate because it asks a different question:
 * a layout change does not invalidate a lit cohort's MEANING the way a new
 * network does, but its restart is not optional -- without one the layout the
 * undo restored would never appear.
 */
export function layoutChanged(before: Project, after: Project): boolean {
  if (before === after) return false;
  if (before.configs.length !== after.configs.length) return true;

  return before.configs.some((a, i) => {
    const b = after.configs[i]!;
    if (a === b) return false; // the common case: untouched slots share identity
    return (
      a.cohorts !== b.cohorts ||
      a.initialConditions !== b.initialConditions ||
      a.channels !== b.channels
    );
  });
}

/**
 * Change one world setting.
 *
 * A real edit of the project's single `NcaWorld` -- not, as it once was on
 * the desktop, a disguised edit of config 0.
 */
export function editWorld<K extends keyof NcaWorld>(
  project: Project,
  field: K,
  value: NcaWorld[K],
): Project {
  if (!(field in project.world)) return project;
  return makeProject({ ...project, world: { ...project.world, [field]: value } });
}

// NO SLOT MUTATORS HERE, deliberately. Growing and shrinking the buffer went
// out with the desktop's Config Manager window: nothing in the app can add or
// remove a slot, so those methods had no callers. `configs` is still an array
// of arbitrary length and `selected` still indexes it, so re-exposing slot
// management means adding mutators back here -- not reworking the type.
