/**
 * The visit log: the PATH the user actually walked, in the order they walked it.
 *
 * ## WHY THIS EXISTS ALONGSIDE THE NODE TREE AND NOT INSIDE IT
 *
 * `archive.ts` records a spanning tree oriented by DISCOVERY: a node per distinct
 * state, parented on wherever it was first reached from. That answers "where did
 * exploration reach, and from where did it first get there", and it answers it
 * with one record per state no matter how often the state is revisited.
 *
 * It cannot answer "what did the user DO, in sequence". Those are different
 * questions and the tree deliberately discards what the second one needs:
 *
 *   - A REVISIT writes nothing at all (`recordVisit`'s known-hash early return).
 *     Returning to a state ten times is indistinguishable from returning once.
 *   - UNDO AND REDO write nothing; `moveCursor` moves the cursor silently. So the
 *     tree shows a fork but not that the user backed up three steps to reach it.
 *   - ORDER survives only as first-visit order. Interleaving between branches is
 *     gone.
 *
 * The obvious-looking fix -- let a revisit file a second node sharing the hash --
 * does not work, and the reason is worth stating because it is the whole argument
 * for a separate store. `nodes` is KEYED BY HASH and written with `add` rather
 * than `put` (`archiveDb.ts`), precisely so parentage can never be rewritten
 * after first visit. A second record for the same hash either collides on the
 * keyPath or, if the key were relaxed, makes `node.parent` ambiguous -- and
 * `lineageOf` walks exactly that field. The tree's central invariant is that a
 * state has ONE parent forever; a traversal log's central fact is that a state
 * may be arrived at many times from many places. Those two cannot share a record.
 *
 * So: the tree keeps its invariants untouched, and this log sits beside it,
 * keyed by an ordinal rather than by content. Every project visit here names a
 * `hash` that IS a node in the tree, so replay is `reconstruct(archive, visit.
 * hash)` -- already implemented, and needing no delta of its own. The log is
 * therefore almost pure gain: ~40 bytes an entry buys the traversal, and the
 * states it points at were being stored anyway.
 *
 * ## WHAT A "PARENT FOR FUTURE STATES" MEANS HERE
 *
 * `from` is per-VISIT, where `node.parent` is per-STATE. Revisiting state A and
 * then editing forward produces a visit whose `from` is A, regardless of how many
 * times A has been visited before or which of those visits the node tree calls
 * A's parent. That is the "distinct parent for future states" property, obtained
 * without touching parentage at all.
 *
 * ## THE THREE KINDS OF ENTRY
 *
 * `project` entries carry a hash and are replayable through the node tree.
 * `preference` and `command` entries carry no hash, because they are not project
 * states -- a brightness change or a pause moves nothing the archive hashes. They
 * are here rather than in a fourth store because the one thing a replay needs
 * above all is a SINGLE TOTAL ORDER over everything the user did; splitting them
 * across stores would mean merging by timestamp afterwards and guessing at ties.
 *
 * ## FAILURE IS SILENT, AS EVERYWHERE IN `archive/`
 *
 * Same contract as the node tree: bookkeeping is synchronous, the write is
 * detached, and a failed write is dropped. A hole in the log is enormously better
 * than a dropped frame.
 */

/**
 * How a project state was arrived at.
 *
 * `act` is an ordinary edit. `undo` and `redo` are cursor moves along the
 * timeline -- the entries the node tree structurally cannot hold, and the reason
 * this log exists. `enter` covers the wholesale installs (`RootReason`'s paths):
 * session start, a committed load, a paste, a checkpoint restore.
 */
export type VisitKind = 'act' | 'undo' | 'redo' | 'enter';

/**
 * A project state was visited.
 *
 * **`hash` NAMES A NODE IN THE TREE and is not itself a state.** The state is
 * reconstructed from the node, which is what keeps a revisit at ~40 bytes rather
 * than at the ~1.8 kB a full state costs. `repeat` marks that this hash had been
 * visited before, so an analysis can filter to first visits and recover exactly
 * the node tree's view without re-deriving it.
 */
export interface ProjectVisit {
  readonly type: 'project';
  readonly kind: VisitKind;
  /** The state arrived at. A key into the `nodes` store. */
  readonly hash: string;
  /** The state departed from, or null at the start of a session. */
  readonly from: string | null;
  /** The undo label of the act, or the reason for an `enter`. Display only. */
  readonly label: string;
  /** True when this hash was already on record -- a revisit rather than a discovery. */
  readonly repeat: boolean;
}

/**
 * A preference changed.
 *
 * One entry per FIELD, so a `resetPreferences` that moves nine settings is nine
 * entries rather than one opaque "reset". They share a sequence run and can be
 * grouped back together by `label` if an analysis wants the coarser view; the
 * reverse -- recovering which fields a bundled entry moved -- would need the old
 * value stored anyway, so the fine grain costs nothing and answers more.
 *
 * `strongLogging` IS NEVER RECORDED. Logging the act of enabling logging puts an
 * entry in the dataset that describes the dataset's own existence, and its
 * partner -- disabling -- can never be recorded at all, because recording stops
 * first. An asymmetric pair is worse than an absent one.
 */
export interface PreferenceVisit {
  readonly type: 'preference';
  readonly field: string;
  readonly value: number | boolean;
  /** The value replaced, so the log replays forwards or backwards. */
  readonly previous: number | boolean;
  readonly label: string;
}

/**
 * A discrete command that changes no project state.
 *
 * Simulation reset, pause, camera mode, mouse mode, clearing a field. These have
 * no before/after to diff -- pausing twice returns you to where you began -- so
 * they are recorded as EVENTS rather than as states, and carry only their name.
 *
 * **THE CONTINUOUS PATHS ARE DELIBERATELY ABSENT.** Camera movement is a
 * per-frame value governed by a blur schedule with no discrete act to record, and
 * the draw/shove/trail tools write into GPU textures that no hash covers and no
 * delta can express -- their effect is not in the project state at all. Recording
 * either would mean storing a pointer stream and hoping a replay reproduced it,
 * which is a different and much larger promise than this log makes. What is here
 * is exactly the set of acts that are discrete, deliberate, and faithfully
 * replayable.
 */
export interface CommandVisit {
  readonly type: 'command';
  readonly command: string;
  readonly label: string;
}

export type Visit = ProjectVisit | PreferenceVisit | CommandVisit;

/**
 * A visit as stored: the entry plus its ordering and provenance.
 *
 * **`seq` IS THE RECORD'S IDENTITY, and it must be, because nothing else about a
 * visit is unique** -- the same state revisited from the same place with the same
 * label is a genuinely different event, and that repetition is the signal this
 * log exists to capture. It is assigned monotonically within a session and is the
 * store's keyPath, so IndexedDB returns entries in the order they happened with
 * no sort.
 *
 * `at` is wall clock and is NOT the ordering key: two acts in one frame can share
 * a millisecond, and `Date.now` is not monotonic across a clock adjustment.
 * Timestamps are for reading the dataset, `seq` is for ordering it.
 */
export interface VisitRecord {
  readonly seq: number;
  readonly session: string;
  readonly at: number;
  readonly visit: Visit;
}
