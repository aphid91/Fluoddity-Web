"""Camera: the view onto the simulation, and the temporal supersampler.

Owns the camera state (pan/zoom/mode) and both ways of drawing the world:

  TRAIL      a fullscreen pass that samples the canvas texture through the
             INVERSE camera transform. The quad never moves; each screen pixel
             asks "what world point do I show?". That inverse is what puts the
             letterbox bars in the right place.

  PARTICLES  one instanced sprite per entity, transformed to screen ndc in the
             vertex shader. Particles are world-sized, so they grow as you zoom
             in.

Both modes share one transform (particle_system/coords.py + common.glsl), so
they agree pixel-for-pixel about where a world point lands. Toggling between
them does not shift the image -- which is the whole point of rule 9, and what
the reference could not guarantee. Both also feed the same accumulator and the
same assembler, so they respond identically to Brightness, blur and bloom.

MOTION BLUR LIVES HERE, and it is why the render path is a three-call cycle
rather than one call:

    begin_frame(window_size, samples)   open a cycle; size + clear buffers
    render(...)                 x N     draw a sample, add it to the accumulator
    result()                            the finished supersampled frame

A displayed frame is the average of N samples taken at different points in the
simulation's advance. Until the cycle closes, the partial sum is the Camera's
business alone -- result() is the only way out, and nothing downstream sees an
incomplete frame.

Everything the Camera emits is LINEAR HDR. Tone curve, brightness, bloom and
the overlays belong to the assembler; the accumulator has to average energy
rather than display values, or blur would darken as it smeared.

Camera holds no simulation state: the entity buffer and canvas texture are
handed to it per frame by the Orchestrator.
"""

from pathlib import Path

import moderngl

from shared.gl_utils import read_shader, tryset, quad_vbo, quad_vao
from .camera_state import CameraState, CameraMode

# Shader paths resolved relative to this module, so the app is not CWD-dependent.
_SHADER_DIR = Path(__file__).parent / "shaders"
_SHARED_SHADER_DIR = Path(__file__).parent.parent / "shared" / "shaders"

#: Sprite size relative to an entity's own size, in PARTICLES mode.
SPRITE_SIZE = 1.5
#: Per-particle brightness. Low because thousands of sprites accumulate.
#: A bare constant: brightness is the assembler's job, applied once to the
#: finished frame, so that both camera modes answer to it the same way.
PARTICLE_ALPHA = 0.045

ENTITY_BUFFER_BINDING = 0

#: Render-target format. 16-bit float is half the bandwidth of 32-bit and its
#: range (~65504) is far beyond anything the canvas produces; the precision is
#: ample for the sample counts motion blur uses.
_HDR_DTYPE = 'f2'


class Camera:
    def __init__(self, ctx, state=None):
        self.ctx = ctx
        self.state = state or CameraState()

        self.present_program = None
        self.particle_program = None
        self.accumulate_program = None
        self.quad_vbo = None
        self.present_vao = None
        self.particle_vao = None
        self.accumulate_vao = None

        # --- the supersampling buffers, allocated lazily on first frame ---
        #: One sample, redrawn from scratch every render() call.
        self._hdr_texture = None
        self._hdr_fbo = None
        #: The running sum of this cycle's samples, each pre-weighted by 1/N.
        self._accum_texture = None
        self._accum_fbo = None
        #: What the buffers above are sized for. Compared against the window
        #: each cycle, so a resize reallocates rather than rendering stretched.
        self._buffer_size = None
        #: Set by begin_frame(). Guards result() against handing out a buffer
        #: that no render() has written to.
        self._samples_taken = 0
        #: Weight per sample. Replaced every begin_frame(); the default covers
        #: a stray render() before the first cycle opens.
        self._inv_samples = 1.0

        self.reload()

    # ------------------------------------------------------------------
    # Shader loading (isolated so hot-reload can re-run it)
    # ------------------------------------------------------------------

    def reload(self):
        """Reload shaders from disk. Safe to call mid-execution."""
        self._reload_present()
        self._reload_particles()
        self._reload_accumulate()

    def _reload_present(self):
        try:
            program = self.ctx.program(
                vertex_shader=read_shader(str(_SHARED_SHADER_DIR / 'fullscreen_quad.vert')),
                fragment_shader=read_shader(str(_SHADER_DIR / 'camera.frag')),
            )
            self.present_program = program

            if self.quad_vbo is None:
                self.quad_vbo = quad_vbo(self.ctx)

            # The VAO binds a program, so it must be rebuilt with the new one.
            self.present_vao = quad_vao(self.ctx, program, self.quad_vbo)
            print("Camera present shaders reloaded successfully")
        except Exception as e:
            print(f"Failed to reload camera present shaders: {e}")

    def _reload_particles(self):
        try:
            program = self.ctx.program(
                vertex_shader=read_shader(str(_SHADER_DIR / 'cam_brush.vert')),
                fragment_shader=read_shader(str(_SHADER_DIR / 'cam_brush.frag')),
            )
            self.particle_program = program
            self.particle_vao = self.ctx.vertex_array(program, [])
            print("Camera particle shaders reloaded successfully")
        except Exception as e:
            print(f"Failed to reload camera particle shaders: {e}")

    def _reload_accumulate(self):
        try:
            program = self.ctx.program(
                vertex_shader=read_shader(str(_SHARED_SHADER_DIR / 'fullscreen_quad.vert')),
                fragment_shader=read_shader(str(_SHADER_DIR / 'accumulate.frag')),
            )
            self.accumulate_program = program

            if self.quad_vbo is None:
                self.quad_vbo = quad_vbo(self.ctx)

            self.accumulate_vao = quad_vao(self.ctx, program, self.quad_vbo)
            print("Camera accumulate shader reloaded successfully")
        except Exception as e:
            print(f"Failed to reload camera accumulate shader: {e}")

    # ------------------------------------------------------------------
    # Rendering
    # ------------------------------------------------------------------

    def begin_frame(self, window_size, samples):
        """Open an accumulation cycle for one displayed frame.

        `samples` is the DERIVED sample count, not the number the user asked
        for -- see orchestrator.blur_schedule(). It must equal the number of
        render() calls that follow, or the frame comes out mis-weighted.
        """
        self._ensure_buffers(window_size)
        self._samples_taken = 0
        self._inv_samples = 1.0 / max(1, int(samples))
        # Clearing once per cycle IS the reset. The accumulator is written by
        # blending from here on, so there is no first-sample special case.
        if self._accum_fbo is not None:
            self._accum_fbo.clear(0.0, 0.0, 0.0, 1.0)

    def render(self, canvas_texture, entity_buffer, entity_count,
               canvas_size, window_size, color_sensitivity=0.5):
        """Draw one temporal sample and fold it into the accumulator.

        Everything needed is passed per call -- Camera keeps no reference to
        the simulation between frames, so the canvas double-buffer swap stays
        invisible to it. `color_sensitivity` arrives the same way rather than
        being read from the config buffer, which belongs to ParticleSystem.
        """
        if self._hdr_fbo is None:
            return

        if self.state.mode is CameraMode.PARTICLES:
            self._render_particles(entity_buffer, entity_count,
                                   canvas_size, window_size, color_sensitivity)
        else:
            self._render_trail(canvas_texture, canvas_size, window_size)

        self._accumulate()
        self._samples_taken += 1

    def result(self):
        """The finished supersampled frame, linear HDR.

        None before any sample has landed, which is what the Orchestrator
        checks rather than presenting an uninitialized buffer.
        """
        if self._samples_taken == 0:
            return None
        return self._accum_texture

    def _render_trail(self, canvas_texture, canvas_size, window_size):
        if self.present_program is None or self.present_vao is None:
            return
        self._hdr_fbo.use()
        # Cleared per sample: this pass writes every pixel it keeps and
        # early-outs to black in the letterbox, but the previous sample's
        # content must not survive underneath either way.
        self.ctx.clear(0.0, 0.0, 0.0, 1.0)
        self._set_view_uniforms(self.present_program, canvas_size, window_size)
        tryset(self.present_program, 'tex', 0)
        canvas_texture.use(location=0)
        self.present_vao.render(moderngl.TRIANGLES)

    def _render_particles(self, entity_buffer, entity_count,
                          canvas_size, window_size, color_sensitivity=0.5):
        if self.particle_program is None or self.particle_vao is None:
            return
        self._hdr_fbo.use()
        self.ctx.clear(0.0, 0.0, 0.0, 1.0)
        entity_buffer.bind_to_storage_buffer(ENTITY_BUFFER_BINDING)

        self._set_view_uniforms(self.particle_program, canvas_size, window_size)
        tryset(self.particle_program, 'sprite_size', SPRITE_SIZE)
        tryset(self.particle_program, 'particle_alpha', PARTICLE_ALPHA)
        tryset(self.particle_program, 'color_sensitivity',
               float(color_sensitivity))

        # Additive: overlapping sprites accumulate into brighter regions, which
        # is what makes density legible. Unrelated to the temporal accumulation
        # below -- this one is within a single sample.
        self.ctx.enable(moderngl.BLEND)
        self.ctx.blend_func = moderngl.ONE, moderngl.ONE
        self.particle_vao.render(moderngl.TRIANGLE_FAN, vertices=4,
                                 instances=entity_count)
        self.ctx.disable(moderngl.BLEND)

    def _accumulate(self):
        """Add the sample just rendered into the running average.

        The 1/N weight is applied in the shader and the sum by the blend unit,
        so the accumulator is never read back -- see accumulate.frag for why
        that matters.
        """
        if self.accumulate_program is None or self.accumulate_vao is None:
            return
        self._accum_fbo.use()
        tryset(self.accumulate_program, 'hdr', 0)
        tryset(self.accumulate_program, 'inv_samples', self._inv_samples)
        self._hdr_texture.use(location=0)

        self.ctx.enable(moderngl.BLEND)
        self.ctx.blend_func = moderngl.ONE, moderngl.ONE
        self.accumulate_vao.render(moderngl.TRIANGLES)
        self.ctx.disable(moderngl.BLEND)

    # ------------------------------------------------------------------
    # Render targets
    # ------------------------------------------------------------------

    def _ensure_buffers(self, window_size):
        """Allocate the HDR and accumulation targets, resizing with the window.

        Minimizing reports 0x0, which is not a legal texture size; the buffers
        are left alone and render() no-ops until the window comes back.
        """
        width, height = int(window_size[0]), int(window_size[1])
        if width <= 0 or height <= 0:
            return
        if self._buffer_size == (width, height):
            return

        self._release_buffers()

        self._hdr_texture = self.ctx.texture((width, height), 4, dtype=_HDR_DTYPE)
        self._hdr_texture.filter = (moderngl.LINEAR, moderngl.LINEAR)
        self._hdr_fbo = self.ctx.framebuffer(color_attachments=[self._hdr_texture])

        self._accum_texture = self.ctx.texture((width, height), 4, dtype=_HDR_DTYPE)
        self._accum_texture.filter = (moderngl.LINEAR, moderngl.LINEAR)
        # Clamped: the bloom chain samples this with offset taps, and repeat
        # would wrap light around from the opposite edge of the screen.
        self._accum_texture.repeat_x = False
        self._accum_texture.repeat_y = False
        self._accum_fbo = self.ctx.framebuffer(color_attachments=[self._accum_texture])

        self._buffer_size = (width, height)

    def _release_buffers(self):
        """Free the render targets. Called on resize and at shutdown."""
        for resource in (self._hdr_fbo, self._hdr_texture,
                         self._accum_fbo, self._accum_texture):
            if resource is not None:
                resource.release()
        self._hdr_texture = self._hdr_fbo = None
        self._accum_texture = self._accum_fbo = None
        self._buffer_size = None
        self._samples_taken = 0

    def release(self):
        self._release_buffers()

    def _set_view_uniforms(self, program, canvas_size, window_size):
        """The camera half of the transform. Both modes use the same values,
        which is why they agree about where a world point lands."""
        tryset(program, 'canvas_resolution', (float(canvas_size[0]), float(canvas_size[1])))
        tryset(program, 'window_resolution', (float(window_size[0]), float(window_size[1])))
        tryset(program, 'cam_pan', (float(self.state.pan[0]), float(self.state.pan[1])))
        tryset(program, 'cam_zoom', float(self.state.zoom))
