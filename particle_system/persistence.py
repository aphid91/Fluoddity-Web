"""Saving and loading simulation configurations.

FORMAT v8
Writes exactly what this codebase actually has: a WorldData block, a list of
ConfigData entries, and the camera. Fields the project has explicitly cut --
slider_ranges, sweeps, jitters, parameter_sweeps_enabled -- are not written,
because a save format that carries dead features teaches the next reader that
those features exist.

Multiple configs are supported from the start: the ConfigBuffer is a list, so a
save is a list. Saving "just config 0" writes a one-element list, which loads
through exactly the same path as a many-config file.

READING v7
The legacy presets in configs/ are Fluoddity v7 files. They still load: the
reader takes the fields that survived and ignores the rest. Writing v7 is not
supported -- migration is one-way on purpose.

NOT SAVED (yet): simulation state -- the entity buffer and canvas trails.
Deferred deliberately: it is multiple megabytes of binary, a poor fit for the
browser port, and a clean retrofit later since nothing about this format
precludes adding it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, replace
from pathlib import Path

from .config import SimulationConfig, WorldSettings

FORMAT_VERSION = 8

#: Subfolder of configs/ where user saves land, keeping them separate from the
#: shipped presets without needing a second top-level directory.
CUSTOM_DIRNAME = "custom"

#: Category shown for configs sitting directly in configs/.
CORE_CATEGORY = "Core"


class ConfigFormatError(Exception):
    """Raised when a file is not a config we can read."""


# ---------------------------------------------------------------------------
# The saved document
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class SavedConfig:
    """A loaded config file: the configs, the world, and optionally a camera.

    `camera` is None when the file did not record one (all v7 files, and v8
    files saved before a camera existed). Callers should leave the camera alone
    in that case rather than snapping it to a default.
    """

    configs: list[SimulationConfig]
    world: WorldSettings
    camera: dict | None = None
    notes: str = ""


def _config_to_dict(config: SimulationConfig) -> dict:
    """One ConfigData entry. Grouped to mirror the GLSL struct's vec4 lanes, so
    a reader can line the file up against common.glsl."""
    return {
        "rule": list(config.rule),
        "sensor": {
            "gain": config.sensor_gain,
            "angle": config.sensor_angle,
            "distance": config.sensor_distance,
            "mutation_scale": config.mutation_scale,
        },
        "force": {
            "global_mult": config.global_force_mult,
            "drag": config.drag,
            "strafe": config.strafe_power,
            "axial": config.axial_force,
        },
        "misc": {
            "lateral": config.lateral_force,
            "hazard_rate": config.hazard_rate,
            "cohorts": config.cohorts,
            "mutation_seed": config.mutation_seed,
        },
    }


def _config_from_dict(data: dict) -> SimulationConfig:
    sensor = data["sensor"]
    force = data["force"]
    misc = data["misc"]
    return SimulationConfig(
        cohorts=int(misc["cohorts"]),
        # LEGACY: v8 files written before the rename spell this "rule_seed".
        mutation_seed=float(misc.get("mutation_seed", misc.get("rule_seed", 0.0))),
        sensor_gain=float(sensor["gain"]),
        sensor_angle=float(sensor["angle"]),
        sensor_distance=float(sensor["distance"]),
        mutation_scale=float(sensor["mutation_scale"]),
        global_force_mult=float(force["global_mult"]),
        drag=float(force["drag"]),
        strafe_power=float(force["strafe"]),
        axial_force=float(force["axial"]),
        lateral_force=float(misc["lateral"]),
        hazard_rate=float(misc["hazard_rate"]),
        rule=tuple(float(v) for v in data["rule"]),
    )


def to_dict(configs, world: WorldSettings, camera: dict | None = None,
            notes: str = "") -> dict:
    doc = {
        "version": FORMAT_VERSION,
        "world": {
            "trail_persistence": world.trail_persistence,
            "trail_diffusion": world.trail_diffusion,
        },
        "configs": [_config_to_dict(c) for c in configs],
    }
    if camera is not None:
        doc["camera"] = camera
    if notes:
        doc["notes"] = notes
    return doc


def from_dict(data: dict) -> SavedConfig:
    """Parse either a v8 or a legacy v7 document."""
    version = data.get("version")
    if version == FORMAT_VERSION:
        return _from_v8(data)
    if isinstance(version, int) and version <= 7:
        return _from_v7(data)
    raise ConfigFormatError(
        f"unrecognized config version {version!r}; "
        f"expected {FORMAT_VERSION} or a legacy version <= 7"
    )


def _from_v8(data: dict) -> SavedConfig:
    world_raw = data["world"]
    configs = [_config_from_dict(c) for c in data["configs"]]
    if not configs:
        raise ConfigFormatError("config file contains an empty 'configs' list")
    world = WorldSettings(
        trail_persistence=float(world_raw["trail_persistence"]),
        trail_diffusion=float(world_raw["trail_diffusion"]),
    )
    return SavedConfig(configs=configs, world=world,
                       camera=data.get("camera"), notes=data.get("notes", ""))


# ===========================================================================
# LEGACY COMPATIBILITY -- DELETE THIS BLOCK TO DROP v7 SUPPORT
#
# This exists ONLY to read configs authored by the original Fluoddity while
# this rebuild is being tested against them. It is not part of the design and
# must not appear in the WebGPU port: the spec that port follows is the v8
# format alone.
#
# Everything legacy lives between these markers plus the two call sites marked
# `LEGACY`, so removing it is: delete this block, delete those calls, and
# delete the `version <= 7` branch in from_dict().
# ---------------------------------------------------------------------------

#: Field renames from v7 to current. v7 spelled the mutation seed "rule_seed"
#: and kept it under "settings"; it is now "mutation_seed" on ConfigData.
_V7_RENAMES = {'rule_seed': 'mutation_seed'}


def _v7_seed(settings: dict) -> float:
    """Read the mutation seed from a v7 `settings` block.

    v7 values are already floats in [0,1], the same convention used now, so
    this is a rename rather than a conversion.
    """
    for old, new in _V7_RENAMES.items():
        if old in settings:
            return float(settings[old])
    return float(settings.get('mutation_seed', 0.0))

# ------------------------- END LEGACY COMPATIBILITY -------------------------


def _from_v7(data: dict) -> SavedConfig:
    """Legacy Fluoddity format. Takes what survived; ignores the rest.

    Dropped on purpose: slider_ranges, sweeps, jitters,
    parameter_sweeps_enabled (all subsumed by the ConfigBuffer or cut), and
    most of `appearance` (unimplemented here).
    """
    physics = data["physics"]
    settings = data["settings"]
    config = SimulationConfig(
        cohorts=int(settings["num_cohorts"]),
        mutation_seed=_v7_seed(settings),   # LEGACY
        sensor_gain=float(physics["sensor_gain"]),
        sensor_angle=float(physics["sensor_angle"]),
        sensor_distance=float(physics["sensor_distance"]),
        mutation_scale=float(physics["mutation_scale"]),
        global_force_mult=float(physics["global_force_mult"]),
        drag=float(physics["drag"]),
        strafe_power=float(physics["strafe_power"]),
        axial_force=float(physics["axial_force"]),
        lateral_force=float(physics["lateral_force"]),
        hazard_rate=float(physics["hazard_rate"]),
        rule=tuple(float(v) for v in data["rule"]),
    )
    # v7 keeps the trail settings beside the physics parameters, but they are
    # world settings all the same -- one per file, not one per config.
    world = WorldSettings(
        trail_persistence=float(physics["trail_persistence"]),
        trail_diffusion=float(physics["trail_diffusion"]),
    )
    return SavedConfig(configs=[config], world=world, camera=None,
                       notes=data.get("notes", ""))


# ---------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------

def save(path, configs, world: WorldSettings, camera=None, notes=""):
    """Write a v8 config file, creating parent directories as needed."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    doc = to_dict(configs, world, camera, notes)
    path.write_text(json.dumps(doc, indent=2))
    return path


def load(path) -> SavedConfig:
    """Read a config file (v8 or legacy v7)."""
    path = Path(path)
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        raise ConfigFormatError(f"{path.name} is not valid JSON: {e}") from e
    if not isinstance(data, dict):
        raise ConfigFormatError(f"{path.name}: expected a JSON object")
    return from_dict(data)


def sanitize_filename(name: str) -> str:
    """Make a user-typed name safe to use as a filename.

    Strips path separators and characters Windows rejects, so a typed name can
    never escape the configs directory or produce an unopenable file.
    """
    cleaned = "".join(c for c in name.strip() if c not in '\\/:*?"<>|').strip()
    cleaned = cleaned.rstrip('.')          # Windows dislikes trailing dots
    return cleaned[:120]


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ConfigEntry:
    """One config file found on disk."""

    name: str        # filename without extension, shown in the menu
    path: Path
    category: str

    @property
    def key(self) -> tuple[str, str]:
        """Stable identity for hover tracking, independent of Path equality."""
        return (self.category, self.name)


def discover(config_dir) -> dict[str, list[ConfigEntry]]:
    """Find every config, grouped into collapsible categories.

    Files directly in configs/ are "Core"; each subfolder becomes its own
    category named after the folder. Categories are ordered with Core first,
    then alphabetically, so the shipped presets stay predictable while user
    folders accumulate below.
    """
    config_dir = Path(config_dir)
    categories: dict[str, list[ConfigEntry]] = {}
    if not config_dir.is_dir():
        return categories

    for path in sorted(config_dir.glob("*.json")):
        categories.setdefault(CORE_CATEGORY, []).append(
            ConfigEntry(name=path.stem, path=path, category=CORE_CATEGORY))

    for sub in sorted(p for p in config_dir.iterdir() if p.is_dir()):
        entries = [ConfigEntry(name=p.stem, path=p, category=sub.name)
                   for p in sorted(sub.glob("*.json"))]
        if entries:
            categories[sub.name] = entries

    ordered = {}
    if CORE_CATEGORY in categories:
        ordered[CORE_CATEGORY] = categories.pop(CORE_CATEGORY)
    for name in sorted(categories):
        ordered[name] = categories[name]
    return ordered


def custom_dir(config_dir) -> Path:
    """Where user saves go."""
    return Path(config_dir) / CUSTOM_DIRNAME
