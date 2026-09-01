/**
 * Undo/redo, and the coalescing window.
 *
 * ## What is worth testing here and what is not
 *
 * The timeline arithmetic is small, and its bugs are the kind that look like
 * "undo behaved oddly once" rather than like a crash -- which is the class this
 * file is aimed at. Three specifically:
 *
 *   - **Coalescing merges the END of a gesture, never the start.** If the start
 *     moved too, undoing a drag would land mid-drag. `history.py:113-118`.
 *   - **A new action truncates redo.** Editing after an undo must discard the
 *     future, or redo walks into a state that never followed from here.
 *   - **The seed is never merged into.** `cursor > 0` in `canCoalesce` is what
 *     stops the session's first edit rewriting the state undo returns to.
 *
 * `now` is injected throughout rather than slept on. That is not only for
 * speed: the window is 500 **milliseconds** here where the Python's is 0.5
 * **seconds**, because `performance.now()` and `time.monotonic()` differ by a
 * factor of 1000. Getting that conversion wrong makes every edit coalesce
 * forever or none of them, and both read as "undo is behaving oddly" rather
 * than as a unit bug -- so the window is exercised explicitly from both sides.
 *
 * The projects are real `Project` values because `History` stores them by
 * reference and the test asserts on identity.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { COALESCE_WINDOW_MS, History } from './history.ts';
import { type Project, editSelected, makeProject } from './project.ts';
import { makeSimulationConfig } from '../particleSystem/config.ts';

const base = makeProject({
  configs: [
    makeSimulationConfig(
      {
        cohorts: 1,
        mutationSeed: 0.5,
        sensorGain: 0,
        sensorAngle: 0,
        sensorDistance: 1,
        mutationScale: 0,
        globalForceMult: 1,
        drag: 0.5,
        strafePower: 0,
        axialForce: 1,
        lateralForce: 1,
        hazardRate: 0,
      },
      { rule: new Array<number>(80).fill(0) },
    ),
  ],
});

/** A project distinguishable by `sensorGain`, so assertions can name a state. */
function at(gain: number): Project {
  return editSelected(base, 'sensorGain', gain);
}

function gainOf(project: Project | null): number | null {
  return project === null ? null : project.configs[0]!.sensorGain;
}

// ---------------------------------------------------------------------------
// The timeline
// ---------------------------------------------------------------------------

test('a seeded history can neither undo nor redo', () => {
  const history = new History();
  history.seed(base);
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
  assert.equal(history.depth, 1);
  assert.equal(history.undoLabel(), '');
});

test('one record makes undo return the state before it', () => {
  const history = new History();
  history.seed(base);
  history.record(base, at(1), 'edit gain', null, 0);

  assert.equal(history.canUndo, true);
  assert.equal(history.undoLabel(), 'edit gain');
  assert.equal(gainOf(history.undo()), 0);
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, true);
  assert.equal(gainOf(history.redo()), 1);
});

test('EVERY step keeps its label, not just the newest', () => {
  // The reported bug: undo the most recent action and it names itself; undo the
  // one before it and the message degraded to a bare "Undo".
  //
  // The cause was in `record`'s re-seating. It replaces the entry at the cursor
  // so the timeline holds the state actually being left (previews can move the
  // project without recording), and replacing the WHOLE entry also blanked its
  // label -- so recording B erased A's. Harmless while labels only fed a menu
  // that shows one row; visible the moment they became messages.
  const history = new History();
  history.seed(base);
  history.record(base, at(1), 'first', null, 0);
  history.record(at(1), at(2), 'second', null, 1000);

  // Walking back: each step names the act it takes back.
  assert.equal(history.undoLabel(), 'second');
  history.undo();
  assert.equal(history.undoLabel(), 'first', 'the older step lost its label');
  history.undo();
  assert.equal(history.undoLabel(), '', 'the seed has no label to give');

  // And forward: each redo names the act it re-applies.
  assert.equal(history.redoLabel(), 'first');
  history.redo();
  assert.equal(history.redoLabel(), 'second', 'the newer step lost its label');
  history.redo();
  assert.equal(history.redoLabel(), '', 'nothing left to redo');
});

test('labels survive an arbitrarily long chain', () => {
  // The same property at depth, so a fix that only repairs the last two steps
  // does not pass. Every entry must name itself on the way back and forward.
  const history = new History();
  history.seed(base);
  const labels = ['a', 'b', 'c', 'd', 'e'];
  labels.forEach((label, i) => {
    history.record(at(i), at(i + 1), label, null, i * 1000);
  });

  for (const expected of [...labels].reverse()) {
    assert.equal(history.undoLabel(), expected);
    history.undo();
  }
  for (const expected of labels) {
    assert.equal(history.redoLabel(), expected);
    history.redo();
  }
});

test('undo and redo are symmetric across several steps', () => {
  const history = new History();
  history.seed(base);
  history.record(base, at(1), 'a', null, 0);
  history.record(at(1), at(2), 'b', null, 1000);
  history.record(at(2), at(3), 'c', null, 2000);

  assert.equal(gainOf(history.undo()), 2);
  assert.equal(gainOf(history.undo()), 1);
  assert.equal(gainOf(history.undo()), 0);
  assert.equal(history.undo(), null, 'undo past the seed must return null');
  assert.equal(gainOf(history.redo()), 1);
  assert.equal(gainOf(history.redo()), 2);
  assert.equal(gainOf(history.redo()), 3);
  assert.equal(history.redo(), null);
});

test('a new action discards the redo future', () => {
  const history = new History();
  history.seed(base);
  history.record(base, at(1), 'a', null, 0);
  history.record(at(1), at(2), 'b', null, 1000);
  history.undo();
  assert.equal(history.canRedo, true);

  history.record(at(1), at(9), 'c', null, 2000);
  assert.equal(history.canRedo, false, 'editing after undo must truncate the future');
  assert.equal(gainOf(history.undo()), 1);
});

// ---------------------------------------------------------------------------
// Coalescing
// ---------------------------------------------------------------------------

test('same-key records within the window merge into one entry', () => {
  const history = new History();
  history.seed(base);
  // A slider drag: one record per frame, all the same key.
  history.record(base, at(1), 'edit Gain', 'config:sensorGain', 0);
  history.record(at(1), at(2), 'edit Gain', 'config:sensorGain', 100);
  history.record(at(2), at(3), 'edit Gain', 'config:sensorGain', 200);

  assert.equal(history.depth, 2, 'a drag is one entry, not three');
  // THE START STAYS PUT and only the end moves, so undo jumps the whole drag.
  assert.equal(gainOf(history.undo()), 0);
});

test('record reports whether it appended or coalesced', () => {
  // The decision used to be invisible to callers, and the state archive hooks
  // this path expecting one node per ACT -- so without the return value it filed
  // one per FRAME of a drag. Undo was unaffected throughout, which is what made
  // the bug worth reporting rather than leaving to be inferred.
  const history = new History();
  history.seed(base);
  assert.equal(
    history.record(base, at(1), 'edit Gain', 'config:sensorGain', 0),
    'appended',
  );
  assert.equal(
    history.record(at(1), at(2), 'edit Gain', 'config:sensorGain', 100),
    'coalesced',
  );
  // A one-shot act never merges, so it always appends.
  assert.equal(history.record(at(2), at(3), 'randomize', null, 200), 'appended');
});

test('a different key starts a new entry', () => {
  // Moving to another slider ends the gesture -- otherwise two sliders dragged
  // in quick succession would undo as one.
  const history = new History();
  history.seed(base);
  history.record(base, at(1), 'edit Gain', 'config:sensorGain', 0);
  history.record(at(1), at(2), 'edit Angle', 'config:sensorAngle', 100);
  assert.equal(history.depth, 3);
});

test('a pause longer than the window starts a new entry', () => {
  const history = new History();
  history.seed(base);
  history.record(base, at(1), 'edit Gain', 'config:sensorGain', 0);
  history.record(at(1), at(2), 'edit Gain', 'config:sensorGain', COALESCE_WINDOW_MS + 1);
  assert.equal(history.depth, 3, 'a deliberate second adjustment is its own step');
});

test('exactly at the window still merges', () => {
  // The boundary is `<=`, matching `history.py:139`. Asserted from both sides
  // because an off-by-one here is invisible in use.
  const history = new History();
  history.seed(base);
  history.record(base, at(1), 'edit Gain', 'config:sensorGain', 0);
  history.record(at(1), at(2), 'edit Gain', 'config:sensorGain', COALESCE_WINDOW_MS);
  assert.equal(history.depth, 2);
});

test('a null key never merges', () => {
  // One-shot acts: randomizing the seed three times is three undo steps,
  // which is what you want from a button (`settings_commands.py:66-69`).
  const history = new History();
  history.seed(base);
  history.record(base, at(1), 'randomize', null, 0);
  history.record(at(1), at(2), 'randomize', null, 1);
  history.record(at(2), at(3), 'randomize', null, 2);
  assert.equal(history.depth, 4);
});

test('the seed is never merged into', () => {
  // `cursor > 0` in canCoalesce. Without it the session's very first drag would
  // rewrite the state undo returns to, and the original would be unreachable.
  const history = new History();
  history.seed(base);
  history.record(base, at(1), 'edit Gain', 'config:sensorGain', 0);
  assert.equal(history.depth, 2);
  assert.equal(gainOf(history.undo()), 0);
});

test('breakCoalescing ends the gesture', () => {
  // Undo/redo call this: resuming a drag afterwards must not rewrite the entry
  // just stepped back to (`history.py:141-148`).
  const history = new History();
  history.seed(base);
  history.record(base, at(1), 'edit Gain', 'config:sensorGain', 0);
  history.breakCoalescing();
  history.record(at(1), at(2), 'edit Gain', 'config:sensorGain', 100);
  assert.equal(history.depth, 3);
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

test('the timeline is trimmed to max entries, oldest first', () => {
  const history = new History(4);
  history.seed(base);
  for (let i = 1; i <= 10; i++) {
    history.record(at(i - 1), at(i), `edit ${i}`, null, i * 1000);
  }
  assert.equal(history.depth, 4);
  // The cursor stays on the live state after a trim, so undo still works.
  assert.equal(history.cursor, 3);
  assert.equal(gainOf(history.undo()), 9);
});

test('recording without a seed still produces an undoable step', () => {
  // The `else` arm of `record`. Nothing in the app hits it -- the Orchestrator
  // seeds at construction -- but a History used before seeding must not lose
  // the first entry silently.
  const history = new History();
  history.record(base, at(1), 'first', null, 0);
  assert.equal(history.depth, 2);
  assert.equal(gainOf(history.undo()), 0);
});
