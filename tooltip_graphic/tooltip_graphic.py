"""The shader-drawn diagram shown inside the sensor tooltips.

WHAT THIS IS
An offscreen render target and the shader that fills it. Hovering Sensor Angle
or Sensor Distance opens the ordinary imgui tooltip for that setting, with this
texture drawn above the help text: a small animated diagram of a particle and
its two sensors, showing what the slider means geometrically.

WHY IT IS ITS OWN TOP-LEVEL MODULE AND NOT PART OF ui/
The UI package owns no GPU resources and holds no simulation truth (see
ARCHITECTURE.md rule 10 and the module docstring in ui.py). A framebuffer is
exactly the kind of thing it must not own. This is built by the Orchestrator
with the shared `ctx`, the same way Camera and StrafeField are, and handed to
the UI as a thing it can draw. The UI calls render() with two numbers and gets
back a texture id; it never touches moderngl.

It used to live at ui/tooltip_graphic.py, which meant the one moderngl-owning
file in the codebase sat inside the package forbidden to touch GL, and the
Orchestrator had to import past ui/__init__.py to reach it. Same class, same
owner, same hand-off -- it just sits where the rule says it does now, with its
own shaders/ folder like every other GPU module.

WHY ONLY TWO SETTINGS
The reference implementation drew the entire physics model in this diagram and
lit up a different part of it for each of eleven sliders. Most of those parts
explained less than their help text did. The two sensor settings are the ones
where a picture genuinely beats a paragraph -- an angle and a distance are
spatial facts -- so the port keeps those and drops the rest, shader codepaths
included.

The texture is re-rendered only on the frames a sensor tooltip is actually
open, which is the only reason it is cheap enough to animate.
"""

from __future__ import annotations

from pathlib import Path

import moderngl
from imgui_bundle import imgui

from shared.gl_utils import tryset, quad_vbo, reload_program

_SHADER_DIR = Path(__file__).parent / "shaders"
_SHARED_SHADER_DIR = Path(__file__).parent.parent / "shared" / "shaders"

#: Edge length of the diagram, in pixels. Square: the shader's frame is square
#: and a non-square target would just stretch it.
TEXTURE_SIZE = 160

#: Animation rate multiplier. The shader's oscillation is a sine of `time`, and
#: wall-clock seconds make it sluggish enough to read as a bug rather than as
#: an animation.
_TIME_SCALE = 3.0


class TooltipGraphic:
    """Renders the sensor diagram to a texture the UI can draw with imgui."""

    def __init__(self, ctx: moderngl.Context):
        self.ctx = ctx
        self._vbo = quad_vbo(ctx)
        self._program = None
        self._vao = None
        self.reload()
        if self._program is None:
            # Startup is the one case where a bad shader IS fatal: there is no
            # previous program to fall back to, so continuing would mean
            # rendering the diagram with nothing. reload() has already printed
            # the compile error.
            raise RuntimeError("tooltip_graphic.frag failed to compile at startup")

        self._texture = ctx.texture((TEXTURE_SIZE, TEXTURE_SIZE), components=4)
        # LINEAR so the diagram stays smooth if imgui ever draws it at a size
        # other than 1:1 -- a DPI-scaled tooltip does exactly that.
        self._texture.filter = (moderngl.LINEAR, moderngl.LINEAR)
        self._fbo = ctx.framebuffer(color_attachments=[self._texture])

        #: What imgui.image() wants. Built once: it is just the GL name boxed
        #: up, and the texture outlives every frame that draws it.
        self.texture_id = imgui.ImTextureRef(self._texture.glo)

    def reload(self):
        """Recompile the shader, keeping the render target.

        A compile error leaves the previous program in place and prints, so a
        typo mid-edit costs the tooltip's appearance rather than the session --
        the same hot-reload contract every other GPU module honours, through
        the same helper.
        """
        self._program, self._vao = reload_program(
            self.ctx, "Tooltip graphic shader",
            _SHARED_SHADER_DIR / 'fullscreen_quad.vert',
            _SHADER_DIR / 'tooltip_graphic.frag',
            self._program, self._vao, self._vbo)

    def render(self, elapsed: float, *, angle_mode: bool, distance_mode: bool,
               sensor_angle: float, sensor_distance: float):
        """Draw the diagram into the texture. Returns the id to hand imgui.

        `elapsed` is seconds since the app started; scaling it to something
        watchable is this module's business, not the caller's.
        """
        tryset(self._program, 'time', elapsed * _TIME_SCALE)
        tryset(self._program, 'ANGLE_MODE', angle_mode)
        tryset(self._program, 'DISTANCE_MODE', distance_mode)
        tryset(self._program, 'SENSOR_ANGLE', float(sensor_angle))
        tryset(self._program, 'SENSOR_DISTANCE', float(sensor_distance))

        self._fbo.use()
        self.ctx.clear(0.0, 0.0, 0.0, 1.0)
        self._vao.render(moderngl.TRIANGLES)

        # Hand the screen back. This runs during the UI build, which is after
        # the frame has been presented to the default framebuffer -- leaving
        # our own FBO bound would send the entire interface to it instead.
        self.ctx.screen.use()
        return self.texture_id
