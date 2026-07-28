"""Controls that hide themselves when switched off.

Several settings are "off" at one end of their range and only interesting when
deliberately turned on: jitter, fences, hazard rate, motion blur, gravity. Left
as plain sliders they are knobs to scan past, all sitting at zero. Two kinds of
control here fix that, and both derive their on/off state from the values
themselves -- nothing extra is stored, so save, load, undo and A/B preview all
keep working with no knowledge that any of this exists.

GATED (kind=GATED / GATED_INT)   one slider, gated on its own value.
    Shows a checkbox while it holds `gate_base`, the slider otherwise.
    Ticking sets a value just off base; dragging back to base folds it away.

GATES (a Setting with `gates=(...)`)   one checkbox in front of other sliders.
    Owns no field. Reads as ticked while any field it names is non-zero, and
    members point at it by LABEL in `reveals_on`. Gravity uses this: two
    bipolar sliders that pass through zero between real values, so they must
    not self-hide -- hence a plain gate rather than two GATED controls.

THE SESSION LATCH, which is the part worth understanding before editing:

    show slider = value is off base  OR  a session is open on this control

A session opens when imgui reports the widget active (click, drag, or ctrl+click
text entry) and closes when it reports deactivated. The fold-back is evaluated
at that closing edge and NOWHERE else.

Testing the value every frame instead cannot work: the value passes through the
off zone during the gesture -- drag a slider to the bottom and it is at zero
long before you let go -- and folding then destroys the drag that produced it,
because imgui drops a drag whose widget stops being submitted. Detecting "is the
user busy?" from global state (any mouse down, imgui wants the keyboard) fails
for a subtler reason: those go false on the very frame the gesture ends, which
is the one frame the fold-back runs.

THE OFF ZONE IS MEASURED IN SLIDER POSITION, not value. Hazard Rate is cubed, so
0.01% along its bar is 1e-12 in value; a zone defined in value would swallow
half the visible slider. Position is what the user manipulates and what "sitting
at zero" means to the eye.
"""

from __future__ import annotations

from imgui_bundle import imgui

from . import settings_spec as spec


def is_gated(setting):
    """True for a slider that hides itself behind a checkbox."""
    return setting.kind in (spec.GATED, spec.GATED_INT)


def position(setting, value):
    """Where `value` sits along the slider's travel, as 0..1.

    Mirrors the mapping in the curved-slider widget so the two cannot drift.
    """
    lo, span = float(setting.lo), float(setting.hi) - float(setting.lo)
    if span == 0.0:
        return 0.0
    norm = min(1.0, max(0.0, (float(value) - lo) / span))
    return norm ** (1.0 / setting.curve) if setting.curve != 1.0 else norm


def value_at(setting, pos):
    """Inverse of `position`: the value at 0..1 along the travel."""
    lo, span = float(setting.lo), float(setting.hi) - float(setting.lo)
    pos = min(1.0, max(0.0, pos))
    return lo + span * (pos ** setting.curve if setting.curve != 1.0 else pos)


def is_off(setting, value):
    """True if `value` is close enough to base to count as switched off.

    Integers compare exactly -- there is no "nearly 1 sample".
    """
    if setting.kind == spec.GATED_INT:
        return int(round(float(value))) == int(round(float(setting.gate_base)))
    offset = abs(position(setting, value) - position(setting, setting.gate_base))
    return offset <= setting.gate_epsilon


def nudged(setting):
    """The value ticking the checkbox sets: one epsilon of position off base.

    Must land strictly outside the off zone (`is_off` tests `<=`), or the
    control would re-derive as off in the same frame and never open. Steps away
    from whichever end the base sits at, so a base of `hi` steps down.
    """
    if setting.kind == spec.GATED_INT:
        return int(float(setting.gate_base) + 1.0)
    base_pos = position(setting, setting.gate_base)
    step = setting.gate_epsilon * 2.0
    return value_at(setting, base_pos + (step if base_pos <= 0.5 else -step))


class GateState:
    """Per-control state the gating needs: open sessions and forced-open gates.

    Both are session-only and deliberately unsaved -- a config with no gravity
    in it should open with the box unticked.
    """

    def __init__(self):
        #: (source, field) of GATED sliders with a gesture in flight. Such a
        #: slider stays on screen whatever its value does, and this is the only
        #: thing keeping it there once the value reaches base.
        self.sessions = set()
        #: Labels of GATES checkboxes ticked while everything they gate is still
        #: zero. Without this the box would spring back the instant it was
        #: ticked, since its state is otherwise derived purely from those values.
        self.forced = set()
        #: (project, config) the above belong to; a change means the values came
        #: from a load rather than the user, so both are dropped.
        self.identity = None

    def clear(self):
        """Drop everything -- nothing on screen, so no gesture can be live."""
        self.sessions.clear()
        self.forced.clear()

    def sync(self, identity, gate_is_open):
        """Retire state that no longer applies, once per frame.

        A forced gate is redundant the moment its values go non-zero (the
        derivation says "open" on its own), and everything is dropped when the
        project or selected config changes -- that is the "value set outside of
        user interaction" case, where whatever was loaded should speak for
        itself.
        """
        if identity != self.identity:
            self.identity = identity
            self.clear()
            return
        for gate in tuple(self.forced):
            setting = gate_by_label(gate)
            if setting is None or gate_is_open(setting):
                self.forced.discard(gate)


def gate_by_label(label):
    """The GATES checkbox named by `label`, or None if it is a real bool field."""
    if not label:
        return None
    for candidate in spec.SETTINGS:
        if candidate.gates and candidate.label == label:
            return candidate
    return None


def setting_for(source, field):
    """The registry entry owning `field` on `source`, or None.

    Keyed on both halves because a field name alone is not unique across the
    three sources.
    """
    for setting in spec.SETTINGS:
        if setting.source == source and setting.field == field:
            return setting
    return None


def draw_gate(setting, state, checked, on_clear, interactive=True):
    """The GATES checkbox. Stores nothing; `checked` is the derived answer.

    Ticking writes no flag -- it just reveals the sliders, which are already at
    zero, and `state.forced` holds the box open until they are given a value.
    Unticking calls `on_clear` to zero them, because a hidden slider still
    pulling every particle down is the worst outcome a checkbox could have.
    """
    changed, new = imgui.checkbox(f"{setting.label}##gate.{setting.label}",
                                  checked)
    if not (changed and interactive):
        return
    if new:
        state.forced.add(setting.label)
    else:
        state.forced.discard(setting.label)
        on_clear(setting)


def draw_gated(setting, value, state, draw_slider, dispatch, interactive):
    """A slider that folds back into a checkbox at its base value.

    `draw_slider(setting, value)` renders the slider itself and returns the
    value it settled on, in STORED space -- the caller owns widget details like
    curves and inverted display. This function owns only the gating.

    Returns nothing; edits go through `dispatch(setting, value)`.
    """
    base = float(setting.gate_base)
    current = float(value)
    key = (setting.source, setting.field)

    if is_off(setting, current) and key not in state.sessions:
        changed, new = imgui.checkbox(
            f"{setting.label}##{setting.source}.{setting.field}", False)
        if changed and new and interactive:
            # Open the session here too, so the checkbox always visibly responds
            # even before the nudged value reaches the next frame's payload.
            state.sessions.add(key)
            dispatch(setting, nudged(setting))
        return

    # The value the slider just produced -- not the payload, which is a snapshot
    # taken before this frame's dispatches and still holds the old one.
    landed = draw_slider(setting, current)
    if not interactive:
        return

    if imgui.is_item_active():
        state.sessions.add(key)
        return

    # The closing edge: the only place the fold-back may happen.
    # is_item_deactivated() rather than ..._after_edit(), because a drag that
    # ends back where it started is still a finished gesture.
    if not imgui.is_item_deactivated():
        return
    state.sessions.discard(key)
    # Snap to exactly base, so "is it off?" stays unambiguous rather than
    # "within epsilon" -- which is also what makes a config carrying a stray
    # 1e-9 come back as a clean unticked box.
    if landed != base and is_off(setting, landed):
        dispatch(setting, int(base) if setting.kind == spec.GATED_INT else base)
