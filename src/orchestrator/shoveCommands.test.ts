/**
 * Tests for the Shove tool's per-frame state.
 *
 * THE STRENGTH FORMULA IS THE POINT OF THIS FILE. The shader applies the value
 * once per sub-step, so the host divides by `steps ** 0.75`, anchored so the
 * default rate is unmoved. The exponent is a deliberate middle: the brush gets
 * STRONGER as Physics Rate falls (the behaviour the tool is judged on) without
 * the 30x swing a full division would give across the slider.
 *
 * The DIRECTION has been reversed twice -- an early version multiplied the rate
 * back in, making strength proportional to it -- so these tests pin the sign of
 * the relationship and the anchor, not just arithmetic. A test that only
 * checked numbers would let the direction flip a third time unnoticed.
 *
 * The other four assertions cover gates that fail SILENTLY: a shove that keeps
 * working while paused looks like a stuck simulation, and a right-drag that
 * reverses mid-push looks like a physics quirk.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EMPTY_INPUT, type InputState } from '../ui/inputState.ts';
import {
  SHOVE_GAIN,
  SHOVE_RATE_EXPONENT,
  SHOVE_REFERENCE_STEPS,
  type ShoveContext,
  shoveState,
} from './shoveCommands.ts';

const CTX: ShoveContext = {
  mouseMode: 'shove',
  paused: false,
  windowSize: [1024, 1024],
  canvasSize: [1024, 1024],
  pan: [0, 0],
  zoom: 1,
  physicsSteps: 30,
  drawPower: 1.0,
  drawSize: 0.031,
};

const ctx = (over: Partial<ShoveContext> = {}): ShoveContext => ({ ...CTX, ...over });

const input = (over: Partial<InputState> = {}): InputState => ({
  ...EMPTY_INPUT,
  mousePos: [512, 512],
  ...over,
});

test('nothing shoves while paused', () => {
  // The guard lives in shoveState rather than at the call site, so a second
  // caller cannot silently defeat the pause (`shove_commands.py:69-72`).
  assert.equal(
    shoveState(input({ leftDragging: true }), ctx({ paused: true })),
    null,
  );
});

test('nothing shoves in another tool', () => {
  for (const mouseMode of ['select', 'walls'] as const) {
    assert.equal(shoveState(input({ leftDragging: true }), ctx({ mouseMode })), null);
  }
});

test('nothing shoves with no button down', () => {
  assert.equal(shoveState(input(), CTX), null);
  // HELD is not DRAGGING. A press that landed on a panel sets neither dragging
  // flag, and must not shove.
  assert.equal(shoveState(input({ leftPressed: true }), CTX), null);
});

test('left pushes, right pulls, and left wins when both are down', () => {
  const push = shoveState(input({ leftDragging: true }), CTX);
  const pull = shoveState(input({ rightDragging: true }), CTX);
  assert.ok(push !== null && pull !== null);
  assert.ok(push.strength > 0, 'left must push away (positive)');
  assert.ok(pull.strength < 0, 'right must pull in (negative)');
  assert.equal(pull.strength, -push.strength);

  // Both down: left wins, so a stray right-click mid-shove does not reverse it.
  const both = shoveState(input({ leftDragging: true, rightDragging: true }), CTX);
  assert.ok(both !== null);
  assert.equal(both.strength, push.strength);
});

test('the brush is RELATIVELY stronger at low physics rates, not weaker', () => {
  // THE DIRECTION, which is the thing that has flip-flopped. Per sub-step a
  // lower rate must buy MORE displacement -- that is what lets a shove outrun a
  // simulation deliberately slowed down to work carefully in.
  //
  // Restoring the old `* (steps / 30)` factor would make every strength here
  // identical, so this fails loudly rather than letting proportional come back.
  const slow = shoveState(input({ leftDragging: true }), ctx({ physicsSteps: 10 }));
  const mid = shoveState(input({ leftDragging: true }), ctx({ physicsSteps: 30 }));
  const fast = shoveState(input({ leftDragging: true }), ctx({ physicsSteps: 60 }));
  assert.ok(slow !== null && mid !== null && fast !== null);
  assert.ok(slow.strength > mid.strength, 'a low rate must shove harder per sub-step');
  assert.ok(mid.strength > fast.strength, 'a high rate must shove softer per sub-step');
});

test('the rate falloff is gentler than dividing the rate out entirely', () => {
  // What the 0.75 exponent BUYS, expressed as the property it was chosen for.
  // A full division (exponent 1) makes `strength * steps` constant; anything
  // less means a frame's total shove still grows with the rate, just sub-
  // linearly. Pinning the inequality rather than the constant keeps this true
  // for any exponent in (0, 1) while failing at both endpoints -- 1 would make
  // these equal, 0 would make the low rate's total the larger one.
  const lo = shoveState(input({ leftDragging: true }), ctx({ physicsSteps: 10 }));
  const hi = shoveState(input({ leftDragging: true }), ctx({ physicsSteps: 60 }));
  assert.ok(lo !== null && hi !== null);
  assert.ok(SHOVE_RATE_EXPONENT > 0 && SHOVE_RATE_EXPONENT < 1);
  assert.ok(
    hi.strength * 60 > lo.strength * 10,
    'a partial exponent must leave some rate dependence in the per-frame total',
  );

  // And the span across the full 1..60 slider is the 21.6x the exponent was
  // picked for, comfortably under the 60x a full division would give. Derived
  // from the constant rather than hardcoded, so retuning the exponent moves
  // this with it -- but the bound still catches a move to either endpoint.
  const span = (60 / 1) ** SHOVE_RATE_EXPONENT;
  assert.ok(span > 10 && span < 40, `expected a moderated span, got ${span}x`);
});

test('the default physics rate is unmoved by the exponent', () => {
  // THE ANCHOR. At the reference rate the formula must collapse to
  // `gain * power / 30` for ANY exponent -- that is what makes the exponent
  // safe to retune. A bare `steps ** 0.75` would land at ~12.8 here and
  // silently make the default brush 2.3x stronger.
  const s = shoveState(
    input({ leftDragging: true }),
    ctx({ physicsSteps: SHOVE_REFERENCE_STEPS }),
  );
  assert.ok(s !== null);
  assert.ok(
    Math.abs(s.strength - (SHOVE_GAIN * CTX.drawPower) / SHOVE_REFERENCE_STEPS) < 1e-12,
  );
});

test('strength scales with draw power', () => {
  // The slider is shared with Draw, and both must respond in the same direction.
  const weak = shoveState(input({ leftDragging: true }), ctx({ drawPower: 1.0 }));
  const strong = shoveState(input({ leftDragging: true }), ctx({ drawPower: 5.0 }));
  assert.ok(weak !== null && strong !== null);
  assert.ok(Math.abs(strong.strength - weak.strength * 5) < 1e-12);
});

test('a fractional physics rate truncates to at least one step', () => {
  // `Math.max(1, Math.trunc(...))`: the desktop's `max(1, int(...))`. A rate of
  // 0 would otherwise divide by zero and hand the GPU an Infinity.
  const s = shoveState(input({ leftDragging: true }), ctx({ physicsSteps: 0 }));
  assert.ok(s !== null);
  assert.ok(Number.isFinite(s.strength));
});

test('the centre is the cursor in world space and the size is the brush radius', () => {
  // Screen centre at zoom 1 with no pan is world origin. `uvRadiusToWorld` is
  // radius*2, and it lives in coords.ts rather than here (invariant 9).
  const s = shoveState(input({ mousePos: [512, 512], leftDragging: true }), CTX);
  assert.ok(s !== null);
  assert.ok(Math.abs(s.center[0]) < 1e-6 && Math.abs(s.center[1]) < 1e-6);
  assert.equal(s.size, CTX.drawSize * 2.0);
});

test('the three tuning constants have their documented values', () => {
  assert.equal(SHOVE_GAIN, 0.004);
  assert.equal(SHOVE_REFERENCE_STEPS, 30.0);
  assert.equal(SHOVE_RATE_EXPONENT, 0.75);
});
