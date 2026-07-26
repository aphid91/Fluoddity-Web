"""Settings window: live controls over the selected config and the world.

Renders whatever `settings_spec.SETTINGS` declares (minus the PREFS-sourced
entries, which belong to the Preferences window), so adding a control is a
registry entry rather than a UI change.

This window edits the things a config SAVES: per-particle behaviour and the
shared world properties. Editor preferences -- brightness, world size, display
post-processing -- are a different kind of state and live in Preferences,
together with the Basic/Advanced toggle that governs both windows.

WHICH CONFIG DOES THIS EDIT?
The one selected in the Config Manager. That is the manager's entire purpose:
with several configs in the buffer, these controls act on the selected one.
With a single config -- the common case -- it is Config 0 and nothing needs
touching.

NO UNDO HERE, ON PURPOSE. The Config Clipboard already snapshots and restores
the whole buffer, so "Set Checkpoint, experiment, hover to A/B, click to
revert" is the undo story. Building a second, weaker one next to it would be
redundant.

Values are pushed on every change, straight into the GPU buffer -- editing a
slider shows its effect immediately, which is the point of having sliders at
all rather than editing JSON.
"""

from __future__ import annotations

from imgui_bundle import imgui

from . import settings_spec as spec


class SettingsWindow:
    """Mixin providing the Settings window. Host supplies `_dispatch`/`_status`."""

    def _init_settings_window(self):
        self.show_settings = True
        # Tier state is shared with the Preferences window, whose radio buttons
        # own it -- switching there reveals advanced controls in both.
        self.show_advanced = False
        #: Pending text for INPUT controls, keyed by field. These commit on
        #: Enter rather than per-keystroke, because they reset the simulation.
        self._input_buffers = {}

    def _settings_window(self):
        if not self.show_settings:
            return

        imgui.set_next_window_size(imgui.ImVec2(360, 560), imgui.Cond_.first_use_ever.value)
        expanded, self.show_settings = imgui.begin("Settings", True)
        if not expanded:
            imgui.end()
            return

        selected = self._status.get('selected_config', 0)
        config_count = self._status.get('config_count', 1)
        imgui.text(f"Editing Config {selected}")
        if config_count > 1:
            imgui.same_line()
            imgui.text_disabled(f"of {config_count}")

        imgui.separator()

        # Config and world settings only. Editor preferences (brightness, world
        # size, display post-processing) live in the Preferences window, along
        # with the Basic/Advanced toggle that governs both.
        current_group = None
        for setting in spec.visible(self.show_advanced):
            if setting.source == spec.PREFS:
                continue
            if setting.group and setting.group != current_group:
                current_group = setting.group
                imgui.spacing()
                imgui.text_disabled(setting.group.upper())
            self._render_setting(setting)

        imgui.end()

    # ------------------------------------------------------------------

    def _value_of(self, setting):
        """Current value for a setting, from whichever source owns it."""
        source = {
            spec.CONFIG: self._status.get('edit_config') or {},
            spec.WORLD: self._status.get('edit_world') or {},
            spec.PREFS: self._status.get('edit_prefs') or {},
        }[setting.source]
        return source.get(setting.field)

    def _render_setting(self, setting):
        value = self._value_of(setting)

        # Registered but not yet wired: show the control greyed so the tier
        # layout is visible without implying the knob does something.
        unavailable = not setting.implemented or value is None
        if unavailable:
            imgui.begin_disabled()
            placeholder = 0.0 if setting.kind != spec.INT else 0
            self._draw_widget(setting, placeholder, interactive=False)
            imgui.end_disabled()
            self._tooltip(setting, suffix="\n\n(not implemented yet)")
            return

        self._draw_widget(setting, value, interactive=True)
        self._tooltip(setting)

    def _draw_widget(self, setting, value, interactive):
        label = f"{setting.label}##{setting.source}.{setting.field}"

        if setting.kind == spec.SEED:
            self._draw_seed(setting, value, interactive)
            return

        if setting.kind == spec.INPUT:
            self._draw_input(setting, value, interactive)
            return

        if setting.kind == spec.INT:
            changed, new = imgui.slider_int(label, int(value),
                                            int(setting.lo), int(setting.hi))
            if changed and interactive:
                self._dispatch('edit_setting', setting, int(new))
            return

        # Default: float slider. Ctrl+click types an exact value, which is how
        # a config can hold a value outside these fixed bounds without a
        # range-editing UI.
        changed, new = imgui.slider_float(label, float(value),
                                          setting.lo, setting.hi)
        if changed and interactive:
            self._dispatch('edit_setting', setting, float(new))

    def _draw_seed(self, setting, value, interactive):
        """Seed + Randomize. Both greyed when mutation scale is zero.

        With no mutation there is no variation for a seed to select, so an
        active control would imply an effect it cannot have.
        """
        config = self._status.get('edit_config') or {}
        inert = float(config.get('mutation_scale', 0.0)) <= 0.0

        if inert:
            imgui.begin_disabled()

        width = imgui.get_content_region_avail().x
        imgui.set_next_item_width(max(width - 100.0, 80.0))
        changed, new = imgui.input_int(
            f"##{setting.field}", int(value), 0, 0)
        if changed and interactive and not inert:
            self._dispatch('edit_setting', setting, int(new))
        imgui.same_line()
        if imgui.button("Randomize") and interactive and not inert:
            self._dispatch('randomize_seed', setting)
        imgui.same_line()
        imgui.text(setting.label)

        if inert:
            imgui.end_disabled()
            imgui.text_disabled("   (no effect while Mutation Scale is 0)")

    def _draw_input(self, setting, value, interactive):
        """Typed input committed on Enter, for settings that reset the sim."""
        key = f"{setting.source}.{setting.field}"
        if key not in self._input_buffers:
            self._input_buffers[key] = f"{float(value):g}"

        imgui.set_next_item_width(max(imgui.get_content_region_avail().x - 140.0, 80.0))
        entered, text = imgui.input_text(
            f"{setting.label}##{key}", self._input_buffers[key],
            imgui.InputTextFlags_.enter_returns_true.value)
        self._input_buffers[key] = text

        if entered and interactive:
            try:
                parsed = float(text)
            except ValueError:
                # Reject silently by restoring the live value: a typo should
                # not reset the simulation.
                self._input_buffers[key] = f"{float(value):g}"
                return
            parsed = max(setting.lo, min(setting.hi, parsed))
            self._input_buffers[key] = f"{parsed:g}"
            self._dispatch('edit_setting', setting, parsed)

        if setting.disruptive:
            imgui.text_disabled("   resets the simulation (Enter to apply)")

    def _tooltip(self, setting, suffix=""):
        if not imgui.is_item_hovered(imgui.HoveredFlags_.delay_normal.value
                                     | imgui.HoveredFlags_.for_tooltip.value):
            return
        if imgui.begin_tooltip():
            imgui.push_text_wrap_pos(320.0)
            imgui.text_disabled(setting.label)
            imgui.separator()
            imgui.text_unformatted(setting.help + suffix)
            imgui.pop_text_wrap_pos()
            imgui.end_tooltip()

    def _sync_input_buffers(self):
        """Refresh INPUT text from live values when they change elsewhere.

        Without this, loading a config would leave stale text in the boxes.
        Buffers being edited are left alone -- imgui owns focus, and clobbering
        text mid-type would be hostile.
        """
        for setting in spec.SETTINGS:
            if setting.kind != spec.INPUT:
                continue
            key = f"{setting.source}.{setting.field}"
            value = self._value_of(setting)
            if value is None:
                continue
            formatted = f"{float(value):g}"
            if key not in self._input_buffers:
                self._input_buffers[key] = formatted
