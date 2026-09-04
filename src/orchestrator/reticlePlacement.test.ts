/**
 * Tests for where the brush reticle goes.
 *
 * THE TOOL GATE AND THE SIZING GESTURE ARE THE POINT OF THIS FILE. The reticle
 * is normally the brush tools' own overlay, gated on the active tool -- and the
 * Brush Size drag deliberately punches through that gate, because sizing a
 * brush you cannot see is the one thing the ring exists to prevent.
 *
 * That override is easy to lose to a well-meaning simplification: `if
 * (!usesBrushReticle(mode)) return null` reads like the obviously correct first
 * line of this function, and reinstating it would silently take the reticle away
 * from every non-brush tool while leaving the slider working. So these pin BOTH
 * halves of the rule -- that the gate holds without the gesture, and that the
 * gesture beats the gate.
 *
 * The DECORATION half is here for the same reason in the other direction. The
 * rays, dashes and arrow say what the armed brush would do, and in Select
 * nothing is armed; dropping them is what keeps a measurement from reading as an
 * aim.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MOUSE_MODES, reticlePlacement, usesBrushReticle } from './commands.ts';

test('the brush tools place the reticle under the cursor, decorated', () => {
  for (const mode of MOUSE_MODES.filter(usesBrushReticle)) {
    const placement = reticlePlacement(mode, false);
    assert.notEqual(placement, null, `${mode} should draw a reticle`);
    assert.equal(placement?.centred, false, `${mode} follows the cursor`);
    assert.equal(placement?.decorated, true, `${mode} keeps its own decoration`);
  }
});

test('the other tools draw no reticle at all', () => {
  for (const mode of MOUSE_MODES.filter((m) => !usesBrushReticle(m))) {
    assert.equal(reticlePlacement(mode, false), null, `${mode} draws none`);
  }
});

test('a Brush Size drag centres the reticle in EVERY tool', () => {
  // The whole point of the feature: the ring has to be visible while the size
  // is being chosen, and Select is the tool a user is most likely to be in
  // while setting up. A regression here is invisible from the brush tools.
  for (const mode of MOUSE_MODES) {
    const placement = reticlePlacement(mode, true);
    assert.notEqual(placement, null, `${mode} shows a reticle while sizing`);
    assert.equal(placement?.centred, true, `${mode} centres it while sizing`);
  }
});

test('sizing from a non-brush tool drops the decoration', () => {
  // Nothing is armed in Select, so the rays and dashes would be describing a
  // stroke that no click could produce.
  for (const mode of MOUSE_MODES.filter((m) => !usesBrushReticle(m))) {
    assert.equal(reticlePlacement(mode, true)?.decorated, false, `${mode} is bare`);
  }
});

test('sizing from a brush tool keeps the decoration, and only moves the ring', () => {
  // The honest half of the rule: in a brush tool the reticle still means what
  // it always meant, so the gesture changes its POSITION and nothing else.
  for (const mode of MOUSE_MODES.filter(usesBrushReticle)) {
    const placement = reticlePlacement(mode, true);
    assert.equal(placement?.centred, true, `${mode} centres while sizing`);
    assert.equal(placement?.decorated, true, `${mode} keeps its decoration`);
  }
});

test('releasing the slider leaves nothing centred behind', () => {
  // The gesture must leave NOTHING behind -- a reticle stuck on screen, or one
  // stuck in the middle of it, is the failure mode of a flag that is set but
  // never cleared. Ending a drag has to be indistinguishable from never having
  // started one, which for a pure function means `sizing: false` alone decides
  // it: no tool may report a centred ring once the gesture is over.
  for (const mode of MOUSE_MODES) {
    assert.notEqual(
      reticlePlacement(mode, false)?.centred,
      true,
      `${mode} is never centred at rest`,
    );
  }
});
