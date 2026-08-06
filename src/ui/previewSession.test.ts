/**
 * Hover-preview: the click-commit rule, and session independence.
 *
 * Only the rows that fail SILENTLY are asserted here. A restore that fires when
 * it should not looks exactly like a config the user picked failing to load, and
 * two sessions sharing a snapshot looks exactly like the wrong config coming
 * back -- neither throws, neither logs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PreviewSession } from './previewSession.ts';

/** A session that records what it was asked to do. */
function tracked() {
  const log: string[] = [];
  const session = new PreviewSession<string, string>(
    {
      onSnapshot: () => log.push('snapshot'),
      onRestore: () => log.push('restore'),
      onApply: (item) => log.push(`apply:${item}`),
    },
    (item) => item,
  );
  return { session, log };
}

test('hovering applies, unhovering restores', () => {
  const { session, log } = tracked();
  session.begin();
  session.sync('A');
  session.sync(null);
  assert.deepEqual(log, ['snapshot', 'apply:A', 'restore']);
});

test('closing without a click restores', () => {
  const { session, log } = tracked();
  session.begin();
  session.sync('A');
  session.end();
  assert.deepEqual(log, ['snapshot', 'apply:A', 'restore']);
});

/** THE ROW THAT FAILS SILENTLY. */
test('a click commits, and closing does NOT undo it', () => {
  const { session, log } = tracked();
  session.begin();
  session.sync('A');
  session.commit('A');
  session.end();
  assert.deepEqual(log, ['snapshot', 'apply:A'], 'the commit was undone on close');
});

test('unhovering after a commit does not restore either', () => {
  // Surfaces that stay open after a click leave the cursor on the row; moving
  // it away must not undo the choice.
  const { session, log } = tracked();
  session.begin();
  session.sync('A');
  session.commit('A');
  session.sync(null);
  assert.deepEqual(log, ['snapshot', 'apply:A']);
});

/**
 * THE ROW THAT FAILS SILENTLY, in the other direction.
 *
 * A restore is a config change and therefore resets the simulation. Opening a
 * menu and closing it without hovering anything changed nothing, so restoring
 * there restarts the sim for no reason the user can see -- which is what
 * clicking `File` twice did.
 */
test('opening and closing without hovering restores nothing', () => {
  const { session, log } = tracked();
  session.begin();
  session.end();
  assert.deepEqual(log, ['snapshot'], 'closing an untouched menu restored');
});

test('restoreNow before any hover does nothing', () => {
  // Collapsing a category calls this even when nothing was previewed.
  const { session, log } = tracked();
  session.begin();
  session.restoreNow();
  assert.deepEqual(log, ['snapshot']);
});

test('a session that hovered and unhovered still restores on close', () => {
  // `sync(null)` already restored, but the session HAS touched the world, so
  // the close-time restore stays -- the guard is "never applied", not
  // "not currently previewing".
  const { session, log } = tracked();
  session.begin();
  session.sync('A');
  session.sync(null);
  session.end();
  assert.deepEqual(log, ['snapshot', 'apply:A', 'restore', 'restore']);
});

test('a reopened session does not restore on the strength of the last one', () => {
  const { session, log } = tracked();
  session.begin();
  session.sync('A');
  session.end();
  log.length = 0;
  // Second visit, nothing hovered: `begin` must have cleared the applied flag.
  session.begin();
  session.end();
  assert.deepEqual(log, ['snapshot']);
});

test('moving between rows previews each without restoring between', () => {
  const { session, log } = tracked();
  session.begin();
  session.sync('A');
  session.sync('B');
  assert.deepEqual(log, ['snapshot', 'apply:A', 'apply:B']);
});

test('re-hovering the same row does not re-apply', () => {
  const { session, log } = tracked();
  session.begin();
  session.sync('A');
  session.sync('A');
  assert.deepEqual(log, ['snapshot', 'apply:A']);
});

test('begin is idempotent, so a re-open cannot snapshot a preview', () => {
  const { session, log } = tracked();
  session.begin();
  session.sync('A');
  session.begin();
  assert.deepEqual(log, ['snapshot', 'apply:A']);
});

test('sync does nothing while closed', () => {
  const { session, log } = tracked();
  session.sync('A');
  assert.deepEqual(log, []);
});

test('forget drops the old snapshot and takes a fresh one', () => {
  const { session, log } = tracked();
  session.begin();
  session.sync('A');
  session.forget();
  session.end();
  // The fresh snapshot is restored on close, not the pre-preview one.
  assert.deepEqual(log, ['snapshot', 'apply:A', 'snapshot', 'restore']);
});

/** The bug that made this a class rather than state on the menu. */
test('two sessions do not clobber each other', () => {
  const load = tracked();
  const checkpoints = tracked();

  load.session.begin();
  load.session.sync('preset');
  // A second surface opens while the first is still browsing.
  checkpoints.session.begin();
  checkpoints.session.sync('cp1');
  checkpoints.session.end();

  // The first surface still owes its own restore, and still has it.
  load.session.end();

  assert.deepEqual(load.log, ['snapshot', 'apply:preset', 'restore']);
  assert.deepEqual(checkpoints.log, ['snapshot', 'apply:cp1', 'restore']);
});
