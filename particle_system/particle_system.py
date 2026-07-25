import math
from pathlib import Path

import numpy as np
import moderngl

from shared.gl_utils import read_shader, tryset
from . import persistence
from .config import pack_configs
from .layout import SIZE_OF_CONFIG_DATA, SIZE_OF_ENTITY_STRUCT, ENTITY_DTYPE
from .picker import EntityPicker, MISS

WORLD_SIZE = .25
SQRT_WORLD_SIZE = 0.5
ENTITY_COUNT = int(600000*WORLD_SIZE)
CANVAS_DIM = int(1024*SQRT_WORLD_SIZE)

#: Canvas aspect (width:height). 1.0 is square. Changing this changes the SHAPE
#: of the simulated world -- world space is area-preserving, so the canvas keeps
#: roughly the same pixel count and the same particle density; it just gets
#: wider and shorter. This is independent of the window: resizing the window
#: letterboxes, it does not reshape the world.
CANVAS_ASPECT = .250


def canvas_dimensions(aspect=CANVAS_ASPECT, dim=CANVAS_DIM):
    """Canvas (width, height) for an aspect, preserving total pixel count.

    Area-preserving to match world space: dim*dim pixels regardless of shape,
    so changing aspect does not silently change simulation cost or the
    effective resolution of the trails.
    """
    import math
    s = math.sqrt(aspect)
    return (max(1, int(round(dim * s))), max(1, int(round(dim / s))))

# SSBO binding points. Mirrored in common.glsl's header table.
ENTITY_BUFFER_BINDING = 0
CONFIG_BUFFER_BINDING = 1

# Shader paths resolved relative to this module, so the app is not CWD-dependent.
_SHADER_DIR = Path(__file__).parent / "shaders"
_SHARED_SHADER_DIR = Path(__file__).parent.parent / "shared" / "shaders"


class ParticleSystem:
    def __init__(self, ctx, canvas_size=None, config_path=None):

        if canvas_size is None:
            canvas_size = canvas_dimensions()

        if config_path is None:
            config_path = str(Path(__file__).parent.parent / "configs" / "Starcrossed.json")

        self.ctx = ctx
        self.canvas_size = canvas_size
        self.config_path = str(config_path)
        # One code path for reading configs, so v7/v8 handling never diverges
        # between startup and a later load.
        self.config = persistence.load(config_path).configs[0]

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

        # Entity buffer. Contents are written entirely GPU-side by the reset
        # path in entity_update.glsl, so reserve is all that is needed here.
        self.entity_buffer = self.ctx.buffer(reserve=ENTITY_COUNT * SIZE_OF_ENTITY_STRUCT)

        # Config buffer: one ConfigData slot per particle population. Sized as a
        # variable from the start -- Phase 1 runs a single slot (every entity on
        # config 0, behavior-identical to the old uniform setup), but growing it
        # is the supported path to heterogeneous particles.
        self.configs = [self.config]
        self.config_buffer = None
        self._upload_configs()

        # Fullscreen quad for canvas update (initialized in reload)
        self.quad_vbo = None
        self.canvas_vao = None

        # Frame counter
        self.frame_count = 0

        # Nearest-entity picking. Owned here because it reads the entity buffer.
        self.picker = EntityPicker(ctx)

        # Initialize gpu resources
        self.reload()


    def reload(self):
        """Reload all shaders from disk. Safe to call mid-execution."""
        self._reload_entity_update()
        self._reload_brush_splat()
        self._reload_canvas_update()
        self.picker.reload()

    # --- config buffer / world uniform ---

    def _upload_configs(self):
        """(Re)allocate and fill the ConfigBuffer from self.configs.

        Reallocates only when the slot count changes, so a plain edit-and-push
        of existing configs does not churn GPU memory.
        """
        needed = len(self.configs) * SIZE_OF_CONFIG_DATA
        if self.config_buffer is None or self.config_buffer.size != needed:
            if self.config_buffer is not None:
                self.config_buffer.release()
            self.config_buffer = self.ctx.buffer(reserve=needed)
        self.config_buffer.write(pack_configs(self.configs))

    def _world_config(self):
        """WorldData for the current frame.

        Trail settings come from config 0 by convention: they are world
        properties, so when multiple configs exist the first one supplies them.
        """
        return self.configs[0].world_config(
            sqrt_world_size=SQRT_WORLD_SIZE,
            config_count=len(self.configs),
        )

    def _set_world_uniform(self, program):
        tryset(program, 'world.trail', self._world_config().as_uniform_value())

    def _reload_entity_update(self):
        """Reload entity update compute shader."""
        try:
            source = read_shader(str(_SHADER_DIR / 'entity_update.glsl'))
            new_program = self.ctx.compute_shader(source)
            self.entity_update_program = new_program
            print("Entity update shader reloaded successfully")
        except Exception as e:
            print(f"Failed to reload entity update shader: {e}")

    def _reload_brush_splat(self):
        """Reload brush splat shaders."""
        try:
            vert_source = read_shader(str(_SHADER_DIR / 'brush.vert'))
            frag_source = read_shader(str(_SHADER_DIR / 'brush.frag'))
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
            vert_source = read_shader(str(_SHARED_SHADER_DIR / 'fullscreen_quad.vert'))
            frag_source = read_shader(str(_SHADER_DIR / 'canvas.frag'))
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

    def entity_count(self):
        """Narrow accessor: how many entities the simulation is running."""
        return ENTITY_COUNT

    def pick(self, target_world, radius_world):
        """Nearest entity to a world position, within `radius_world`.

        Deferred by one frame: this dispatches a pick for the given target and
        returns the result of the PREVIOUS call. Reading the current frame's
        result would stall the GPU, and WebGPU has no synchronous readback at
        all -- see picker.py for the full reasoning.

        Returns a PickResult; check `.hit` before using `.index`.
        """
        result = self.picker.retrieve(self.entity_buffer, ENTITY_DTYPE)
        self.picker.request(self.entity_buffer, ENTITY_COUNT, target_world,
                            self.canvas_size, radius_world)
        return result

    def pick_blocking(self, target_world, radius_world):
        """Pick the CURRENT frame's answer, stalling until it is ready.

        Prefer `pick()`. This exists for one-shot host-side queries (tests,
        tooling) where a frame of latency is unacceptable. It forces a GPU sync
        and does NOT translate to WebGPU, so it must not be used in the render
        loop.
        """
        self.picker.request(self.entity_buffer, ENTITY_COUNT, target_world,
                            self.canvas_size, radius_world)
        self.ctx.finish()
        return self.picker.retrieve(self.entity_buffer, ENTITY_DTYPE)

    def current_canvas_texture(self):
        """Narrow accessor: the canvas texture to present this frame.

        Returned by value each frame rather than held persistently by consumers,
        because the double-buffer swap means the front texture changes identity.
        """
        return self.canvas_texture

    def load_config(self, config_path):
        """Command: switch to a different preset (v8 or legacy v7)."""
        saved = persistence.load(config_path)
        self.apply_configs(saved.configs)
        self.config_path = str(config_path)
        print(f"Loaded config: {config_path}")
        return saved

    def apply_configs(self, configs):
        """Replace the ConfigBuffer contents. Does not touch entities.

        Used by both loading and hover-preview: the particles keep moving and
        simply start obeying different rules, so a preview can be applied and
        undone with a single buffer upload and no visual discontinuity.
        """
        if not configs:
            return
        self.configs = list(configs)
        self.config = self.configs[0]
        self._upload_configs()

    def snapshot_configs(self):
        """Copy of the current ConfigBuffer contents, for restoring later.

        SimulationConfig is frozen, so a shallow list copy is a real snapshot.
        """
        return list(self.configs)

    def update_entities(self):
        """Dispatch compute shader to update entity positions."""

        self.entity_buffer.bind_to_storage_buffer(ENTITY_BUFFER_BINDING)
        self.config_buffer.bind_to_storage_buffer(CONFIG_BUFFER_BINDING)

        self._set_world_uniform(self.entity_update_program)
        tryset(self.entity_update_program, 'rule_seed', float(self.config.rule_seed))
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
        self.entity_buffer.bind_to_storage_buffer(ENTITY_BUFFER_BINDING)

        # Set uniforms (world supplies trail_persistence for the (1-P)/P premultiply)
        self._set_world_uniform(self.brush_splat_program)
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

        self._set_world_uniform(self.canvas_update_program)
        tryset(self.canvas_update_program, 'canvas_texture', 0)
        tryset(self.canvas_update_program, 'frame_count', self.frame_count)

        self.canvas_texture.use(location=0)

        self.canvas_vao.render(moderngl.TRIANGLES)

        # Swap buffers
        self.canvas_texture, self.canvas_texture_back = self.canvas_texture_back, self.canvas_texture
        self.canvas_fbo, self.canvas_fbo_back = self.canvas_fbo_back, self.canvas_fbo
