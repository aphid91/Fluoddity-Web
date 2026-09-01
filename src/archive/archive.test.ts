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
  seed: Set<string> = new Set();

  put(node: ArchiveNode, root: ArchiveRoot | null): Promise<void> {
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
  /** The node filed for `project`, or undefined. */
  find(project: Project): ArchiveNode | undefined {
    const hash = hashState(project);
    return this.nodes.find((n) => n.hash === hash);
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
