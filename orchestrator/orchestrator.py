"""Orchestrator: the sole broker of commands and data between modules.

Owns one instance each of AppWindow, Camera, ParticleSystem, and UI. Modules
hold no references to one another; all inter-module communication flows through
here. Two examples of the pattern:

  - Data: each frame the Orchestrator pulls the current canvas texture from
    ParticleSystem (via a narrow accessor) and hands it to Camera. Camera never
    holds a persistent reference to it.
  - Commands: UI reports named intents ('reload', 'next_preset', ...) which the
    Orchestrator translates into public method calls on the right module.

The moderngl `ctx` is the one sanctioned shared substrate: created by AppWindow
and injected once into Camera and ParticleSystem at construction.

FRAME ORDER
Input is polled at the TOP of the frame, so the physics and rendering that
follow act on this frame's input rather than the previous frame's. The imgui
frame spans the whole loop body -- opened before the simulation runs, closed
after all GL drawing -- so the interface composites on top of the sim.
"""

from pathlib import Path

from app_window import AppWindow
from camera import Camera
from particle_system import ParticleSystem
from particle_system import coords
from ui import UI

# How many physics sub-steps per rendered frame (physics ~180Hz).
PHYSICS_STEPS_PER_FRAME = 30

_CONFIG_DIR = Path(__file__).parent.parent / "configs"


class Orchestrator:
    def __init__(self):
        self.window = AppWindow()
        ctx = self.window.ctx

        self.camera = Camera(ctx)
        self.system = ParticleSystem(ctx)

        # Preset list, for LEFT/RIGHT cycling. Ordered by filename.
        self.presets = sorted(_CONFIG_DIR.glob("*.json"))
        self.preset_index = self._index_of(self.system.config_path)

        self.ui = UI(self.window.window, commands={
            'reload': self._cmd_reload,
            'reset': self._cmd_reset,
            'next_preset': self._cmd_next_preset,
            'prev_preset': self._cmd_prev_preset,
        })

    def run(self):
        while not self.window.should_close():
            # Poll + snapshot input, open the imgui frame. Everything below
            # sees this frame's input.
            self.ui.begin_frame()

            for _ in range(PHYSICS_STEPS_PER_FRAME):
                self.system.advance()

            self.window.begin_frame()
            # Pull data from one module, hand it to another. No persistent link.
            self.camera.render_texture(
                self.system.current_canvas_texture(),
                self.window.ctx.screen,
            )

            # Hand the UI display-only values; it owns no simulation truth.
            self._report_status()
            self.ui.end_frame()

            self.window.end_frame()

        self.ui.shutdown()
        self.window.terminate()

    def _report_status(self):
        """Push read-only status into the UI for display (ARCHITECTURE rule 10)."""
        state = self.ui.state
        self.ui.set_status(
            mouse_world=coords.screen_to_world(
                state.mouse_pos, self.window.size(), self.system.canvas_size),
            preset=Path(self.system.config_path).stem,
            entity_count=self.system.entity_count(),
            config_count=len(self.system.configs),
            frame_count=self.system.frame_count,
        )

    # --- command handlers (invoked by UI via the commands map) ---

    def _cmd_reload(self):
        self.camera.reload()
        self.system.reload()

    def _cmd_reset(self):
        self.system.reset()

    def _cmd_next_preset(self):
        self._switch_preset(self.preset_index + 1)

    def _cmd_prev_preset(self):
        self._switch_preset(self.preset_index - 1)

    # --- preset helpers ---

    def _switch_preset(self, index):
        if not self.presets:
            return
        self.preset_index = index % len(self.presets)
        self.system.load_config(str(self.presets[self.preset_index]))

    def _index_of(self, config_path):
        target = Path(config_path).resolve()
        for i, p in enumerate(self.presets):
            if p.resolve() == target:
                return i
        return 0
