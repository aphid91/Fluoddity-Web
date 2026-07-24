"""Plotting window: GPU histogram visualization from entity_update report() calls."""
from imgui_bundle import imgui


AXIS_MODE_LABELS = ["Linear", "Log", "Log-Log"]


class PlottingWindowMixin:
    """Mixin for the Plotting window. Combined into UI via multiple inheritance."""

    def render_plotting_window(self):
        """Render the Plotting window with 4 histogram channels."""
        visible, opened = imgui.begin("Plotting", True)
        if not opened:
            self.state.preferences.show_plotting_window = False
            imgui.end()
            return
        if not visible:
            imgui.end()
            return

        pm = self.plotting_manager
        if pm is None:
            imgui.text("Plotting manager not initialized.")
            imgui.end()
            return

        tex = pm.get_texture()
        tex_id = imgui.ImTextureRef(tex.glo)

        # Available width for the histogram images
        avail_width = imgui.get_content_region_avail().x
        # Each channel gets 1/4 of the texture height
        image_height = avail_width * 0.25  # Maintain reasonable aspect ratio

        for ch in range(4):
            imgui.push_id(f"plot_{ch}")

            # UV coordinates for this channel's strip
            # Channel 0 is top of texture (UV y=0), channel 3 is bottom (UV y=1)
            # OpenGL textures have y=0 at bottom, imgui has y=0 at top
            # So channel 0 maps to UV y: 0.75->1.0, channel 1: 0.50->0.75, etc.
            uv_y0 = 1.0 - (ch + 1) / 4.0
            uv_y1 = 1.0 - ch / 4.0

            imgui.image(
                tex_id,
                imgui.ImVec2(avail_width, image_height),
                uv0=imgui.ImVec2(0.0, uv_y0),
                uv1=imgui.ImVec2(1.0, uv_y1),
            )

            # Controls row
            # Axis mode cycle button
            mode_idx = pm.axis_mode[ch]
            if imgui.button(f"{AXIS_MODE_LABELS[mode_idx]}##axis"):
                pm.axis_mode[ch] = (mode_idx + 1) % len(AXIS_MODE_LABELS)
            imgui.same_line()

            # Plot mode (uint) — what data to report on this channel
            imgui.set_next_item_width(80)
            changed, new_val = imgui.input_int("Mode", pm.plot_mode[ch], 1, 1)
            if changed:
                pm.plot_mode[ch] = max(0, new_val)

            # Hist min/max sliders
            imgui.set_next_item_width(avail_width * 0.45)
            changed, new_val = imgui.drag_float(
                "Hist Min", pm.hist_min[ch], 0.001, -100.0, 100.0, "%.4f"
            )
            if changed:
                pm.hist_min[ch] = new_val
            imgui.same_line()
            imgui.set_next_item_width(avail_width * 0.45)
            changed, new_val = imgui.drag_float(
                "Hist Max", pm.hist_max[ch], 0.001, -100.0, 100.0, "%.4f"
            )
            if changed:
                pm.hist_max[ch] = new_val

            # Height min/max/scale sliders
            imgui.set_next_item_width(avail_width * 0.3)
            changed, new_val = imgui.drag_float(
                "H Min", pm.height_min[ch], 0.1, 0.0, 1e8, "%.1f"
            )
            if changed:
                pm.height_min[ch] = new_val
            imgui.same_line()
            imgui.set_next_item_width(avail_width * 0.3)
            changed, new_val = imgui.drag_float(
                "H Max", pm.height_max[ch], 0.1, 0.0, 1e8, "%.1f"
            )
            if changed:
                pm.height_max[ch] = new_val
            imgui.same_line()
            imgui.set_next_item_width(avail_width * 0.3)
            changed, new_val = imgui.drag_float(
                "Scale", pm.height_scale[ch], 0.01, 0.001, 1000.0, "%.3f"
            )
            if changed:
                pm.height_scale[ch] = new_val

            if ch < 3:
                imgui.separator()

            imgui.pop_id()

        imgui.end()
