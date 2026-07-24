"""Arrow Debug Service - Renders velocity field arrows as an overlay."""
import moderngl
import numpy as np
from utilities.gl_helpers import read_shader, tryset


class ArrowDebugService:
    """Service for rendering debug arrow overlay showing velocity field."""

    def __init__(self, ctx: moderngl.Context):
        """
        Initialize arrow debug service.

        Args:
            ctx: moderngl.Context
        """
        self.ctx = ctx
        self.setup_rendering()

    def setup_rendering(self):
        """Set up shaders and geometry for arrow rendering."""
        # Load shaders
        vertex_shader = read_shader('shaders/arrow_debug.vert')
        fragment_shader = read_shader('shaders/arrow_debug.frag')

        try:
            self.program = self.ctx.program(
                vertex_shader=vertex_shader,
                fragment_shader=fragment_shader
            )
        except Exception as e:
            print('Arrow debug shader compilation failed:')
            print(e)
            self.program = None
            return

        # Create fullscreen quad
        vertices = np.array([
            -1.0, -1.0,
             1.0, -1.0,
             1.0,  1.0,
            -1.0,  1.0,
        ], dtype=np.float32)

        indices = np.array([0, 1, 2, 0, 2, 3], dtype=np.uint32)

        vbo = self.ctx.buffer(vertices.tobytes())
        ibo = self.ctx.buffer(indices.tobytes())
        self.vao = self.ctx.vertex_array(self.program, [(vbo, '2f', 'position')], ibo)

    def render(self, canvas_texture: moderngl.Texture, cam_pos: tuple[float, float],
               cam_zoom: float, canvas_resolution: tuple[int, int],
               window_size: tuple[int, int], arrow_sensitivity: float,
               use_zw_channels: bool = False):
        """
        Render arrow overlay.

        Args:
            canvas_texture: Canvas texture containing velocity field
            cam_pos: Camera position (x, y)
            cam_zoom: Camera zoom level
            canvas_resolution: Canvas texture resolution (width, height)
            window_size: Window size (width, height)
            arrow_sensitivity: Velocity scale exponent (pow(2, x))
        """
        if self.program is None:
            return

        # Bind canvas texture
        canvas_texture.use(location=0)
        self.program['canvas_texture'] = 0

        # Set camera uniforms
        tryset(self.program, 'cam_pos', cam_pos)
        tryset(self.program, 'cam_zoom', cam_zoom)
        tryset(self.program, 'canvas_resolution', canvas_resolution)
        tryset(self.program, 'window_size', window_size)
        tryset(self.program, 'arrow_sensitivity', arrow_sensitivity)
        tryset(self.program, 'use_zw_channels', use_zw_channels)

        # Enable alpha blending for overlay
        self.ctx.enable(moderngl.BLEND)
        self.ctx.blend_func = moderngl.SRC_ALPHA, moderngl.ONE_MINUS_SRC_ALPHA

        # Render fullscreen quad
        self.vao.render()

        # Disable blending
        self.ctx.disable(moderngl.BLEND)

    def cleanup(self):
        """Clean up GPU resources."""
        if self.program is not None:
            self.program.release()
            self.vao.release()
