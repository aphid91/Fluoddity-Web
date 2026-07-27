"""Preferences: editor state that is NOT part of a saved config.

The distinction matters and is worth stating plainly:

  ConfigData   per-particle behaviour. Saved. Loading someone else's config
               should change these -- that IS the config.
  WorldData    global simulation properties (trail decay). Saved, for the same
               reason: they define how the piece looks.
  Preferences  how YOUR editor is set up: brightness, physics rate, canvas
               size. NOT saved with a config, because loading a config you
               downloaded should not dim your screen or resize your canvas.

Persisted to preferences.json at the repo root (already gitignored), loaded at
startup and written when changed.

Fields here fall into two groups, and the difference drives the UI:
  live         cheap to change every frame (brightness, physics steps)
  disruptive   reallocates GPU resources and resets the simulation (world
               size, canvas aspect). The UI presents these as float INPUTS
               committed on Enter, never as sliders, so dragging cannot
               reset the simulation on every frame of the drag.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, asdict, fields, replace
from pathlib import Path

_PREFS_PATH = Path(__file__).parent.parent / "preferences.json"


@dataclass(frozen=True)
class Preferences:
    """Editor preferences. Frozen; edits produce a new instance via `replace`."""

    # --- live ---
    #: Output brightness multiplier applied by the present pass.
    brightness: float = 1.0
    #: Physics sub-steps per rendered frame. Higher = faster simulation time.
    physics_steps: int = 30

    # --- drawing (Draw tool) ---
    #: Airbrush gaussian sigma, in aspect-corrected canvas uv.
    draw_size: float = 0.031
    #: How hard a stroke paints. THE ONLY strength control for drawing: how far
    #: the painted field then moves a particle is a fixed constant
    #: (STRAFE_FIELD_GAIN in shared/shaders/common.glsl), so there is no second
    #: multiplier interacting with this one.
    draw_power: float = 1.0

    # --- disruptive: changing these reallocates and resets the simulation ---
    #: Scales entity count and canvas resolution together.
    world_size: float = 1.0
    #: Canvas width:height. Reshapes world space (see coords.py).
    canvas_aspect: float = 1.0

    @classmethod
    def load(cls, path=None) -> "Preferences":
        """Read preferences.json, falling back to defaults.

        Never raises: a corrupt or partial preferences file must not stop the
        app from starting, and unknown keys are ignored so downgrading does not
        break on a field a newer version wrote.
        """
        path = Path(path or _PREFS_PATH)
        if not path.is_file():
            return cls()
        try:
            data = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError) as e:
            print(f"Could not read preferences ({e}); using defaults")
            return cls()
        if not isinstance(data, dict):
            return cls()
        known = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in data.items() if k in known})

    def save(self, path=None):
        path = Path(path or _PREFS_PATH)
        try:
            path.write_text(json.dumps(asdict(self), indent=2))
        except OSError as e:
            print(f"Could not write preferences: {e}")

    def with_value(self, name: str, value) -> "Preferences":
        """A copy with one field changed. Unknown names return self unchanged."""
        if name not in {f.name for f in fields(self)}:
            return self
        return replace(self, **{name: value})

    def requires_restart(self, other: "Preferences") -> bool:
        """True if moving to `other` needs the simulation rebuilt."""
        return (self.world_size != other.world_size
                or self.canvas_aspect != other.canvas_aspect)
