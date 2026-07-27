"""Drawing Controls: the brush settings for the Draw tool.

Rendered directly rather than through ui/settings_spec.py. The registry exists
to drive the Project and Preferences windows, where dozens of controls need
consistent tiering, grouping and tooltips; three widgets in a dedicated window
are not that shape, and routing them through it would mean fabricating Setting
objects to satisfy a signature.

These values are PREFS -- editor state. They are saved to preferences.json so
your brush survives a restart, but never into a config, and never into history.
"""

from __future__ import annotations

from imgui_bundle import imgui


class DrawingWindow:
    def _init_drawing_window(self):
        self.show_drawing = True

    def _drawing_window(self):
        if not self.show_drawing:
            return

        imgui.set_next_window_size(imgui.ImVec2(320, 0), imgui.Cond_.first_use_ever.value)
        expanded, self.show_drawing = imgui.begin("Drawing Controls", True)
        if not expanded:
            imgui.end()
            return

        # Sourced from the Orchestrator's snapshot of Preferences, not held here
        # (rule 10). Note that _settings_dicts() only builds this payload while a
        # window that reads it is open -- this window is one of them.
        prefs = self._status.get('edit_prefs') or {}

        changed, value = imgui.slider_float(
            "Brush Size", float(prefs.get('draw_size', 0.031)),
            0.01, 0.5, format="%.3f")
        if changed:
            self._dispatch('edit_draw_pref', 'draw_size', value)

        changed, value = imgui.slider_float(
            "Draw Power", float(prefs.get('draw_power', 1.0)),
            0.1, 5.0, format="%.2f")
        if changed:
            self._dispatch('edit_draw_pref', 'draw_power', value)

        imgui.separator()

        if imgui.button("Clear Field"):
            self._dispatch('clear_strafe_field')
        imgui.same_line()
        imgui.text_disabled("(not undoable)")

        imgui.separator()
        imgui.text_disabled("Draw tool [3]:")
        imgui.text_disabled("  drag: push particles outward")
        imgui.text_disabled("  right-drag: erase")

        imgui.end()
