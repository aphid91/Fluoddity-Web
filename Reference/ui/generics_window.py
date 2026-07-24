"""Generics window: 8 scratch sliders for live-coding shader experiments."""
from imgui_bundle import imgui


class GenericsWindowMixin:
    """Mixin for the Generics window. Combined into UI via multiple inheritance."""

    def render_generics_window(self):
        """Render the Generics window with 8 sliders (-1 to 1, default 0)."""
        visible, opened = imgui.begin("Generics", True)
        if not opened:
            self.state.preferences.show_generics_window = False
            imgui.end()
            return
        if visible:
            imgui.text_disabled("Uniforms: generic03 (vec4), generic47 (vec4)")
            imgui.text_disabled("Shaders: entity_update.glsl, field_override shaders")
            imgui.separator()
            prefs = self.state.preferences
            for i in range(8):
                field = f"generic{i}"
                val = getattr(prefs, field)
                changed, new_val = imgui.slider_float(field, val, -1.0, 1.0)
                if changed:
                    setattr(prefs, field, new_val)
        imgui.end()
