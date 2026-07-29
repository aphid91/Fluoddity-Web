"""Shared hover-to-preview state machine.

Two surfaces browse config collections by hovering (the File>Load menu and the
Config Clipboard), and both need the same contract:

    open        snapshot the current ConfigBuffer
    hover X     apply X (previewing)
    hover none  restore the snapshot
    close       restore the snapshot...
    click X     ...UNLESS a click committed, which drops the snapshot so the
                closing restore cannot undo the user's choice

WHY THIS IS A SEPARATE CLASS
The first implementation kept this state on the load menu and used a single
snapshot slot on the Orchestrator. With two independent hover surfaces that
breaks: hovering a clipboard entry while the Load menu is also open would
overwrite the menu's snapshot, and unhovering would restore the wrong state.
Each surface now owns its own PreviewSession, and each session takes its own
snapshot -- so they cannot clobber one another regardless of what is open.

The session holds no config data itself. It calls back into the host for the
three operations it needs, so it works for file entries and in-memory
checkpoints alike.
"""

from __future__ import annotations


class PreviewSession:
    """Tracks preview/commit state for one hoverable collection."""

    def __init__(self, on_snapshot, on_restore, on_apply):
        """
        on_snapshot()   capture the current ConfigBuffer; returns a snapshot
        on_restore(s)   put snapshot `s` back
        on_apply(item)  apply the hovered item for preview
        """
        self._on_snapshot = on_snapshot
        self._on_restore = on_restore
        self._on_apply = on_apply

        self._open = False
        self._snapshot = None
        self._committed = False
        #: Key of the item currently previewed, or None.
        self._previewing = None

    def begin(self):
        """Call when the surface opens. Idempotent within a session."""
        if self._open:
            return
        self._open = True
        self._committed = False
        self._previewing = None
        self._snapshot = self._on_snapshot()

    def end(self):
        """Call when the surface closes. Restores unless a click committed."""
        if not self._open:
            return
        self._open = False
        if not self._committed and self._snapshot is not None:
            self._on_restore(self._snapshot)
        self._snapshot = None
        self._previewing = None

    def sync(self, hovered, key_of):
        """Apply/undo previews as the hovered item changes.

        hovered   the item under the cursor this frame, or None
        key_of    item -> hashable identity, for change detection
        """
        if not self._open:
            return
        key = key_of(hovered) if hovered is not None else None
        if key == self._previewing:
            return
        if hovered is None:
            # A committed choice is no longer a preview: unhovering must not
            # undo it. This matters for window-based surfaces (the Clipboard),
            # where clicking does NOT close the surface -- the cursor is still
            # on the row afterwards, and moving it away would otherwise restore
            # the state the user just deliberately chose. Menu-based surfaces
            # close on click so they rarely reach this path.
            if self._committed:
                self._previewing = None
                return
            self.restore_now()
        else:
            self._on_apply(hovered)
        self._previewing = key

    def commit(self, key=None):
        """Mark the current preview as chosen.

        Neither `end()` nor a later unhover will undo it. The snapshot is
        dropped outright so there is nothing left to restore by any path.
        """
        self._committed = True
        self._snapshot = None
        self._previewing = key

    def restore_now(self):
        """Put the snapshot back without ending the session.

        No-op after a commit: the snapshot is gone by then, by design.
        """
        if self._snapshot is not None:
            self._on_restore(self._snapshot)

    def forget(self):
        """Drop the snapshot without restoring.

        For when the snapshot has become meaningless -- e.g. the previewed item
        was deleted, so restoring it would resurrect state the user discarded.
        """
        self._snapshot = self._on_snapshot()
        self._previewing = None
