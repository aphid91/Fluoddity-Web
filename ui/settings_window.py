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


def _setting_for(source, field):
    """The registry entry owning `field` on `source`, or None.

    Keyed on both halves because a field name alone is not unique across the
    three sources -- the same reason _DIAGRAM_MODES is keyed that way.
    """
    for setting in spec.SETTINGS:
        if setting.source == source and setting.field == field:
            return setting
    return None


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

        #: Labels of GATES checkboxes the user has ticked while everything they
        #: gate is still zero. Without this the box would spring back the
        #: instant it was ticked, since its state is otherwise derived purely
        #: from those values -- there is nowhere else for "revealed but not yet
        #: set" to live. Session-only and deliberately unsaved: a config with no
        #: gravity in it should open with the box unticked.
        self._gate_forced = set()
        #: (project, selected config) the overrides above belong to. When this
        #: changes, the values on screen came from somewhere other than the
        #: user, so the overrides are dropped and the boxes re-derive from
        #: whatever was loaded -- see _sync_gates().
        self._gate_identity = None

        #: (source, field) of every GATED slider with a gesture in flight --
        #: held, dragged, or taking ctrl+click text. Such a slider stays on
        #: screen whatever its value does, and is the ONLY thing that keeps it
        #: there once the value reaches base. Opened on is_item_active(), closed
        #: on is_item_deactivated(), which is where the fold-back is decided.
        #: See _draw_gated() for why a global "is the user busy?" test cannot
        #: replace this.
        self._gate_sessions = set()

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
            # Same reasoning for gated sliders: a control that stops being
            # rendered never gets its deactivation, and a session left open
            # would hold it expanded when the window comes back.
            self._gate_sessions.clear()
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
            self._gate_sessions.clear()  # ditto -- nothing rendered, no sessions
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

        # A GATES checkbox has no field of its own -- it is derived from the
        # ones it reveals -- so it never reaches the value checks below.
        if setting.gates:
            self._draw_gate(setting)
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
        """
        source = {
            spec.CONFIG: self._status.get('edit_config') or {},
            spec.WORLD: self._status.get('edit_world') or {},
            spec.PREFS: self._status.get('edit_prefs') or {},
        }[setting.source]
        # A GATES checkbox owns no field, so `reveals_on` names its LABEL rather
        # than a stored bool. Its state is derived from the fields it gates --
        # nothing is stored for it, which is the point.
        gate = self._gate_by_label(setting.reveals_on)
        if gate is not None:
            # Must ask the same question the checkbox answers, override and all
            # -- reading the raw derivation here would leave a ticked box with
            # nothing under it, since ticking is exactly the case where the
            # gated values are all still zero.
            return self._gate_checked(gate)
        return bool(source.get(setting.reveals_on, False))

    def _gate_checked(self, gate):
        """Whether a GATES checkbox reads as ticked: derived, or forced open."""
        return self._gate_open(gate) or gate.label in self._gate_forced

    @staticmethod
    def _gate_by_label(label):
        """The GATES checkbox named by `label`, or None if it is a real field."""
        if not label:
            return None
        for candidate in spec.SETTINGS:
            if candidate.gates and candidate.label == label:
                return candidate
        return None

    def _gate_open(self, gate):
        """True if any field a GATES checkbox covers is non-zero.

        EXACTLY zero, deliberately: the gravity sliders are bipolar and pass
        through zero on the way between real values, so a tolerance here would
        make a deliberate hair's-breadth setting collapse the control it is in.
        """
        source = {
            spec.CONFIG: self._status.get('edit_config') or {},
            spec.WORLD: self._status.get('edit_world') or {},
            spec.PREFS: self._status.get('edit_prefs') or {},
        }[gate.source]
        return any(float(source.get(f, 0.0) or 0.0) != 0.0 for f in gate.gates)

    def _draw_widget(self, setting, value, interactive):
        label = f"{setting.label}##{setting.source}.{setting.field}"

        if setting.kind == spec.SEED:
            self._draw_seed(setting, value, interactive)
            return

        if setting.kind == spec.INPUT:
            self._draw_input(setting, value, interactive)
            return

        if setting.kind in (spec.GATED, spec.GATED_INT):
            self._draw_gated(setting, value, interactive)
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

    def _draw_gate(self, setting, interactive=True):
        """A checkbox derived from the fields it gates, storing nothing itself.

        Ticking it does not set a flag -- there is no flag. It reveals the
        sliders beneath it, which are already at zero, and the box stays ticked
        because `self._gate_forced` remembers the click for as long as they sit
        there. Unticking zeroes them, at which point the derivation agrees on
        its own and the memory is dropped.

        That memory is the one piece of session state this pattern needs, and
        it is deliberately not persisted: reopening the app with a zeroed
        gravity shows the box unticked, which is the honest reading of the
        config.
        """
        changed, new = imgui.checkbox(f"{setting.label}##gate.{setting.label}",
                                      self._gate_checked(setting))
        if not (changed and interactive):
            return

        if new:
            # Nothing to write: the sliders keep the zeros they already hold and
            # simply become visible. Remembering the click is what holds the box
            # open until they are given a value.
            self._gate_forced.add(setting.label)
            return

        self._gate_forced.discard(setting.label)
        # Unticking must actually turn gravity OFF, not just hide a live value:
        # a hidden slider still pulling every particle down is the worst
        # possible outcome of a checkbox.
        for field in setting.gates:
            member = _setting_for(setting.source, field)
            if member is not None and float(self._value_of(member) or 0.0) != 0.0:
                self._dispatch('edit_setting', member, 0.0)

    def _draw_gated(self, setting, value, interactive):
        """A slider that folds itself back into a checkbox at its base value.

        THE SESSION LATCH IS WHAT MAKES THIS WORK, and it is worth understanding
        before touching any of it. The slider is shown when the value is off
        base OR while a session is open on it:

            show = not at base  or  session open

        A session opens the moment imgui reports the widget active -- a click, a
        drag, or entering ctrl+click text entry -- and closes only when imgui
        reports it deactivated. The fold-back is evaluated at exactly that
        closing edge and nowhere else.

        WHY NOT SIMPLY TEST THE VALUE EACH FRAME. Because the value passes
        through the off zone DURING the gesture: drag a jitter slider to the
        bottom and it is at zero long before you let go. Folding then destroys
        the drag that produced it -- imgui drops a drag whose widget stops being
        submitted. The latch holds the slider on screen for the whole gesture
        no matter what the value does, which is the entire point.

        Detecting "is the user busy?" from global state (any mouse down, imgui
        wants the keyboard) was the previous attempt and does not work: those
        are true during the drag but false on the frame it ends, which is the
        one frame the fold-back actually runs -- so it fired at the release with
        the value already inside the off zone, and the control vanished anyway.
        The latch is per widget and edge-triggered, so it cannot make that
        mistake.

        THE OFF ZONE IS MEASURED IN SLIDER POSITION, not in value. For a curved
        slider the two are wildly different: Hazard Rate is cubed, so 0.01% of
        the way along the bar is 1e-12 in value. Position is what the user is
        actually manipulating and what "barely off the bottom" means to the eye,
        so both the fold-back test and the tick nudge work in that space.

        WHY TICKING DOES NOT SET EXACTLY THE BASE
        The control is derived: at base with no session it shows a checkbox, so
        setting base on tick would re-derive as unticked in the same frame and
        the slider would never appear. It is nudged just off instead -- one
        epsilon of POSITION, which for Hazard Rate is a value indistinguishable
        from zero rather than a few-percent jump up the bar.
        """
        base = float(setting.gate_base)
        current = float(value)
        integral = setting.kind == spec.GATED_INT
        key = (setting.source, setting.field)

        if self._gate_off(setting, current) and key not in self._gate_sessions:
            changed, new = imgui.checkbox(
                f"{setting.label}##{setting.source}.{setting.field}", False)
            if changed and new and interactive:
                # Opening the session here too means the slider appears even if
                # the nudge somehow lands inside the off zone -- the checkbox
                # can never "not respond" to being ticked.
                self._gate_sessions.add(key)
                self._dispatch('edit_setting', setting,
                               int(base + 1.0) if integral
                               else self._gate_nudged(setting))
            return

        # Gating works in STORED space (gate_base is a stored value), but the
        # slider itself shows display space -- Trail Stiffness is both gated and
        # inverted, so the two conversions have to compose here exactly as they
        # do on the ungated paths.
        label = f"{setting.label}##{setting.source}.{setting.field}"
        # Tracked so the fold-back below tests what the slider JUST produced.
        # _value_of() reads the status payload, which is a snapshot taken before
        # this frame's dispatches, so it would still hold the pre-drag value.
        landed = current
        if integral:
            changed, new = imgui.slider_int(label, int(current),
                                            int(setting.lo), int(setting.hi))
            if changed and interactive:
                landed = float(int(new))
                self._dispatch('edit_setting', setting, int(new))
        elif setting.curve != 1.0:
            # Curved and gated compose: Hazard Rate is both.
            landed = self._stored(setting, self._draw_curved_slider(
                setting, self._shown(setting, current), interactive))
        else:
            changed, new = imgui.slider_float(label, self._shown(setting, current),
                                              setting.lo, setting.hi)
            if changed and interactive:
                landed = self._stored(setting, new)
                self._dispatch('edit_setting', setting, landed)

        if not interactive:
            return

        # HOLD the session open for as long as imgui says the widget is being
        # worked -- held, dragged, or taking typed input.
        if imgui.is_item_active():
            self._gate_sessions.add(key)
            return

        # THE CLOSING EDGE, and the only place the fold-back may happen.
        # is_item_deactivated() rather than ..._after_edit(): a drag that ends
        # back where it started is still a finished gesture, and the control
        # should settle the same way either way.
        if not imgui.is_item_deactivated():
            return
        self._gate_sessions.discard(key)
        # Snap to exactly base, so the derivation is unambiguous rather than
        # "within epsilon" -- which is also what makes a saved config carrying a
        # stray 1e-9 come back as a clean unticked box.
        if landed != base and self._gate_off(setting, landed):
            self._dispatch('edit_setting', setting,
                           int(base) if integral else base)

    def _gate_position(self, setting, value):
        """Where `value` sits along the slider's TRAVEL, as 0..1 from the base.

        Curved sliders make value distance and visual distance disagree by
        orders of magnitude, and it is the visual one that decides whether a
        control looks like it is sitting at zero. Mirrors the mapping in
        _draw_curved_slider, so the two cannot drift apart.
        """
        lo, hi = float(setting.lo), float(setting.hi)
        span = hi - lo
        if span == 0.0:
            return 0.0
        norm = min(1.0, max(0.0, (float(value) - lo) / span))
        pos = norm ** (1.0 / setting.curve) if setting.curve != 1.0 else norm
        base_norm = min(1.0, max(0.0, (float(setting.gate_base) - lo) / span))
        base_pos = (base_norm ** (1.0 / setting.curve)
                    if setting.curve != 1.0 else base_norm)
        return abs(pos - base_pos)

    def _gate_off(self, setting, value):
        """True if `value` is close enough to base to count as switched off.

        Integer controls compare exactly -- there is no "nearly 1 sample".
        """
        if setting.kind == spec.GATED_INT:
            return int(round(float(value))) == int(round(float(setting.gate_base)))
        return self._gate_position(setting, value) <= setting.gate_epsilon

    def _gate_nudged(self, setting):
        """The value one epsilon of POSITION off base -- what ticking sets.

        Strictly outside the off zone (the test is `<=`), or the box would
        re-derive as unticked in the same frame and the slider never appear.
        """
        lo, hi = float(setting.lo), float(setting.hi)
        span = hi - lo
        if span == 0.0:
            return float(setting.gate_base)
        base_norm = min(1.0, max(0.0, (float(setting.gate_base) - lo) / span))
        base_pos = (base_norm ** (1.0 / setting.curve)
                    if setting.curve != 1.0 else base_norm)
        # Away from whichever end the base sits at, so a base of `hi` steps down.
        step = setting.gate_epsilon * 2.0
        pos = base_pos + (step if base_pos <= 0.5 else -step)
        pos = min(1.0, max(0.0, pos))
        return lo + span * (pos ** setting.curve if setting.curve != 1.0 else pos)

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

    def _sync_gates(self):
        """Retire forced-open gates that no longer need the override.

        _gate_forced exists only to hold a box open between the tick and the
        first drag, while everything under it is still zero. Two things end
        that, and both mean the override has done its job:

        ONCE THE VALUES ARE NON-ZERO the derivation reads "open" by itself, so
        the override is redundant. Dropping it here rather than leaving it set
        is what lets a later load of a zeroed config close the box.

        ON A LOAD OR CONFIG SWITCH the values on screen are no longer the ones
        the user ticked the box for. Whatever they are now is the honest answer,
        so the override goes and the derivation speaks for the new config --
        which is the "setting the value outside of user interaction" case.
        """
        identity = (self._status.get('project_name'),
                    self._status.get('selected_config'))
        if identity != self._gate_identity:
            self._gate_identity = identity
            self._gate_forced.clear()
            # Sessions too: a load can swap the value under a slider that never
            # got its deactivation (the window closed, the tier changed, the
            # control stopped being rendered). A stale session would hold an
            # at-base slider open forever, since nothing else can close one.
            self._gate_sessions.clear()
            return

        for gate in tuple(self._gate_forced):
            setting = self._gate_by_label(gate)
            if setting is None or self._gate_open(setting):
                self._gate_forced.discard(gate)

    def _sync_input_buffers(self):
        """Refresh INPUT text from live values when they change elsewhere.

        Without this, loading a config would leave stale text in the boxes.
        Buffers being edited are left alone -- imgui owns focus, and clobbering
        text mid-type would be hostile.
        """
        self._sync_gates()

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
