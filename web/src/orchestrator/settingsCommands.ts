/**
 * Settings commands: routing an edit to whichever source owns the field.
 * The port of `orchestrator/settings_commands.py` (131 lines).
 *
 * Three sources with different semantics (see `ui/settingsSpec.ts`):
 *
 *   CONFIG  per-particle, in the project. Saved.
 *   WORLD   global simulation state, in the project. Saved.
 *   PREFS   editor state. NOT saved with a project.
 *
 * ## Pure functions, and why that shape
 *
 * The desktop's mixin mutates `self.project` and `self.prefs` directly. These
 * take the current values and RETURN the new ones, which does two things: the
 * Orchestrator keeps its "one place project state changes" property (nothing
 * here calls `setProject`), and the routing becomes testable under
 * `node --test` with no GPU, no device and no Orchestrator -- which is where
 * `settingsCommands.test.ts` checks that a WORLD setting does not land on a
 * config, the failure that would otherwise look like a physics quirk.
 *
 * ## Preference edits are NOT recorded in history
 *
 * They are editor state, outside the project entirely, so there is nothing for
 * undo to restore. That is why `applySettingEdit` returns a tagged union rather
 * than one project: the caller has to know which source it hit, because only
 * two of the three record.
 */

import {
  type Preferences,
  withValue,
} from '../prefs/preferences.ts';
import {
  type Project,
  editSelected,
  editWorld,
  selectedConfig,
} from '../project/project.ts';
import type { SimulationConfig, WorldSettings } from '../particleSystem/config.ts';
import { type Setting, CONFIG, PREFS, WORLD, seedSetting } from '../ui/settingsSpec.ts';

/** The two things an edit can produce. */
export type SettingEditResult =
  | { readonly kind: 'project'; readonly project: Project }
  | { readonly kind: 'prefs'; readonly prefs: Preferences };

/** What an edit reads. Passed in rather than reached for. */
export interface SettingEditSources {
  readonly project: Project;
  readonly prefs: Preferences;
}

/**
 * Route an edit to whichever of the three sources owns the field.
 *
 * **Returns the sources UNCHANGED when the field is unknown.** `editSelected`
 * and `editWorld` both return their receiver for a field the target does not
 * have, and `withValue` does the same -- which is what keeps the caller's
 * `before !== after` history guard meaningful. A registry entry naming a field
 * that no longer exists therefore does nothing rather than recording an empty
 * undo step every frame the slider moves.
 *
 * The value is cast to the field's type at the boundary. The registry is
 * string-keyed by nature (it is a data table), so this is the one place where
 * "a `Setting` names a real field" stops being checkable and starts being
 * asserted -- `settingsSpec.test.ts` asserts it for all 35 entries against the
 * real interfaces, which is where that check belongs.
 */
export function applySettingEdit(
  sources: SettingEditSources,
  setting: Setting,
  value: number | boolean,
): SettingEditResult {
  if (setting.source === CONFIG) {
    const field = setting.field as keyof SimulationConfig;
    return {
      kind: 'project',
      project: editSelected(
        sources.project,
        field,
        value as SimulationConfig[typeof field],
      ),
    };
  }

  if (setting.source === WORLD) {
    const field = setting.field as keyof WorldSettings;
    return {
      kind: 'project',
      project: editWorld(sources.project, field, value as WorldSettings[typeof field]),
    };
  }

  if (setting.source === PREFS) {
    return { kind: 'prefs', prefs: withValue(sources.prefs, setting.field, value) };
  }

  // An unknown source. Unreachable while `Source` is a closed union, and
  // returning the project untouched is the honest answer if it ever is not.
  return { kind: 'project', project: sources.project };
}

/**
 * New mutation seed. Only meaningful while Mutation Scale > 0.
 *
 * Drawn from [0,1) to match the convention the configs use -- the value is fed
 * straight into the hash, so any float in range is valid.
 *
 * Returns `null` when the registry has no SEED control, which is the port of
 * the desktop's silent `return` (`settings_commands.py:76-77`). Looking the
 * setting up by KIND rather than by field name is deliberate: SEED means "a
 * randomizable opaque selector" and there is exactly one, so naming the field
 * here would put a second copy of that name outside the registry.
 *
 * `rng` is injectable so the test can assert the seed actually MOVED without
 * depending on `Math.random` -- and, more usefully, that it lands in [0,1).
 */
export function randomizeSeed(
  project: Project,
  rng: () => number = Math.random,
): Project | null {
  const setting = seedSetting();
  if (setting === null) return null;
  if (setting.source !== CONFIG) return null;
  const field = setting.field as keyof SimulationConfig;
  return editSelected(project, field, rng() as SimulationConfig[typeof field]);
}

/**
 * The "no target rule" sentinel. 80 floats = 10 FourierCenters x (freq + amp).
 *
 * **AN ALL-ZERO RULE IS A SENTINEL, not a rule**: `entityUpdate.wgsl` reads it
 * as "no target given" and generates random centers from the mutation seed
 * instead. So zeroing is how the host asks for a new behaviour without having
 * to reproduce the shader's generator in TypeScript.
 */
export const ZERO_RULE: readonly number[] = Object.freeze(new Array<number>(80).fill(0));

/**
 * Throw away the selected config's rule and grow a fresh one.
 *
 * **THE SEED MOVES TOO, and it has to.** The fallback is seeded by
 * `mutationSeed`, so zeroing the rule alone would regenerate the SAME behaviour
 * every time -- the command would appear to do nothing on the second press.
 * Both fields change together as one undoable step, because together they are
 * one act (`settings_commands.py:82-105`).
 */
export function randomizeBehavior(
  project: Project,
  rng: () => number = Math.random,
): Project {
  const zeroed = editSelected(project, 'rule', ZERO_RULE.slice());
  return editSelected(zeroed, 'mutationSeed', rng());
}

/**
 * Whether the selected config's rule is the all-zero sentinel.
 *
 * Not used by the commands above -- it is what a UI needs to say "this config's
 * behaviour is generated" rather than showing 80 zeros. `entityUpdate.wgsl`
 * tests only TWO lanes for exactly zero, so a rule that is zero in those lanes
 * and non-zero elsewhere would ALSO trigger generation on the GPU while
 * reading as authored here. Checking every lane is the conservative direction:
 * this can say "authored" about a rule the GPU generates, but never the reverse.
 */
export function ruleIsSentinel(project: Project): boolean {
  return selectedConfig(project).rule.every((v) => v === 0);
}
