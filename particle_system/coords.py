"""The Python mirror of the coordinate convention in common.glsl.

World space is AREA-PRESERVING. With ca = canvas_res.x / canvas_res.y:

    world = [-sqrt(ca), +sqrt(ca)]  x  [-1/sqrt(ca), +1/sqrt(ca)]

so the world always has area 4 regardless of canvas aspect, and a circle in
world space stays a circle on screen. On a square canvas ca == 1 and this
reduces exactly to the familiar [-1,1] x [-1,1].

THIS MODULE AND common.glsl ARE THE ONLY TWO PLACES ALLOWED TO WRITE
ASPECT-RATIO MATH. Anything that needs a coordinate conversion calls one of
these functions. The reference implementation had six divergent copies of this
math, at least one of which contradicted the others, and the resulting drift
between overlays and the simulation was never fully fixed. That is the specific
failure this rule exists to prevent.

Keep these functions in lockstep with the ones at the bottom of common.glsl.
"""

from __future__ import annotations

import math


def world_half_extent(canvas_size) -> tuple[float, float]:
    """Half-extent of world space on each axis, from canvas (width, height)."""
    ca = canvas_size[0] / canvas_size[1]
    s = math.sqrt(ca)
    return (s, 1.0 / s)


def world_to_uv(p, canvas_size) -> tuple[float, float]:
    """World position -> texture uv [0,1]."""
    ex, ey = world_half_extent(canvas_size)
    return (p[0] / (2.0 * ex) + 0.5, p[1] / (2.0 * ey) + 0.5)


def uv_to_world(uv, canvas_size) -> tuple[float, float]:
    """Texture uv [0,1] -> world position."""
    ex, ey = world_half_extent(canvas_size)
    return ((uv[0] - 0.5) * 2.0 * ex, (uv[1] - 0.5) * 2.0 * ey)


def world_to_ndc(p, canvas_size) -> tuple[float, float]:
    """World position -> normalized device coords [-1,1]."""
    ex, ey = world_half_extent(canvas_size)
    return (p[0] / ex, p[1] / ey)


def world_wrap(p, canvas_size) -> tuple[float, float]:
    """Wrap a world position into the toroidal world bounds."""
    ex, ey = world_half_extent(canvas_size)

    def wrap(v, extent):
        size = 2.0 * extent
        return size * (math.fmod(math.fmod(v / size - 0.5, 1.0) + 1.0, 1.0) - 0.5)

    return (wrap(p[0], ex), wrap(p[1], ey))


def screen_to_world(pixel, window_size, canvas_size) -> tuple[float, float]:
    """Screen pixel (GLFW: origin top-left, y down) -> world position.

    The present pass currently stretches the canvas across the whole window, so
    this inverts exactly that. It takes `window_size` and `canvas_size`
    separately because they are genuinely independent -- resizing the window
    must not move a particle.

    NOTE: this does not yet account for camera pan/zoom or letterboxing,
    because neither exists yet. When the camera lands, its inverse belongs
    HERE, in this function -- not in the caller. That is rule 9, and the
    reference's six drifting copies of this transform are what it is for.
    """
    if window_size[0] <= 0 or window_size[1] <= 0:
        return (0.0, 0.0)
    # Pixel -> uv, flipping y: GLFW counts down from the top, GL counts up.
    uv = (pixel[0] / window_size[0], 1.0 - pixel[1] / window_size[1])
    return uv_to_world(uv, canvas_size)
