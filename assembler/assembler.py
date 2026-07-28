"""Assembler: the finished camera frame, turned into what the screen shows.

The Camera hands over a linear HDR frame -- possibly the average of several
temporal samples -- and this module takes it the rest of the way:

    bloom        wide glow around bright regions, added in linear space
    brightness   exposure, still linear
    tone curve   asinh, linear -> display
    overlays     strafe field, brush reticle

THE ORDER IS THE POINT. Light is added and exposed while the values still mean
energy, and the curve runs once at the end; the reference tonemaps before
blooming and pays for it by inverse-tonemapping in two separate shaders to get
back to a space where addition is meaningful.

Everything but bloom happens in one pass (shaders/frame_assembly.frag), because
each stage is a handful of instructions on a value already in a register --
splitting them into separate passes would cost a full-screen read and write
each to save nothing.

Holds no simulation state and no preferences: the Orchestrator passes what this
needs per frame, including the already-resolved decisions about whether the
overlays should be visible at all.
"""

from pathlib import Path

import moderngl

from shared.gl_utils import read_shader, tryset, quad_vbo, quad_vao
from .bloom import Bloom

_SHADER_DIR = Path(__file__).parent / "shaders"
_SHARED_SHADER_DIR = Path(__file__).parent.parent / "shared" / "shaders"

#: Texture units. Fixed rather than allocated, so the bindings below and the
#: samplers in frame_assembly.frag can be read side by side.
_SOURCE_UNIT = 0
_BLOOM_UNIT = 1
_FIELD_UNIT = 2


class Assembler:
    def __init__(self, ctx):
        self.ctx = ctx
        self.bloom = Bloom(ctx)

        self.program = None
        self.quad_vbo = None
        self.vao = None

        self.reload()

    # ------------------------------------------------------------------
    # Shader loading (isolated so hot-reload can re-run it)
    # ------------------------------------------------------------------

    def reload(self):
        """Reload the assembly shader and the bloom chain. Safe mid-execution."""
        try:
            program = self.ctx.program(
                vertex_shader=read_shader(str(_SHARED_SHADER_DIR / 'fullscreen_quad.vert')),
                fragment_shader=read_shader(str(_SHADER_DIR / 'frame_assembly.frag')),
            )
            # Only replaced on success: a failed compile leaves the old program
            # running rather than dropping the screen to black.
            self.program = program

            if self.quad_vbo is None:
                self.quad_vbo = quad_vbo(self.ctx)

            # The VAO binds a program, so it must be rebuilt with the new one.
            self.vao = quad_vao(self.ctx, program, self.quad_vbo)
            print("Frame assembly shader reloaded successfully")
        except Exception as e:
            print(f"Failed to reload frame assembly shader: {e}")

        self.bloom.reload()

    # ------------------------------------------------------------------
    # Presenting
    # ------------------------------------------------------------------

    def present(self, source, framebuffer, prefs, canvas_size, window_size,
                cam_pan, cam_zoom, strafe_field=None, show_field=False,
                reticle_center=None, reticle_radius=0.0,
                reticle_dashed=False):
        """Assemble `source` onto `framebuffer`.

        `show_field`, `reticle_radius` and `reticle_dashed` arrive already
        decided: whether an overlay belongs on screen, and which tool it is
        describing, depends on the active tool -- and that is the
        Orchestrator's to know, not this module's.
        """
        if self.program is None or self.vao is None or source is None:
            return

        # Bloom runs first and into its own targets, so it must happen before
        # the output framebuffer is bound.
        bloom_texture = None
        if prefs.bloom_enabled and prefs.bloom_intensity > 0.0:
            bloom_texture = self.bloom.process(
                source, prefs.bloom_threshold, prefs.bloom_radius)

        framebuffer.use()

        source.use(location=_SOURCE_UNIT)
        tryset(self.program, 'source', _SOURCE_UNIT)

        # Intensity carries the on/off switch into the shader: at zero it skips
        # the fetch entirely, so the sampler being stale does not matter.
        if bloom_texture is not None:
            bloom_texture.use(location=_BLOOM_UNIT)
            tryset(self.program, 'bloom_tex', _BLOOM_UNIT)
            tryset(self.program, 'bloom_intensity', float(prefs.bloom_intensity))
        else:
            tryset(self.program, 'bloom_intensity', 0.0)

        tryset(self.program, 'brightness', float(prefs.brightness))
        tryset(self.program, 'tonemap_softness', float(prefs.tonemap_softness))

        # Same four values the Camera pushed, so the overlays land exactly
        # where the image did -- see rule 9.
        tryset(self.program, 'canvas_resolution',
               (float(canvas_size[0]), float(canvas_size[1])))
        tryset(self.program, 'window_resolution',
               (float(window_size[0]), float(window_size[1])))
        tryset(self.program, 'cam_pan', (float(cam_pan[0]), float(cam_pan[1])))
        tryset(self.program, 'cam_zoom', float(cam_zoom))

        # Zero opacity is the off switch, and the shader does not sample the
        # field at all below it -- so a missing texture is only a problem when
        # the overlay was actually asked for.
        opacity = float(prefs.field_opacity) if show_field else 0.0
        if opacity > 0.0 and strafe_field is not None:
            strafe_field.use(location=_FIELD_UNIT)
            tryset(self.program, 'strafe_field', _FIELD_UNIT)
        else:
            opacity = 0.0
        tryset(self.program, 'field_opacity', opacity)

        center = reticle_center or (0.0, 0.0)
        tryset(self.program, 'reticle_center',
               (float(center[0]), float(center[1])))
        tryset(self.program, 'reticle_radius', float(reticle_radius))
        tryset(self.program, 'reticle_dashed', bool(reticle_dashed))

        self.vao.render(moderngl.TRIANGLES)

    def release(self):
        self.bloom.release()
