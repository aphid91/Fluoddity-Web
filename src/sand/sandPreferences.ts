/**
 * Sand's own preferences record.
 *
 * Sand used to read and write the STUDIO's record, so the two modes fought
 * over world size and canvas shape -- changing one reshaped the other. Now
 * sand keeps the same `Preferences` shape under its own key, and the studio's
 * record is only ever READ, once, to seed sand's on its first run.
 *
 * `worldSize` here is sand's TARGET world size: what a world is built at unless
 * a loaded scene needs more room (see `icFit.ts`). `canvasAspect` is carried
 * but unused -- the world's shape follows the screen.
 *
 * A LEAF over `preferences.ts`, so it is testable under `node --test`.
 */

import {
  type PreferenceStorage,
  type Preferences,
  browserStorage,
  loadPreferences,
  savePreferences,
} from '../prefs/preferences.ts';

/** Where sand's record lives, beside the studio's `fluoddity.preferences`. */
export const SAND_STORAGE_KEY = 'fluoddity.sand.preferences';

/**
 * The target world size a new sand install starts at. Deliberately small:
 * sand has no first-run calibration, and here the user controls the particle
 * count, so a slow world is one they can see the cause of.
 */
export const DEFAULT_SAND_WORLD_SIZE = 0.15;

/**
 * `preferences.ts` reads and writes one fixed key. This redirects it to sand's,
 * so the parsing, coercion and never-throw handling are shared rather than
 * copied.
 */
function redirected(storage: PreferenceStorage): PreferenceStorage {
  return {
    getItem: () => storage.getItem(SAND_STORAGE_KEY),
    setItem: (_key, value) => storage.setItem(SAND_STORAGE_KEY, value),
  };
}

/**
 * Sand's preferences. On the first run -- no sand record yet -- they are seeded
 * from the studio's, with the target world size set to
 * `DEFAULT_SAND_WORLD_SIZE`, and saved.
 */
export function loadSandPreferences(
  storage: PreferenceStorage | null = browserStorage(),
): Preferences {
  if (storage === null) {
    return { ...loadPreferences(null), worldSize: DEFAULT_SAND_WORLD_SIZE };
  }
  let existing: string | null = null;
  try {
    existing = storage.getItem(SAND_STORAGE_KEY);
  } catch {
    existing = null;
  }
  if (existing !== null) return loadPreferences(redirected(storage));

  const seeded: Preferences = {
    ...loadPreferences(storage),
    worldSize: DEFAULT_SAND_WORLD_SIZE,
  };
  savePreferences(seeded, redirected(storage));
  return seeded;
}

export function saveSandPreferences(
  prefs: Preferences,
  storage: PreferenceStorage | null = browserStorage(),
): void {
  if (storage === null) return;
  savePreferences(prefs, redirected(storage));
}
