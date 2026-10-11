/**
 * Setting edits and the behaviour commands, NCA edition. The interesting case
 * is architecture: an edit to a layout field must carry the weights across
 * (`withArchEdit`), never leave them the wrong length.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applySettingEdit,
  randomizeBehavior,
  randomizeSeed,
  rerollIsNoOp,
  selectionIsNoOp,
  setPopulationLayout,
  weightsAreGenerated,
} from './settingsCommands.ts';
import { makeProject, selectedConfig } from '../project/project.ts';
import { DEFAULT_PREFERENCES } from '../prefs/preferences.ts';
import { makeNcaConfig } from '../nca/ncaConfig.ts';
import { paramCount } from '../nca/paramLayout.ts';
import { initWeights, toStored } from '../nca/weights.ts';
import { CONFIG, PREFS, WORLD, settingFor } from '../ui/settingsSpec.ts';

const ARCH = { channels: 4, hidden: 4, perception: 0, learnedKernels: 1, laplacian: false };
const concrete = makeNcaConfig({ ...ARCH, weights: toStored(initWeights(ARCH, 7)) });
const project = makeProject({ configs: [concrete] });
const sources = { project, prefs: DEFAULT_PREFERENCES };

function edit(source: typeof CONFIG | typeof WORLD | typeof PREFS, field: string, value: number | boolean) {
  const setting = settingFor(source, field);
  assert.ok(setting, `${source}.${field} is registered`);
  return applySettingEdit(sources, setting, value);
}

test('a config edit lands on the selected config', () => {
  const r = edit(CONFIG, 'dt', 0.25);
  assert.equal(r.kind, 'project');
  if (r.kind === 'project') assert.equal(selectedConfig(r.project).dt, 0.25);
});

test('a world edit lands on the world; a prefs edit on the preferences', () => {
  const r = edit(WORLD, 'displayGain', 2);
  if (r.kind === 'project') assert.equal(r.project.world.displayGain, 2);
  else assert.fail('expected a project');
  const q = edit(PREFS, 'physicsSteps', 9);
  if (q.kind === 'prefs') assert.equal(q.prefs.physicsSteps, 9);
  else assert.fail('expected prefs');
});

test('growing an architecture field re-embeds the weights at the new length', () => {
  const r = edit(CONFIG, 'channels', 7);
  if (r.kind !== 'project') return assert.fail();
  const c = selectedConfig(r.project);
  assert.equal(c.channels, 7);
  assert.equal(c.weights?.length, paramCount(c));
  const h = edit(CONFIG, 'hidden', 9);
  if (h.kind !== 'project') return assert.fail();
  assert.equal(selectedConfig(h.project).weights?.length, paramCount(selectedConfig(h.project)));
});

test('architecture values are rounded and clamped, and a same-value edit is a no-op', () => {
  const r = edit(CONFIG, 'channels', 99.4);
  if (r.kind === 'project') assert.equal(selectedConfig(r.project).channels, 32);
  const same = edit(CONFIG, 'channels', 4);
  if (same.kind === 'project') assert.equal(same.project, project, 'receiver unchanged');
});

test('hidden 0 <-> >0 has no embedding: the network becomes generated', () => {
  const r = edit(CONFIG, 'hidden', 0);
  if (r.kind === 'project') assert.equal(selectedConfig(r.project).weights, null);
});

test('randomizeSeed moves only the mutation seed', () => {
  const p = randomizeSeed(project, () => 0.123)!;
  assert.equal(selectedConfig(p).mutationSeed, 0.123);
  assert.equal(selectedConfig(p).weights, concrete.weights);
});

test('randomizeBehavior drops the base network and reseeds', () => {
  const p = randomizeBehavior(project, () => 0.5);
  assert.equal(selectedConfig(p).weights, null);
  assert.equal(weightsAreGenerated(p), true);
  assert.equal(selectedConfig(p).mutationSeed, 0.5);
});

test('setPopulationLayout clamps the cohort count', () => {
  assert.equal(selectedConfig(setPopulationLayout(project, 9)).cohorts, 9);
  assert.equal(selectedConfig(setPopulationLayout(project, 500)).cohorts, 64);
});

test('the no-op predicates', () => {
  const zero = makeProject({ configs: [{ ...concrete, mutationScale: 0 }] });
  assert.equal(selectionIsNoOp(zero), true, 'scale 0: every cohort is the base');
  assert.equal(rerollIsNoOp(zero), true);
  assert.equal(selectionIsNoOp(project), false);
  assert.equal(rerollIsNoOp(project), false);
  const generated = randomizeBehavior(zero);
  assert.equal(selectionIsNoOp(generated), false, 'generated cohorts always differ');
  assert.equal(rerollIsNoOp(generated), true, 'F only rerolls mutations');
});
