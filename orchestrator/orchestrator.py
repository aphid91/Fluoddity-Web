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

import dataclasses
import random
from dataclasses import dataclass, field
from itertools import count
from pathlib import Path

import glfw

from app_window import AppWindow
from camera import Camera, CameraMode
from particle_system import ParticleSystem
from particle_system import coords, persistence
from particle_system.particle_system import (MAX_CONFIGS, canvas_dimensions,
                                             sizing_for)
from particle_system.picker import DEFAULT_PICK_RADIUS_PX, radius_px_to_world, MISS
from preferences import Preferences
from ui import UI
from ui import settings_spec as spec

# Physics sub-steps per frame is now a live preference (Preferences.physics_steps).

_CONFIG_DIR = Path(__file__).parent.parent / "configs"

_checkpoint_ids = count()


@dataclass(frozen=True)
class Checkpoint:
    """An in-session snapshot of the entire ConfigBuffer.

    `key` is an opaque id rather than the name, so the hover-preview machinery
    keeps tracking the right entry even if two checkpoints ever share a name.
    """

    name: str
    configs: list
    key: int = field(default_factory=lambda: next(_checkpoint_ids))


class Orchestrator:
    def __init__(self):
        self.window = AppWindow()
        ctx = self.window.ctx

        # Editor state, distinct from anything saved with a config.
        self.prefs = Preferences.load()

        self.camera = Camera(ctx)
        self.system = self._build_system()

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

        #: Which ConfigData subsequent controls will edit. Config 0 by default,
        #: so a single-config buffer needs no interaction.
        self.selected_config = 0
        #: In-session ConfigBuffer checkpoints, newest first. Not persisted:
        #: File > Save is the route for anything worth keeping.
        self.checkpoints = []
        self._checkpoint_serial = 0
        self._manager_message = ""

        # Hover-preview snapshots are owned by each UI surface's PreviewSession
        # (see ui/hover_preview.py), not stored here -- one shared slot would
        # let two open surfaces clobber each other.
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
            selected_config=self.selected_config,
            max_configs=MAX_CONFIGS,
            # The three settings sources, as plain dicts the window reads by
            # field name. Snapshots, not references: the UI never holds live
            # simulation objects (rule 10).
            edit_config=self._editable_config(),
            edit_world=dataclasses.asdict(self.system._world_config()),
            edit_prefs=dataclasses.asdict(self.prefs),
            manager_message=self._manager_message,
            checkpoints=self.checkpoints,
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

    def _build_system(self, config_path=None):
        """Construct a ParticleSystem sized by the current preferences.

        World size and canvas aspect determine GPU allocation, so changing
        either means building a new system rather than adjusting this one.
        """
        entity_count, dim = sizing_for(self.prefs.world_size)
        return ParticleSystem(
            self.window.ctx,
            canvas_size=canvas_dimensions(self.prefs.canvas_aspect, dim),
            config_path=config_path,
            entity_count=entity_count,
        )

    def _rebuild_system(self):
        """Rebuild after a disruptive preference change, preserving configs.

        The simulation restarts -- that is inherent to reallocating the entity
        buffer -- but the LIVE configs carry over, so a world-size change does
        not discard edits the user has made.

        Deliberately does not reload from config_path: those in-memory configs
        may contain unsaved edits, and the path itself may no longer exist (the
        file could have been deleted since it was loaded). The new system is
        built from the default preset purely to get a valid initial state, then
        immediately overwritten with the configs we carried across.
        """
        configs = self.system.snapshot_configs()
        path = self.system.config_path
        self.system = self._build_system()
        self.system.apply_configs(configs)
        # Keep the reported preset name pointing at wherever these configs came
        # from, even though we did not re-read the file.
        self.system.config_path = path
        self.selected_config = min(self.selected_config,
                                   len(self.system.configs) - 1)

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
        """Commit a load. The menu's session has already marked it committed."""
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
        # A load replaces the buffer, which may be smaller than before.
        self.selected_config = min(self.selected_config,
                                   len(self.system.configs) - 1)

    def _cmd_preview_config(self, entry):
        """Apply a config for hover-preview: settings only, no camera, no reset."""
        try:
            saved = persistence.load(entry.path)
        except Exception as e:
            print(f"Failed to preview {entry.path}: {e}")
            return
        self.system.apply_configs(saved.configs)

    def _cmd_snapshot_configs(self):
        """Snapshot for the Load menu's hover-preview session.

        Returns it rather than storing it: each hover surface owns its own
        snapshot, so two of them open at once cannot clobber each other.
        """
        return self.system.snapshot_configs()

    def _cmd_restore_configs(self, snapshot=None):
        if snapshot is not None:
            self.system.apply_configs(snapshot)
            self.selected_config = min(self.selected_config,
                                       len(self.system.configs) - 1)

    def _cmd_delete_config(self, entry):
        try:
            entry.path.unlink()
            print(f"Deleted config: {entry.path}")
        except OSError as e:
            print(f"Could not delete {entry.path}: {e}")
        self._refresh_config_list()

    # --- config manager ---

    def _cmd_select_config(self, index):
        if 0 <= index < len(self.system.configs):
            self.selected_config = index

    def _cmd_duplicate_config(self, index):
        self._manager_message = ""
        new_index = self.system.duplicate_config(index)
        if new_index is None:
            self._manager_message = f"Cannot duplicate: buffer is full ({MAX_CONFIGS})."
            return
        self.selected_config = new_index

    def _cmd_remove_config(self, index):
        self._manager_message = ""
        if not self.system.remove_config(index):
            self._manager_message = "Cannot remove the last config."
            return
        # Keep the selection in range after the list shrinks.
        self.selected_config = min(self.selected_config, len(self.system.configs) - 1)

    def _cmd_append_config_file(self, entry):
        """Append every config in a saved file to the buffer."""
        self._manager_message = ""
        try:
            saved = persistence.load(entry.path)
        except Exception as e:
            self._manager_message = f"Could not load {entry.name}: {e}"
            return
        added, rejected = self.system.append_configs(saved.configs)
        if added:
            # Select the first appended config: the user just asked for it, so
            # it is almost certainly what they want to work on.
            self.selected_config = len(self.system.configs) - added
        if rejected:
            self._manager_message = (
                f"Added {added} of {added + rejected} configs; "
                f"buffer is full ({MAX_CONFIGS}).")
        elif not added:
            self._manager_message = f"Buffer is full ({MAX_CONFIGS})."

    # --- config clipboard ---

    def _checkpoint_name(self):
        """Unique '<preset><NN>' name, numbering per preset.

        Numbering scans existing checkpoints rather than using a global counter,
        so deleting entries frees their numbers back up and the list does not
        drift into high numbers after a lot of churn.
        """
        stem = Path(self.system.config_path).stem or "Config"
        taken = {cp.name for cp in self.checkpoints}
        for n in range(100):
            candidate = f"{stem}{n:02d}"
            if candidate not in taken:
                return candidate
        # Past 100 of the same name, fall back to something guaranteed unique.
        self._checkpoint_serial += 1
        return f"{stem}_{self._checkpoint_serial}"

    def _cmd_set_checkpoint(self):
        """Capture the whole ConfigBuffer. Newest goes on top."""
        cp = Checkpoint(name=self._checkpoint_name(),
                        configs=self.system.snapshot_configs())
        self.checkpoints.insert(0, cp)

    def _cmd_delete_checkpoint(self, checkpoint):
        self.checkpoints = [c for c in self.checkpoints if c.key != checkpoint.key]

    def _cmd_load_checkpoint(self, checkpoint):
        self.system.apply_configs(checkpoint.configs)
        self.selected_config = min(self.selected_config,
                                   len(self.system.configs) - 1)

    def _cmd_load_latest_checkpoint(self):
        if self.checkpoints:
            self._cmd_load_checkpoint(self.checkpoints[0])

    def _cmd_clipboard_snapshot(self):
        """Snapshot for the clipboard's own hover-preview session.

        Separate from the load menu's snapshot: two independent hover surfaces
        must not share one slot, or hovering in one would clobber the other.
        """
        return self.system.snapshot_configs()

    def _cmd_clipboard_restore(self, snapshot):
        if snapshot is not None:
            self.system.apply_configs(snapshot)
            self.selected_config = min(self.selected_config,
                                       len(self.system.configs) - 1)

    def _cmd_clipboard_apply(self, checkpoint):
        self.system.apply_configs(checkpoint.configs)

    # --- settings ---

    def _cmd_edit_setting(self, setting, value):
        """Route an edit to whichever of the three sources owns the field."""
        if setting.source == spec.CONFIG:
            self.system.edit_config(self.selected_config, setting.field, value)
        elif setting.source == spec.WORLD:
            self.system.edit_world(setting.field, value)
        elif setting.source == spec.PREFS:
            self._edit_preference(setting, value)

    def _edit_preference(self, setting, value):
        updated = self.prefs.with_value(setting.field, value)
        if updated == self.prefs:
            return
        needs_rebuild = self.prefs.requires_restart(updated)
        self.prefs = updated
        self.prefs.save()
        if needs_rebuild:
            # World size / canvas aspect changed: the GPU allocation depends on
            # them, so the system is rebuilt. This is why those controls are
            # typed inputs rather than sliders.
            self._rebuild_system()

    def _cmd_randomize_seed(self, setting):
        """New mutation seed. Only meaningful while Mutation Scale > 0.

        Drawn from [0,1) to match the convention the legacy configs use -- the
        value is fed straight into the hash, so any float in range is valid.
        """
        self._cmd_edit_setting(setting, random.random())

    def _editable_config(self):
        """The selected config as a plain dict, for the settings window."""
        if not self.system.configs:
            return {}
        index = min(self.selected_config, len(self.system.configs) - 1)
        return dataclasses.asdict(self.system.configs[index])

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
