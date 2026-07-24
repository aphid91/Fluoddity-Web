"""State for Multi Load feature."""
from dataclasses import dataclass, field


@dataclass
class MultiLoadState:
    """State for multi-load feature configuration."""

    # Feature toggle
    multi_load_enabled: bool = False

    # Loaded configurations (max 64) - stored in service, not here
    # We track count and filenames for UI display

    # Progress controls (floats for smooth interpolation)
    simultaneous_configs: float = 1.0  # Range: 0.0 to len(loaded_configs)
    progression_pace: float = 0.0      # Range: 0.0 to 1.0
    current_progress: float = 0.0      # Range: 0.0 to 1.0 (auto-advances based on pace)

    # Assignment settings
    assignment_mode: str = "Cohorts"  # "Random" or "Cohorts"
    per_config_initial_conditions: bool = False
    per_config_cohorts: bool = False
    per_config_hazard_rate: bool = False
