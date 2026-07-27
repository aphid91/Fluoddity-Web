"""StrafeField: a painted vector field that displaces every particle.

WHAT IT IS
One RG32F texture at canvas resolution. Each texel holds a world-space vector
that is added straight to the position of any particle over it, every physics
step. That makes it ADVECTION rather than a force: it bypasses velocity
entirely, so drag never damps it and no particle can "swim upstream" against it
the way a rule can resist a force. Paint a swirl and everything caught in it
goes around, regardless of what it would rather be doing.

WHY IT IS NOT PING-PONGED
The drawing shader never samples the field, only writes it, and each fragment
writes exactly its own texel. There is no read-write hazard to double-buffer
away, so the brush renders into the texture in place via hardware blending.
Contrast the canvas, which diffuses (each texel reads its neighbours) and
therefore must ping-pong.

WHY IT IS NOT SAVED
The texture is several megabytes of binary and belongs to no Project. It is
live-only: not serialized with a config, and not in the undo timeline. "Clear
Field" is the reset. This matches the existing decision to leave canvas trails
out of the save format, and keeps History a timeline of Projects rather than of
mixed state it was never designed to hold.

The Orchestrator drives this module; it holds no reference to any other.
"""

from pathlib import Path

import moderngl
import numpy as np

from particle_system.particle_system import canvas_dimensions
from shared.gl_utils import read_shader, tryset

# Shader paths resolved relative to this module, so the app is not CWD-dependent.
_SHADER_DIR = Path(__file__).parent / "shaders"
_SHARED_SHADER_DIR = Path(__file__).parent.parent / "shared" / "shaders"

#: THE SINGLE SOURCE OF TRUTH for how detailed the field may get.
#:
#: Read as a square-equivalent edge: the field is capped at MAX_FIELD_DIM^2
#: TEXELS, not at that width and height, so a wide canvas spends the same
#: budget on a wider, shorter texture (see field_dimensions()).
#:
#: The field holds soft blobby pushes, not structure -- it is sampled with
#: LINEAR filtering and consumed as a smooth displacement, so detail beyond
#: this is invisible while the VRAM is not. The canvas has to track world size
#: because trails ARE the fine detail; the field does not.
#:
#: RG32F = 8 bytes/texel, so 512 costs 2 MB flat. Uncapped it would follow the
#: canvas: 8 MB at world_size 1, 32 MB at world_size 4.
MAX_FIELD_DIM = 512


def field_dimensions(canvas_size):
    """Field (width, height) for a canvas: same shape, capped total area.

    Below the cap the field matches the canvas exactly, which keeps the common
    case texel-for-texel and makes the mapping trivial to reason about. Above
    it, the canvas ASPECT is preserved while the area is clamped -- so the
    brush stays circular and cursor mapping stays exact at any world size,
    because both are computed from the field's own resolution rather than
    assumed square.

    Composed from canvas_dimensions() rather than reimplemented: that function
    already does area-preserving aspect math, and two copies of it would be one
    too many (the same rule that keeps coordinate math in coords.py).
    """
    width, height = canvas_size
    if width * height <= MAX_FIELD_DIM * MAX_FIELD_DIM:
        return (width, height)
    return canvas_dimensions(aspect=width / height, dim=MAX_FIELD_DIM)


class StrafeField:
    def __init__(self, ctx, canvas_size):
        self.ctx = ctx
        #: The field's OWN resolution, which is not the canvas resolution once
        #: the cap bites. Everything downstream -- the aspect correction in the
        #: shader, the uv mapping from the cursor -- must read this, never the
        #: canvas size, or strokes would skew at large world sizes.
        self.canvas_size = field_dimensions(canvas_size)

        # RG32F: two signed, unclamped channels. Signed because a brush vector
        # points in any direction; unclamped because strokes accumulate
        # additively and a normalized format would saturate almost immediately.
        self.texture = ctx.texture(self.canvas_size, 2, dtype='f4')
        self.texture.filter = (moderngl.LINEAR, moderngl.LINEAR)
        self.fbo = ctx.framebuffer(color_attachments=[self.texture])
        # Start at zero: an unwritten float texture is undefined, and undefined
        # here means every particle gets shoved by garbage on frame one.
        self.fbo.clear()

        self.program = None
        self.quad_vbo = None
        self.vao = None

        self.reload()

    # ------------------------------------------------------------------
    # Shader loading (isolated so hot-reload can re-run it)
    # ------------------------------------------------------------------

    def reload(self):
        """Reload the drawing shader from disk. Safe to call mid-execution.

        Does NOT reallocate the texture, so a painted field survives a reload --
        which is what makes it practical to tune the brush shader against a
        stroke you already like.
        """
        try:
            program = self.ctx.program(
                vertex_shader=read_shader(str(_SHARED_SHADER_DIR / 'fullscreen_quad.vert')),
                fragment_shader=read_shader(str(_SHADER_DIR / 'strafe_draw.frag')),
            )
            # Only replaced on success: a failed compile leaves the old program
            # running rather than dropping the brush entirely.
            self.program = program

            if self.quad_vbo is None:
                self.quad_vbo = self.ctx.buffer(np.array([
                    -1, -1,  1, -1,  1,  1,
                    -1, -1,  1,  1, -1,  1,
                ], dtype=np.float32).tobytes())

            # The VAO binds a program, so it must be rebuilt with the new one.
            self.vao = self.ctx.vertex_array(
                program, [(self.quad_vbo, '2f', 'in_position')])

            # Constant for the life of the program, so it is set here rather
            # than on every stroke frame.
            tryset(program, 'canvas_resolution',
                   (float(self.canvas_size[0]), float(self.canvas_size[1])))
            print("Strafe field shader reloaded successfully")
        except Exception as e:
            print(f"Failed to reload strafe field shader: {e}")

    # ------------------------------------------------------------------
    # Narrow accessors
    # ------------------------------------------------------------------

    def current_texture(self):
        """The field texture to sample this frame.

        Returned by value each frame rather than held by consumers, matching
        ParticleSystem.current_canvas_texture() -- so a future double-buffering
        of this field would stay invisible to everything downstream.
        """
        return self.texture

    def set_wrap(self, wrap: bool):
        """Follow the world's boundary mode.

        The field must sample the same way the canvas does. In wrap mode a
        particle crossing the seam has to keep reading the field it was just
        in; in every other mode a read past the edge must clamp to the edge,
        not teleport to the far side. Mirrors
        ParticleSystem._apply_boundary_sampling().
        """
        self.texture.repeat_x = wrap
        self.texture.repeat_y = wrap

    # ------------------------------------------------------------------
    # Painting
    # ------------------------------------------------------------------

    def draw(self, mouse_uv, prev_uv, draw_size, draw_power):
        """Accumulate one Out-Repel stroke segment into the field."""
        self._pass(mouse_uv, prev_uv, draw_size, draw_power, erase=False)

    def erase(self, mouse_uv, prev_uv, draw_size):
        """Zero the field along one stroke segment.

        draw_power is deliberately not a parameter: erasing is absolute, so
        there is nothing for a strength control to mean.
        """
        self._pass(mouse_uv, prev_uv, draw_size, 0.0, erase=True)

    def _pass(self, mouse_uv, prev_uv, draw_size, draw_power, erase):
        """One fullscreen pass over the field.

        Blending differs between the two: drawing accumulates (ONE, ONE) so a
        held brush builds up, while erasing must write literal zeros and
        therefore runs unblended.
        """
        if self.program is None or self.vao is None:
            return

        self.fbo.use()

        tryset(self.program, 'mouse', tuple(mouse_uv))
        tryset(self.program, 'previous_mouse', tuple(prev_uv))
        tryset(self.program, 'draw_size', float(draw_size))
        tryset(self.program, 'draw_power', float(draw_power))
        tryset(self.program, 'erase_mode', bool(erase))

        if not erase:
            self.ctx.enable(moderngl.BLEND)
            self.ctx.blend_func = moderngl.ONE, moderngl.ONE

        self.vao.render(moderngl.TRIANGLES)

        if not erase:
            self.ctx.disable(moderngl.BLEND)

    def clear(self):
        """Zero the whole field.

        One call, because this texture holds nothing but the strafe field. The
        reference had to read back 4 channels, memset 2 of them and re-upload,
        purely because it packed force and strafe into one RGBA texture.
        """
        self.fbo.clear()

    def release(self):
        """Free GPU resources. Called when the system is rebuilt at a new size."""
        for resource in (self.fbo, self.texture, self.quad_vbo, self.vao):
            if resource is not None:
                resource.release()
