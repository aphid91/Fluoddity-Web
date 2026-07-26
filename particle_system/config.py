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
    #: Which random variation the rule mutation uses. A float in [0,1] -- it is
    #: fed straight into the hash function, so fractional values are meaningful.
    mutation_seed: float
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
    # WORLD SETTINGS ON A PER-CONFIG TYPE -- a known wart.
    #
    # These are world properties (one canvas, one decay rate), but they live on
    # every SimulationConfig because that is where the preset format put them.
    # Config 0 is the one that counts: world_config() reads from it, and
    # Project.edit_world() is really edit_config(0). With several configs in the
    # buffer, slots 1+ carry trail values that are silently ignored.
    #
    # Straightening this out means moving them onto WorldConfig alone, which
    # touches the save format on both the read and write paths (~18 sites).
    # Worth doing, but as its own change rather than folded into something else.
    trail_persistence: float
    trail_diffusion: float
    # 80 floats -> 10 FourierCenters, each frequency(4) + amplitude(4)
    rule: tuple = field(default_factory=tuple)

    # Reading and writing config FILES lives in persistence.py, which handles
    # both the current format and the legacy one. This class is just the typed
    # value and how it packs into GPU memory.

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
        # misc: lateral, hazard_rate, cohorts(int bits), mutation_seed
        record['misc'] = (self.lateral_force, self.hazard_rate,
                          _int_lane(self.cohorts), self.mutation_seed)
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
