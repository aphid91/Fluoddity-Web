/**
 * Which config categories the swatch menu shows collapsed.
 *
 * Remembered across menu openings and reloads: someone who folds Archive away
 * once means it, and re-folding it on every right-click is the chore this
 * removes. Every category starts expanded, so a first-time user still sees the
 * whole list.
 *
 * Its own small entry rather than part of `SandSession`, which is the palette
 * and the tools -- this is how one menu is arranged, and a corrupt or missing
 * entry here should cost nothing but the folds.
 */

export const LOADER_COLLAPSED_STORAGE_KEY = 'fluoddity.sand.loaderCollapsed';

type Readable = { getItem(key: string): string | null };
type Writable = { setItem(key: string, value: string): void };

/** The collapsed categories. Empty on any failure -- everything expanded. */
export function loadCollapsedCategories(
  storage: Readable | null = browserStorageOrNull(),
): Set<string> {
  if (storage === null) return new Set();
  try {
    const parsed: unknown = JSON.parse(storage.getItem(LOADER_COLLAPSED_STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? new Set(parsed.filter((v): v is string => typeof v === 'string'))
      : new Set();
  } catch {
    return new Set();
  }
}

/** Store the collapsed categories. A storage failure costs only the folds. */
export function saveCollapsedCategories(
  collapsed: ReadonlySet<string>,
  storage: Writable | null = browserStorageOrNull(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(LOADER_COLLAPSED_STORAGE_KEY, JSON.stringify([...collapsed].sort()));
  } catch {
    // Quota or a denied store: the menu still works, it just forgets.
  }
}

function browserStorageOrNull(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
