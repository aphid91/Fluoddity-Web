"""Config clipboard window with preview, and tooltip shader rendering."""
import time
import moderngl
from imgui_bundle import imgui


class HistoryWindowMixin:
    """Mixin for config clipboard window and physics tooltips. Combined into UI via multiple inheritance."""

    def render_history_window(self):
        """Render config clipboard window with hover preview."""
        expanded, opened = imgui.begin("Config Clipboard - EXPERIMENTAL", True)
        if not opened:
            self.show_history_window = False
            imgui.end()
            return

        imgui.text_colored(imgui.ImVec4(0.6, 0.6, 0.6, 1.0), "Press Ctrl+C to add a checkpoint")
        imgui.separator()

        if not self.config_clipboard:
            imgui.text_colored(imgui.ImVec4(0.6, 0.6, 0.6, 1.0), "No checkpoints yet")
            imgui.end()
            return

        # Render entries (newest first)
        hovered_this_frame = None

        for i in range(len(self.config_clipboard) - 1, -1, -1):
            _config, label, _field = self.config_clipboard[i]

            # Selectable label for click/hover detection
            # Use allow_overlap so the X button can receive clicks on the same line
            clicked, _ = imgui.selectable(
                f"{label}##clip_{i}",
                self.clipboard_previewing_index == i,
                imgui.SelectableFlags_.allow_overlap,
                imgui.ImVec2(0, 0)
            )

            if imgui.is_item_hovered():
                hovered_this_frame = i

            # Right-click opens rename popup
            if imgui.is_item_clicked(imgui.MouseButton_.right):
                self._clipboard_renaming_index = i
                self._clipboard_rename_buffer = label
                imgui.open_popup(f"rename_clip_{i}")

            # X button on the same line
            imgui.same_line()
            imgui.push_style_color(imgui.Col_.button, imgui.ImVec4(0.8, 0.2, 0.2, 1.0))
            imgui.push_style_color(imgui.Col_.button_hovered, imgui.ImVec4(1.0, 0.3, 0.3, 1.0))
            if imgui.small_button(f"X##clip_{i}"):
                self._request_delete_clipboard_config = True
                self._clipboard_config_index = i
            imgui.pop_style_color(2)

            if imgui.is_item_hovered():
                hovered_this_frame = i

            if clicked:
                self._request_load_clipboard_config = True
                self._clipboard_config_index = i

            # Rename popup
            if imgui.begin_popup(f"rename_clip_{i}"):
                imgui.text("Rename:")
                imgui.set_next_item_width(200)
                # Auto-focus the input on first appearance
                if imgui.is_window_appearing():
                    imgui.set_keyboard_focus_here()
                changed, self._clipboard_rename_buffer = imgui.input_text(
                    f"##rename_input_{i}", self._clipboard_rename_buffer)
                if imgui.is_item_deactivated_after_edit():
                    # Enter pressed or focus lost after editing — commit rename
                    if self._clipboard_rename_buffer.strip():
                        config, _old_label, field = self.config_clipboard[i]
                        self.config_clipboard[i] = (config, self._clipboard_rename_buffer.strip(), field)
                    self._clipboard_renaming_index = None
                    imgui.close_current_popup()
                imgui.end_popup()

        # Handle preview state changes
        if hovered_this_frame != self.clipboard_previewing_index:
            if self.clipboard_previewing_index is not None:
                self._request_clear_clipboard_preview = True

            if hovered_this_frame is not None:
                self._request_preview_clipboard_config = True
                self._clipboard_config_index = hovered_this_frame
                self.clipboard_previewing_index = hovered_this_frame
            else:
                self.clipboard_previewing_index = None

        imgui.end()

    def update_tooltip_texture(self):
        """Render the tooltip graphic to texture using shader."""
        # Set time uniform for animations
        current_time = time.time() - self.tooltip_start_time
        self.tooltip_program['time'] = current_time * 3.0  # Speed up animation a bit

        # Set sensor angle (raw value, not normalized)
        self.tooltip_program['SENSOR_ANGLE'] = self.state.sim.SENSOR_ANGLE

        # Set MODE bools based on which slider is hovered
        self.tooltip_program['AXIAL_MODE'] = (self.last_hovered_slider == "Axial Force")
        self.tooltip_program['LATERAL_MODE'] = (self.last_hovered_slider == "Lateral Force")
        self.tooltip_program['SENSOR_MODE'] = (self.last_hovered_slider == "Sensor Gain")
        self.tooltip_program['DRAG_MODE'] = (self.last_hovered_slider == "Drag")
        self.tooltip_program['ANGLE_MODE'] = (self.last_hovered_slider == "Sensor Angle")
        self.tooltip_program['DISTANCE_MODE'] = (self.last_hovered_slider == "Sensor Distance")
        self.tooltip_program['TRAIL_MODE'] = (self.last_hovered_slider == "Trail Persistence")
        self.tooltip_program['DIFFUSION_MODE'] = (self.last_hovered_slider == "Trail Diffusion")
        self.tooltip_program['GLOBAL_MODE'] = (self.last_hovered_slider == "Global Force Mult")
        self.tooltip_program['STRAFE_MODE'] = (self.last_hovered_slider == "Strafe Power")
        self.tooltip_program['MUTATION_MODE'] = (self.last_hovered_slider == "Mutation Scale")

        # Render to framebuffer
        self.tooltip_fbo.use()
        self.ctx.clear(0.0, 0.0, 0.0, 1.0)
        self.tooltip_vao.render(mode=moderngl.TRIANGLE_FAN, vertices=4)
        self.ctx.screen.use()  # Return to default framebuffer

    def render_custom_tooltip(self, label: str, description: str):
        """Render a custom tooltip anchored to the right edge of a window.

        Args:
            label: The label of the slider
            description: Description text to display in the tooltip
        """
        # Track which slider is currently hovered
        if imgui.is_item_hovered():
            self.last_hovered_slider = label
            self.last_hovered_description = description

        # Track if any item is being actively manipulated (dragged)
        if imgui.is_item_active():
            self.physics_window_interaction = True

    def render_physics_tooltip(self):
        """Render the tooltip if mouse is over the Physics Settings window."""
        # Early exit if tooltips are disabled
        if not self.state.preferences.physics_tooltips_enabled:
            self.last_hovered_slider = None
            self.physics_window_interaction = False
            return

        # Check if physics settings window is hovered or if we're actively interacting with it
        physics_window_hovered = imgui.is_window_hovered()

        # First, check if we should show the tooltip at all
        # We need to render it at least once to check if IT is hovered
        should_show = (physics_window_hovered or
                      self.physics_window_interaction or
                      self.last_hovered_slider is not None)

        if not should_show:
            self.last_hovered_slider = None
            self.physics_window_interaction = False
            return

        if self.last_hovered_slider is None:
            self.physics_window_interaction = False
            return

        # Update the tooltip texture with current slider values
        self.update_tooltip_texture()

        # Get the position and size of the anchor window
        window_pos = imgui.get_window_pos()
        window_size = imgui.get_window_size()

        # Calculate tooltip position (right edge of the anchor window)
        tooltip_x = window_pos.x + window_size.x
        tooltip_y = window_pos.y

        # Set next window position
        imgui.set_next_window_pos(imgui.ImVec2(tooltip_x, tooltip_y))

        # Begin a borderless, no-move, no-focus tooltip window
        # Note: no_focus_on_appearing allows clicking to gain focus, just not automatic focus
        imgui.begin(
            "##SliderTooltip",
            flags=(
                imgui.WindowFlags_.no_title_bar |
                imgui.WindowFlags_.no_move |
                imgui.WindowFlags_.no_resize |
                imgui.WindowFlags_.always_auto_resize |
                imgui.WindowFlags_.no_focus_on_appearing |
                imgui.WindowFlags_.no_nav
            )
        )

        # Display the shader-rendered tooltip graphic
        imgui.image(
            self.tooltip_texture_id,
            imgui.ImVec2(self.tooltip_texture_size, self.tooltip_texture_size)
        )

        # Display slider name and description
        imgui.separator()
        imgui.text(f"Parameter: {self.last_hovered_slider}")
        imgui.separator()
        imgui.text_wrapped(self.last_hovered_description)

        # Check if tooltip itself is hovered (must be after content is rendered)
        tooltip_hovered = imgui.is_window_hovered()

        imgui.end()

        # Now decide if we should keep the tooltip visible next frame
        # Keep it if: physics window hovered, tooltip hovered, or actively dragging
        if not physics_window_hovered and not tooltip_hovered and not self.physics_window_interaction:
            self.last_hovered_slider = None

        # Reset interaction flag for next frame
        self.physics_window_interaction = False
