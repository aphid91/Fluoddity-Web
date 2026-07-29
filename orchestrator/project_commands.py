"""Save / load / preview commands.

Everything that moves a project between disk and the running simulation:
saving, loading, hover-preview, delete, and the preset cycle.

Mixed into the Orchestrator rather than owning state itself. The Orchestrator
holds `project`, `system`, `camera` and the config list; these methods read and
replace them through `_set_project`. Splitting them out keeps the Orchestrator
to the frame loop and the wiring, which is what "sole broker" was meant to mean
-- it routes, it does not implement.
"""

from __future__ import annotations

from pathlib import Path

from particle_system import persistence
from particle_system.config import BC_WRAP
from particle_system.particle_system import ParticleSystem
from particle_system.sizing import canvas_dimensions, sizing_for
from strafe_field import StrafeField


class ProjectCommands:
    """Save/load/preview handlers. Expects the Orchestrator's attributes."""

    # ------------------------------------------------------------------
    # Building the simulation
    # ------------------------------------------------------------------

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
        """Rebuild after a disruptive preference change, preserving the project.

        The simulation restarts -- inherent to reallocating the entity buffer --
        but the live project carries over, so a world-size change does not
        discard edits.

        Deliberately does not reload from config_path: the in-memory configs may
        contain unsaved edits, and the path may no longer exist (the file could
        have been deleted since it was loaded).
        """
        path = self.system.config_path
        self.system = self._build_system()
        self.system.apply_project(self.project)
        self.system.config_path = path

        # The field is sized to the canvas, so a new canvas needs a new field --
        # otherwise its uv mapping would silently skew against the new shape.
        # Its contents are lost, which is consistent with the field being
        # live-only state that was never going to survive a restart either.
        self.strafe_field.release()
        self.strafe_field = StrafeField(self.window.ctx, self.system.canvas_size)
        self.strafe_field.set_wrap(
            self.project.world.boundary_conditions == BC_WRAP)
        self._end_stroke()

    # ------------------------------------------------------------------
    # Discovery
    # ------------------------------------------------------------------

    def _refresh_config_list(self):
        """Rescan configs/ so the load menu reflects the filesystem."""
        self.config_categories = persistence.discover(self._config_dir)
        # Keep the LEFT/RIGHT preset cycle in step with what is on disk.
        self.presets = [e.path for entries in self.config_categories.values()
                        for e in entries]
        self.preset_index = self._index_of(self.system.config_path)

    def _index_of(self, config_path):
        target = Path(config_path).resolve()
        for i, p in enumerate(self.presets):
            if p.resolve() == target:
                return i
        return 0

    # ------------------------------------------------------------------
    # Commands
    # ------------------------------------------------------------------

    def _cmd_save_config(self, name, save_all):
        """Write the project to configs/custom/<name>.json."""
        self._save_error = ""
        safe = persistence.sanitize_filename(name)
        if not safe:
            self._save_error = "That name has no usable characters."
            return

        configs = (list(self.project.configs) if save_all
                   else [self.project.configs[0]])
        cam = self.camera.state
        path = persistence.custom_dir(self._config_dir) / f"{safe}.json"
        try:
            persistence.save(
                path, configs, self.project.world,
                camera={'pan': list(cam.pan), 'zoom': cam.zoom,
                        'mode': cam.mode.value},
            )
        except OSError as e:
            self._save_error = f"Could not write {path.name}: {e}"
            return

        self.system.config_path = str(path)
        self.project = self.project.renamed(safe)
        self._refresh_config_list()
        print(f"Saved config: {path}")

    def _cmd_load_config(self, entry):
        """Commit a load. The menu's session has already marked it committed."""
        try:
            saved = persistence.load(entry.path)
        except Exception as e:
            print(f"Failed to load {entry.path}: {e}")
            return
        before = self._pre_preview_project(self.project)
        self._set_project(self.project.with_configs(saved.configs,
                                                    name=entry.name,
                                                    world=saved.world))
        self._record_history(before, f"load {entry.name}")
        self._preview_origin = None
        self.system.config_path = str(entry.path)
        # Only move the camera if the file actually recorded one -- v7 presets
        # did not, and snapping to a default would be worse than staying put.
        if saved.camera:
            self._apply_saved_camera(saved.camera)
        self.preset_index = self._index_of(str(entry.path))
        print(f"Loaded config: {entry.path}")

    def _cmd_preview_config(self, entry):
        """Apply a config for hover-preview: settings only, no camera, no reset.

        The title tracks what is applied, previews included -- so browsing the
        load list renames the Project window as you go.

        DOES NOT RECORD HISTORY. A preview is a transient state the user never
        chose; browsing forty configs would otherwise leave forty undo entries.
        Only a committed load records.
        """
        try:
            saved = persistence.load(entry.path)
        except Exception as e:
            print(f"Failed to preview {entry.path}: {e}")
            return
        self._set_project(self.project.with_configs(saved.configs,
                                                    name=entry.name,
                                                    world=saved.world))

    # Hover-preview snapshot/restore. A Project IS the snapshot -- immutable, so
    # holding a reference is enough. Each hover surface keeps its own, so two
    # open at once cannot clobber each other (see ui/hover_preview.py).

    def _cmd_snapshot_configs(self):
        # Remember where browsing started, so a committed load records against
        # it rather than against whatever preview happened to be showing.
        self._preview_origin = self.project
        return self.project

    def _cmd_restore_configs(self, snapshot=None):
        # The other half of hover-preview; likewise never recorded.
        if snapshot is not None:
            self._set_project(snapshot)
        self._preview_origin = None

    def _cmd_delete_config(self, entry):
        try:
            entry.path.unlink()
            print(f"Deleted config: {entry.path}")
        except OSError as e:
            print(f"Could not delete {entry.path}: {e}")
        self._refresh_config_list()

    # ------------------------------------------------------------------
    # Preset cycling (LEFT/RIGHT)
    # ------------------------------------------------------------------

    def _cmd_next_preset(self):
        self._switch_preset(self.preset_index + 1)

    def _cmd_prev_preset(self):
        self._switch_preset(self.preset_index - 1)

    def _switch_preset(self, index):
        if not self.presets:
            return
        self.preset_index = index % len(self.presets)
        path = self.presets[self.preset_index]
        try:
            saved = persistence.load(path)
        except Exception as e:
            print(f"Failed to load {path}: {e}")
            return
        before = self.project
        self._set_project(self.project.with_configs(saved.configs,
                                                    name=Path(path).stem,
                                                    world=saved.world))
        self._record_history(before, f"load {Path(path).stem}")
        self.system.config_path = str(path)
        print(f"Loaded config: {path}")

    def _apply_saved_camera(self, cam_data):
        from camera import CameraMode
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
