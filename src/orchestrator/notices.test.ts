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

test('the four behaviour events read as the specification asks', () => {
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

test('cohort 0 is named, not dropped', () => {
  // A falsy cohort number is the classic way a template drops a value. Cohort 0
  // is a perfectly ordinary cohort and the message has to say so.
  assert.equal(
    describeEvent({ kind: 'commitSelection', cohort: 0 }),
    'Commit Selection of cohort 0',
  );
});
