"""Drawing: translating mouse gestures into strokes on the strafe field.

The field itself (texture, shader, blending) lives in strafe_field/. This is the
half that decides WHEN to paint and WHERE -- which is the Orchestrator's job,
because it is the only thing that can see the camera, the input snapshot and the
field at once.

STROKE CONTINUITY
A stroke is a chain of segments, one per rendered frame, each running from where
the cursor was last frame to where it is now. `_stroke_prev_uv` is that memory,
and clearing it on button release is what makes the next press start a fresh
stroke rather than drawing a line from wherever the last one ended.

CADENCE
Once per RENDERED frame, never per physics sub-step. advance() runs
prefs.physics_steps times a frame (30 by default); painting in that loop would
make the brush 30x stronger and would couple stroke weight to the simulation
rate, so that moving the Physics Steps slider changed how hard you were drawing.

Mixed into the Orchestrator; owns no state of its own.
"""

from __future__ import annotations

import dataclasses

from particle_system import coords


class DrawingCommands:
    """Drawing handlers. Expects the Orchestrator's attributes."""

    def _mouse_field_uv(self, pixel):
        """Screen pixel -> field texture uv [0,1].

        COMPOSED from coords, never reimplemented. The reference carried six
        divergent copies of this transform and its overlays never quite lined up
        with its simulation as a result; coords.py exists to make that
        impossible. screen_to_world is the same call picking uses, so a brush
        lands exactly where a click would select.

        The screen->world half is the CANVAS's transform -- that is the space
        the camera shows and the particles live in. The world->uv half is the
        FIELD's, because the field may be lower resolution than the canvas
        (see MAX_FIELD_DIM). Both agree today only because field_dimensions()
        preserves the canvas aspect and uv is normalized; reading the field's
        own size here says so out loud rather than relying on it.
        """
        cam = self.camera.state
        world = coords.screen_to_world(pixel, self.window.size(),
                                       self.system.canvas_size,
                                       cam.pan, cam.zoom)
        return coords.world_to_uv(world, self.strafe_field.canvas_size)

    def _apply_draw_input(self, state):
        """Paint or erase, following the mouse.

        Reads *_dragging rather than *_held: a drag belongs to whoever received
        the press, so a stroke that began on the canvas survives the cursor
        crossing a panel, and a press that landed on a panel never starts one.
        That is the same reason panning uses it.
        """
        drawing = state.left_dragging
        # Left wins when both buttons are down, so a stray right-click mid-stroke
        # cannot punch a hole in what is being painted.
        erasing = state.right_dragging and not drawing

        if not (drawing or erasing):
            self._end_stroke()
            return

        uv = self._mouse_field_uv(state.mouse_pos)
        # First frame of a stroke: the segment collapses to a point, which is
        # exactly the right splat. Seeding from the CURRENT position is what
        # prevents a phantom streak across the canvas from wherever the previous
        # stroke ended -- a real bug in the reference implementation.
        prev = self._stroke_prev_uv if self._stroke_prev_uv is not None else uv

        if drawing:
            self.strafe_field.draw(uv, prev, self.prefs.draw_size,
                                   self.prefs.draw_power)
        else:
            self.strafe_field.erase(uv, prev, self.prefs.draw_size)

        self._stroke_prev_uv = uv

    def _end_stroke(self):
        """Forget the stroke in progress, so the next press starts a new one."""
        self._stroke_prev_uv = None

    def _cmd_clear_strafe_field(self):
        """Zero the field. The only reset -- it is not in the undo timeline."""
        self.strafe_field.clear()

    def _cmd_edit_draw_pref(self, field, value):
        """Set one drawing preference.

        Drawing controls are PREFS: editor state, saved to preferences.json but
        never to a config, and never recorded in history -- loading someone
        else's config must not resize your brush, and there is no project state
        for undo to restore.

        None is disruptive, so this skips the rebuild check in _edit_preference
        and just writes. The unchanged-value early-out matters: imgui reports a
        slider as changed on frames where the value did not actually move, and
        each of those would otherwise be a disk write.

        Coerced to the field's DECLARED type rather than blanket float(): the
        overlay toggles are booleans, and a float() here would land `1.0` in
        preferences.json where `true` belongs.
        """
        updated = self.prefs.with_value(field, _coerce(self.prefs, field, value))
        if updated == self.prefs:
            return
        self.prefs = updated
        self.prefs.save()


def _coerce(prefs, field, value):
    """`value` as whatever type `field` is declared to hold on Preferences.

    Unknown fields pass through untouched; with_value() drops them anyway.
    """
    declared = {f.name: f.type for f in dataclasses.fields(prefs)}.get(field)
    if declared in (bool, 'bool'):
        return bool(value)
    if declared in (int, 'int'):
        return int(value)
    if declared in (float, 'float'):
        return float(value)
    return value
