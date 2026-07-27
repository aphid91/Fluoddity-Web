"""Shove: pushing particles around with the cursor, directly.

THE DIFFERENCE FROM DRAW, which is the thing worth being clear about: Draw
paints the Strafe Field, which then keeps pushing whatever crosses it until it
is erased. Shove acts on the particles themselves and leaves nothing behind --
it exists only on the frames the button is held. One is painting a force, the
other is applying one.

Both share a brush, though: Shove reads `draw_size` and `draw_power` from the
same Drawing Controls, and the reticle shows the same circle. There is one
brush in this app; the tool decides what it does.

WHY THIS RUNS INSIDE THE PHYSICS LOOP, unlike painting. The field is a texture
that persists between steps, so it can be written once per frame and read many
times. A shove has nothing to persist in -- it has to be applied as the
particles move, or it would be a single jump at one arbitrary point in the
frame's advance. That makes it per-sub-step, which is exactly what
prefs.physics_steps scales, so the strength is divided by that count before it
reaches the GPU (see shove_state).

Mixed into the Orchestrator; owns no state of its own.
"""

from __future__ import annotations

from particle_system import coords

from .selection_commands import MouseMode

#: Converts draw_power into a world-space displacement per frame. Tuned so the
#: default power moves a particle a visible but controllable distance -- about
#: a twentieth of the world per second of holding the button.
#:
#: Divided by draw_power's own 0.1..5 range rather than normalized against it:
#: the slider is shared with Draw, and the two tools should respond to it in
#: the same direction even though they act on different things.
SHOVE_GAIN = 0.004


class ShoveCommands:
    """Shove handlers. Expects the Orchestrator's attributes."""

    def shove_state(self, state):
        """The live shove for this frame, or None when nothing is being shoved.

        Returns (center_x, center_y, strength, size) in WORLD units, ready to
        hand to ParticleSystem.advance(). Strength is SIGNED: positive pushes
        away from the cursor, negative pulls in.

        Reads *_dragging rather than *_held for the same reason painting does:
        a drag belongs to whoever received the press, so a shove that began on
        the canvas survives the cursor crossing a panel, and a press that
        landed on a panel never starts one.

        Returns None while PAUSED, so a frozen frame stays frozen. The guard
        lives here rather than at the call site: "paused means nothing shoves"
        is a property of the shove, and a second caller that forgot to check
        would silently defeat the pause.
        """
        if self.paused or self.mouse_mode is not MouseMode.SHOVE:
            return None

        pushing = state.left_dragging
        # Left wins when both buttons are down, matching the Draw tool -- a
        # stray right-click mid-shove should not suddenly reverse the pull.
        pulling = state.right_dragging and not pushing
        if not (pushing or pulling):
            return None

        cam = self.camera.state
        center = coords.screen_to_world(state.mouse_pos, self.window.size(),
                                        self.system.canvas_size,
                                        cam.pan, cam.zoom)

        # Divided by the sub-step count, so holding the button for one frame
        # moves a particle the same distance at 30 steps as at 120. Without
        # this the Physics Rate slider would silently be a strength slider too.
        steps = max(1, int(self.prefs.physics_steps))
        strength = SHOVE_GAIN * self.prefs.draw_power / steps
        if pulling:
            strength = -strength

        # The brush's sigma, in the world metric the shader measures in. The
        # conversion lives in coords.py, not here (rule 9).
        size = coords.uv_radius_to_world(self.prefs.draw_size)

        return (center[0], center[1], strength, size)
