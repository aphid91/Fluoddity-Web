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

THIS FILE HOLDS THE LOOP, THE WIRING AND THE STATE -- NOT THE HANDLERS.
"Sole broker" means it routes, not that it implements. As features landed the
class grew to 24 handlers in 574 lines, and its own section comments were
marking the seams; those groups are now mixins:

    project_commands         save / load / preview / preset cycling
    clipboard_commands       in-session checkpoints
    settings_commands        slider edits, preference edits
    config_manager_commands  multi-config editing (scoped for removal)

The mixins own no state. They read and replace the attributes defined here,
which keeps the state in one readable place while the behaviour lives next to
the feature it serves.

FRAME ORDER
Input is polled at the TOP of the frame, so the physics and rendering that
follow act on this frame's input rather than the previous frame's. The imgui
frame spans the whole loop body -- opened before the simulation runs, closed
after all GL drawing -- so the interface composites on top of the sim.
"""

import dataclasses
from pathlib import Path

import glfw

from app_window import AppWindow
from camera import Camera
from particle_system import coords
from particle_system.particle_system import MAX_CONFIGS
from particle_system.picker import DEFAULT_PICK_RADIUS_PX, radius_px_to_world, MISS
from preferences import Preferences
from project import Project, History
from ui import UI

from .clipboard_commands import ClipboardCommands, Checkpoint
from .config_manager_commands import ConfigManagerCommands
from .project_commands import ProjectCommands
from .selection_commands import SelectionCommands, MouseMode
from .settings_commands import SettingsCommands

# Physics sub-steps per frame is a live preference (Preferences.physics_steps).

_CONFIG_DIR = Path(__file__).parent.parent / "configs"

__all__ = ['Orchestrator', 'Checkpoint']


class Orchestrator(ProjectCommands, ClipboardCommands, SettingsCommands,
                   ConfigManagerCommands, SelectionCommands):

    #: Where configs live. An attribute so the command mixins can reach it.
    _config_dir = _CONFIG_DIR

    def __init__(self):
        self.window = AppWindow()
        ctx = self.window.ctx

        # Editor state, distinct from anything saved with a project.
        self.prefs = Preferences.load()

        self.camera = Camera(ctx)
        self.system = self._build_system()

        # --- state the command mixins read and replace ---

        #: The current project: configs + name + selection, as one immutable
        #: value. Replaced wholesale rather than mutated, so its invariants
        #: (selection in range, name tracks contents) hold by construction --
        #: see project/project.py for why that matters.
        self.project = Project(
            configs=tuple(self.system.configs),
            world=self.system.world,
            name=Path(self.system.config_path).stem,
        )

        #: In-session project checkpoints, newest first. Not persisted:
        #: File > Save is the route for anything worth keeping.
        self.checkpoints = []
        self._checkpoint_serial = 0

        #: Config list on disk, grouped into load-menu categories.
        self.config_categories = {}
        self.presets = []
        self.preset_index = 0

        #: Entity under the cursor / last clicked. Picking is on-demand, so
        #: these only change when the user asks -- see run().
        self.hovered = MISS
        self.selected = MISS

        #: What a left-click on the canvas does. Camera by default; selection
        #: needs its own mode because left-drag already pans.
        self.mouse_mode = MouseMode.CAMERA

        #: Undo/redo timeline. Seeded with the startup state so the first
        #: undo has somewhere to return to. Only selection and seed
        #: randomization record entries -- see project/history.py for why the
        #: obvious hook (_set_project) would be wrong.
        self.history = History()
        self.history.seed(self.project)

        #: Transient UI messages.
        self._manager_message = ""
        self._save_error = ""

        self.ui = UI(self.window.window, commands={
            'reload': self._cmd_reload,
            'reset': self._cmd_reset,
            'next_preset': self._cmd_next_preset,
            'prev_preset': self._cmd_prev_preset,
            'toggle_camera_mode': self._cmd_toggle_camera_mode,
            'reset_camera': self._cmd_reset_camera,
            'toggle_mouse_mode': self._cmd_toggle_mouse_mode,
            'undo': self._cmd_undo,
            'redo': self._cmd_redo,
            'quit': self._cmd_quit,
            # save / load
            'save_config': self._cmd_save_config,
            'load_config': self._cmd_load_config,
            'delete_config': self._cmd_delete_config,
            'preview_config': self._cmd_preview_config,
            'snapshot_configs': self._cmd_snapshot_configs,
            'restore_configs': self._cmd_restore_configs,
            # config manager
            'select_config': self._cmd_select_config,
            'duplicate_config': self._cmd_duplicate_config,
            'remove_config': self._cmd_remove_config,
            'append_config_file': self._cmd_append_config_file,
            # config clipboard
            'set_checkpoint': self._cmd_set_checkpoint,
            'delete_checkpoint': self._cmd_delete_checkpoint,
            'load_checkpoint': self._cmd_load_checkpoint,
            'load_latest_checkpoint': self._cmd_load_latest_checkpoint,
            'clipboard_snapshot': self._cmd_clipboard_snapshot,
            'clipboard_restore': self._cmd_clipboard_restore,
            'clipboard_apply': self._cmd_clipboard_apply,
            # settings
            'edit_setting': self._cmd_edit_setting,
            'randomize_seed': self._cmd_randomize_seed,
        })

        self._refresh_config_list()

    # ------------------------------------------------------------------
    # The frame loop
    # ------------------------------------------------------------------

    def run(self):
        while not self.window.should_close():
            # Poll + snapshot input, open the imgui frame. Everything below
            # sees this frame's input.
            state = self.ui.begin_frame()
            self._apply_canvas_input(state)

            # PICKING IS DELIBERATELY NOT RUN PER FRAME. A pick dispatches over
            # every entity, which measured in the tens of milliseconds per
            # frame at large world sizes -- far too much for something whose
            # answer is only wanted when the user acts.
            #
            # It is on-demand instead: a click, or an explicit request such as
            # holding a key to inspect the particle under the cursor. Call
            # _update_pick() from those paths, not from here.

            # Physics rate is a live preference, read each frame.
            for _ in range(self.prefs.physics_steps):
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
                brightness=self.prefs.brightness,
            )

            # Hand the UI display-only values; it owns no simulation truth.
            self._report_status()
            self.ui.end_frame()

            self.window.end_frame()

        self.ui.shutdown()
        self.window.terminate()

    # ------------------------------------------------------------------
    # Per-frame plumbing
    # ------------------------------------------------------------------

    def _set_project(self, project):
        """Adopt a new project and push it to the GPU.

        THE single place project state changes. Everything that used to be
        "apply the configs, fix the name, re-clamp the selection" is now one
        call, with the invariants enforced inside Project rather than repeated
        at each call site.
        """
        self.project = project
        self.system.apply_project(project)

    def _apply_canvas_input(self, state):
        """Translate canvas input into camera motion and selection.

        The UI reports *what happened* (a drag, a click); deciding what it means
        is the Orchestrator's job. Every field consulted here is already
        filtered for imgui capture, so dragging a panel never pans the view and
        clicking a button never selects a particle.

        LEFT-DRAG PANS AND LEFT-CLICK SELECTS, so they must not both fire. The
        mouse mode arbitrates: panning is always available in CAMERA mode, and
        in SELECT mode a click selects instead. Without the mode, every attempt
        to pan would select a particle on the way down.
        """
        window_size = self.window.size()
        canvas_size = self.system.canvas_size

        if self.mouse_mode is MouseMode.SELECT:
            if state.left_pressed:
                self._cmd_select_particle(state.mouse_pos)
            # Right-click undoes, mirroring the original's binding.
            if state.right_pressed:
                self._cmd_undo()
        elif state.left_dragging and state.mouse_delta != (0.0, 0.0):
            self.camera.state.pan_by_pixels(state.mouse_delta, window_size, canvas_size)

        # Zoom works in both modes: it is navigation, not a tool.
        if state.scroll:
            self.camera.state.zoom_at_pixel(state.scroll, state.mouse_pos,
                                            window_size, canvas_size)

    def _update_pick(self, state):
        """Find the entity under the cursor. ON-DEMAND ONLY -- see run().

        A pick dispatches over every entity, so this is called from user
        actions (a click, an explicit inspect request), never per frame.

        The radius is specified in screen pixels and converted through the view
        transform, so the tolerance feels identical at any zoom -- a
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
            mouse_mode=self.mouse_mode.value,
            can_undo=self.history.can_undo,
            can_redo=self.history.can_redo,
            undo_label=self.history.undo_label(),
            history_depth=self.history.depth,
            history_cursor=self.history.cursor,
            cam_pan=cam.pan,
            cam_zoom=cam.zoom,
            canvas_size=f"{canvas_size[0]}x{canvas_size[1]}",
            window_size=f"{window_size[0]}x{window_size[1]}",
            hovered=self.hovered,
            selected=self.selected,
            config_categories=self.config_categories,
            save_error=self._save_error,
            project_name=self.project.name,
            selected_config=self.project.selected,
            max_configs=MAX_CONFIGS,
            manager_message=self._manager_message,
            checkpoints=self.checkpoints,
            # The three settings sources, as plain dicts the window reads by
            # field name. Snapshots, not references: the UI never holds live
            # simulation objects (rule 10). Built only when a window that reads
            # them is open -- see _settings_dicts().
            **self._settings_dicts(),
            preset=Path(self.system.config_path).stem,
            entity_count=self.system.entity_count(),
            config_count=self.project.count,
            frame_count=self.system.frame_count,
        )

    #: Empty payload reused when no settings window is open, so the common case
    #: allocates nothing at all.
    _NO_SETTINGS = {'edit_config': {}, 'edit_world': {}, 'edit_prefs': {}}

    def _settings_dicts(self):
        """Settings payloads for the UI, built only when something reads them.

        `asdict` on a SimulationConfig deep-copies its 80-float rule tuple. Doing
        that every frame for a window that is closed is pure garbage; with both
        windows shut this returns a shared empty payload instead.
        """
        if not (self.ui.show_settings or self.ui.show_preferences):
            return self._NO_SETTINGS
        return {
            'edit_config': dataclasses.asdict(self.project.config),
            'edit_world': dataclasses.asdict(self.system.current_world_config()),
            'edit_prefs': dataclasses.asdict(self.prefs),
        }

    # ------------------------------------------------------------------
    # Simple commands. Feature groups live in the command mixins.
    # ------------------------------------------------------------------

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
