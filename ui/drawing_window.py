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
        # (rule 10). Indexed rather than defaulted: the payload is
        # asdict(Preferences), so it carries every field, and _settings_dicts()
        # builds it whenever a window that reads it is open -- this window is
        # one of them, and self.show_drawing above is exactly that condition.
        # Restating the defaults here (they live in preferences/preferences.py)
        # would mean a changed default silently disagreed with the slider.
        prefs = self._status['edit_prefs']

        changed, value = imgui.slider_float(
            "Brush Size", float(prefs['draw_size']),
            0.01, 0.5, format="%.3f")
        if changed:
            self._dispatch('edit_draw_pref', 'draw_size', value)

        changed, value = imgui.slider_float(
            "Draw Power", float(prefs['draw_power']),
            0.1, 5.0, format="%.2f")
        if changed:
            self._dispatch('edit_draw_pref', 'draw_power', value)

        imgui.separator()

        # The field is otherwise invisible -- you can only infer it from how
        # particles move -- so this is the one way to see what you have painted.
        changed, value = imgui.slider_float(
            "Field Opacity", float(prefs['field_opacity']),
            0.0, 1.0, format="%.2f")
        if changed:
            self._dispatch('edit_draw_pref', 'field_opacity', value)

        changed, value = imgui.checkbox(
            "Always Show Field", bool(prefs['field_always_show']))
        if changed:
            self._dispatch('edit_draw_pref', 'field_always_show', value)
        if not prefs['field_always_show']:
            imgui.same_line()
            imgui.text_disabled("(Draw tool only)")

        changed, value = imgui.checkbox(
            "Brush Reticle", bool(prefs['show_reticle']))
        if changed:
            self._dispatch('edit_draw_pref', 'show_reticle', value)

        imgui.separator()

        if imgui.button("Clear Field"):
            self._dispatch('clear_strafe_field')
        imgui.same_line()
        imgui.text_disabled("(not undoable)")

        imgui.separator()
        # Both brush tools, because Brush Size and Draw Power drive both and
        # this is the window that owns them.
        imgui.text_disabled("Shove tool [2] -- acts on particles:")
        imgui.text_disabled("  drag: push them away from the cursor")
        imgui.text_disabled("  right-drag: pull them in")
        imgui.text_disabled("  (leaves nothing behind)")
        imgui.spacing()
        imgui.text_disabled("Draw tool [3] -- paints the field:")
        imgui.text_disabled("  drag: push particles outward")
        imgui.text_disabled("  right-drag: erase")
        imgui.text_disabled("  (the field persists until erased)")

        imgui.end()
