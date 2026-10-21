/**
 * Sand's own preferences record.
 *
 * Sand used to read and write the STUDIO's record, so the two modes fought
 * over world size and canvas shape -- changing one reshaped the other. Now
 * sand keeps the same `Preferences` shape under its own key and never touches
 * the studio's. A new visitor's record is seeded from sand's shipped defaults
 * (`sandDefaults.ts`).
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
 * Sand's preferences. On the first run -- no sand record yet -- they are
 * `seed` (the shipped defaults), and saved.
 */
export function loadSandPreferences(
  seed: Preferences,
  storage: PreferenceStorage | null = browserStorage(),
): Preferences {
  if (storage === null) return seed;
  let existing: string | null = null;
  try {
    existing = storage.getItem(SAND_STORAGE_KEY);
  } catch {
    existing = null;
  }
  if (existing !== null) return loadPreferences(redirected(storage));
  savePreferences(seed, redirected(storage));
  return seed;
}

export function saveSandPreferences(
  prefs: Preferences,
  storage: PreferenceStorage | null = browserStorage(),
): void {
  if (storage === null) return;
  savePreferences(prefs, redirected(storage));
}
