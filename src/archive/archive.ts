/**
 * The permanent archive: a directed graph of every project state ever visited,
 * plus the path the user walked through it.
 *
 * ## TWO DATASETS, ONE RECORDER
 *
 * This module writes two things at once, and keeping them straight is the whole
 * design:
 *
 *   THE NODE TREE answers "where did exploration REACH, and from where did it
 *   first get there". One record per distinct state, forever.
 *
 *   THE VISIT LOG (`visits.ts`) answers "what did the user DO, in order". One
 *   record per act, including the acts that reach nowhere new.
 *
 * The tree is the older of the two and its invariants are unchanged by the log's
 * existence -- every rule below about parentage, dedup and coalescing still holds
 * exactly as it did. The log is strictly additive: it observes the same calls and
 * writes a second, differently-keyed record. Where the tree says "nothing to do
 * here", the log usually still has something to say, and that asymmetry is the
 * point of having both.
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
 * full traversal graph and is not meant to be -- the visit log is where the
 * traversal lives, and `visits.ts` explains at length why the two cannot share a
 * record.
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
 * and excluded here for the same reason, in BOTH datasets. Because the archive
 * hooks `recordHistory`, this is free: previews never call it.
 *
 * INTERMEDIATE VALUES OF A DRAG. `History` coalesces a gesture into one entry,
 * so the forty per-frame values of a slider sweep never become forty nodes. The
 * archive inherits that, and wants to: the user chose the value they stopped on.
 * **THE VISIT LOG INHERITS IT TOO** -- a gesture is one visit at its settled
 * value, not one per frame -- so the log is a record of ACTIONS at exactly the
 * granularity the undo menu shows, rather than of pointer movement.
 *
 * REVISITS, IN THE NODE TREE ONLY. Returning to a known state adds no node and no
 * edge and never changes parentage: the tree is a map of where exploration
 * reached and from where it FIRST got there, and re-treading is not discovery.
 * **BUT IT IS NOW RECORDED IN THE VISIT LOG**, with `repeat: true`, because
 * re-treading is absolutely part of what the user DID. Both readings of "we only
 * care about the first visit" are now available from the data: filter the log to
 * `repeat === false` and you have the tree's view exactly.
 *
 * RENAMES. `name` is not hashed (`hash.ts`), so renaming a project is not a new
 * state and produces no node -- and no visit either, since the hash it would
 * report is the one it already sits on.
 *
 * CONTINUOUS INPUT. Camera movement and the draw/shove/trail tools are absent
 * from both datasets. `visits.ts`'s `CommandVisit` sets out why: their effect is
 * either a per-frame value with no discrete act to name, or lives in a GPU
 * texture that no hash covers and no delta can express.
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
import type { Visit, VisitKind, VisitRecord } from './visits.ts';
import {
  type ArchiveNode,
  type ArchiveRoot,
  openArchiveDb,
  lastVisitSeq,
  loadKnownHashes,
  nodeCount,
  putNode,
  putVisit,
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
  /**
   * Write a node, its root if it has one, and retire `supersedes` if given.
   *
   * All in ONE transaction: a coalescing gesture replaces its own last frame,
   * and an archive observed holding both -- or neither -- is a corrupt one.
   */
  put(
    node: ArchiveNode,
    root: ArchiveRoot | null,
    supersedes?: string | null,
  ): Promise<void>;
  known(): Promise<Set<string>>;
  count(): Promise<number>;
  /**
   * Append one entry to the visit log, or overwrite an existing ordinal.
   *
   * `overwrite` is true ONLY for a coalescing gesture replacing its own previous
   * frame. Everything else appends strictly, so a duplicate ordinal surfaces as
   * a failed write rather than as a silently lost event. See `visits.ts`.
   */
  putVisit(record: VisitRecord, overwrite: boolean): Promise<void>;
  /** The highest `seq` already stored, so a new session continues the sequence. */
  lastSeq(): Promise<number>;
}

/** The real store, over the archive database. */
export function idbStore(db: IDBDatabase): ArchiveStore {
  return {
    put: (node, root, supersedes) => putNode(db, node, root, supersedes ?? null),
    known: () => loadKnownHashes(db),
    count: () => nodeCount(db),
    putVisit: (record, overwrite) => putVisit(db, record, overwrite),
    lastSeq: () => lastVisitSeq(db),
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
   * The ordinal for the next visit, continuing from what is already stored.
   *
   * **SEEDED FROM `lastSeq` AT ENABLE, NOT RESET TO ZERO.** `seq` is the visit
   * store's keyPath, so a per-session counter would make every session's first
   * visit collide with the previous session's -- and since visits are written
   * with `add`, the collision is a rejected write rather than an overwrite. The
   * log would quietly stop recording a few entries into the second session and
   * look fine until somebody read it.
   */
  private nextSeq = 0;

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
   * The node this gesture has filed, and which the next frame retires.
   *
   * **ONLY EVER A NODE THIS GESTURE CREATED.** Null when the drag has passed
   * through a state that was already on record, because that node was somebody
   * else's discovery and deleting it would erase a visit this gesture did not
   * make. A drag that sweeps across an old state therefore leaves it alone and
   * simply stops superseding until it files something new.
   */
  private gestureNode: string | null = null;
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
  /**
   * The visit log entry this gesture filed, so the next frame can REPLACE it.
   *
   * The log's analogue of `gestureNode`, and it exists for the same reason: a
   * drag calls `recordVisit` per frame, and a log that appended each one would
   * hold a hundred entries for an act the undo menu shows as one. Rewriting the
   * same `seq` keeps the log at exactly one visit per coalesced action, matching
   * both the timeline and the node tree.
   *
   * **UNLIKE `gestureNode`, THIS IS NEVER CLEARED BY LANDING ON A KNOWN STATE.**
   * `gestureNode` goes null there because the node belongs to whoever discovered
   * it and must not be deleted; a visit is not shared with anyone, so a sweep
   * that passes back over an old value still owns its own log entry and keeps
   * updating it.
   */
  private gestureSeq: number | null = null;

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
      // BOTH READS BEFORE THE FIRST WRITE, and inside the same `try`: a visit
      // log whose sequence started from a stale zero would reject every write
      // after the first few, so failing to read it is as disqualifying as
      // failing to read the dedup set.
      this.nextSeq = (await store.lastSeq()) + 1;
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

    // LOGGED BEFORE THE DEDUP CHECK, so an install is recorded whether or not it
    // discovered anything. Loading a preset you have opened a hundred times is a
    // real act and belongs in the path; it simply adds no node. `repeat` is read
    // off `known` inside `logProject`, which is why this must precede `commit`.
    this.logProject(hash, this.cursorHash, 'enter', `enter: ${reason}`);

    if (this.known.has(hash)) {
      // Already mapped. Moving here is a traversal, not a discovery: no node, no
      // edge, and parentage is left exactly as the first visit set it. The visit
      // log above is what now remembers that it happened at all.
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

    // **A COALESCED STEP CONTINUES THE GESTURE ALREADY ON RECORD, so it retires
    // the frame before it rather than adding to a pile.**
    //
    // Without this the archive files a node per FRAME of a drag: `record` is
    // called on every one, and only the timeline knew that the fortieth call was
    // still the same act as the first. A two-second slider sweep became a
    // hundred states -- exactly the flood coalescing exists to prevent, and
    // invisible in the undo menu, which showed the one entry it always did.
    //
    // The archive is therefore EXACTLY as strict as the undo stack: ONE NODE PER
    // COALESCED ACTION. The timeline's answer to "what counts as a step" is the
    // one the user experiences, so a second policy here would only be a second
    // thing to reason about.
    if (outcome === 'coalesced' && this.gestureOrigin !== null) {
      this.advanceGesture(after, label, tag);
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
    // THE VISIT IS LOGGED EITHER WAY, and before the dedup check for the reason
    // `enterState` logs early: `repeat` is read off `known`, so logging after the
    // commit would mark every first visit as a repeat. The sequence number is
    // kept because a coalescing gesture rewrites this same entry per frame.
    const seq = this.logProject(hash, this.cursorHash, 'act', label);

    if (this.known.has(hash)) {
      // A state we have been to before. Under first-visit parentage this is a
      // revisit: the cursor moves and NO NODE is written. Undoing to a state and
      // redoing forward along the same path lands here, as does rediscovering a
      // state by a different route.
      //
      // **THE GESTURE IS STILL SET UP**, unlike before the visit log existed. A
      // drag whose first frame lands on a known value used to leave `gesture*`
      // null, so the second frame would take the non-coalesced path and append a
      // fresh log entry -- one per frame, the exact flood this all exists to
      // avoid. The origin and parent are recorded here so the gesture can extend
      // properly; `gestureNode` stays null because this node is not ours to
      // retire, which is the same rule `advanceGesture` follows.
      // ORDER MATTERS: the parent is where the hand BEGAN, so it is taken from
      // the cursor before the cursor moves to the destination.
      this.gestureParent = this.cursorHash;
      this.cursorHash = hash;
      this.gestureOrigin = before;
      this.gestureNode = null;
      this.gestureSeq = seq;
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
    //
    // `gestureNode` is this node: if the next call continues the gesture, THIS is
    // the frame it retires. A one-shot act sets it too and simply never has it
    // read.
    this.gestureParent = this.cursorHash;
    this.gestureOrigin = before;
    this.gestureNode = hash;
    // The log entry this act just filed. If the next call continues the gesture,
    // THIS is the ordinal it rewrites rather than appending beside.
    this.gestureSeq = seq;
    this.commit(hash, node, root);
  }

  /**
   * Advance a gesture already in progress, retiring the frame before it.
   *
   * **THE ARCHIVE'S ANALOGUE OF `History`'s in-place update, and it matches it
   * exactly: ONE NODE PER COALESCED ACTION.** The gesture's START does not move,
   * only its end. Each frame is parented on `gestureParent` -- where the drag
   * began -- and DELETES the node the previous frame filed, so a two-second
   * slider sweep leaves the single value the user settled on rather than the
   * hundred it swept past.
   *
   * The intermediate values are genuinely discarded, not merely re-parented.
   * They were technically visited, but they are not choices: nobody decided on
   * the value a slider was passing through on its way somewhere else, and a
   * dataset about exploration should record where the exploring stopped. That is
   * the same judgement `History` already makes for undo, and the archive is now
   * no stricter and no looser than the timeline.
   *
   * **A STATE THAT WAS ALREADY ON RECORD IS NEVER DELETED**, even if a drag
   * happens to pass through it -- it belongs to whatever earlier act discovered
   * it, and this gesture has no claim on it. `gestureNode` is null in that case
   * and the sweep simply stops superseding until it files something new.
   */
  private advanceGesture(
    after: Project,
    label: string,
    tag: ArchiveTag | null,
  ): void {
    const origin = this.gestureOrigin;
    if (origin === null) return;

    const hash = hashState(after);
    // **THE LOG ENTRY IS REWRITTEN, NEVER APPENDED TO.** The gesture holds one
    // ordinal for its whole duration and keeps overwriting it, so a two-second
    // sweep is one visit at the value the user settled on -- matching the single
    // node it files and the single undo entry the timeline shows. Rewritten
    // before the dedup branch below, because both branches need it: a sweep that
    // passes back over a known value is still the same gesture and still owns
    // this entry.
    if (this.gestureSeq !== null) {
      this.logProject(hash, this.gestureParent, 'act', label, this.gestureSeq);
    }

    // Landing on a state already recorded -- dragging a slider back to where it
    // started, which happens constantly. Nothing to file, and nothing to retire:
    // this node is not the gesture's to remove.
    if (this.known.has(hash)) {
      this.cursorHash = hash;
      this.gestureNode = null;
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
    const superseded = this.gestureNode;
    this.gestureNode = hash;
    this.commit(hash, node, null, superseded);
  }

  /**
   * Move the cursor for undo and redo, recording the move in the visit log.
   *
   * **NO NODE AND NO EDGE, BUT A VISIT.** Both operations reach states that are
   * already mapped, so the tree has nothing to add -- the reverse edge an undo
   * would produce is deliberately not part of that dataset, and parentage stays
   * where the first visit put it. What matters structurally is that the cursor
   * FOLLOWS, because the next act's parent is read from it: that is what makes
   * undoing and then working forward create a branch rather than a straight line.
   *
   * The LOG, by contrast, has a great deal to add, and this is the case that
   * motivated it. "The user backed up three steps and then went a different way"
   * is invisible in the tree -- which shows only a fork, with no hint that
   * reaching it took any backtracking -- and is exactly what a replay needs. So
   * `kind` distinguishes the direction rather than collapsing both into a plain
   * arrival.
   *
   * A state that is somehow unseen is adopted rather than dropped, so the cursor
   * is never left pointing at nothing. That path logs its own `enter` visit
   * through `enterState`, which is why this one returns rather than falling
   * through -- otherwise the move would be recorded twice.
   */
  moveCursor(project: Project, kind: 'undo' | 'redo' = 'undo'): void {
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
      this.logProject(hash, this.cursorHash, kind, kind);
      this.cursorHash = hash;
      return;
    }
    // Unseen: `enterState` adopts it AND logs its own visit, so nothing is
    // logged here. The label there says `enter: session` rather than naming the
    // undo, which is the honest record -- the archive genuinely did not know
    // this state, so what happened was an adoption rather than a step back
    // through mapped territory.
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
    // **THE SEQUENCE RESTARTS, because `clearArchive` empties the visit store
    // too.** Leaving the counter where it was would work -- ordinals would just
    // begin at some arbitrary number -- but a cleared archive whose first visit
    // is #4,812 reads as a log with 4,811 lost entries, which is exactly the
    // wrong impression for data that is meant to be studied.
    this.nextSeq = 0;
    this.endGesture();
  }

  /** Forget any gesture in progress, so the next step starts a fresh node. */
  private endGesture(): void {
    this.gestureParent = null;
    this.gestureOrigin = null;
    this.gestureNode = null;
    this.gestureSeq = null;
  }

  /**
   * Append one entry to the visit log, or REWRITE one when `seq` is given.
   *
   * Returns the sequence number used, so a gesture can hold on to it and keep
   * overwriting the same record. Fire-and-forget on the same terms as `commit`:
   * the counter advances synchronously and the write settles in the background,
   * because two acts in one frame must not be handed the same ordinal.
   *
   * **AN EXPLICIT `seq` MEANS OVERWRITE**, and the store is told so. A new entry
   * is written with `add`, which rejects a duplicate ordinal and so catches a
   * counter bug rather than silently losing an event; a gesture's replacement is
   * written with `put`, because overwriting its own previous frame is exactly
   * what it intends. Passing the distinction down rather than always using `put`
   * keeps the ordinary path strict, which is where a bug would actually hide.
   */
  private logVisit(visit: Visit, seq?: number): number {
    const overwrite = seq !== undefined;
    const record: VisitRecord = {
      seq: seq ?? this.nextSeq++,
      session: this.session,
      at: this.now(),
      visit,
    };
    void this.store?.putVisit(record, overwrite).catch((e: unknown) => {
      if (this.warned) return;
      this.warned = true;
      console.warn(`Archive write failed (${String(e)}); further failures are silent.`);
    });
    return record.seq;
  }

  /**
   * Record a project arrival in the log, whether or not it was a discovery.
   *
   * **THE ONE PLACE `repeat` IS DECIDED**, and it reads `known` BEFORE the caller
   * has added the new hash to it -- so every call site must log before it
   * commits. Getting that order wrong would mark every visit as a repeat,
   * including first ones, and the mistake would be invisible in the app and fatal
   * to the dataset.
   */
  private logProject(
    hash: string,
    from: string | null,
    kind: VisitKind,
    label: string,
    seq?: number,
  ): number {
    return this.logVisit(
      {
        type: 'project',
        kind,
        hash,
        from,
        label,
        repeat: this.known.has(hash),
      },
      seq,
    );
  }

  /**
   * Record a preference change. One entry per field -- see `PreferenceVisit`.
   *
   * PUBLIC, and called by the Orchestrator's `adoptPreferences`, which is the
   * single funnel every preference write in the app passes through. That is why
   * this costs no plumbing at the individual call sites: `editSetting`,
   * `editDrawPref`, `editViewPref` and `resetPreferences` all arrive here already.
   */
  recordPreference(
    field: string,
    value: number | boolean,
    previous: number | boolean,
    label: string,
  ): void {
    if (this.store === null) return;
    this.logVisit({ type: 'preference', field, value, previous, label });
  }

  /**
   * Record a discrete command that moves no project state.
   *
   * Simulation reset, pause, camera mode, mouse mode, clearing a field. See
   * `CommandVisit` for what is deliberately excluded and why.
   */
  recordCommand(command: string, label: string): void {
    if (this.store === null) return;
    this.logVisit({ type: 'command', command, label });
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
  private commit(
    hash: string,
    node: ArchiveNode,
    root: ArchiveRoot | null,
    supersedes: string | null = null,
  ): void {
    // **THE RETIRED NODE LEAVES THE DEDUP SET TOO.** That set is the in-memory
    // mirror of what is stored, and leaving a deleted hash in it would make the
    // archive believe a state is on record when it is not -- so returning to
    // that value later would be treated as a revisit and never re-filed. The
    // state would be permanently unrecordable for the rest of the session.
    if (supersedes !== null) this.known.delete(supersedes);
    this.known.add(hash);
    this.cursorHash = hash;
    void this.store?.put(node, root, supersedes).catch((e: unknown) => {
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
