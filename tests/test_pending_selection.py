"""Async selection records history against the state from CLICK time.

WHY THIS TEST EXISTS
Selection is two-phase: the click dispatches a pick, and the NEXT frame adopts
the winner's rule. That split creates a way to get history wrong -- recording
against the project as it stands when the result lands, rather than as it stood
when the user clicked. Anything that changed the project in between would then
be swallowed into the selection's undo entry.

It also pins the last-click-wins rule for a second click arriving while one is
still pending.

No GPU needed: this exercises the Orchestrator's pending-selection bookkeeping
against fakes, which is where the ordering bug would live.

    Scratch.venv/Scripts/python.exe tests/test_pending_selection.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from orchestrator.selection_commands import SelectionCommands  # noqa: E402
from particle_system.picker import MISS, PickResult  # noqa: E402


class FakeSystem:
    """Records requests; returns whatever result the test queues."""

    def __init__(self):
        self.requests = []
        self.queued = MISS

    def request_pick(self, target, radius):
        self.requests.append((target, radius))

    def retrieve_pick(self):
        return self.queued

    #: A property on the real ParticleSystem (E7), so the fake matches -- a
    #: fake with a different access shape would hide a broken call site.
    entity_count = 1000


class Harness(SelectionCommands):
    """The Orchestrator's selection half, with everything else stubbed."""

    def __init__(self):
        self.system = FakeSystem()
        self.project = 'P0'
        self.selected = MISS
        self._pending_selection = None
        self.recorded = []

    # -- the collaborators SelectionCommands calls into --
    def _pick_params(self, pixel):
        return (float(pixel[0]), float(pixel[1])), 0.05

    def _set_project(self, project):
        self.project = project

    def _record_history(self, before, label, coalesce_key=None):
        self.recorded.append((before, self.project, label))


class P(str):
    """A stand-in Project: a string that can be compared and adopted into.

    Adoption returns a NEW value, like the real immutable Project, so a test
    can see exactly which state an entry was recorded against.
    """

    config = object()          # only ever passed through to entity_rule

    def adopt_rule(self, rule):
        return P(f"{self}+{rule}")


def _adopting(system, index):
    """Queue a hit at `index`."""
    system.queued = PickResult(index=index, pos=(0.0, 0.0), distance=0.01)


def check(name, cond):
    print(f"  {'OK  ' if cond else 'FAIL'} {name}")
    return 0 if cond else 1


def main() -> int:
    import particle_system.mutation as mutation

    # entity_rule is exercised by the mutation probe test; here it only has to
    # be deterministic, so the adopted project is predictable.
    mutation.entity_rule = lambda config, index, count: f"rule{index}"

    fails = 0

    # -- 1. the click does not resolve anything by itself --------------------
    h = Harness()
    _adopting(h.system, 42)
    h.project = P('P0')
    h._cmd_select_particle((10.0, 20.0))
    fails += check("click dispatches exactly one pick", len(h.system.requests) == 1)
    fails += check("click does not change the project", h.project == 'P0')
    fails += check("click records no history yet", h.recorded == [])
    fails += check("click captures before-state", h._pending_selection == 'P0')

    # -- 2. the project moves between click and resolve ----------------------
    # This is the case the two-phase split makes possible: something else edits
    # the project while the pick is in flight.
    h.project = P('P1_edited_while_in_flight')
    h._resolve_pending_selection()
    fails += check("resolve records ONE entry", len(h.recorded) == 1)
    before, after, label = h.recorded[0]
    fails += check("history 'before' is the CLICK-time project (P0), "
                   f"not the in-flight edit (got {before!r})", before == 'P0')
    fails += check("history 'after' is the adopted project",
                   after == 'P1_edited_while_in_flight+rule42')
    fails += check("label names the entity", label == 'select particle #42')
    fails += check("pending cleared after resolve", h._pending_selection is None)

    # -- 3. resolving again does nothing -------------------------------------
    h.recorded.clear()
    h._resolve_pending_selection()
    fails += check("second resolve is a no-op", h.recorded == [])

    # -- 4. a MISS changes nothing but `selected` ----------------------------
    h2 = Harness()
    h2.project = P('Q0')
    h2.system.queued = MISS
    h2._cmd_select_particle((1.0, 1.0))
    h2._resolve_pending_selection()
    fails += check("miss records no history", h2.recorded == [])
    fails += check("miss leaves the project alone", h2.project == 'Q0')
    fails += check("miss clears pending", h2._pending_selection is None)

    # -- 5. last click wins, with ITS OWN before-state -----------------------
    h3 = Harness()
    h3.project = P('R0')
    _adopting(h3.system, 7)
    h3._cmd_select_particle((5.0, 5.0))        # first click, before = R0
    h3.project = P('R1')                        # project moves
    h3._cmd_select_particle((6.0, 6.0))        # second click, before = R1
    fails += check("second click replaces the pending record",
                   h3._pending_selection == 'R1')
    fails += check("both clicks dispatched", len(h3.system.requests) == 2)
    h3._resolve_pending_selection()
    fails += check("only one entry recorded", len(h3.recorded) == 1)
    fails += check("it records against the SECOND click's state",
                   h3.recorded[0][0] == 'R1')

    print("\nPASS" if not fails else f"\nFAIL: {fails} check(s)")
    return 1 if fails else 0


if __name__ == '__main__':
    raise SystemExit(main())
