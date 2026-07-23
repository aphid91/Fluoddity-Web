import glfw
import moderngl
from camera import Camera
from particle_system import ParticleSystem

class App:
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


        self.camera = Camera(self.ctx)
        self.system = ParticleSystem(self.ctx)

    def run(self):
        while not glfw.window_should_close(self.window):
            #physics update hardcoded to 180hz
            for i in range(30):
                self.system.advance()
            
            self.ctx.screen.use()
            self.ctx.clear(0., 0., 0., 1.0)
            
            #display canvas texture with camera.frag
            self.camera.render_texture(self.system.canvas_texture, self.ctx.screen)

            glfw.poll_events()
            glfw.swap_buffers(self.window)

        glfw.terminate()


if __name__ == "__main__":
    app = App()
    app.run()
