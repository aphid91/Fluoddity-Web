"""The Python mirror of the coordinate math in common.glsl.

THIS MODULE AND common.glsl ARE THE ONLY TWO PLACES ALLOWED TO WRITE
ASPECT-RATIO OR CAMERA MATH. Everything else calls these functions. The
reference implementation had six divergent copies of this transform, at least
one contradicting the others, and the resulting drift between overlays and the
simulation was never fully fixed. That is the failure this rule prevents.

Keep these functions in lockstep with the ones at the bottom of common.glsl.

===========================================================================
THREE INDEPENDENT ASPECT QUANTITIES
===========================================================================
Conflating these is the single biggest source of confusion in this domain, so
they are named distinctly everywhere:

  canvas_size   The simulation texture's dimensions. Defines WORLD SPACE.
                Changing it changes the shape of the simulated world.

  window_size   The framebuffer's dimensions in pixels. Changes when the user
                resizes the window. Must NOT move a particle.

  letterbox     How the canvas is fitted into the window when their aspects
                disagree. Derived from the two above; never stored.

===========================================================================
WORLD SPACE (area-preserving)
===========================================================================
With ca = canvas_size.x / canvas_size.y:

    world = [-sqrt(ca), +sqrt(ca)]  x  [-1/sqrt(ca), +1/sqrt(ca)]

so world area is always 4 and a circle stays a circle. On a square canvas
ca == 1 and this reduces to the familiar [-1,1] x [-1,1].

===========================================================================
THE VIEW TRANSFORM  (world -> screen)
===========================================================================
    world                                     entity coordinates
      |  / world_half_extent                  normalize to [-1,1] canvas box
    canvas ndc
      |  - pan, * zoom                        camera
    view ndc
      |  * letterbox_scale                    fit canvas into window
    screen ndc  [-1,1]
      |  * 0.5 + 0.5, flip y, * window_size
    screen pixels                             GLFW convention, origin top-left

Every step is invertible and `screen_to_world` walks it backwards. If you ever
need a new conversion, compose it from these -- do not write a fresh one.

ZOOM CONVENTION: bigger zoom = zoomed IN (a magnification factor).
zoom=1 fits the world in the window; zoom=2 shows half of it. This is the
opposite of the original Fluoddity, whose "zoom" was really a view size and
made the math read backwards (`scale /= zoom`).

PAN UNITS: world units. pan is the world point at the center of the view, so
`pan = (0.5, 0)` puts world x=0.5 in the middle of the screen. The original
stored pan in "ndc x zoom" units with a negated y, which meant pan values were
meaningless without also knowing the zoom.
"""

from __future__ import annotations

import math

#: Camera state that produces an untransformed view. Handy as a default and
#: for the trail-view present pass, which bakes no camera in.
IDENTITY_PAN = (0.0, 0.0)
IDENTITY_ZOOM = 1.0


# ---------------------------------------------------------------------------
# World space
# ---------------------------------------------------------------------------

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


#: A radius measured in the brush's ASPECT-CORRECTED uv metric is exactly twice
#: as large in world units, on both axes.
#:
#: The brush corrects a uv delta by (sqrt(ca), 1/sqrt(ca)) -- see
#: aspect_correct_uv in strafe_draw.frag -- and world space scales uv by
#: 2*(sqrt(ca), 1/sqrt(ca)). The aspect factors are identical, so they cancel
#: and only the factor of 2 survives. That cancellation is WHY a single radius
#: can describe the same circle for a tool that works in uv (Draw) and one that
#: works in world space (Shove): both metrics are area-preserving, so neither
#: turns a circle into an oval, and they differ only in scale.
_UV_TO_WORLD_RADIUS = 2.0


def uv_radius_to_world(radius: float) -> float:
    """Brush radius (aspect-corrected uv) -> world units.

    Independent of canvas size, which is the point -- see above.
    """
    return radius * _UV_TO_WORLD_RADIUS


def world_to_ndc(p, canvas_size) -> tuple[float, float]:
    """World position -> canvas-normalized device coords [-1,1].

    This is the *canvas* box, before any camera or letterboxing. It is what a
    shader rasterizing into the canvas texture wants.
    """
    ex, ey = world_half_extent(canvas_size)
    return (p[0] / ex, p[1] / ey)


def ndc_to_world(ndc, canvas_size) -> tuple[float, float]:
    """Canvas ndc [-1,1] -> world position."""
    ex, ey = world_half_extent(canvas_size)
    return (ndc[0] * ex, ndc[1] * ey)


# There is deliberately no host-side world_wrap here, and no toroidal distance.
# Wrapping is the shader's job (`world_wrap` in common.glsl): nothing on the
# host ever needs to move a particle. Picking -- the only thing that ever
# wanted a toroidal distance -- uses straight-line distance in every boundary
# mode; see entity_pick.glsl.


# ---------------------------------------------------------------------------
# Letterboxing
# ---------------------------------------------------------------------------

def letterbox_scale(canvas_size, window_size) -> tuple[float, float]:
    """Scale factors fitting the canvas box into the window, preserving shape.

    Returns multipliers applied to canvas-ndc to reach screen-ndc. The axis
    that would overflow is shrunk; the other stays 1.0. The unused margin is
    the letterbox bar.

    Fit (not fill): the whole canvas is always visible. A circle stays a
    circle in any window shape.
    """
    if window_size[0] <= 0 or window_size[1] <= 0:
        return (1.0, 1.0)
    canvas_aspect = canvas_size[0] / canvas_size[1]
    window_aspect = window_size[0] / window_size[1]
    if window_aspect > canvas_aspect:
        # Window is wider than the canvas: bars on the left and right.
        return (canvas_aspect / window_aspect, 1.0)
    # Window is taller: bars on top and bottom.
    return (1.0, window_aspect / canvas_aspect)


# ---------------------------------------------------------------------------
# The view transform
# ---------------------------------------------------------------------------

def world_to_screen_ndc(p, canvas_size, window_size,
                        pan=IDENTITY_PAN, zoom=IDENTITY_ZOOM) -> tuple[float, float]:
    """World position -> screen ndc [-1,1], through camera and letterbox."""
    # Camera acts in world units, so pan is subtracted before normalizing.
    cx, cy = world_to_ndc((p[0] - pan[0], p[1] - pan[1]), canvas_size)
    cx *= zoom
    cy *= zoom
    sx, sy = letterbox_scale(canvas_size, window_size)
    return (cx * sx, cy * sy)


def screen_ndc_to_world(ndc, canvas_size, window_size,
                        pan=IDENTITY_PAN, zoom=IDENTITY_ZOOM) -> tuple[float, float]:
    """Screen ndc [-1,1] -> world position. Exact inverse of the above."""
    sx, sy = letterbox_scale(canvas_size, window_size)
    cx = ndc[0] / sx if sx else 0.0
    cy = ndc[1] / sy if sy else 0.0
    if zoom:
        cx /= zoom
        cy /= zoom
    wx, wy = ndc_to_world((cx, cy), canvas_size)
    return (wx + pan[0], wy + pan[1])


def screen_to_ndc(pixel, window_size) -> tuple[float, float]:
    """Screen pixel (GLFW: origin top-left, y down) -> screen ndc [-1,1]."""
    if window_size[0] <= 0 or window_size[1] <= 0:
        return (0.0, 0.0)
    return (2.0 * pixel[0] / window_size[0] - 1.0,
            1.0 - 2.0 * pixel[1] / window_size[1])


def ndc_to_screen(ndc, window_size) -> tuple[float, float]:
    """Screen ndc [-1,1] -> screen pixel (GLFW convention).

    KEPT although nothing calls it since world_to_screen went: this is
    screen_to_ndc's exact inverse, and a conversion table missing one direction
    invites the next caller to write it inline -- which is what rule 9 exists to
    stop. Four lines, no cost.
    """
    return ((ndc[0] + 1.0) * 0.5 * window_size[0],
            (1.0 - ndc[1]) * 0.5 * window_size[1])


def screen_to_world(pixel, window_size, canvas_size,
                    pan=IDENTITY_PAN, zoom=IDENTITY_ZOOM) -> tuple[float, float]:
    """Screen pixel -> world position. The full inverse chain.

    This is what picking, drawing and cursor readouts want.
    """
    ndc = screen_to_ndc(pixel, window_size)
    return screen_ndc_to_world(ndc, canvas_size, window_size, pan, zoom)


# The forward chain stops at world_to_screen_ndc (above), which the camera and
# the overlays use. A world_to_screen composing it with ndc_to_screen, and a
# visible_world_bounds built on screen_to_world, both existed here unused --
# the app only ever converts the other way, from the cursor into the world.
# Both are two lines to rebuild from the steps above if something ever wants
# them.
