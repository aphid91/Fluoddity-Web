/**
 * Saved worlds, in IndexedDB.
 *
 * ## A SECOND OBJECT STORE, NOT A CATEGORY IN THE FIRST
 *
 * `configs` holds v8 config documents -- single materials, interchangeable with
 * the studio's own library and with files on disk. A world is a different
 * animal: a palette, a preference set and a multi-megabyte binary scene.
 *
 * Putting worlds in the config store as a `Worlds` category would make every
 * one of them appear in the swatch load menu and in the studio's File > Load,
 * where they are not configs and cannot be loaded as one. Separating them keeps
 * `ConfigStore.catalog()` honest about what it lists.
 *
 * ## THE DATABASE VERSION BUMP IS THE RISKY PART
 *
 * `idb.ts` opened `fluoddity` at version 1 with one store. Adding a store means
 * version 2, and an `onupgradeneeded` that ONLY CREATES -- it must never drop or
 * recreate `configs`, because that would delete every config a user has saved,
 * silently, on the first load after an update.
 *
 * The upgrade is therefore written as "create what is missing" rather than as a
 * migration, and it is idempotent: running it against a fresh database and
 * against a v1 database both produce the same two stores, and the v1 case leaves
 * every existing record untouched.
 *
 * ## The scene is stored as bytes, beside the JSON
 *
 * IndexedDB stores `ArrayBuffer` natively, so a world's `.fwld` scene goes in
 * as-is. No base64, no inflation, and `stampCodec.ts` remains the only thing
 * that interprets those bytes -- this module never looks inside them.
 *
 * ## Unavailability is not fatal
 *
 * Same stance as `idb.ts`: private browsing and denied storage make IndexedDB
 * absent or unopenable, and that must degrade to "worlds cannot be saved"
 * rather than to a dead app. Every read returns empty and every write reports
 * an error.
 */

/** Shared with `idb.ts`. One database, two stores. */
const DB_NAME = 'fluoddity';
/**
 * VERSION 2 adds the `worlds` store beside `configs`.
 *
 * `idb.ts` must be bumped to match, and both must run the same creating-only
 * upgrade -- whichever opens the database first performs it, so they cannot
 * disagree about what the schema is.
 */
export const DB_VERSION = 2;
export const CONFIG_STORE = 'configs';
export const WORLD_STORE = 'worlds';

/** One saved world. `name` is the primary key -- worlds have no category. */
export interface StoredWorld {
  readonly name: string;
  /** The world document's JSON half. See `worldFormat.ts`. */
  readonly document: unknown;
  /**
   * The scene, as `.fwld` bytes, or null for a world with no initial conditions.
   *
   * NULL IS A LEGITIMATE STATE, not a missing field: a world may be nothing but
   * a palette and a set of preferences, which is exactly what an author has
   * before they paint anything. Distinguishing it from "the scene failed to
   * save" is why this is explicit rather than an absent key.
   */
  readonly scene: ArrayBuffer | null;
  readonly savedAt: number;
}

/**
 * Create whatever stores are missing. THE ONLY UPGRADE PATH.
 *
 * MUST NOT DROP OR RECREATE ANYTHING. A user upgrading from v1 has configs in
 * the database, and a migration that deleted and rebuilt the store would take
 * them with it -- silently, on first load, with no way back. Creating only what
 * is absent makes that failure impossible to express.
 *
 * Exported so `idb.ts` runs the identical function: two modules opening the same
 * database at the same version must agree on the schema, and sharing the code is
 * what guarantees it rather than two hand-kept copies.
 */
export function upgradeSchema(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(CONFIG_STORE)) {
    db.createObjectStore(CONFIG_STORE, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(WORLD_STORE)) {
    db.createObjectStore(WORLD_STORE, { keyPath: 'name' });
  }
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** Open the shared database, or null when IndexedDB is unavailable. */
export async function openWorldDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    console.warn('IndexedDB is unavailable; worlds cannot be saved.');
    return null;
  }
  try {
    return await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => upgradeSchema(request.result);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('open failed'));
      // Another tab holding an older version open. Rejecting rather than
      // hanging: a promise that never settles would freeze startup.
      request.onblocked = () => reject(new Error('blocked by another tab'));
    });
  } catch (e) {
    console.warn(`IndexedDB could not be opened (${String(e)}); worlds are unavailable.`);
    return null;
  }
}

/** Thrown when a write is attempted with no storage behind it. */
export class WorldStorageUnavailableError extends Error {
  constructor() {
    super('Saving worlds is unavailable: this browser denied access to local storage.');
    this.name = 'WorldStorageUnavailableError';
  }
}

export class WorldStore {
  /** `null` when IndexedDB is unavailable -- read-only, and empty. */
  private readonly db: IDBDatabase | null;
  /** Names, cached so the dev panel's dropdowns can be built synchronously. */
  private cachedNames: readonly string[] = [];

  private constructor(db: IDBDatabase | null, names: readonly string[]) {
    this.db = db;
    this.cachedNames = names;
  }

  static async open(): Promise<WorldStore> {
    const db = await openWorldDb();
    if (db === null) return new WorldStore(null, []);
    let names: readonly string[] = [];
    try {
      names = await listNames(db);
    } catch (e) {
      // A readable database that fails to list is odd but survivable; the app
      // runs without saved worlds.
      console.warn(`Could not list saved worlds: ${String(e)}`);
    }
    return new WorldStore(db, names);
  }

  /** Build a store over supplied data, with no IndexedDB. FOR TESTS. */
  static forTesting(names: readonly string[] = []): WorldStore {
    return new WorldStore(null, names);
  }

  /** Whether saving is possible. Surfaced so the UI can say so before trying. */
  get writable(): boolean {
    return this.db !== null;
  }

  /**
   * Every saved world's name, sorted.
   *
   * SYNCHRONOUS, which is what lets the Dev panel rebuild its five dropdowns
   * without an await -- Tweakpane's options are supplied at bind time. The cache
   * is refreshed by `save` and `remove`, both already async.
   */
  names(): readonly string[] {
    return this.cachedNames;
  }

  /** Whether a name is taken. Drives the overwrite prompt. */
  has(name: string): boolean {
    return this.cachedNames.includes(name);
  }

  async read(name: string): Promise<StoredWorld | null> {
    if (this.db === null) return null;
    const tx = this.db.transaction(WORLD_STORE, 'readonly');
    const record = (await promisify(tx.objectStore(WORLD_STORE).get(name))) as
      | StoredWorld
      | undefined;
    return record ?? null;
  }

  /**
   * Write a world, replacing any of the same name.
   *
   * SILENT OVERWRITE, matching `ConfigStore.write`. The "are you sure" belongs
   * in the UI, where the user can see what they are about to replace -- the
   * store's job is to do what it is told.
   */
  async save(name: string, document: unknown, scene: ArrayBuffer | null): Promise<void> {
    if (this.db === null) throw new WorldStorageUnavailableError();
    const tx = this.db.transaction(WORLD_STORE, 'readwrite');
    await promisify(
      tx.objectStore(WORLD_STORE).put({
        name,
        document,
        scene,
        savedAt: Date.now(),
      } satisfies StoredWorld),
    );
    this.cachedNames = await listNames(this.db);
  }

  async remove(name: string): Promise<void> {
    if (this.db === null) throw new WorldStorageUnavailableError();
    const tx = this.db.transaction(WORLD_STORE, 'readwrite');
    await promisify(tx.objectStore(WORLD_STORE).delete(name));
    this.cachedNames = await listNames(this.db);
  }
}

/**
 * Names only, via a key cursor.
 *
 * `getAllKeys` rather than `getAll`: the dropdowns need names, and pulling every
 * world's SCENE to build a list of strings would move tens of megabytes on every
 * save and delete.
 */
async function listNames(db: IDBDatabase): Promise<readonly string[]> {
  const tx = db.transaction(WORLD_STORE, 'readonly');
  const keys = (await promisify(tx.objectStore(WORLD_STORE).getAllKeys())) as IDBValidKey[];
  return keys
    .filter((k): k is string => typeof k === 'string')
    .sort((a, b) => a.localeCompare(b));
}
