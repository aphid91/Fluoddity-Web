/**
 * Preset discovery and cycling.
 * The port of the half of `orchestrator/project_commands.py` (254 lines) that
 * Step 7 can honour.
 *
 * ## What is here and what is Step 9's
 *
 * The desktop's `ProjectCommands` covers save, load, hover-preview, delete AND
 * the preset cycle. All but the last need `persistence.py` -- reading and
 * writing files -- and **Step 9 owns storage** (a build-time `manifest.json`
 * plus IndexedDB). So this module is the preset cycle and the category
 * grouping, over the presets Step 4 baked in.
 *
 * That is not a stub: LEFT/RIGHT preset cycling, the load-menu categories and
 * hover-preview are all genuinely working here, because a shipped preset is
 * already in memory. What is missing is only the ability to read a preset that
 * was not compiled in, and to write one back.
 *
 * ## What Step 9 replaces, precisely
 *
 * `discover()` globs `configs/` for the "Core" category and iterates subfolders
 * into their own categories (`persistence.py:339-367`). **No browser can
 * enumerate a directory**, so `buildCatalog` below fabricates the same shape
 * from the generated preset list -- one "Core" category. Step 9 swaps the
 * source for the fetched manifest plus the user's IndexedDB saves; the SHAPE
 * (`category -> ordered names`, Core first then alphabetical) is what everything
 * downstream is written against, and it does not change.
 */

import { preset as presetByName } from '../particleSystem/defaultConfig.ts';
import { type Project, withConfigs } from '../project/project.ts';

/**
 * The shipped presets, grouped for the load menu.
 *
 * `order` is the flat cycle order LEFT/RIGHT walks, which is the concatenation
 * of the categories in their own order -- `_refresh_config_list` builds it the
 * same way (`project_commands.py:79-80`), and keeping them derived from one
 * source is what stops the menu and the cycle disagreeing about what comes
 * next.
 */
export interface PresetCatalog {
  readonly categories: Readonly<Record<string, readonly string[]>>;
  readonly order: readonly string[];
}

/** The category shipped presets land in. Step 9 adds "Custom" beside it. */
export const CORE_CATEGORY = 'Core';

/**
 * Group the shipped preset names into load-menu categories.
 *
 * One category today, because everything compiled in came from `configs/`'s top
 * level -- which is exactly what `discover()` calls "Core". Sorted rather than
 * left in object-key order so the cycle is stable across regenerations of
 * `presets.generated.json`; key order there follows `_PRESET_FILES`, which is a
 * hand-maintained list and not a promise.
 */
export function buildCatalog(names: readonly string[]): PresetCatalog {
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  return {
    categories: Object.freeze({ [CORE_CATEGORY]: Object.freeze(sorted) }),
    order: Object.freeze(sorted),
  };
}

/**
 * Where an index lands after wrapping, or `null` when there is nothing to
 * cycle.
 *
 * The modulo is written to handle NEGATIVE indices, which the plain `%`
 * operator does not: `prevPreset` at index 0 asks for -1, and `-1 % 3` is `-1`
 * in JavaScript where Python's `%` gives `2`. Getting this wrong makes the
 * LEFT key do nothing at the start of the list and is invisible until someone
 * presses it there.
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
 * Apply a preset to a project, returning the new one.
 *
 * Replaces the configs, the world settings AND the name together -- the three
 * that must always move as one, which is the whole argument for the `Project`
 * type. `withConfigs` re-clamps `selected` for free.
 *
 * Returns `null` on an unknown name rather than throwing: a preset that has
 * gone missing should leave the app on what it has, the same way the desktop
 * prints and returns (`project_commands.py:229-232`).
 *
 * **The camera is NOT applied here**, though a saved file records one. Loading
 * a preset moves the project, not the view -- and the shipped presets are read
 * through `defaultConfig.ts`, which does not carry the camera block at all.
 * Step 9's real loader restores it, and only "if the file actually recorded
 * one" (`project_commands.py:149-152`).
 */
export function loadPresetInto(project: Project, name: string): Project | null {
  let loaded;
  try {
    loaded = presetByName(name);
  } catch (e) {
    console.warn(`Failed to load preset ${name}: ${String(e)}`);
    return null;
  }
  return withConfigs(project, [loaded.config], { name, world: loaded.world });
}
