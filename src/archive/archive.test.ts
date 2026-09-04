/**
 * The state archive: identity, deltas, and the shape of the graph.
 *
 * ## What is worth testing here
 *
 * Three properties, and each has a failure mode that is silent rather than loud:
 *
 *   - **Identity is over the PACKED f32 bytes.** Two states that differ only
 *     below float32 precision are the same state to every particle on screen,
 *     and hashing the float64s would file them separately -- inventing
 *     exploration in a dataset whose whole purpose is measuring exploration.
 *     Nothing crashes; the graph is just wrong.
 *   - **Undo then act creates a BRANCH.** This is the property the archive
 *     exists for and the one `History` cannot supply: `record` truncates the
 *     abandoned future, so if the archive read parentage off the timeline
 *     instead of watching the cursor, forks would silently become straight
 *     lines.
 *   - **A revisit writes nothing and never re-parents.** "First visit defines
 *     parentage" is the whole model; a second edge would make the graph
 *     ambiguous about where a state was discovered from.
 *
 * The store is a fake rather than IndexedDB, which is what lets this run under
 * `node --test` with no browser -- the same reason `preferences.test.ts` injects
 * its storage. `now` is injected for the reason `history.test.ts` injects it: so
 * timestamps are assertable rather than slept for.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ProjectArchive, type ArchiveStore } from './archive.ts';
import { deriveDelta } from './delta.ts';
import { hashState } from './hash.ts';
import type { ArchiveNode, ArchiveRoot } from './archiveDb.ts';
import type { ProjectVisit, VisitRecord } from './visits.ts';
import {
  type Project,
  editSelected,
  editWorld,
  makeProject,
} from '../project/project.ts';
import { BC, makeSimulationConfig } from '../particleSystem/config.ts';

const base = makeProject({
  configs: [
    makeSimulationConfig(
      {
        cohorts: 4,
        mutationSeed: 0.5,
        sensorGain: 1,
        sensorAngle: 0,
        sensorDistance: 1,
        mutationScale: 0.25,
        globalForceMult: 1,
        drag: 0.5,
        strafePower: 0,
        axialForce: 1,
        lateralForce: 1,
        hazardRate: 0,
      },
      { rule: new Array<number>(80).fill(0.25) },
    ),
  ],
});

/** A project distinguishable by `sensorGain`, so assertions can name a state. */
function at(gain: number): Project {
  return editSelected(base, 'sensorGain', gain);
}

/** An in-memory store, standing in for the archive database. */
class FakeStore implements ArchiveStore {
  readonly nodes: ArchiveNode[] = [];
  readonly roots: ArchiveRoot[] = [];
  readonly visits: VisitRecord[] = [];
  seed: Set<string> = new Set();
  /** What `lastSeq` reports, so a test can stand in for a prior session's log. */
  seedSeq = -1;

  put(
    node: ArchiveNode,
    root: ArchiveRoot | null,
    supersedes?: string | null,
  ): Promise<void> {
    // Retiring the superseded node is what the real store's transaction does,
    // and the tests assert on `nodes` -- so a fake that skipped it would report
    // a drag leaving a pile behind when it does not.
    if (supersedes !== undefined && supersedes !== null) {
      const at = this.nodes.findIndex((n) => n.hash === supersedes);
      if (at >= 0) this.nodes.splice(at, 1);
    }
    this.nodes.push(node);
    if (root !== null) this.roots.push(root);
    return Promise.resolve();
  }
  known(): Promise<Set<string>> {
    return Promise.resolve(new Set(this.seed));
  }
  count(): Promise<number> {
    return Promise.resolve(this.nodes.length);
  }
  /**
   * Models the real store's `add`/`put` split, and the overwrite half matters:
   * a fake that always appended would show a drag leaving one log entry per
   * frame, which is the exact behaviour the coalescing tests exist to disprove.
   */
  putVisit(record: VisitRecord, overwrite: boolean): Promise<void> {
    const at = this.visits.findIndex((v) => v.seq === record.seq);
    if (at >= 0) {
      if (!overwrite) return Promise.reject(new Error(`duplicate seq ${record.seq}`));
      this.visits[at] = record;
    } else {
      this.visits.push(record);
    }
    return Promise.resolve();
  }
  lastSeq(): Promise<number> {
    return Promise.resolve(this.seedSeq);
  }
  /** The node filed for `project`, or undefined. */
  find(project: Project): ArchiveNode | undefined {
    const hash = hashState(project);
    return this.nodes.find((n) => n.hash === hash);
  }
  /** Just the project-state visits, which is what most assertions care about. */
  projectVisits(): ProjectVisit[] {
    return this.visits
      .map((v) => v.visit)
      .filter((v): v is ProjectVisit => v.type === 'project');
  }
}

/** An enabled archive over a fresh fake store. */
async function enabled(
  start: Project = base,
): Promise<{ archive: ProjectArchive; store: FakeStore }> {
  const store = new FakeStore();
  let clock = 1000;
  const archive = new ProjectArchive(() => ++clock);
  await archive.enable(store, start);
  return { archive, store };
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test('the same content hashes the same through different objects', () => {
  // A structurally identical project built separately -- which is what a reload
  // of the same preset produces, and the case reference identity cannot see.
  const twin = makeProject({ configs: base.configs.slice(), world: base.world });
  assert.notEqual(base, twin);
  assert.equal(hashState(base), hashState(twin));
});

test('the name is not part of state identity', () => {
  // A rename has no physics kernel impact, so it is not a new state and must
  // produce no node at all.
  const renamed = makeProject({ ...base, name: 'something else' });
  assert.equal(hashState(base), hashState(renamed));
});

test('the selected config is not part of state identity', () => {
  const two = makeProject({ configs: [base.configs[0]!, base.configs[0]!] });
  const other = makeProject({ ...two, selected: 1 });
  assert.equal(hashState(two), hashState(other));
});

test('world settings ARE part of state identity', () => {
  // `world` is in the save file and changes the physics -- the boundary mode
  // alone decides how the trail field wraps.
  const bounced = editWorld(base, 'boundaryConditions', BC.BOUNCE);
  assert.notEqual(hashState(base), hashState(bounced));
});

test('a difference below float32 precision is the same state', () => {
  // The simulation runs on f32. Two doubles that round to the same float are
  // the same state to every particle, and filing them separately would invent
  // exploration that never happened.
  //
  // f32 has 24 bits of mantissa, so a step of 2^-30 at 1.0 is far below what it
  // can represent and `Math.fround` collapses it -- while f64 holds the two
  // apart, which is the whole point of the case.
  const nudged = editSelected(base, 'sensorGain', 1 + 2 ** -30);
  assert.notEqual(base.configs[0]!.sensorGain, nudged.configs[0]!.sensorGain);
  assert.equal(Math.fround(1 + 2 ** -30), Math.fround(1));
  assert.equal(hashState(base), hashState(nudged));
});

test('a difference visible in float32 is a different state', () => {
  assert.notEqual(hashState(base), hashState(at(2)));
});

// ---------------------------------------------------------------------------
// Deltas
// ---------------------------------------------------------------------------

test('a reroll is one field, with the drawn seed read out of the after-state', () => {
  // The RNG is called inside `settingsCommands.ts` and the value survives only
  // in the resulting project -- which is exactly why the delta is derived by
  // diffing rather than by intercepting the command.
  const after = editSelected(base, 'mutationSeed', 0.875);
  const delta = deriveDelta(base, after);
  assert.deepEqual(delta, {
    kind: 'configField',
    config: 0,
    field: 'mutationSeed',
    value: 0.875,
  });
});

test('a cohort selection stores the cohort, not the eighty floats', () => {
  // The adopted rule is a pure function of the parent state and the cohort
  // (`rule.wgsl`), so the number is sufficient and the rule is recomputed
  // offline. This is the second-commonest act, and the compression that matters.
  const adopted = editSelected(base, 'rule', new Array<number>(80).fill(0.5));
  const delta = deriveDelta(base, adopted, { kind: 'commitSelection', cohort: 3 });
  assert.deepEqual(delta, { kind: 'selection', config: 0, cohort: 3 });
});

test('an untagged rule change falls back to storing the rule', () => {
  // Without the cohort the rule is not derivable, and the 80 floats are the only
  // honest record. Bigger, and correct -- which is the trade this makes
  // everywhere it is unsure.
  const adopted = editSelected(base, 'rule', new Array<number>(80).fill(0.5));
  const delta = deriveDelta(base, adopted, null);
  assert.equal(delta.kind, 'rule');
});

test('randomize behavior is recognized as the sentinel plus a seed', () => {
  // `randomizeBehavior` zeroes the rule AND moves the seed as one act. The zeros
  // are a constant -- the "no target given" signal -- so only the seed is stored.
  const zeroed = editSelected(base, 'rule', new Array<number>(80).fill(0));
  const after = editSelected(zeroed, 'mutationSeed', 0.125);
  assert.deepEqual(deriveDelta(base, after), {
    kind: 'randomize',
    config: 0,
    seed: 0.125,
  });
});

test('a world edit is its own delta kind', () => {
  const after = editWorld(base, 'trailPersistence', 0.5);
  assert.deepEqual(deriveDelta(base, after), {
    kind: 'worldField',
    field: 'trailPersistence',
    value: 0.5,
  });
});

test('two fields moving at once falls back to the full state', () => {
  // No single field names the change, and a delta that described only half of it
  // would corrupt every descendant silently.
  const after = editSelected(editSelected(base, 'sensorGain', 2), 'drag', 0.9);
  assert.equal(deriveDelta(base, after).kind, 'full');
});

test('a config count change falls back to the full state', () => {
  const grown = makeProject({ configs: [base.configs[0]!, base.configs[0]!] });
  assert.equal(deriveDelta(base, grown).kind, 'full');
});

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

test('enabling on an unseen state files it as a root', async () => {
  const { store } = await enabled();
  assert.equal(store.nodes.length, 1);
  assert.equal(store.nodes[0]!.parent, null);
  assert.equal(store.roots.length, 1);
  assert.equal(store.roots[0]!.reason, 'logging-enabled');
});

test('enabling on a state already in the archive adds no root', async () => {
  // The case the dedup exists for: loading a preset you have been to before, or
  // one you saved, must not forge a second origin for it.
  const store = new FakeStore();
  store.seed = new Set([hashState(base)]);
  const archive = new ProjectArchive();
  await archive.enable(store, base);

  assert.equal(store.nodes.length, 0);
  assert.equal(store.roots.length, 0);
  assert.equal(archive.cursor, hashState(base));
});

test('a recorded act files a node parented on the state it came from', async () => {
  const { archive, store } = await enabled();
  archive.recordVisit(base, at(2), 'edit Gain');

  const node = store.find(at(2));
  assert.equal(node?.parent, hashState(base));
  assert.equal(node?.label, 'edit Gain');
  // Not a root: it has a parent to be reconstructed from.
  assert.equal(store.roots.length, 1);
});

test('revisiting a known state writes nothing and moves the cursor', async () => {
  const { archive, store } = await enabled();
  archive.recordVisit(base, at(2), 'edit Gain');
  const after = store.nodes.length;

  // Back and forward again by the same route.
  archive.moveCursor(base);
  archive.recordVisit(base, at(2), 'edit Gain');

  assert.equal(store.nodes.length, after);
  assert.equal(archive.cursor, hashState(at(2)));
});

test('undo then a new act makes the shared parent fork', async () => {
  // THE PROPERTY THE ARCHIVE EXISTS FOR. `History.record` truncates the
  // abandoned branch, so this fork is only visible to something watching the
  // cursor as it happens.
  const { archive, store } = await enabled();
  archive.recordVisit(base, at(2), 'to B');
  archive.recordVisit(at(2), at(3), 'to C');

  // Undo twice, back to the root.
  archive.moveCursor(at(2));
  archive.moveCursor(base);

  // A different act from there.
  archive.recordVisit(base, at(9), 'to D');

  const b = store.find(at(2));
  const d = store.find(at(9));
  assert.equal(b?.parent, hashState(base));
  assert.equal(d?.parent, hashState(base));
  // The abandoned branch is still on record -- that is the point of an archive
  // over a timeline.
  assert.notEqual(store.find(at(3)), undefined);
});

test('parentage is set by the FIRST visit and never revised', async () => {
  // Reaching a state a second time by a different route leaves its recorded
  // origin alone. "First visit defines parentage" is the whole model.
  const { archive, store } = await enabled();
  archive.recordVisit(base, at(2), 'to B');
  archive.recordVisit(at(2), at(5), 'to C');

  // Now reach at(5) again from a different parent.
  archive.moveCursor(base);
  archive.recordVisit(base, at(5), 'to C again');

  const nodes = store.nodes.filter((n) => n.hash === hashState(at(5)));
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]!.parent, hashState(at(2)));
});

test('a stale cursor defers to the before-state it is handed', async () => {
  // `History.record` re-seats its entry on `before` precisely because a preview
  // can move the project without recording, so `before` is authoritative about
  // what was departed from.
  const { archive, store } = await enabled();
  archive.recordVisit(at(7), at(8), 'edit Gain');

  const node = store.find(at(8));
  assert.equal(node?.parent, hashState(at(7)));
  // The unseen origin was adopted rather than left dangling.
  assert.notEqual(store.find(at(7)), undefined);
});

// ---------------------------------------------------------------------------
// Coalescing
//
// A drag calls `recordHistory` once per FRAME. Only `History.record` knows the
// fortieth call is still the first act, so the archive takes its verdict --
// without which a two-second slider sweep filed a hundred states while the undo
// menu showed the one entry it always did.
// ---------------------------------------------------------------------------

test('a coalesced drag leaves exactly one node: the value it settled on', async () => {
  const { archive, store } = await enabled();
  const rootNodes = store.nodes.length;

  // The gesture opens with an appended step, then extends.
  archive.recordVisit(base, at(2), 'edit Gain', null, 'appended');
  archive.recordVisit(at(2), at(3), 'edit Gain', null, 'coalesced');
  archive.recordVisit(at(3), at(4), 'edit Gain', null, 'coalesced');
  archive.recordVisit(at(4), at(5), 'edit Gain', null, 'coalesced');

  // ONE NODE PER COALESCED ACTION, exactly as the undo stack sees it. The values
  // swept past are not choices -- nobody decided on the number a slider was
  // passing through on its way somewhere else.
  assert.equal(store.nodes.length - rootNodes, 1);
  assert.equal(store.find(at(5))?.parent, hashState(base));
  for (const gain of [2, 3, 4]) {
    assert.equal(store.find(at(gain)), undefined, `gain ${gain} should be retired`);
  }
});

test('a retired state can be reached again later', async () => {
  // The dedup set has to forget a superseded hash along with the store. Leaving
  // it behind would make the archive believe that value is on record when it is
  // not, so arriving there deliberately would be read as a revisit and never
  // filed -- permanently unrecordable for the rest of the session.
  const { archive, store } = await enabled();
  archive.recordVisit(base, at(2), 'edit Gain', null, 'appended');
  archive.recordVisit(at(2), at(3), 'edit Gain', null, 'coalesced');
  assert.equal(store.find(at(2)), undefined);

  // Now arrive at gain 2 as a deliberate act of its own.
  archive.recordVisit(at(3), at(2), 'edit Gain', null, 'appended');
  assert.notEqual(store.find(at(2)), undefined);
});

test('a drag sweeping through an older state does not delete it', async () => {
  // That node belongs to whatever earlier act discovered it; this gesture has no
  // claim on it.
  const { archive, store } = await enabled();
  archive.recordVisit(base, at(4), 'earlier act', null, 'appended');
  archive.moveCursor(base);

  // A drag that passes across gain 4 on its way to 6.
  archive.recordVisit(base, at(3), 'edit Gain', null, 'appended');
  archive.recordVisit(at(3), at(4), 'edit Gain', null, 'coalesced');
  archive.recordVisit(at(4), at(6), 'edit Gain', null, 'coalesced');

  assert.notEqual(store.find(at(4)), undefined, 'the older node survives');
  assert.equal(store.find(at(6))?.parent, hashState(base));
});

test('a coalesced step derives its delta from the gesture origin', async () => {
  // A delta means "apply this to my parent". Deriving against the previous FRAME
  // while parenting on the gesture's start reconstructs to the wrong value --
  // silently, since both are edits to the same field.
  const { archive, store } = await enabled();
  archive.recordVisit(base, at(2), 'edit Gain', null, 'appended');
  archive.recordVisit(at(2), at(7), 'edit Gain', null, 'coalesced');

  const node = store.find(at(7));
  assert.deepEqual(node?.delta, {
    kind: 'configField',
    config: 0,
    field: 'sensorGain',
    value: 7,
  });
});

test('an appended step after a drag parents on where the drag ended', async () => {
  // The gesture is over; the next act continues from the value the user settled
  // on, which is what makes a drag read as one step in the graph.
  const { archive, store } = await enabled();
  archive.recordVisit(base, at(2), 'edit Gain', null, 'appended');
  archive.recordVisit(at(2), at(5), 'edit Gain', null, 'coalesced');
  archive.recordVisit(at(5), at(6), 'edit Angle', null, 'appended');

  assert.equal(store.find(at(6))?.parent, hashState(at(5)));
  // And the drag itself is still one node, so base -> 5 -> 6 is the whole chain.
  assert.equal(store.find(at(2)), undefined);
});

test('dragging back to the start files nothing new', async () => {
  // Constant in practice: a slider swept out and back. The state is already
  // known, so it is a revisit and the cursor simply follows.
  const { archive, store } = await enabled();
  archive.recordVisit(base, at(2), 'edit Gain', null, 'appended');
  const after = store.nodes.length;
  archive.recordVisit(at(2), base, 'edit Gain', null, 'coalesced');

  assert.equal(store.nodes.length, after);
  assert.equal(archive.cursor, hashState(base));
});

test('undo ends a gesture, so a later drag cannot parent onto it', async () => {
  // Mirrors the `breakCoalescing` undo already calls on the timeline. Here the
  // consequence would be worse than a rewritten label: the gesture's origin
  // names a state the user has left.
  const { archive, store } = await enabled();
  archive.recordVisit(base, at(2), 'edit Gain', null, 'appended');
  archive.moveCursor(base);

  // A `coalesced` outcome arriving after the jump must not reach back to the
  // abandoned gesture; it starts fresh from the cursor.
  archive.recordVisit(base, at(8), 'edit Gain', null, 'coalesced');
  assert.equal(store.find(at(8))?.parent, hashState(base));
});

test('a disabled archive records nothing', async () => {
  const { archive, store } = await enabled();
  const before = store.nodes.length;
  archive.disable();
  archive.recordVisit(base, at(2), 'edit Gain');
  assert.equal(store.nodes.length, before);
});

test('a rename produces no node', async () => {
  // Not a state change: `name` is excluded from identity, so there is nothing
  // to file even though `recordHistory` would fire.
  const { archive, store } = await enabled();
  const before = store.nodes.length;
  archive.recordVisit(base, makeProject({ ...base, name: 'renamed' }), 'rename');
  assert.equal(store.nodes.length, before);
});

// =============================================================================
// THE VISIT LOG
//
// The node tree's tests above assert what is DISCOVERED. These assert what was
// DONE -- the revisits, undos and repeats the tree deliberately does not hold.
// The two datasets are written by the same calls, so several of these are
// deliberately paired with a node-count assertion: the point is not merely that
// the log records something, but that it records it WITHOUT the tree changing.
// =============================================================================

test('a revisit adds no node but does add a visit', async () => {
  const { archive, store } = await enabled();
  archive.recordVisit(base, at(2), 'to B');
  const nodes = store.nodes.length;
  const visits = store.visits.length;

  // Back to base, then forward to the same state by the same route.
  archive.moveCursor(base);
  archive.recordVisit(base, at(2), 'to B again');

  assert.equal(store.nodes.length, nodes, 'no new node for a known state');
  // Two entries: the undo-style cursor move, and the act that re-reached B.
  assert.equal(store.visits.length, visits + 2);

  const last = store.projectVisits().at(-1);
  assert.equal(last?.hash, hashState(at(2)));
  assert.equal(last?.repeat, true, 'the second arrival is marked a repeat');
  assert.equal(last?.from, hashState(base));
});

test('the first visit to a state is not marked a repeat', async () => {
  const { archive, store } = await enabled();
  archive.recordVisit(base, at(2), 'to B');
  // Guards the ordering trap: `repeat` is read off the dedup set, so logging
  // after the commit rather than before would mark every first visit true.
  assert.equal(store.projectVisits().at(-1)?.repeat, false);
});

test('undo and redo are logged with their direction, and add no nodes', async () => {
  const { archive, store } = await enabled();
  archive.recordVisit(base, at(2), 'to B');
  archive.recordVisit(at(2), at(3), 'to C');
  const nodes = store.nodes.length;

  archive.moveCursor(at(2), 'undo');
  archive.moveCursor(base, 'undo');
  archive.moveCursor(at(2), 'redo');

  assert.equal(store.nodes.length, nodes, 'traversal writes no nodes');
  const kinds = store.projectVisits().slice(-3).map((v) => v.kind);
  assert.deepEqual(kinds, ['undo', 'undo', 'redo']);
});

test('backing up and branching records the whole path, not just the fork', async () => {
  // THE CASE THE VISIT LOG EXISTS FOR. The node tree shows base with two
  // children and no indication that reaching the second took two steps back;
  // the log shows the retreat.
  const { archive, store } = await enabled();
  archive.recordVisit(base, at(2), 'to B');
  archive.recordVisit(at(2), at(3), 'to C');
  archive.moveCursor(at(2), 'undo');
  archive.moveCursor(base, 'undo');
  archive.recordVisit(base, at(9), 'to D');

  const path = store.projectVisits().map((v) => `${v.kind}:${v.hash.slice(0, 4)}`);
  assert.deepEqual(path, [
    `enter:${hashState(base).slice(0, 4)}`,
    `act:${hashState(at(2)).slice(0, 4)}`,
    `act:${hashState(at(3)).slice(0, 4)}`,
    `undo:${hashState(at(2)).slice(0, 4)}`,
    `undo:${hashState(base).slice(0, 4)}`,
    `act:${hashState(at(9)).slice(0, 4)}`,
  ]);
  // And the fork is still in the tree exactly as it was before the log existed.
  assert.equal(store.find(at(2))?.parent, hashState(base));
  assert.equal(store.find(at(9))?.parent, hashState(base));
});

test('a drag is ONE visit, at the value it settled on', async () => {
  // The log is exactly as strict as the timeline and the node tree: a gesture
  // is one entry, rewritten in place, not one per frame.
  const { archive, store } = await enabled();
  const before = store.visits.length;

  archive.recordVisit(base, at(2), 'edit Gain', null, 'appended');
  archive.recordVisit(at(2), at(3), 'edit Gain', null, 'coalesced');
  archive.recordVisit(at(3), at(4), 'edit Gain', null, 'coalesced');
  archive.recordVisit(at(4), at(5), 'edit Gain', null, 'coalesced');

  assert.equal(store.visits.length, before + 1, 'one entry for the whole sweep');
  const last = store.projectVisits().at(-1);
  assert.equal(last?.hash, hashState(at(5)), 'holding the settled value');
  assert.equal(last?.from, hashState(base), 'parented where the hand began');
});

test('a drag that starts on a known value is still one visit', async () => {
  // The regression this guards: a first frame landing on a known state used to
  // leave no gesture set up, so every later frame took the append path and the
  // log grew per frame while the node tree stayed correct.
  const { archive, store } = await enabled();
  archive.recordVisit(base, at(2), 'seed', null, 'appended');
  archive.moveCursor(base);
  const before = store.visits.length;

  archive.recordVisit(base, at(2), 'edit Gain', null, 'appended');
  archive.recordVisit(at(2), at(3), 'edit Gain', null, 'coalesced');
  archive.recordVisit(at(3), at(4), 'edit Gain', null, 'coalesced');

  assert.equal(store.visits.length, before + 1);
  assert.equal(store.projectVisits().at(-1)?.hash, hashState(at(4)));
});

test('a new session continues the sequence rather than restarting it', async () => {
  // A per-session counter would collide with the previous session's ordinals,
  // and since visits are added strictly the collision loses events silently.
  const store = new FakeStore();
  store.seedSeq = 41;
  const archive = new ProjectArchive(() => 1000);
  await archive.enable(store, base);
  archive.recordVisit(base, at(2), 'edit Gain');

  assert.deepEqual(store.visits.map((v) => v.seq), [42, 43]);
});

test('preferences and commands are logged, and are not project states', async () => {
  const { archive, store } = await enabled();
  const nodes = store.nodes.length;

  archive.recordPreference('brightness', 3.0, 2.0, 'set brightness');
  archive.recordCommand('reset', 'reset simulation');

  assert.equal(store.nodes.length, nodes, 'neither is a project state');
  const [pref, cmd] = store.visits.slice(-2).map((v) => v.visit);
  assert.deepEqual(pref, {
    type: 'preference',
    field: 'brightness',
    value: 3.0,
    previous: 2.0,
    label: 'set brightness',
  });
  assert.deepEqual(cmd, { type: 'command', command: 'reset', label: 'reset simulation' });
});

test('a disabled archive logs nothing at all', async () => {
  const { archive, store } = await enabled();
  archive.disable();
  const visits = store.visits.length;

  archive.recordVisit(base, at(2), 'edit Gain');
  archive.recordPreference('brightness', 3.0, 2.0, 'set brightness');
  archive.recordCommand('reset', 'reset simulation');
  archive.moveCursor(base, 'undo');

  assert.equal(store.visits.length, visits, 'every path checks the gate');
});

test('every visit carries the session that produced it', async () => {
  const { archive, store } = await enabled();
  archive.recordVisit(base, at(2), 'edit Gain');
  const sessions = new Set(store.visits.map((v) => v.session));
  assert.equal(sessions.size, 1);
  assert.notEqual([...sessions][0], '');
});
