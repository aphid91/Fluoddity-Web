"""Undo/redo over whole projects.

WHAT IS UNDOABLE

Every deliberate act: slider edits, particle selection, seed randomization,
committed loads, preset cycling, checkpoint restores, and config
add/duplicate/remove.

TWO THINGS ARE DELIBERATELY EXCLUDED, and neither is an oversight:

  HOVER-PREVIEW (and its restore). The Load menu and Config Clipboard apply a
  config as the cursor crosses each row, then put it back when you move away.
  These are transient states the user never chose -- browsing a list of forty
  configs would otherwise leave forty entries and evict real work. Only the
  COMMITTED load records. Coalescing cannot help here: previews are not rapid
  edits to merge, they revert themselves.

  UNDO AND REDO. They call the same _set_project() everything else does, so
  recording them would make undo push a history entry -- history about history.

COALESCING

A slider drag fires an edit per frame; without merging, two seconds of dragging
would be a hundred entries. Consecutive records sharing a `coalesce_key` within
COALESCE_WINDOW seconds collapse into one: the entry's *end* state is updated
in place while its start state stays put, so undo jumps over the whole gesture.

Keying on the field means moving to a different slider starts a new entry, and
pausing does too. Deliberate one-shot acts pass no key, so they never merge --
randomizing the seed twice in a row is two undo steps, which is what you want
from a button.

HOW IT WORKS

Entries hold references to `Project`, which is immutable, so a snapshot costs a
pointer rather than a copy. `undo`/`redo` move a cursor rather than destroying
state, which is what makes redo nearly free -- the original had no redo because
its stack popped entries away.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from .project import Project

#: Entries kept before the oldest is dropped. The original used 200; with
#: coalescing a drag is one entry, so 100 covers a long session of real actions.
MAX_HISTORY = 100

#: Seconds within which same-key records merge. Long enough to bridge the gaps
#: in a slider drag, short enough that a deliberate second adjustment is its
#: own undo step.
COALESCE_WINDOW = 0.5


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

    def __init__(self, max_entries: int = MAX_HISTORY,
                 coalesce_window: float = COALESCE_WINDOW):
        #: The timeline, oldest first. Entry 0 has no label -- nothing produced
        #: it, it is simply where the session started.
        self._states: list[HistoryEntry] = []
        #: Index of the live state within _states; -1 while empty.
        self._cursor = -1
        self._max = max_entries
        self._window = coalesce_window
        #: (key, timestamp) of the last record, for merging a run of edits.
        self._last_key = None
        self._last_time = 0.0

    # ------------------------------------------------------------------

    def record(self, before: Project, after: Project, label: str = "",
               coalesce_key=None, now: float | None = None) -> None:
        """Record an undoable step from `before` to `after`.

        `coalesce_key` identifies a continuous gesture -- pass the field name
        for a slider so a drag merges into one entry. Pass None for one-shot
        acts, which then never merge.

        BOTH states are needed. Recording only `after` is wrong when anything
        reaches the project without recording (previews do), because the
        timeline would still hold a stale start state; re-seating the current
        entry on `before` means undo returns you to the moment just before you
        acted.
        """
        now = time.monotonic() if now is None else now

        if self._can_coalesce(coalesce_key, now):
            # Extend the gesture in place: the start state stays put, so undo
            # still jumps over the whole drag, and only the end moves.
            self._states[self._cursor] = HistoryEntry(project=after, label=label)
            self._last_time = now
            return

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

        self._last_key = coalesce_key
        self._last_time = now

    def _can_coalesce(self, key, now: float) -> bool:
        """True if this record should extend the previous entry."""
        return (key is not None
                and key == self._last_key
                and self._cursor > 0            # never merge into the seed
                and (now - self._last_time) <= self._window)

    def break_coalescing(self) -> None:
        """End the current gesture, so the next record starts a new entry.

        Anything that is not a continuation should call this -- undo/redo most
        of all, since resuming a drag after undoing must not rewrite the entry
        the user just stepped back to.
        """
        self._last_key = None

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
