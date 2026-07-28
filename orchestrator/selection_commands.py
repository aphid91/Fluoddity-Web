"""Particle selection: adopt a clicked particle's behaviour as the base rule.

Every particle obeys a *mutated* version of its config's rule, varying by
cohort. Selection promotes one of those variants to be the new base rule --
"that one, do more of that" -- and the population then re-mutates around it.

HOW THE RULE IS OBTAINED
Recomputed host-side (particle_system/mutation.py), not read back from the GPU.
The mutation is deterministic in (rule, scale, seed, cohort), so Python can
reproduce it exactly; a probe test compares the two over a range of inputs.
That avoids the extra buffer and readback the original needed -- and avoids
async readback in the WebGPU port.

WHY mutation_scale IS LEFT ALONE
Adopting a mutated rule while keeping the scale means the population keeps
exploring around the new centre, which is the useful behaviour. It also means
selection changes exactly one field, so undo is unambiguous.

PICKING IS ON DEMAND. A pick dispatches over every entity -- tens of
milliseconds per frame at large world sizes. It runs on the click, never per
frame.
"""

from __future__ import annotations

from enum import Enum

from particle_system import coords, mutation
from particle_system.picker import DEFAULT_PICK_RADIUS_PX, radius_px_to_world


class MouseMode(Enum):
    """What the mouse does on the canvas. The active TOOL.

    Exists because several different behaviours all want the left button --
    without a mode, every click would select a particle on the way down and
    paint on the way across.

    SELECT  click adopts a particle's rule, right-click undoes.
    SHOVE   drag pushes particles away from the cursor, right-drag pulls them in.
    DRAW    drag paints the strafe field, right-drag erases.

    SHOVE and DRAW are easy to confuse and worth stating apart: Shove acts on
    the PARTICLES, directly and only while the button is held. Draw paints the
    FIELD, which then keeps pushing whatever crosses it until it is erased.

    THERE IS NO PAN TOOL. Navigation moved to the keyboard (WASD to pan, Q/E to
    zoom, and the scroll wheel), which frees the mouse for tools entirely --
    a tool that only moved the view was spending a button on something the
    keyboard does better, and while held it blocked everything else.

    MEMBER ORDER IS THE TOOLBAR ORDER and the 1/2/3 key order. The toolbar
    builds itself from this enum, so adding a tool here adds a button.
    """

    SELECT = 'select'
    SHOVE = 'shove'
    DRAW = 'draw'

    @classmethod
    def from_value(cls, value) -> "MouseMode | None":
        """Look up a mode by its string value, or None if unknown.

        The UI reports tools as plain strings so it never imports a simulation
        module (ARCHITECTURE rule 10); this is where the string becomes typed.
        """
        for member in cls:
            if member.value == value:
                return member
        return None


class SelectionCommands:
    """Selection handlers. Expects the Orchestrator's attributes."""

    def _pick_at(self, pixel):
        """Nearest entity to a screen pixel, or a miss.

        Blocking on purpose: a click is a one-shot action and needs *this*
        frame's answer. The deferred `pick()` returns the previous dispatch's
        result, which is right for continuous hovering and wrong here.
        """
        cam = self.camera.state
        window_size = self.window.size()
        canvas_size = self.system.canvas_size

        target = coords.screen_to_world(pixel, window_size, canvas_size,
                                        cam.pan, cam.zoom)
        radius = radius_px_to_world(DEFAULT_PICK_RADIUS_PX, window_size,
                                    canvas_size, cam.pan, cam.zoom)
        return self.system.pick_blocking(target, radius)

    def _cmd_select_particle(self, pixel):
        """Adopt the rule of the particle under `pixel`.

        A miss leaves everything untouched -- clicking empty space should do
        nothing, not reset anything.

        SELECTING ON AN UNAUTHORED CONFIG IS THE INTERESTING CASE. After
        Randomize Behavior the config's rule is all zeros -- a sentinel meaning
        "generate one" -- and the particles obey a rule that exists only on the
        GPU. entity_rule() reproduces it exactly (generated rules are not
        mutated, on either side), and adopting the result writes it into the
        config as a real rule, so the sentinel stops firing from here on.
        """
        result = self._pick_at(pixel)
        self.selected = result
        if not result.hit:
            return

        config = self.project.config
        rule = mutation.entity_rule(config, result.index,
                                    self.system.entity_count())

        before = self.project
        self._set_project(self.project.adopt_rule(rule))
        self._record_history(before, f"select particle #{result.index}")

    def _cmd_set_mouse_mode(self, mode):
        """Select a tool directly, by MouseMode or by its string value.

        Direct selection rather than a cycle: with three tools, cycling to reach
        the one you want is tedious, and a toolbar has no sensible "next".
        Switching tools abandons any stroke in progress, so releasing the button
        over a different tool cannot resume painting.
        """
        resolved = mode if isinstance(mode, MouseMode) else MouseMode.from_value(mode)
        if resolved is None:
            return
        self.mouse_mode = resolved
        self._end_stroke()

    def _cmd_undo(self):
        """Step back along the history timeline.

        Bound to Ctrl+Z and to right-click while in SELECT mode, mirroring the
        original's binding.
        """
        # Undo is not a continuation of whatever gesture preceded it: without
        # this, resuming a drag afterwards would rewrite the entry just
        # stepped back to.
        self.history.break_coalescing()
        previous = self.history.undo()
        if previous is not None:
            self._set_project(previous)

    def _cmd_redo(self):
        self.history.break_coalescing()
        nxt = self.history.redo()
        if nxt is not None:
            self._set_project(nxt)

    def _record_history(self, before, label, coalesce_key=None):
        """Record an undoable step from `before` to the current project.

        Called by every deliberate act. Deliberately NOT from _set_project --
        hover-preview and undo/redo flow through there too, and neither belongs
        in history (see project/history.py).

        `coalesce_key` merges a continuous gesture into one entry; pass None
        for one-shot acts so they always stand alone.
        """
        if before is not self.project:
            self.history.record(before, self.project, label, coalesce_key)

    def _pre_preview_project(self, fallback):
        """The state from before any hover-preview began, or `fallback`.

        A committed load arrives with the project ALREADY moved by the preview
        that was showing when the user clicked. Recording `before = live` would
        see no change and skip the entry, so commits record against what was
        live before browsing started.
        """
        return self._preview_origin if self._preview_origin is not None else fallback
