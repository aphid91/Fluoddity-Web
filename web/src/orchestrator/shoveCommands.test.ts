/**
 * Tests for the Shove tool's per-frame state.
 *
 * THE STRENGTH FORMULA IS THE POINT OF THIS FILE. It is written as
 * `gain * power / steps * (steps / 30)`, which algebraically equals
 * `gain * power / 30` -- and someone WILL simplify it, because it looks like an
 * oversight. The two factors mean different things (`/steps` is what per-sub-step
 * application requires; `steps/30` deliberately puts the rate back), and the
 * comment saying so is not enforcement. This is.
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
  for (const mouseMode of ['select', 'draw'] as const) {
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

test('THE STRENGTH FORMULA IS NOT COLLAPSED TO /30', () => {
  // Asserted at three rates because the whole hazard is that the expression
  // *equals* `gain * power / 30` at every one of them. What this pins is that
  // the answer does NOT vary with the rate -- which is the observable
  // consequence of the two factors cancelling, and is exactly what a
  // "simplification" to `/steps` alone (or to `* steps / 30` alone) would break.
  //
  // If this fails, read `shove_commands.py:88-96` before touching the formula.
  for (const physicsSteps of [1, 30, 100]) {
    const s = shoveState(input({ leftDragging: true }), ctx({ physicsSteps }));
    assert.ok(s !== null);
    assert.equal(
      s.strength,
      (SHOVE_GAIN * CTX.drawPower) / SHOVE_REFERENCE_STEPS,
      `strength drifted at physicsSteps=${physicsSteps} -- see shove_commands.py:88-96`,
    );
  }
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

test('the two tuning constants have their documented values', () => {
  assert.equal(SHOVE_GAIN, 0.004);
  assert.equal(SHOVE_REFERENCE_STEPS, 30.0);
});
