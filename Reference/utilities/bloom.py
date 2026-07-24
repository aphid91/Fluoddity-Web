"""Mip-chain bloom post-processing effect.

GPU resources are lazily initialized on first use, so there is zero
performance impact when bloom is disabled.
"""

import moderngl
import numpy as np
from utilities.gl_helpers import read_shader


class BloomProcessor:
    """Multi-pass mip-chain bloom.

    Downsample with brightness threshold -> progressive blur -> upsample
    and accumulate back to full resolution -> composite onto original.

    All GPU resources (shaders, textures, FBOs) are created lazily on the
    first call to ``process()`` and recreated if the input size changes.
    """

    MIP_LEVELS = 5  # half, quarter, eighth, sixteenth, thirty-second

    def __init__(self, ctx: moderngl.Context):
        self.ctx = ctx
        self._resources = None  # lazily created
        self._width = 0
        self._height = 0

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def process(self, source_texture: moderngl.Texture,
                threshold: float, intensity: float,
                radius: float, tonemap_softness: float = 3.0) -> moderngl.Texture:
        """Apply bloom and return the composited texture.

        ``source_texture`` is read but never written to.  The returned
        texture is owned by this processor (do not release it).
        """
        w, h = source_texture.size
        self._ensure_resources(w, h)
        r = self._resources

        # -- 1. Copy source into mip 0 (full-res working copy) --------
        r["copy_fbo"].use()
        source_texture.use(location=0)
        r["downsample_prog"]["source_tex"] = 0
        r["downsample_prog"]["apply_threshold"] = False
        r["downsample_prog"]["source_texel_size"] = (1.0 / w, 1.0 / h)
        r["downsample_vao"].render()

        # -- 2. Downsample chain (mip 0 -> 1 -> … -> N) ---------------
        #    First pass inverse-tonemaps from display to linear HDR.
        r["downsample_prog"]["tonemap_softness"] = tonemap_softness
        for i in range(self.MIP_LEVELS):
            src_tex = r["copy_tex"] if i == 0 else r["mip_textures"][i - 1]
            sw, sh = src_tex.size

            r["mip_fbos"][i].use()
            src_tex.use(location=0)
            r["downsample_prog"]["source_tex"] = 0
            r["downsample_prog"]["apply_threshold"] = (i == 0)
            r["downsample_prog"]["threshold"] = threshold
            r["downsample_prog"]["source_texel_size"] = (1.0 / sw, 1.0 / sh)
            r["downsample_vao"].render()

        # -- 3. Upsample chain (mip N -> N-1 -> … -> 0) ---------------
        for i in range(self.MIP_LEVELS - 1, 0, -1):
            src_tex = r["mip_textures"][i]      # lower-res bloom
            dst_tex = r["mip_textures"][i - 1]  # higher-res mip (destination)
            sw, sh = src_tex.size

            r["mip_fbos"][i - 1].use()
            src_tex.use(location=0)
            dst_tex.use(location=1)
            r["upsample_prog"]["source_tex"] = 0
            r["upsample_prog"]["destination_tex"] = 1
            r["upsample_prog"]["source_texel_size"] = (1.0 / sw, 1.0 / sh)
            r["upsample_prog"]["bloom_radius"] = radius
            r["upsample_vao"].render()

        # -- 4. Composite: inverse-tonemap original, add bloom, re-tonemap
        r["composite_fbo"].use()
        source_texture.use(location=0)
        r["mip_textures"][0].use(location=1)
        r["composite_prog"]["original_tex"] = 0
        r["composite_prog"]["bloom_tex"] = 1
        r["composite_prog"]["bloom_intensity"] = intensity
        r["composite_prog"]["tonemap_softness"] = tonemap_softness
        r["composite_vao"].render()

        return r["composite_tex"]

    def cleanup(self):
        """Release all GPU resources."""
        if self._resources is None:
            return
        r = self._resources
        for fbo in r["mip_fbos"]:
            fbo.release()
        for tex in r["mip_textures"]:
            tex.release()
        r["copy_fbo"].release()
        r["copy_tex"].release()
        r["composite_fbo"].release()
        r["composite_tex"].release()
        r["downsample_prog"].release()
        r["upsample_prog"].release()
        r["composite_prog"].release()
        r["downsample_vao"].release()
        r["upsample_vao"].release()
        r["composite_vao"].release()
        r["quad_vbo"].release()
        r["quad_ibo"].release()
        self._resources = None
        self._width = 0
        self._height = 0

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _ensure_resources(self, w: int, h: int):
        if self._resources is not None and self._width == w and self._height == h:
            return
        self.cleanup()
        self._width = w
        self._height = h

        ctx = self.ctx
        vert_src = read_shader("shaders/frame_assembly.vert")

        # -- Shared fullscreen quad geometry --
        vertices = np.array([-1, -1, 1, -1, 1, 1, -1, 1], dtype=np.float32)
        indices = np.array([0, 1, 2, 0, 2, 3], dtype=np.uint32)
        quad_vbo = ctx.buffer(vertices.tobytes())
        quad_ibo = ctx.buffer(indices.tobytes())

        # -- Shader programs --
        downsample_prog = ctx.program(
            vertex_shader=vert_src,
            fragment_shader=read_shader("shaders/bloom_downsample.frag"),
        )
        upsample_prog = ctx.program(
            vertex_shader=vert_src,
            fragment_shader=read_shader("shaders/bloom_upsample.frag"),
        )
        composite_prog = ctx.program(
            vertex_shader=vert_src,
            fragment_shader=self._composite_frag_source(),
        )

        # -- VAOs (one per program, all sharing the same VBO/IBO) --
        downsample_vao = ctx.vertex_array(downsample_prog, [(quad_vbo, "2f", "position")], quad_ibo)
        upsample_vao = ctx.vertex_array(upsample_prog, [(quad_vbo, "2f", "position")], quad_ibo)
        composite_vao = ctx.vertex_array(composite_prog, [(quad_vbo, "2f", "position")], quad_ibo)

        # -- Full-res copy texture (source is never modified) --
        copy_tex = ctx.texture((w, h), 4, dtype="f4")
        copy_tex.filter = (moderngl.LINEAR, moderngl.LINEAR)
        copy_fbo = ctx.framebuffer(color_attachments=[copy_tex])

        # -- Mip chain textures + FBOs --
        mip_textures = []
        mip_fbos = []
        mw, mh = w, h
        for _ in range(self.MIP_LEVELS):
            mw = max(1, mw // 2)
            mh = max(1, mh // 2)
            tex = ctx.texture((mw, mh), 4, dtype="f4")
            tex.filter = (moderngl.LINEAR, moderngl.LINEAR)
            tex.repeat_x=False
            tex.repeat_y=False
            mip_textures.append(tex)
            mip_fbos.append(ctx.framebuffer(color_attachments=[tex]))

        # -- Composite output texture --
        composite_tex = ctx.texture((w, h), 4, dtype="f4")
        composite_tex.filter = (moderngl.LINEAR, moderngl.LINEAR)
        composite_fbo = ctx.framebuffer(color_attachments=[composite_tex])

        self._resources = dict(
            quad_vbo=quad_vbo, quad_ibo=quad_ibo,
            downsample_prog=downsample_prog, downsample_vao=downsample_vao,
            upsample_prog=upsample_prog, upsample_vao=upsample_vao,
            composite_prog=composite_prog, composite_vao=composite_vao,
            copy_tex=copy_tex, copy_fbo=copy_fbo,
            mip_textures=mip_textures, mip_fbos=mip_fbos,
            composite_tex=composite_tex, composite_fbo=composite_fbo,
        )

    @staticmethod
    def _composite_frag_source() -> str:
        return """\
#version 330 core
uniform sampler2D original_tex;
uniform sampler2D bloom_tex;
uniform float bloom_intensity;
uniform float tonemap_softness;
in vec2 uv;
out vec4 fragColor;

vec3 inverse_asinh(vec3 color) {
    float len = length(color);
    if (len > 0.0) {
        color = normalize(color) * sinh(len * tonemap_softness) / tonemap_softness;
    }
    return color;
}

vec3 forward_asinh(vec3 color) {
    float len = length(color);
    if (len > 0.0) {
        color *= asinh(len * tonemap_softness) / (len * tonemap_softness);
    }
    return color;
}

void main() {
    vec3 original = texture(original_tex, uv).rgb;
    vec3 bloom = texture(bloom_tex, uv).rgb;
    // Undo asinh curve, add bloom in linear space, re-apply asinh
    vec3 linear_original = inverse_asinh(original);
    vec3 combined = linear_original + bloom * bloom_intensity;
    fragColor = vec4(forward_asinh(combined), 1.0);
}
"""
