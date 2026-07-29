"""The pinned, animated diagram explaining the two sensor settings.

Extracted from settings_window.py, which was doing four jobs. This is the one
with STATE -- a small open/close/anchor machine spread across the frame -- so it
is a class rather than loose functions, the way ui/gated_controls.py is.

THE LIFECYCLE, which is why the state exists at all
The three fields are read and written at different points of a single frame:

    top of frame      hovered = None            (nothing carries over)
    ...sliders...     note(setting, mode)       from whichever slider is hovered
    before end()      set_anchor(pos, width)    while the window is measurable
    after end()       draw(...)                 a window cannot open inside one

`is_open` is LAST frame's answer, deliberately: sliders render before the panel
does, so this frame's is not known when a slider asks whether a drag may keep an
already-open panel alive.

WHY PINNED RATHER THAN A NORMAL TOOLTIP
A tooltip follows the cursor, and the cursor is on the slider being dragged --
so the diagram would jitter around the screen at exactly the moment it is meant
to be watched. Anchoring it to the window's edge holds it still while the value
under it changes, which is the whole point of an animated diagram.

IT LIVES AND DIES WITH THE HOVER, and deliberately does not persist the way the
reference's did. That one stayed up for as long as the cursor was anywhere in
the physics window, which meant a panel about sensors hanging over the screen
while you adjusted something unrelated. Here, moving off the slider closes it.
The panel itself is therefore not interactive -- there is nothing in it to
click, so nothing is lost.

This module owns no GPU resources (ARCHITECTURE rule 10): the renderer is handed
in per draw, and it only calls render() and gets a texture id back.
"""

from __future__ import annotations

from imgui_bundle import imgui

from . import settings_spec as spec
#: Imported for TEXTURE_SIZE alone -- the diagram's own edge length, which the
#: panel has to size its image and text column against. The RENDERER arrives
#: through _status, not from here: the UI owns no GPU resources (rule 10).
from tooltip_graphic import TEXTURE_SIZE

#: Settings explained by the shader-drawn diagram instead of a plain tooltip,
#: mapped to which quantity the diagram animates. Keyed by (source, field) so
#: the match cannot be fooled by a same-named field on another source.
DIAGRAM_MODES = {
    (spec.CONFIG, 'sensor_angle'): 'angle',
    (spec.CONFIG, 'sensor_distance'): 'distance',
}

#: How much wider than the diagram the panel's text may run, in pixels. The
#: diagram alone is too narrow a column for a paragraph.
_TEXT_EXTRA = 140.0


def mode_for(setting):
    """Which quantity the diagram would animate for `setting`, or None."""
    return DIAGRAM_MODES.get((setting.source, setting.field))


class SensorDiagram:
    """Open/close/anchor state for the pinned sensor diagram."""

    def __init__(self):
        #: (setting, mode) for the sensor slider hovered THIS frame, or None.
        #: Set while the sliders render and consumed at the end of the same
        #: frame, so the diagram closes the moment the cursor leaves.
        self._hovered = None
        #: Whether the panel was on screen at the end of LAST frame. A drag may
        #: keep an already-open panel up, but must never be what opens one.
        self._open = False
        #: Where to pin it: the Project window's top-right corner, captured
        #: each frame before its imgui.end().
        self._anchor = imgui.ImVec2(0.0, 0.0)
        self._anchor_width = 0.0

    @property
    def is_open(self) -> bool:
        """Was the panel up at the end of last frame? See the module docstring."""
        return self._open

    @property
    def wanted(self) -> bool:
        """Did a slider ask for the panel this frame?"""
        return self._hovered is not None

    def begin_frame(self):
        """Forget last frame's hover. Call before the sliders render."""
        self._hovered = None

    def note(self, setting, mode):
        """Record that `setting`'s slider wants the diagram this frame."""
        self._hovered = (setting, mode)

    def set_anchor(self, pos, width):
        """Remember where to pin the panel. Call before the window's end()."""
        self._anchor = pos
        self._anchor_width = width

    def close(self):
        """Force the panel shut.

        For the exit paths where nothing renders at all -- the window hidden or
        collapsed. A panel that is not drawn must not be remembered as open, or
        the first drag after it comes back would be treated as sustaining a
        panel that is not there.
        """
        self._open = False

    def end_frame(self, status):
        """Draw the panel if a slider asked for it, and record what happened.

        Call at the END of the Project window's build, AFTER imgui.end() -- a
        window cannot be opened inside another.
        """
        if self._hovered is not None:
            self._draw(status)
        # Recorded AFTER the panel is drawn, so next frame's "may a drag keep
        # this alive?" test asks about a panel that was really on screen.
        self._open = self._hovered is not None

    def _draw(self, status):
        setting, mode = self._hovered
        graphic = status['tooltip_graphic']
        # No renderer means the Orchestrator did not supply one. The UI owns no
        # GPU resources of its own, so a missing diagram is a cosmetic loss
        # rather than a broken window: fall back to nothing at all.
        if graphic is None:
            return

        config = status['edit_config'] or {}
        texture = graphic.render(
            imgui.get_time(),
            angle_mode=(mode == 'angle'),
            distance_mode=(mode == 'distance'),
            sensor_angle=config.get('sensor_angle', 0.0),
            sensor_distance=config.get('sensor_distance', 0.0),
        )

        imgui.set_next_window_pos(
            imgui.ImVec2(self._anchor.x + self._anchor_width, self._anchor.y))
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
                   # must not do so DURING a drag, which is what the is_open
                   # guard in the tooltip path handles instead.
                   | imgui.WindowFlags_.no_nav.value
                   | imgui.WindowFlags_.no_docking.value
                   # Nothing in here is clickable, and the panel sits directly
                   # under the cursor's path off the slider. Letting it eat
                   # mouse input would block the canvas behind it.
                   | imgui.WindowFlags_.no_inputs.value),
        )

        size = float(TEXTURE_SIZE)
        imgui.image(texture, imgui.ImVec2(size, size))
        imgui.push_text_wrap_pos(size + _TEXT_EXTRA)
        imgui.text_disabled(setting.label)
        imgui.separator()
        imgui.text_unformatted(setting.help)
        imgui.pop_text_wrap_pos()
        imgui.end()
