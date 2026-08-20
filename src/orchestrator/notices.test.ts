/**
 * The wording of the transient messages.
 *
 * Worth testing because the strings ARE the feature, and a wrong one is worse
 * than none: the user is being told what just happened to their work, so "Undo:
 * Load Preset" after undoing a slider drag actively misleads. Nothing about a
 * compiler notices a stale phrase.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  type BehaviorEvent,
  describeCheckpointSet,
  describeEvent,
  describeHistoryStep,
  historyLabelFor,
} from './notices.ts';

test('undo and redo name what the step was', () => {
  // The stored labels are lowercase verb phrases written for the menu; the
  // toast reads as a title. Capitalising at the boundary is what lets both.
  assert.equal(describeHistoryStep('undo', 'edit Mutation Scale'), 'Undo: Edit Mutation Scale');
  assert.equal(describeHistoryStep('redo', 'edit Mutation Scale'), 'Redo: Edit Mutation Scale');
  assert.equal(
    describeHistoryStep('undo', 'toggle Cohort Fences'),
    'Undo: Toggle Cohort Fences',
  );
});

test('an unlabelled step degrades to a bare verb, not a dangling colon', () => {
  // Entry 0 carries no label -- nothing produced it -- and a step recorded
  // before this feature existed carries none either. "Undo" alone is honest
  // about not knowing; "Undo: " is a bug on screen.
  for (const empty of ['', '   ']) {
    assert.equal(describeHistoryStep('undo', empty), 'Undo');
    assert.equal(describeHistoryStep('redo', empty), 'Redo');
  }
});

test('the behaviour events read as the specification asks', () => {
  assert.equal(
    describeEvent({ kind: 'loadPreset', name: 'Diversity' }),
    'Load Preset — Diversity',
  );
  assert.equal(
    describeEvent({ kind: 'commitSelection', cohort: 7 }),
    'Commit Selection of cohort 7',
  );
  assert.equal(
    describeEvent({ kind: 'loadCheckpoint', name: 'before the split' }),
    'Load checkpoint before the split',
  );
  assert.equal(describeEvent({ kind: 'loadSharedLink' }), 'Load project from URL');
  assert.equal(describeEvent({ kind: 'randomizeBehavior' }), 'Randomize behavior');
  assert.equal(describeEvent({ kind: 'randomizeSeed' }), 'Reroll mutations');
});

test('the reroll message says "mutations", which only an authored rule has', () => {
  // The word is only safe because of the REDIRECT: under the all-zero sentinel
  // `randomizeSeed` never reaches this string -- the Orchestrator routes it to
  // `randomizeBehavior`, which reports as that. So "mutations" is accurate
  // everywhere this can appear. If that redirect is ever removed, this message
  // starts lying in exactly the state it used to lie in.
  assert.notEqual(
    describeEvent({ kind: 'randomizeSeed' }),
    describeEvent({ kind: 'randomizeBehavior' }),
    'the two must stay distinguishable -- the redirect picks between them',
  );
});

test('randomizing behaviour keeps the history label it had before the toast', () => {
  // THE MIGRATION THIS PINS. `randomizeBehavior` recorded `'randomize behavior'`
  // as a literal before it gained a toast; it now goes through `notifyBehavior`,
  // which derives the label from the event. Those must produce the same string,
  // or the Edit menu's "Undo <label>" silently changes wording for a command
  // whose behaviour did not.
  assert.equal(historyLabelFor({ kind: 'randomizeBehavior' }), 'randomize behavior');
});

test('an event and its UNDO describe the same act', () => {
  // The property that matters, and the reason `historyLabelFor` exists rather
  // than each site writing its own string: the message shown when something
  // happens and the message shown when it is undone must be about one act.
  const events: BehaviorEvent[] = [
    { kind: 'loadPreset', name: 'Crystal' },
    { kind: 'commitSelection', cohort: 3 },
    { kind: 'loadCheckpoint', name: 'v2' },
    { kind: 'loadSharedLink' },
    { kind: 'randomizeBehavior' },
    { kind: 'randomizeSeed' },
  ];
  for (const event of events) {
    const shown = describeEvent(event);
    const undone = describeHistoryStep('undo', historyLabelFor(event));
    assert.equal(
      undone,
      `Undo: ${shown}`,
      `"${undone}" does not undo "${shown}"`,
    );
  }
});

test('setting a checkpoint names the checkpoint', () => {
  // The NAME is the point: it is what the Checkpoints menu lists the entry
  // under, so it is how the user finds again the thing they just set. A bare
  // "Checkpoint set" would say something happened without saying what to look
  // for.
  assert.equal(describeCheckpointSet('Project00'), 'Checkpoint set: Project00');
});

test('a checkpoint set is NOT a behaviour event', () => {
  // The distinction `describeCheckpointSet` exists to keep. Every member of
  // `BehaviorEvent` is recorded to history, which is what lets `historyLabelFor`
  // derive an undo label from it -- setting a checkpoint changes no behaviour
  // and pushes no history step, so it must not acquire one by being folded into
  // the union. Stated as a test because the pull to "just add a fifth kind" is
  // real and the damage would be an undo entry for a step that cannot be undone.
  const events: BehaviorEvent[] = [
    { kind: 'loadPreset', name: 'Crystal' },
    { kind: 'commitSelection', cohort: 3 },
    { kind: 'loadCheckpoint', name: 'v2' },
    { kind: 'loadSharedLink' },
    { kind: 'randomizeBehavior' },
    { kind: 'randomizeSeed' },
  ];
  for (const event of events) {
    assert.notEqual(
      describeEvent(event),
      describeCheckpointSet('Project00'),
      'a behaviour event must not produce the checkpoint-set message',
    );
  }
});

test('cohort 0 is named, not dropped', () => {
  // A falsy cohort number is the classic way a template drops a value. Cohort 0
  // is a perfectly ordinary cohort and the message has to say so.
  assert.equal(
    describeEvent({ kind: 'commitSelection', cohort: 0 }),
    'Commit Selection of cohort 0',
  );
});
