/**
 * Shove: pushing particles around with the cursor, directly.
 *
 * A port of `orchestrator/shove_commands.py` (105 lines).
 *
 * THE DIFFERENCE FROM DRAW, which is the thing worth being clear about: Draw
 * paints the Strafe Field, which then keeps pushing whatever crosses it until it
 * is erased. Shove acts on the particles themselves and leaves nothing behind --
 * it exists only on the frames the button is held. One is painting a force, the
 * other is applying one.
 *
 * Both share a brush, though: Shove reads `drawSize` and `drawPower` from the
 * same Drawing Controls, and the reticle shows the same circle. There is one
 * brush in this app; the tool decides what it does.
 *
 * WHY THIS RUNS INSIDE THE PHYSICS LOOP, unlike painting. The field is a texture
 * that persists between steps, so it can be written once per frame and read many
 * times. A shove has nothing to persist in -- it has to be applied as the
 * particles move, or it would be a single jump at one arbitrary point in the
 * frame's advance. That makes it per-sub-step, so the strength is scaled down by
 * the physics rate before it reaches the GPU -- by `steps ** 0.75` rather than
 * `steps`, which leaves the brush deliberately stronger at low rates without the
 * full 30x swing a plain division gives (see `shoveState`).
 *
 * A pure function, not a mixin. The desktop reaches through `self` for the
 * camera, the window and the prefs; here every dependency is an argument, which
 * is the composition-over-MRO argument the port has been making since Step 7 --
 * and this is the last module to make good on it.
 */

import { screenToWorld, uvRadiusToWorld } from '../particleSystem/coords.ts';
import type { ShoveState } from '../particleSystem/uniforms.ts';
import type { InputState } from '../ui/inputState.ts';
import type { MouseMode } from './commands.ts';

/**
 * Converts `drawPower` into a world-space displacement per frame. Tuned so the
 * default power moves a particle a visible but controllable distance -- about a
 * twentieth of the world per second of holding the button.
 *
 * Divided by `drawPower`'s own 0.1..5 range rather than normalized against it:
 * the slider is shared with Draw, and the two tools should respond to it in the
 * same direction even though they act on different things.
 */
export const SHOVE_GAIN = 0.004;

/**
 * The physics rate `SHOVE_GAIN` was tuned at -- the default -- and the anchor
 * the rate falloff pivots around. Strength here is exactly `gain * power / 30`
 * whatever `SHOVE_RATE_EXPONENT` is set to, which is what lets the exponent be
 * retuned without silently restrengthening the default brush.
 *
 * It is also what makes `SHOVE_GAIN`'s magnitude readable: "a twentieth of the
 * world per second" is a claim about 30 sub-steps a frame. If the gain is ever
 * retuned at another rate, this is the number that has to move with it.
 */
export const SHOVE_REFERENCE_STEPS = 30.0;

/**
 * How hard Physics Rate pulls back on shove strength. See `shoveState` for the
 * three positions on this axis and why this one was chosen.
 *
 * 1 divides the rate out completely (a frame's total shove identical at every
 * rate); 0 leaves it fully in (strength proportional to the rate). At 0.75 the
 * brush still gets stronger as the rate drops -- the behaviour this is for --
 * but across the full 1..60 slider that is a 21.6x span rather than 60x, and
 * the bottom of the slider sits 12.8x above the default rather than 30x.
 */
export const SHOVE_RATE_EXPONENT = 0.75;

/** What `shoveState` needs to see. Everything, explicitly. */
export interface ShoveContext {
  readonly mouseMode: MouseMode;
  readonly paused: boolean;
  readonly windowSize: readonly [number, number];
  readonly canvasSize: readonly [number, number];
  readonly pan: readonly [number, number];
  readonly zoom: number;
  readonly physicsSteps: number;
  readonly drawPower: number;
  readonly drawSize: number;
}

/**
 * The live shove for this frame, or `null` when nothing is being shoved.
 *
 * Returns centre, strength and size in WORLD units, ready to hand to
 * `ParticleSystem.runFrame`. Strength is SIGNED: positive pushes away from the
 * cursor, negative pulls in.
 *
 * Reads `*Dragging` rather than `*Held` for the same reason painting does: a
 * drag belongs to whoever received the press, so a shove that began on the
 * canvas survives the cursor crossing a panel, and a press that landed on a
 * panel never starts one.
 *
 * RETURNS NULL WHILE PAUSED, so a frozen frame stays frozen. The guard lives
 * here rather than at the call site: "paused means nothing shoves" is a property
 * of the shove, and a second caller that forgot to check would silently defeat
 * the pause.
 */
export function shoveState(state: InputState, ctx: ShoveContext): ShoveState | null {
  if (ctx.paused || ctx.mouseMode !== 'shove') return null;

  const pushing = state.leftDragging;
  // Left wins when both buttons are down, matching the Draw tool -- a stray
  // right-click mid-shove should not suddenly reverse the pull.
  const pulling = state.rightDragging && !pushing;
  if (!pushing && !pulling) return null;

  const center = screenToWorld(
    state.mousePos,
    ctx.windowSize,
    ctx.canvasSize,
    ctx.pan,
    ctx.zoom,
  );

  // PER SUB-STEP, hence dividing by a power of `steps` at all: the shader
  // applies this value once per sub-step, so without a divisor a frame's total
  // shove would be `steps`x stronger and Physics Rate would silently be a
  // strength slider.
  //
  // THE EXPONENT IS THE TUNING KNOB, and it is deliberately not 1. Three
  // positions on one axis, all of which this codebase has held:
  //
  //   exponent 0   -- multiply the rate straight back in. Strength proportional
  //                   to Physics Rate. Rejected: the brush goes limp exactly at
  //                   the low rates people select in order to place things
  //                   carefully, because everything it pushes slows down and it
  //                   slows with them.
  //   exponent 1   -- a frame's total shove identical at every rate. Correct in
  //                   principle, but rate 1 then bites 30x harder than the
  //                   default, which overshoots at the bottom of the slider.
  //   exponent .75 -- here. Still stronger as the rate falls, which is the whole
  //                   point, but 12.8x above the default at rate 1 instead of
  //                   30x (21.6x rather than 60x across the whole 1..60 range).
  //
  // ANCHORED AT THE REFERENCE RATE so the exponent reshapes the curve without
  // moving the default. `steps ** 0.75` alone would be ~12.8 at 30 rather than
  // 30, quietly making the default shove 2.3x stronger; dividing by the
  // reference raised to the same power pins the default to the value it has
  // always had and lets the exponent change only the slope around it.
  const steps = Math.max(1, Math.trunc(ctx.physicsSteps));
  const falloff =
    steps ** SHOVE_RATE_EXPONENT / SHOVE_REFERENCE_STEPS ** (SHOVE_RATE_EXPONENT - 1);
  let strength = (SHOVE_GAIN * ctx.drawPower) / falloff;
  if (pulling) strength = -strength;

  // The brush's sigma, in the world metric the shader measures in. The
  // conversion lives in `coords.ts`, not here (invariant 9).
  return { center, strength, size: uvRadiusToWorld(ctx.drawSize) };
}
