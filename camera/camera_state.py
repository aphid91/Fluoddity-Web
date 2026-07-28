"""CameraState: where the viewer is looking, and in which mode.

Deliberately tiny and free of GL: pan, zoom, mode. All the transform math lives
in particle_system/coords.py (ARCHITECTURE rule 9) -- this module only decides
*what* pan and zoom are, never how to apply them.

CONVENTIONS (both differ from the original Fluoddity, on purpose):
  zoom  bigger = zoomed IN, a magnification factor. zoom=1 fits the world.
  pan   world units; the world point sitting at the center of the view.

The original stored zoom inverted (smaller = closer) and pan in "ndc x zoom"
units with a negated y, which made pan values meaningless without also knowing
the zoom. These conventions make both directly readable.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from particle_system import coords

#: Zoom limits. Below the minimum the world is a speck; above the maximum
#: floating-point precision in the canvas uv lookup starts to show.
MIN_ZOOM = 0.1
MAX_ZOOM = 100.0

#: Multiplier per scroll notch.
ZOOM_PER_NOTCH = 1.1

#: Keyboard pan speed, as a fraction of the visible height per second. Held
#: keys, so this is a RATE rather than a step -- a per-frame step would move
#: twice as fast at 120fps as at 60.
PAN_PER_SECOND = 0.9

#: Keyboard zoom rate, as a multiplier per second. Exponential because zoom is
#: multiplicative: a fixed additive step would crawl when zoomed out and lurch
#: when zoomed in.
ZOOM_PER_SECOND = 2.2


class CameraMode(Enum):
    """What the camera draws.

    TRAIL     the accumulated velocity flow-field the particles write into.
              Smooth and continuous -- the trails ARE the simulation state.
    PARTICLES each entity drawn as an instanced sprite, coloured by its own
              output. Shows where the particles actually are, which the trail
              view only implies. The DEFAULT: it is the more direct view of
              what the simulation is doing, and the only one that carries the
              per-particle colour signal.
    """

    TRAIL = 'trail'
    PARTICLES = 'particles'

    def next(self) -> "CameraMode":
        members = list(CameraMode)
        return members[(members.index(self) + 1) % len(members)]


@dataclass
class CameraState:
    """Mutable camera state. Small enough to copy, cheap to save/load later."""

    pan: tuple[float, float] = (0.0, 0.0)
    zoom: float = 1.0
    mode: CameraMode = CameraMode.PARTICLES

    def reset(self):
        self.pan = (0.0, 0.0)
        self.zoom = 1.0

    # pan_by_pixels() lived here until the Pan tool was removed. Deleted rather
    # than kept "in case": nothing drags the view any more, and a method with
    # no caller reads as supported when it is really just untested. The
    # keyboard equivalent is pan_by_fraction() below.

    def zoom_at_pixel(self, notches, pixel, window_size, canvas_size):
        """Zoom by `notches`, keeping the world point under `pixel` fixed.

        The anchor is what makes scroll-zoom feel controlled instead of
        lurching: find the world point under the cursor, apply the zoom, then
        pan so that same point lands back under the cursor.
        """
        if not notches:
            return
        before = coords.screen_to_world(pixel, window_size, canvas_size,
                                        self.pan, self.zoom)
        self.set_zoom(self.zoom * (ZOOM_PER_NOTCH ** notches))
        after = coords.screen_to_world(pixel, window_size, canvas_size,
                                       self.pan, self.zoom)
        self.pan = (self.pan[0] + (before[0] - after[0]),
                    self.pan[1] + (before[1] - after[1]))

    def pan_by_fraction(self, fraction, canvas_size):
        """Pan by a fraction of the VISIBLE height, per axis.

        Keyboard navigation, so the step is time-based rather than pixel-based
        (see PAN_PER_SECOND). Scaled by 1/zoom so a keypress covers the same
        proportion of the screen at any magnification -- zoomed in, the same
        key travels a smaller world distance, which is what makes it feel like
        moving at a constant speed rather than lurching.

        Height, not width, on both axes: using each axis's own extent would
        make diagonal movement faster on a wide canvas.
        """
        if fraction == (0.0, 0.0):
            return
        _, extent_y = coords.world_half_extent(canvas_size)
        step = 2.0 * extent_y / self.zoom
        self.pan = (self.pan[0] + fraction[0] * step,
                    self.pan[1] + fraction[1] * step)

    def zoom_by_factor(self, factor: float):
        """Zoom about the CENTER of the view, leaving pan untouched.

        Distinct from zoom_at_pixel, which anchors on the cursor: a keyboard
        zoom has no cursor to anchor to, and pulling the view toward wherever
        the mouse happened to rest would be surprising.
        """
        if factor == 1.0:
            return
        self.set_zoom(self.zoom * factor)

    def set_zoom(self, zoom: float):
        self.zoom = max(MIN_ZOOM, min(MAX_ZOOM, zoom))

    def toggle_mode(self):
        self.mode = self.mode.next()
