/**
 * The archive's storage: its own IndexedDB database.
 *
 * A sibling of `config/idb.ts`, following its conventions -- a thin typed wrapper
 * over object stores with no library, and `open` returning null rather than
 * throwing where storage is unavailable.
 *
 * ## WHY A SEPARATE DATABASE AND NOT A SECOND STORE IN `fluoddity`
 *
 * Adding stores to the existing database means bumping its `DB_VERSION`, and
 * `openConfigDb` rejects on `onblocked` -- which fires when another tab still
 * holds the older version open. So a version bump would make a user with two
 * tabs open lose SAVING, not merely archiving, until they closed one. The
 * archive is an opt-in research feature and the save path is the app's core
 * promise; the archive must not be able to break it.
 *
 * A separate database also means "download archive" and any future "clear
 * archive" cannot touch a user's saved configs, and that the archive's quota
 * pressure is its own.
 *
 * ## WHY INDEXEDDB AND NOT `localStorage`
 *
 * Four reasons, and the first is the one that decides it:
 *
 *   - `localStorage` is SYNCHRONOUS and main-thread. This app runs a WebGPU
 *     render loop; a multi-megabyte serialize-and-write on the record path would
 *     drop frames. IndexedDB writes are async and stay off the frame.
 *   - Quota. `localStorage` is ~5 MB of UTF-16, so ~2.5 MB of usable payload --
 *     a few thousand events, which a heavy fortnight exhausts. IndexedDB is
 *     origin-quota, in the tens of megabytes upward.
 *   - Structured clone stores a `Float32Array` as 320 raw bytes. JSON would
 *     spend ~1.4 kB on the same rule, and base64 adds a third on top.
 *   - Export has to serialize everything at once, which from `localStorage`
 *     would be exactly the main-thread stall described above.
 *
 * ## THE STORES
 *
 *   nodes  one per distinct state, keyed by content hash. Holds the delta that
 *          produced it and its FIRST-VISIT parent. Written once, never updated:
 *          re-reaching a state is not a change to its record.
 *   roots  the full state for nodes that have no parent. Keyed by the same hash,
 *          so a root is a node PLUS a stored state rather than a separate kind
 *          of thing.
 *
 * There is no `edges` store. First-visit parentage means every node has exactly
 * one parent, so the edge set IS the `parent` field -- a separate store would be
 * a second copy of the same fact, able to disagree with it.
 */

const DB_NAME = 'fluoddity-archive';
const DB_VERSION = 1;
export const NODE_STORE = 'nodes';
export const ROOT_STORE = 'roots';

import type { Delta } from './delta.ts';
import type { SimulationConfig, WorldSettings } from '../particleSystem/config.ts';

/**
 * One visited state.
 *
 * `parent` is null exactly for roots. `label` is the history label that produced
 * this state -- prose, for reading the dataset back, never parsed by anything.
 */
export interface ArchiveNode {
  /** Content hash of `{configs, world}`. See `hash.ts`. */
  readonly hash: string;
  /** The hash this state was FIRST reached from, or null for a root. */
  readonly parent: string | null;
  /** What changed from `parent` to here. Absent on roots. */
  readonly delta: Delta | null;
  /** The undo label of the act that produced this state. Display only. */
  readonly label: string;
  /** Wall clock of the first visit, ms since epoch. */
  readonly visitedAt: number;
  /** Which session first reached it, so sessions can be told apart offline. */
  readonly session: string;
}

/**
 * A full state, stored for nodes with no parent.
 *
 * Roots are rare by construction -- `archive.ts` only creates one when a state is
 * genuinely unseen AND has no parent to derive from -- so the ~1.8 kB each is not
 * a budget concern.
 */
export interface ArchiveRoot {
  readonly hash: string;
  readonly configs: readonly SimulationConfig[];
  readonly world: WorldSettings;
  /** Why a root was needed here, for reading the dataset back. */
  readonly reason: string;
  readonly createdAt: number;
}

/** Wrap an IDBRequest as a promise. Same helper as `config/idb.ts`. */
function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * Open the archive database, or return `null` where IndexedDB is unavailable.
 *
 * Never throws, for the reason `openConfigDb` does not: private-browsing modes
 * and denied storage permissions are a degraded mode, not a failure. Here the
 * degradation is total and silent by design -- strong logging simply records
 * nothing, and the app is otherwise unaffected.
 */
export async function openArchiveDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    return await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(NODE_STORE)) {
          db.createObjectStore(NODE_STORE, { keyPath: 'hash' });
        }
        if (!db.objectStoreNames.contains(ROOT_STORE)) {
          db.createObjectStore(ROOT_STORE, { keyPath: 'hash' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('open failed'));
      request.onblocked = () => reject(new Error('blocked by another tab'));
    });
  } catch (e) {
    console.warn(`Archive database unavailable (${String(e)}); strong logging is off.`);
    return null;
  }
}

/**
 * Write a node and, when it is a root, its full state -- in ONE transaction.
 *
 * Both or neither. A root whose node is missing is unreachable, and a parentless
 * node whose root is missing cannot be reconstructed from; either half alone is
 * a corrupt archive. An IndexedDB transaction spanning both stores is what makes
 * that atomic, and it is why this is one function rather than two calls.
 */
export async function putNode(
  db: IDBDatabase,
  node: ArchiveNode,
  root: ArchiveRoot | null,
): Promise<void> {
  const stores = root === null ? [NODE_STORE] : [NODE_STORE, ROOT_STORE];
  const tx = db.transaction(stores, 'readwrite');
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('archive write failed'));
    tx.onabort = () => reject(tx.error ?? new Error('archive write aborted'));
  });
  // `add`, not `put`: a node is written once and never revised, so a second
  // write for the same hash is a bug in the caller's dedup rather than an
  // update. Letting it throw surfaces that instead of silently rewriting
  // parentage -- which is the one field that must never move after first visit.
  tx.objectStore(NODE_STORE).add(node);
  if (root !== null) tx.objectStore(ROOT_STORE).add(root);
  await done;
}

/** Every node hash already on record, for seeding the in-memory dedup set. */
export async function loadKnownHashes(db: IDBDatabase): Promise<Set<string>> {
  const tx = db.transaction(NODE_STORE, 'readonly');
  const keys = await promisify(tx.objectStore(NODE_STORE).getAllKeys());
  return new Set(keys as string[]);
}

export async function allNodes(db: IDBDatabase): Promise<readonly ArchiveNode[]> {
  const tx = db.transaction(NODE_STORE, 'readonly');
  return (await promisify(tx.objectStore(NODE_STORE).getAll())) as ArchiveNode[];
}

export async function allRoots(db: IDBDatabase): Promise<readonly ArchiveRoot[]> {
  const tx = db.transaction(ROOT_STORE, 'readonly');
  return (await promisify(tx.objectStore(ROOT_STORE).getAll())) as ArchiveRoot[];
}

export async function nodeCount(db: IDBDatabase): Promise<number> {
  const tx = db.transaction(NODE_STORE, 'readonly');
  return await promisify(tx.objectStore(NODE_STORE).count());
}
