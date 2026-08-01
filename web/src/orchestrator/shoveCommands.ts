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
 * frame's advance. That makes it per-sub-step, so the strength is divided by the
 * physics rate before it reaches the GPU (see `shoveState`).
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
 * The physics rate a shove is tuned against. Shove strength is PROPORTIONAL to
 * the rate -- the tool pushes as fast as the simulation is running, so a shove
 * keeps its weight relative to everything else moving on screen instead of
 * becoming a feeble nudge at high rates and a shunt at low ones. This is the
 * rate where that scaling is 1x.
 */
export const SHOVE_REFERENCE_STEPS = 30.0;

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

  // PER SUB-STEP, so a frame's total shove scales with the sub-step count -- a
  // shove is as fast as the simulation it is pushing.
  //
  // DO NOT COLLAPSE THIS TO `/ SHOVE_REFERENCE_STEPS`, which it algebraically
  // equals. The two factors mean different things: the `/ steps` is what
  // per-sub-step application requires, and the `* (steps / 30)` is the
  // deliberate reintroduction of the rate. A bare `/ 30` would read as an
  // arbitrary constant, and a later edit to either half would be
  // unattributable.
  const steps = Math.max(1, Math.trunc(ctx.physicsSteps));
  let strength = ((SHOVE_GAIN * ctx.drawPower) / steps) * (steps / SHOVE_REFERENCE_STEPS);
  if (pulling) strength = -strength;

  // The brush's sigma, in the world metric the shader measures in. The
  // conversion lives in `coords.ts`, not here (invariant 9).
  return { center, strength, size: uvRadiusToWorld(ctx.drawSize) };
}
