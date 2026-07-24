"""MultiLoadService - Manages multiple physics configurations for particle assignment."""
from services.config_saver import PhysicsConfig
from typing import Optional

MAX_CONFIGS = 64


class MultiLoadService:
    """Service for managing multiple physics configurations in multi-load mode."""

    def __init__(self):
        """Initialize the multi-load service."""
        self.loaded_configs: list[PhysicsConfig] = []
        self.loaded_filenames: list[str] = []  # Track filenames for UI display
        self.simultaneous_configs: float = 1.0
        self.progression_pace: float = 0.0
        self.current_progress: float = 0.0
        self.assignment_mode: str = "Cohorts"
        self.per_config_initial_conditions: bool = False
        self.per_config_cohorts: bool = False
        self.per_config_hazard_rate: bool = False
        self._ssbo_dirty: bool = False  # Flag for SSBO update needed

    # --- Configuration Management ---

    def add_config(self, config: PhysicsConfig, filename: str) -> bool:
        """
        Add a configuration to the loaded list.

        Args:
            config: PhysicsConfig to add
            filename: Filename for UI display

        Returns:
            True if added successfully, False if list is full
        """
        if len(self.loaded_configs) >= MAX_CONFIGS:
            print(f"Cannot add config: maximum of {MAX_CONFIGS} configs reached")
            return False
        self.loaded_configs.append(config)
        self.loaded_filenames.append(filename)
        # Auto-adjust simultaneous_configs if needed
        if self.simultaneous_configs > len(self.loaded_configs):
            self.simultaneous_configs = float(len(self.loaded_configs))
        self.invalidate_ssbo()  # Mark SSBO as needing update
        return True

    def remove_config(self, index: int) -> bool:
        """
        Remove a configuration at the given index.

        Args:
            index: Index of config to remove (0-based)

        Returns:
            True if removed successfully, False if index invalid
        """
        if 0 <= index < len(self.loaded_configs):
            self.loaded_configs.pop(index)
            self.loaded_filenames.pop(index)
            # Adjust simultaneous_configs if it exceeds new length
            if len(self.loaded_configs) > 0:
                self.simultaneous_configs = min(self.simultaneous_configs,
                                               float(len(self.loaded_configs)))
            else:
                self.simultaneous_configs = 1.0
            self.invalidate_ssbo()  # Mark SSBO as needing update
            return True
        return False

    def clear_all(self) -> None:
        """Remove all loaded configurations."""
        self.loaded_configs.clear()
        self.loaded_filenames.clear()
        self.simultaneous_configs = 1.0
        self.current_progress = 0.0
        self.invalidate_ssbo()  # Mark SSBO as needing update

    # --- Query Methods ---

    def get_config_count(self) -> int:
        """Get the number of loaded configurations."""
        return len(self.loaded_configs)

    def is_active(self) -> bool:
        """Check if multi-load mode is active (has at least 1 config)."""
        return len(self.loaded_configs) >= 1

    def get_config(self, index: int) -> Optional[PhysicsConfig]:
        """Get a configuration by index."""
        if 0 <= index < len(self.loaded_configs):
            return self.loaded_configs[index]
        return None

    def get_filename(self, index: int) -> Optional[str]:
        """Get a filename by index."""
        if 0 <= index < len(self.loaded_filenames):
            return self.loaded_filenames[index]
        return None

    # --- Progress Management ---

    def increment_progress(self) -> None:
        """
        Increment progress based on progression_pace.
        Called once per physics update (from sim.update()).
        """
        if self.progression_pace > 0:
            # Scale progression pace to reasonable speed
            # pace=1.0 should complete full cycle in ~1000 frames
            self.current_progress += self.progression_pace / 1000.0
            # Wrap around [0, 1]
            if self.current_progress >= 1.0:
                self.current_progress -= 1.0

    def set_progress(self, value: float) -> None:
        """Manually set progress value (from UI slider)."""
        self.current_progress = max(0.0, min(1.0, value))

    # --- State Sync ---

    def apply_state(self, multi_load_state) -> None:
        """
        Apply state from UI (similar to sim.apply_state pattern).

        Args:
            multi_load_state: MultiLoadState from UIState
        """
        self.simultaneous_configs = multi_load_state.simultaneous_configs
        self.progression_pace = multi_load_state.progression_pace
        # Don't overwrite current_progress from state - it's auto-advancing
        # Only sync from state if user manually changed it (handled in UI)
        self.assignment_mode = multi_load_state.assignment_mode
        self.per_config_initial_conditions = multi_load_state.per_config_initial_conditions
        self.per_config_cohorts = multi_load_state.per_config_cohorts
        self.per_config_hazard_rate = multi_load_state.per_config_hazard_rate

    # --- SSBO Management ---

    def invalidate_ssbo(self) -> None:
        """Mark the SSBO as needing an update (called when config data changes)."""
        self._ssbo_dirty = True

    def is_ssbo_dirty(self) -> bool:
        """Check if the SSBO needs to be rewritten."""
        return self._ssbo_dirty

    def clear_ssbo_dirty(self) -> None:
        """Clear the dirty flag (called after SSBO write completes)."""
        self._ssbo_dirty = False
