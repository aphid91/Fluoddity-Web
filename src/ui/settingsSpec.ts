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
  /**
   * Whether the STUDIO renders this control. False for settings that only mean
   * something between different configs, which the studio never runs together
   * -- Trail Weight. Sand, which does, builds its config tab from `SETTINGS`
   * directly and shows them regardless. `visible()` is the filter, like `panel`.
   */
  readonly studio: boolean;
  /**
   * A SLIDER's smallest magnitude, or 0 for none. Values inside +-this snap
   * out to it on their own side (zero counts as positive), so dragging across
   * zero jumps from +min to -min. For a value something DIVIDES by.
   */
  readonly minMagnitude: number;
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
  studio: true,
  minMagnitude: 0,
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
  boundary: ['Wrap', 'Zero'],
  initialConditions: ['Seed', 'Noise', 'Sparse', 'Zero'],
  stateBound: ['None', 'Clip [-1,1]', 'Clip [0,1]', 'Tanh'],
  activation: ['ReLU', 'Tanh', 'Sin'],
  perception: ['Fixed', 'Learned'],
  displayMode: ['RGB', 'RGBA', 'Signed', 'Channel'],
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
  // **NOT IN THE PANEL, deliberately.** Mutation Scale lives in
  // `ui/mutationOverlay.ts`, as a wide slider above the canvas with Reroll
  // Mutations beside it; the overlay reads its bounds, label and help from here.
  setting({
    field: 'mutationScale',
    label: 'Mutation Scale',
    tier: BASIC,
    source: CONFIG,
    kind: SLIDER,
    lo: 0.0,
    hi: 1.0,
    help:
      "How far each cohort's weights are pushed from the base network, in units " +
      "of each layer's own initial spread. 0 runs the base network in every " +
      'cohort; higher values fan the cohorts out into distinct behaviours.',
    group: 'Mutation',
    panel: false,
  }),
  // The FIRST SEED entry is what `randomizeSeed` rerolls (`seedSetting()`).
  setting({
    field: 'mutationSeed',
    label: 'Mutation Seed',
    tier: BASIC,
    source: CONFIG,
    kind: SEED,
    lo: 0.0,
    hi: 1.0,
    help:
      'Which random variation the mutation uses. Reroll to explore alternatives ' +
      'at the same mutation strength.',
    group: 'Mutation',
    panel: false,
  }),

  // ================= PROJECT: Cohorts =================
  setting({
    field: 'cohorts',
    label: 'Cohorts',
    tier: BASIC,
    source: CONFIG,
    kind: INT,
    lo: 1,
    hi: 64,
    help:
      'How many rectangles the grid is divided into. Each runs its own mutation ' +
      'of the base network; click one to make it the new base.',
    group: 'Cohorts',
  }),
  setting({
    field: 'cohortFences',
    label: 'Cohort Fences',
    tier: BASIC,
    source: CONFIG,
    kind: BOOL,
    help:
      'Wrap each cohort around on itself, so every cohort is its own torus and ' +
      'nothing crosses between them. Off: cells read their neighbours across ' +
      'cohort edges and the cohorts can invade one another.',
    group: 'Cohorts',
  }),
  setting({
    field: 'boundary',
    label: 'World Edge',
    tier: ADVANCED,
    source: WORLD,
    kind: CHOICE,
    lo: 0,
    hi: 1,
    help:
      'What a cell sees past the edge of the grid when fences are off: Wrap ' +
      'makes the grid a torus, Zero reads empty cells.',
    group: 'Cohorts',
    options: DROPDOWN_MODES.boundary,
  }),

  // ================= PROJECT: Dynamics =================
  setting({
    field: 'dt',
    label: 'Step Size',
    tier: BASIC,
    source: CONFIG,
    kind: SLIDER,
    lo: 0.0,
    hi: 2.0,
    help: "How much of the network's output is added to a cell's state each update.",
    group: 'Dynamics',
  }),
  setting({
    field: 'fireRate',
    label: 'Fire Rate',
    tier: BASIC,
    source: CONFIG,
    kind: SLIDER,
    lo: 0.0,
    hi: 1.0,
    help:
      'The chance a cell updates on a given step. Below 1 the update is ' +
      'asynchronous, which breaks the grid-locked symmetry of a synchronous CA.',
    group: 'Dynamics',
  }),
  setting({
    field: 'gain',
    label: 'Gain',
    tier: BASIC,
    source: CONFIG,
    kind: SLIDER,
    lo: 0.0,
    hi: 6.0,
    help:
      "Multiplies every hidden unit's input. Low gain is calm and near-linear; " +
      'high gain saturates the nonlinearity -- the knob for finding the edge of chaos.',
    group: 'Dynamics',
  }),
  setting({
    field: 'stateBound',
    label: 'State Bound',
    tier: BASIC,
    source: CONFIG,
    kind: CHOICE,
    lo: 0,
    hi: 3,
    help:
      'What keeps cell values finite: None (only a far safety clamp), Clip to ' +
      '[-1, 1], Clip to [0, 1], or a smooth tanh squash.',
    group: 'Dynamics',
    options: DROPDOWN_MODES.stateBound,
  }),
  setting({
    field: 'activation',
    label: 'Activation',
    tier: ADVANCED,
    source: CONFIG,
    kind: CHOICE,
    lo: 0,
    hi: 2,
    help: 'The hidden layer nonlinearity.',
    group: 'Dynamics',
    options: DROPDOWN_MODES.activation,
  }),
  setting({
    field: 'leak',
    label: 'Leak',
    tier: ADVANCED,
    source: CONFIG,
    kind: GATED,
    lo: 0.0,
    hi: 0.2,
    curve: 2.0,
    help: 'Per-step decay of every channel toward zero.',
    group: 'Dynamics',
  }),
  setting({
    field: 'noise',
    label: 'Noise',
    tier: ADVANCED,
    source: CONFIG,
    kind: GATED,
    lo: 0.0,
    hi: 0.2,
    curve: 2.0,
    help: 'Uniform noise added to every channel on every step.',
    group: 'Dynamics',
  }),
  setting({
    field: 'aliveMask',
    label: 'Alive Mask',
    tier: ADVANCED,
    source: CONFIG,
    kind: BOOL,
    help:
      "Growing-NCA alive masking: a cell whose 3x3 neighbourhood has no value of " +
      'channel 3 (or the last channel) above the threshold is zeroed.',
    group: 'Dynamics',
  }),
  setting({
    field: 'aliveThreshold',
    label: 'Alive Threshold',
    tier: ADVANCED,
    source: CONFIG,
    kind: SLIDER,
    lo: 0.0,
    hi: 1.0,
    help: 'The alive channel value a neighbourhood must exceed to stay alive.',
    group: 'Dynamics',
    revealsOn: 'aliveMask',
  }),

  // ================= PROJECT: Architecture =================
  //
  // TYPED INPUTS, committed on Enter: every commit re-embeds the weights into
  // the new layout and recompiles the step kernel, so a slider dragged down and
  // back up would truncate the network on the way down.
  setting({
    field: 'channels',
    label: 'Channels',
    tier: BASIC,
    source: CONFIG,
    kind: INPUT,
    lo: 1,
    hi: 32,
    help:
      'State values per cell. Growing it keeps the current behaviour (new ' +
      'channels start disconnected); changing it restarts the simulation.',
    group: 'Architecture',
  }),
  setting({
    field: 'hidden',
    label: 'Hidden Units',
    tier: BASIC,
    source: CONFIG,
    kind: INPUT,
    lo: 0,
    hi: 256,
    help:
      'Width of the hidden layer. 0 is a single layer straight from perception ' +
      'to update. Growing it keeps the current behaviour.',
    group: 'Architecture',
  }),
  setting({
    field: 'perception',
    label: 'Perception',
    tier: BASIC,
    source: CONFIG,
    kind: CHOICE,
    lo: 0,
    hi: 1,
    help:
      'Fixed: identity plus Sobel x/y (and optionally a Laplacian) per channel. ' +
      'Learned: identity plus learned 3x3 kernels per channel, mutated with the ' +
      'rest of the network. Switching to Learned starts the kernels AS the fixed filters.',
    group: 'Architecture',
    options: DROPDOWN_MODES.perception,
  }),
  setting({
    field: 'laplacian',
    label: 'Laplacian',
    tier: ADVANCED,
    source: CONFIG,
    kind: BOOL,
    help: 'Add a Laplacian filter to the fixed perception.',
    group: 'Architecture',
    requires: ['perception', 0],
  }),
  setting({
    field: 'learnedKernels',
    label: 'Learned Kernels',
    tier: ADVANCED,
    source: CONFIG,
    kind: INPUT,
    lo: 1,
    hi: 8,
    help: 'Learned 3x3 kernels per channel.',
    group: 'Architecture',
    requires: ['perception', 1],
  }),

  // ================= PROJECT: Initial Conditions =================
  setting({
    field: 'initialConditions',
    label: 'Initial Conditions',
    tier: BASIC,
    source: CONFIG,
    kind: CHOICE,
    lo: 0,
    hi: 3,
    help:
      'Seed: a disc at the centre of every cohort. Noise: every cell random. ' +
      'Sparse: scattered seeds. Zero: empty (paint or noise must start it). ' +
      'Takes effect on reset.',
    group: 'Initial Conditions',
    options: DROPDOWN_MODES.initialConditions,
  }),
  setting({
    field: 'seedRadius',
    label: 'Seed Radius',
    tier: BASIC,
    source: CONFIG,
    kind: INT,
    lo: 0,
    hi: 16,
    help: 'Radius of each seed disc, in cells.',
    group: 'Initial Conditions',
  }),
  setting({
    field: 'icAmplitude',
    label: 'Amplitude',
    tier: ADVANCED,
    source: CONFIG,
    kind: SLIDER,
    lo: 0.0,
    hi: 2.0,
    help: 'The value a seed writes into every channel, or the noise amplitude.',
    group: 'Initial Conditions',
  }),
  setting({
    field: 'icDensity',
    label: 'Seed Density',
    tier: ADVANCED,
    source: CONFIG,
    kind: SLIDER,
    lo: 0.0,
    hi: 0.05,
    curve: 2.0,
    help: 'Sparse mode: the chance any cell is a seed centre.',
    group: 'Initial Conditions',
  }),
  setting({
    field: 'icSeed',
    label: 'Run Seed',
    tier: ADVANCED,
    source: CONFIG,
    kind: SEED,
    lo: 0.0,
    hi: 1.0,
    help: 'Seeds the initial noise, the sparse seeds, the fire mask and the step noise.',
    group: 'Initial Conditions',
  }),

  // ================= PROJECT: Display =================
  setting({
    field: 'displayMode',
    label: 'Display',
    tier: BASIC,
    source: WORLD,
    kind: CHOICE,
    lo: 0,
    hi: 3,
    help:
      'RGB: three channels as colour. RGBA: the classic Growing-NCA look, ' +
      'premultiplied on white. Signed: three channels with grey at zero. ' +
      'Channel: one channel, warm positive and cool negative.',
    group: 'Display',
    options: DROPDOWN_MODES.displayMode,
  }),
  setting({
    field: 'displayChannel',
    label: 'First Channel',
    tier: BASIC,
    source: WORLD,
    kind: INT,
    lo: 0,
    hi: 31,
    help: 'The first channel shown.',
    group: 'Display',
  }),
  setting({
    field: 'displayGain',
    label: 'Display Gain',
    tier: ADVANCED,
    source: WORLD,
    kind: SLIDER,
    lo: 0.1,
    hi: 8.0,
    curve: 2.0,
    help: 'Multiplies channel values before they become colour.',
    group: 'Display',
  }),
  setting({
    field: 'showCohortBorders',
    label: 'Cohort Borders',
    tier: BASIC,
    source: WORLD,
    kind: BOOL,
    help: 'Draw the edges between cohorts.',
    group: 'Display',
  }),
  // ROLLING TORI. Per STEP, so changing Steps / Frame needs no retuning.
  setting({
    field: 'scrollX',
    label: 'Scroll X',
    tier: BASIC,
    source: WORLD,
    kind: SLIDER,
    lo: -1.0,
    hi: 1.0,
    help:
      'Rolling tori: scroll the view of every cohort sideways by this many cells ' +
      'per step (+ is right). Match a soliton\'s velocity and it stands still. ' +
      'View only -- the simulation is untouched. Reset returns the view home.',
    group: 'Display',
  }),
  setting({
    field: 'scrollY',
    label: 'Scroll Y',
    tier: BASIC,
    source: WORLD,
    kind: SLIDER,
    lo: -1.0,
    hi: 1.0,
    help:
      'Rolling tori: scroll the view of every cohort vertically by this many ' +
      'cells per step (+ is up). See Scroll X.',
    group: 'Display',
  }),

  // ================= PREFERENCES: Simulation =================
  setting({
    field: 'worldSize',
    label: 'Grid Size',
    tier: BASIC,
    source: PREFS,
    kind: INPUT,
    lo: 0.01,
    hi: 16.0,
    help:
      '(Expensive) The grid is 256 x 256 cells times the square root of this, ' +
      'shaped by Canvas Aspect: 0.25 is 128 x 128, 4 is 512 x 512.',
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
    label: 'Steps / Frame',
    tier: BASIC,
    source: PREFS,
    kind: INT,
    lo: 1,
    hi: 240,
    help:
      '(Expensive) NCA steps per rendered frame. Higher values run the ' +
      'simulation faster.',
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

  // IMMEDIATELY BELOW THE COUNTER, and the two belong together: they are the
  // only entries in the registry that govern a `document.body` widget rather
  // than anything about the rendered frame, and both are answering "what do I
  // want sitting over my artwork".
  //
  // **ADVANCED WHERE THE COUNTER IS BASIC.** Turning the badge off is a plain
  // preference; hiding this one takes away a live control, and the fold on the
  // widget itself already serves anyone who just wants it smaller. Somebody who
  // means to banish a control entirely can be asked to find the Advanced tier.
  setting({
    field: 'showPhysicsSlider',
    label: 'Show Physics Rate Widget',
    tier: ADVANCED,
    source: PREFS,
    kind: BOOL,
    help:
      'The fast-forward button and its rate slider, at the right edge. It is ' +
      'the way to reach Physics Rate while the panels are hidden.' +
      '\n\nUntick to remove it from the screen entirely. To merely fold the ' +
      'slider away and keep the button, press the button itself -- and ' +
      'right-click it to auto-calibrate the rate.',
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
      'Which layout to build: Auto picks the touch layout on touchscreens, ' +
      'including tablets. Change this only if the automatic choice is wrong ' +
      'for your device -- it takes effect after you reload the page.',
    group: 'Behavior',
    options: DROPDOWN_MODES.mobileMode,
  }),
];

/**
 * Panel settings for the current tier, in declaration order.
 *
 * `panel: false` entries are excluded at this one point rather than at each
 * caller, so nothing downstream -- `grouped()`, the sections, the reveal pass --
 * has to know that a field can have its widget somewhere else. `studio: false`
 * entries likewise: every caller of this is the studio's panel.
 */
export function visible(tierAdvanced: boolean): readonly Setting[] {
  return SETTINGS.filter(
    (s) => s.panel && s.studio && (tierAdvanced || s.tier === BASIC),
  );
}

/**
 * `value` pushed out of the setting's `minMagnitude` dead zone, keeping its
 * side -- zero counts as positive. Unchanged when the setting has none.
 */
export function outsideMinMagnitude(setting: Setting, value: number): number {
  const min = setting.minMagnitude;
  if (min <= 0 || Math.abs(value) >= min) return value;
  return value < 0 ? -min : min;
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
