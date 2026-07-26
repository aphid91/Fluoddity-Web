"""Settings commands: routing slider edits to whichever source owns the field.

Three sources with different semantics (see ui/settings_spec.py):
  CONFIG  per-particle, in the project. Saved.
  WORLD   global simulation state, in the project. Saved.
  PREFS   editor state. NOT saved with a project.

Mixed into the Orchestrator; owns no state of its own.
"""

from __future__ import annotations

import random

from ui import settings_spec as spec


class SettingsCommands:
    """Settings handlers. Expects the Orchestrator's attributes."""

    def _cmd_edit_setting(self, setting, value):
        """Route an edit to whichever of the three sources owns the field."""
        if setting.source == spec.CONFIG:
            self._set_project(self.project.edit_selected(setting.field, value))
        elif setting.source == spec.WORLD:
            self._set_project(self.project.edit_world(setting.field, value))
        elif setting.source == spec.PREFS:
            self._edit_preference(setting, value)

    def _edit_preference(self, setting, value):
        updated = self.prefs.with_value(setting.field, value)
        if updated == self.prefs:
            return
        needs_rebuild = self.prefs.requires_restart(updated)
        self.prefs = updated
        self.prefs.save()
        if needs_rebuild:
            # World size / canvas aspect changed: the GPU allocation depends on
            # them, so the system is rebuilt. This is why those controls are
            # typed inputs rather than sliders.
            self._rebuild_system()

    def _cmd_randomize_seed(self, setting):
        """New mutation seed. Only meaningful while Mutation Scale > 0.

        Drawn from [0,1) to match the convention the legacy configs use -- the
        value is fed straight into the hash, so any float in range is valid.
        """
        self._cmd_edit_setting(setting, random.random())
