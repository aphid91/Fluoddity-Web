"""Project window: live controls over everything a save file contains.

THE PROJECT is the state the save/load system stores and restores: the whole
ConfigBuffer plus the world settings. The window title carries its name --
"Project: Starcrossed" -- which tracks whatever was last loaded, previewed or
saved, so the title always says what you are actually looking at.

Renders whatever `settings_spec.SETTINGS` declares (minus the PREFS-sourced
entries, which belong to the Preferences window), so adding a control is a
registry entry rather than a UI change. Controls are grouped into collapsible
tabs by their `group`; a tab whose members are all Advanced simply vanishes in
Basic mode rather than showing an empty header.

Editor preferences -- brightness, world size, display post-processing -- are a
different kind of state and live in Preferences, together with the
Basic/Advanced toggle that governs both windows.

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

import math

from imgui_bundle import imgui

from . import settings_spec as spec

#: Indent applied to controls revealed by a checkbox, in pixels.
_REVEAL_INDENT = 20.0


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

        project = self._status.get('project_name') or 'Untitled'
        # The imgui ID must stay stable as the project name changes, or the
        # window would forget its position and docking every time you load a
        # file. Everything after "##" is identity, not display.
        title = f"Project: {project}###project_window"

        imgui.set_next_window_size(imgui.ImVec2(360, 560), imgui.Cond_.first_use_ever.value)
        expanded, self.show_settings = imgui.begin(title, True)
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

        # Config and world settings only. Editor preferences live in the
        # Preferences window, along with the Basic/Advanced toggle.
        for group, settings in spec.grouped(self.show_advanced,
                                            (spec.CONFIG, spec.WORLD)):
            if not imgui.collapsing_header(
                    group, imgui.TreeNodeFlags_.default_open.value):
                continue
            for setting in settings:
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

        # Hangs off a checkbox that is currently off: not rendered at all.
        # Greying it out instead would keep a row of dead sliders on screen for
        # every effect the user is not using, which is the wall this avoids.
        if setting.reveals_on and not self._revealed(setting):
            return

        # Registered but not yet wired: show the control greyed so the tier
        # layout is visible without implying the knob does something.
        unavailable = not setting.implemented or value is None
        if unavailable:
            imgui.begin_disabled()
            placeholder = 0 if setting.kind in (spec.INT, spec.CHOICE) else 0.0
            if setting.kind == spec.BOOL:
                placeholder = False
            self._draw_widget(setting, placeholder, interactive=False)
            imgui.end_disabled()
            self._tooltip(setting, suffix="\n\n(not implemented yet)")
            return

        # Indented so the group reads as belonging to its checkbox. Pushed and
        # popped around this one control, so the counts balance on every path.
        indented = bool(setting.reveals_on)
        if indented:
            imgui.indent(_REVEAL_INDENT)
        self._draw_widget(setting, value, interactive=True)
        self._tooltip(setting)
        if indented:
            imgui.unindent(_REVEAL_INDENT)

    def _revealed(self, setting):
        """True if this control's governing checkbox is on.

        A missing or unreadable governing value counts as OFF: the payload is
        only built while a window that reads it is open, and revealing controls
        against a value we cannot see would be worse than hiding them.
        """
        source = {
            spec.CONFIG: self._status.get('edit_config') or {},
            spec.WORLD: self._status.get('edit_world') or {},
            spec.PREFS: self._status.get('edit_prefs') or {},
        }[setting.source]
        return bool(source.get(setting.reveals_on, False))

    def _draw_widget(self, setting, value, interactive):
        label = f"{setting.label}##{setting.source}.{setting.field}"

        if setting.kind == spec.SEED:
            self._draw_seed(setting, value, interactive)
            return

        if setting.kind == spec.INPUT:
            self._draw_input(setting, value, interactive)
            return

        if setting.kind == spec.CHOICE:
            options = list(setting.options)
            index = max(0, min(len(options) - 1, int(value)))
            changed, new = imgui.combo(label, index, options)
            if changed and interactive:
                self._dispatch('edit_setting', setting, int(new))
            return

        if setting.kind == spec.BOOL:
            changed, new = imgui.checkbox(label, bool(value))
            if changed and interactive:
                self._dispatch('edit_setting', setting, bool(new))
            return

        if setting.kind == spec.INT:
            changed, new = imgui.slider_int(label, int(value),
                                            int(setting.lo), int(setting.hi))
            if changed and interactive:
                self._dispatch('edit_setting', setting, int(new))
            return

        if setting.curve != 1.0:
            self._draw_curved_slider(setting, value, interactive)
            return

        # Default: float slider. Ctrl+click types an exact value, which is how
        # a config can hold a value outside these fixed bounds without a
        # range-editing UI.
        changed, new = imgui.slider_float(label, float(value),
                                          setting.lo, setting.hi)
        if changed and interactive:
            self._dispatch('edit_setting', setting, float(new))

    def _draw_curved_slider(self, setting, value, interactive):
        """A slider whose TRAVEL is bent, for ranges squashed against one end.

        imgui has no power-scaled slider, so the widget is driven in normalized
        0..1 POSITION space and the real value is mapped in and out around it:

            pos   = ((value - lo) / (hi - lo)) ** (1/curve)
            value = lo + (hi - lo) * pos ** curve

        The value is never stored curved. What is saved, dispatched and shown
        in the readout is the real number, so a curve is purely how the control
        feels -- changing one cannot change what a config means.

        The readout is explicit for the same reason: with a bent slider the
        handle position no longer suggests the magnitude, so the number has to
        be legible. It is formatted at a precision that suits the range rather
        than imgui's default %.3f, which would show a whole useful range of a
        rate like Hazard Rate as "0.000".
        """
        label = f"{setting.label}##{setting.source}.{setting.field}"
        lo, hi = float(setting.lo), float(setting.hi)
        span = hi - lo

        # Guard the degenerate registry entry rather than producing inf/NaN and
        # a slider that cannot be moved.
        if span <= 0.0:
            imgui.text_disabled(f"{setting.label}: empty range")
            return

        # A config may legitimately hold a value outside the slider's bounds
        # (ctrl+click types one), so clamp the POSITION rather than the value:
        # the handle pins to the end while the readout still tells the truth.
        norm = min(1.0, max(0.0, (float(value) - lo) / span))
        pos = norm ** (1.0 / setting.curve)

        # Enough decimals to distinguish adjacent positions at the fine end,
        # where the curve spends most of its travel.
        decimals = max(3, min(8, int(round(-math.log10(span))) + 4))
        changed, new_pos = imgui.slider_float(label, pos, 0.0, 1.0,
                                              f"{float(value):.{decimals}f}")
        if changed and interactive:
            self._dispatch('edit_setting', setting,
                           lo + span * (min(1.0, max(0.0, new_pos)) ** setting.curve))

    def _draw_seed(self, setting, value, interactive):
        """A Randomize button with the current seed shown beside it.

        Not an editable field: the seed is an opaque selector into the space of
        rule variations, so a specific value is only ever worth reading (to
        note it down or compare), never worth typing.

        Greyed when Mutation Scale is zero -- with no mutation there is no
        variation for a seed to select, so an active control would imply an
        effect it cannot have.
        """
        config = self._status.get('edit_config') or {}
        inert = float(config.get('mutation_scale', 0.0)) <= 0.0

        if inert:
            imgui.begin_disabled()

        if imgui.button(f"Randomize {setting.label}") and interactive and not inert:
            self._dispatch('randomize_seed', setting)
        imgui.same_line()
        imgui.text(f"{float(value):.4f}")

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
