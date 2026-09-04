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
 *   visits the PATH walked, one entry per act in the order it happened, keyed by
 *          an ordinal. See `visits.ts` for why a traversal cannot live in
 *          `nodes`: that store is keyed by hash so a state has one parent
 *          forever, and a revisit is by definition a second arrival at the same
 *          hash from possibly somewhere else.
 *
 * There is no `edges` store. First-visit parentage means every node has exactly
 * one parent, so the edge set IS the `parent` field -- a separate store would be
 * a second copy of the same fact, able to disagree with it. (The visit log is not
 * that second copy: it records ARRIVALS, which are many per state, where `parent`
 * records DISCOVERY, which is one.)
 */

const DB_NAME = 'fluoddity-archive';
/**
 * Bumped to 2 for the `visits` store.
 *
 * **THE BUMP IS WHY `onblocked` REJECTS RATHER THAN HANGS.** A version change
 * cannot complete while another tab holds the older version open, so a user with
 * two tabs gets a rejected open here -- which `openArchiveDb` turns into a warning
 * and a null, and `startArchiving` turns into "strong logging simply does not
 * run". That is the correct outcome and the reason this database is separate from
 * `fluoddity` in the first place (see above): the same bump against the config
 * database would take SAVING down with it, which is the app's core promise. Here
 * it costs a research feature until the other tab closes.
 *
 * The upgrade is ADDITIVE -- `nodes` and `roots` are untouched, so an existing
 * archive keeps every state it has ever recorded and simply gains an empty visit
 * log from that point on. There is no backfill and there cannot be one: the path
 * through those states was never recorded and is not recoverable from the tree.
 */
const DB_VERSION = 2;
export const NODE_STORE = 'nodes';
export const ROOT_STORE = 'roots';
export const VISIT_STORE = 'visits';

import type { Delta } from './delta.ts';
import type { VisitRecord } from './visits.ts';
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
        // KEYED BY `seq`, NOT BY CONTENT. Every other store here is keyed by
        // hash because a state is the same state however often it is reached;
        // a visit is the opposite -- the same state reached twice is two
        // events, and collapsing them would discard exactly what this store was
        // added to record. The guard is `contains` rather than a version check
        // so the v1 -> v2 upgrade and a fresh v2 create take the same path.
        if (!db.objectStoreNames.contains(VISIT_STORE)) {
          db.createObjectStore(VISIT_STORE, { keyPath: 'seq' });
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
  supersedes: string | null = null,
): Promise<void> {
  const stores = root === null ? [NODE_STORE] : [NODE_STORE, ROOT_STORE];
  const tx = db.transaction(stores, 'readwrite');
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('archive write failed'));
    tx.onabort = () => reject(tx.error ?? new Error('archive write aborted'));
  });
  // **THE SUPERSEDED NODE GOES IN THE SAME TRANSACTION as its replacement.** A
  // coalescing gesture files a node per frame and keeps only the value the user
  // settled on, so each frame retires the one before it. Doing both here means
  // the archive is never observed holding both, or neither -- the same
  // all-or-nothing argument the node/root pairing below makes.
  if (supersedes !== null) tx.objectStore(NODE_STORE).delete(supersedes);
  // `add`, not `put`: a node is written once and never revised, so a second
  // write for the same hash is a bug in the caller's dedup rather than an
  // update. Letting it throw surfaces that instead of silently rewriting
  // parentage -- which is the one field that must never move after first visit.
  //
  // A superseding write is not an exception to that: it DELETES one hash and
  // ADDS a different one, so no record is ever rewritten in place.
  tx.objectStore(NODE_STORE).add(node);
  if (root !== null) tx.objectStore(ROOT_STORE).add(root);
  await done;
}

/**
 * Append one visit to the log.
 *
 * SEPARATE FROM `putNode` and deliberately not folded into it, despite most
 * visits accompanying one. The two have different atomicity needs: a node and its
 * root are meaningless apart and must share a transaction, whereas a visit whose
 * node failed to write is still a true record of something the user did, and a
 * node whose visit failed to write is still a state that was reached. Neither
 * half is corrupt without the other, so pairing them would only widen the
 * transaction and give a single failure two victims instead of one.
 *
 * `add` BY DEFAULT, for `putNode`'s reason: a duplicate `seq` is a bug in the
 * caller's counter, and silently overwriting one visit with another would lose an
 * event with nothing to show for it.
 *
 * `overwrite` switches to `put`, and exactly one caller passes it -- a coalescing
 * gesture replacing its own previous frame, which is the one case where landing
 * on an existing ordinal is intended rather than a bug. Keeping it a parameter
 * rather than making every write a `put` means the strict path stays strict,
 * which is where a counter bug would otherwise hide undetected.
 */
export async function putVisit(
  db: IDBDatabase,
  record: VisitRecord,
  overwrite = false,
): Promise<void> {
  const tx = db.transaction(VISIT_STORE, 'readwrite');
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('archive visit write failed'));
    tx.onabort = () => reject(tx.error ?? new Error('archive visit write aborted'));
  });
  const store = tx.objectStore(VISIT_STORE);
  if (overwrite) store.put(record);
  else store.add(record);
  await done;
}

/**
 * Every visit, in the order they happened.
 *
 * No sort: `seq` is the keyPath and IndexedDB returns keyed records in key
 * order, so the store's own ordering IS the traversal order.
 */
export async function allVisits(db: IDBDatabase): Promise<readonly VisitRecord[]> {
  const tx = db.transaction(VISIT_STORE, 'readonly');
  return (await promisify(tx.objectStore(VISIT_STORE).getAll())) as VisitRecord[];
}

/**
 * The highest `seq` on record, or -1 when the log is empty.
 *
 * **READ ONCE AT ENABLE so a new session's sequence continues rather than
 * restarts.** A per-session counter starting at zero would give every session its
 * own 0, 1, 2 -- and since `seq` is the keyPath, the second session's first visit
 * would collide with the first session's and be rejected as a duplicate. The log
 * would then silently stop recording anything after the first few entries of the
 * second run, which is the kind of failure that looks like "the feature works"
 * right up until the data is read.
 *
 * Opening the cursor in `prev` direction reads one record rather than loading the
 * whole log to take a maximum, which matters at the hundreds of thousands of
 * entries this store is expected to reach.
 */
export async function lastVisitSeq(db: IDBDatabase): Promise<number> {
  const tx = db.transaction(VISIT_STORE, 'readonly');
  const cursor = await promisify(tx.objectStore(VISIT_STORE).openCursor(null, 'prev'));
  const key = cursor?.key;
  return typeof key === 'number' ? key : -1;
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

/**
 * Empty both stores.
 *
 * ONE TRANSACTION, for `putNode`'s reason inverted: roots without their nodes
 * are unreachable and nodes without their roots are unreconstructable, so the
 * two stores must never be observed half-cleared. An aborted transaction leaves
 * the archive exactly as it was, which is the right outcome for a destructive
 * action that failed partway.
 *
 * **THE VISIT LOG GOES WITH THEM, and leaving it would be the subtle half of
 * this.** Every project visit names a node by hash; clearing `nodes` while
 * keeping `visits` would leave a log whose every entry points at a state that no
 * longer exists, so replay would fail on the first record and the surviving data
 * would be unreadable rather than merely partial. A clear means the archive is
 * empty, not that one third of it outlives the rest.
 *
 * The DATABASE SURVIVES, only its contents go. Deleting it outright would need
 * every other tab to close first (`deleteDatabase` blocks on open connections),
 * so a user with two tabs would get a clear that silently never happened.
 */
export async function clearArchive(db: IDBDatabase): Promise<void> {
  const tx = db.transaction([NODE_STORE, ROOT_STORE, VISIT_STORE], 'readwrite');
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('archive clear failed'));
    tx.onabort = () => reject(tx.error ?? new Error('archive clear aborted'));
  });
  tx.objectStore(NODE_STORE).clear();
  tx.objectStore(ROOT_STORE).clear();
  tx.objectStore(VISIT_STORE).clear();
  await done;
}
