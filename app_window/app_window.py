"""Window + GL context ownership.

AppWindow owns GLFW initialization, the window handle, and the moderngl context.
The context (`ctx`) is the one sanctioned shared substrate: created here and
injected once into every other module at construction. AppWindow exposes the
per-frame windowing primitives (should_close / clear-target / swap) and the raw
window handle so the UI module can register GLFW callbacks against it.

Note that AppWindow does NOT pump the event queue. The UI module owns polling,
because input must be gathered at the very top of the frame -- before the
physics and rendering that consume it -- while the buffer swap happens at the
very bottom. Splitting those two responsibilities is what keeps input fresh.
"""

import glfw
import moderngl


class AppWindow:
    def __init__(self, width=512, height=512, title="Fluoddity-Core"):
        if not glfw.init():
            raise RuntimeError("Failed to initialize GLFW")

        self.window = glfw.create_window(width, height, title, None, None)
        if not self.window:
            glfw.terminate()
            raise RuntimeError("Failed to create GLFW window")

        glfw.make_context_current(self.window)

        self.ctx = moderngl.create_context()
        self.ctx.enable(moderngl.BLEND)

        # Cached so the render path never syscalls per frame. GLFW reports the
        # framebuffer size, which is what pixel coordinates refer to and which
        # differs from window size on HiDPI displays.
        self._size = glfw.get_framebuffer_size(self.window)
        glfw.set_framebuffer_size_callback(self.window, self._on_resize)

    def _on_resize(self, window, width, height):
        """Track framebuffer size and keep the GL viewport in step.

        Resizing must not disturb the simulation: the canvas texture and world
        space are independent of window size, and the letterbox transform
        absorbs the new aspect. Only the viewport changes here.
        """
        self._size = (width, height)
        # Minimizing reports 0x0; setting a zero viewport is invalid.
        if width > 0 and height > 0:
            self.ctx.viewport = (0, 0, width, height)

    def should_close(self) -> bool:
        return glfw.window_should_close(self.window)

    def begin_frame(self):
        """Bind the default framebuffer and clear it for a fresh frame."""
        self.ctx.screen.use()
        self.ctx.clear(0., 0., 0., 1.0)

    def end_frame(self):
        """Present the frame. Event polling belongs to the UI module, at the
        top of the frame -- see the note in this module's docstring."""
        glfw.swap_buffers(self.window)

    def size(self):
        """Framebuffer size in pixels. Differs from window size on HiDPI
        displays, and it is the framebuffer that pixel coordinates refer to."""
        return self._size

    def terminate(self):
        glfw.terminate()
