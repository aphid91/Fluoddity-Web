/**
 * Settings routing: an edit reaches the source that owns the field, and only it.
 *
 * ## The failure this is aimed at
 *
 * Three sources with three different save semantics share one edit path. A
 * WORLD setting routed to CONFIG would be **saved in the wrong half of the file
 * and applied per-config**, which for `trailPersistence` means the trails decay
 * at whatever the selected config says instead of at the world's rate. That
 * reads as a physics quirk, not as an error -- `project.py:125-134` records
 * exactly this bug having shipped once, as "a disguised edit of config 0".
 *
 * A PREFS setting routed to the project is worse in a quieter way: preference
 * edits are deliberately NOT recorded in history, so a misrouted one would
 * start filling the undo stack with entries that undo nothing visible.
 *
 * No GPU, no Orchestrator, no device -- the routing is pure by construction,
 * which is why it moved out of the class.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ZERO_RULE,
  applySettingEdit,
  randomizeBehavior,
  randomizeSeed,
  ruleIsSentinel,
  ruleIsGeneratedOnGpu,
  selectionIsNoOp,
  setPopulationLayout,
} from './settingsCommands.ts';
import { type Project, makeProject, selectedConfig } from '../project/project.ts';
import { DEFAULT_PREFERENCES } from '../prefs/preferences.ts';
import { SETTINGS, type Setting } from '../ui/settingsSpec.ts';
import { makeSimulationConfig, IC } from '../particleSystem/config.ts';

const project: Project = makeProject({
  configs: [
    makeSimulationConfig(
      {
        cohorts: 1,
        mutationSeed: 0.5,
        sensorGain: 1.0,
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
    ),
  ],
});

const sources = { project, prefs: DEFAULT_PREFERENCES };

function settingFor(label: string): Setting {
  const found = SETTINGS.find((s) => s.label === label);
  assert.ok(found !== undefined, `no setting labelled ${label}`);
  return found;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

test('a CONFIG setting edits the selected config', () => {
  const result = applySettingEdit(sources, settingFor('Sensor Gain'), 4.0);
  assert.equal(result.kind, 'project');
  if (result.kind !== 'project') return;
  assert.equal(selectedConfig(result.project).sensorGain, 4.0);
  // And leaves the world alone.
  assert.deepEqual(result.project.world, project.world);
});

test('a WORLD setting edits the world, not the config', () => {
  // The bug that shipped once on the desktop, asserted in both directions.
  const result = applySettingEdit(sources, settingFor('Trail Persistence'), 0.8);
  assert.equal(result.kind, 'project');
  if (result.kind !== 'project') return;
  assert.equal(result.project.world.trailPersistence, 0.8);
  assert.deepEqual(result.project.configs, project.configs);
});

test('a PREFS setting produces preferences and never touches the project', () => {
  const result = applySettingEdit(sources, settingFor('Brightness'), 2.0);
  assert.equal(result.kind, 'prefs');
  if (result.kind !== 'prefs') return;
  assert.equal(result.prefs.brightness, 2.0);
});

test('every registry entry routes to a source that actually accepts it', () => {
  // The end-to-end version of `settingsSpec.test.ts`'s field check: not only
  // does the field exist, the edit through THIS path lands on it. A control
  // whose edit is a no-op renders, drags, and silently does nothing.
  for (const setting of SETTINGS) {
    if (setting.field === '') continue; // the Gravity gate stores nothing
    if (setting.kind === 'seed') continue; // exercised by randomizeSeed below

    // A value guaranteed different from THIS setting's current default, and
    // legal for the kind. A bool must be read off the defaults and negated
    // rather than hardcoded to `true`: `bloomEnabled` already defaults to
    // `true`, so a fixed `true` is a legitimate no-op and the assertion below
    // would report a routing bug that is not there.
    const value: number | boolean =
      setting.kind === 'bool'
        ? DEFAULT_PREFERENCES[setting.field as keyof typeof DEFAULT_PREFERENCES] !== true
        : (setting.lo + setting.hi) / 2 + 0.0001;
    const result = applySettingEdit(sources, setting, value);

    if (result.kind === 'prefs') {
      assert.notEqual(
        result.prefs,
        DEFAULT_PREFERENCES,
        `${setting.label} routed to prefs but changed nothing`,
      );
    } else {
      assert.notEqual(
        result.project,
        project,
        `${setting.label} routed to the project but changed nothing`,
      );
    }
  }
});

test('an unknown field returns the sources unchanged', () => {
  // Keeps the caller's `before !== after` history guard meaningful: a stale
  // registry entry does nothing rather than recording an empty undo step on
  // every frame of a drag.
  const stale: Setting = { ...settingFor('Sensor Gain'), field: 'goneAway' };
  const result = applySettingEdit(sources, stale, 1.0);
  assert.equal(result.kind, 'project');
  if (result.kind !== 'project') return;
  assert.equal(result.project, project, 'must return the receiver, not a copy');
});

// ---------------------------------------------------------------------------
// The two randomizers
// ---------------------------------------------------------------------------

test('randomizeSeed moves the seed and nothing else', () => {
  const next = randomizeSeed(project, () => 0.875);
  assert.ok(next !== null);
  assert.equal(selectedConfig(next).mutationSeed, 0.875);
  assert.equal(selectedConfig(next).sensorGain, selectedConfig(project).sensorGain);
  assert.deepEqual([...selectedConfig(next).rule], [...selectedConfig(project).rule]);
});

test('randomizeBehavior zeroes the rule AND moves the seed', () => {
  // THE SEED HAS TO MOVE. The GPU's fallback is seeded by mutationSeed, so
  // zeroing the rule alone regenerates the SAME behaviour -- the command would
  // appear to do nothing on the second press (`settings_commands.py:90-95`).
  const next = randomizeBehavior(project, () => 0.125);
  const config = selectedConfig(next);
  assert.deepEqual([...config.rule], [...ZERO_RULE]);
  assert.equal(config.mutationSeed, 0.125);
  assert.notEqual(config.mutationSeed, selectedConfig(project).mutationSeed);
});

test('the zero rule is 80 floats, matching the shader sentinel', () => {
  // 10 FourierCenters x (frequency 4 + amplitude 4). entityUpdate.wgsl reads an
  // all-zero rule as "no target given" and generates one instead.
  assert.equal(ZERO_RULE.length, 80);
  assert.ok(ZERO_RULE.every((v) => v === 0));
});

test('ruleIsSentinel distinguishes a generated rule from an authored one', () => {
  assert.equal(ruleIsSentinel(project), false);
  assert.equal(ruleIsSentinel(randomizeBehavior(project, () => 0.5)), true);
});

// ---------------------------------------------------------------------------
// Population layout
// ---------------------------------------------------------------------------

test('setPopulationLayout moves BOTH fields', () => {
  // Both, or the button lies: a cohort count with the old initial conditions
  // still in force shows nothing laid out, which is the whole promise of the
  // icon that sends this.
  const next = setPopulationLayout(project, 16);
  const config = selectedConfig(next);
  assert.equal(config.cohorts, 16);
  assert.equal(config.initialConditions, IC.GRID);
});

test('setPopulationLayout clamps to the registry bounds', () => {
  // The bounds live in `settingsSpec.ts` and are read, not restated -- so this
  // asserts the CLAMP happened, against whatever the registry currently says,
  // rather than pinning 1..64 in a second place.
  const cohorts = settingFor('Cohorts');
  const high = selectedConfig(setPopulationLayout(project, 9999)).cohorts;
  const low = selectedConfig(setPopulationLayout(project, -5)).cohorts;
  assert.equal(high, cohorts.hi);
  assert.equal(low, cohorts.lo);
});

test('setPopulationLayout leaves the rule and the seed alone', () => {
  // It is a layout command. Touching the rule would make picking a grid
  // silently reroll the behaviour being looked at.
  const next = setPopulationLayout(project, 4);
  assert.deepEqual([...selectedConfig(next).rule], [...selectedConfig(project).rule]);
  assert.equal(selectedConfig(next).mutationSeed, selectedConfig(project).mutationSeed);
});

// ---------------------------------------------------------------------------
// The no-op selection guard
// ---------------------------------------------------------------------------
//
// At mutation scale 0 with an AUTHORED rule, `mutate_rule` scales both of its
// terms by `amount` -- so the amplitude delta is 0 and the frequency multiplier
// is exactly 1.0, and every cohort comes back obeying the rule it went in with.
// Adopting one then installs the rule the config already has: the simulation
// resets and an undo entry is pushed for a picture that did not move.

/** The fixture, with `rule` and `mutationScale` set. */
function withRule(rule: readonly number[], mutationScale: number): Project {
  return makeProject({
    configs: [
      makeSimulationConfig(
        { ...selectedConfig(project), mutationScale },
        { rule: rule.slice() },
      ),
    ],
  });
}

/** A rule that is zero ONLY in the two lanes the shader tests. */
function sentinelLanesOnly(): number[] {
  const rule = new Array<number>(80).fill(0.25);
  for (let i = 0; i < 4; i++) rule[i] = 0; // centers[0].frequency
  for (let i = 44; i < 48; i++) rule[i] = 0; // centers[5].amplitude
  return rule;
}

test('a zero mutation scale makes an authored-rule selection a no-op', () => {
  assert.equal(selectionIsNoOp(withRule(new Array<number>(80).fill(0.25), 0)), true);
});

test('any mutation at all makes the selection meaningful again', () => {
  // The cohorts diverge as soon as `amount` is non-zero, so there is a real
  // difference to adopt. Deliberately tiny: the guard is `=== 0`, not a
  // threshold, because any non-zero scale produces genuinely distinct rules.
  assert.equal(selectionIsNoOp(withRule(new Array<number>(80).fill(0.25), 1e-6)), false);
});

test('a GENERATED rule is never a no-op, whatever the mutation scale', () => {
  // The generate branch never calls `mutate_rule` at all: each cohort's rule
  // comes from `rule_seed = mutationSeed + floor(cohort)`, so the cohorts differ
  // even at scale 0 and adopting one is the only way to capture it. Suppressing
  // the selection here would break the case selection is most useful in.
  assert.equal(selectionIsNoOp(withRule(new Array<number>(80).fill(0), 0)), false);
});

test('the no-op guard asks the SHADER\'s generate test, not the all-zero one', () => {
  // THE CORNER CASE, and the reason `ruleIsGeneratedOnGpu` exists next to
  // `ruleIsSentinel`. A rule that is zero in `centers[0].frequency` and
  // `centers[5].amplitude` but non-zero elsewhere IS generated by the GPU
  // (rule.wgsl:173-174 tests only those two lanes), so its cohorts differ and a
  // selection is real. `ruleIsSentinel` calls it authored -- checking all 80
  // floats -- and using that here would suppress a legitimate selection at
  // scale 0.
  const rule = sentinelLanesOnly();
  assert.equal(ruleIsSentinel(makeProject({
    configs: [makeSimulationConfig({ ...selectedConfig(project) }, { rule })],
  })), false, 'all-80 check says authored');
  assert.equal(ruleIsGeneratedOnGpu(withRule(rule, 0)), true, 'the shader generates it');
  assert.equal(selectionIsNoOp(withRule(rule, 0)), false, 'so the selection is real');
});

test('ruleIsGeneratedOnGpu reads the lanes the Rule layout puts them at', () => {
  // A Rule is 10 FourierCenters of 8 floats (frequency 0..3, amplitude 4..7), so
  // centers[0].frequency is 0..3 and centers[5].amplitude is 44..47. An
  // off-by-one here would test the wrong coefficients and disagree with the GPU
  // about which rules are generated.
  for (const i of [0, 1, 2, 3, 44, 45, 46, 47]) {
    const rule = new Array<number>(80).fill(0);
    rule[i] = 0.5; // one tested lane is non-zero => not generated
    assert.equal(
      ruleIsGeneratedOnGpu(withRule(rule, 0)),
      false,
      `float ${String(i)} is inside a tested lane`,
    );
  }
  for (const i of [4, 43, 48, 79]) {
    const rule = new Array<number>(80).fill(0);
    rule[i] = 0.5; // outside both lanes => still generated
    assert.equal(
      ruleIsGeneratedOnGpu(withRule(rule, 0)),
      true,
      `float ${String(i)} is outside both tested lanes`,
    );
  }
});
