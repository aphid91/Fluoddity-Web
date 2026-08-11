"""Config Manager commands: growing, shrinking and selecting configs.

KEPT DELETABLE. The multi-config machinery is how the ConfigBuffer system gets
exercised and tested, but it is an optional editing surface rather than part of
the core -- a build that exposed only the primary config (Config 0) would still
be the same app. Keeping these handlers in their own file, rather than mixed
into the Orchestrator, means dropping the feature is deleting a file and
unhooking a mixin, not surgery across a 500-line class.

The same reasoning applies to ui/config_manager.py and the "save entire
ConfigBuffer" radio in the save dialog.
"""

from __future__ import annotations

from particle_system import persistence
from particle_system.particle_system import MAX_CONFIGS


class ConfigManagerCommands:
    """Config Manager handlers. Expects the Orchestrator's attributes."""

    def _cmd_select_config(self, index):
        if 0 <= index < self.project.count:
            self.project = self.project.selecting(index)

    def _cmd_duplicate_config(self, index):
        self._manager_message = ""
        before = self.project
        project, ok = self.project.duplicated(index, MAX_CONFIGS)
        if not ok:
            self._manager_message = f"Cannot duplicate: buffer is full ({MAX_CONFIGS})."
            return
        self._set_project(project)
        self._record_history(before, f"duplicate config {index}")

    def _cmd_remove_config(self, index):
        self._manager_message = ""
        before = self.project
        project, ok = self.project.removed(index)
        if not ok:
            self._manager_message = "Cannot remove the last config."
            return
        self._set_project(project)
        self._record_history(before, f"remove config {index}")

    def _cmd_append_config_file(self, entry):
        """Append every config in a saved file to the buffer."""
        self._manager_message = ""
        try:
            saved = persistence.load(entry.path)
        except Exception as e:
            self._manager_message = f"Could not load {entry.name}: {e}"
            return
        before = self.project
        project, added, rejected = self.project.appended(saved.configs, MAX_CONFIGS)
        if added:
            self._set_project(project)
            self._record_history(before, f"append {entry.name}")
        if rejected:
            self._manager_message = (
                f"Added {added} of {added + rejected} configs; "
                f"buffer is full ({MAX_CONFIGS}).")
        elif not added:
            self._manager_message = f"Buffer is full ({MAX_CONFIGS})."
