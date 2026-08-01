/**
 * Preset cycling and the shape of the config catalog.
 *
 * The port of the half of `orchestrator/project_commands.py` (254 lines) that is
 * pure arithmetic over the catalog. The storage half -- reading, writing,
 * deleting -- lives in `config/`, and the handlers that drive it are in
 * `orchestrator.ts` where the project and the camera are.
 *
 * `PresetCatalog` is produced by `ConfigStore.catalog()` and consumed here and
 * by `status()`. Its ordering is `discover()`'s: Core first, then alphabetical,
 * with `order` the flat concatenation in the same sequence -- which is what
 * keeps the LEFT/RIGHT cycle and the load menu agreeing about what comes next
 * (`project_commands.py:79-80`).
 */

import { type Project, withConfigs } from '../project/project.ts';
import type { SavedConfig } from '../config/persistence.ts';

/**
 * Every loadable config, grouped for the menu and flattened for the cycle.
 *
 * `order` is derived from `categories` rather than built alongside it -- two
 * independently-maintained lists would eventually disagree, and the failure
 * (LEFT/RIGHT skipping an entry that the menu shows) is the kind nobody reports
 * precisely.
 */
export interface PresetCatalog {
  readonly categories: Readonly<Record<string, readonly string[]>>;
  readonly order: readonly string[];
}

/**
 * Where an index lands after wrapping, or `null` when there is nothing to cycle.
 *
 * The modulo is written to handle NEGATIVE indices, which the plain `%` operator
 * does not: `prevPreset` at index 0 asks for -1, and `-1 % 3` is `-1` in
 * JavaScript where Python's `%` gives `2`. Getting this wrong makes the LEFT key
 * do nothing at the start of the list and is invisible until someone presses it
 * there.
 */
export function switchPreset(
  catalog: PresetCatalog,
  index: number,
): { readonly index: number; readonly name: string } | null {
  const count = catalog.order.length;
  if (count === 0) return null;
  const wrapped = ((index % count) + count) % count;
  const name = catalog.order[wrapped];
  if (name === undefined) return null;
  return { index: wrapped, name };
}

/**
 * Apply a loaded config to a project, returning the new one.
 *
 * Replaces the configs, the world settings AND the name together -- the three
 * that must always move as one, which is the whole argument for the `Project`
 * type. `withConfigs` re-clamps `selected` for free.
 *
 * TAKES `saved.configs` WHOLE, not just slot 0. The single-config restriction
 * this function used to carry was an artifact of the Step 4 generator emitting
 * config 0 only; a real save file can hold several, and `_cmd_load_config`
 * passes all of them (`project_commands.py:141-143`).
 *
 * THE CAMERA IS NOT APPLIED HERE, though a saved file records one. That is the
 * caller's business, and only on a committed load -- not on a hover-preview
 * (settings only) and not on the LEFT/RIGHT cycle, where a view that jumped on
 * every keypress would make browsing unusable. `_switch_preset`
 * (`project_commands.py:217-239`) likewise never applies it.
 */
export function loadSavedInto(
  project: Project,
  name: string,
  saved: SavedConfig,
): Project {
  return withConfigs(project, saved.configs, { name, world: saved.world });
}
