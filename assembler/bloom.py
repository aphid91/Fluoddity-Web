"""Bloom: the mip chain that turns bright regions into a glow.

The algorithm is the standard dual-filter pyramid:

    downsample  full -> 1/2 -> 1/4 -> 1/8 -> 1/16 -> 1/32   (threshold at 1/2)
    upsample    1/32 -> 1/16 -> 1/8 -> 1/4 -> 1/2           (tent, additive)

and the result is left in mip 0 at half resolution, which the assembler samples
with linear filtering. Half res is not a compromise: bloom is a wide, soft
signal, and there is nothing at full resolution for it to represent.

Threshold is applied ONCE, on the way down into the first mip. Every pass after
that is blurring what the threshold already selected, so re-applying it would
just eat the glow it was meant to spread.

Everything here works in linear HDR. The reference blooms after tonemapping and
so has to inverse-tonemap on the way in and re-apply on the way out; assembling
in the sane order removes both round-trips and the precision they cost.

RESOURCES ARE LAZY. Nothing is allocated until the first process() call, so
bloom left switched off costs no VRAM at all -- which is why it can default to
off without the memory showing up anyway.
"""

from pathlib import Path

import moderngl

from shared.gl_utils import read_shader, tryset, quad_vbo, quad_vao

_SHADER_DIR = Path(__file__).parent / "shaders"
_SHARED_SHADER_DIR = Path(__file__).parent.parent / "shared" / "shaders"

#: Halvings below the source. Five reaches 1/32, which at any sane window size
#: is a handful of texels -- wide enough for the diffuse halo, and past the
#: point where another level would add anything visible.
MIP_LEVELS = 5

#: Matches the camera's targets: bloom reads linear HDR and writes linear HDR.
_HDR_DTYPE = 'f2'


class Bloom:
    def __init__(self, ctx):
        self.ctx = ctx
        self.downsample_program = None
        self.upsample_program = None
        self.quad_vbo = None
        self.downsample_vao = None
        self.upsample_vao = None

        #: Mip textures/FBOs, largest first. None until the first process().
        self._mip_textures = []
        self._mip_fbos = []
        #: Source size the chain was built for; a change reallocates.
        self._source_size = None

        # Shaders are NOT loaded here: the Assembler owns this object and
        # reloads it as part of its own reload(), so compiling in the
        # constructor would just do the same work twice at startup.

    # ------------------------------------------------------------------
    # Shader loading (isolated so hot-reload can re-run it)
    # ------------------------------------------------------------------

    def reload(self):
        """Reload both bloom shaders from disk. Safe to call mid-execution."""
        vert = str(_SHARED_SHADER_DIR / 'fullscreen_quad.vert')

        try:
            program = self.ctx.program(
                vertex_shader=read_shader(vert),
                fragment_shader=read_shader(str(_SHADER_DIR / 'bloom_downsample.frag')),
            )
            # Only replaced on success: a failed compile leaves the old program
            # running rather than dropping bloom entirely.
            self.downsample_program = program
            if self.quad_vbo is None:
                self.quad_vbo = quad_vbo(self.ctx)
            # The VAO binds a program, so it must be rebuilt with the new one.
            self.downsample_vao = quad_vao(self.ctx, program, self.quad_vbo)
            print("Bloom downsample shader reloaded successfully")
        except Exception as e:
            print(f"Failed to reload bloom downsample shader: {e}")

        try:
            program = self.ctx.program(
                vertex_shader=read_shader(vert),
                fragment_shader=read_shader(str(_SHADER_DIR / 'bloom_upsample.frag')),
            )
            self.upsample_program = program
            if self.quad_vbo is None:
                self.quad_vbo = quad_vbo(self.ctx)
            self.upsample_vao = quad_vao(self.ctx, program, self.quad_vbo)
            print("Bloom upsample shader reloaded successfully")
        except Exception as e:
            print(f"Failed to reload bloom upsample shader: {e}")

    # ------------------------------------------------------------------
    # The chain
    # ------------------------------------------------------------------

    def process(self, source_texture, threshold, radius):
        """Build the bloom for `source_texture`. Returns the half-res result.

        Returns None if the shaders failed to compile, which the assembler
        reads as "no bloom this frame" rather than as an error.
        """
        if self.downsample_vao is None or self.upsample_vao is None:
            return None

        width, height = source_texture.size
        if width <= 0 or height <= 0:
            return None
        self._ensure_resources(width, height)
        if not self._mip_textures:
            return None

        # -- down: source -> mip 0 -> mip 1 -> ... --
        # Straight into mip 0 from the source. The reference blits to a
        # full-res copy first purely to get a matching format; ours already
        # matches, so that pass is pure cost.
        for i in range(MIP_LEVELS):
            src = source_texture if i == 0 else self._mip_textures[i - 1]
            src_w, src_h = src.size

            self._mip_fbos[i].use()
            src.use(location=0)
            tryset(self.downsample_program, 'source_tex', 0)
            tryset(self.downsample_program, 'apply_threshold', i == 0)
            tryset(self.downsample_program, 'threshold', float(threshold))
            tryset(self.downsample_program, 'source_texel_size',
                   (1.0 / src_w, 1.0 / src_h))
            self.downsample_vao.render(moderngl.TRIANGLES)

        # -- up: mip N -> mip N-1 -> ... -> mip 0, adding as it goes --
        self.ctx.enable(moderngl.BLEND)
        self.ctx.blend_func = moderngl.ONE, moderngl.ONE
        for i in range(MIP_LEVELS - 1, 0, -1):
            src = self._mip_textures[i]
            src_w, src_h = src.size

            self._mip_fbos[i - 1].use()
            src.use(location=0)
            tryset(self.upsample_program, 'source_tex', 0)
            tryset(self.upsample_program, 'source_texel_size',
                   (1.0 / src_w, 1.0 / src_h))
            tryset(self.upsample_program, 'bloom_radius', float(radius))
            self.upsample_vao.render(moderngl.TRIANGLES)
        self.ctx.disable(moderngl.BLEND)

        return self._mip_textures[0]

    # ------------------------------------------------------------------
    # Resources
    # ------------------------------------------------------------------

    def _ensure_resources(self, width, height):
        if self._source_size == (width, height):
            return
        self.release()

        mip_w, mip_h = width, height
        for _ in range(MIP_LEVELS):
            # max(1, ...) so a very small or very thin window cannot ask for a
            # zero-sized texture partway down the chain.
            mip_w = max(1, mip_w // 2)
            mip_h = max(1, mip_h // 2)
            texture = self.ctx.texture((mip_w, mip_h), 4, dtype=_HDR_DTYPE)
            texture.filter = (moderngl.LINEAR, moderngl.LINEAR)
            # Clamped, not repeated: the tent filter reaches past the edge, and
            # repeat would wrap a bright edge's glow around to the far side.
            texture.repeat_x = False
            texture.repeat_y = False
            self._mip_textures.append(texture)
            self._mip_fbos.append(
                self.ctx.framebuffer(color_attachments=[texture]))

        self._source_size = (width, height)

    def release(self):
        """Free the mip chain. Called on resize and at shutdown."""
        for fbo in self._mip_fbos:
            fbo.release()
        for texture in self._mip_textures:
            texture.release()
        self._mip_fbos = []
        self._mip_textures = []
        self._source_size = None
