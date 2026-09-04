/**
 * Rebuilding project states from an archive.
 *
 * ## What is worth testing here
 *
 * The property that matters is a ROUND TRIP: a state recorded by `deriveDelta`
 * and rebuilt by `reconstruct` must be the state that went in. Everything below
 * is a case of that, driven through the real `ProjectArchive` rather than
 * hand-built nodes -- a test that constructed its own deltas would pass while the
 * recorder and the rebuilder disagreed, which is the one failure this file exists
 * to catch.
 *
 * The failure modes are all silent. A delta applied to the wrong slot, a world
 * field dropped, a lineage walked in the wrong direction: each produces a
 * plausible project that is simply not the one the user had. So the assertions
 * compare whole states through the content hash, which is the same identity the
 * archive itself uses.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ProjectArchive, type ArchiveStore } from './archive.ts';
import { hashState } from './hash.ts';
import { latestNode, loadArchive, reconstruct, replaySession } from './reconstruct.ts';
import type { ArchiveNode, ArchiveRoot } from './archiveDb.ts';
import type { VisitRecord } from './visits.ts';
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

const at = (gain: number): Project => editSelected(base, 'sensorGain', gain);

/** Collects what the archive writes, and hands it back as an export document. */
class CaptureStore implements ArchiveStore {
  readonly nodes: ArchiveNode[] = [];
  readonly roots: ArchiveRoot[] = [];
  readonly visits: VisitRecord[] = [];

  put(node: ArchiveNode, root: ArchiveRoot | null, supersedes?: string | null): Promise<void> {
    if (supersedes !== undefined && supersedes !== null) {
      const at = this.nodes.findIndex((n) => n.hash === supersedes);
      if (at >= 0) this.nodes.splice(at, 1);
    }
    this.nodes.push(node);
    if (root !== null) this.roots.push(root);
    return Promise.resolve();
  }
  known(): Promise<Set<string>> {
    return Promise.resolve(new Set());
  }
  count(): Promise<number> {
    return Promise.resolve(this.nodes.length);
  }
  putVisit(record: VisitRecord, overwrite: boolean): Promise<void> {
    const at = this.visits.findIndex((v) => v.seq === record.seq);
    if (at >= 0 && overwrite) this.visits[at] = record;
    else if (at < 0) this.visits.push(record);
    return Promise.resolve();
  }
  lastSeq(): Promise<number> {
    return Promise.resolve(-1);
  }
  /** The shape `export.ts` writes, so the tests exercise the real document. */
  document(): unknown {
    return { version: 1, nodes: this.nodes, roots: this.roots, visits: this.visits };
  }
}

async function recorder(start: Project = base) {
  const store = new CaptureStore();
  let clock = 1000;
  const archive = new ProjectArchive(() => (clock += 1000));
  await archive.enable(store, start);
  return { archive, store };
}

/** Rebuild `project`'s node and assert it comes back identical. */
function assertRoundTrip(store: CaptureStore, project: Project): void {
  const archive = loadArchive(store.document());
  const result = reconstruct(archive, hashState(project));
  assert.equal(result.ok, true, `reconstruction failed for ${hashState(project)}`);
  if (!result.ok) return;
  // Compared by CONTENT HASH, which is the archive's own identity -- so this
  // asserts the rebuilt state is the same state, not merely a similar-looking one.
  assert.equal(hashState(result.project), hashState(project));
}

// ---------------------------------------------------------------------------
// Round trips, one per delta kind
// ---------------------------------------------------------------------------

test('a root rebuilds to itself', async () => {
  const { store } = await recorder();
  assertRoundTrip(store, base);
});

test('a scalar edit rebuilds', async () => {
  const { archive, store } = await recorder();
  archive.recordVisit(base, at(2), 'edit Gain');
  assertRoundTrip(store, at(2));
});

test('a reroll rebuilds, seed and all', async () => {
  const { archive, store } = await recorder();
  const rerolled = editSelected(base, 'mutationSeed', 0.8125);
  archive.recordVisit(base, rerolled, 'reroll mutations');
  assertRoundTrip(store, rerolled);
});

test('a world edit rebuilds', async () => {
  const { archive, store } = await recorder();
  const bounced = editWorld(base, 'boundaryConditions', BC.BOUNCE);
  archive.recordVisit(base, bounced, 'edit Boundary');
  assertRoundTrip(store, bounced);
});

test('randomize behavior rebuilds to the zero sentinel and the new seed', async () => {
  // The zeros are the STORED value, not a stand-in: the shader reads them as
  // "generate a rule from the seed". So no deriver is needed to rebuild the
  // project, and the project genuinely holds zeros.
  const { archive, store } = await recorder();
  const zeroed = editSelected(base, 'rule', new Array<number>(80).fill(0));
  const after = editSelected(zeroed, 'mutationSeed', 0.125);
  archive.recordVisit(base, after, 'randomize behavior');
  assertRoundTrip(store, after);
});

test('an untagged rule change rebuilds from its stored floats', async () => {
  const { archive, store } = await recorder();
  const adopted = editSelected(base, 'rule', new Array<number>(80).fill(0.5));
  archive.recordVisit(base, adopted, 'adopt rule', null);
  assertRoundTrip(store, adopted);
});

test('a multi-field change rebuilds through the full fallback', async () => {
  const { archive, store } = await recorder();
  const both = editSelected(editSelected(base, 'sensorGain', 2), 'drag', 0.9);
  archive.recordVisit(base, both, 'edit two');
  assertRoundTrip(store, both);
});

test('a long chain rebuilds at every step', async () => {
  const { archive, store } = await recorder();
  let previous = base;
  for (let i = 1; i <= 12; i++) {
    const next = editSelected(previous, 'sensorGain', i);
    archive.recordVisit(previous, next, `edit Gain ${i}`);
    previous = next;
  }
  const doc = loadArchive(store.document());
  for (let i = 1; i <= 12; i++) {
    const state = editSelected(base, 'sensorGain', i);
    const built = reconstruct(doc, hashState(state));
    assert.equal(built.ok, true, `step ${i} failed`);
    if (built.ok) assert.equal(hashState(built.project), hashState(state));
  }
});

test('a branch rebuilds both sides independently', async () => {
  // The case the graph exists for: undo, then a different act. Each side must
  // rebuild through its OWN lineage.
  const { archive, store } = await recorder();
  archive.recordVisit(base, at(2), 'to B');
  archive.moveCursor(base);
  archive.recordVisit(base, at(9), 'to D');

  assertRoundTrip(store, at(2));
  assertRoundTrip(store, at(9));
});

// ---------------------------------------------------------------------------
// The deriver seam
// ---------------------------------------------------------------------------

test('a selection needs a deriver, and says so rather than guessing', async () => {
  // The rule is a pure function of the parent state and the cohort, but only the
  // real shader computes it correctly -- so the honest answer is to report it.
  const { archive, store } = await recorder();
  const adopted = editSelected(base, 'rule', new Array<number>(80).fill(0.75));
  archive.recordVisit(base, adopted, 'select cohort 3', {
    kind: 'commitSelection',
    cohort: 3,
  });

  const doc = loadArchive(store.document());
  const result = reconstruct(doc, hashState(adopted), null);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.failure.kind, 'needsDeriver');
    if (result.failure.kind === 'needsDeriver') {
      assert.equal(result.failure.cohort, 3);
    }
  }
});

test('a supplied deriver is given the parent rule, seed, scale and cohort', async () => {
  const { archive, store } = await recorder();
  const adopted = editSelected(base, 'rule', new Array<number>(80).fill(0.75));
  archive.recordVisit(base, adopted, 'select cohort 3', {
    kind: 'commitSelection',
    cohort: 3,
  });

  const doc = loadArchive(store.document());
  let seen: unknown = null;
  const result = reconstruct(doc, hashState(adopted), (input) => {
    seen = input;
    return new Array<number>(80).fill(0.75);
  });

  assert.equal(result.ok, true);
  assert.deepEqual(seen, {
    // The PARENT's values -- the exact inputs `derive_entity_rule` takes.
    rule: base.configs[0]!.rule,
    cohort: 3,
    mutationSeed: 0.5,
    mutationScale: 0.25,
  });
  if (result.ok) assert.equal(hashState(result.project), hashState(adopted));
});

// ---------------------------------------------------------------------------
// Document handling
// ---------------------------------------------------------------------------

test('the newest node is the one the export ended on', async () => {
  const { archive, store } = await recorder();
  archive.recordVisit(base, at(2), 'first');
  archive.recordVisit(at(2), at(3), 'second');
  archive.recordVisit(at(3), at(4), 'last');

  const doc = loadArchive(store.document());
  assert.equal(latestNode(doc)?.hash, hashState(at(4)));
});

test('an unknown hash is reported, not thrown', async () => {
  const { store } = await recorder();
  const doc = loadArchive(store.document());
  const result = reconstruct(doc, 'ffffffffffffffffffffffffffffffff');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failure.kind, 'unknownNode');
});

test('a broken lineage names the ancestor that is missing, not the target', async () => {
  // What a truncated or hand-edited export looks like. The TARGET is present and
  // fine; it is its parent that is gone, and saying "unknown node <target>"
  // would send someone looking at the one node that is not the problem.
  const { archive, store } = await recorder();
  archive.recordVisit(base, at(2), 'edit Gain');
  const doc = store.document() as { nodes: ArchiveNode[]; roots: ArchiveRoot[] };
  doc.nodes = doc.nodes.filter((n) => n.parent !== null);

  const loaded = loadArchive(doc);
  const result = reconstruct(loaded, hashState(at(2)));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.failure.kind, 'brokenLineage');
    if (result.failure.kind === 'brokenLineage') {
      assert.equal(result.failure.hash, hashState(at(2)));
      assert.equal(result.failure.parent, hashState(base));
    }
  }
});

test('a node whose own hash is absent is reported as unknown', async () => {
  const { store } = await recorder();
  const loaded = loadArchive(store.document());
  const result = reconstruct(loaded, 'ffffffffffffffffffffffffffffffff');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failure.kind, 'unknownNode');
});

test('a document without nodes is rejected with a useful message', () => {
  assert.throws(() => loadArchive({ roots: [] }), /nodes/);
  assert.throws(() => loadArchive(null), /not an object/);
});

// =============================================================================
// REPLAY
//
// `reconstructAll` answers "what states exist". These assert the question only
// the visit log can answer: what happened, in what order, including the arrivals
// that added no state.
// =============================================================================

test('a session replays in order, revisits and all', async () => {
  const { archive, store } = await recorder();
  archive.recordVisit(base, at(2), 'to B');
  archive.recordVisit(at(2), at(3), 'to C');
  archive.moveCursor(at(2), 'undo');
  archive.moveCursor(base, 'undo');
  archive.recordVisit(base, at(9), 'to D');

  const steps = replaySession(loadArchive(store.document()));

  // Six steps for five acts plus the session root -- where the node tree holds
  // only four states, because the two undos discovered nothing.
  assert.equal(steps.length, 6);
  assert.deepEqual(
    steps.map((s) => (s.record.visit.type === 'project' ? s.record.visit.kind : '?')),
    ['enter', 'act', 'act', 'undo', 'undo', 'act'],
  );
  // Every step rebuilt to a real state, including the ones that added no node.
  assert.ok(steps.every((s) => s.project !== null && s.failure === null));
  // And the states are the ones actually visited, in the order visited.
  assert.deepEqual(
    steps.map((s) => s.project!.configs[0]!.sensorGain),
    [1, 2, 3, 2, 1, 9],
  );
});

test('a replayed revisit rebuilds the same state as its first visit', async () => {
  const { archive, store } = await recorder();
  archive.recordVisit(base, at(2), 'to B');
  archive.moveCursor(base, 'undo');
  archive.recordVisit(base, at(2), 'to B again');

  const steps = replaySession(loadArchive(store.document()));
  const gains = steps.map((s) => s.project?.configs[0]?.sensorGain);
  assert.deepEqual(gains, [1, 2, 1, 2]);
});

test('preference and command steps replay in order, with no state', async () => {
  const { archive, store } = await recorder();
  archive.recordVisit(base, at(2), 'to B');
  archive.recordPreference('brightness', 3.0, 2.0, 'set brightness');
  archive.recordCommand('reset', 'reset simulation');
  archive.recordVisit(at(2), at(3), 'to C');

  const steps = replaySession(loadArchive(store.document()));
  assert.deepEqual(steps.map((s) => s.record.visit.type), [
    'project',
    'project',
    'preference',
    'command',
    'project',
  ]);
  // The two non-project steps hold no state, and that is not a failure.
  assert.equal(steps[2]!.project, null);
  assert.equal(steps[2]!.failure, null);
  assert.equal(steps[3]!.project, null);
});

test('a document with no visit log replays as empty rather than throwing', async () => {
  // What a pre-log export looks like. The node tree is intact and
  // `reconstructAll` still reads it; there is simply no path to replay.
  const { archive, store } = await recorder();
  archive.recordVisit(base, at(2), 'to B');
  const doc = store.document() as Record<string, unknown>;
  delete doc['visits'];

  const loaded = loadArchive(doc);
  assert.deepEqual(loaded.visits, []);
  assert.deepEqual(replaySession(loaded), []);
  assert.ok(loaded.nodes.size > 0, 'the states are all still there');
});
