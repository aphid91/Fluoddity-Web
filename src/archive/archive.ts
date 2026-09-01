/**
 * The permanent archive: a directed graph of every project state ever visited.
 *
 * ## THE MODEL, in three sentences
 *
 * Every distinct project state is a NODE, keyed by a content hash of the physics
 * it describes (`hash.ts`). A node's PARENT is the state the user was in
 * immediately before their FIRST visit to it, and that parent never changes
 * afterwards. Nodes with no parent are ROOTS, and only those store a full state;
 * everything else stores the delta from its parent (`delta.ts`).
 *
 * That is a spanning tree over the states, oriented by discovery. It is not the
 * full traversal graph and is not meant to be -- see "what is deliberately not
 * recorded".
 *
 * ## THE CURSOR, which is what makes the rest work
 *
 * The archive holds one piece of mutable state: `cursor`, the hash of the state
 * the user is in right now. Every recorded act emits an edge from `cursor` to
 * the new state, and then moves `cursor` there. Undo and redo move `cursor`
 * WITHOUT emitting anything.
 *
 * That single rule produces the branching structure correctly and with no special
 * cases. Walk the interesting one: the user goes A -> B -> C, undoes twice to A,
 * then acts. The cursor followed them back to A, so the new state D gets parent
 * A -- and A now has two children, B and D, which is exactly the fork the dataset
 * exists to capture. `History` itself cannot answer this: `record` TRUNCATES the
 * abandoned branch (`this.states.length = this.cursorIndex + 1`), so B and C are
 * gone from the timeline the instant D is recorded. The archive has already
 * written them, which is the whole reason it observes edges as they happen rather
 * than reading them off the timeline afterwards.
 *
 * ## WHAT IS DELIBERATELY NOT RECORDED
 *
 * HOVER-PREVIEW. Excluded from `History` for reasons its header sets out at
 * length -- browsing forty configs applies forty states the user never chose --
 * and excluded here for the same reason. Because the archive hooks
 * `recordHistory`, this is free: previews never call it.
 *
 * INTERMEDIATE VALUES OF A DRAG. `History` coalesces a gesture into one entry,
 * so the forty per-frame values of a slider sweep never become forty nodes. The
 * archive inherits that, and wants to: the user chose the value they stopped on.
 *
 * REVISITS. Returning to a known state emits nothing at all -- no second edge, no
 * visit record, no change to parentage. The dataset is a map of WHERE
 * exploration reached and from where it first got there; re-treading is not
 * discovery. This is what "we only care about the first visit to a state" means,
 * taken literally.
 *
 * RENAMES. `name` is not hashed (`hash.ts`), so renaming a project is not a new
 * state and produces no node.
 *
 * ## FAILURE IS ALWAYS SILENT
 *
 * Nothing here may throw into a frame. `recordVisit` is fire-and-forget: it
 * updates the cursor and the in-memory dedup set SYNCHRONOUSLY, then writes to
 * IndexedDB in the background. A failed write is warned once and dropped. The
 * archive is a research feature attached to a real-time renderer, and a dataset
 * with a hole in it is enormously better than a dropped frame or a broken app.
 */

import type { Project } from '../project/project.ts';
import type { RecordOutcome } from '../project/history.ts';
import { type ArchiveTag, type Delta, deriveDelta } from './delta.ts';
import { hashState } from './hash.ts';
import {
  type ArchiveNode,
  type ArchiveRoot,
  openArchiveDb,
  loadKnownHashes,
  nodeCount,
  putNode,
} from './archiveDb.ts';

/**
 * Why a root was created. Stored on the root for reading the dataset back.
 *
 * `session` is the ordinary one: the app started and the state it started in was
 * unseen. The rest are the paths that can install a project wholesale.
 */
export type RootReason = 'session' | 'load' | 'paste' | 'checkpoint' | 'logging-enabled';

/** The storage surface, injectable so tests run under `node --test` with no IDB. */
export interface ArchiveStore {
  put(node: ArchiveNode, root: ArchiveRoot | null): Promise<void>;
  known(): Promise<Set<string>>;
  count(): Promise<number>;
}

/** The real store, over the archive database. */
export function idbStore(db: IDBDatabase): ArchiveStore {
  return {
    put: (node, root) => putNode(db, node, root),
    known: () => loadKnownHashes(db),
    count: () => nodeCount(db),
  };
}

/** A short, sortable session id. Distinguishes runs without identifying anything. */
function newSessionId(now: number): string {
  return `${now.toString(36)}-${Math.floor(Math.random() * 0x10000).toString(36)}`;
}

/**
 * The archive.
 *
 * Constructed unconditionally by the Orchestrator but INERT until `enable` is
 * called, so the strong-logging preference gates work rather than construction.
 * A disabled archive costs one null check per `recordHistory`.
 */
export class ProjectArchive {
  private store: ArchiveStore | null = null;
  /** Hashes already on record. Seeded from storage on enable; the dedup set. */
  private known = new Set<string>();
  /** Where the user is now. Null until the first state is seen. */
  private cursorHash: string | null = null;
  private session = '';
  /** Warn once per session rather than per failed write. */
  private warned = false;

  /**
   * The gesture currently being extended, if any.
   *
   * The state the gesture STARTED from -- the node every frame of the drag
   * re-parents onto, because a drag's parent is where the hand began, not the
   * value it passed through last frame.
   *
   * Null whenever no gesture is in flight, which is the common case: only a
   * coalescing key (a slider drag) ever sets it.
   */
  private gestureParent: string | null = null;
  /**
   * The gesture's ORIGIN STATE, held so a replacement's delta can be derived
   * against the same node it is parented on.
   *
   * A delta means "apply this to my parent". Deriving one against the previous
   * FRAME while parenting on the gesture's start would produce a delta that
   * reconstructs to the wrong value -- silently, since both are the same field
   * and only the number differs. The project itself is held rather than
   * re-derived because a `Project` is immutable and a reference costs nothing,
   * which is the same argument `history.ts` makes for storing snapshots.
   */
  private gestureOrigin: Project | null = null;

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  get enabled(): boolean {
    return this.store !== null;
  }

  /** The state the user is currently in, for tests and diagnostics. */
  get cursor(): string | null {
    return this.cursorHash;
  }

  /**
   * Turn logging on, seeding the dedup set from what is already stored.
   *
   * `project` is the state the user is in AT THE MOMENT logging is enabled. It
   * becomes a root only if it is genuinely unseen -- someone who enables logging
   * while sitting on a preset they have visited before adds no root, and the
   * cursor simply picks up at the existing node. That is the same dedup every
   * other root path gets; see `enterState`.
   */
  async enable(store: ArchiveStore, project: Project): Promise<void> {
    this.store = store;
    this.session = newSessionId(this.now());
    try {
      this.known = await store.known();
    } catch (e) {
      console.warn(`Archive could not be read (${String(e)}); strong logging is off.`);
      this.store = null;
      return;
    }
    this.enterState(project, 'logging-enabled');
  }

  /** Turn logging off. The stored archive is untouched; only recording stops. */
  disable(): void {
    this.store = null;
    this.cursorHash = null;
    this.endGesture();
  }

  /**
   * Adopt a state that did not come from an act on the current one.
   *
   * Session start, a committed load, a paste, a checkpoint restore -- the paths
   * that install a project wholesale rather than editing the live one.
   *
   * **THE ROOT IS CREATED ONLY IF THE STATE IS UNSEEN**, which is the point of
   * doing this through the same dedup as everything else. Loading a preset you
   * have visited before -- or one you saved, so it is in the archive as an
   * ordinary interior node -- moves the cursor onto the existing node and writes
   * nothing. Roots are therefore genuinely rare, and a checkpoint root is rarer
   * still: it takes making the checkpoint, THEN enabling logging, then loading it.
   */
  enterState(project: Project, reason: RootReason): void {
    if (this.store === null) return;
    const hash = hashState(project);

    if (this.known.has(hash)) {
      // Already mapped. Moving here is a traversal, not a discovery: no node, no
      // edge, and parentage is left exactly as the first visit set it.
      this.cursorHash = hash;
      return;
    }

    const node: ArchiveNode = {
      hash,
      parent: null,
      delta: null,
      label: `root: ${reason}`,
      visitedAt: this.now(),
      session: this.session,
    };
    const root: ArchiveRoot = {
      hash,
      configs: project.configs,
      world: project.world,
      reason,
      createdAt: node.visitedAt,
    };
    this.commit(hash, node, root);
  }

  /**
   * Record a deliberate act moving the project from `before` to `after`.
   *
   * The Orchestrator's `recordHistory` calls this, so it sees exactly what the
   * undo timeline sees -- previews and undo/redo excluded, drags already
   * coalesced.
   *
   * **`before` IS TRUSTED OVER THE CURSOR when they disagree.** `History.record`
   * re-seats its current entry on `before` precisely because a preview can move
   * the project without recording, so `before` is the authority on what state was
   * actually departed from. A disagreement means the cursor is stale, and the
   * fix is to believe the argument -- adopting `before` as a new state if it is
   * itself unseen, so the edge has a real source rather than a dangling one.
   */
  recordVisit(
    before: Project,
    after: Project,
    label: string,
    tag: ArchiveTag | null = null,
    outcome: RecordOutcome = 'appended',
  ): void {
    if (this.store === null) return;

    // **A COALESCED STEP CONTINUES THE GESTURE ALREADY ON RECORD, so it REPLACES
    // the node that gesture is building rather than adding one.**
    //
    // Without this the archive files a node per FRAME of a drag: `record` is
    // called on every one, and only the timeline knew that the fortieth call was
    // still the same act as the first. A two-second slider sweep became a
    // hundred states -- exactly the flood coalescing exists to prevent, and
    // invisible in the undo menu, which showed the one entry it always did.
    //
    // The archive is therefore EXACTLY as strict as the undo stack: one node per
    // entry on the timeline, no more. Deliberately not stricter -- a second
    // policy would be a second thing to reason about, and the timeline's answer
    // is the one the user experiences as "a step".
    if (outcome === 'coalesced' && this.gestureOrigin !== null) {
      this.replaceGestureNode(after, label, tag);
      return;
    }
    // Any non-coalesced step ends whatever gesture was in progress.
    this.endGesture();

    const fromHash = hashState(before);
    if (fromHash !== this.cursorHash) {
      // The cursor is stale. `before` is authoritative -- see above.
      if (!this.known.has(fromHash)) {
        this.enterState(before, 'session');
      } else {
        this.cursorHash = fromHash;
      }
    }

    const hash = hashState(after);
    if (this.known.has(hash)) {
      // A state we have been to before. Under first-visit parentage this is a
      // revisit: the cursor moves and nothing is written. Undoing to a state and
      // redoing forward along the same path lands here, as does rediscovering a
      // state by a different route.
      this.cursorHash = hash;
      return;
    }

    const delta: Delta = deriveDelta(before, after, tag);
    const node: ArchiveNode = {
      hash,
      parent: this.cursorHash,
      delta,
      label,
      visitedAt: this.now(),
      session: this.session,
    };
    // A node with no parent needs its state stored, or it cannot be
    // reconstructed from. Unreachable while `enable` seeds the cursor, and
    // handled rather than asserted because an unreconstructable archive is a
    // worse outcome than a redundant root.
    const root: ArchiveRoot | null =
      this.cursorHash === null
        ? {
            hash,
            configs: after.configs,
            world: after.world,
            reason: 'session',
            createdAt: node.visitedAt,
          }
        : null;
    // REMEMBERED BEFORE the commit moves the cursor: a gesture's parent is where
    // the hand began, and every later frame of this drag re-parents onto it.
    // Only a keyed step can be extended, but recording that here unconditionally
    // costs nothing and keeps the two paths symmetric -- an unkeyed act simply
    // never sees a `coalesced` outcome to use it.
    this.gestureParent = this.cursorHash;
    this.gestureOrigin = before;
    this.commit(hash, node, root);
  }

  /**
   * File one frame of a gesture already in progress.
   *
   * **THE ARCHIVE'S ANALOGUE OF `History`'s in-place update**, and it keeps that
   * method's invariant: the gesture's START does not move, only its end. Every
   * frame is parented on `gestureParent` -- where the drag began -- rather than
   * on the value it happens to be leaving, which is what stops a slider sweep
   * laying down a chain of forty nodes each parented on the last.
   *
   * **NOTHING IS DELETED, and that is deliberate.** Each state the drag passed
   * through was genuinely visited: the user held the slider there and saw it.
   * Under first-visit parentage a state that has been reached stays reached, and
   * removing it would make the archive disagree with what happened. So a drag
   * leaves the values it swept through as siblings hanging off its origin, and
   * the value the user settled on is simply the one the next act continues from.
   * Nodes are never revised once written, which is what lets `putNode` use `add`
   * rather than `put`.
   *
   * The GRAPH therefore stays honest about what was seen while the TIMELINE
   * stays honest about what was done -- which is the whole reason these are two
   * structures rather than one.
   */
  private replaceGestureNode(
    after: Project,
    label: string,
    tag: ArchiveTag | null,
  ): void {
    const origin = this.gestureOrigin;
    if (origin === null) return;

    const hash = hashState(after);
    // Landing back on a state already recorded -- dragging a slider back to where
    // it started, which happens constantly. Nothing to file; just follow it.
    if (this.known.has(hash)) {
      this.cursorHash = hash;
      return;
    }

    const node: ArchiveNode = {
      hash,
      // BOTH FROM THE GESTURE'S ORIGIN, and they have to agree. A delta means
      // "apply this to my parent", so deriving against the previous FRAME while
      // parenting on the gesture's start would reconstruct to the wrong value --
      // silently, because both are edits to the same field and only the number
      // differs.
      parent: this.gestureParent,
      delta: deriveDelta(origin, after, tag),
      label,
      visitedAt: this.now(),
      session: this.session,
    };
    this.commit(hash, node, null);
  }

  /**
   * Move the cursor without recording, for undo and redo.
   *
   * Both reach states that are already mapped, so there is nothing to write --
   * the reverse edge an undo would produce is deliberately not part of this
   * dataset. What matters is that the cursor FOLLOWS, because the next act's
   * parent is read from it: that is what makes undoing and then working forward
   * create a branch rather than a straight line.
   *
   * A state that is somehow unseen is adopted rather than dropped, so the cursor
   * is never left pointing at nothing.
   */
  moveCursor(project: Project): void {
    if (this.store === null) return;
    // **A CURSOR JUMP ENDS ANY GESTURE**, mirroring the `breakCoalescing` that
    // undo and redo already call on the timeline -- and for the same reason
    // stated there: resuming a drag after undoing must not rewrite the entry the
    // user just stepped back to. Here the consequence would be worse than a
    // rewritten label: the gesture's origin now names a state the user has left,
    // so the next replacement would parent a node onto a branch it never
    // travelled.
    this.endGesture();
    const hash = hashState(project);
    if (this.known.has(hash)) {
      this.cursorHash = hash;
      return;
    }
    this.enterState(project, 'session');
  }

  /**
   * Forget every state this session believed was already on record.
   *
   * **CALLED AFTER THE DATABASE IS EMPTIED, and it is not optional.** The dedup
   * set is an in-memory mirror of what is stored; leaving it populated after a
   * clear would make the archive skip every state it had seen before -- so the
   * user would clear the archive, carry on working, and record almost nothing,
   * with no error anywhere. The cursor goes too, so the next act re-roots rather
   * than parenting onto a hash that no longer exists.
   */
  forgetAll(): void {
    this.known.clear();
    this.cursorHash = null;
    this.endGesture();
  }

  /** Forget any gesture in progress, so the next step starts a fresh node. */
  private endGesture(): void {
    this.gestureParent = null;
    this.gestureOrigin = null;
  }

  /** How many states are on record. For the Preferences readout. */
  async size(): Promise<number> {
    if (this.store === null) return 0;
    try {
      return await this.store.count();
    } catch {
      return 0;
    }
  }

  /**
   * Mark a node visited and persist it, without waiting.
   *
   * The dedup set and cursor move SYNCHRONOUSLY so two acts in one frame cannot
   * both file the same state, and the write is left to settle in the background.
   * See the header on why failure is silent.
   */
  private commit(hash: string, node: ArchiveNode, root: ArchiveRoot | null): void {
    this.known.add(hash);
    this.cursorHash = hash;
    void this.store?.put(node, root).catch((e: unknown) => {
      if (this.warned) return;
      this.warned = true;
      console.warn(`Archive write failed (${String(e)}); further failures are silent.`);
    });
  }
}

/** Open the archive database and wrap it as a store, or null if unavailable. */
export async function openArchiveStore(): Promise<ArchiveStore | null> {
  const db = await openArchiveDb();
  return db === null ? null : idbStore(db);
}
