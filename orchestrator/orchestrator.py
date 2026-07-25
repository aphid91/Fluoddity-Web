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

import glfw

from app_window import AppWindow
from camera import Camera, CameraMode
from particle_system import ParticleSystem
from particle_system import coords, persistence
from particle_system.picker import DEFAULT_PICK_RADIUS_PX, radius_px_to_world, MISS
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

        # Preset list for LEFT/RIGHT cycling, and the categorized view the load
        # menu shows. Both are rebuilt by _refresh_config_list() below.
        self.config_categories = {}
        self.presets = []
        self.preset_index = 0

        #: Entity currently under the cursor (one frame stale -- see picker.py).
        self.hovered = MISS
        #: Entity the user last clicked. Persists until the next click.
        self.selected = MISS

        self.ui = UI(self.window.window, commands={
            'reload': self._cmd_reload,
            'reset': self._cmd_reset,
            'next_preset': self._cmd_next_preset,
            'prev_preset': self._cmd_prev_preset,
            'toggle_camera_mode': self._cmd_toggle_camera_mode,
            'reset_camera': self._cmd_reset_camera,
            'quit': self._cmd_quit,
            # save / load
            'save_config': self._cmd_save_config,
            'load_config': self._cmd_load_config,
            'delete_config': self._cmd_delete_config,
            'preview_config': self._cmd_preview_config,
            'snapshot_configs': self._cmd_snapshot_configs,
            'restore_configs': self._cmd_restore_configs,
        })

        #: ConfigBuffer contents from before the load menu opened, so a
        #: hover-preview can be undone. None when nothing is snapshotted.
        self._config_snapshot = None
        self._save_error = ""
        self._refresh_config_list()

    def run(self):
        while not self.window.should_close():
            # Poll + snapshot input, open the imgui frame. Everything below
            # sees this frame's input.
            state = self.ui.begin_frame()
            self._apply_camera_input(state)
            # Before advancing: the pick must test the cursor against the
            # entity positions the user can currently SEE, not against where
            # they will be after 30 more sub-steps.
            #self._update_pick(state)

            for _ in range(PHYSICS_STEPS_PER_FRAME):
                self.system.advance()

            self.window.begin_frame()
            # Pull data from modules, hand them to Camera. No persistent link:
            # the canvas double-buffer swap stays invisible to the Camera.
            self.camera.render(
                framebuffer=self.window.ctx.screen,
                canvas_texture=self.system.current_canvas_texture(),
                entity_buffer=self.system.entity_buffer,
                entity_count=self.system.entity_count(),
                canvas_size=self.system.canvas_size,
                window_size=self.window.size(),
            )

            # Hand the UI display-only values; it owns no simulation truth.
            self._report_status()
            self.ui.end_frame()

            self.window.end_frame()

        self.ui.shutdown()
        self.window.terminate()

    def _apply_camera_input(self, state):
        """Translate canvas input into camera motion.

        The UI reports *what happened* (a drag, a scroll); deciding that this
        means "move the camera" is the Orchestrator's job. Both fields are
        already filtered for imgui capture, so dragging a panel never pans the
        view and scrolling a slider never zooms.
        """
        window_size = self.window.size()
        canvas_size = self.system.canvas_size

        if state.left_dragging and state.mouse_delta != (0.0, 0.0):
            self.camera.state.pan_by_pixels(state.mouse_delta, window_size, canvas_size)

        if state.scroll:
            self.camera.state.zoom_at_pixel(state.scroll, state.mouse_pos,
                                            window_size, canvas_size)

    def _update_pick(self, state):
        """Track the entity under the cursor, and latch it on click.

        The pick radius is specified in screen pixels and converted through the
        view transform, so the tolerance feels identical at any zoom -- a
        world-space radius would shrink on screen as you zoom out.
        """
        cam = self.camera.state
        window_size = self.window.size()
        canvas_size = self.system.canvas_size

        target = coords.screen_to_world(state.mouse_pos, window_size,
                                        canvas_size, cam.pan, cam.zoom)
        radius = radius_px_to_world(DEFAULT_PICK_RADIUS_PX, window_size,
                                    canvas_size, cam.pan, cam.zoom)
        self.hovered = self.system.pick(target, radius)

        if state.left_pressed:
            self.selected = self.hovered

    def _report_status(self):
        """Push read-only status into the UI for display (ARCHITECTURE rule 10)."""
        state = self.ui.state
        cam = self.camera.state
        window_size = self.window.size()
        canvas_size = self.system.canvas_size
        self.ui.set_status(
            # Through the full inverse chain, so the readout accounts for pan,
            # zoom and letterboxing -- it is the world point actually under the
            # cursor, not an approximation.
            mouse_world=coords.screen_to_world(
                state.mouse_pos, window_size, canvas_size, cam.pan, cam.zoom),
            cam_mode=cam.mode.value,
            cam_pan=cam.pan,
            cam_zoom=cam.zoom,
            canvas_size=f"{canvas_size[0]}x{canvas_size[1]}",
            window_size=f"{window_size[0]}x{window_size[1]}",
            hovered=self.hovered,
            selected=self.selected,
            config_categories=self.config_categories,
            save_error=self._save_error,
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

    def _cmd_toggle_camera_mode(self):
        self.camera.state.toggle_mode()

    def _cmd_reset_camera(self):
        self.camera.state.reset()

    def _cmd_quit(self):
        glfw.set_window_should_close(self.window.window, True)

    # --- save / load ---

    def _refresh_config_list(self):
        """Rescan configs/ so the load menu reflects the filesystem."""
        self.config_categories = persistence.discover(_CONFIG_DIR)
        # Keep the LEFT/RIGHT preset cycle in step with what is on disk.
        self.presets = [e.path for entries in self.config_categories.values()
                        for e in entries]
        self.preset_index = self._index_of(self.system.config_path)

    def _cmd_save_config(self, name, save_all):
        """Write the current config(s) to configs/custom/<name>.json."""
        self._save_error = ""
        safe = persistence.sanitize_filename(name)
        if not safe:
            self._save_error = "That name has no usable characters."
            return

        configs = (self.system.snapshot_configs() if save_all
                   else [self.system.configs[0]])
        cam = self.camera.state
        path = persistence.custom_dir(_CONFIG_DIR) / f"{safe}.json"
        try:
            persistence.save(
                path, configs, self.system._world_config(),
                camera={'pan': list(cam.pan), 'zoom': cam.zoom,
                        'mode': cam.mode.value},
            )
        except OSError as e:
            self._save_error = f"Could not write {path.name}: {e}"
            return

        self.system.config_path = str(path)
        self._refresh_config_list()
        print(f"Saved config: {path}")

    def _cmd_load_config(self, entry):
        """Commit a load. The menu has already dropped its snapshot."""
        self._config_snapshot = None
        try:
            saved = self.system.load_config(entry.path)
        except Exception as e:
            print(f"Failed to load {entry.path}: {e}")
            return
        # Only move the camera if the file actually recorded one -- v7 presets
        # did not, and snapping to a default would be worse than staying put.
        if saved.camera:
            self._apply_saved_camera(saved.camera)
        self.preset_index = self._index_of(str(entry.path))

    def _cmd_preview_config(self, entry):
        """Apply a config for hover-preview: settings only, no camera, no reset."""
        try:
            saved = persistence.load(entry.path)
        except Exception as e:
            print(f"Failed to preview {entry.path}: {e}")
            return
        self.system.apply_configs(saved.configs)

    def _cmd_snapshot_configs(self):
        self._config_snapshot = self.system.snapshot_configs()

    def _cmd_restore_configs(self):
        if self._config_snapshot is not None:
            self.system.apply_configs(self._config_snapshot)

    def _cmd_delete_config(self, entry):
        try:
            entry.path.unlink()
            print(f"Deleted config: {entry.path}")
        except OSError as e:
            print(f"Could not delete {entry.path}: {e}")
        self._refresh_config_list()

    def _apply_saved_camera(self, cam_data):
        state = self.camera.state
        pan = cam_data.get('pan')
        if pan and len(pan) == 2:
            state.pan = (float(pan[0]), float(pan[1]))
        if 'zoom' in cam_data:
            state.set_zoom(float(cam_data['zoom']))
        mode = cam_data.get('mode')
        for candidate in CameraMode:
            if candidate.value == mode:
                state.mode = candidate
                break

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
