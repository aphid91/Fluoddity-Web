from dataclasses import dataclass, field
import numpy as np


@dataclass
class CameraState:
    """State for camera position and rendering mode."""
    position: np.ndarray = field(default_factory=lambda: np.array([0.0, 0.0]))
    zoom: float = 1.0
    BRIGHTNESS: float = 1.  # Kept for backward compat, sourced from SimState
    cam_brush_mode: bool = True
