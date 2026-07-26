import math
from pathlib import Path

import numpy as np
import moderngl

from shared.gl_utils import read_shader, tryset
from . import persistence
from .config import pack_configs
from .layout import SIZE_OF_CONFIG_DATA, SIZE_OF_ENTITY_STRUCT, ENTITY_DTYPE
from .picker import EntityPicker, MISS

WORLD_SIZE = 1.
SQRT_WORLD_SIZE = math.sqrt(WORLD_SIZE)
ENTITY_COUNT = int(600000*WORLD_SIZE)
CANVAS_DIM = int(1024*SQRT_WORLD_SIZE)

#: Canvas aspect (width:height). 1.0 is square. Changing this changes the SHAPE
#: of the simulated world -- world space is area-preserving, so the canvas keeps
#: roughly the same pixel count and the same particle density; it just gets
#: wider and shorter. This is independent of the window: resizing the window
#: letterboxes, it does not reshape the world.
CANVAS_ASPECT = 1.


def canvas_dimensions(aspect=CANVAS_ASPECT, dim=CANVAS_DIM):
    """Canvas (width, height) for an aspect, preserving total pixel count.

    Area-preserving to match world space: dim*dim pixels regardless of shape,
    so changing aspect does not silently change simulation cost or the
    effective resolution of the trails.
    """
    s = math.sqrt(aspect)
    return (max(1, int(round(dim * s))), max(1, int(round(dim / s))))


def sizing_for(world_size):
    """(entity_count, canvas_dim) for a world size.

    World size scales particle count and canvas resolution together, so
    density stays constant as the world grows -- the same simulation, larger.
    """
    return (max(1, int(600000 * world_size)),
            max(16, int(1024 * math.sqrt(world_size))))

# SSBO binding points. Mirrored in common.glsl's header table.
ENTITY_BUFFER_BINDING = 0
CONFIG_BUFFER_BINDING = 1

#: Upper bound on ConfigBuffer slots. The GPU side would happily take far more
#: (up to the entity count), but a hard cap keeps the manager UI bounded and
#: makes overflow a clear, reportable condition rather than silent growth.
MAX_CONFIGS = 64

# Shader paths resolved relative to this module, so the app is not CWD-dependent.
_SHADER_DIR = Path(__file__).parent / "shaders"
_SHARED_SHADER_DIR = Path(__file__).parent.parent / "shared" / "shaders"


class ParticleSystem:
    def __init__(self, ctx, canvas_size=None, config_path=None, entity_count=None):

        if canvas_size is None:
            canvas_size = canvas_dimensions()

        if config_path is None:
            config_path = str(Path(__file__).parent.parent / "configs" / "Starcrossed.json")

        self.ctx = ctx
        self.canvas_size = canvas_size
        # Injectable so World Size can rebuild the system at a different scale;
        # defaults to the module constant for callers that do not care.
        self.entity_count_value = entity_count or ENTITY_COUNT
        # Derived from the ACTUAL entity count, not the module default, so a
        # rebuilt system scales distances correctly. This feeds WorldData and
        # is the single source of truth the shader reads.
        self.sqrt_world_size = math.sqrt(self.entity_count_value / 600000.0)
        self.config_path = str(config_path)
        # One code path for reading configs, so v7/v8 handling never diverges
        # between startup and a later load.
        _saved = persistence.load(config_path)
        self.config = _saved.configs[0]
        #: World settings currently uploaded. Replaced by apply_project().
        self.world = _saved.world

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
        self.entity_buffer = self.ctx.buffer(
            reserve=self.entity_count_value * SIZE_OF_ENTITY_STRUCT)

        # Config buffer: one ConfigData slot per particle population. Sized as a
        # variable from the start -- Phase 1 runs a single slot (every entity on
        # config 0, behavior-identical to the old uniform setup), but growing it
        # is the supported path to heterogeneous particles.
        self.configs = [self.config]
        self.config_buffer = None
        #: Cached WorldData uniform payload. Rebuilt only when configs change --
        #: see _refresh_world_uniform().
        self._world_uniform = None
        self._upload_configs()
        self._refresh_world_uniform()

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
        self._set_constant_uniforms()

    def _set_constant_uniforms(self):
        """Push uniforms that never change while a program lives.

        Texture units and the canvas resolution are fixed for the lifetime of a
        compiled program, so setting them per sub-step was pure overhead at
        ~1800 dispatches a second. Re-run after every shader reload, because a
        freshly compiled program starts with its uniforms unset.
        """
        resolution = (float(self.canvas_size[0]), float(self.canvas_size[1]))
        tryset(self.entity_update_program, 'canvas_texture', 0)
        tryset(self.canvas_update_program, 'canvas_texture', 0)
        tryset(self.brush_splat_program, 'canvas_resolution', resolution)

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

    def current_world_config(self):
        """WorldData for whatever is currently uploaded.

        Public: the save path and the settings window both need it, and reaching
        into a private helper across a module boundary is exactly what the
        narrow-accessor rule exists to prevent.
        """
        return self.world.for_upload(
            sqrt_world_size=self.sqrt_world_size,
            config_count=len(self.configs),
        )

    def _refresh_world_uniform(self):
        """Recompute the cached WorldData payload.

        Called when the project changes -- NOT per sub-step. Building it walks a
        dataclass, allocates a numpy record and builds a tuple; at 30 sub-steps
        per frame across three programs that was ~32k allocations a second for a
        value that only changes when the user moves a slider.
        """
        self._world_uniform = self.current_world_config().as_uniform_value()

    def _set_world_uniform(self, program):
        tryset(program, 'world.trail', self._world_uniform)

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
        return self.entity_count_value

    def pick(self, target_world, radius_world):
        """Nearest entity to a world position, within `radius_world`.

        Deferred by one frame: this dispatches a pick for the given target and
        returns the result of the PREVIOUS call. Reading the current frame's
        result would stall the GPU, and WebGPU has no synchronous readback at
        all -- see picker.py for the full reasoning.

        Returns a PickResult; check `.hit` before using `.index`.
        """
        result = self.picker.retrieve(self.entity_buffer, ENTITY_DTYPE)
        self.picker.request(self.entity_buffer, self.entity_count_value, target_world,
                            self.canvas_size, radius_world)
        return result

    def pick_blocking(self, target_world, radius_world):
        """Pick the CURRENT frame's answer, stalling until it is ready.

        Prefer `pick()`. This exists for one-shot host-side queries (tests,
        tooling) where a frame of latency is unacceptable. It forces a GPU sync
        and does NOT translate to WebGPU, so it must not be used in the render
        loop.
        """
        self.picker.request(self.entity_buffer, self.entity_count_value, target_world,
                            self.canvas_size, radius_world)
        self.ctx.finish()
        return self.picker.retrieve(self.entity_buffer, ENTITY_DTYPE)

    def current_canvas_texture(self):
        """Narrow accessor: the canvas texture to present this frame.

        Returned by value each frame rather than held persistently by consumers,
        because the double-buffer swap means the front texture changes identity.
        """
        return self.canvas_texture

    def apply_project(self, project):
        """Upload a project's configs and world settings. Does not touch entities.

        The ONE point where project state reaches the GPU. Loading,
        hover-preview and every slider edit all funnel through here: the
        particles keep moving and simply start obeying different rules, so a
        change can be applied and undone with a single buffer upload and no
        visual discontinuity.

        Deciding *what* the state should be is the Project type's job (see
        project/project.py); this only ships it to the device.
        """
        self.world = project.world
        self.apply_configs(project.configs)

    def apply_configs(self, configs):
        """Replace the ConfigBuffer contents. Does not touch entities."""
        if not configs:
            return
        self.configs = list(configs)
        self.config = self.configs[0]
        self._upload_configs()
        # config_count is part of WorldData, so the cached uniform is stale
        # until refreshed. Doing it here -- the one place the count changes --
        # is what keeps it out of the per-sub-step path.
        self._refresh_world_uniform()

    def update_entities(self):
        """Dispatch compute shader to update entity positions."""

        self.entity_buffer.bind_to_storage_buffer(ENTITY_BUFFER_BINDING)
        self.config_buffer.bind_to_storage_buffer(CONFIG_BUFFER_BINDING)

        # Only frame_count varies per sub-step; the world uniform is cached and
        # canvas_texture's unit is set once at reload.
        self._set_world_uniform(self.entity_update_program)
        tryset(self.entity_update_program, 'frame_count', self.frame_count)
        self.canvas_texture.use(location=0)

        # Dispatch enough workgroups to cover all entities
        # local_size_x = 256, so we need ceil(entity_count / 256) workgroups
        workgroups = math.ceil(self.entity_count_value / 256)
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

        # World supplies trail_persistence for the (1-P)/P premultiply.
        # canvas_resolution is constant and set at reload.
        self._set_world_uniform(self.brush_splat_program)
        tryset(self.brush_splat_program, 'frame_count', self.frame_count)

        # Instanced rendering: 4 vertices per entity
        self.brush_vao.render(moderngl.TRIANGLE_FAN, vertices=4,
                              instances=self.entity_count_value)

        # Restore default blend mode
        self.ctx.disable(moderngl.BLEND)

    def update_canvas(self):
        """Diffuse and decay the canvas by trail persistence (splats already mixed in)."""
        if self.canvas_update_program is None or self.canvas_vao is None:
            return

        # Render to back buffer, reading from front
        self.canvas_fbo_back.use()

        self._set_world_uniform(self.canvas_update_program)
        tryset(self.canvas_update_program, 'frame_count', self.frame_count)

        self.canvas_texture.use(location=0)

        self.canvas_vao.render(moderngl.TRIANGLES)

        # Swap buffers
        self.canvas_texture, self.canvas_texture_back = self.canvas_texture_back, self.canvas_texture
        self.canvas_fbo, self.canvas_fbo_back = self.canvas_fbo_back, self.canvas_fbo
