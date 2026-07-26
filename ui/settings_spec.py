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
  SEED     a Randomize button with the current value shown beside it. The seed
           is an opaque selector into rule-variation space, so it is worth
           reading but never worth typing.
  CHOICE   dropdown over `options`.

GROUPS become collapsible tabs in whichever window renders them. A tab whose
members are all hidden by the current tier is not rendered at all.

`implemented=False` entries are registered but greyed out: the tab layout is
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
CHOICE = 'choice'   # dropdown over `options`


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
    #: Collapsible tab this control belongs to. Tabs render in the order their
    #: first member appears here, and a tab whose members are all hidden by the
    #: current tier is not rendered at all.
    group: str = ""
    #: For CHOICE controls: the dropdown entries, indexed by the stored value.
    options: tuple = ()


#: Dropdown entries for the CHOICE controls. Both features are registered but
#: not yet implemented; the option lists record the intended modes.
DROPDOWN_MODES = {
    'boundary_conditions': ('Wrap', 'Clamp', 'Bounce', 'Respawn'),
    'initial_conditions': ('Random', 'Grid', 'Ring', 'Center'),
}

# Bounds are fixed and generous rather than user-editable (adjustable slider
# ranges were explicitly cut). Where a preset value approaches a bound, the
# bound is widened -- and any slider can be ctrl+clicked to type a value
# outside its range when a config genuinely needs it.
#
# ORDER MATTERS: controls render in this order, grouped into the collapsible
# tab named by `group`. Tabs appear in the order their first member appears.
SETTINGS = [
    # ================= PROJECT: Sensors =================
    # Mutation first: it is the single most consequential control.
    Setting('mutation_scale', 'Mutation Scale', BASIC, CONFIG, SLIDER, 0.0, 1.0,
            "How much each cohort's rule is randomly varied from the base rule. "
            "The most consequential control here: 0 makes every particle obey "
            "the same rule, higher values fan the population out into "
            "distinct behaviours.",
            group='Sensors'),
    Setting('mutation_seed', 'Mutation Seed', BASIC, CONFIG, SEED, 0.0, 1.0,
            "Which random variation the mutation uses. Only has an effect when "
            "Mutation Scale is above zero. Randomize to explore alternatives "
            "at the same mutation strength.",
            group='Sensors'),
    Setting('sensor_angle', 'Sensor Angle', BASIC, CONFIG, SLIDER, -1.0, 1.0,
            "The angle, in half-turns, between a particle's heading and each "
            "of its two sensors. Small angles look ahead; larger angles sweep "
            "wide. Negative values swap left and right.",
            group='Sensors'),
    Setting('sensor_distance', 'Sensor Distance', BASIC, CONFIG, SLIDER, 0.0, 5.0,
            "How far ahead a particle samples the trail field. Short distances "
            "produce tight, detailed structure; long distances produce broad, "
            "smooth flows.",
            group='Sensors'),
    Setting('sensor_angle_jitter', 'Sensor Angle Jitter', ADVANCED, CONFIG,
            SLIDER, 0.0, 1.0,
            "Random per-particle variation in sensor angle.",
            implemented=False, group='Sensors'),
    Setting('sensor_distance_jitter', 'Sensor Distance Jitter', ADVANCED, CONFIG,
            SLIDER, 0.0, 1.0,
            "Random per-particle variation in sensor distance.",
            implemented=False, group='Sensors'),
    Setting('sensor_gain', 'Sensor Gain', ADVANCED, CONFIG, SLIDER, 0.0, 8.0,
            "How strongly particles respond to what they sense. Higher values "
            "make particles more reactive to the trails on the canvas.",
            group='Sensors'),

    # ================= PROJECT: Population =================
    Setting('cohorts', 'Cohorts', BASIC, CONFIG, INT, 1, 64,
            "How many groups the population is divided into. Each cohort gets "
            "its own mutation of the rule, so more cohorts means more distinct "
            "behaviours coexisting.",
            group='Population'),
    Setting('boundary_conditions', 'Boundary Conditions', ADVANCED, CONFIG,
            CHOICE, 0, 3,
            "What happens when a particle reaches the edge of the world.",
            implemented=False, group='Population',
            options=DROPDOWN_MODES['boundary_conditions']),
    Setting('initial_conditions', 'Initial Conditions', ADVANCED, CONFIG,
            CHOICE, 0, 3,
            "How particles are arranged when the simulation resets.",
            implemented=False, group='Population',
            options=DROPDOWN_MODES['initial_conditions']),
    Setting('cohort_fences', 'Cohort Fences', ADVANCED, CONFIG, SLIDER, 0.0, 1.0,
            "Confines each cohort to its own region of the world.",
            implemented=False, group='Population'),
    Setting('hazard_rate', 'Hazard Rate', ADVANCED, CONFIG, SLIDER, 0.0, 0.01,
            "Chance per step that a particle is reset to its initial state. "
            "A slow churn that keeps the population from settling.",
            group='Population'),

    # ================= PROJECT: Forces =================
    Setting('global_force_mult', 'Global Force', ADVANCED, CONFIG, SLIDER, 0.0, 2.0,
            "Master multiplier on every force a particle applies to itself. "
            "Raise for faster, more violent motion; lower for languid drift.",
            group='Forces'),
    Setting('drag', 'Drag', ADVANCED, CONFIG, SLIDER, 0.0, 1.0,
            "How much velocity carries over between steps. Low values make "
            "particles turn on a dime; high values give them momentum.",
            group='Forces'),
    Setting('strafe_power', 'Strafe Power', ADVANCED, CONFIG, SLIDER, 0.0, 2.0,
            "Strength of sideways displacement that moves a particle without "
            "changing its velocity -- a sidestep rather than a push.",
            group='Forces'),
    Setting('axial_force', 'Axial Force', ADVANCED, CONFIG, SLIDER, -2.0, 2.0,
            "Scales the forward/backward component of a particle's response.",
            group='Forces'),
    Setting('lateral_force', 'Lateral Force', ADVANCED, CONFIG, SLIDER, -2.0, 2.0,
            "Scales the left/right component of a particle's response. "
            "Negative values invert the turn direction.",
            group='Forces'),

    # ================= PROJECT: Trails =================
    Setting('trail_persistence', 'Trail Persistence', ADVANCED, WORLD, SLIDER,
            0.5, 0.999,
            "How much of the trail field survives each step. High values leave "
            "long-lived trails; low values make them evaporate quickly. "
            "A world setting: shared by every particle on the canvas.",
            group='Trails'),
    Setting('trail_diffusion', 'Trail Diffusion', ADVANCED, WORLD, SLIDER,
            0.0, 1.0,
            "How fast the trail field spreads outward. Higher values blur "
            "trails into soft washes. A world setting, shared by all particles.",
            group='Trails'),

    # ================= PREFERENCES: Simulation =================
    Setting('world_size', 'World Size', BASIC, PREFS, INPUT, 0.05, 4.0,
            "Scales the particle count and canvas resolution together. "
            "Changing this rebuilds and resets the simulation, so it is typed "
            "and committed with Enter rather than dragged.",
            disruptive=True, group='Simulation'),
    Setting('canvas_aspect', 'Canvas Aspect', ADVANCED, PREFS, INPUT, 0.1, 10.0,
            "Canvas width divided by height. Reshapes the simulated world "
            "(area is preserved). Rebuilds and resets the simulation, so it is "
            "typed and committed with Enter.",
            disruptive=True, group='Simulation'),
    Setting('physics_steps', 'Physics Rate', BASIC, PREFS, INT, 1, 120,
            "Simulation sub-steps per rendered frame. Higher runs the "
            "simulation faster in wall-clock terms, at proportional GPU cost.",
            group='Simulation'),

    # ================= PREFERENCES: Display =================
    Setting('brightness', 'Brightness', BASIC, PREFS, SLIDER, 0.1, 4.0,
            "Output brightness of the display. A view setting only -- it does "
            "not affect the simulation and is not saved with a config.",
            group='Display'),
    Setting('tonemap_softness', 'Tonemap Softness', ADVANCED, PREFS, SLIDER,
            0.0, 1.0, "Softness of the output tone curve.",
            implemented=False, group='Display'),
    Setting('motion_blur', 'Motion Blur', ADVANCED, PREFS, SLIDER, 0.0, 1.0,
            "Blends frames together to smear motion.",
            implemented=False, group='Display'),
    Setting('bloom', 'Bloom', ADVANCED, PREFS, SLIDER, 0.0, 1.0,
            "Glow around bright areas.",
            implemented=False, group='Display'),
]


def visible(tier_advanced: bool):
    """Settings for the current tier, in declaration order."""
    return [s for s in SETTINGS if tier_advanced or s.tier == BASIC]


def by_source(settings, source):
    return [s for s in settings if s.source == source]


def grouped(tier_advanced: bool, sources):
    """Visible settings for `sources`, as [(group, [settings]), ...].

    Tabs come out in the order their first member is declared. A group with no
    visible members is omitted entirely rather than rendered empty -- that is
    how a tab disappears in Basic mode when all its controls are Advanced.
    """
    wanted = set(sources)
    order = []
    buckets = {}
    for setting in visible(tier_advanced):
        if setting.source not in wanted:
            continue
        if setting.group not in buckets:
            buckets[setting.group] = []
            order.append(setting.group)
        buckets[setting.group].append(setting)
    return [(name, buckets[name]) for name in order]
