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

    def _cmd_edit_setting(self, setting, value, record=True):
        """Route an edit to whichever of the three sources owns the field.

        Records history, coalescing by field so a slider drag becomes one undo
        step rather than one per frame. `record=False` lets a caller that will
        record the step itself avoid a duplicate entry.

        Preference edits are NOT recorded: they are editor state, outside the
        project entirely, so there is nothing for undo to restore.
        """
        before = self.project

        if setting.source == spec.CONFIG:
            self._set_project(self.project.edit_selected(setting.field, value))
        elif setting.source == spec.WORLD:
            self._set_project(self.project.edit_world(setting.field, value))
        elif setting.source == spec.PREFS:
            self._edit_preference(setting, value)
            return

        if record:
            # Key on source+field: moving to a different slider ends the
            # gesture, as does pausing longer than the coalesce window.
            self._record_history(before, f"edit {setting.label}",
                                 coalesce_key=(setting.source, setting.field))

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

    def _cmd_randomize_seed(self, setting=None):
        """New mutation seed. Only meaningful while Mutation Scale > 0.

        Drawn from [0,1) to match the convention the legacy configs use -- the
        value is fed straight into the hash, so any float in range is valid.

        Records as a one-shot (no coalesce key), so hitting Randomize three
        times gives three undo steps -- a button press is a discrete act, not a
        gesture to merge.

        `setting` is optional because the G hotkey has no widget to pass: the
        button hands over the Setting it drew, and the key looks it up. Both
        end at the same edit rather than the key having its own path.
        """
        if setting is None:
            setting = _SEED_SETTING
            if setting is None:
                return
        before = self.project
        self._cmd_edit_setting(setting, random.random(), record=False)
        self._record_history(before, "randomize mutation seed")


def _find_seed_setting():
    """The registry's SEED control, for callers that have no widget to hand.

    Looked up by KIND rather than by field name: SEED means "a randomizable
    opaque selector", and there is exactly one. Naming the field here would put
    a second copy of that name outside settings_spec.
    """
    for setting in spec.SETTINGS:
        if setting.kind == spec.SEED:
            return setting
    return None


#: Resolved once at import. The registry is a module-level constant, so this
#: cannot go stale, and a missing entry is worth failing quietly rather than
#: searching the list on every keypress.
_SEED_SETTING = _find_seed_setting()
