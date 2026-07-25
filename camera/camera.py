"""Camera: the view onto the simulation.

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
the reference could not guarantee.

Camera holds no simulation state: the entity buffer and canvas texture are
handed to it per frame by the Orchestrator.
"""

from pathlib import Path

import moderngl
import numpy as np

from shared.gl_utils import read_shader, tryset
from .camera_state import CameraState, CameraMode

# Shader paths resolved relative to this module, so the app is not CWD-dependent.
_SHADER_DIR = Path(__file__).parent / "shaders"
_SHARED_SHADER_DIR = Path(__file__).parent.parent / "shared" / "shaders"

#: Sprite size relative to an entity's own size, in PARTICLES mode.
SPRITE_SIZE = 1.5
#: Per-particle brightness. Low because thousands of sprites accumulate.
PARTICLE_ALPHA = 0.045

ENTITY_BUFFER_BINDING = 0


class Camera:
    def __init__(self, ctx, state=None):
        self.ctx = ctx
        self.state = state or CameraState()

        self.present_program = None
        self.particle_program = None
        self.quad_vbo = None
        self.present_vao = None
        self.particle_vao = None

        self.reload()

    # ------------------------------------------------------------------
    # Shader loading (isolated so hot-reload can re-run it)
    # ------------------------------------------------------------------

    def reload(self):
        """Reload shaders from disk. Safe to call mid-execution."""
        self._reload_present()
        self._reload_particles()

    def _reload_present(self):
        try:
            program = self.ctx.program(
                vertex_shader=read_shader(str(_SHARED_SHADER_DIR / 'fullscreen_quad.vert')),
                fragment_shader=read_shader(str(_SHADER_DIR / 'camera.frag')),
            )
            self.present_program = program

            if self.quad_vbo is None:
                self.quad_vbo = self.ctx.buffer(np.array([
                    -1, -1,  1, -1,  1,  1,
                    -1, -1,  1,  1, -1,  1,
                ], dtype=np.float32).tobytes())

            # The VAO binds a program, so it must be rebuilt with the new one.
            self.present_vao = self.ctx.vertex_array(
                program, [(self.quad_vbo, '2f', 'in_position')])
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

    # ------------------------------------------------------------------
    # Rendering
    # ------------------------------------------------------------------

    def render(self, framebuffer, canvas_texture, entity_buffer,
               entity_count, canvas_size, window_size):
        """Draw the current view. Dispatches on mode.

        Everything needed is passed per frame -- Camera keeps no reference to
        the simulation between frames, so the canvas double-buffer swap stays
        invisible to it.
        """
        if self.state.mode is CameraMode.PARTICLES:
            self._render_particles(framebuffer, entity_buffer, entity_count,
                                   canvas_size, window_size)
        else:
            self._render_trail(framebuffer, canvas_texture, canvas_size, window_size)

    def _render_trail(self, framebuffer, canvas_texture, canvas_size, window_size):
        if self.present_program is None or self.present_vao is None:
            return
        framebuffer.use()
        self._set_view_uniforms(self.present_program, canvas_size, window_size)
        tryset(self.present_program, 'tex', 0)
        canvas_texture.use(location=0)
        self.present_vao.render(moderngl.TRIANGLES)

    def _render_particles(self, framebuffer, entity_buffer, entity_count,
                          canvas_size, window_size):
        if self.particle_program is None or self.particle_vao is None:
            return
        framebuffer.use()
        entity_buffer.bind_to_storage_buffer(ENTITY_BUFFER_BINDING)

        self._set_view_uniforms(self.particle_program, canvas_size, window_size)
        tryset(self.particle_program, 'sprite_size', SPRITE_SIZE)
        tryset(self.particle_program, 'particle_alpha', PARTICLE_ALPHA)

        # Additive: overlapping sprites accumulate into brighter regions, which
        # is what makes density legible.
        self.ctx.enable(moderngl.BLEND)
        self.ctx.blend_func = moderngl.ONE, moderngl.ONE
        self.particle_vao.render(moderngl.TRIANGLE_FAN, vertices=4,
                                 instances=entity_count)
        self.ctx.disable(moderngl.BLEND)

    def _set_view_uniforms(self, program, canvas_size, window_size):
        """The camera half of the transform. Both modes use the same values,
        which is why they agree about where a world point lands."""
        tryset(program, 'canvas_resolution', (float(canvas_size[0]), float(canvas_size[1])))
        tryset(program, 'window_resolution', (float(window_size[0]), float(window_size[1])))
        tryset(program, 'cam_pan', (float(self.state.pan[0]), float(self.state.pan[1])))
        tryset(program, 'cam_zoom', float(self.state.zoom))
