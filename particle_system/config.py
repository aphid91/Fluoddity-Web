"""Simulation configuration: the typed physics/settings preset for ParticleSystem.

This is domain logic owned by the ParticleSystem module. It knows the shape of a
preset JSON (physics / settings / rule) and how to push those values into the
GLSL `config` (ConfigData struct) and `config_rule` (Fourier Rule) uniforms.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

import moderngl

from shared.gl_utils import tryset


@dataclass(frozen=True)
class SimulationConfig:
    """Typed, immutable physics preset. Mirrors the GLSL ConfigData struct + Rule."""

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

    def set_config_uniform(self, program: moderngl.Program):
        """Set all ConfigData struct uniforms on a program."""
        tryset(program, 'config.cohorts', self.cohorts)
        tryset(program, 'config.rule_seed', self.rule_seed)
        tryset(program, 'config.sensor_gain', self.sensor_gain)
        tryset(program, 'config.sensor_angle', self.sensor_angle)
        tryset(program, 'config.sensor_distance', self.sensor_distance)
        tryset(program, 'config.mutation_scale', self.mutation_scale)
        tryset(program, 'config.global_force_mult', self.global_force_mult)
        tryset(program, 'config.drag', self.drag)
        tryset(program, 'config.strafe_power', self.strafe_power)
        tryset(program, 'config.axial_force', self.axial_force)
        tryset(program, 'config.lateral_force', self.lateral_force)
        tryset(program, 'config.hazard_rate', self.hazard_rate)
        tryset(program, 'config.trail_persistence', self.trail_persistence)
        tryset(program, 'config.trail_diffusion', self.trail_diffusion)

    def set_rule_uniform(self, program: moderngl.Program):
        """Set the Rule uniform (10 FourierCenters, each frequency vec4 + amplitude vec4)."""
        for i in range(10):
            base = i * 8
            tryset(program, f'config_rule.centers[{i}].frequency', tuple(self.rule[base:base+4]))
            tryset(program, f'config_rule.centers[{i}].amplitude', tuple(self.rule[base+4:base+8]))
