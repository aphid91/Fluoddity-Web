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

    def _pick_params(self, pixel):
        """(target_world, radius_world) for a pick at a screen pixel.

        The one place the pick inputs are built, so a dispatch and anything
        that reasons about the same pick cannot disagree about where it was
        aimed or how wide it searched.

        The radius is specified in screen pixels and converted through the view
        transform, so the tolerance feels identical at any zoom -- a
        world-space radius would shrink on screen as you zoom out.
        """
        cam = self.camera.state
        window_size = self.window.size()
        canvas_size = self.system.canvas_size

        target = coords.screen_to_world(pixel, window_size, canvas_size,
                                        cam.pan, cam.zoom)
        radius = radius_px_to_world(DEFAULT_PICK_RADIUS_PX, window_size,
                                    canvas_size, cam.pan, cam.zoom)
        return target, radius

    def _cmd_select_particle(self, pixel):
        """Begin adopting the rule of the particle under `pixel`.

        ASYNCHRONOUS: this dispatches the pick and records what it will need to
        finish. The result is read next frame by _resolve_pending_selection(),
        because reading it now would stall the GPU -- and WebGPU, the port
        target, has no synchronous readback at all (see picker.py).

        `before` is captured HERE, at click time, not when the result arrives:
        history must record against the project as it was when the user
        clicked. Anything that changes the project in the intervening frame
        would otherwise be swallowed into this entry.

        A SECOND CLICK WHILE ONE IS PENDING REPLACES IT -- last click wins, with
        its own `before`. The dispatch is overwritten by the new one regardless
        (the picker has a single result slot), so honouring the older click
        would mean adopting a rule from a pick aimed somewhere else.
        """
        target, radius = self._pick_params(pixel)
        self.system.request_pick(target, radius)
        self._pending_selection = self.project

    def _resolve_pending_selection(self):
        """Finish a selection whose pick was dispatched on an earlier frame.

        Called once per frame from the frame loop, BEFORE advance(), which is
        also where the picking slot has always been in the frame order. It must
        not live inside advance(): that is skipped while paused, and clicking
        while paused has to keep working.

        A miss is dropped silently -- clicking empty space should do nothing,
        not reset anything.

        SELECTING ON AN UNAUTHORED CONFIG IS THE INTERESTING CASE. After
        Randomize Behavior the config's rule is all zeros -- a sentinel meaning
        "generate one" -- and the particles obey a rule that exists only on the
        GPU. entity_rule() reproduces it exactly (generated rules are not
        mutated, on either side), and adopting the result writes it into the
        config as a real rule, so the sentinel stops firing from here on.
        """
        if self._pending_selection is None:
            return
        before = self._pending_selection
        self._pending_selection = None

        result = self.system.retrieve_pick()
        self.selected = result
        if not result.hit:
            return

        config = self.project.config
        rule = mutation.entity_rule(config, result.index,
                                    self.system.entity_count())

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
