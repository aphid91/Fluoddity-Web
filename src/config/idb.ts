/**
 * User saves, in IndexedDB. The browser's answer to `configs/custom/`.
 *
 * A thin typed wrapper over ONE object store, with no library. IndexedDB's API
 * is event-based and verbose, but the surface this app needs is four operations,
 * and a dependency to wrap four operations would be worse than the wrapping.
 *
 * ## WHY THE DOCUMENT IS STORED UNPARSED
 *
 * A record holds the v8 JSON document exactly as `toDocument` produced it, not a
 * parsed `SimulationConfig`. That keeps `persistence.ts` the single interpreter
 * of these bytes: a save written today and read after a future format change
 * goes through the same reader, with the same tolerances, as a file on disk. If
 * the parsed form were stored, a field that changed meaning would be silently
 * reinterpreted with no version to check against.
 *
 * ## UNAVAILABILITY IS NOT FATAL
 *
 * Private-browsing modes and denied storage permissions make `indexedDB` either
 * absent or unopenable. That must degrade to "shipped presets still load, saving
 * reports an error" rather than to a dead app -- so `openConfigDb` returns null
 * instead of throwing, and `ConfigStore` treats null as read-only. Contrast the
 * manifest, whose absence IS fatal (see `manifest.ts`).
 *
 * THIS WILL NOT REPRODUCE ON A DEVELOPMENT MACHINE, which is exactly why it is
 * handled by construction rather than left to be discovered.
 */

const DB_NAME = 'fluoddity';
const DB_VERSION = 1;
const STORE = 'configs';

/**
 * One saved config.
 *
 * `id` is the primary key and is `category` and `name` joined -- the
 * `(category, name)` identity `ConfigEntry.key` already uses
 * (`persistence.py:331-336`), which is what makes swapping the filesystem for a
 * database a swap rather than a redesign.
 */
export interface StoredConfig {
  readonly id: string;
  readonly category: string;
  readonly name: string;
  /** The v8 document, unparsed. See the header. */
  readonly document: unknown;
  /** Not read today; here so a future "sort by recent" is a query, not a migration. */
  readonly savedAt: number;
}

/**
 * The key for a `(category, name)` pair.
 *
 * NUL as the separator, deliberately. `sanitizeName` does not strip it -- Windows
 * filename rules do not mention it -- but it also cannot be typed into a DOM
 * input, so unlike any printable separator it cannot appear inside a legal name
 * and collide two different records into one key.
 */
export function configId(category: string, name: string): string {
  return `${category}\u0000${name}`;
}

/** Wrap an IDBRequest as a promise. The whole reason this module is short. */
function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * Open the database, or return `null` if IndexedDB is unavailable.
 *
 * Never throws. See the header for why unavailability is a degraded mode rather
 * than a failure.
 */
export async function openConfigDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    console.warn('IndexedDB is unavailable; saved configs will be read-only.');
    return null;
  }
  try {
    return await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('open failed'));
      // Fires when another tab holds an older version open. Rejecting rather
      // than hanging: a promise that never settles would freeze startup.
      request.onblocked = () => reject(new Error('blocked by another tab'));
    });
  } catch (e) {
    console.warn(`IndexedDB could not be opened (${String(e)}); saves are unavailable.`);
    return null;
  }
}

/** Every saved config. Used to build the catalog; there are never many. */
export async function idbList(db: IDBDatabase): Promise<readonly StoredConfig[]> {
  const tx = db.transaction(STORE, 'readonly');
  return (await promisify(tx.objectStore(STORE).getAll())) as StoredConfig[];
}

export async function idbGet(db: IDBDatabase, id: string): Promise<StoredConfig | undefined> {
  const tx = db.transaction(STORE, 'readonly');
  return (await promisify(tx.objectStore(STORE).get(id))) as StoredConfig | undefined;
}

/** Write one record, replacing any with the same `(category, name)`. */
export async function idbPut(db: IDBDatabase, record: StoredConfig): Promise<void> {
  const tx = db.transaction(STORE, 'readwrite');
  await promisify(tx.objectStore(STORE).put(record));
}

export async function idbDelete(db: IDBDatabase, id: string): Promise<void> {
  const tx = db.transaction(STORE, 'readwrite');
  await promisify(tx.objectStore(STORE).delete(id));
}
