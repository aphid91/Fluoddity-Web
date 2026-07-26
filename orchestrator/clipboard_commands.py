"""Config Clipboard commands: in-session checkpoints of the whole project.

A scratch space for experimenting -- checkpoint before changing things and you
can get back, without committing anything to disk. Session-only: File > Save is
the route for anything worth keeping.

Mixed into the Orchestrator; owns no state of its own beyond what lives there.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from itertools import count

from project import Project

_checkpoint_ids = count()


@dataclass(frozen=True)
class Checkpoint:
    """An in-session snapshot of the whole project.

    Holds a Project rather than a bare config list, so restoring one restores
    the name and selection too.

    `key` is an opaque id rather than the name, so the hover-preview machinery
    keeps tracking the right entry even if two checkpoints ever share a name.
    """

    name: str
    project: Project
    key: int = field(default_factory=lambda: next(_checkpoint_ids))


class ClipboardCommands:
    """Checkpoint handlers. Expects the Orchestrator's attributes."""

    def _checkpoint_name(self):
        """Unique '<project><NN>' name, numbered per project.

        Numbering scans existing checkpoints rather than using a global counter,
        so deleting entries frees their numbers back up and the list does not
        drift into high numbers after a lot of churn.
        """
        stem = self.project.name or "Project"
        taken = {cp.name for cp in self.checkpoints}
        for n in range(100):
            candidate = f"{stem}{n:02d}"
            if candidate not in taken:
                return candidate
        # Past 100 of the same name, fall back to something guaranteed unique.
        self._checkpoint_serial += 1
        return f"{stem}_{self._checkpoint_serial}"

    def _cmd_set_checkpoint(self):
        """Capture the whole project. Newest goes on top."""
        name = self._checkpoint_name()
        self.checkpoints.insert(
            0, Checkpoint(name=name, project=self.project.renamed(name)))

    def _cmd_delete_checkpoint(self, checkpoint):
        self.checkpoints = [c for c in self.checkpoints if c.key != checkpoint.key]

    def _cmd_load_checkpoint(self, checkpoint):
        self._set_project(checkpoint.project)

    def _cmd_load_latest_checkpoint(self):
        if self.checkpoints:
            self._cmd_load_checkpoint(self.checkpoints[0])

    # Its own snapshot slot, separate from the Load menu's: two independent
    # hover surfaces must not share one, or hovering in one would clobber the
    # other (see ui/hover_preview.py).

    def _cmd_clipboard_snapshot(self):
        return self.project

    def _cmd_clipboard_restore(self, snapshot):
        if snapshot is not None:
            self._set_project(snapshot)

    def _cmd_clipboard_apply(self, checkpoint):
        self._set_project(checkpoint.project)
