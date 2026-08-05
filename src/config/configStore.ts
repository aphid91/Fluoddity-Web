/**
 * The config catalog: shipped presets and user saves, as one ordered list.
 *
 * This is what replaces `persistence.discover()` (`persistence.py:339-367`). The
 * desktop globs a directory; the browser merges a fetched manifest with an
 * IndexedDB store. The SHAPE is identical and that is the point -- everything
 * downstream was written against `category -> ordered names`
 * (`commands.ts:216-220` says so explicitly), so none of it changes.
 *
 * ## The identity is `(category, name)`, and it always was
 *
 * `ConfigEntry.key` on the desktop is `(category, name)` rather than the path,
 * "so hover tracking survives path normalization" (`persistence.py:331-336`).
 * That is what makes this a swap: `path` becomes an optional manifest
 * implementation detail, and NOTHING OUTSIDE THIS MODULE READS IT. `read()`
 * branches on `source`, not on whether a path is present.
 *
 * ## Ordering
 *
 * Core first, then the remaining categories alphabetically -- `discover()`'s
 * ordering (`:362-367`), preserved because the flat concatenation of it is the
 * LEFT/RIGHT preset cycle. `Custom` sorts into the alphabetical run naturally.
 */

import type { PresetCatalog } from '../orchestrator/projectCommands.ts';
import {
  type StoredConfig,
  configId,
  idbDelete,
  idbGet,
  idbList,
  idbPut,
  openConfigDb,
} from './idb.ts';
import { type Manifest, fetchPreset, loadManifest } from './manifest.ts';
import { type SavedConfig, fromDocument } from './persistence.ts';

/** The category shipped presets land in. `discover()`'s `CORE_CATEGORY`. */
export const CORE_CATEGORY = 'Core';

/**
 * The category user saves land in. The browser's `configs/custom/`.
 *
 * Capitalized where the desktop's folder is not, because on the desktop the
 * category name IS the folder name and folders there are lowercase; here it is
 * only ever a label in a menu, beside "Core".
 */
export const CUSTOM_CATEGORY = 'Custom';

/**
 * The preset the app opens with, or `''` to mean "whatever sorts first".
 *
 * WAS `'Starcrossedv8'`, the desktop's own default -- and that file has since
 * been swapped out of `configs/`, so the constant named something that no longer
 * existed. The app still booted, because `Orchestrator.create` falls through to
 * the first catalog entry when the default is missing, which is exactly the kind
 * of silent fallback that hides a broken constant for months.
 *
 * EMPTY RATHER THAN A NEW NAME. The shipped library turns over constantly, so
 * any name written here is a hostage to the next swap -- and there is no longer
 * a desktop A/B to keep in step with, which was the only reason to pin one.
 * `npm run sync:configs` builds the manifest and the manifest decides; this
 * says "take the first" without pretending to know what that is.
 */
export const DEFAULT_PRESET_NAME = 'Diversity';

/** One config in the catalog, wherever it came from. */
export interface ConfigEntry {
  readonly name: string;
  readonly category: string;
  readonly source: 'manifest' | 'idb';
  /** Manifest entries only. Read by `read()` and by nothing else. */
  readonly path?: string;
}

/** Thrown when a write is attempted with no storage behind it. */
export class StorageUnavailableError extends Error {
  constructor() {
    super('Saving is unavailable: this browser denied access to local storage.');
    this.name = 'StorageUnavailableError';
  }
}

export class ConfigStore {
  private readonly manifest: Manifest;
  /** `null` when IndexedDB is unavailable -- read-only mode. See `idb.ts`. */
  private readonly db: IDBDatabase | null;
  /** The user's saves, cached so `catalog()` stays synchronous. */
  private saved: readonly StoredConfig[];

  private constructor(
    manifest: Manifest,
    db: IDBDatabase | null,
    saved: readonly StoredConfig[],
  ) {
    this.manifest = manifest;
    this.db = db;
    this.saved = saved;
  }

  /**
   * Fetch the manifest and read the user's saves.
   *
   * THE TWO FAILURE MODES ARE DELIBERATELY DIFFERENT. A missing manifest throws,
   * because an app with no presets is not usable and the likeliest cause is a
   * build that did not copy `public/`. Missing IndexedDB does not, because
   * shipped presets still work without it.
   */
  static async open(): Promise<ConfigStore> {
    // In parallel: neither depends on the other, and both are startup latency.
    const [manifest, db] = await Promise.all([loadManifest(), openConfigDb()]);
    let saved: readonly StoredConfig[] = [];
    if (db !== null) {
      try {
        saved = await idbList(db);
      } catch (e) {
        // A readable database that fails to list is odd but survivable, and the
        // same argument applies: shipped presets should still load.
        console.warn(`Could not list saved configs: ${String(e)}`);
      }
    }
    return new ConfigStore(manifest, db, saved);
  }

  /**
   * Build a store over supplied data, with no fetch and no IndexedDB.
   *
   * FOR TESTS. The merge and the ordering are the parts of this module worth
   * asserting and the only parts that are pure -- but `open()` reaches for two
   * globals that `node --test` has neither of. This is the seam that lets the
   * catalog be tested without a fake `fetch`, a fake `indexedDB`, or making the
   * constructor public.
   *
   * The resulting store is READ-ONLY: `db` is null, so `write` and `remove`
   * reject exactly as they would in a browser that denied storage.
   */
  static forTesting(manifest: Manifest, saved: readonly StoredConfig[] = []): ConfigStore {
    return new ConfigStore(manifest, null, saved);
  }

  /** Whether saving is possible. Surfaced so the UI can say so before trying. */
  get writable(): boolean {
    return this.db !== null;
  }

  /**
   * The catalog, in menu and cycle order.
   *
   * SYNCHRONOUS, which is what lets `status()` return it every frame without the
   * Orchestrator holding an async cache. The IndexedDB half is read once at
   * `open()` and refreshed by `write`/`remove`, both of which are already async.
   */
  catalog(): PresetCatalog {
    const byCategory = new Map<string, string[]>();
    for (const category of this.manifest.categories) {
      byCategory.set(category.name, category.entries.map((e) => e.name));
    }
    for (const record of this.saved) {
      const names = byCategory.get(record.category);
      if (names === undefined) byCategory.set(record.category, [record.name]);
      else names.push(record.name);
    }

    // Core first, then alphabetical -- `discover():362-367`. Empty categories are
    // omitted, which is also what `discover()` does (`:359-360`).
    const ordered = [...byCategory.entries()]
      .filter(([, names]) => names.length > 0)
      .sort(([a], [b]) => {
        if (a === CORE_CATEGORY) return b === CORE_CATEGORY ? 0 : -1;
        if (b === CORE_CATEGORY) return 1;
        return a.localeCompare(b);
      });

    const categories: Record<string, readonly string[]> = {};
    const order: string[] = [];
    for (const [category, names] of ordered) {
      const sorted = [...names].sort((a, b) => a.localeCompare(b));
      categories[category] = Object.freeze(sorted);
      // The flat cycle order is the concatenation of the categories in THEIR
      // order, derived from the same source rather than built separately -- which
      // is what stops the menu and the LEFT/RIGHT cycle disagreeing about what
      // comes next (`project_commands.py:79-80`).
      order.push(...sorted);
    }
    return { categories: Object.freeze(categories), order: Object.freeze(order) };
  }

  /** Look up an entry by its identity, or `null` if there is no such config. */
  entry(category: string, name: string): ConfigEntry | null {
    const record = this.saved.find((r) => r.category === category && r.name === name);
    if (record !== undefined) {
      return { name: record.name, category: record.category, source: 'idb' };
    }
    for (const cat of this.manifest.categories) {
      if (cat.name !== category) continue;
      const found = cat.entries.find((e) => e.name === name);
      if (found !== undefined) {
        return { name, category, source: 'manifest', path: found.path };
      }
    }
    return null;
  }

  /**
   * Find a config by name alone, searching every category.
   *
   * For `?preset=` and for the LEFT/RIGHT cycle, which both name a config
   * without knowing its category. Categories are searched in catalog order, so
   * Core wins a name collision with a user save -- matching the desktop, where
   * `presets` is the flattened category list in the same order.
   */
  entryByName(name: string): ConfigEntry | null {
    for (const category of Object.keys(this.catalog().categories)) {
      const found = this.entry(category, name);
      if (found !== null) return found;
    }
    return null;
  }

  /**
   * Read and parse a config.
   *
   * BRANCHES ON `source`, NOT ON `path`. A record's storage is a property of
   * where it came from, not of which optional fields happen to be populated.
   */
  async read(entry: ConfigEntry): Promise<SavedConfig> {
    const where = `${entry.category}/${entry.name}`;
    if (entry.source === 'manifest') {
      if (entry.path === undefined) {
        throw new Error(`${where}: manifest entry has no path`);
      }
      return fromDocument(await fetchPreset(entry.path), where);
    }
    if (this.db === null) throw new StorageUnavailableError();
    const record = await idbGet(this.db, configId(entry.category, entry.name));
    if (record === undefined) throw new Error(`${where}: no such saved config`);
    return fromDocument(record.document, where);
  }

  /**
   * Save a document under `(category, name)`, replacing any existing one.
   *
   * SILENT OVERWRITE, matching `_cmd_save_config` (`project_commands.py:105-133`),
   * which does no existence check. Any "are you sure" belongs in the UI, where
   * the user can see what they are about to replace.
   */
  async write(category: string, name: string, document: unknown): Promise<void> {
    if (this.db === null) throw new StorageUnavailableError();
    await idbPut(this.db, {
      id: configId(category, name),
      category,
      name,
      document,
      savedAt: Date.now(),
    });
    this.saved = await idbList(this.db);
  }

  /**
   * Delete a saved config.
   *
   * SHIPPED PRESETS CANNOT BE DELETED, which is a guard the desktop does not
   * need and does not have -- there the X button happily unlinks a Core file,
   * because it is the user's own filesystem. Here they are part of the build,
   * so a delete would appear to work and then reappear on reload.
   */
  async remove(entry: ConfigEntry): Promise<void> {
    if (entry.source === 'manifest') {
      throw new Error(`${entry.name} is a shipped preset and cannot be deleted.`);
    }
    if (this.db === null) throw new StorageUnavailableError();
    await idbDelete(this.db, configId(entry.category, entry.name));
    this.saved = await idbList(this.db);
  }
}
