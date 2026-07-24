import glfw
import moderngl
import numpy as np
from imgui_bundle import imgui
from imgui_bundle.python_backends import glfw_backend


def create_test_pattern(size=64):
    """Create a simple test pattern texture data."""
    data = np.zeros((size, size, 4), dtype=np.uint8)

    # Create a checkerboard pattern with colored squares
    square_size = size // 8
    for y in range(size):
        for x in range(size):
            square_x = x // square_size
            square_y = y // square_size

            if (square_x + square_y) % 2 == 0:
                # Red squares
                data[y, x] = [255, 0, 0, 255]
            else:
                # Blue squares
                data[y, x] = [0, 0, 255, 255]

    # Add a green border
    data[0, :] = [0, 255, 0, 255]  # Top
    data[-1, :] = [0, 255, 0, 255]  # Bottom
    data[:, 0] = [0, 255, 0, 255]  # Left
    data[:, -1] = [0, 255, 0, 255]  # Right

    return data


class TextureDemo:
    def __init__(self):
        # Initialize GLFW
        if not glfw.init():
            raise Exception("GLFW initialization failed")

        self.window = glfw.create_window(800, 600, "ImGui Texture Demo", None, None)
        if not self.window:
            glfw.terminate()
            raise Exception("GLFW window creation failed")

        glfw.make_context_current(self.window)
        glfw.swap_interval(1)  # Enable vsync

        # Initialize ModernGL
        self.ctx = moderngl.create_context()
        self.ctx.gc_mode = 'auto'

        # Always on top
        glfw.set_window_attrib(self.window, glfw.FLOATING, glfw.TRUE)

        # Initialize ImGui
        imgui.create_context()
        self.imgui_renderer = glfw_backend.GlfwRenderer(self.window)

        # Create test texture
        self.texture_size = 64
        pattern_data = create_test_pattern(self.texture_size)

        # Create ModernGL texture
        self.texture = self.ctx.texture(
            size=(self.texture_size, self.texture_size),
            components=4,
            data=pattern_data.tobytes()
        )

        # Get OpenGL texture handle for ImGui
        # imgui_bundle requires ImTextureRef, created from the OpenGL texture ID
        self.texture_id = imgui.ImTextureRef(self.texture.glo)

        print(f"Created texture with OpenGL ID: {self.texture.glo}")
        print(f"Texture size: {self.texture_size}x{self.texture_size}")

    def render_ui(self):
        """Render ImGui interface."""
        self.imgui_renderer.process_inputs()
        imgui.new_frame()

        # Main window with texture display
        imgui.begin("Texture Viewer")
        imgui.text(f"OpenGL Texture ID: {self.texture.glo}")
        imgui.text(f"Texture Size: {self.texture_size}x{self.texture_size}")
        imgui.separator()

        # Display texture at original size
        imgui.text("Original Size (64x64):")
        imgui.image(
            self.texture_id,
            imgui.ImVec2(self.texture_size, self.texture_size)
        )

        imgui.separator()

        # Display texture scaled up
        imgui.text("Scaled 4x (256x256):")
        imgui.image(
            self.texture_id,
            imgui.ImVec2(self.texture_size * 4, self.texture_size * 4)
        )

        imgui.separator()

        # Display texture with custom UV coordinates (top-left quarter only)
        imgui.text("Top-left quarter (UV 0,0 to 0.5,0.5):")
        imgui.image(
            self.texture_id,
            imgui.ImVec2(self.texture_size * 2, self.texture_size * 2),
            uv0=imgui.ImVec2(0, 0),
            uv1=imgui.ImVec2(0.5, 0.5)
        )

        imgui.end()

        # Info window
        imgui.begin("Info")
        imgui.text("This demo shows ModernGL textures")
        imgui.text("displayed in ImGui windows.")
        imgui.separator()
        imgui.text("Controls:")
        imgui.text("ESC - Exit")
        imgui.end()

        imgui.render()
        self.imgui_renderer.render(imgui.get_draw_data())

    def run(self):
        """Main render loop."""
        while not glfw.window_should_close(self.window):
            # Clear screen
            self.ctx.clear(0.1, 0.1, 0.1)

            # Render UI
            self.render_ui()

            # Swap buffers and poll events
            glfw.swap_buffers(self.window)
            glfw.poll_events()

            # Handle ESC key
            if glfw.get_key(self.window, glfw.KEY_ESCAPE) == glfw.PRESS:
                glfw.set_window_should_close(self.window, True)

    def cleanup(self):
        """Clean up resources."""
        self.imgui_renderer.shutdown()
        self.texture.release()
        glfw.terminate()


def main():
    demo = TextureDemo()
    try:
        demo.run()
    finally:
        demo.cleanup()


if __name__ == "__main__":
    main()
