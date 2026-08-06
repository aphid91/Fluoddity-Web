/**
 * The settings registry: one declaration per control.
 * A direct port of `ui/settings_spec.py` (35 entries, 447 lines).
 *
 * ## The point of this file
 *
 * Every tunable in the app is declared here once, with its tier, bounds, source
 * and help text. The settings panel renders whatever this list says. **Adding a
 * control is a one-line entry, not a UI edit** -- that is the abstraction the
 * desktop's tiering was asked for, and it is what makes Step 10's real UI a
 * rendering change rather than a rewiring.
 *
 * ## Tiers
 *
 *   BASIC     shown always. The handful of knobs that most change the result.
 *   ADVANCED  shown only when the user asks for the full set.
 *
 * The split exists because an undifferentiated wall of sliders was
 * intimidating. Basic is deliberately short.
 *
 * ## Sources -- three places a value lives, with different save semantics
 *
 *   CONFIG   per-particle, in the ConfigBuffer. SAVED with the config.
 *   WORLD    global simulation state. Saved with the config.
 *   PREFS    editor state. NOT saved -- loading someone's config must not
 *            change your brightness or canvas size.
 *
 * ## Kinds
 *
 *   SLIDER     drag to change; applies live.
 *   INPUT      type a value, commits on Enter. For DISRUPTIVE settings that
 *              reallocate GPU resources and reset the simulation.
 *   INT        integer slider.
 *   BOOL       checkbox. Usually the head of a `revealsOn` group.
 *   SEED       a Randomize button with the current value shown beside it.
 *   CHOICE     dropdown over `options`.
 *   GATED      a slider that shows a checkbox while it sits at `gateBase`.
 *              GATED_INT is the integer form. **Step 10 implements the gating**
 *              (`ui/gated_controls.py`); Step 7's thin UI renders these as
 *              plain sliders, which is the correct degradation -- nothing about
 *              a gate is stored, so the value behaves identically either way.
 *
 * ## What Step 7 uses and what it does not
 *
 * The thin UI reads `kind`, `lo`, `hi`, `options`, `label` and `source`. It
 * ignores `group`, `tier`, `revealsOn`, `gates`, `curve` and `inverted` -- all
 * of which are Step 10's, and all of which are carried here verbatim so that
 * step is a UI change with no registry archaeology. `help` is carried for the
 * same reason; Step 7 hangs it off the control's `title` attribute, which is
 * free and better than dropping it.
 *
 * `curve` and `inverted` are the two that would be TEMPTING to drop, and must
 * not be: they change what the stored value is for a given slider position, so
 * a Step 10 that re-derived them would have to re-derive them CORRECTLY or
 * every affected config silently changes meaning.
 */

/** @see `settings_spec.py:59-60` */
export const BASIC = 'basic';
export const ADVANCED = 'advanced';
export type Tier = typeof BASIC | typeof ADVANCED;

/** @see `settings_spec.py:62-64` */
export const CONFIG = 'config';
export const WORLD = 'world';
export const PREFS = 'prefs';
export type Source = typeof CONFIG | typeof WORLD | typeof PREFS;

/** @see `settings_spec.py:66-75` */
export const SLIDER = 'slider';
export const INPUT = 'input';
export const INT = 'int';
export const BOOL = 'bool';
export const SEED = 'seed';
export const CHOICE = 'choice';
export const GATED = 'gated';
export const GATED_INT = 'gated_int';
export type Kind =
  | typeof SLIDER
  | typeof INPUT
  | typeof INT
  | typeof BOOL
  | typeof SEED
  | typeof CHOICE
  | typeof GATED
  | typeof GATED_INT;

/** One control. `field` is the property name on its source object. */
export interface Setting {
  readonly field: string;
  readonly label: string;
  readonly tier: Tier;
  readonly source: Source;
  readonly kind: Kind;
  readonly lo: number;
  readonly hi: number;
  readonly help: string;
  /** False for controls whose underlying feature does not exist yet. */
  readonly implemented: boolean;
  /** True if changing this rebuilds the simulation. */
  readonly disruptive: boolean;
  /** Collapsible group this control belongs to. */
  readonly group: string;
  /** For CHOICE controls: the dropdown entries, indexed by the stored value. */
  readonly options: readonly string[];
  /**
   * Name of a BOOL field on the same source. When set, this control renders
   * indented and only while that checkbox is on. Step 10.
   */
  readonly revealsOn: string;
  /**
   * Exponent bending a SLIDER's travel. The slider POSITION curves; the value
   * is still the real number and is what gets stored, shown and saved:
   *
   *     value = lo + (hi - lo) * pos**curve
   *
   * 1.0 is a plain linear slider. Above 1.0 gives fine control near `lo`.
   * Step 10 (`ui/curved_slider.py`).
   */
  readonly curve: number;
  /**
   * True if the slider shows the COMPLEMENT of the stored value, i.e. what the
   * user drags is `(lo + hi) - value`. Trail Stiffness is the inverse of trail
   * diffusion; this lets the label and the slider agree without touching the
   * shader, the save format or any stored config. Step 10.
   */
  readonly inverted: boolean;
  /** GATED: the value that counts as "off". Not always zero. */
  readonly gateBase: number;
  /** GATED: half-width of the off zone, along the slider's TRAVEL. */
  readonly gateEpsilon: number;
  /** Fields this control's checkbox reveals, storing nothing itself. */
  readonly gates: readonly string[];
  /**
   * Whether this entry renders as a control in a panel section.
   *
   * False means the field is real -- packed, saved, undoable -- but its widget
   * lives somewhere the registry does not build: today that is Mutation Scale,
   * which is a wide slider in `ui/mutationOverlay.ts` rather than a row in a
   * folder. `visible()` filters these out, so `grouped()` never sees them and no
   * section has to know they exist.
   *
   * **Not the same as `implemented: false`**, which renders the control DISABLED
   * to stage a layout ahead of its feature. This one renders nothing at all,
   * because something else already renders it better.
   */
  readonly panel: boolean;
}

/** Defaults for everything a declaration does not state. */
const SETTING_DEFAULTS = {
  kind: SLIDER,
  lo: 0.0,
  hi: 1.0,
  help: '',
  implemented: true,
  disruptive: false,
  group: '',
  options: [] as readonly string[],
  revealsOn: '',
  curve: 1.0,
  inverted: false,
  gateBase: 0.0,
  gateEpsilon: 1e-4,
  gates: [] as readonly string[],
  panel: true,
} as const;

/** The four fields every entry must state, plus whatever it overrides. */
type SettingInit = Pick<Setting, 'field' | 'label' | 'tier' | 'source'> &
  Partial<Setting>;

function setting(init: SettingInit): Setting {
  return { ...SETTING_DEFAULTS, ...init };
}

/**
 * Dropdown entries for the CHOICE controls.
 *
 * **ORDER IS THE ENUM**: each label's index is the value stored and uploaded,
 * so these must stay in lockstep with the `BC_*`/`IC_*` constants in
 * `common.wgsl` (mirrored in `particleSystem/config.ts`). Reordering a tuple
 * here silently changes what every saved config means -- which is why
 * `settingsSpec.test.ts` asserts them against `BC` and `IC` rather than trusting
 * the comment.
 */
export const DROPDOWN_MODES = {
  boundaryConditions: ['Bounce', 'Wrap', 'Reset'],
  initialConditions: ['Grid', 'Random', 'Center', 'Ring'],
} as const;

// Bounds are fixed and generous rather than user-editable (adjustable slider
// ranges were explicitly cut on the desktop). Where a preset value approaches a
// bound, the bound is widened.
//
// ORDER MATTERS: controls render in this order, grouped into the collapsible
// group named by `group`. Groups appear in the order their first member appears.
export const SETTINGS: readonly Setting[] = [
  // ================= PROJECT: Mutation =================
  //
  // **NOT IN THE PANEL, deliberately.** Mutation Scale is the single most
  // consequential control in the app, and it used to be the first entry here for
  // exactly that reason -- which still buried it in a folder in a 320px column.
  // It now lives in `ui/mutationOverlay.ts`, as a wide slider centred above the
  // canvas with the Reroll Mutations button beside it.
  //
  // The ENTRY stays, because the overlay reads its bounds, label and help text
  // from here rather than restating them -- `mutationSetting()` is the lookup.
  // `panel: false` is what keeps it out of `grouped()`, and therefore out of the
  // Project section, without making the registry lie about the field existing.
  //
  setting({
    field: 'mutationScale',
    label: 'Mutation Scale',
    tier: BASIC,
    source: CONFIG,
    kind: SLIDER,
    lo: 0.0,
    hi: 0.6,
    help:
      "How much each cohort's rule is randomly varied from the base rule. The " +
      'most consequential control here: 0 makes every particle obey the same ' +
      'rule, higher values fan the population out into distinct behaviours.',
    group: 'Mutation',
    panel: false,
  }),
  // The SEED entry STAYS, and it is not vestigial: `randomizeSeed`
  // (`settingsCommands.ts:118-127`) finds the field to randomize by looking up
  // `kind === SEED` here, precisely so the field name lives in one place. Delete
  // this and Reroll Mutations silently stops doing anything.
  //
  // What went away is only its WIDGET -- a read-only readout beside a Randomize
  // button. The readout was never worth a row (an opaque selector is only ever
  // worth reading, never typing), and the button now lives in the overlay
  // sending that same command.
  setting({
    field: 'mutationSeed',
    label: 'Mutation Seed',
    tier: BASIC,
    source: CONFIG,
    kind: SEED,
    lo: 0.0,
    hi: 1.0,
    help:
      'Which random variation the mutation uses. Only has an effect when ' +
      'Mutation Scale is above zero. Reroll to explore alternatives at the ' +
      'same mutation strength.',
    group: 'Mutation',
    panel: false,
  }),

  // ================= PROJECT: Population =================
  setting({
    field: 'cohorts',
    label: 'Cohorts',
    tier: BASIC,
    source: CONFIG,
    kind: INT,
    lo: 1,
    hi: 64,
    help:
      'How many groups the population is divided into. Each cohort gets its ' +
      'own mutation of the rule, so more cohorts means more distinct ' +
      'behaviours coexisting.',
    group: 'Population',
  }),
  setting({
    field: 'boundaryConditions',
    label: 'Boundary Conditions',
    tier: ADVANCED,
    source: WORLD,
    kind: CHOICE,
    lo: 0,
    hi: 2,
    help:
      'What happens when a particle reaches the edge of the world. Bounce ' +
      'reflects it, Wrap carries it round to the far side, Reset returns it to ' +
      'its starting position.\n\nA world setting: the trails themselves wrap or ' +
      'stop at the edge to match, so it cannot differ between particles sharing ' +
      'a canvas.',
    group: 'Population',
    options: DROPDOWN_MODES.boundaryConditions,
  }),
  setting({
    field: 'initialConditions',
    label: 'Initial Conditions',
    tier: BASIC,
    source: CONFIG,
    kind: CHOICE,
    lo: 0,
    hi: 3,
    help:
      'How particles are arranged when the simulation resets. Grid and Ring lay ' +
      'the cohorts out, Random scatters them, Center starts them all in a clump ' +
      'at the middle.\n\nAlso governs where Hazard Rate respawns particles, and ' +
      'where Cohort Fences hold them.',
    group: 'Population',
    options: DROPDOWN_MODES.initialConditions,
  }),
  setting({
    field: 'cohortFences',
    label: 'Cohort Fences',
    tier: BASIC,
    source: CONFIG,
    kind: GATED,
    lo: 0.0,
    hi: 1.0,
    help:
      'Holds each particle near where it started, so cohorts stay distinct ' +
      'instead of mixing. 0 is off; higher values pull harder. Follows Initial ' +
      "Conditions -- the fence is around a particle's own starting point, " +
      'wherever that mode put it.',
    group: 'Population',
  }),
  setting({
    field: 'hazardRate',
    label: 'Hazard Rate',
    tier: ADVANCED,
    source: CONFIG,
    kind: GATED,
    lo: 0.0,
    hi: 0.01,
    help:
      'Chance per step that a particle is reset to its initial state. A slow ' +
      'churn that keeps the population from settling.\n\nThe slider is CUBED, so ' +
      'most of its travel covers the very small rates where the effect is a slow ' +
      'churn rather than a constant teardown. This is a per-STEP probability ' +
      'applied ~1800 times a second at the default Physics Rate, so the usable ' +
      'range is far smaller than it looks: 0.001 already resets most of the ' +
      'population within a second.',
    group: 'Population',
    curve: 3.0,
  }),

  // ================= PROJECT: Sensors =================
  setting({
    field: 'sensorAngle',
    label: 'Sensor Angle',
    tier: BASIC,
    source: CONFIG,
    kind: SLIDER,
    lo: -1.0,
    hi: 1.0,
    help:
      "The angle, in half-turns, between a particle's heading and each of its " +
      'two sensors. Small angles look ahead; larger angles sweep wide. Negative ' +
      'values swap left and right.',
    group: 'Sensors',
  }),
  setting({
    field: 'sensorAngleJitter',
    label: 'Sensor Angle Jitter',
    tier: ADVANCED,
    source: CONFIG,
    kind: GATED,
    lo: 0.0,
    hi: 1.0,
    help:
      'Random wobble added to Sensor Angle, redrawn every physics step. A ' +
      'shimmer rather than a trait: the same particle looks somewhere slightly ' +
      'different each step, which softens structure into something looser and ' +
      'more organic.\n\nScaled so 1.0 spans the whole Sensor Angle slider, ' +
      'meaning the angle is then effectively random and the base value stops ' +
      'mattering.',
    group: 'Sensors',
  }),
  // NOTE: the 5.0 upper bound is mirrored in common.wgsl as
  // SENSOR_DISTANCE_SPAN, which is what a Sensor Distance Jitter of 1.0 spans.
  // The shader cannot read these bounds, so widening this one means widening
  // that constant too.
  setting({
    field: 'sensorDistance',
    label: 'Sensor Distance',
    tier: BASIC,
    source: CONFIG,
    kind: SLIDER,
    lo: 0.0,
    hi: 5.0,
    help:
      'How far ahead a particle samples the trail field. Short distances produce ' +
      'tight, detailed structure; long distances produce broad, smooth flows.',
    group: 'Sensors',
  }),
  setting({
    field: 'sensorDistanceJitter',
    label: 'Sensor Distance Jitter',
    tier: ADVANCED,
    source: CONFIG,
    kind: GATED,
    lo: 0.0,
    hi: 1.0,
    help:
      'Random wobble added to Sensor Distance, redrawn every physics step -- the ' +
      'distance counterpart to Sensor Angle Jitter, mixing near and far sampling ' +
      'instead of near and wide.\n\nScaled so 1.0 spans the whole Sensor Distance ' +
      'slider. Because that range is offset either way, high values push the ' +
      'distance NEGATIVE for some steps, which puts the sensors behind the ' +
      'particle with left and right swapped. That is deliberate: it is a look no ' +
      'other slider reaches.',
    group: 'Sensors',
  }),
  setting({
    field: 'sensorGain',
    label: 'Sensor Gain',
    tier: ADVANCED,
    source: CONFIG,
    kind: SLIDER,
    lo: 0.0,
    hi: 8.0,
    help:
      'How strongly particles respond to what they sense. Higher values make ' +
      'particles more reactive to the trails on the canvas.',
    group: 'Sensors',
  }),

  // ================= PROJECT: Forces =================
  setting({
    field: 'globalForceMult',
    label: 'Global Force',
    tier: ADVANCED,
    source: CONFIG,
    kind: SLIDER,
    lo: 0.0,
    hi: 1.0,
    help:
      'Master multiplier on every force a particle applies to itself. Raise for ' +
      'faster, more violent motion; lower for languid drift.',
    group: 'Forces',
  }),
  // Stored as `drag`, shown as Momentum: the field is how much velocity CARRIES
  // OVER, which is momentum, not how much is lost. Renaming the label rather
  // than the field keeps every saved config readable.
  setting({
    field: 'drag',
    label: 'Momentum',
    tier: ADVANCED,
    source: CONFIG,
    kind: SLIDER,
    lo: 0.0,
    hi: 1.0,
    help:
      'How much velocity carries over between steps. Low values make particles ' +
      'turn on a dime; high values give them momentum.',
    group: 'Forces',
  }),

  // Not GATED: the sliders are bipolar, so passing through zero is a normal
  // thing to drag past rather than an "off" to snap to.
  setting({
    field: '',
    label: 'Gravity',
    tier: BASIC,
    source: CONFIG,
    kind: BOOL,
    help:
      'Reveals the two gravity sliders.\n\nNot itself a saved setting -- it ' +
      'simply reads as on whenever either gravity value is non-zero, so a config ' +
      'that uses gravity opens with these already showing.',
    group: 'Forces',
    gates: ['gravityStrafe', 'gravityForce'],
  }),
  setting({
    field: 'gravityStrafe',
    label: 'Gravity (Strafe)',
    tier: BASIC,
    source: CONFIG,
    kind: SLIDER,
    lo: -1.0,
    hi: 1.0,
    help:
      'A steady pull on every particle, applied as displacement -- it slides ' +
      'particles without changing their velocity, so they keep steering as ' +
      'before while drifting. Positive pulls down.\n\nThe slider is not ' +
      'proportional to the force: it is expanded logarithmically, so the middle ' +
      'of the range covers small adjustments and the ends reach far. Dead centre ' +
      'is exactly zero.',
    group: 'Forces',
    revealsOn: 'Gravity',
  }),
  setting({
    field: 'gravityForce',
    label: 'Gravity (Force)',
    tier: ADVANCED,
    source: CONFIG,
    kind: SLIDER,
    lo: -1.0,
    hi: 1.0,
    help:
      'A steady pull on every particle, applied as acceleration -- it feeds ' +
      'velocity, so particles build up speed and fight their own steering. ' +
      'Positive pulls down.\n\nLogarithmically expanded like Gravity (Strafe), ' +
      'with a true zero at centre.',
    group: 'Forces',
    revealsOn: 'Gravity',
  }),
  // Hangs off the same gate as the sliders it redirects: on its own it does
  // nothing, so leaving it on screen with both gravities at zero would be a
  // checkbox with no observable effect.
  setting({
    field: 'radialGravity',
    label: 'Radial Gravity',
    tier: ADVANCED,
    source: CONFIG,
    kind: BOOL,
    help:
      'Pull each particle along its own position vector instead of straight down ' +
      'the screen.\n\nBoth gravity sliders swing together -- positive values fall ' +
      'inwards towards the centre of the world, negative values blow outwards. ' +
      'The strength is unchanged; only the direction differs, so a config can be ' +
      'flipped between a downpour and a collapse without retuning either ' +
      'slider.\n\nA particle sitting exactly at the centre has no direction to ' +
      'fall in and is left alone.',
    group: 'Forces',
    revealsOn: 'Gravity',
  }),

  // ================= PROJECT: Trails =================
  setting({
    field: 'trailPersistence',
    label: 'Trail Persistence',
    tier: ADVANCED,
    source: WORLD,
    kind: SLIDER,
    lo: 0.5,
    hi: 0.999,
    help:
      'How much of the trail field survives each step. High values leave ' +
      'long-lived trails; low values make them evaporate quickly. A world ' +
      'setting: shared by every particle on the canvas.',
    group: 'Trails',
  }),

  // ================= PROJECT: Appearance =================
  // Rendering, not physics -- these change how particles are DRAWN in the
  // particle view and never touch the simulation. Saved with the config
  // nonetheless: a config's colours are part of how it looks.
  setting({
    field: 'colorSensitivity',
    label: 'Color Sensitivity',
    tier: ADVANCED,
    source: CONFIG,
    kind: SLIDER,
    lo: -1.0,
    hi: 1.0,
    help:
      "How strongly each particle's own output swings its hue, in the particle " +
      'view.\n\nAt 0 every particle is the same colour. Turning it up spreads the ' +
      'population across the hue wheel by how each particle\'s rule is behaving, ' +
      'so mutation and cohort structure become visible. Negative simply runs the ' +
      'hue the other way.\n\nThe signal driving this typically has a spread of ~3, ' +
      'so hue wraps more than once above about 0.15 and the population starts to ' +
      'read as static rather than structure. Low values are where the structure ' +
      'is.\n\nAffects rendering only -- the simulation does not change.',
    group: 'Appearance',
  }),
  setting({
    field: 'colorByCohort',
    label: 'Color By Cohort',
    tier: BASIC,
    source: CONFIG,
    kind: BOOL,
    help:
      'Give each cohort one flat colour instead of colouring by what each ' +
      'particle is doing.\n\nMakes populations legible as groups -- useful with ' +
      'Cohort Fences, or for seeing how far cohorts have mixed. Color Sensitivity ' +
      'still scales the spread between them.',
    group: 'Appearance',
  }),

  // ================= PROJECT: Advanced =================
  // Last group, on purpose: the knobs you reach for once the rest is dialled in.
  // Declared here rather than beside their relatives so the group lands at the
  // bottom -- groups come out in the order their first member appears.
  setting({
    field: 'axialForce',
    label: 'Axial Force',
    tier: ADVANCED,
    source: CONFIG,
    kind: SLIDER,
    lo: -2.0,
    hi: 2.0,
    help: "Scales the forward/backward component of a particle's response.",
    group: 'Advanced',
  }),
  setting({
    field: 'lateralForce',
    label: 'Lateral Force',
    tier: ADVANCED,
    source: CONFIG,
    kind: SLIDER,
    lo: -2.0,
    hi: 2.0,
    help:
      "Scales the left/right component of a particle's response. Negative values " +
      'invert the turn direction.',
    group: 'Advanced',
  }),
  setting({
    field: 'strafePower',
    label: 'Strafe Power',
    tier: ADVANCED,
    source: CONFIG,
    kind: SLIDER,
    lo: 0.0,
    hi: 0.5,
    help:
      'Strength of sideways displacement that moves a particle without changing ' +
      'its velocity -- a sidestep rather than a push.',
    group: 'Advanced',
  }),
  // Stored as `trailDiffusion` but shown INVERTED, as stiffness: 0.0 is full
  // diffusion, 1.0 is none. The stored field, the shader and the save format all
  // still speak diffusion -- see `inverted`. gateBase is the STORED value: full
  // diffusion (1.0) is "no stiffness", so the slider reads 0.0 the moment it
  // appears, like every other gated one.
  setting({
    field: 'trailDiffusion',
    label: 'Trail Stiffness',
    tier: ADVANCED,
    source: WORLD,
    kind: GATED,
    lo: 0.0,
    hi: 1.0,
    help:
      'How much the trail field RESISTS spreading outward. 1.0 holds trails ' +
      'exactly where they were laid; lower values let them bleed, and 0.0 is ' +
      'full-rate diffusion that blurs them into soft washes. A world setting, ' +
      'shared by all particles.',
    group: 'Advanced',
    inverted: true,
    gateBase: 1.0,
  }),

  // ================= PREFERENCES: Simulation =================
  setting({
    field: 'worldSize',
    label: 'World Size',
    tier: BASIC,
    source: PREFS,
    kind: INPUT,
    lo: 0.05,
    hi: 4.0,
    help:
      'Scales the particle count and canvas resolution together. Changing this ' +
      'rebuilds and resets the simulation, so it is typed and committed with ' +
      'Enter rather than dragged.',
    disruptive: true,
    group: 'Simulation',
  }),
  setting({
    field: 'canvasAspect',
    label: 'Canvas Aspect',
    tier: ADVANCED,
    source: PREFS,
    kind: INPUT,
    lo: 0.1,
    hi: 10.0,
    help:
      'Canvas width divided by height. Reshapes the simulated world (area is ' +
      'preserved). Rebuilds and resets the simulation, so it is typed and ' +
      'committed with Enter.',
    disruptive: true,
    group: 'Simulation',
  }),
  setting({
    field: 'physicsSteps',
    label: 'Physics Rate',
    tier: BASIC,
    source: PREFS,
    kind: INT,
    lo: 1,
    hi: 60,
    help:
      'Simulation sub-steps per rendered frame. Higher runs the simulation ' +
      'faster in wall-clock terms, at proportional GPU cost.',
    group: 'Simulation',
  }),

  // ================= PREFERENCES: Display =================
  setting({
    field: 'brightness',
    label: 'Brightness',
    tier: BASIC,
    source: PREFS,
    kind: SLIDER,
    lo: 0.1,
    hi: 4.0,
    help:
      'Output brightness of the display. A view setting only -- it does not ' +
      'affect the simulation and is not saved with a config.',
    group: 'Display',
  }),
  setting({
    field: 'tonemapSoftness',
    label: 'Tonemap Softness',
    tier: ADVANCED,
    source: PREFS,
    kind: SLIDER,
    lo: 0.1,
    hi: 5.0,
    help:
      'How hard the highlights are compressed.\n\nLow is more linear: highlights ' +
      'stay bright and can blow out. High is more logarithmic: it pulls faint ' +
      'detail up out of the dark at the cost of flattening the brightest regions.',
    group: 'Display',
  }),

  // A sample count of 1 IS blur switched off, so there is no separate enable
  // flag -- see `camera/blurSchedule.ts`.
  setting({
    field: 'motionBlurSamples',
    label: 'Motion Blur',
    tier: BASIC,
    source: PREFS,
    kind: GATED_INT,
    lo: 1,
    hi: 16,
    help:
      'Renders each frame several times across the simulation\'s advance and ' +
      'averages the result, so fast movement smears instead of stepping. The ' +
      'slider is how many samples to average, and costs one full render ' +
      'each.\n\nA TARGET, not a promise: samples must fall a whole number of ' +
      'physics steps apart, so the count achieved is this one when it divides ' +
      'Physics Rate and the nearest reachable value otherwise. Raising Physics ' +
      'Rate gives it more room to hit the number asked for. Overall brightness ' +
      'does not change either way.',
    group: 'Display',
    gateBase: 1.0,
  }),

  setting({
    field: 'bloomEnabled',
    label: 'Bloom',
    tier: BASIC,
    source: PREFS,
    kind: BOOL,
    help: 'Glow around bright areas.',
    group: 'Display',
  }),
  setting({
    field: 'bloomThreshold',
    label: 'Threshold',
    tier: ADVANCED,
    source: PREFS,
    kind: SLIDER,
    lo: 0.0,
    hi: 2.0,
    help:
      'Brightness cutoff for what glows. Lower spreads the glow to more of the ' +
      'image; higher confines it to the brightest regions.',
    group: 'Display',
    revealsOn: 'bloomEnabled',
  }),
  setting({
    field: 'bloomIntensity',
    label: 'Intensity',
    tier: ADVANCED,
    source: PREFS,
    kind: SLIDER,
    lo: 0.0,
    hi: 1.0,
    help: 'Strength of the glow.',
    group: 'Display',
    revealsOn: 'bloomEnabled',
  }),
  setting({
    field: 'bloomRadius',
    label: 'Radius',
    tier: ADVANCED,
    source: PREFS,
    kind: SLIDER,
    lo: 0.1,
    hi: 1.0,
    help: 'Spread of the blur kernel -- how far the glow reaches.',
    group: 'Display',
    revealsOn: 'bloomEnabled',
  }),
];

/**
 * Panel settings for the current tier, in declaration order.
 *
 * `panel: false` entries are excluded at this one point rather than at each
 * caller, so nothing downstream -- `grouped()`, the sections, the reveal pass --
 * has to know that a field can have its widget somewhere else.
 */
export function visible(tierAdvanced: boolean): readonly Setting[] {
  return SETTINGS.filter((s) => s.panel && (tierAdvanced || s.tier === BASIC));
}

export function bySource(
  settings: readonly Setting[],
  source: Source,
): readonly Setting[] {
  return settings.filter((s) => s.source === source);
}

/**
 * Visible settings for `sources`, as `[group, settings][]`.
 *
 * Groups come out in the order their first member is declared. A group with no
 * visible members is omitted entirely rather than rendered empty -- that is how
 * a group disappears in Basic mode when all its controls are Advanced.
 */
export function grouped(
  tierAdvanced: boolean,
  sources: readonly Source[],
): readonly (readonly [string, readonly Setting[]])[] {
  const wanted = new Set<Source>(sources);
  const order: string[] = [];
  const buckets = new Map<string, Setting[]>();
  for (const s of visible(tierAdvanced)) {
    if (!wanted.has(s.source)) continue;
    let bucket = buckets.get(s.group);
    if (bucket === undefined) {
      bucket = [];
      buckets.set(s.group, bucket);
      order.push(s.group);
    }
    bucket.push(s);
  }
  return order.map((name) => [name, buckets.get(name) ?? []] as const);
}

/**
 * The registry's SEED control, for callers with no widget to hand.
 *
 * Looked up by KIND rather than by field name: SEED means "a randomizable
 * opaque selector", and there is exactly one. Naming the field here would put a
 * second copy of that name outside this file
 * (`settings_commands.py:114-124`).
 */
export function seedSetting(): Setting | null {
  return SETTINGS.find((s) => s.kind === SEED) ?? null;
}

/**
 * One entry by source and field, for a widget the registry does not build.
 *
 * `mutationOverlay.ts` is the caller: it renders its own slider but takes the
 * label, bounds and help text from here, so the overlay and a registry-driven
 * control can never disagree about what Mutation Scale's range is. Returns
 * `null` rather than throwing, so a renamed field degrades to a missing widget
 * instead of a blank page.
 */
export function settingFor(source: Source, field: string): Setting | null {
  return SETTINGS.find((s) => s.source === source && s.field === field) ?? null;
}
