"""Preferences window: editor state, and the Basic/Advanced tier toggle.

Separate from the Settings window because these are a different KIND of state.
Settings edits a config -- the thing you save, load and share. Preferences is
how your editor is set up: how bright the display is, how big the world is, how
much detail the interface shows. Loading someone else's config changes the
former and must never change the latter.

Concretely: everything here is `source == PREFS` in the settings registry, and
none of it is written into a saved config file.

THE TIER TOGGLE LIVES HERE because it is itself an editor preference, and
because it governs BOTH windows -- switching to Advanced reveals the advanced
controls in Settings as well as in this one. Putting it inside Settings would
have made a window-local control that silently reaches outside its window.

(The tier is not persisted to preferences.json: it is a view mode, and the
useful default is to start simple each session.)
"""

from __future__ import annotations

from imgui_bundle import imgui

from . import settings_spec as spec


class PreferencesWindow:
    """Mixin providing the Preferences window. Host supplies `_dispatch`/`_status`."""

    def _init_preferences_window(self):
        self.show_preferences = True

    def _preferences_window(self):
        if not self.show_preferences:
            return

        imgui.set_next_window_size(imgui.ImVec2(340, 400), imgui.Cond_.first_use_ever.value)
        expanded, self.show_preferences = imgui.begin("Preferences", True)
        if not expanded:
            imgui.end()
            return

        # PREFS-sourced controls, grouped into the same collapsible tabs the
        # Project window uses.
        for group, settings in spec.grouped(self.show_advanced, (spec.PREFS,)):
            if not imgui.collapsing_header(
                    group, imgui.TreeNodeFlags_.default_open.value):
                continue
            for setting in settings:
                self._render_setting(setting)

        # Editor is its own tab, and is not registry-driven: the detail level
        # is a property of the interface rather than of the simulation, so it
        # has no entry in settings_spec.
        if imgui.collapsing_header("Editor", imgui.TreeNodeFlags_.default_open.value):
            imgui.text("Detail level")
            if imgui.radio_button("Basic", not self.show_advanced):
                self.show_advanced = False
            imgui.same_line()
            if imgui.radio_button("Advanced", self.show_advanced):
                self.show_advanced = True
            imgui.text_disabled("applies to the Project window too")

        imgui.separator()
        imgui.text_disabled("Not saved with projects.")

        imgui.end()
