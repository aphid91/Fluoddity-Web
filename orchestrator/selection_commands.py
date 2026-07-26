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
    """What a left-click on the canvas does.

    Exists because left-drag pans and left-click selects, and they cannot both
    own the button -- without a mode, every attempt to pan would select a
    particle on mouse-down.

    CAMERA  drag pans. The default: navigation is the common case.
    SELECT  click adopts a particle's rule, right-click undoes.
    """

    CAMERA = 'camera'
    SELECT = 'select'

    def next(self) -> "MouseMode":
        members = list(MouseMode)
        return members[(members.index(self) + 1) % len(members)]


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
        """
        result = self._pick_at(pixel)
        self.selected = result
        if not result.hit:
            return

        config = self.project.config
        rule = mutation.entity_rule(config, result.index,
                                    self.system.entity_count())

        self._push_history(f"select particle #{result.index}")
        self._set_project(self.project.adopt_rule(rule))

    def _cmd_toggle_mouse_mode(self):
        self.mouse_mode = self.mouse_mode.next()

    def _cmd_undo(self):
        """Placeholder until history lands (next commit).

        Right-click in SELECT mode already routes here, so the binding exists
        from the moment selection does.
        """
        history = getattr(self, 'history', None)
        if history is None:
            return
        previous = history.undo()
        if previous is not None:
            self._set_project(previous)

    def _cmd_redo(self):
        history = getattr(self, 'history', None)
        if history is None:
            return
        nxt = history.redo()
        if nxt is not None:
            self._set_project(nxt)

    def _push_history(self, label):
        """Record the current project so the coming change can be undone.

        Defined here as a no-op hook until the history system lands, so the
        selection path already has its call site in the right place.
        """
        history = getattr(self, 'history', None)
        if history is not None:
            history.push(self.project, label)
