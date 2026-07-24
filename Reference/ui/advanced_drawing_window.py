"""Advanced Drawing window: brush modes, force/strafe field controls."""
import math
from imgui_bundle import imgui
from utilities.advanced_drawing import AdvancedDrawingProcessor


class AdvancedDrawingWindowMixin:
    """Mixin for advanced drawing controls. Combined into UI via multiple inheritance."""

    def render_advanced_drawing_window(self):
        """Render the Advanced Drawing Controls window."""
        expanded, opened = imgui.begin("Drawing Controls", True)

        if not opened:
            self.state.preferences.advanced_drawing_enabled = False
            imgui.end()
            return

        if expanded:
            prefs = self.state.preferences

            # === 1. Draw Size + Draw Power sliders ===
            _, prefs.draw_size = imgui.slider_float(
                "Draw Size##adv", prefs.draw_size, 0.01, 0.5, format="%.3f"
            )
            _, prefs.draw_power = imgui.slider_float(
                "Draw Power##adv", prefs.draw_power, 0.1, 5.0, format="%.2f"
            )

            # === 2. Brush Mode Combo ===
            brush_modes = [
                "Mouse Direction",
                "Inverse Mouse Direction",
                "Fixed Direction",
                "In - Attract",
                "Out - Repel",
            ]
            _, prefs.brush_mode = imgui.combo("Brush Mode", prefs.brush_mode, brush_modes)

            # === 3. Fixed Direction Heading slider ===
            _, prefs.fixed_direction_heading = imgui.slider_float(
                "Fixed Direction Heading",
                prefs.fixed_direction_heading,
                -math.pi,
                math.pi,
                format="%.3f",
            )
            self._delayed_tooltip(
                "Heading angle for Fixed Direction brush mode.\n"
                "0 = up (positive Y), PI/2 = right."
            )

            imgui.separator()

            # === 4. Active Draw Target (mutually exclusive radio buttons) ===
            imgui.text("Active Draw Target")

            # Determine current selection: 0=canvas, 1=force, 2=strafe
            if prefs.advanced_draw_force_field:
                target = 1
            elif prefs.advanced_draw_strafe_field:
                target = 2
            else:
                target = 0

            if imgui.radio_button("Trails / Canvas", target == 0):
                target = 0
            self._delayed_tooltip("Draw on the particle trail canvas (existing behavior).")

            if imgui.radio_button("Force Field", target == 1):
                target = 1
            self._delayed_tooltip(
                "Draw onto the force field texture.\n"
                "Acts like any other force: some rules may 'swim upstream'."
            )

            if imgui.radio_button("Strafe Field", target == 2):
                target = 2
            self._delayed_tooltip(
                "Draw onto the strafe field texture.\n"
                "All particles will be dragged in the direction of the field."
            )

            # Apply mutually exclusive selection back to prefs
            prefs.advanced_draw_canvas = (target == 0)
            prefs.advanced_draw_force_field = (target == 1)
            prefs.advanced_draw_strafe_field = (target == 2)

            # === 5. Fill Popup ===
            if imgui.button("Fill..."):
                imgui.open_popup("fill_popup")
            self._delayed_tooltip(
                "Apply the brush to the entire canvas/field for one frame.\n"
                "Like the fill bucket in a paint program. Strength proportional to Draw power."
            )
            if imgui.begin_popup("fill_popup"):
                if imgui.selectable("Fixed Direction", False)[0]:
                    self._request_fill_operation = True
                    self._fill_direction_type = 0
                if imgui.selectable("Fixed Direction - Negative", False)[0]:
                    self._request_fill_operation = True
                    self._fill_direction_type = 3
                if imgui.selectable("Radial - In", False)[0]:
                    self._request_fill_operation = True
                    self._fill_direction_type = 1
                if imgui.selectable("Radial - Out", False)[0]:
                    self._request_fill_operation = True
                    self._fill_direction_type = 2
                imgui.end_popup()

            # === 6. Dynamic Clear button ===
            clear_labels = ["Trails/Canvas", "Force Field", "Strafe Field"]
            clear_label = clear_labels[target]
            if imgui.button(f"Clear {clear_label}"):
                if target == 0:
                    self._request_clear_canvas = True
                elif target == 1:
                    self._request_clear_force_field = True
                elif target == 2:
                    self._request_clear_strafe_field = True
            self._delayed_tooltip(f"Clear the {clear_label.lower()} to zero.")

            imgui.separator()

            # === 7. Force Field Strength (logarithmic: 0.0001 to 10.0) ===
            FIELD_MIN_EXP = -4.0  # 10^-4 = 0.0001
            FIELD_MAX_EXP = 1.0   # 10^1 = 10.0
            FIELD_EXP_RANGE = FIELD_MAX_EXP - FIELD_MIN_EXP  # 5.0

            pls = self.param_lock_service
            ffs_lock_colors = pls.push_locked_style('force_field_strength') if pls else 0
            ffs_label = pls.get_display_label('force_field_strength', "Force Field Strength") if pls else "Force Field Strength"

            if prefs.force_field_strength > 0:
                fslider = (math.log10(prefs.force_field_strength) - FIELD_MIN_EXP) / FIELD_EXP_RANGE
            else:
                fslider = 0.0
            fslider = max(0.0, min(1.0, fslider))
            _, new_fpos = imgui.slider_float(
                ffs_label,
                fslider,
                0.0,
                1.0,
                f"{prefs.force_field_strength:.4f}",
            )
            if pls and pls.handle_alt_click('force_field_strength'):
                pass  # alt-click intercepted; discard value change
            else:
                prefs.force_field_strength = 10.0 ** (FIELD_MIN_EXP + FIELD_EXP_RANGE * new_fpos)
            if pls:
                pls.pop_locked_style(ffs_lock_colors)
            self._delayed_tooltip(
                "Multiplier for force field effects.\n"
                "Logarithmic scale: 0.0001 to 10.0, default 1.0."
            )

            # === 8. Strafe Field Strength (logarithmic: 0.0001 to 10.0) ===
            sfs_lock_colors = pls.push_locked_style('strafe_field_strength') if pls else 0
            sfs_label = pls.get_display_label('strafe_field_strength', "Strafe Field Strength") if pls else "Strafe Field Strength"

            if prefs.strafe_field_strength > 0:
                sslider = (math.log10(prefs.strafe_field_strength) - FIELD_MIN_EXP) / FIELD_EXP_RANGE
            else:
                sslider = 0.0
            sslider = max(0.0, min(1.0, sslider))
            _, new_spos = imgui.slider_float(
                sfs_label,
                sslider,
                0.0,
                1.0,
                f"{prefs.strafe_field_strength:.4f}",
            )
            if pls and pls.handle_alt_click('strafe_field_strength'):
                pass  # alt-click intercepted; discard value change
            else:
                prefs.strafe_field_strength = 10.0 ** (FIELD_MIN_EXP + FIELD_EXP_RANGE * new_spos)
            if pls:
                pls.pop_locked_style(sfs_lock_colors)
            self._delayed_tooltip(
                "Multiplier for strafe field effects.\n"
                "Logarithmic scale: 0.0001 to 10.0, default 1.0."
            )

            imgui.separator()

            # === 9. View Draw Target Arrows (coupled to preferences debug_arrows) ===
            _, prefs.debug_arrows = imgui.checkbox(
                "View Draw Target Arrows", prefs.debug_arrows
            )
            self._delayed_tooltip(
                "Render a grid of arrows to help visualize the active draw target's vector field."
            )

            # === 10. Draw Target Overlay Opacity ===
            _, prefs.draw_target_overlay_opacity = imgui.slider_float(
                "Draw Target Overlay Opacity",
                prefs.draw_target_overlay_opacity,
                0.0,
                1.0,
                format="%.2f",
            )
            self._delayed_tooltip(
                "Opacity of the force/strafe field color overlay in the main view.\n"
                "0 = hidden, 1 = fully visible."
            )

            imgui.separator()

            # === 11. Shader Driven Field ===
            changed, prefs.shader_driven_field = imgui.checkbox(
                "Shader Driven Field", prefs.shader_driven_field
            )
            self._delayed_tooltip(
                "Use a frag shader to override the field texture."
            )

            # When enabling, switch draw target to canvas if on force/strafe
            if changed and prefs.shader_driven_field:
                if prefs.advanced_draw_force_field or prefs.advanced_draw_strafe_field:
                    prefs.advanced_draw_canvas = True
                    prefs.advanced_draw_force_field = False
                    prefs.advanced_draw_strafe_field = False

            if prefs.shader_driven_field:
                available = AdvancedDrawingProcessor.get_available_override_shaders()
                # Find current selection index among non-divider entries
                shader_names = [name for name, is_div in available if not is_div]
                current_idx = 0
                if prefs.field_override_shader in shader_names:
                    current_idx = shader_names.index(prefs.field_override_shader)

                preview = prefs.field_override_shader
                imgui.set_next_item_width(-1)
                if imgui.begin_combo("##field_override_shader", preview):
                    for name, is_divider in available:
                        if is_divider:
                            imgui.separator()
                            continue
                        is_selected = (name == prefs.field_override_shader)
                        if imgui.selectable(name, is_selected)[0]:
                            prefs.field_override_shader = name
                        if is_selected:
                            imgui.set_item_default_focus()
                    imgui.end_combo()

        imgui.end()
