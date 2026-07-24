"""Histogram plotting manager: GPU resources and lifecycle for report() histograms."""
import moderngl
from utilities.gl_helpers import read_shader, tryset


# Change this to adjust histogram resolution globally
BUCKET_COUNT = 64

# Histogram render texture dimensions
HIST_TEX_WIDTH = 512
HIST_TEX_HEIGHT = 512


class PlottingManager:
    """Manages GPU resources for the histogram reporting system.

    Owns the reports SSBO, histogram render texture/FBO/shader, and drives
    the per-frame lifecycle (set uniforms, count steps, render, clear).
    """

    def __init__(self, ctx: moderngl.Context):
        self.ctx = ctx
        self.enabled = False
        self.accumulated_report_steps = 0

        # Per-channel state (4 channels)
        self.hist_min = [0.0, 0.0, 0.0, 0.0]
        self.hist_max = [1.0, 1.0, 1.0, 1.0]
        self.plot_mode = [0, 0, 0, 0]  # uint per channel (0 = disabled)
        self.axis_mode = [0, 0, 0, 0]  # 0=Linear, 1=Log, 2=Log-Log
        self.height_scale = [1.0, 1.0, 1.0, 1.0]
        self.height_min = [0.0, 0.0, 0.0, 0.0]
        self.height_max = [1.0, 1.0, 1.0, 1.0]

        # Create reports SSBO (uvec4 = 16 bytes each)
        self.reports_buffer = ctx.buffer(reserve=BUCKET_COUNT * 16)
        self.reports_buffer.clear()
        self.reports_buffer.bind_to_storage_buffer(5)

        # Create histogram render texture and FBO
        self.hist_texture = ctx.texture(
            (HIST_TEX_WIDTH, HIST_TEX_HEIGHT), 4, dtype='f1'
        )
        self.hist_texture.filter = (moderngl.NEAREST, moderngl.NEAREST)
        self.hist_fbo = ctx.framebuffer(color_attachments=[self.hist_texture])

        # Compile histogram render shader
        self._compile_shader()

    def _compile_shader(self):
        """Compile (or recompile) the histogram render shader."""
        vert_source = read_shader('shaders/histogram_render.vert')
        frag_source = read_shader('shaders/histogram_render.frag')
        self.hist_program = self.ctx.program(
            vertex_shader=vert_source,
            fragment_shader=frag_source,
        )
        self.hist_vao = self.ctx.vertex_array(self.hist_program, [])

    def pre_physics_frame(self, entity_update_program: moderngl.Program):
        """Set histogram uniforms on entity_update before physics loop.

        Called once per render frame, before any physics steps.
        """
        # Ensure SSBO stays bound
        self.reports_buffer.bind_to_storage_buffer(5)

        if self.enabled:
            tryset(entity_update_program, 'hist_min', tuple(self.hist_min))
            tryset(entity_update_program, 'hist_max', tuple(self.hist_max))
            tryset(entity_update_program, 'bucket_count', BUCKET_COUNT)
            tryset(entity_update_program, 'plot_mode', tuple(self.plot_mode))
        else:
            # All channels disabled — report() will early-exit
            tryset(entity_update_program, 'plot_mode', (0, 0, 0, 0))
            tryset(entity_update_program, 'bucket_count', BUCKET_COUNT)
            tryset(entity_update_program, 'hist_min', (0.0, 0.0, 0.0, 0.0))
            tryset(entity_update_program, 'hist_max', (1.0, 1.0, 1.0, 1.0))

    def notify_physics_step(self):
        """Called after each entity_update dispatch to count accumulation steps."""
        self.accumulated_report_steps += 1

    def render_histograms(self):
        """Render histogram bars from the reports SSBO to the histogram texture."""
        if not self.enabled or self.accumulated_report_steps == 0:
            return

        # Ensure reports SSBO is bound for reading by the fragment shader
        self.reports_buffer.bind_to_storage_buffer(5)

        # Save current FBO and restore after
        old_fbo = self.ctx.fbo

        self.hist_fbo.use()
        self.ctx.clear(0.0, 0.0, 0.0, 1.0)

        tryset(self.hist_program, 'accumulated_report_steps', self.accumulated_report_steps)
        tryset(self.hist_program, 'bucket_count', BUCKET_COUNT)
        tryset(self.hist_program, 'height_scale', tuple(self.height_scale))
        tryset(self.hist_program, 'height_min', tuple(self.height_min))
        tryset(self.hist_program, 'height_max', tuple(self.height_max))
        tryset(self.hist_program, 'axis_mode', tuple(self.axis_mode))

        self.hist_vao.render(mode=moderngl.TRIANGLE_FAN, vertices=4)

        old_fbo.use()

    def post_assembly_frame(self):
        """Called once per render frame after frame assembly is complete.

        Renders histograms, then clears the reports buffer for the next frame.
        """
        self.render_histograms()

        # Clear reports buffer for next frame
        self.reports_buffer.clear()

        # Reset step counter
        self.accumulated_report_steps = 0

    def reload_shader(self):
        """Recompile histogram render shader (called on V key press)."""
        try:
            self._compile_shader()
            print('Histogram shader reloaded')
        except Exception as e:
            print(f'Histogram shader reload failed: {e}')

    def get_texture(self) -> moderngl.Texture:
        """Return the histogram render texture for imgui display."""
        return self.hist_texture

    def cleanup(self):
        """Release all GPU resources."""
        self.reports_buffer.release()
        self.hist_texture.release()
        self.hist_fbo.release()
