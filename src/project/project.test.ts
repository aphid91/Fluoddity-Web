/**
 * Project: the invariants, reference identity on no-op edits (what history's
 * `before !== after` guard relies on), and the two "what changed" questions
 * undo/redo asks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  adoptWeights,
  editSelected,
  editWorld,
  edited,
  layoutChanged,
  makeProject,
  ruleChanged,
  selectedConfig,
  withConfigs,
} from './project.ts';
import { makeNcaConfig, makeNcaWorld, NCA_WORLD_DEFAULTS } from '../nca/ncaConfig.ts';

const a = makeNcaConfig({ cohorts: 4 });
const b = makeNcaConfig({ cohorts: 9, mutationSeed: 0.2 });

test('a project cannot be built with no configs', () => {
  assert.throws(() => makeProject({ configs: [] }));
});

test('selected is clamped into range at construction', () => {
  assert.equal(makeProject({ configs: [a, b], selected: 5 }).selected, 1);
  assert.equal(makeProject({ configs: [a, b], selected: -3 }).selected, 0);
});

test('defaults: an NCA world and an untitled name', () => {
  const p = makeProject({ configs: [a] });
  assert.deepEqual(p.world, NCA_WORLD_DEFAULTS);
  assert.equal(p.name, 'Untitled');
});

test('selectedConfig follows the selection', () => {
  assert.equal(selectedConfig(makeProject({ configs: [a, b], selected: 1 })), b);
});

test('a real edit returns a new project; a no-op returns the receiver', () => {
  const p = makeProject({ configs: [a] });
  const q = editSelected(p, 'dt', 0.9);
  assert.notEqual(p, q);
  assert.equal(selectedConfig(q).dt, 0.9);
  assert.equal(edited(p, 3, 'dt', 0.9), p, 'out-of-range index');
  assert.equal(editSelected(p, 'nonsense' as never, 1 as never), p, 'unknown field');
  assert.equal(editWorld(p, 'nonsense' as never, 1 as never), p, 'unknown world field');
});

test('editWorld edits the world', () => {
  const p = editWorld(makeProject({ configs: [a] }), 'displayGain', 3);
  assert.equal(p.world.displayGain, 3);
});

test('adoptWeights changes only the weights, and copies them', () => {
  const p = makeProject({ configs: [a] });
  const w = [1, 2, 3];
  const q = adoptWeights(p, w);
  assert.deepEqual(selectedConfig(q).weights, [1, 2, 3]);
  w[0] = 99;
  assert.equal(selectedConfig(q).weights![0], 1, 'not aliased');
  assert.equal(selectedConfig(q).mutationScale, a.mutationScale);
  assert.equal(selectedConfig(q).mutationSeed, a.mutationSeed);
});

test('withConfigs re-clamps the selection and keeps name/world unless given', () => {
  const p = makeProject({ configs: [a, b], selected: 1, name: 'x' });
  const q = withConfigs(p, [a]);
  assert.equal(q.selected, 0);
  assert.equal(q.name, 'x');
  const world = makeNcaWorld({ displayGain: 2 });
  assert.equal(withConfigs(p, [a], { world, name: 'y' }).name, 'y');
});

test('ruleChanged: weights and seed count; other edits and selection do not', () => {
  const p = makeProject({ configs: [a, b] });
  assert.equal(ruleChanged(p, p), false);
  assert.equal(ruleChanged(p, adoptWeights(p, [1])), true);
  assert.equal(ruleChanged(p, editSelected(p, 'mutationSeed', 0.77)), true);
  assert.equal(ruleChanged(p, editSelected(p, 'dt', 0.1)), false);
  assert.equal(ruleChanged(p, makeProject({ ...p, selected: 1 })), false);
  // An unselected slot, and a different count.
  assert.equal(ruleChanged(p, edited(p, 1, 'weights', [5])), true);
  assert.equal(ruleChanged(p, withConfigs(p, [a])), true);
});

test('ruleChanged compares weights by VALUE', () => {
  const p = adoptWeights(makeProject({ configs: [a] }), [1, 2]);
  assert.equal(ruleChanged(p, adoptWeights(p, [1, 2])), false);
  assert.equal(ruleChanged(p, adoptWeights(p, [1, 3])), true);
  assert.equal(ruleChanged(p, editSelected(p, 'weights', null)), true);
});

test('layoutChanged: cohorts, initial conditions and channels', () => {
  const p = makeProject({ configs: [a] });
  assert.equal(layoutChanged(p, p), false);
  assert.equal(layoutChanged(p, editSelected(p, 'cohorts', 16)), true);
  assert.equal(layoutChanged(p, editSelected(p, 'initialConditions', 1)), true);
  assert.equal(layoutChanged(p, editSelected(p, 'channels', 12)), true);
  assert.equal(layoutChanged(p, editSelected(p, 'hidden', 7)), false);
  assert.equal(layoutChanged(p, editSelected(p, 'gain', 2)), false);
});
