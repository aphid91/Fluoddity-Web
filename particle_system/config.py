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


#: Mode enums, mirroring the BC_*/IC_* defines in common.glsl BY VALUE. The
#: shader is the definition; these exist so host code and the settings registry
#: can name the modes instead of writing bare integers.
BC_BOUNCE, BC_WRAP, BC_RESET = 0, 1, 2
IC_GRID, IC_RANDOM, IC_CENTER, IC_RING = 0, 1, 2, 3


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
    #: Uniform pull on the whole population, one per motion channel. LINEAR
    #: -1..1 controls -- the shader expands them logarithmically via
    #: gravity_expand(). Default 0 (no pull), so configs saved before these
    #: existed behave exactly as they did.
    gravity_force: float = 0.0
    gravity_strafe: float = 0.0
    #: How particles are arranged on reset. Indexes the IC_* modes in
    #: common.glsl. Defaults to IC_CENTER, which is what this app did before
    #: the mode was selectable, so existing configs look unchanged.
    initial_conditions: int = IC_CENTER
    #: How tightly each particle is held near its own spawn point. 0 is off.
    cohort_fences: float = 0.0
    #: How strongly the particle's colour signal swings its hue, in PARTICLES
    #: view. A RENDERING setting that happens to be per-config: it never touches
    #: the simulation, so dragging it re-colours without disturbing anything.
    #: Negative values simply run the hue backwards.
    color_sensitivity: float = 0.5
    #: Colour each population flat by cohort instead of by its brain's output.
    #: Applied in entity_update (it changes what gets stored), not the renderer.
    color_by_cohort: bool = False
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
        # force2: gravity_force, gravity_strafe, initial_conditions(int bits),
        # cohort_fences
        record['force2'] = (self.gravity_force, self.gravity_strafe,
                            _int_lane(self.initial_conditions),
                            self.cohort_fences)
        # appearance: color_sensitivity, color_by_cohort(int bits), 2 spare
        record['appearance'] = (self.color_sensitivity,
                                _int_lane(int(self.color_by_cohort)),
                                0.0, 0.0)
        return record


@dataclass(frozen=True)
class WorldSettings:
    """The world half of a project: settings shared by every particle.

    One canvas, one decay rate -- these are properties of the world, not of any
    config, and there is exactly one instance per project. They used to be
    carried on every SimulationConfig because the preset format put them beside
    the physics parameters, which made config 0 secretly authoritative and left
    slots 1+ holding values that were silently ignored.

    Saved with the project. Sizing values (sqrt_world_size, config_count) are
    NOT here: they are properties of the running system, so they join at
    upload time in WorldConfig.
    """

    trail_persistence: float = 0.94
    trail_diffusion: float = 1.0
    #: What happens at the edge of the world. Indexes the BC_* modes in
    #: common.glsl. A world setting rather than a per-config one: the trail
    #: field obeys the same boundary, and there is only one trail field.
    #: Defaults to BC_WRAP, the behavior before the mode was selectable.
    boundary_conditions: int = BC_WRAP

    def for_upload(self, sqrt_world_size: float, config_count: int) -> "WorldConfig":
        return WorldConfig(
            trail_persistence=self.trail_persistence,
            trail_diffusion=self.trail_diffusion,
            boundary_conditions=self.boundary_conditions,
            sqrt_world_size=sqrt_world_size,
            config_count=config_count,
        )


@dataclass(frozen=True)
class WorldConfig:
    """WorldSettings plus runtime sizing. Mirrors the GLSL WorldData struct.

    The GPU-facing value: saved settings combined with properties of the
    running system that no save file should dictate.
    """

    trail_persistence: float
    trail_diffusion: float
    sqrt_world_size: float
    config_count: int
    boundary_conditions: int = BC_WRAP

    def to_record(self) -> np.ndarray:
        record = np.zeros((), dtype=WORLD_DATA_DTYPE)
        record['trail'] = (self.trail_persistence, self.trail_diffusion,
                           self.sqrt_world_size, _int_lane(self.config_count))
        record['bounds'] = (_int_lane(self.boundary_conditions), 0.0, 0.0, 0.0)
        return record

    def as_uniform_value(self) -> dict[str, tuple]:
        """WorldData as {member: flat tuple}, one entry per vec4 lane.

        GLSL struct uniforms are set a member at a time, so this is keyed by
        member name rather than flattened -- adding a lane to WorldData means
        adding a key here, not renumbering an offset.
        """
        record = self.to_record()
        return {name: tuple(float(v) for v in record[name])
                for name in record.dtype.names}


def pack_configs(configs: list[SimulationConfig]) -> bytes:
    """Pack a list of configs into ConfigBuffer bytes."""
    array = np.zeros(len(configs), dtype=CONFIG_DATA_DTYPE)
    for i, config in enumerate(configs):
        array[i] = config.to_record()
    return array.tobytes()
