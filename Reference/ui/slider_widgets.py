"""Reusable slider widgets with context menus, sweep buttons, and range adjustment."""
from imgui_bundle import imgui
from .physics_params import PARAM_BY_LABEL


class SliderWidgetsMixin:
    """Mixin for slider widget utilities. Combined into UI via multiple inheritance."""

    def _label_to_param_name(self, label: str, for_jitter: bool = False) -> str | None:
        """Convert a slider label to its parameter name.

        Args:
            label: The slider label (e.g., 'Axial Force')
            for_jitter: If True, returns None for params where jitter is hidden
        """
        pdef = PARAM_BY_LABEL.get(label)
        if pdef is None:
            return None
        if for_jitter and pdef.hide_jitter:
            return None
        return pdef.name

    def slider_float_with_range_menu(self, label, param_name, value, default_min, default_max, format="%.3f", display_label=None):
        """
        Create a slider with an adjustable min/max context menu and reset to defaults.
        Right-click the slider to adjust its range or reset value.
        Shows jitter range when jitter > 0 with orange tint.

        Args:
            label: Display label for the slider (also used as range dict key)
            param_name: Parameter name (key in current_physics_defaults.values)
            value: Current value
            default_min: Default minimum value
            default_max: Default maximum value
            format: Display format string
            display_label: Optional label for rendering (e.g. "[L]Sensor Gain##Sensor Gain")

        Returns:
            tuple: (changed, new_value)
        """
        # Initialize or get current range
        if label not in self.state.sim.slider_ranges:
            self.state.sim.slider_ranges[label] = [default_min, default_max, default_min, default_max]

        min_val, max_val = self.state.sim.slider_ranges[label][0], self.state.sim.slider_ranges[label][1]

        # Check if jitter is active for this parameter (skip for params where jitter is hidden)
        jitter_param = self._label_to_param_name(label, for_jitter=True)
        jitter_amount = self.state.sim.jitters.get(param_name, 0.0) if jitter_param else 0.0
        has_jitter = jitter_amount > 0.0

        # Apply orange tint when jitter is active
        if has_jitter:
            imgui.push_style_color(imgui.Col_.frame_bg, imgui.ImVec4(0.4, 0.25, 0.1, 0.54))
            imgui.push_style_color(imgui.Col_.frame_bg_hovered, imgui.ImVec4(0.5, 0.3, 0.1, 0.7))
            imgui.push_style_color(imgui.Col_.frame_bg_active, imgui.ImVec4(0.6, 0.35, 0.1, 0.8))
            imgui.push_style_color(imgui.Col_.slider_grab, imgui.ImVec4(0.9, 0.6, 0.2, 1.0))
            imgui.push_style_color(imgui.Col_.slider_grab_active, imgui.ImVec4(1.0, 0.7, 0.3, 1.0))

        # Custom format showing jitter range when jitter is active
        if has_jitter:
            jitter_min = value * (1.0 - jitter_amount)
            jitter_max = value * (1.0 + jitter_amount)
            display_format = f"%.3f ({jitter_min:.3f}, {jitter_max:.3f})"
        else:
            display_format = format

        # Create the slider (use display_label for rendering, label for dict keys)
        slider_label = display_label if display_label else label
        changed, new_value = imgui.slider_float(slider_label, value, min_val, max_val, format=display_format)

        # Check alt-click for lock toggle (intercept suppresses the value change)
        pls = self.param_lock_service
        if pls and pls.handle_alt_click(param_name):
            changed, new_value = False, value

        # Pop orange style colors
        if has_jitter:
            imgui.pop_style_color(5)

        # Show delayed tooltip explaining jitter when slider is orange-tinted
        if has_jitter:
            self._delayed_tooltip(
                "Parameter varies randomly within the listed range.\n"
                "Right-click for context menu with jitter slider."
            )

        # Add context menu
        _, _, reset_requested, _ = self.add_slider_context_menu(label, default_min, default_max)

        # If reset was requested, get the default value from current_physics_defaults
        if reset_requested:
            new_value = self.current_physics_defaults.values.get(param_name, value)
            changed = True

        return changed, new_value

    def add_slider_context_menu(self, slider_name, default_min, default_max):
        """
        Add a right-click context menu to adjust slider min/max values and reset to defaults.
        Call this immediately after imgui.slider_float().

        Args:
            slider_name: Unique identifier for this slider
            default_min: Default minimum value
            default_max: Default maximum value

        Returns:
            tuple: (current_min, current_max, reset_requested, range_changed)
        """
        # Initialize slider range if not exists
        if slider_name not in self.state.sim.slider_ranges:
            self.state.sim.slider_ranges[slider_name] = [default_min, default_max, default_min, default_max]

        min_val, max_val, def_min, def_max = self.state.sim.slider_ranges[slider_name]
        range_changed = False
        reset_requested = False

        # Create context menu (right-click on the previous item)
        if imgui.begin_popup_context_item(f"{slider_name}_context"):
            # Auto-close if mouse moves too far away from popup
            popup_pos = imgui.get_window_pos()
            popup_size = imgui.get_window_size()
            mouse_pos = imgui.get_mouse_pos()

            # Calculate distance from mouse to popup rectangle
            popup_min_x, popup_min_y = popup_pos.x, popup_pos.y
            popup_max_x, popup_max_y = popup_pos.x + popup_size.x, popup_pos.y + popup_size.y
            dx = max(popup_min_x - mouse_pos.x, 0, mouse_pos.x - popup_max_x)
            dy = max(popup_min_y - mouse_pos.y, 0, mouse_pos.y - popup_max_y)
            distance = (dx * dx + dy * dy) ** 0.5

            if distance > self.state.preferences.menu_close_threshold:
                imgui.close_current_popup()

            # Jitter control at top (hidden for Hazard Rate and Mutation Scale)
            param_name = self._label_to_param_name(slider_name, for_jitter=True)
            if param_name:
                current_jitter = self.state.sim.jitters.get(param_name, 0.0)
                imgui.text("Jitter")
                changed_jitter, new_jitter = imgui.slider_float(
                    f"##jitter_{slider_name}", current_jitter, 0.0, 2.0, "%.2f")
                if changed_jitter:
                    self.state.sim.jitters[param_name] = new_jitter
                self._delayed_tooltip("Adds random jitter to this setting per-particle per-frame.\nOften results in a softer, fuzzier look.")
                imgui.separator()

            imgui.text(f"Adjust Range: {slider_name}")
            imgui.separator()

            # Min/Max input fields
            changed_min, new_min = imgui.input_float(f"Min##{slider_name}", min_val)
            changed_max, new_max = imgui.input_float(f"Max##{slider_name}", max_val)

            if changed_min:
                self.state.sim.slider_ranges[slider_name][0] = new_min
                range_changed = True
            if changed_max:
                self.state.sim.slider_ranges[slider_name][1] = new_max
                range_changed = True

            imgui.separator()

            # Reset range to default button
            if imgui.button(f"Reset Range to Default##{slider_name}"):
                self.state.sim.slider_ranges[slider_name][0] = def_min
                self.state.sim.slider_ranges[slider_name][1] = def_max
                range_changed = True

            imgui.separator()

            # Reset value button (uses current_physics_defaults)
            if self.current_physics_defaults.source_filename:
                button_label = f"Reset value to '{self.current_physics_defaults.source_filename}'##{slider_name}"
            else:
                button_label = f"Reset value to defaults##{slider_name}"

            if imgui.button(button_label):
                reset_requested = True

            imgui.end_popup()

        return self.state.sim.slider_ranges[slider_name][0], self.state.sim.slider_ranges[slider_name][1], reset_requested, range_changed

    def render_aligned_label(self, label_text: str):
        """Render a right-justified label aligned to the longest label width for consistent button positioning.

        Args:
            label_text: The label text to display (e.g., "Axial Force:")
        """
        # Calculate the width of the longest label to ensure alignment
        longest_label = "Global Force Mult:"
        longest_width = imgui.calc_text_size(longest_label).x
        current_width = imgui.calc_text_size(label_text).x

        # Calculate where to start the label so it ends at the same X position (right-justified)
        label_start_x = imgui.get_style().window_padding.x + longest_width - current_width

        # Position cursor for right-justified label
        imgui.set_cursor_pos_x(label_start_x)
        imgui.text(label_text)
        imgui.same_line()

        # Position cursor at consistent X location for buttons
        target_x = imgui.get_style().window_padding.x + longest_width + 8
        imgui.set_cursor_pos_x(target_x)

    def _set_sweep(self, axis: str, param_name: str, new_mode: float):
        """Set a sweep mode for a parameter.

        Args:
            axis: 'x', 'y', or 'cohort'
            param_name: Name of the parameter to set
            new_mode: New sweep mode (0.0 = off, 1.0 = normal, -1.0 = inverse)
        """
        if axis == 'x':
            sweeps = self.state.sim.x_sweeps
        elif axis == 'y':
            sweeps = self.state.sim.y_sweeps
        else:  # cohort
            sweeps = self.state.sim.cohort_sweeps

        sweeps[param_name] = new_mode

    def render_sweep_buttons(self, param_name: str):
        """Render X, Y, C sweep toggle buttons for a parameter.

        Left-click cycles: off -> normal -> off
        Right-click cycles: off -> inverse -> off

        Sweep modes: 0.0 = off, 1.0 = normal (highlight), -1.0 = inverse (lowlight)

        Args:
            param_name: Name of the parameter (e.g., 'AXIAL_FORCE')
        """
        button_height = imgui.get_frame_height() * 1.75  # Slightly taller to give range buttons more room
        button_width = button_height * 1.  # Wider than tall

        # X button (Red)
        x_mode = self.state.sim.x_sweeps.get(param_name, 0.0)
        if x_mode == 1.0:  # Normal sweep - bright red (highlight)
            imgui.push_style_color(imgui.Col_.button, imgui.ImVec4(0.8, 0.2, 0.2, 1.0))
            imgui.push_style_color(imgui.Col_.button_hovered, imgui.ImVec4(1.0, 0.3, 0.3, 1.0))
            imgui.push_style_color(imgui.Col_.button_active, imgui.ImVec4(0.6, 0.15, 0.15, 1.0))
        elif x_mode == -1.0:  # Inverse sweep - dark red (lowlight)
            imgui.push_style_color(imgui.Col_.button, imgui.ImVec4(0.3*.3, 0.05*.3, 0.05*.3, 1.0))
            imgui.push_style_color(imgui.Col_.button_hovered, imgui.ImVec4(0.4*.3, 0.1*.3, 0.1*.3, 1.0))
            imgui.push_style_color(imgui.Col_.button_active, imgui.ImVec4(0.2, 0.03, 0.03, 1.0))
        else:  # Off - dim red
            imgui.push_style_color(imgui.Col_.button, imgui.ImVec4(0.4, 0.1, 0.1, 1.0))
            imgui.push_style_color(imgui.Col_.button_hovered, imgui.ImVec4(0.6, 0.15, 0.15, 1.0))
            imgui.push_style_color(imgui.Col_.button_active, imgui.ImVec4(0.3, 0.08, 0.08, 1.0))

        imgui.button(f"X##{param_name}_x", imgui.ImVec2(button_width, button_height))
        if imgui.is_item_clicked(imgui.MouseButton_.left):
            new_mode = 1.0 if x_mode == 0.0 else 0.0
            self._set_sweep('x', param_name, new_mode)
        elif imgui.is_item_clicked(imgui.MouseButton_.right):
            new_mode = -1.0 if x_mode == 0.0 else 0.0
            self._set_sweep('x', param_name, new_mode)

        imgui.pop_style_color(3)
        imgui.same_line(spacing=2)

        # Y button (Green)
        y_mode = self.state.sim.y_sweeps.get(param_name, 0.0)
        if y_mode == 1.0:  # Normal sweep - bright green (highlight)
            imgui.push_style_color(imgui.Col_.button, imgui.ImVec4(0.2, 0.8, 0.2, 1.0))
            imgui.push_style_color(imgui.Col_.button_hovered, imgui.ImVec4(0.3, 1.0, 0.3, 1.0))
            imgui.push_style_color(imgui.Col_.button_active, imgui.ImVec4(0.15, 0.6, 0.15, 1.0))
        elif y_mode == -1.0:  # Inverse sweep - dark green (lowlight)
            imgui.push_style_color(imgui.Col_.button, imgui.ImVec4(0.05*.3, 0.3*.3, 0.05*.3, 1.0))
            imgui.push_style_color(imgui.Col_.button_hovered, imgui.ImVec4(0.1*.3, 0.4*.3, 0.1*.3, 1.0))
            imgui.push_style_color(imgui.Col_.button_active, imgui.ImVec4(0.03, 0.2, 0.03, 1.0))
        else:  # Off - dim green
            imgui.push_style_color(imgui.Col_.button, imgui.ImVec4(0.1, 0.4, 0.1, 1.0))
            imgui.push_style_color(imgui.Col_.button_hovered, imgui.ImVec4(0.15, 0.6, 0.15, 1.0))
            imgui.push_style_color(imgui.Col_.button_active, imgui.ImVec4(0.08, 0.3, 0.08, 1.0))

        imgui.button(f"Y##{param_name}_y", imgui.ImVec2(button_width, button_height))
        if imgui.is_item_clicked(imgui.MouseButton_.left):
            new_mode = 1.0 if y_mode == 0.0 else 0.0
            self._set_sweep('y', param_name, new_mode)
        elif imgui.is_item_clicked(imgui.MouseButton_.right):
            new_mode = -1.0 if y_mode == 0.0 else 0.0
            self._set_sweep('y', param_name, new_mode)

        imgui.pop_style_color(3)
        imgui.same_line(spacing=2)

        # C button (Yellow)
        c_mode = self.state.sim.cohort_sweeps.get(param_name, 0.0)
        if c_mode == 1.0:  # Normal sweep - bright yellow (highlight)
            imgui.push_style_color(imgui.Col_.button, imgui.ImVec4(0.9, 0.9, 0.2, 1.0))
            imgui.push_style_color(imgui.Col_.button_hovered, imgui.ImVec4(1.0, 1.0, 0.3, 1.0))
            imgui.push_style_color(imgui.Col_.button_active, imgui.ImVec4(0.7, 0.7, 0.15, 1.0))
        elif c_mode == -1.0:  # Inverse sweep - dark yellow/brown (lowlight)
            imgui.push_style_color(imgui.Col_.button, imgui.ImVec4(0.3*.3, 0.3*.3, 0.05*.3, 1.0))
            imgui.push_style_color(imgui.Col_.button_hovered, imgui.ImVec4(0.4*.3, 0.4*.3, 0.1*.3, 1.0))
            imgui.push_style_color(imgui.Col_.button_active, imgui.ImVec4(0.2*.3, 0.2*.3, 0.03*.3, 1.0))
        else:  # Off - dim yellow
            imgui.push_style_color(imgui.Col_.button, imgui.ImVec4(0.4, 0.4, 0.1, 1.0))
            imgui.push_style_color(imgui.Col_.button_hovered, imgui.ImVec4(0.6, 0.6, 0.15, 1.0))
            imgui.push_style_color(imgui.Col_.button_active, imgui.ImVec4(0.3, 0.3, 0.08, 1.0))

        imgui.button(f"C##{param_name}_c", imgui.ImVec2(button_width, button_height))
        if imgui.is_item_clicked(imgui.MouseButton_.left):
            new_mode = 1.0 if c_mode == 0.0 else 0.0
            self._set_sweep('cohort', param_name, new_mode)
        elif imgui.is_item_clicked(imgui.MouseButton_.right):
            new_mode = -1.0 if c_mode == 0.0 else 0.0
            self._set_sweep('cohort', param_name, new_mode)

        imgui.pop_style_color(3)

    def adjust_slider_range(self, slider_label: str, current_value: float, default_min: float, default_max: float, widen: bool, strength: float = 2.0, hard_min: float = None, hard_max: float = None):
        """Adjust the min/max range for a slider, widening or narrowing around current value.

        Args:
            slider_label: Label of the slider (e.g., 'Axial Force')
            current_value: Current slider value (x in the formula)
            default_min: Default minimum value
            default_max: Default maximum value
            widen: True to widen, False to narrow
            strength: Strength parameter (S in formula when widening, 1/S when narrowing)
            hard_min: Optional hard minimum limit (e.g., -1.0 for Drag/Sensor Angle)
            hard_max: Optional hard maximum limit (e.g., 1.0 for Drag/Sensor Angle)
        """
        # Get current range - handle both 2-element and 4-element formats
        if slider_label in self.state.sim.slider_ranges:
            range_data = self.state.sim.slider_ranges[slider_label]
            # slider_ranges can be [L, H] or [L, H, default_min, default_max]
            L, H = range_data[0], range_data[1]
        else:
            L, H = default_min, default_max

        # Calculate S based on widen/narrow
        x = current_value
        S = strength if widen else (1.0 / strength)

        # Apply the formulas
        # L' = x - S*( (x-L)/2. + (H-L)/4. )
        # H' = L' + S*(H-L)
        L_prime = x - S * ((x - L) / 2.0 + (H - L) / 4.0)
        H_prime = L_prime + S * (H - L)

        # Apply hard limits if specified (for sliders like Drag and Sensor Angle)
        if hard_min is not None:
            L_prime = max(L_prime, hard_min)
        if hard_max is not None:
            H_prime = min(H_prime, hard_max)

        # Update the range in preferences
        self.state.sim.slider_ranges[slider_label] = [L_prime, H_prime,default_min,default_max]

    def render_range_adjust_buttons(self, param_name: str, slider_label: str, current_value: float, default_min: float, default_max: float, hard_min: float = None, hard_max: float = None):
        """Render widen/narrow buttons for adjusting slider range.

        Args:
            param_name: Name of the parameter (e.g., 'AXIAL_FORCE')
            slider_label: Label of the slider (e.g., 'Axial Force')
            current_value: Current slider value
            default_min: Default minimum value
            default_max: Default maximum value
            hard_min: Optional hard minimum limit (e.g., -1.0 for Drag/Sensor Angle)
            hard_max: Optional hard maximum limit (e.g., 1.0 for Drag/Sensor Angle)
        """
        # Match the height of the XYC sweep buttons (which are 1.35x frame height)
        total_height = imgui.get_frame_height() * 1.43
        button_height = total_height / 2.0  # Half height for stacked buttons
        button_width = imgui.get_frame_height() * 1.23  # Same width as sweep buttons

        # Begin a group to keep buttons together
        imgui.begin_group()
        imgui.push_font(self.default_font,12)
        # Widen button
        if imgui.button(f"^##widen_{param_name}", imgui.ImVec2(button_width, button_height)):
            self.adjust_slider_range(slider_label, current_value, default_min, default_max, widen=True, hard_min=hard_min, hard_max=hard_max)

        # Narrow button
        if imgui.button(f"v##narrow_{param_name}", imgui.ImVec2(button_width, button_height)):
            self.adjust_slider_range(slider_label, current_value, default_min, default_max, widen=False, hard_min=hard_min, hard_max=hard_max)
        imgui.pop_font()
        imgui.end_group()

        # Add tooltip when hovering over the button group
        self._delayed_tooltip("Up arrow widens slider range. Down arrow narrows range")

    def render_physics_slider(self, pdef):
        """Render a complete physics slider from its PhysicsParamDef.

        Handles sweep buttons, range adjust buttons, the slider itself
        (including power-scaled sliders like Hazard Rate), context menu,
        tooltip, and parameter lock styling/alt-click. Reads/writes the
        value on self.state.sim.

        Args:
            pdef: A PhysicsParamDef instance from physics_params.py
        """
        pls = self.param_lock_service
        value = getattr(self.state.sim, pdef.name)

        # Push red lock style if locked
        lock_colors = pls.push_locked_style(pdef.name) if pls else 0

        # Build display label: "[L]Sensor Gain##Sensor Gain" when locked
        display_label = pls.get_display_label(pdef.name, pdef.label) if pls else pdef.label

        # Sweep buttons + range adjust (only when sweeps enabled)
        if self.state.sim.parameter_sweeps_enabled:
            self.render_sweep_buttons(pdef.name)
            imgui.same_line(spacing=2)
            self.render_range_adjust_buttons(
                pdef.name, pdef.label, value,
                pdef.default_min, pdef.default_max,
                hard_min=pdef.hard_min, hard_max=pdef.hard_max,
            )
            imgui.same_line(spacing=8)
            imgui.set_next_item_width(80)

        if pdef.is_power_scaled:
            # Power-scaled slider (e.g. Hazard Rate): fine control at low values
            slider_pos = (value / pdef.default_max) ** (1.0 / pdef.power_exponent)
            _, new_pos = imgui.slider_float(
                display_label, slider_pos, 0.0, 1.0,
                f"{value:.5f}"
            )
            # Check alt-click for lock toggle (intercept suppresses the value change)
            if not (pls and pls.handle_alt_click(pdef.name)):
                new_value = pdef.default_max * (new_pos ** pdef.power_exponent)
                setattr(self.state.sim, pdef.name, new_value)
            # Context menu without jitter (power-scaled params hide jitter)
            self.add_slider_context_menu(pdef.label, pdef.default_min, pdef.default_max)
        else:
            # Standard slider with range menu
            _, new_value = self.slider_float_with_range_menu(
                label=pdef.label,
                param_name=pdef.name,
                value=value,
                default_min=pdef.default_min,
                default_max=pdef.default_max,
                display_label=display_label,
            )
            setattr(self.state.sim, pdef.name, new_value)

        # Pop lock style
        if pls:
            pls.pop_locked_style(lock_colors)

        self.render_custom_tooltip(pdef.label, pdef.description)
