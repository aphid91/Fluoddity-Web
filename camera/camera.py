from pathlib import Path

import moderngl
import numpy as np

from shared.gl_utils import read_shader, tryset

# Shader paths resolved relative to this module, so the app is not CWD-dependent.
_SHADER_DIR = Path(__file__).parent / "shaders"
_SHARED_SHADER_DIR = Path(__file__).parent.parent / "shared" / "shaders"

#Simple camera for displaying a texture to the screen
class Camera:
    def __init__(self, ctx):
        self.ctx = ctx
        self.program = None
        self.vao = None
        self.reload()

    def reload(self):
        """Reload shaders from disk. Safe to call mid-execution."""
        try:
            vert_source = read_shader(str(_SHARED_SHADER_DIR / 'fullscreen_quad.vert'))
            frag_source = read_shader(str(_SHADER_DIR / 'camera.frag'))

            new_program = self.ctx.program(
                vertex_shader=vert_source,
                fragment_shader=frag_source
            )

            self.program = new_program

            # Create fullscreen quad VAO if it doesn't exist
            if self.vao is None:
                vertices = self.ctx.buffer(np.array([
                    -1, -1,
                     1, -1,
                     1,  1,
                    -1, -1,
                     1,  1,
                    -1,  1,
                ], dtype=np.float32).tobytes())
                self.vao = self.ctx.vertex_array(
                    self.program,
                    [(vertices, '2f', 'in_position')]
                )

            print("Camera shaders reloaded successfully")

        except Exception as e:
            print(f"Failed to reload camera shaders: {e}")

    def render_texture(self, texture, framebuffer):
        """Render a texture to a framebuffer using a fullscreen quad."""
        if self.program is None or self.vao is None:
            return

        framebuffer.use()
        tryset(self.program, 'tex', 0)
        texture.use(location=0)
        self.vao.render(moderngl.TRIANGLES)
