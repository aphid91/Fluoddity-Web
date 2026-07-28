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
from . import tooltip_graphic

#: Indent applied to controls revealed by a checkbox, in pixels.
_REVEAL_INDENT = 20.0

#: Settings explained by the shader-drawn diagram instead of a plain tooltip,
#: mapped to which quantity the diagram animates. Keyed by (source, field) so
#: the match cannot be fooled by a same-named field on another source.
_DIAGRAM_MODES = {
    (spec.CONFIG, 'sensor_angle'): 'angle',
    (spec.CONFIG, 'sensor_distance'): 'distance',
}

#: How much wider than the diagram the panel's text may run, in pixels. The
#: diagram alone is too narrow a column for a paragraph.
_DIAGRAM_TEXT_EXTRA = 140.0


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

        #: (setting, mode) for the sensor slider hovered THIS frame, or None.
        #: Set while the sliders render and consumed at the end of the same
        #: frame, so the diagram closes the moment the cursor leaves.
        self._diagram_hovered = None
        #: Whether the panel was on screen at the end of LAST frame. A drag may
        #: keep an already-open panel up, but must never be what opens one --
        #: see the note in _tooltip(). Last frame's value is the right question:
        #: sliders render before the panel does, so this frame's is not known
        #: yet when it is consulted.
        self._diagram_open = False
        #: Where to pin the diagram: the Project window's top-right corner,
        #: captured each frame before its imgui.end().
        self._diagram_anchor = imgui.ImVec2(0.0, 0.0)
        self._diagram_anchor_width = 0.0

    def _settings_window(self):
        if not self.show_settings:
            # No window means no panel, so a later reopen must not think one was
            # still up -- otherwise the first drag after reopening would be
            # treated as sustaining a panel that is not there.
            self._diagram_open = False
            return

        # Cleared at the top of every frame and set again by whichever sensor
        # slider is hovered while the controls below render. Nothing carries
        # over, so unhovering closes the diagram on the very next frame.
        self._diagram_hovered = None

        project = self._status.get('project_name') or 'Untitled'
        # The imgui ID must stay stable as the project name changes, or the
        # window would forget its position and docking every time you load a
        # file. Everything after "##" is identity, not display.
        title = f"Project: {project}###project_window"

        imgui.set_next_window_size(imgui.ImVec2(360, 560), imgui.Cond_.first_use_ever.value)
        expanded, self.show_settings = imgui.begin(title, True)
        if not expanded:
            imgui.end()
            self._diagram_open = False   # collapsed: same reasoning as above
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

        # Captured before end(), used after it: the diagram is a window of its
        # own and cannot be opened inside this one.
        self._diagram_anchor = imgui.get_window_pos()
        self._diagram_anchor_width = imgui.get_window_size().x

        imgui.end()

        if self._diagram_hovered is not None:
            self._sensor_diagram_panel()
        # Recorded AFTER the panel is drawn, so next frame's "may a drag keep
        # this alive?" test asks about a panel that was really on screen.
        self._diagram_open = self._diagram_hovered is not None

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
        # The two sensor settings are explained by a pinned diagram panel
        # instead -- see _sensor_diagram_panel(). Note the hover here and show
        # no floating tooltip, so the two never overlap. Turning the diagram
        # off in Preferences falls through to the plain tooltip below, so those
        # sliders are never left with no explanation at all.
        mode = _DIAGRAM_MODES.get((setting.source, setting.field))
        if mode is not None and self._diagram_enabled():
            # The same delay flags the text tooltips use, so the diagram waits
            # its turn rather than flashing up the instant the cursor crosses a
            # slider on its way somewhere else.
            #
            # is_item_active() KEEPS it up through a drag: imgui stops reporting
            # hover once the drag starts, and the diagram going dark exactly
            # while you drag the slider it explains is the worst moment for it
            # to leave.
            #
            # But it must never be what first OPENS the panel, and THIS IS THE
            # WHOLE FIX for a bug worth not reintroducing: a window appearing
            # mid-drag is raised above the Project window, and imgui drops an
            # active drag once its owning window stops being frontmost. So
            # grabbing a slider before the hover delay elapsed would open the
            # panel and break the very drag that opened it.
            #
            # Requiring the panel to be up ALREADY means a drag can only sustain
            # one, never summon one -- and nothing new appears while dragging.
            # Fixing it with no_bring_to_front_on_focus instead would also work,
            # but by never raising the panel at all, leaving it buried behind
            # other windows.
            active = imgui.is_item_active()
            hovered = imgui.is_item_hovered(
                imgui.HoveredFlags_.delay_normal.value
                | imgui.HoveredFlags_.for_tooltip.value)
            if hovered or (active and self._diagram_open):
                self._diagram_hovered = (setting, mode)
            return

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

    def _diagram_enabled(self):
        """True if the sensor diagram is switched on in Preferences.

        Defaults to on when the payload is missing, matching the preference's
        own default -- the alternative silently disables the feature on any
        frame the prefs dict has not been built.
        """
        prefs = self._status.get('edit_prefs') or {}
        return bool(prefs.get('sensor_tooltip_diagram', True))

    def _sensor_diagram_panel(self):
        """The pinned diagram for the sensor settings, at the window's right edge.

        WHY PINNED RATHER THAN A NORMAL TOOLTIP
        A tooltip follows the cursor, and the cursor is on the slider being
        dragged -- so the diagram would jitter around the screen at exactly the
        moment it is meant to be watched. Anchoring it to the window's edge
        holds it still while the value under it changes, which is the whole
        point of an animated diagram.

        IT LIVES AND DIES WITH THE HOVER, and deliberately does not persist the
        way the reference's did. That one stayed up for as long as the cursor
        was anywhere in the physics window, which meant a panel about sensors
        hanging over the screen while you adjusted something unrelated. Here,
        moving off the slider closes it. The panel itself is therefore not
        interactive -- there is nothing in it to click, so nothing is lost.

        Call at the END of the Project window's build, while its position and
        size are still readable, but AFTER imgui.end() -- a window cannot be
        opened inside another.
        """
        setting, mode = self._diagram_hovered
        graphic = self._status.get('tooltip_graphic')
        # No renderer means the Orchestrator did not supply one. The UI owns no
        # GPU resources of its own, so a missing diagram is a cosmetic loss
        # rather than a broken window: fall back to nothing at all.
        if graphic is None:
            return

        config = self._status.get('edit_config') or {}
        texture = graphic.render(
            imgui.get_time(),
            angle_mode=(mode == 'angle'),
            distance_mode=(mode == 'distance'),
            sensor_angle=config.get('sensor_angle', 0.0),
            sensor_distance=config.get('sensor_distance', 0.0),
        )

        imgui.set_next_window_pos(
            imgui.ImVec2(self._diagram_anchor.x + self._diagram_anchor_width,
                         self._diagram_anchor.y))
        imgui.set_next_window_size(imgui.ImVec2(0, 0))
        imgui.begin(
            "##sensor_diagram",
            flags=(imgui.WindowFlags_.no_title_bar.value
                   | imgui.WindowFlags_.no_move.value
                   | imgui.WindowFlags_.no_resize.value
                   | imgui.WindowFlags_.always_auto_resize.value
                   | imgui.WindowFlags_.no_focus_on_appearing.value
                   # NOT no_bring_to_front_on_focus. It would also stop the
                   # drag being broken, but by never raising the panel at all --
                   # which buries it behind every other window and makes the
                   # diagram useless. The panel must come to the front; it just
                   # must not do so DURING a drag, which is what the
                   # _diagram_open guard in _tooltip() handles instead.
                   | imgui.WindowFlags_.no_nav.value
                   | imgui.WindowFlags_.no_docking.value
                   # Nothing in here is clickable, and the panel sits directly
                   # under the cursor's path off the slider. Letting it eat
                   # mouse input would block the canvas behind it.
                   | imgui.WindowFlags_.no_inputs.value),
        )

        size = float(tooltip_graphic.TEXTURE_SIZE)
        imgui.image(texture, imgui.ImVec2(size, size))
        imgui.push_text_wrap_pos(size + _DIAGRAM_TEXT_EXTRA)
        imgui.text_disabled(setting.label)
        imgui.separator()
        imgui.text_unformatted(setting.help)
        imgui.pop_text_wrap_pos()
        imgui.end()

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
