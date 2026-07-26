"""Undo/redo over whole projects.

WHAT IS UNDOABLE, AND WHY SO LITTLE

Only two operations record history: **particle selection** and **mutation seed
randomization**. Deliberately not slider edits, config loads, previews, or
config add/remove.

The temptation is to hook `Orchestrator._set_project()` -- every project change
funnels through it, so one line would capture everything. That is exactly why
it would be wrong: two of its callers are hover-preview (fires as the cursor
crosses rows in the Load menu) and two are slider edits (fires per drag-frame).
Hooking there would bury the handful of entries a user actually wants under
hundreds of spurious ones from browsing a list for a few seconds.

The two operations here share a shape: a single discrete act with a
non-obvious, randomised result. Those are the ones worth taking back. Sliders
are their own undo -- drag them back -- and the Config Clipboard covers "I want
to return to a state I chose to remember".

HOW IT WORKS

Entries hold references to `Project`, which is immutable, so a snapshot costs a
pointer rather than a copy. `undo`/`redo` move a cursor rather than destroying
state, which is what makes redo nearly free -- the original had no redo because
its stack popped entries away.
"""

from __future__ import annotations

from dataclasses import dataclass

from .project import Project

#: Entries kept before the oldest is dropped. The original used 200; entries
#: are cheap references, so the bound is about predictable memory rather than
#: cost.
MAX_HISTORY = 100


@dataclass(frozen=True)
class HistoryEntry:
    """A project state and what the user did to leave it."""

    project: Project
    label: str


class History:
    """A bounded undo/redo timeline of project states.

    THE MODEL: `_states` is the full timeline, oldest first, and `_cursor` is
    the index of the state currently live. Undo decrements it, redo increments
    it, and both simply return `_states[_cursor]`.

    Framing it as "where am I on the timeline" rather than "what would undo
    restore" is what keeps the two operations symmetric -- an earlier version
    had the cursor trail the live state by one and needed different arithmetic
    in each direction, which was a bug waiting to happen.

    Because the live state is always *in* the timeline, callers seed it once at
    startup (see `record`).
    """

    def __init__(self, max_entries: int = MAX_HISTORY):
        #: The timeline, oldest first. Entry 0 has no label -- nothing produced
        #: it, it is simply where the session started.
        self._states: list[HistoryEntry] = []
        #: Index of the live state within _states; -1 while empty.
        self._cursor = -1
        self._max = max_entries

    # ------------------------------------------------------------------

    def record(self, before: Project, after: Project, label: str = "") -> None:
        """Record an undoable step from `before` to `after`.

        BOTH states are needed, and this is the subtle part. Most changes --
        slider drags especially -- do not record at all, so by the time an
        undoable action happens the live state has usually drifted away from
        whatever is on the timeline. Rewriting the current entry with `before`
        keeps those un-recorded edits: undo returns you to the moment just
        before you clicked, not to the last thing history happened to notice.

        Recording only `after` looked simpler and was wrong -- undoing a seed
        randomize silently threw away any slider edits made since the previous
        undoable action.
        """
        if self._states and self._cursor >= 0:
            # A new action invalidates any redo entries ahead of the cursor.
            del self._states[self._cursor + 1:]
            # Re-seat the current entry on the state actually being left.
            self._states[self._cursor] = HistoryEntry(project=before, label="")
        else:
            self._states.append(HistoryEntry(project=before, label=""))
            self._cursor = 0
        self._states.append(HistoryEntry(project=after, label=label))
        self._trim()

    def seed(self, project: Project) -> None:
        """Put the session's starting state on the timeline."""
        self._states = [HistoryEntry(project=project, label="")]
        self._cursor = 0

    def _trim(self):
        while len(self._states) > self._max:
            del self._states[0]
        self._cursor = len(self._states) - 1

    def undo(self) -> Project | None:
        """Move one step back along the timeline. Returns the state to restore."""
        if not self.can_undo:
            return None
        self._cursor -= 1
        return self._states[self._cursor].project

    def redo(self) -> Project | None:
        """Move one step forward along the timeline."""
        if not self.can_redo:
            return None
        self._cursor += 1
        return self._states[self._cursor].project

    # ------------------------------------------------------------------

    @property
    def can_undo(self) -> bool:
        return self._cursor > 0

    @property
    def can_redo(self) -> bool:
        return 0 <= self._cursor < len(self._states) - 1

    @property
    def depth(self) -> int:
        """Number of states on the timeline, including the live one."""
        return len(self._states)

    @property
    def cursor(self) -> int:
        return self._cursor

    def undo_label(self) -> str:
        """What undo would take back, for menu text. Empty when nothing would."""
        if not self.can_undo:
            return ""
        return self._states[self._cursor].label

    def clear(self) -> None:
        self._states.clear()
        self._cursor = -1
