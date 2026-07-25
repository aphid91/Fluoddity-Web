"""The settings registry: one declaration per control.

THE POINT OF THIS FILE
Every tunable in the app is declared here once, with its tier, bounds, source
and help text. The settings window renders whatever this list says. Adding a
control later is a one-line entry, not a UI edit -- which is the abstraction
the tiering was asked for.

TIERS
  BASIC     shown always. The handful of knobs that most change the result.
  ADVANCED  shown only when the user asks for the full set.

The split exists because the original's undifferentiated wall of sliders was
intimidating. Basic is deliberately short.

SOURCES -- three different places a value lives, with different save semantics:
  CONFIG   per-particle, in the ConfigBuffer. Saved with the config.
  WORLD    global simulation state. Saved with the config.
  PREFS    editor state. NOT saved with the config -- loading someone's
           config must not change your brightness or canvas size.

KINDS
  SLIDER   drag to change; applies live.
  INPUT    type a value, commits on Enter. Used for DISRUPTIVE settings that
           reallocate GPU resources and reset the simulation -- a slider would
           reset on every frame of the drag.
  INT      integer slider.
  SEED     an integer with a Randomize button (mutation seed).

`implemented=False` entries are registered but greyed out: the tier layout is
recorded now so wiring them later is a one-line change, without pretending the
control works.
"""

from __future__ import annotations

from dataclasses import dataclass

BASIC = 'basic'
ADVANCED = 'advanced'

CONFIG = 'config'
WORLD = 'world'
PREFS = 'prefs'

SLIDER = 'slider'
INPUT = 'input'
INT = 'int'
SEED = 'seed'


@dataclass(frozen=True)
class Setting:
    """One control. `field` is the attribute name on its source object."""

    field: str
    label: str
    tier: str
    source: str
    kind: str = SLIDER
    lo: float = 0.0
    hi: float = 1.0
    help: str = ""
    #: False for controls whose underlying feature does not exist yet.
    implemented: bool = True
    #: True if changing this rebuilds the simulation.
    disruptive: bool = False
    #: Rendered as a group heading before this control.
    group: str = ""


# Bounds are fixed and generous rather than user-editable (adjustable slider
# ranges were explicitly cut). Where a preset value approaches a bound, the
# bound is widened -- and any slider can be ctrl+clicked to type a value
# outside its range when a config genuinely needs it.
SETTINGS = [
    # ---------------- BASIC ----------------
    # Mutation first: it is the single most consequential control.
    Setting('mutation_scale', 'Mutation Scale', BASIC, CONFIG, SLIDER, 0.0, 1.0,
            "How much each cohort's rule is randomly varied from the base rule. "
            "The most consequential control here: 0 makes every particle obey "
            "the same rule, higher values fan the population out into "
            "distinct behaviours.",
            group='Behaviour'),
    Setting('rule_seed', 'Mutation Seed', BASIC, CONFIG, SEED, 0, 9999,
            "Which random variation the mutation uses. Only has an effect when "
            "Mutation Scale is above zero. Randomize to explore alternatives "
            "at the same mutation strength."),

    Setting('sensor_angle', 'Sensor Angle', BASIC, CONFIG, SLIDER, -1.0, 1.0,
            "The angle, in half-turns, between a particle's heading and each "
            "of its two sensors. Small angles look ahead; larger angles sweep "
            "wide. Negative values swap left and right.",
            group='Sensing'),
    Setting('sensor_distance', 'Sensor Distance', BASIC, CONFIG, SLIDER, 0.0, 5.0,
            "How far ahead a particle samples the trail field. Short distances "
            "produce tight, detailed structure; long distances produce broad, "
            "smooth flows."),

    Setting('cohorts', 'Cohorts', BASIC, CONFIG, INT, 1, 32,
            "How many groups the population is divided into. Each cohort gets "
            "its own mutation of the rule, so more cohorts means more distinct "
            "behaviours coexisting.",
            group='Population'),

    Setting('brightness', 'Brightness', BASIC, PREFS, SLIDER, 0.1, 4.0,
            "Output brightness of the display. A view setting only -- it does "
            "not affect the simulation and is not saved with a config.",
            group='Display'),
    Setting('physics_steps', 'Physics Rate', BASIC, PREFS, INT, 1, 120,
            "Simulation sub-steps per rendered frame. Higher runs the "
            "simulation faster in wall-clock terms, at proportional GPU cost."),
    Setting('world_size', 'World Size', BASIC, PREFS, INPUT, 0.05, 4.0,
            "Scales the particle count and canvas resolution together. "
            "Changing this rebuilds and resets the simulation, so it is typed "
            "and committed with Enter rather than dragged.",
            disruptive=True),

    # ---------------- ADVANCED ----------------
    Setting('sensor_gain', 'Sensor Gain', ADVANCED, CONFIG, SLIDER, 0.0, 8.0,
            "How strongly particles respond to what they sense. Higher values "
            "make particles more reactive to the trails on the canvas.",
            group='Sensing'),
    Setting('sensor_distance_jitter', 'Sensor Distance Jitter', ADVANCED, CONFIG,
            SLIDER, 0.0, 1.0,
            "Random per-particle variation in sensor distance.",
            implemented=False),
    Setting('sensor_angle_jitter', 'Sensor Angle Jitter', ADVANCED, CONFIG,
            SLIDER, 0.0, 1.0,
            "Random per-particle variation in sensor angle.",
            implemented=False),

    Setting('global_force_mult', 'Global Force', ADVANCED, CONFIG, SLIDER, 0.0, 2.0,
            "Master multiplier on every force a particle applies to itself. "
            "Raise for faster, more violent motion; lower for languid drift.",
            group='Force'),
    Setting('drag', 'Drag', ADVANCED, CONFIG, SLIDER, 0.0, 1.0,
            "How much velocity carries over between steps. Low values make "
            "particles turn on a dime; high values give them momentum."),
    Setting('strafe_power', 'Strafe Power', ADVANCED, CONFIG, SLIDER, 0.0, 2.0,
            "Strength of sideways displacement that moves a particle without "
            "changing its velocity -- a sidestep rather than a push."),
    Setting('axial_force', 'Axial Force', ADVANCED, CONFIG, SLIDER, -2.0, 2.0,
            "Scales the forward/backward component of a particle's response."),
    Setting('lateral_force', 'Lateral Force', ADVANCED, CONFIG, SLIDER, -2.0, 2.0,
            "Scales the left/right component of a particle's response. "
            "Negative values invert the turn direction."),

    Setting('hazard_rate', 'Hazard Rate', ADVANCED, CONFIG, SLIDER, 0.0, 0.01,
            "Chance per step that a particle is reset to its initial state. "
            "A slow churn that keeps the population from settling.",
            group='Population'),
    Setting('boundary_conditions', 'Boundary Conditions', ADVANCED, CONFIG, INT,
            0, 3, "How particles behave at the edge of the world.",
            implemented=False),
    Setting('initial_conditions', 'Initial Conditions', ADVANCED, CONFIG, INT,
            0, 3, "How particles are arranged when the simulation resets.",
            implemented=False),
    Setting('cohort_fences', 'Cohort Fences', ADVANCED, CONFIG, SLIDER, 0.0, 1.0,
            "Confines each cohort to its own region of the world.",
            implemented=False),

    Setting('trail_persistence', 'Trail Persistence', ADVANCED, WORLD, SLIDER,
            0.5, 0.999,
            "How much of the trail field survives each step. High values leave "
            "long-lived trails; low values make them evaporate quickly. "
            "A world setting: shared by every particle on the canvas.",
            group='Trails (world)'),
    Setting('trail_diffusion', 'Trail Diffusion', ADVANCED, WORLD, SLIDER,
            0.0, 1.0,
            "How fast the trail field spreads outward. Higher values blur "
            "trails into soft washes. A world setting, shared by all particles."),

    Setting('tonemap_softness', 'Tonemap Softness', ADVANCED, PREFS, SLIDER,
            0.0, 1.0, "Softness of the output tone curve.",
            implemented=False),
    Setting('bloom', 'Bloom', ADVANCED, PREFS, SLIDER, 0.0, 1.0,
            "Glow around bright areas.", implemented=False),
    Setting('motion_blur', 'Motion Blur', ADVANCED, PREFS, SLIDER, 0.0, 1.0,
            "Blends frames together to smear motion.", implemented=False),
    Setting('canvas_aspect', 'Canvas Aspect', ADVANCED, PREFS, INPUT, 0.1, 10.0,
            "Canvas width divided by height. Reshapes the simulated world "
            "(area is preserved). Rebuilds and resets the simulation, so it is "
            "typed and committed with Enter.",
            disruptive=True, group='Display'),
]


def visible(tier_advanced: bool):
    """Settings for the current tier, in declaration order."""
    return [s for s in SETTINGS if tier_advanced or s.tier == BASIC]


def by_source(settings, source):
    return [s for s in settings if s.source == source]
