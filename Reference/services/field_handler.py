"""Field texture handler: manages field save/load/preview/cache for configs.

Owns all GPU field texture state transitions (snapshot, restore, write, clear)
and the LRU cache for field PNGs. CommandHandler delegates field operations here.
"""
import numpy as np
from services.field_texture_cache import FieldTextureCache
from utilities.field_texture_io import is_field_nonzero, save_field_png as _save_field_png

MAX_FIELD_SNAPSHOTS = 20  # Max clipboard entries with non-None field snapshots


class FieldHandler:
    """Manages field texture persistence across config save/load/preview/clipboard.

    Operates on the AdvancedDrawingProcessor's GPU field texture. All methods
    are no-ops when adv_draw is None (fields disabled).
    """

    def __init__(self, adv_draw, sim, param_lock_service=None):
        self.adv_draw = adv_draw
        self.sim = sim
        self.param_lock_service = param_lock_service
        self.cache = FieldTextureCache(max_size=20)

        # File preview cached state
        self._cached_field_data = None
        self._cached_field_strengths = None

        # Clipboard preview cached state
        self._clipboard_cached_field_data = None
        self._clipboard_cached_field_strengths = None

        # Last Ctrl+C field cache (for Ctrl+V restore)
        self._last_copied_field_data = None  # np.ndarray or None
        self._last_copied_field_strengths = None  # (force, strafe) or None

    @property
    def _has_field_tex(self):
        """Whether the GPU field texture exists and is initialized."""
        return self.adv_draw is not None and self.adv_draw.field_texture is not None

    def _write_field_with_locks(self, new_data):
        """Write field data to GPU, respecting force/strafe field locks.

        If both fields locked, skips write. If one locked, preserves its
        channels (force=XY 0:2, strafe=ZW 2:4) from existing GPU data.
        """
        pls = self.param_lock_service
        block_force = pls and pls.should_block_force_field()
        block_strafe = pls and pls.should_block_strafe_field()

        if block_force and block_strafe:
            return  # Both locked, write nothing

        if not block_force and not block_strafe:
            self.adv_draw.write_field_data(new_data)
            return

        # Partial lock: preserve locked channels from existing GPU state
        existing = self.adv_draw.snapshot_field_data()
        if existing is None:
            self.adv_draw.write_field_data(new_data)
            return

        merged = new_data.copy()
        if block_force:
            merged[:, :, 0:2] = existing[:, :, 0:2]
        else:
            merged[:, :, 2:4] = existing[:, :, 2:4]
        self.adv_draw.write_field_data(merged)

    def _should_skip_clear(self):
        """Whether clear_fields should be skipped due to field locks."""
        pls = self.param_lock_service
        return pls and (pls.should_block_force_field() or pls.should_block_strafe_field())

    def _write_field_strengths(self, ui_state, force_val, strafe_val):
        """Write field strength scalars, respecting individual param locks."""
        pls = self.param_lock_service
        if not (pls and pls.is_locked('force_field_strength')):
            ui_state.preferences.force_field_strength = force_val
        if not (pls and pls.is_locked('strafe_field_strength')):
            ui_state.preferences.strafe_field_strength = strafe_val

    # --- Snapshot / query ---

    def snapshot_with_strengths(self, ui_state):
        """Snapshot current field texture and strengths if non-zero.

        Also caches the result for Ctrl+V restore. Each Ctrl+C overwrites
        the previous cache (None if field is zero or uninitialized).

        Returns:
            (field_snapshot, field_strengths) where field_snapshot is np.ndarray
            or None, and field_strengths is (force, strafe) tuple or None.
        """
        if not self._has_field_tex:
            self._last_copied_field_data = None
            self._last_copied_field_strengths = (
                ui_state.preferences.force_field_strength,
                ui_state.preferences.strafe_field_strength,
            )
            return None, None

        field_data = self.adv_draw.snapshot_field_data()
        if field_data is not None and is_field_nonzero(field_data):
            field_strengths = (
                ui_state.preferences.force_field_strength,
                ui_state.preferences.strafe_field_strength,
            )
            self._last_copied_field_data = field_data
            self._last_copied_field_strengths = field_strengths
            return field_data, field_strengths

        self._last_copied_field_data = None
        self._last_copied_field_strengths = (
            ui_state.preferences.force_field_strength,
            ui_state.preferences.strafe_field_strength,
        )
        return None, None

    # --- File save/load ---

    def save_field_png(self, field_data, filename, configs_dir):
        """Save field PNG alongside config, or remove stale PNG.

        Args:
            field_data: np.ndarray from snapshot_with_strengths(), or None.
            filename: Config filename (without .json extension).
            configs_dir: Directory containing config files.
        """
        fields_png_path = configs_dir / f"{filename}_fields.png"
        if field_data is not None:
            _save_field_png(field_data, fields_png_path)
        elif fields_png_path.exists():
            fields_png_path.unlink()

    def delete_field_png(self, filepath):
        """Delete companion _fields.png and invalidate cache."""
        fields_path = filepath.with_name(filepath.stem + "_fields.png")
        if fields_path.exists():
            fields_path.unlink()
        self.cache.invalidate(filepath)

    def invalidate_cache(self, filepath):
        """Invalidate cached field data for a given config filepath."""
        self.cache.invalidate(filepath)

    def apply_for_config(self, config, json_filepath, ui_state):
        """Load and apply field texture from a file-based config.

        Reads the companion _fields.png via cache (pre-resized to current
        canvas dimensions). Lazily initializes GPU resources if needed.
        Clears field texture if no PNG exists. Respects field locks.
        """
        canvas_dim_x,canvas_dim_y = self.sim.get_canvas_dimensions()
        field_data = self.cache.get(json_filepath, canvas_dim_y, canvas_dim_x)

        if field_data is not None:
            if self.adv_draw:
                if self.adv_draw.field_texture is None:
                    canvas_dim_x,canvas_dim_y = self.sim.get_canvas_dimensions()
                    self.adv_draw.ensure_initialized(canvas_dim_x,canvas_dim_y)
                self._write_field_with_locks(field_data)
        else:
            if self._has_field_tex and not self._should_skip_clear():
                self.adv_draw.clear_fields()

        # Apply field strengths from config (respects locks)
        if config.force_field_strength is not None:
            self._write_field_strengths(
                ui_state, config.force_field_strength, config.strafe_field_strength)
        elif field_data is None:
            self._write_field_strengths(ui_state, 1.0, 1.0)

    def apply_last_copied(self, ui_state):
        """Apply the field state cached from the most recent Ctrl+C.

        If the cached field data is None (zero/uninitialized at copy time),
        clears the field texture. If the field texture isn't initialized and
        cached data is None, does nothing (no need to init for all-zeros).
        Respects field locks.
        """
        if self._last_copied_field_data is not None:
            if self.adv_draw:
                if self.adv_draw.field_texture is None:
                    canvas_dim_x,canvas_dim_y = self.sim.get_canvas_dimensions()
                    self.adv_draw.ensure_initialized(canvas_dim_x,canvas_dim_y)
                self._write_field_with_locks(self._last_copied_field_data)
        else:
            # Cached field is None (all zeros) - clear if initialized, skip if not
            if self._has_field_tex and not self._should_skip_clear():
                self.adv_draw.clear_fields()

        # Restore field strengths (respects locks)
        if self._last_copied_field_strengths is not None:
            self._write_field_strengths(
                ui_state,
                self._last_copied_field_strengths[0],
                self._last_copied_field_strengths[1])

    def clear_fields(self):
        """Clear the GPU field texture to zeros (if initialized)."""
        if self._has_field_tex:
            self.adv_draw.clear_fields()

    # --- File preview cache/restore ---

    def cache_for_preview(self, ui_state):
        """Cache current field state before starting file preview."""
        if self._has_field_tex:
            self._cached_field_data = self.adv_draw.snapshot_field_data()
        else:
            self._cached_field_data = None
        self._cached_field_strengths = (
            ui_state.preferences.force_field_strength,
            ui_state.preferences.strafe_field_strength,
        )

    def restore_from_preview(self, ui_state):
        """Restore cached field state when clearing file preview."""
        if self._has_field_tex and self._cached_field_data is not None:
            self.adv_draw.write_field_data(self._cached_field_data)

        if self._cached_field_strengths is not None:
            ui_state.preferences.force_field_strength = self._cached_field_strengths[0]
            ui_state.preferences.strafe_field_strength = self._cached_field_strengths[1]

    def discard_preview_cache(self):
        """Discard cached field state (preview was finalized via load)."""
        self._cached_field_data = None
        self._cached_field_strengths = None

    # --- Clipboard preview cache/restore ---

    def cache_for_clipboard_preview(self, ui_state):
        """Cache current field state before starting clipboard preview."""
        if self._has_field_tex:
            self._clipboard_cached_field_data = self.adv_draw.snapshot_field_data()
        else:
            self._clipboard_cached_field_data = None
        self._clipboard_cached_field_strengths = (
            ui_state.preferences.force_field_strength,
            ui_state.preferences.strafe_field_strength,
        )

    def restore_from_clipboard_preview(self, ui_state):
        """Restore cached field state when clearing clipboard preview."""
        if self._has_field_tex and self._clipboard_cached_field_data is not None:
            self.adv_draw.write_field_data(self._clipboard_cached_field_data)
        self._clipboard_cached_field_data = None

        if self._clipboard_cached_field_strengths is not None:
            ui_state.preferences.force_field_strength = self._clipboard_cached_field_strengths[0]
            ui_state.preferences.strafe_field_strength = self._clipboard_cached_field_strengths[1]
            self._clipboard_cached_field_strengths = None

    def discard_clipboard_preview_cache(self):
        """Discard clipboard cached field state (preview was finalized via click)."""
        self._clipboard_cached_field_data = None
        self._clipboard_cached_field_strengths = None

    # --- Clipboard field snapshot ---

    def apply_snapshot(self, field_snapshot, config, ui_state):
        """Apply a field snapshot from a clipboard entry. Respects field locks.

        Args:
            field_snapshot: np.ndarray or None from clipboard tuple.
            config: PhysicsConfig to read field_strengths from.
            ui_state: For writing force/strafe field strength preferences.
        """
        if field_snapshot is not None:
            if self.adv_draw:
                if self.adv_draw.field_texture is None:
                    canvas_dim_x,canvas_dim_y = self.sim.get_canvas_dimensions()
                    self.adv_draw.ensure_initialized(canvas_dim_x,canvas_dim_y)
                self._write_field_with_locks(field_snapshot)
        else:
            if self._has_field_tex and not self._should_skip_clear():
                self.adv_draw.clear_fields()

        if config.force_field_strength is not None:
            self._write_field_strengths(
                ui_state, config.force_field_strength, config.strafe_field_strength)
        elif field_snapshot is None:
            self._write_field_strengths(ui_state, 1.0, 1.0)

    def load_field_from_image(self, filepath: str, target: str):
        """Load an image file and write its polar-to-cartesian data to a field.

        Args:
            filepath: Path to the PNG/JPEG image file.
            target: "force" to write .xy channels, "strafe" to write .zw channels.
        """
        from pathlib import Path
        from utilities.field_texture_io import load_image_as_polar_field

        canvas_dim_x,canvas_dim_y = self.sim.get_canvas_dimensions()
        cartesian = load_image_as_polar_field(Path(filepath), canvas_dim_y, canvas_dim_x)
        if cartesian is None:
            print(f"Failed to load field image: {filepath}")
            return

        if self.adv_draw is None:
            print("Warning: advanced drawing processor not available")
            return

        if self.adv_draw.field_texture is None:
            self.adv_draw.ensure_initialized(canvas_dim_x,canvas_dim_y)

        existing = self.adv_draw.snapshot_field_data()
        if existing is None:
            existing = np.zeros((canvas_dim_y, canvas_dim_x, 4), dtype=np.float32)

        if target == "force":
            existing[:, :, 0] = cartesian[:, :, 0]
            existing[:, :, 1] = cartesian[:, :, 1]
        elif target == "strafe":
            existing[:, :, 2] = cartesian[:, :, 0]
            existing[:, :, 3] = cartesian[:, :, 1]

        self.adv_draw.write_field_data(existing)
        print(f"Loaded {target} field from image: {filepath}")

    def enforce_snapshot_cap(self, config_clipboard):
        """Null out oldest field snapshots if >MAX_FIELD_SNAPSHOTS entries have data."""
        entries_with_fields = []
        for i, entry in enumerate(config_clipboard):
            _config, _label, field_snapshot = entry
            if field_snapshot is not None:
                entries_with_fields.append(i)

        while len(entries_with_fields) > MAX_FIELD_SNAPSHOTS:
            oldest_idx = entries_with_fields.pop(0)
            config, label, _ = config_clipboard[oldest_idx]
            config_clipboard[oldest_idx] = (config, label, None)
