"""Simulation configuration: the typed presets that drive the simulation.

Two distinct things live here, and the split is deliberate:

  - SimulationConfig -> packs into the GLSL `ConfigData` struct, which lives in
    the ConfigBuffer SSBO. These are PER-PARTICLE-POPULATION settings: each
    entity picks one via its own config_index. Behavior (the Fourier `Rule`)
    and physics parameters are unified here, because they are the same kind of
    thing and separating them is what made the reference sprawl.

  - WorldConfig -> packs into the GLSL `WorldData` struct, set as a uniform.
    These are settings that would be meaningless to vary between two particles
    sharing a canvas: trail decay, world scale.

Both pack via numpy dtypes parsed out of common.glsl (see layout.py), so the
byte layout can never drift from the shader's view of it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

import numpy as np

from .layout import CONFIG_DATA_DTYPE, WORLD_DATA_DTYPE


def _int_lane(value: int) -> np.float32:
    """Store an int in a float lane (mirrors GLSL intBitsToFloat)."""
    return np.frombuffer(np.int32(value).tobytes(), dtype=np.float32)[0]


@dataclass(frozen=True)
class SimulationConfig:
    """Typed, immutable preset. Mirrors the GLSL ConfigData struct."""

    # settings
    cohorts: int
    rule_seed: int
    # physics
    sensor_gain: float
    sensor_angle: float
    sensor_distance: float
    mutation_scale: float
    global_force_mult: float
    drag: float
    strafe_power: float
    axial_force: float
    lateral_force: float
    hazard_rate: float
    # world settings -- kept on the dataclass because the preset JSON carries
    # them, but they pack into WorldData, not ConfigData. See world_config().
    trail_persistence: float
    trail_diffusion: float
    # 80 floats -> 10 FourierCenters, each frequency(4) + amplitude(4)
    rule: tuple = field(default_factory=tuple)

    @classmethod
    def load(cls, path: str) -> "SimulationConfig":
        """Load a preset JSON file into a SimulationConfig."""
        with open(path, 'r') as f:
            data = json.load(f)

        physics = data['physics']
        settings = data['settings']

        return cls(
            cohorts=settings['num_cohorts'],
            rule_seed=settings['rule_seed'],
            sensor_gain=physics['sensor_gain'],
            sensor_angle=physics['sensor_angle'],
            sensor_distance=physics['sensor_distance'],
            mutation_scale=physics['mutation_scale'],
            global_force_mult=physics['global_force_mult'],
            drag=physics['drag'],
            strafe_power=physics['strafe_power'],
            axial_force=physics['axial_force'],
            lateral_force=physics['lateral_force'],
            hazard_rate=physics['hazard_rate'],
            trail_persistence=physics['trail_persistence'],
            trail_diffusion=physics['trail_diffusion'],
            rule=tuple(data['rule']),
        )

    def to_record(self) -> np.ndarray:
        """Pack into a single ConfigData record (a 0-d structured array).

        Lane assignments must match the accessors in common.glsl. The dtype
        itself comes from parsing that file, so only the lane *ordering* is
        stated here.
        """
        record = np.zeros((), dtype=CONFIG_DATA_DTYPE)

        # Rule: 80 floats -> centers[10].{frequency,amplitude}
        rule = np.asarray(self.rule, dtype=np.float32)
        if rule.size != 80:
            raise ValueError(
                f'rule must be 80 floats (10 centers x 8), got {rule.size}'
            )
        pairs = rule.reshape(10, 2, 4)
        record['rule']['centers']['frequency'] = pairs[:, 0, :]
        record['rule']['centers']['amplitude'] = pairs[:, 1, :]

        # sensor: gain, angle, distance, mutation_scale
        record['sensor'] = (self.sensor_gain, self.sensor_angle,
                            self.sensor_distance, self.mutation_scale)
        # force: global_mult, drag, strafe, axial
        record['force'] = (self.global_force_mult, self.drag,
                           self.strafe_power, self.axial_force)
        # misc: lateral, hazard_rate, cohorts(int bits), reserved
        record['misc'] = (self.lateral_force, self.hazard_rate,
                          _int_lane(self.cohorts), 0.0)
        return record

    def world_config(self, sqrt_world_size: float, config_count: int) -> "WorldConfig":
        """The WorldData half of this preset.

        trail_persistence/diffusion come from the preset; the sizing values are
        supplied by the caller because they are properties of the running
        system, not of the saved config.
        """
        return WorldConfig(
            trail_persistence=self.trail_persistence,
            trail_diffusion=self.trail_diffusion,
            sqrt_world_size=sqrt_world_size,
            config_count=config_count,
        )


@dataclass(frozen=True)
class WorldConfig:
    """Typed, immutable world settings. Mirrors the GLSL WorldData struct."""

    trail_persistence: float
    trail_diffusion: float
    sqrt_world_size: float
    config_count: int

    def to_record(self) -> np.ndarray:
        record = np.zeros((), dtype=WORLD_DATA_DTYPE)
        record['trail'] = (self.trail_persistence, self.trail_diffusion,
                           self.sqrt_world_size, _int_lane(self.config_count))
        return record

    def as_uniform_value(self) -> tuple:
        """WorldData as a flat tuple, for setting the `world.trail` uniform."""
        return tuple(float(v) for v in self.to_record()['trail'])


def pack_configs(configs: list[SimulationConfig]) -> bytes:
    """Pack a list of configs into ConfigBuffer bytes."""
    array = np.zeros(len(configs), dtype=CONFIG_DATA_DTYPE)
    for i, config in enumerate(configs):
        array[i] = config.to_record()
    return array.tobytes()
