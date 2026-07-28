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

REVERT, at the top, is the coarser version of that: back to what is on disk,
discarding everything since. It dispatches the SAME load command File > Load
does, with the same entry, so the two can never drift apart -- see
_revert_button().

Values are pushed on every change, straight into the GPU buffer -- editing a
slider shows its effect immediately, which is the point of having sliders at
all rather than editing JSON.
"""

from __future__ import annotations

import math

from imgui_bundle import imgui

from . import gated_controls as gated
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

        #: Open gestures and forced-open gates for the self-hiding controls.
        #: See ui/gated_controls.py -- all of that behaviour lives there.
        self._gates = gated.GateState()

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
            # Same reasoning for the gated sliders: a control that stops being
            # rendered never gets its deactivation, and a session left open
            # would hold it expanded when the window comes back.
            self._gates.clear()
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
            self._gates.clear()          # ditto -- nothing rendered, no gestures
            return

        self._revert_button(project)

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

    def _revert_button(self, project):
        """Reload the project's own file, discarding every edit since.

        The escape hatch for the window below it: these controls write straight
        into the GPU buffer with no confirmation, so an experiment that went
        nowhere needs one click to undo rather than a hunt for which sliders
        were moved.

        DELIBERATELY THE SAME COMMAND File > Load > <this project> dispatches,
        with the same entry -- not a private "reset" path. Whatever loading does
        (history entry, camera, preset index) is what reverting does, and the
        two cannot drift apart later. The tooltip says so, because a button that
        silently duplicates a menu item is a button people are afraid to press.

        Greyed out when nothing on disk matches, which is the Untitled case: a
        project that was never loaded or saved has nothing to revert TO.
        """
        entry = self._revert_entry()
        if entry is None:
            imgui.begin_disabled()
        # Full width, so it reads as a header for the window rather than a
        # control belonging to the first group.
        if imgui.button(f"Revert to {project} (Ctrl-R)",
                        imgui.ImVec2(-1.0, 0.0)) and entry is not None:
            self._dispatch('load_config', entry)
        if entry is None:
            imgui.end_disabled()
        self._revert_tooltip(project, entry)

    def _revert_tooltip(self, project, entry):
        if not imgui.is_item_hovered(imgui.HoveredFlags_.delay_normal.value
                                     | imgui.HoveredFlags_.for_tooltip.value
                                     | imgui.HoveredFlags_.allow_when_disabled.value):
            return
        if not imgui.begin_tooltip():
            return
        imgui.push_text_wrap_pos(320.0)
        if entry is None:
            imgui.text_disabled("Revert")
            imgui.separator()
            imgui.text_unformatted(
                "Nothing to revert to: this project has not been loaded from "
                "or saved to a file yet. Save it first.")
        else:
            imgui.text_disabled(f"Revert to {project}")
            imgui.separator()
            imgui.text_unformatted(
                f"Exactly equivalent to File > Load > {project} -- it reloads "
                f"the same file through the same path.\n\n"
                f"Every change made since it was loaded is discarded, "
                f"including world settings and the camera. Undo (Ctrl+Z) still "
                f"gets them back.")
        imgui.pop_text_wrap_pos()
        imgui.end_tooltip()

    def _revert_entry(self):
        """The load-menu entry for the currently loaded project, or None.

        Matched by NAME against the same categories the Load menu renders from,
        so the button and the menu item cannot disagree about which file is
        meant -- and a project whose file has since been deleted correctly finds
        nothing rather than dispatching a load of a missing path.
        """
        project = self._status.get('project_name')
        if not project:
            return None
        for entries in (self._status.get('config_categories') or {}).values():
            for entry in entries:
                if entry.name == project:
                    return entry
        return None

    # ------------------------------------------------------------------

    def _source_of(self, setting):
        """The payload dict holding this setting's source, as a plain dict."""
        return self._status.get({
            spec.CONFIG: 'edit_config',
            spec.WORLD: 'edit_world',
            spec.PREFS: 'edit_prefs',
        }[setting.source]) or {}

    def _value_of(self, setting):
        """Current value for a setting, from whichever source owns it."""
        return self._source_of(setting).get(setting.field)

    def _render_setting(self, setting):
        value = self._value_of(setting)

        # Hangs off a checkbox that is currently off: not rendered at all.
        # Greying it out instead would keep a row of dead sliders on screen for
        # every effect the user is not using, which is the wall this avoids.
        if setting.reveals_on and not self._revealed(setting):
            return

        # A GATES checkbox has no field of its own -- it is derived from the
        # ones it reveals -- so it never reaches the value checks below.
        if setting.gates:
            gated.draw_gate(setting, self._gates, self._gate_checked(setting),
                            self._clear_gated)
            self._tooltip(setting)
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

        A GATES checkbox owns no field, so `reveals_on` may name its LABEL
        instead of a stored bool. It must be asked the same question the box
        itself answers, overrides included -- the raw derivation would leave a
        ticked box with nothing under it, since ticking is exactly the case
        where the gated values are all still zero.
        """
        gate = gated.gate_by_label(setting.reveals_on)
        if gate is not None:
            return self._gate_checked(gate)
        return bool(self._source_of(setting).get(setting.reveals_on, False))

    def _gate_checked(self, gate):
        """Whether a GATES checkbox reads as ticked: derived, or forced open."""
        return self._gate_open(gate) or gate.label in self._gates.forced

    def _gate_open(self, gate):
        """True if any field a GATES checkbox covers is non-zero.

        EXACTLY zero, deliberately: the gravity sliders are bipolar and pass
        through zero on the way between real values, so a tolerance here would
        collapse the control around a deliberate hair's-breadth setting.
        """
        source = self._source_of(gate)
        return any(float(source.get(f, 0.0) or 0.0) != 0.0 for f in gate.gates)

    def _clear_gated(self, gate):
        """Zero every field a GATES checkbox covers -- what unticking means."""
        for field in gate.gates:
            member = gated.setting_for(gate.source, field)
            if member is not None and float(self._value_of(member) or 0.0) != 0.0:
                self._dispatch('edit_setting', member, 0.0)

    def _draw_widget(self, setting, value, interactive):
        label = f"{setting.label}##{setting.source}.{setting.field}"

        if setting.kind == spec.SEED:
            self._draw_seed(setting, value, interactive)
            return

        if setting.kind == spec.INPUT:
            self._draw_input(setting, value, interactive)
            return

        if gated.is_gated(setting):
            gated.draw_gated(
                setting, value, self._gates, self._gated_slider,
                lambda s, v: self._dispatch('edit_setting', s, v), interactive)
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
            self._draw_curved_slider(setting, self._shown(setting, value),
                                     interactive)
            return

        # Default: float slider. Ctrl+click types an exact value, which is how
        # a config can hold a value outside these fixed bounds without a
        # range-editing UI.
        changed, new = imgui.slider_float(label, self._shown(setting, value),
                                          setting.lo, setting.hi)
        if changed and interactive:
            self._dispatch('edit_setting', setting, self._stored(setting, new))

    @staticmethod
    def _shown(setting, value):
        """Stored value -> what the slider displays. Identity unless inverted.

        `inverted` settings are named for the opposite of what the simulation
        stores (Trail Stiffness vs. trail diffusion), so the flip lives here and
        in `_stored` alone: everything downstream of the dispatch, and every
        saved config, still speaks the stored quantity.
        """
        value = float(value)
        if not setting.inverted:
            return value
        return (setting.lo + setting.hi) - value

    @staticmethod
    def _stored(setting, value):
        """What the slider displays -> the value to store. Inverse of `_shown`.

        The mapping is its own inverse, so this is `_shown` again -- kept as a
        separate name because the call sites read as directions, and a later
        non-symmetric mapping would only have to change one of them.
        """
        return SettingsWindow._shown(setting, value)

    def _draw_curved_slider(self, setting, value, interactive):
        """A slider whose TRAVEL is bent, for ranges squashed against one end.

        imgui has no power-scaled slider, so the widget is driven in normalized
        0..1 POSITION space and the real value is mapped in and out around it:

            pos   = ((value - lo) / (hi - lo)) ** (1/curve)
            value = lo + (hi - lo) * pos ** curve

        The value is never stored curved. What is saved and dispatched is the
        real number, so a curve is purely how the control feels -- changing one
        cannot change what a config means.

        `value` arrives in DISPLAY space (see _shown), which for every setting
        but an `inverted` one is the stored number. The readout therefore shows
        what the label promises, and the dispatch converts back. The value the
        slider settled on is RETURNED, also in display space, for the gated
        caller that has to test it before the status payload catches up.

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
            return float(value)

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
            # `value` arrived already in display space, so the new one leaves in
            # display space too and is converted back before it is stored.
            display = lo + span * (min(1.0, max(0.0, new_pos)) ** setting.curve)
            self._dispatch('edit_setting', setting, self._stored(setting, display))
            return display
        # Returned in DISPLAY space, matching what came in -- the gated caller
        # converts back. Lets that caller test what the slider just produced
        # rather than the status payload, which still holds the old value.
        return float(value)

    def _gated_slider(self, setting, value):
        """Render a gated control's slider. Returns the value it settled on.

        Gating works in STORED space (`gate_base` is a stored value) while the
        slider shows display space, so the conversions compose here exactly as
        they do on the ungated paths -- Trail Stiffness is both gated and
        inverted, and Hazard Rate both gated and curved.
        """
        label = f"{setting.label}##{setting.source}.{setting.field}"
        if setting.kind == spec.GATED_INT:
            changed, new = imgui.slider_int(label, int(value),
                                            int(setting.lo), int(setting.hi))
            if changed:
                self._dispatch('edit_setting', setting, int(new))
                return float(int(new))
            return float(value)
        if setting.curve != 1.0:
            return self._stored(setting, self._draw_curved_slider(
                setting, self._shown(setting, value), interactive=True))
        changed, new = imgui.slider_float(label, self._shown(setting, value),
                                          setting.lo, setting.hi)
        if changed:
            stored = self._stored(setting, new)
            self._dispatch('edit_setting', setting, stored)
            return stored
        return float(value)

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
        self._gates.sync((self._status.get('project_name'),
                          self._status.get('selected_config')),
                         self._gate_open)

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
