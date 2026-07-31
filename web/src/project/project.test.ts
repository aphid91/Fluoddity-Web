/**
 * `Project`'s invariants, and the reference identity everything downstream
 * depends on.
 *
 * ## Why this test carries more weight than it looks
 *
 * `_record_history` guards on `before is not self.project` -- REFERENCE
 * IDENTITY (`selection_commands.py:198`), ported as `!==`. That means every
 * mutator here has a contract with the history stack that is invisible in its
 * signature:
 *
 *   - a real edit MUST return a new object, or the edit is never recorded
 *   - a no-op MUST return the receiver, or every no-op records an empty entry
 *
 * Neither direction is checkable by the compiler and both fail SILENTLY: the
 * first as "undo skips some edits", the second as "undo does nothing several
 * times in a row". `settingsSpec.test.ts` covers the other half -- that the
 * fields these are called with exist at all.
 *
 * The desktop has no equivalent test. Python's `dataclasses.replace` always
 * builds a new object, so the second direction cannot go wrong there;
 * TypeScript's spread has to be written correctly at each site.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  type Project,
  UNTITLED,
  adoptRule,
  configCount,
  editSelected,
  editWorld,
  edited,
  makeProject,
  renamed,
  selectedConfig,
  withConfigs,
} from './project.ts';
import {
  type SimulationConfig,
  BC,
  makeSimulationConfig,
  makeWorldSettings,
} from '../particleSystem/config.ts';

/** A config distinguishable from its neighbours by `sensorGain`. */
function config(sensorGain: number): SimulationConfig {
  return makeSimulationConfig(
    {
      cohorts: 1,
      mutationSeed: 0.5,
      sensorGain,
      sensorAngle: 0.25,
      sensorDistance: 1.0,
      mutationScale: 0.0,
      globalForceMult: 1.0,
      drag: 0.5,
      strafePower: 0.0,
      axialForce: 1.0,
      lateralForce: 1.0,
      hazardRate: 0.0,
    },
    { rule: new Array<number>(80).fill(0.25) },
  );
}

function project(count = 1, selected = 0): Project {
  return makeProject({
    configs: Array.from({ length: count }, (_, i) => config(i)),
    selected,
  });
}

// ---------------------------------------------------------------------------
// The two construction invariants
// ---------------------------------------------------------------------------

test('a project cannot be built with no configs', () => {
  // Throws rather than substituting a default: there is no sensible config to
  // invent, and a project with none is a bug upstream (`project.py:62-63`).
  assert.throws(() => makeProject({ configs: [] }), /at least one config/);
});

test('selected is clamped into range at construction', () => {
  // The invariant that used to be a hand-written line at seventeen call sites,
  // and whose omission gives an index past the end of the buffer.
  assert.equal(makeProject({ configs: [config(0)], selected: 7 }).selected, 0);
  assert.equal(makeProject({ configs: [config(0)], selected: -3 }).selected, 0);
  assert.equal(project(4, 2).selected, 2);
});

test('defaults match the Python dataclass', () => {
  const p = makeProject({ configs: [config(0)] });
  assert.equal(p.name, UNTITLED);
  assert.equal(p.selected, 0);
  assert.equal(p.world.boundaryConditions, BC.WRAP);
});

test('selectedConfig follows the selection', () => {
  assert.equal(selectedConfig(project(3, 2)).sensorGain, 2);
  assert.equal(configCount(project(3)), 3);
});

// ---------------------------------------------------------------------------
// Reference identity: a real edit returns a NEW object
// ---------------------------------------------------------------------------

test('a real edit returns a new project', () => {
  const before = project();
  const after = editSelected(before, 'sensorGain', 9);
  assert.notEqual(after, before, 'an edit that changes a value must not return the receiver');
  assert.equal(selectedConfig(after).sensorGain, 9);
  // The original is untouched -- which is what makes a history snapshot a
  // pointer rather than a copy.
  assert.equal(selectedConfig(before).sensorGain, 0);
});

test('editWorld edits the world, not config 0', () => {
  // The specific bug `project.py:125-134` records: world settings were once "a
  // disguised edit of config 0", which silently ignored slots 1+.
  const before = project(2);
  const after = editWorld(before, 'trailPersistence', 0.5);
  assert.equal(after.world.trailPersistence, 0.5);
  assert.deepEqual(after.configs, before.configs);
});

test('adoptRule changes only the rule', () => {
  // mutationScale is deliberately left alone, so the population re-mutates
  // around the adopted rule rather than locking to it -- and undo has exactly
  // one field to restore (`project.py:113-123`).
  const before = editSelected(project(), 'mutationScale', 0.4);
  const rule = new Array<number>(80).fill(0.75);
  const after = adoptRule(before, rule);
  assert.deepEqual([...selectedConfig(after).rule], rule);
  assert.equal(selectedConfig(after).mutationScale, 0.4);
});

test('adoptRule copies the rule rather than aliasing it', () => {
  // The caller's array is a decoded GPU readback buffer that gets reused. An
  // alias would let the NEXT pick silently rewrite this project's rule -- and
  // it would still be `===` to itself, so history would show nothing wrong.
  const rule = new Array<number>(80).fill(0.75);
  const after = adoptRule(project(), rule);
  rule[0] = 999;
  assert.equal(selectedConfig(after).rule[0], 0.75);
});

// ---------------------------------------------------------------------------
// Reference identity: a no-op returns the RECEIVER
// ---------------------------------------------------------------------------

test('editing an unknown field returns the receiver unchanged', () => {
  const before = project();
  // Cast because the whole point is a field the type system would reject: the
  // registry is a data table, so a stale entry is a runtime possibility.
  const after = edited(before, 0, 'noSuchField' as keyof SimulationConfig, 1 as never);
  assert.equal(after, before, 'an unknown field must not produce a new project');
});

test('editing an out-of-range index returns the receiver unchanged', () => {
  const before = project();
  assert.equal(edited(before, 5, 'sensorGain', 1), before);
  assert.equal(edited(before, -1, 'sensorGain', 1), before);
});

test('editWorld on an unknown field returns the receiver unchanged', () => {
  const before = project();
  const after = editWorld(before, 'nope' as keyof typeof before.world, 1 as never);
  assert.equal(after, before);
});

// ---------------------------------------------------------------------------
// withConfigs: the three-line operation that became one
// ---------------------------------------------------------------------------

test('withConfigs re-clamps the selection', () => {
  // Loading a 1-config preset while editing config 3 is exactly the case whose
  // missing clamp indexed past the end of the buffer.
  const before = project(4, 3);
  const after = withConfigs(before, [config(0)]);
  assert.equal(after.selected, 0);
  assert.equal(configCount(after), 1);
});

test('withConfigs keeps name and world when not given', () => {
  const before = renamed(project(), 'Starcrossedv8');
  const after = withConfigs(before, [config(1)]);
  assert.equal(after.name, 'Starcrossedv8');
  assert.deepEqual(after.world, before.world);
});

test('withConfigs replaces name and world when given', () => {
  // All four parts moving together is the entire argument for the type -- the
  // shipped bug was a restore that replaced configs and left the name behind.
  const world = makeWorldSettings({ boundaryConditions: BC.BOUNCE });
  const after = withConfigs(project(), [config(1)], { name: '9leafv8', world });
  assert.equal(after.name, '9leafv8');
  assert.equal(after.world.boundaryConditions, BC.BOUNCE);
});
