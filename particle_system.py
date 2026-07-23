import math
import numpy as np
import moderngl
from gl_utils import read_shader, tryset, load_config, set_config_uniform, set_rule_uniform

WORLD_SIZE = .25
SQRT_WORLD_SIZE = 0.5
ENTITY_COUNT = int(600000*WORLD_SIZE)
CANVAS_DIM = int(1024*SQRT_WORLD_SIZE)
SIZE_OF_ENTITY_STRUCT = 24


class ParticleSystem:
    def __init__(self, ctx, canvas_size=(CANVAS_DIM,CANVAS_DIM), config_path='Starcrossed.json'):
        
        self.ctx = ctx
        self.canvas_size = canvas_size
        self.config_path = config_path
        self.config = load_config(config_path)

        # Programs (initialized in reload)
        self.entity_update_program = None
        self.brush_splat_program = None
        self.canvas_update_program = None

        # Textures and framebuffers.
        # Canvas textures only ever use .xy (velocity flow field), so RG suffices.
        # Particles are splatted directly into the canvas, so there is no separate brush texture.
        self.canvas_texture = self.ctx.texture(canvas_size, 2, dtype='f4')
        self.canvas_texture.repeat_x = True
        self.canvas_texture.repeat_y = True
        self.canvas_texture.filter = (moderngl.LINEAR,moderngl.LINEAR)
        self.canvas_fbo = self.ctx.framebuffer(color_attachments=[self.canvas_texture])

        # Double buffer for canvas update (read from one, write to other)
        self.canvas_texture_back = self.ctx.texture(canvas_size, 2, dtype='f4')
        self.canvas_texture_back.repeat_x = True
        self.canvas_texture_back.repeat_y = True
        self.canvas_texture_back.filter = (moderngl.LINEAR,moderngl.LINEAR)
        self.canvas_fbo_back = self.ctx.framebuffer(color_attachments=[self.canvas_texture_back])

        # Entity buffer
        self.entity_buffer = self.ctx.buffer(reserve=ENTITY_COUNT * SIZE_OF_ENTITY_STRUCT)

        # Fullscreen quad for canvas update (initialized in reload)
        self.quad_vbo = None
        self.canvas_vao = None

        # Frame counter
        self.frame_count = 0

        # Initialize gpu resources
        self.reload()


    def reload(self):
        """Reload all shaders from disk. Safe to call mid-execution."""
        self._reload_entity_update()
        self._reload_brush_splat()
        self._reload_canvas_update()

    def _reload_entity_update(self):
        """Reload entity update compute shader."""
        try:
            source = read_shader('shaders/entity_update.glsl')
            new_program = self.ctx.compute_shader(source)
            self.entity_update_program = new_program
            print("Entity update shader reloaded successfully")
        except Exception as e:
            print(f"Failed to reload entity update shader: {e}")

    def _reload_brush_splat(self):
        """Reload brush splat shaders."""
        try:
            vert_source = read_shader('shaders/brush.vert')
            frag_source = read_shader('shaders/brush.frag')
            new_program = self.ctx.program(
                vertex_shader=vert_source,
                fragment_shader=frag_source
            )
            self.brush_splat_program = new_program
            self.brush_vao = self.ctx.vertex_array(self.brush_splat_program, [])
            print("Brush splat shaders reloaded successfully")
        except Exception as e:
            print(f"Failed to reload brush splat shaders: {e}")

    def _reload_canvas_update(self):
        """Reload canvas update shaders."""
        try:
            vert_source = read_shader('shaders/fullscreen_quad.vert')
            frag_source = read_shader('shaders/canvas.frag')
            new_program = self.ctx.program(
                vertex_shader=vert_source,
                fragment_shader=frag_source
            )
            self.canvas_update_program = new_program

            # Create or recreate VAO with new program
            if self.quad_vbo is None:
                # Fullscreen quad vertices as floats
                vertices = np.array([
                    -1, -1,
                     1, -1,
                     1,  1,
                    -1, -1,
                     1,  1,
                    -1,  1,
                ], dtype=np.float32)
                self.quad_vbo = self.ctx.buffer(vertices.tobytes())

            self.canvas_vao = self.ctx.vertex_array(
                self.canvas_update_program,
                [(self.quad_vbo, '2f', 'in_position')]
            )
            print("Canvas update shaders reloaded successfully")
        except Exception as e:
            print(f"Failed to reload canvas update shaders: {e}")

    def advance(self):
        """Run one simulation step: splat into canvas, update entities, update canvas."""

        #The ordering here is a little weird. It doesn't matter so much,
        #but if I weren't trying to support legacy configs, the proper order would be:
        #update_entities()
        #splat_into_canvas()
        #update_canvas()

        #memory barriers make sure gpu memory writes are visible to subsequent steps

        self.ctx.memory_barrier()
        self.update_entities()
        self.ctx.memory_barrier()
        self.update_canvas()
        self.ctx.memory_barrier()
        self.splat_into_canvas()
        self.frame_count += 1

    def reset(self):
        """Reset simulation state."""
        self.frame_count = 0

    def update_entities(self):
        """Dispatch compute shader to update entity positions."""

        self.entity_buffer.bind_to_storage_buffer(0)

        set_config_uniform(self.entity_update_program, self.config)
        set_rule_uniform(self.entity_update_program, self.config['rule'])
        tryset(self.entity_update_program, 'canvas_texture', 0)
        tryset(self.entity_update_program, 'frame_count', self.frame_count)
        self.canvas_texture.use(location=0)

        # Dispatch enough workgroups to cover all entities
        # local_size_x = 256, so we need ceil(ENTITY_COUNT / 256) workgroups
        workgroups = math.ceil(ENTITY_COUNT / 256)
        self.entity_update_program.run(workgroups, 1, 1)


    def splat_into_canvas(self):
        """Splat all entities directly into the canvas texture as gaussian dots.

        The brush.frag output is premultiplied by (1-P)/P so that the subsequent
        canvas pass's P decay leaves the intended (1-P)*brush contribution.
        """
        if self.brush_splat_program is None:
            return

        # Render into the front canvas WITHOUT clearing (clearing would erase trails).
        self.canvas_fbo.use()

        # Pure additive blending: brush.frag already carries the full per-splat weight.
        self.ctx.enable(moderngl.BLEND)
        self.ctx.blend_func = moderngl.ONE, moderngl.ONE

        # Bind entity buffer as SSBO
        self.entity_buffer.bind_to_storage_buffer(0)

        # Set uniforms (config supplies trail_persistence for the (1-P)/P premultiply)
        set_config_uniform(self.brush_splat_program, self.config)
        tryset(self.brush_splat_program, 'canvas_resolution',
               (float(self.canvas_size[0]), float(self.canvas_size[1])))
        tryset(self.brush_splat_program, 'frame_count', self.frame_count)

        # Instanced rendering: 4 vertices per entity with ENTITY_COUNT instances
        self.brush_vao.render(moderngl.TRIANGLE_FAN, vertices=4, instances=ENTITY_COUNT)

        # Restore default blend mode
        self.ctx.disable(moderngl.BLEND)

    def update_canvas(self):
        """Diffuse and decay the canvas by trail persistence (splats already mixed in)."""
        if self.canvas_update_program is None or self.canvas_vao is None:
            return

        # Render to back buffer, reading from front
        self.canvas_fbo_back.use()

        set_config_uniform(self.canvas_update_program, self.config)
        tryset(self.canvas_update_program, 'canvas_texture', 0)
        tryset(self.canvas_update_program, 'frame_count', self.frame_count)

        self.canvas_texture.use(location=0)

        self.canvas_vao.render(moderngl.TRIANGLES)

        # Swap buffers
        self.canvas_texture, self.canvas_texture_back = self.canvas_texture_back, self.canvas_texture
        self.canvas_fbo, self.canvas_fbo_back = self.canvas_fbo_back, self.canvas_fbo
