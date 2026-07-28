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
  BOOL     checkbox. Usually the head of a `reveals_on` group.
  SEED     a Randomize button with the current value shown beside it. The seed
           is an opaque selector into rule-variation space, so it is worth
           reading but never worth typing.
  CHOICE   dropdown over `options`.
  GATED    a slider that shows a checkbox while it sits at `gate_base`, and
           hides itself again when dragged back to it. GATED_INT is the integer
           form. A `gates` tuple makes the same kind of derived checkbox for
           OTHER sliders instead of one of its own (Gravity). Both are entirely
           implemented in ui/gated_controls.py, including why -- nothing about
           them is stored, so the rest of the app is unaffected.

GROUPS become collapsible tabs in whichever window renders them. A tab whose
members are all hidden by the current tier is not rendered at all.

REVEALS_ON names a BOOL field this control hangs off: it renders, indented,
only while that checkbox is on. Effects like bloom carry three or four
parameters that are meaningless when the effect is switched off, and showing
them anyway is how a preferences panel turns into a wall. This is deliberately
a plain field reference rather than nesting, so the flat SETTINGS list stays
flat and the tier/group machinery keeps working unchanged.

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
BOOL = 'bool'
SEED = 'seed'
CHOICE = 'choice'   # dropdown over `options`
#: A slider that hides itself behind a checkbox while it sits at its base
#: value -- see the GATED SLIDERS note below.
GATED = 'gated'
GATED_INT = 'gated_int'


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
    #: Name of a BOOL field on the same source. When set, this control renders
    #: indented and only while that checkbox is on.
    reveals_on: str = ""
    #: Exponent bending a SLIDER's travel, for ranges whose interesting part is
    #: squashed against one end. The slider POSITION is what curves; the value
    #: is still the real number and is what gets stored, shown and saved:
    #:
    #:     value = lo + (hi - lo) * pos**curve
    #:
    #: 1.0 (the default) is a plain linear slider. Above 1.0 gives fine control
    #: near `lo` and coarse near `hi` -- which is what a rate like Hazard Rate
    #: wants, where everything usable lives in the bottom few percent. Only
    #: meaningful for SLIDER, and only for lo >= 0.
    curve: float = 1.0
    #: True if the slider shows the COMPLEMENT of the stored value, i.e. what
    #: the user drags is (lo + hi) - value. For a quantity whose natural name
    #: is the opposite of what the simulation stores -- Trail Stiffness is the
    #: inverse of trail diffusion -- this lets the label and the slider agree
    #: without touching the shader, the save format or any stored config. The
    #: value is inverted on the way into the widget and back on the way out, so
    #: only the display flips. Only meaningful for SLIDER.
    inverted: bool = False
    #: GATED: the value that counts as "off" and shows a checkbox. Not always
    #: zero -- Blur Samples counts renders, so its off is 1.
    gate_base: float = 0.0
    #: GATED: half-width of the off zone, along the slider's TRAVEL rather than
    #: in value -- 1e-4 means the first 0.01% of the bar.
    gate_epsilon: float = 1e-4
    #: Fields this control's checkbox reveals, for a checkbox that gates OTHER
    #: sliders and stores nothing itself. Members name it by LABEL in
    #: `reveals_on`, as they would a real BOOL field.
    gates: tuple = ()


#: Dropdown entries for the CHOICE controls. ORDER IS THE ENUM: each label's
#: index is the value stored and uploaded, so these must stay in lockstep with
#: the BC_*/IC_* defines in shared/shaders/common.glsl (mirrored in
#: particle_system/config.py). Reordering a tuple here silently changes what
#: every saved config means.
DROPDOWN_MODES = {
    'boundary_conditions': ('Bounce', 'Wrap', 'Reset'),
    'initial_conditions': ('Grid', 'Random', 'Center', 'Ring'),
}

# Bounds are fixed and generous rather than user-editable (adjustable slider
# ranges were explicitly cut). Where a preset value approaches a bound, the
# bound is widened -- and any slider can be ctrl+clicked to type a value
# outside its range when a config genuinely needs it.
#
# ORDER MATTERS: controls render in this order, grouped into the collapsible
# tab named by `group`. Tabs appear in the order their first member appears.
SETTINGS = [
    # ================= PROJECT: Mutation =================
    # First tab: the single most consequential pair of controls in the app.
    Setting('mutation_scale', 'Mutation Scale', BASIC, CONFIG, SLIDER, 0.0, 1.0,
            "How much each cohort's rule is randomly varied from the base rule. "
            "The most consequential control here: 0 makes every particle obey "
            "the same rule, higher values fan the population out into "
            "distinct behaviours.",
            group='Mutation'),
    Setting('mutation_seed', 'Mutation Seed', BASIC, CONFIG, SEED, 0.0, 1.0,
            "Which random variation the mutation uses. Only has an effect when "
            "Mutation Scale is above zero. Randomize to explore alternatives "
            "at the same mutation strength.",
            group='Mutation'),

    # ================= PROJECT: Population =================
    Setting('cohorts', 'Cohorts', BASIC, CONFIG, INT, 1, 64,
            "How many groups the population is divided into. Each cohort gets "
            "its own mutation of the rule, so more cohorts means more distinct "
            "behaviours coexisting.",
            group='Population'),
    Setting('boundary_conditions', 'Boundary Conditions', ADVANCED, WORLD,
            CHOICE, 0, 2,
            "What happens when a particle reaches the edge of the world. "
            "Bounce reflects it, Wrap carries it round to the far side, Reset "
            "returns it to its starting position.\n\n"
            "A world setting: the trails themselves wrap or stop at the edge "
            "to match, so it cannot differ between particles sharing a canvas.",
            group='Population',
            options=DROPDOWN_MODES['boundary_conditions']),
    Setting('initial_conditions', 'Initial Conditions', BASIC, CONFIG,
            CHOICE, 0, 3,
            "How particles are arranged when the simulation resets. Grid and "
            "Ring lay the cohorts out, Random scatters them, Center starts "
            "them all in a clump at the middle.\n\n"
            "Also governs where Hazard Rate respawns particles, and where "
            "Cohort Fences hold them.",
            group='Population',
            options=DROPDOWN_MODES['initial_conditions']),
    Setting('cohort_fences', 'Cohort Fences', BASIC, CONFIG, GATED, 0.0, 1.0,
            "Holds each particle near where it started, so cohorts stay "
            "distinct instead of mixing. 0 is off; higher values pull harder. "
            "Follows Initial Conditions -- the fence is around a particle's "
            "own starting point, wherever that mode put it.",
            group='Population'),
    Setting('hazard_rate', 'Hazard Rate', ADVANCED, CONFIG, GATED, 0.0, 0.01,
            "Chance per step that a particle is reset to its initial state. "
            "A slow churn that keeps the population from settling.\n\n"
            "The slider is CUBED, so most of its travel covers the very small "
            "rates where the effect is a slow churn rather than a constant "
            "teardown. This is a per-STEP probability applied ~1800 times a "
            "second at the default Physics Rate, so the usable range is far "
            "smaller than it looks: 0.001 already resets most of the "
            "population within a second.",
            group='Population', curve=3.0),

    # ================= PROJECT: Sensors =================
    Setting('sensor_angle', 'Sensor Angle', BASIC, CONFIG, SLIDER, -1.0, 1.0,
            "The angle, in half-turns, between a particle's heading and each "
            "of its two sensors. Small angles look ahead; larger angles sweep "
            "wide. Negative values swap left and right.",
            group='Sensors'),
    # NOTE: the 5.0 upper bound is mirrored in common.glsl as
    # SENSOR_DISTANCE_SPAN, which is what a Sensor Distance Jitter of 1.0
    # spans. The shader cannot read these bounds, so widening this one means
    # widening that #define too.
    Setting('sensor_distance', 'Sensor Distance', BASIC, CONFIG, SLIDER, 0.0, 5.0,
            "How far ahead a particle samples the trail field. Short distances "
            "produce tight, detailed structure; long distances produce broad, "
            "smooth flows.",
            group='Sensors'),
    Setting('sensor_angle_jitter', 'Sensor Angle Jitter', ADVANCED, CONFIG,
            GATED, 0.0, 1.0,
            "Random wobble added to Sensor Angle, redrawn every physics step. "
            "A shimmer rather than a trait: the same particle looks somewhere "
            "slightly different each step, which softens structure into "
            "something looser and more organic.\n\n"
            "Scaled so 1.0 spans the whole Sensor Angle slider, meaning the "
            "angle is then effectively random and the base value stops "
            "mattering.",
            group='Sensors'),
    Setting('sensor_distance_jitter', 'Sensor Distance Jitter', ADVANCED, CONFIG,
            GATED, 0.0, 1.0,
            "Random wobble added to Sensor Distance, redrawn every physics "
            "step -- the distance counterpart to Sensor Angle Jitter, mixing "
            "near and far sampling instead of near and wide.\n\n"
            "Scaled so 1.0 spans the whole Sensor Distance slider. Because "
            "that range is offset either way, high values push the distance "
            "NEGATIVE for some steps, which puts the sensors behind the "
            "particle with left and right swapped. That is deliberate: it is "
            "a look no other slider reaches.",
            group='Sensors'),
    Setting('sensor_gain', 'Sensor Gain', ADVANCED, CONFIG, SLIDER, 0.0, 8.0,
            "How strongly particles respond to what they sense. Higher values "
            "make particles more reactive to the trails on the canvas.",
            group='Sensors'),

    # ================= PROJECT: Forces =================
    Setting('global_force_mult', 'Global Force', ADVANCED, CONFIG, SLIDER, 0.0, 2.0,
            "Master multiplier on every force a particle applies to itself. "
            "Raise for faster, more violent motion; lower for languid drift.",
            group='Forces'),
    # Stored as `drag`, shown as Momentum: the field is how much velocity
    # CARRIES OVER, which is momentum, not how much is lost. Renaming the label
    # rather than the field keeps every saved config readable.
    Setting('drag', 'Momentum', ADVANCED, CONFIG, SLIDER, 0.0, 1.0,
            "How much velocity carries over between steps. Low values make "
            "particles turn on a dime; high values give them momentum.",
            group='Forces'),

    # Not GATED: the sliders are bipolar, so passing through zero is a normal
    # thing to drag past rather than an "off" to snap to.
    Setting('', 'Gravity', BASIC, CONFIG, BOOL,
            help="Reveals the two gravity sliders.\n\n"
                 "Not itself a saved setting -- it simply reads as on whenever "
                 "either gravity value is non-zero, so a config that uses "
                 "gravity opens with these already showing.",
            group='Forces', gates=('gravity_strafe', 'gravity_force')),
    Setting('gravity_strafe', 'Gravity (Strafe)', BASIC, CONFIG, SLIDER, -1.0, 1.0,
            "A steady pull on every particle, applied as displacement -- it "
            "slides particles without changing their velocity, so they keep "
            "steering as before while drifting. Positive pulls down.\n\n"
            "The slider is not proportional to the force: it is expanded "
            "logarithmically, so the middle of the range covers small "
            "adjustments and the ends reach far. Dead centre is exactly zero.",
            group='Forces', reveals_on='Gravity'),
    Setting('gravity_force', 'Gravity (Force)', ADVANCED, CONFIG, SLIDER, -1.0, 1.0,
            "A steady pull on every particle, applied as acceleration -- it "
            "feeds velocity, so particles build up speed and fight their own "
            "steering. Positive pulls down.\n\n"
            "Logarithmically expanded like Gravity (Strafe), with a true zero "
            "at centre.",
            group='Forces', reveals_on='Gravity'),
    # Hangs off the same gate as the sliders it redirects: on its own it does
    # nothing, so leaving it on screen with both gravities at zero would be a
    # checkbox with no observable effect.
    Setting('radial_gravity', 'Radial Gravity', ADVANCED, CONFIG, BOOL,
            help="Pull each particle along its own position vector instead of "
                 "straight down the screen.\n\n"
                 "Both gravity sliders swing together -- positive values fall "
                 "inwards towards the centre of the world, negative values "
                 "blow outwards. The strength is unchanged; only the direction "
                 "differs, so a config can be flipped between a downpour and a "
                 "collapse without retuning either slider.\n\n"
                 "A particle sitting exactly at the centre has no direction to "
                 "fall in and is left alone.",
            group='Forces', reveals_on='Gravity'),

    # ================= PROJECT: Trails =================
    Setting('trail_persistence', 'Trail Persistence', ADVANCED, WORLD, SLIDER,
            0.5, 0.999,
            "How much of the trail field survives each step. High values leave "
            "long-lived trails; low values make them evaporate quickly. "
            "A world setting: shared by every particle on the canvas.",
            group='Trails'),

    # ================= PROJECT: Appearance =================
    # Rendering, not physics -- these change how particles are DRAWN in the
    # particle view (TAB) and never touch the simulation. Saved with the config
    # nonetheless: a config's colours are part of how it looks.
    Setting('color_sensitivity', 'Color Sensitivity', ADVANCED, CONFIG, SLIDER,
            -1.0, 1.0,
            "How strongly each particle's own output swings its hue, in the "
            "particle view (TAB).\n\n"
            "At 0 every particle is the same colour. Turning it up spreads the "
            "population across the hue wheel by how each particle's rule is "
            "behaving, so mutation and cohort structure become visible. "
            "Negative simply runs the hue the other way.\n\n"
            "The signal driving this typically has a spread of ~3, so hue wraps "
            "more than once above about 0.15 and the population starts to read "
            "as static rather than structure. Low values are where the "
            "structure is.\n\n"
            "Affects rendering only -- the simulation does not change.",
            group='Appearance'),
    Setting('color_by_cohort', 'Color By Cohort', BASIC, CONFIG, BOOL,
            help="Give each cohort one flat colour instead of colouring by "
                 "what each particle is doing.\n\n"
                 "Makes populations legible as groups -- useful with Cohort "
                 "Fences, or for seeing how far cohorts have mixed. Color "
                 "Sensitivity still scales the spread between them.",
            group='Appearance'),

    # ================= PROJECT: Advanced =================
    # Last tab, on purpose: the knobs you reach for once the rest is dialled in.
    # Declared here rather than beside their relatives so the tab lands at the
    # bottom -- tabs come out in the order their first member appears.
    Setting('axial_force', 'Axial Force', ADVANCED, CONFIG, SLIDER, -2.0, 2.0,
            "Scales the forward/backward component of a particle's response.",
            group='Advanced'),
    Setting('lateral_force', 'Lateral Force', ADVANCED, CONFIG, SLIDER, -2.0, 2.0,
            "Scales the left/right component of a particle's response. "
            "Negative values invert the turn direction.",
            group='Advanced'),
    Setting('strafe_power', 'Strafe Power', ADVANCED, CONFIG, SLIDER, 0.0, 2.0,
            "Strength of sideways displacement that moves a particle without "
            "changing its velocity -- a sidestep rather than a push.",
            group='Advanced'),
    # Stored as `trail_diffusion` but shown INVERTED, as stiffness: 0.0 is full
    # diffusion, 1.0 is none. The stored field, the shader and the save format
    # all still speak diffusion -- see `inverted` on Setting.
    # gate_base is the STORED value: full diffusion (1.0) is "no stiffness", so
    # the slider reads 0.0 the moment it appears, like every other gated one.
    Setting('trail_diffusion', 'Trail Stiffness', ADVANCED, WORLD, GATED,
            0.0, 1.0,
            "How much the trail field RESISTS spreading outward. 1.0 holds "
            "trails exactly where they were laid; lower values let them bleed, "
            "and 0.0 is full-rate diffusion that blurs them into soft washes. "
            "A world setting, shared by all particles.",
            group='Advanced', inverted=True, gate_base=1.0),

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
            0.1, 5.0,
            "How hard the highlights are compressed.\n\n"
            "Low is more linear: highlights stay bright and can blow out. "
            "High is more logarithmic: it pulls faint detail up out of the "
            "dark at the cost of flattening the brightest regions.",
            group='Display'),

    # A sample count of 1 IS blur switched off, so there is no separate enable
    # flag -- see orchestrator.blur_schedule().
    Setting('motion_blur_samples', 'Motion Blur', BASIC, PREFS, GATED_INT, 1, 16,
            "Renders each frame several times across the simulation's advance "
            "and averages the result, so fast movement smears instead of "
            "stepping. The slider is how many samples to average, and costs "
            "one full render each.\n\n"
            "A TARGET, not a promise: samples must fall a whole number of "
            "physics steps apart, so the count achieved is this one when it "
            "divides Physics Rate and the nearest reachable value otherwise. "
            "Raising Physics Rate gives it more room to hit the number asked "
            "for. Overall brightness does not change either way.",
            group='Display', gate_base=1.0),

    Setting('bloom_enabled', 'Bloom', BASIC, PREFS, BOOL,
            help="Glow around bright areas.",
            group='Display'),
    Setting('bloom_threshold', 'Threshold', ADVANCED, PREFS, SLIDER, 0.0, 2.0,
            "Brightness cutoff for what glows. Lower spreads the glow to more "
            "of the image; higher confines it to the brightest regions.",
            group='Display', reveals_on='bloom_enabled'),
    Setting('bloom_intensity', 'Intensity', ADVANCED, PREFS, SLIDER, 0.0, 3.0,
            "Strength of the glow.",
            group='Display', reveals_on='bloom_enabled'),
    Setting('bloom_radius', 'Radius', ADVANCED, PREFS, SLIDER, 0.1, 3.0,
            "Spread of the blur kernel -- how far the glow reaches.",
            group='Display', reveals_on='bloom_enabled'),
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
