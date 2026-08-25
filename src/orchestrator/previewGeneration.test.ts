/**
 * The ordering rule that keeps a fast hover-stroke from sticking on a preview.
 *
 * ## The bug this pins
 *
 * `previewConfig` reads from storage ASYNCHRONOUSLY and publishes its result
 * under a generation guard. `restoreConfigs` -- the unhover, and the menu close
 * -- is SYNCHRONOUS. Sweeping the cursor across several presets and off the menu
 * therefore produced:
 *
 *     hover A, B, C     three reads in flight, generation is C's
 *     leave the menu    the restore runs NOW, putting the origin back
 *     C resolves        its generation still matches, so it applies on top
 *
 * and the menu closed stuck on whichever row the cursor crossed last, with no
 * error and nothing in the log. Slow hovering hid it completely: each read
 * resolved before the next began, so by the time the cursor left there was
 * nothing outstanding to land late.
 *
 * The fix is that the restore BUMPS THE GENERATION, invalidating the reads it is
 * racing. It cannot outrun them -- it is synchronous and they are not -- so it
 * has to cancel them instead.
 *
 * ## Why this models the rule instead of driving the Orchestrator
 *
 * `Orchestrator` pulls in the whole WebGPU stack and is never constructed under
 * `node --test`; the codebase's split is that pure decisions are tested and
 * GPU-bound classes are not. What actually broke here is not graphics, it is a
 * three-line ordering contract between a canceller and a publisher -- so that
 * contract is reproduced exactly and asserted directly. `publish` and `cancel`
 * below mirror the guard in `previewConfig` and the bump in `restoreConfigs`
 * line for line; if either changes shape, this file is the one that has to be
 * revisited with it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The Orchestrator's generation guard, isolated.
 *
 * `begin` stands in for the `++this.configGeneration` at the top of a storage
 * request, `publish` for the `if (generation !== this.configGeneration) return`
 * inside its `.then`, and `cancel` for the bump `restoreConfigs` now makes.
 */
function guarded() {
  const applied: string[] = [];
  let generation = 0;
  return {
    applied,
    /** Start a request. Returns the token its continuation will check. */
    begin(): number {
      return ++generation;
    },
    /** A continuation resolving. Applies only if it was not superseded. */
    publish(token: number, value: string): void {
      if (token !== generation) return;
      applied.push(value);
    },
    /** Supersede everything outstanding, without starting a request. */
    cancel(): void {
      generation++;
    },
  };
}

test('a restore cancels the previews still in flight behind it', () => {
  // THE REGRESSION. Three rows crossed quickly, then the cursor leaves before
  // any read has come back.
  const g = guarded();
  const a = g.begin();
  const b = g.begin();
  const c = g.begin();

  g.cancel();
  g.applied.push('restore');

  // Every read resolves AFTER the restore, which is the whole difficulty: the
  // restore is synchronous and cannot be late, so the reads are what must lose.
  g.publish(a, 'A');
  g.publish(b, 'B');
  g.publish(c, 'C');

  assert.deepEqual(
    g.applied,
    ['restore'],
    'a preview landed on top of the restore and stuck',
  );
});

test('the newest preview still wins while the menu is open', () => {
  // The other half: cancelling must not be so aggressive that ordinary browsing
  // stops working. Without the last-write-wins guard a slow read for A could
  // land after C and show the wrong preset.
  const g = guarded();
  const a = g.begin();
  const c = g.begin();

  g.publish(a, 'A');
  g.publish(c, 'C');

  assert.deepEqual(g.applied, ['C'], 'a superseded read published anyway');
});

test('a read that resolves before the restore is not clawed back', () => {
  // The common slow-hover case, and the reason the bug went unnoticed: the read
  // lands while the menu is open, and the restore afterwards is what undoes it
  // -- the restore is a real config change, not a cancellation of this one.
  const g = guarded();
  const a = g.begin();

  g.publish(a, 'A');
  g.cancel();
  g.applied.push('restore');

  assert.deepEqual(g.applied, ['A', 'restore']);
});

test('cancelling with nothing in flight is harmless', () => {
  // `restoreConfigs` bumps unconditionally, before it checks whether an origin
  // was ever recorded -- so this is the path taken every time a menu is opened
  // and closed without hovering anything.
  const g = guarded();
  g.cancel();
  const a = g.begin();
  g.publish(a, 'A');
  assert.deepEqual(g.applied, ['A'], 'a later request was wrongly invalidated');
});

test('a cancel invalidates a read begun before it even with no origin', () => {
  // Leaving the menu before the FIRST read resolves records no origin to
  // restore, but still has a read outstanding. Bumping only when an origin
  // exists would let that one land on a menu the user has already left.
  const g = guarded();
  const a = g.begin();
  g.cancel();
  g.publish(a, 'A');
  assert.deepEqual(g.applied, [], 'the first preview landed after the menu closed');
});
