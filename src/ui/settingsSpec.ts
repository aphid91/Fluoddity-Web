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
  /**
   * A live precondition: while it is false the control renders GREYED OUT.
   *
   * `[field, value]` on the same source -- "enabled only while `field` equals
   * `value`". Cohort Fences is the one entry that uses it: its radius is derived
   * from the Grid cell size, so it means nothing under the other Initial
   * Conditions modes and must not look adjustable there.
   *
   * ## Greyed, not hidden -- the opposite of `revealsOn`, on purpose
   *
   * The file header on `reveal.ts` argues for hiding: a bloom parameter that
   * cannot apply is noise, and a panel full of noise is a wall. That reasoning
   * turns around here. Those parameters are meaningless when their EFFECT is
   * off, and the checkbox that turns it off is right above them, so the way back
   * is obvious. This one is meaningful, the user asked for it, and it is
   * unavailable because of a DIFFERENT control in the same group. Hiding it
   * would answer "where did Cohort Fences go?" with silence; greying it out
   * leaves the label on screen, and the tooltip beside it says Grid is required.
   *
   * Evaluated every frame in the control's `refresh`, like the Randomize
   * button's dependence on Mutation Scale -- it is a live condition, not a
   * property of the registry entry.
   */
  readonly requires: readonly [field: string, value: number | boolean] | null;
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
  requires: null as Setting['requires'],
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
  // THE LABELS ONLY. `ui/mobile.ts` derives its `MobileMode` union from this
  // tuple rather than declaring its own, so the stored index and the dropdown
  // cannot drift -- the same lockstep the two above keep with `common.wgsl`,
  // and the reason this list lives here rather than there: this file has no
  // imports, so the dependency runs one way (mobile -> registry) and a UI module
  // can never end up upstream of the registry.
  mobileMode: ['Auto', 'Always Touch', 'Always Desktop'],
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
      'How many groups the population is divided into. When mutation Scale > ' +
      '0, each cohort gets its own mutation of the parent behavior.',
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
      'What happens when a particle reaches the edge of the world: Bounce ' +
      'reflects it, reset returns it to starting position, and wrap carries it ' +
      'around to the opposite edge.',
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
      'How particles are arranged when the simulation starts: Grid and ring lay ' +
      'the cohorts out in a regular pattern, Random spreads them evenly, and ' +
      'Center starts them all in a dense clump in the middle.',
    group: 'Population',
    options: DROPDOWN_MODES.initialConditions,
  }),
  setting({
    field: 'cohortFences',
    label: 'Cohort Fences',
    tier: BASIC,
    source: CONFIG,
    kind: BOOL,
    lo: 0,
    hi: 1,
    // THE SAME SENTENCE THE BAR BUTTON SHOWS. The two controls edit one field
    // and the bar's own tooltip states the Grid requirement in a second
    // paragraph when it applies; here the requirement is already visible as the
    // greyed-out row, and `requires` below is what greys it.
    help:
      'Cohort fences: When enabled, particles are forced to stay close to their ' +
      'initial locations (Grid only).',
    group: 'Population',
    // Grid is IC_GRID, i.e. index 0 of `DROPDOWN_MODES.initialConditions` --
    // spelled as the index because this file imports nothing (see the note on
    // DROPDOWN_MODES). `settingsSpec.test.ts` pins that tuple against the real
    // `IC` constants, so this cannot drift without a test failing.
    requires: ['initialConditions', 0],
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
      'Applies a small probability each tick for a particle to "die" and be ' +
      '"reincarnated" at its initial conditions',
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
      "Defines how wide the angle is between a particle's two sensor locations. " +
      'Values near 0.0 are looking straight ahead, values near 0.5 look to the ' +
      'left and right, while values near 1.0 look behind.',
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
    help: "Adds random, per-tick variation to each particle's sensor angle",
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
      "Defines how far away from a particle's center it reads the trail. Higher " +
      'values tend to result in larger, more global patterns',
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
      "Adds random, per-tick variation to each particle's sensor distance. " +
      'Distance jitter often produces softer edges and less noticeable ' +
      'grid-aligned aliasing',
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
      'Determines how sensitive each particle is to trail conditions. Set it too ' +
      'low and particles will travel ~straight, ignoring the trails. Set it too ' +
      'high and their behavior will become noisy and chaotic',
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
      'Determines the strength with which particles turn quickly, accelerate, ' +
      'and strafe',
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
      'How much velocity carries over between ticks. At high values, particles ' +
      'will be able to build up momentum',
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
    help: 'Enables vertical/radial gravity controls',
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
      'Applies a fixed offset to particles each frame, shifting them downward',
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
      'Applies a fixed force to particles each frame, accelerating them downward',
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
      'Makes gravity push particles towards the center of the simulation instead ' +
      'of straight down',
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
      'Determines how long particle trails remain detectable. At high values, ' +
      'trails will spread widely and decay slowly.',
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
      'Determines how sensitive the hue of a particle is to its brain outputs. ' +
      'At high values particle hue becomes chaotic and regions will become a ' +
      'random mix of hues: appearing pale/white',
    group: 'Appearance',
  }),
  setting({
    field: 'colorByCohort',
    label: 'Color By Cohort',
    tier: BASIC,
    source: CONFIG,
    kind: BOOL,
    help:
      'Assign each cohort a unique color instead of basing hue on brain outputs',
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
    help:
      'Determines the relative strength of acceleration/braking forces and ' +
      'forward/backward strafing',
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
      'Determines the relative strength of turning forces and left-right strafing',
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
      'Determines the relative strength of particle strafe, which directly ' +
      'shifts particle positions, bypassing momentum',
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
      'Allows you to slow or stop the pace at which particle trails spread ' +
      'through the environment. At stiffness 1.0, trails do not diffuse at all, ' +
      'and simply decay over time.',
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
      '(Expensive) Determines the particle count and resolution of the trail ' +
      'map. Overall density -- Particles/Trail pixel -- is kept constant.',
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
    help: 'Determines Width/Height ratio of simulation area.',
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
      '(Expensive) Determines how many physics substeps are performed per ' +
      'frame. Higher values run the simulation faster.',
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
    help: 'Determines overall intensity of each particle',
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
      'Determines how aggressively the bright highlights are dimmed. High values ' +
      'have reduced contrast between bright and dim regions.',
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
      '(Expensive) Renders multiple images at different substeps and blends them ' +
      'together. Results in a smoother, less noisy image',
    group: 'Display',
    gateBase: 1.0,
  }),

  // ABOVE BLOOM, and immediately below Motion Blur, which is deliberate: the
  // three controls the counter's colour also tints -- World Size, Physics Rate
  // and Motion Blur -- are what it is reporting on, so it sits at the end of
  // that run rather than at the bottom of the group.
  //
  // The only entry here whose field changes nothing about the rendered frame.
  // It governs a `document.body` widget rather than a pass, which is why
  // `Preferences.showFpsCounter` is kept out of `DisplayPreferences`.
  setting({
    field: 'showFpsCounter',
    label: 'Show FPS Counter',
    tier: BASIC,
    source: PREFS,
    kind: BOOL,
    help:
      'The frame-rate button in the top-right corner. Its colour tracks how ' +
      'hard your GPU is working: red or yellow means it is struggling, green ' +
      'means it is well used, and blue means the full frame rate is holding.' +
      '\n\nThe number is capped at 60, which is what the simulation is budgeted ' +
      'for -- a faster display is spent on a heavier simulation rather than on ' +
      'more frames.\n\nThe same colour tints World Size, Physics Rate and ' +
      'Motion Blur, which are the three settings that decide it.',
    group: 'Display',
  }),

  setting({
    field: 'bloomEnabled',
    label: 'Bloom',
    tier: BASIC,
    source: PREFS,
    kind: BOOL,
    help: 'Adds a glowing halo effect to over-bright regions',
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
    help: 'Determines the brightness above which bloom is applied',
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
    hi: 0.50,
    help: 'Determines the strength of the bloom effect',
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
    help: 'Determines the size of the bloom halo',
    group: 'Display',
    revealsOn: 'bloomEnabled',
  }),

  // ================= PREFERENCES: Behavior =================
  // DECLARED LAST ON PURPOSE. `grouped()` emits groups in the order their first
  // member is declared, so being last here is what puts this group at the BOTTOM
  // of the Preferences panel. Moving this block up moves the control.
  setting({
    field: 'resetOnBehaviorChange',
    label: 'Reset on Behavior Change',
    tier: ADVANCED,
    source: PREFS,
    kind: BOOL,
    help: 'Resets the simulation whenever particles are given new behaviors',
    group: 'Behavior',
  }),
  setting({
    field: 'oneClickSelection',
    label: '1-Click Selection',
    tier: ADVANCED,
    source: PREFS,
    kind: BOOL,
    help:
      'Allow a single click to bypass cohort selection and generate children ' +
      'immediately',
    group: 'Behavior',
  }),
  setting({
    field: 'mobileMode',
    label: 'Touch Layout',
    tier: ADVANCED,
    source: PREFS,
    kind: CHOICE,
    lo: 0,
    hi: DROPDOWN_MODES.mobileMode.length - 1,
    // NAMES THE RELOAD, because this is the only control in the panel that does
    // not take effect on the next frame -- the layout is BUILT from this rather
    // than styled by it. A dropdown that appears to do nothing is worse than one
    // that says when it will.
    help:
      'Which layout to build: Auto picks the touch layout on phones. Change ' +
      'this only if the automatic choice is wrong for your device -- it takes ' +
      'effect after you reload the page.',
    group: 'Behavior',
    options: DROPDOWN_MODES.mobileMode,
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
