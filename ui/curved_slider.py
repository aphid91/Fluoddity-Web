"""A slider whose travel is bent, for ranges squashed against one end.

Extracted from settings_window.py, which was doing four jobs. This is one of
them: a self-contained widget with no state of its own, so it is a plain
function rather than a mixin.

The registry (ui/settings_spec.py) decides which settings want one, via a
`curve` on the Setting; this module only knows how to draw it.
"""

from __future__ import annotations

import math

from imgui_bundle import imgui


def draw_curved_slider(setting, value, interactive, *, on_edit, to_stored):
    """Draw the slider. Returns the value it settled on, in DISPLAY space.

    imgui has no power-scaled slider, so the widget is driven in normalized
    0..1 POSITION space and the real value is mapped in and out around it:

        pos   = ((value - lo) / (hi - lo)) ** (1/curve)
        value = lo + (hi - lo) * pos ** curve

    The value is never stored curved. What is saved and dispatched is the real
    number, so a curve is purely how the control feels -- changing one cannot
    change what a config means.

    `value` arrives in DISPLAY space (see SettingsWindow._shown), which for
    every setting but an `inverted` one is the stored number. The readout
    therefore shows what the label promises, and `to_stored` converts back
    before dispatch. The settled value is RETURNED, also in display space, for
    the gated caller that has to test it before the status payload catches up.

    The readout is explicit for the same reason: with a bent slider the handle
    position no longer suggests the magnitude, so the number has to be legible.
    It is formatted at a precision that suits the range rather than imgui's
    default %.3f, which would show a whole useful range of a rate like Hazard
    Rate as "0.000".

    `on_edit(setting, stored_value)` is called when the user moves it;
    `to_stored(setting, display_value)` maps display space back to storage.
    Both are passed in rather than reached for, so this module needs no host.
    """
    label = f"{setting.label}##{setting.source}.{setting.field}"
    lo, hi = float(setting.lo), float(setting.hi)
    span = hi - lo

    # Guard the degenerate registry entry rather than producing inf/NaN and a
    # slider that cannot be moved.
    if span <= 0.0:
        imgui.text_disabled(f"{setting.label}: empty range")
        return float(value)

    # A config may legitimately hold a value outside the slider's bounds
    # (ctrl+click types one), so clamp the POSITION rather than the value: the
    # handle pins to the end while the readout still tells the truth.
    norm = min(1.0, max(0.0, (float(value) - lo) / span))
    pos = norm ** (1.0 / setting.curve)

    # Enough decimals to distinguish adjacent positions at the fine end, where
    # the curve spends most of its travel.
    decimals = max(3, min(8, int(round(-math.log10(span))) + 4))
    changed, new_pos = imgui.slider_float(label, pos, 0.0, 1.0,
                                          f"{float(value):.{decimals}f}")
    if changed and interactive:
        # `value` arrived already in display space, so the new one leaves in
        # display space too and is converted back before it is stored.
        display = lo + span * (min(1.0, max(0.0, new_pos)) ** setting.curve)
        on_edit(setting, to_stored(setting, display))
        return display
    # Returned in DISPLAY space, matching what came in -- the gated caller
    # converts back. Lets that caller test what the slider just produced rather
    # than the status payload, which still holds the old value.
    return float(value)
