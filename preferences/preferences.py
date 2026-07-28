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

#: Sample count meaning "blur off", for the migration below. Mirrors the
#: gate_base on the Motion Blur control in ui/settings_spec.py.
_BLUR_OFF = 1
#: What a file written before the merge used when blur was on. The old pair was
#: a bool plus a count, and the count defaulted to 2.
_LEGACY_BLUR_SAMPLES = 2


def _migrate(data: dict) -> dict:
    """Bring an older preferences file up to the current field set.

    MOTION BLUR WAS A BOOL PLUS A COUNT and is now just the count, with 1
    meaning off. Dropping the bool without looking at it would silently switch
    blur off for anyone who had it on with a count of 1 -- a combination the old
    UI allowed, since the two could disagree. The bool is the statement of
    intent, so it wins: on with a useless count becomes a usable one.

    Unknown keys are already ignored by load(), so this only has to handle keys
    whose MEANING changed, not their presence.
    """
    if 'motion_blur' not in data:
        return data
    data = dict(data)
    was_on = bool(data.pop('motion_blur'))
    samples = int(data.get('motion_blur_samples', _LEGACY_BLUR_SAMPLES) or _BLUR_OFF)
    if was_on and samples <= _BLUR_OFF:
        samples = _LEGACY_BLUR_SAMPLES
    elif not was_on:
        samples = _BLUR_OFF
    data['motion_blur_samples'] = samples
    return data


@dataclass(frozen=True)
class Preferences:
    """Editor preferences. Frozen; edits produce a new instance via `replace`."""

    # --- live ---
    #: Output brightness multiplier. Applied by the assembler, once, for both
    #: camera modes -- so TRAIL and PARTICLES respond to it identically.
    brightness: float = 1.0
    #: Physics sub-steps per rendered frame. Higher = faster simulation time.
    physics_steps: int = 30

    # --- display: the frame assembly pipeline ---
    #: Highlight compression for the asinh tone curve. Low is more linear
    #: (brighter highlights); high is more logarithmic (reveals faint detail).
    tonemap_softness: float = 2.5

    #: Temporal supersampling. TARGET samples per displayed frame -- see
    #: orchestrator.blur_schedule(). The achieved count equals this when it
    #: divides physics_steps and is the nearest achievable count otherwise, so
    #: this is a target rather than a promise. Costs one full camera render per
    #: sample.
    #:
    #: 1 IS THE OFF SWITCH: one render per displayed frame is exactly what
    #: "no motion blur" means, so there is no separate enable flag to disagree
    #: with this number. The UI shows the pair as one gated control (a checkbox
    #: until you turn it on) rather than a bool beside a count.
    motion_blur_samples: int = 1

    bloom_enabled: bool = False
    #: Brightness cutoff for bloom extraction. Lower glows more widely.
    bloom_threshold: float = 0.11
    bloom_intensity: float = 0.23
    #: Spread of the blur kernel, in source-texel units.
    bloom_radius: float = 1.0

    # --- drawing (Draw tool) ---
    #: Airbrush gaussian sigma, in aspect-corrected canvas uv.
    draw_size: float = 0.031
    #: How hard a stroke paints. THE ONLY strength control for drawing: how far
    #: the painted field then moves a particle is a fixed constant
    #: (STRAFE_FIELD_GAIN in shared/shaders/common.glsl), so there is no second
    #: multiplier interacting with this one.
    draw_power: float = 1.0

    #: Opacity of the strafe field overlay. EXACTLY zero is the off switch:
    #: the assembler does not sample the field texture at all below it.
    field_opacity: float = 0.0
    #: When False the field overlay appears only while Draw is the active tool.
    field_always_show: bool = False
    #: The brush reticle. Only ever drawn while Draw is the active tool, so
    #: this gates it within that tool rather than across tools.
    show_reticle: bool = True

    # --- interface ---
    #: The animated sensor diagram pinned beside the Project window while a
    #: sensor slider is hovered. On by default: it is the fastest way to learn
    #: what those two sliders mean. Off leaves them with the plain text tooltip
    #: every other setting gets, for anyone who already knows.
    sensor_tooltip_diagram: bool = True

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
        data = _migrate(data)
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
