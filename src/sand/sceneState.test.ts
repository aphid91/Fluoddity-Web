/**
 * The capture/restore state machine, exercised through a stand-in for the GPU
 * side.
 *
 * `SandOrchestrator` itself cannot be constructed under `node --test` -- it
 * needs a device, and it imports `.wgsl` through the Vite plugin. What CAN be
 * tested is the decision logic, which is the part with the subtle bug in it: WHEN
 * a scene is captured, and what a reset does to that decision.
 *
 * So this mirrors the orchestrator's three flags and their transitions. It is a
 * model test, and it is honest about that: if the orchestrator's own transitions
 * drift from these, the test keeps passing. What it buys is a statement of the
 * intended machine that a reader can check the implementation against, and a
 * guard on the specific regression that shipped once during development --
 * capture armed only for the FIRST arrangement, so every later edit was silently
 * discarded by R.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { RESTORE_FRAME } from './restoreFrame.ts';

/** The orchestrator's capture/restore decision logic, mirrored. */
class SceneModel {
  paused = true;
  captureArmed = true;
  hasSnapshot = false;
  restorePending = false;
  /** What the snapshot holds, as a stand-in for the four GPU copies. */
  snapshot: string | null = null;
  /** The live scene. */
  scene = '';
  frame = RESTORE_FRAME;
  captures = 0;

  paint(what: string): void {
    this.scene += what;
  }

  togglePause(): void {
    this.paused = !this.paused;
  }

  reset(): void {
    if (this.hasSnapshot) {
      this.restorePending = true;
      this.paused = true;
      this.captureArmed = true;
      return;
    }
    this.startEmpty();
  }

  startEmpty(): void {
    this.scene = '';
    this.frame = RESTORE_FRAME;
    this.paused = true;
    this.captureArmed = true;
  }

  runFrame(): void {
    if (this.restorePending) {
      this.restorePending = false;
      if (this.hasSnapshot) {
        this.scene = this.snapshot ?? '';
        this.frame = RESTORE_FRAME;
      }
    }
    if (!this.paused && this.captureArmed) {
      this.captureArmed = false;
      this.snapshot = this.scene;
      this.hasSnapshot = true;
      this.captures++;
    }
    if (!this.paused) this.frame++;
  }
}

test('the world starts paused, arranging, with nothing captured', () => {
  const s = new SceneModel();
  assert.equal(s.paused, true);
  assert.equal(s.hasSnapshot, false);
  // NEVER frame 0: that is the studio's regenerate-everything sentinel, which
  // would fill the world with particles the user never painted.
  assert.equal(s.frame, RESTORE_FRAME);
  assert.ok(RESTORE_FRAME > 0);
});

test('painting while paused does not capture', () => {
  const s = new SceneModel();
  s.paint('wall');
  s.runFrame();
  assert.equal(s.hasSnapshot, false, 'arranging is not running');
});

test('the first unpause captures the arrangement', () => {
  const s = new SceneModel();
  s.paint('wall+sand');
  s.togglePause();
  s.runFrame();
  assert.equal(s.hasSnapshot, true);
  assert.equal(s.snapshot, 'wall+sand');
});

test('running does not re-capture', () => {
  const s = new SceneModel();
  s.paint('a');
  s.togglePause();
  s.runFrame();
  s.paint('-drifted');
  s.runFrame();
  s.runFrame();
  assert.equal(s.captures, 1, 'captured once, at the moment of going');
  assert.equal(s.snapshot, 'a', 'later motion is not the initial conditions');
});

test('R restores the arrangement and returns to arranging', () => {
  const s = new SceneModel();
  s.paint('bowl');
  s.togglePause();
  s.runFrame();
  s.paint('-then-chaos');

  s.reset();
  s.runFrame();

  assert.equal(s.scene, 'bowl');
  assert.equal(s.paused, true, 'back to arranging');
  assert.equal(s.frame, RESTORE_FRAME);
});

// ---------------------------------------------------------------------------
// THE REGRESSION THIS FILE EXISTS FOR
// ---------------------------------------------------------------------------

test('a reset RE-ARMS capture, so the next go remembers the NEW scene', () => {
  const s = new SceneModel();
  s.paint('v1');
  s.togglePause();
  s.runFrame();

  // Back to arranging, edit, go again.
  s.reset();
  s.runFrame();
  s.paint('+v2');
  s.togglePause();
  s.runFrame();

  // "The most recently set initial conditions", not the first of the session.
  assert.equal(s.snapshot, 'v1+v2');
  assert.equal(s.captures, 2);

  // And a second R returns the edited arrangement, not the original.
  s.paint('-chaos');
  s.reset();
  s.runFrame();
  assert.equal(s.scene, 'v1+v2');
});

test('R before ever going empties the world', () => {
  const s = new SceneModel();
  s.paint('scribble');
  s.reset();
  assert.equal(s.scene, '', 'nothing to restore, so start over');
  assert.equal(s.captureArmed, true, 'and the next go still captures');
});

test('repeated resets without going keep the same snapshot', () => {
  const s = new SceneModel();
  s.paint('x');
  s.togglePause();
  s.runFrame();

  s.reset();
  s.runFrame();
  s.reset();
  s.runFrame();

  assert.equal(s.scene, 'x');
  assert.equal(s.captures, 1, 'no unpause happened, so nothing re-captured');
});
