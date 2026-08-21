/**
 * What the FPS counter SAYS, given what the GPU is doing.
 *
 * A pure leaf: no DOM, no GPU, no state beyond what is handed in. Same rationale
 * as `calibration/progression.ts` -- the thresholds and the debounce are the part
 * most worth testing, and they should be readable without a browser in the import
 * graph.
 *
 * ## Two regimes, one dial, and why the split is unavoidable
 *
 * **Below 60 the counter reports a MEASUREMENT. At 60 it reports an ESTIMATE.**
 * That is not a design preference, it is forced by how the frame loop works:
 *
 *   - `requestAnimationFrame` is vsync-capped. A GPU doing 8 ms of work and one
 *     doing 16 ms of work both deliver frames every 16.7 ms on a 60 Hz panel, so
 *     wall-clock frame delta SATURATES at the refresh rate and cannot see above
 *     it. Every machine keeping up looks identical.
 *   - Below the refresh rate the cap is not binding -- frames are genuinely late
 *     -- so the same delta becomes a true measurement again.
 *
 * So the dial reads measured fps while frames are being missed, and switches to a
 * headroom estimate once they are not. `estimateFps` is where the two meet.
 *
 * ## Headroom, and the honesty line this file draws
 *
 * Headroom comes from GPU busy time (`perf/gpuProbe.ts`), not from frame delta.
 * `TARGET_FRAME_MS / gpuMs` is how many times over the GPU could have done this
 * frame's work inside one frame's budget -- 5 ms of work in a 16.7 ms frame is
 * ~3.3x.
 *
 * **THAT RATIO IS SPARE CAPACITY, NOT A FRAME RATE THE MACHINE WOULD ACHIEVE.**
 * Raising World Size does not scale cost linearly with every other setting, the
 * measurement excludes compositing, and nothing here models what the user would
 * turn up. This is why the high bands render as `60+`/`60++`/`60+++` rather than
 * as numbers: a `+` reads as "you have room", which is what was measured, while
 * "127" would read as a promise nothing here can keep.
 *
 * Below 60 there is no such gap -- a measured 41 fps IS 41 fps -- so those bands
 * print the number.
 */

/**
 * The reference frame budget: 60 fps.
 *
 * FIXED AT 60 REGARDLESS OF THE DISPLAY, matching `progression.ts`'s
 * `TARGET_FRAME_MS` and for the same stated reason -- the app deliberately spends
 * a 120 Hz panel's extra capacity on a heavier simulation rather than on more
 * frames. A 144 Hz machine hitting every vsync therefore reads as headroom above
 * 60, which is exactly what it is.
 */
export const TARGET_FRAME_MS = 16.7;

/** The four bands, coldest to hottest. The order IS the severity ranking. */
export const RED = 'red';
export const YELLOW = 'yellow';
export const GREEN = 'green';
export const BLUE = 'blue';

export type Band = typeof RED | typeof YELLOW | typeof GREEN | typeof BLUE;

/**
 * Band edges in effective-fps space, from the brief.
 *
 * `<=35` red, `35..50` yellow, `50..70` green, `70+` blue. Stated as the LOWER
 * bound of each band so `bandFor` is a single descending walk and the gaps
 * between the brief's ranges cannot become unhandled cases.
 */
const BAND_FLOOR: readonly (readonly [Band, number])[] = Object.freeze([
  [BLUE, 70],
  [GREEN, 50],
  [YELLOW, 35],
  [RED, 0],
]);

/**
 * Where the `+` marks start, and what each one costs.
 *
 * 70..90 is `60+`, 90..120 is `60++`, 120+ is `60+++`. Only ever reached from
 * the blue band -- see `readoutFor`.
 */
const PLUS_FLOOR: readonly (readonly [string, number])[] = Object.freeze([
  ['60+++', 120],
  ['60++', 90],
  ['60+', 70],
]);

/** Which band an effective fps falls in. */
export function bandFor(fps: number): Band {
  for (const [band, floor] of BAND_FLOOR) {
    if (fps >= floor) return band;
  }
  return RED;
}

/**
 * What the button prints for an effective fps.
 *
 * Three cases, in the order they are reached:
 *
 *   - 120+/90+/70+  ->  `60+++` / `60++` / `60+`. Stylized, because these come
 *     from a headroom ESTIMATE and printing "134" would claim a measurement.
 *   - 60..70        ->  `60`. Above target with no headroom worth naming.
 *   - below 60      ->  the rounded number. A real measurement, printed as one.
 *
 * Rounds rather than truncating: 59.6 fps reading as "59" understates a machine
 * that is essentially holding target.
 */
export function readoutFor(fps: number): string {
  for (const [text, floor] of PLUS_FLOOR) {
    if (fps >= floor) return text;
  }
  if (fps >= 60) return '60';
  // `max(1)` so a catastrophically slow frame reads "1" rather than "0" -- zero
  // would suggest the app has stopped, which is a different failure.
  return String(Math.max(1, Math.round(fps)));
}

/**
 * Effective fps from the two measurements, picking the honest one.
 *
 * `frameMs` is smoothed wall-clock delta between rAF callbacks -- valid ONLY
 * while frames are being missed, since it saturates at the refresh rate
 * otherwise. `gpuMs` is real GPU busy time from the probe, which keeps scaling
 * however fast the machine is.
 *
 * **THE MEASURED NUMBER WINS WHENEVER IT IS BINDING.** If frames really are
 * arriving at 41 fps, the user is watching a 41 fps app and no amount of GPU
 * headroom changes that -- something else (CPU, compositing, a background tab
 * stealing the GPU) is the constraint, and reporting blue there would be telling
 * someone their machine has room while they watch it stutter.
 *
 * So: below the threshold, report what was measured. At or above it, the cap is
 * binding and the estimate is the only thing with information in it.
 *
 * `gpuMs <= 0` means the probe has no reading yet (or the platform gave a
 * useless one), which degrades to the measured number -- the conservative
 * direction, since it can only under-report headroom.
 */
export function estimateFps(frameMs: number, gpuMs: number): number {
  const measured = frameMs > 0 ? 1000 / frameMs : 0;
  if (measured < MEASURED_CEILING || gpuMs <= 0) return measured;
  // Headroom: how many times over this frame's GPU work fits in the budget.
  // Anchored at 60 rather than at `measured`, so a 144 Hz panel and a 60 Hz
  // panel with the same GPU load report the same headroom.
  return 60 * (TARGET_FRAME_MS / gpuMs);
}

/**
 * Measured fps below which the wall clock is believed over the estimate.
 *
 * 58 rather than 60: a machine holding vsync perfectly still reports 59.7-60.2
 * depending on how the browser rounds its callback times, and a threshold at
 * exactly 60 would flip between regimes on rounding noise alone.
 */
const MEASURED_CEILING = 58;

/**
 * The debounce: a band that only moves when the evidence is sustained.
 *
 * ## Why hysteresis AND a dwell time, rather than just smoothing
 *
 * Smoothing alone does not fix an edge. An EMA sitting at 50.0 with the green
 * floor at 50 still crosses back and forth on the smallest jitter, and the
 * counter flickers between yellow and green -- which is precisely the
 * distraction the brief rules out. Two mechanisms, because they solve different
 * halves:
 *
 *   - **A margin** (`MARGIN_FPS`) means leaving a band requires clearing its
 *     edge by a real amount, not by 0.1. This kills edge-sitting.
 *   - **A dwell** (`DWELL_MS`) means the new band has to hold for a while before
 *     it is adopted. This kills brief spikes -- a GC pause, another tab waking
 *     up, the user dragging a slider through an expensive value.
 *
 * A change must satisfy BOTH. The result is a dial that moves when the machine's
 * situation genuinely changed and ignores everything else.
 */
export interface BandState {
  /** The band currently displayed. */
  readonly band: Band;
  /** The readout currently displayed. */
  readonly readout: string;
  /** Band seen in the samples since `pendingSince`, or null if none is pending. */
  readonly pending: Band | null;
  /** When `pending` first appeared, in ms on the caller's clock. */
  readonly pendingSince: number;
}

/**
 * How far past a band edge a reading must go before it counts as that band.
 *
 * 3 fps. Wide enough that ordinary frame-to-frame variation cannot cross it,
 * narrow enough that a real change (turning bloom on, doubling world size) still
 * moves the dial promptly.
 */
const MARGIN_FPS = 3;

/**
 * How long a new band must hold before it is adopted.
 *
 * 3 seconds -- long enough to ride out a GC pause or a slider drag, short enough
 * that someone who just changed a setting sees the consequence while they are
 * still thinking about that setting.
 */
const DWELL_MS = 3000;

/** The band a fresh counter starts in. See `startBand`. */
export const INITIAL_BAND: Band = GREEN;

/**
 * A counter's starting state.
 *
 * **GREEN, not red.** The first reading arrives before any warmup has settled,
 * and opening on a red badge telling someone their GPU is struggling -- when
 * nothing has been measured yet -- is a false alarm on the one impression that
 * matters most. Green is the neutral "nothing to report" of these four.
 */
export function startBand(): BandState {
  return Object.freeze({
    band: INITIAL_BAND,
    readout: readoutFor(60),
    pending: null,
    pendingSince: 0,
  });
}

/**
 * Fold one reading into the band state.
 *
 * PURE, and returns the receiver unchanged when nothing moved -- so the caller
 * can use `next !== prev` to decide whether to touch the DOM, exactly as
 * `preferences.ts`'s `withValue` lets a caller decide whether to save.
 *
 * `now` is injected rather than read from `performance` so the dwell is testable
 * without waiting three real seconds.
 */
export function stepBand(state: BandState, fps: number, now: number): BandState {
  const target = bandFor(fps);

  // Already there: cancel any pending change, and refresh the READOUT.
  //
  // The readout updates freely within a band while the band itself is debounced,
  // and that asymmetry is deliberate: the number ticking 44 -> 45 is information
  // at a glance and costs nothing, while a COLOUR change draws the eye away from
  // the picture. Debouncing both would leave the number visibly stale.
  if (target === state.band) {
    const readout = readoutFor(fps);
    if (state.pending === null && readout === state.readout) return state;
    return Object.freeze({ ...state, readout, pending: null, pendingSince: 0 });
  }

  // Not yet clear of the current band by the margin: treat it as noise. Which
  // direction the margin applies in depends on which way we are moving, so it is
  // measured against the CURRENT band's own edges rather than the target's.
  if (!clearsMargin(state.band, fps)) {
    return state.pending === null
      ? state
      : Object.freeze({ ...state, pending: null, pendingSince: 0 });
  }

  // A new candidate: start its clock.
  if (state.pending !== target) {
    return Object.freeze({ ...state, pending: target, pendingSince: now });
  }

  // The same candidate as last time -- has it held long enough?
  if (now - state.pendingSince < DWELL_MS) return state;

  return Object.freeze({
    band: target,
    readout: readoutFor(fps),
    pending: null,
    pendingSince: 0,
  });
}

/**
 * Whether `fps` is far enough outside `band` to count as having left it.
 *
 * The margin is applied OUTWARD from the band being left, in whichever direction
 * the reading is heading -- so sitting exactly on an edge never flips, and a
 * reading has to commit before it is believed.
 */
function clearsMargin(band: Band, fps: number): boolean {
  const [floor, ceiling] = boundsOf(band);
  return fps < floor - MARGIN_FPS || fps > ceiling + MARGIN_FPS;
}

/** The `[floor, ceiling)` of one band, in fps. */
function boundsOf(band: Band): readonly [number, number] {
  const index = BAND_FLOOR.findIndex(([b]) => b === band);
  const floor = BAND_FLOOR[index]?.[1] ?? 0;
  // The band above this one starts where this one ends. The topmost band has no
  // ceiling, so nothing can ever be "above" blue.
  const ceiling = index <= 0 ? Number.POSITIVE_INFINITY : BAND_FLOOR[index - 1]![1];
  return [floor, ceiling];
}

/**
 * The four colours, as pale fills over a dark chrome.
 *
 * PALE, as the brief asks: this sits over the artwork permanently, and a
 * saturated badge would compete with the picture it is reporting on. These are
 * high-lightness, low-chroma versions of the same hues the rest of the interface
 * already uses -- `#8ab4f8` is the active-tab blue from `settingsSection.ts`, and
 * the others are tuned to sit at a similar weight beside it.
 */
export const BAND_COLOR: Readonly<Record<Band, string>> = Object.freeze({
  [RED]: '#f5a3a3',
  [YELLOW]: '#f2d9a0',
  [GREEN]: '#a8dcb0',
  [BLUE]: '#a8c8f8',
});

/**
 * The same four hues, saturated for use on a SLIDER LABEL.
 *
 * **A second ramp, and it is not redundant.** The badge sits on a dark chrome
 * plate over the artwork, where pale is right -- a saturated badge would compete
 * with the picture. A slider label sits in a panel beside a column of OTHER
 * labels already drawn in a light grey (`rgba(232,232,234,0.7)`), and against
 * that neighbour the pale ramp is nearly invisible: `#a8c8f8` and the idle grey
 * are within a few percent of the same lightness, so a screenshot of the
 * Preferences tab showed World Size, Physics Rate and Motion Blur looking
 * essentially untinted.
 *
 * That was only ever going to be caught by looking at it. The browser check
 * asserts that an inline colour is PRESENT, which it was -- "present but
 * indistinguishable" is not a property an assertion of that shape can see.
 *
 * So these are the same hues pushed up in chroma and down in lightness until
 * they separate from the idle grey while still reading as the badge's colour.
 * They stay well short of alarming: the point is "these three are the knobs",
 * not "something is wrong".
 */
export const BAND_LABEL_COLOR: Readonly<Record<Band, string>> = Object.freeze({
  [RED]: '#ff8080',
  [YELLOW]: '#ffc857',
  [GREEN]: '#6ede8a',
  [BLUE]: '#71a9ff',
});

/**
 * The tooltip for each band, verbatim from the brief.
 *
 * Red and yellow deliberately share one string: both mean "the GPU is not
 * keeping up", and the advice for the two is identical. Splitting them would
 * mean inventing a distinction the user cannot act on differently.
 */
export const BAND_TOOLTIP: Readonly<Record<Band, string>> = Object.freeze({
  [RED]:
    'Fluoddity can be demanding! Looks like your GPU is struggling. Try turning ' +
    'off motion blur, reducing the physics rate, or lowering world size. Click ' +
    'here to bring up the performance-critical settings.',
  [YELLOW]:
    'Fluoddity can be demanding! Looks like your GPU is struggling. Try turning ' +
    'off motion blur, reducing the physics rate, or lowering world size. Click ' +
    'here to bring up the performance-critical settings.',
  [GREEN]:
    'Fluoddity can be demanding! Looks like your GPU is well utilized. Click ' +
    'here to bring up the performance-critical settings.',
  [BLUE]:
    'Fluoddity can be demanding, but it looks like your GPU can handle more! Try ' +
    'raising the physics rate, turning on motion blur, or increasing World size. ' +
    'Click here to bring up the performance-critical settings.',
});

/**
 * A screen-reader name for each band, since colour must not be the only signal.
 *
 * The same rule the mutation overlay's gear and fences follow: the state is in
 * the `aria-label` as words, so the button is readable without colour vision and
 * legible in a screenshot.
 */
export const BAND_DESCRIPTION: Readonly<Record<Band, string>> = Object.freeze({
  [RED]: 'GPU struggling',
  [YELLOW]: 'GPU under strain',
  [GREEN]: 'GPU well utilized',
  [BLUE]: 'GPU has headroom to spare',
});
