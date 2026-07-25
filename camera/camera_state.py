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


class CameraMode(Enum):
    """What the camera draws.

    TRAIL     the accumulated velocity flow-field the particles write into.
              This is the default look: smooth, continuous, the trails ARE the
              simulation state.
    PARTICLES each entity drawn as an instanced sprite. Shows where the
              particles actually are, which the trail view only implies.
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
    mode: CameraMode = CameraMode.TRAIL

    def reset(self):
        self.pan = (0.0, 0.0)
        self.zoom = 1.0

    def pan_by_pixels(self, delta_px, window_size, canvas_size):
        """Drag the view by a mouse delta in pixels.

        Converting through the transform (rather than scaling by a fudge
        factor) is what makes the grabbed world point stay under the cursor at
        any zoom or aspect -- dragging feels like moving the canvas itself.
        """
        origin = coords.screen_to_world((0.0, 0.0), window_size, canvas_size,
                                        self.pan, self.zoom)
        moved = coords.screen_to_world(delta_px, window_size, canvas_size,
                                       self.pan, self.zoom)
        # Dragging right moves the content right, i.e. the camera left.
        self.pan = (self.pan[0] - (moved[0] - origin[0]),
                    self.pan[1] - (moved[1] - origin[1]))

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

    def set_zoom(self, zoom: float):
        self.zoom = max(MIN_ZOOM, min(MAX_ZOOM, zoom))

    def toggle_mode(self):
        self.mode = self.mode.next()
