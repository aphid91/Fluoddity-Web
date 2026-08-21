/**
 * What the FPS counter SAYS, given the measured frame rate.
 *
 * A pure leaf: no DOM, no GPU, no state beyond what is handed in. Same rationale
 * as `calibration/progression.ts` -- the thresholds and the debounce are the part
 * most worth testing, and they should be readable without a browser in the import
 * graph.
 *
 * ## One measurement: the frame delta, and nothing else
 *
 * The dial reports the rate frames are actually arriving at, smoothed, capped at
 * 60. That is all. It cannot distinguish a machine comfortably holding 60 from
 * one barely holding it, and does not pretend to.
 *
 * ## The headroom estimate that used to live here, and why it is gone
 *
 * An earlier version showed `60+`, `60++` and `60+++` above the target, from a
 * separate measurement of GPU busy time: `requestAnimationFrame` is vsync-paced,
 * so frame delta saturates at the refresh rate and genuinely cannot see above it,
 * and the only way to distinguish "just barely 60" from "tons of room" is to time
 * the GPU independently.
 *
 * **The instrument for that was `queue.onSubmittedWorkDone()`, and it does not
 * work for continuous measurement.** Its promise resolves on the main thread, so
 * the interval it times is GPU work PLUS however long the main thread took to get
 * around to delivering the callback -- and under load the main thread is busy
 * encoding the next frame. Samples came back bimodal: some measuring the frame,
 * some measuring the delay. At a steady physics rate of 32 the dial swung between
 * a correct mid-50s and a spurious 10, and no amount of median-filtering fixed
 * it, because the outliers were not noise around a true value -- half the samples
 * were measuring a different quantity.
 *
 * (`Orchestrator.probeFrame` uses the same call and is CORRECT to: calibration
 * awaits it in isolation with nothing else in flight, which is the one situation
 * where what it times is unambiguous.)
 *
 * The honest instrument is `timestamp-query`, which reads the GPU's own clock and
 * is immune to main-thread scheduling. It was deliberately not adopted: it needs a
 * device feature request, per-pass plumbing, a readback path, and a fallback for
 * adapters that lack it -- real complexity for a decorative refinement. A dial
 * that is right is worth more than one that is precise and wrong.
 */

/** The three bands, coldest to hottest. The order IS the severity ranking. */
export const RED = 'red';
export const YELLOW = 'yellow';
export const GREEN = 'green';

export type Band = typeof RED | typeof YELLOW | typeof GREEN;

/**
 * Band edges in measured-fps space.
 *
 * `<35` red, `35..50` yellow, `50+` green. Stated as the LOWER bound of each
 * band so `bandFor` is a single descending walk and the gaps between the ranges
 * cannot become unhandled cases.
 *
 * **THERE IS NO BLUE ANY MORE, and green runs to the top.** Blue originally
 * meant "measurably more headroom than 60 fps needs", which required timing the
 * GPU independently of the frame rate -- see the file header for why that
 * measurement was withdrawn. What was left was a band meaning "holding the frame
 * rate" sitting directly above one meaning "nearly holding it", which is a
 * distinction without a difference to anyone reading a badge: both say the app
 * is fine. Green now covers everything from 50 up.
 */
const BAND_FLOOR: readonly (readonly [Band, number])[] = Object.freeze([
  [GREEN, 50],
  [YELLOW, 35],
  [RED, 0],
]);

/** Which band a measured fps falls in. */
export function bandFor(fps: number): Band {
  for (const [band, floor] of BAND_FLOOR) {
    if (fps >= floor) return band;
  }
  return RED;
}

/**
 * What the button prints for a measured fps.
 *
 * Always a number now. The `60+`/`60++`/`60++​+` marks are gone with the headroom
 * estimate that produced them -- they claimed to distinguish degrees of spare
 * capacity, and nothing here can measure that any more.
 *
 * **CAPPED AT 60**, because that is where the measurement stops meaning
 * anything: `requestAnimationFrame` is vsync-paced, so a 144 Hz display would
 * otherwise read 144 while the simulation is deliberately budgeted for 60
 * (`progression.ts` fixes the target at 60 regardless of the panel). Printing
 * the panel's refresh rate would be reporting the monitor rather than the app.
 *
 * Rounds rather than truncating: 59.6 fps reading as "59" understates a machine
 * that is essentially holding target.
 */
export function readoutFor(fps: number): string {
  // `max(1)` so a catastrophically slow frame reads "1" rather than "0" -- zero
  // would suggest the app has stopped, which is a different failure.
  return String(Math.min(60, Math.max(1, Math.round(fps))));
}

/**
 * Frames per second from a smoothed frame interval, or NaN if there is none.
 *
 * `frameMs` is the smoothed wall-clock delta between `requestAnimationFrame`
 * callbacks. Zero means "nothing measured yet" -- `main.ts` zeroes it for the
 * whole of a restart's warmup -- and that is NOT the same as zero fps, which
 * would render as a red "1" and raise an alarm about the absence of data.
 * `stepBand` holds its previous reading when it sees a NaN.
 */
export function fpsFrom(frameMs: number): number {
  return frameMs > 0 ? 1000 / frameMs : Number.NaN;
}

/**
 * The debounce: what it governs, and -- just as important -- what it does not.
 *
 * ## Only the COLOUR is debounced
 *
 * **The number is never held back.** It is a measurement of what the user is
 * watching, and staleness there is simply wrong information: if the app drops to
 * 24 fps the badge must say 24, right away, whatever the colour is still
 * deciding. The colour is what would distract -- a large change in the corner of
 * the eye -- and it is the only thing this delays.
 *
 * ## Why hysteresis AND a dwell time, rather than just smoothing
 *
 * Smoothing alone does not fix an edge. An EMA sitting at 50.0 with the green
 * floor at 50 still crosses back and forth on the smallest jitter, and the
 * counter flickers between yellow and green. Two mechanisms, because they solve
 * different halves:
 *
 *   - **A margin** (`MARGIN_FPS`) means leaving a band requires clearing its
 *     edge by a real amount, not by 0.1. This kills edge-sitting.
 *   - **A dwell** (`DWELL_MS`) means the new band has to hold for a while before
 *     it is adopted. This kills brief spikes -- a GC pause, another tab waking
 *     up, the user dragging a slider through an expensive value.
 *
 * A change must satisfy BOTH. With the dwell now short, the margin carries most
 * of the anti-flicker work; it is what stops a reading parked on a band edge
 * from oscillating however briefly the dwell waits.
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
 * 250 ms: long enough to swallow a single bad frame or a GC pause, short enough
 * that the colour tracks what the user is doing rather than lagging visibly
 * behind it. Someone dragging World Size should see the badge answer while their
 * hand is still on the slider.
 *
 * **Down from 3 seconds**, which was tuned for a version where the NUMBER was
 * debounced along with the colour and staleness was therefore very costly. Now
 * that the number is never held back (see `stepBand`), the dwell only has to
 * protect against flicker -- and `MARGIN_FPS` already does most of that job,
 * since a reading has to clear a band edge by 3 fps before the clock even
 * starts.
 *
 * **THIS COMPOSES WITH THE CALLER'S AVERAGING WINDOW.** `main.ts` feeds this a
 * mean over its own 250 ms of frames, so a step change takes that long to move
 * the input and then this long to be adopted -- up to half a second before the
 * colour settles. That is the intended total: the number tracks immediately
 * throughout, and only the fill waits. Shortening one without the other buys
 * little, since whichever remains sets the floor.
 */
const DWELL_MS = 250;

/**
 * The band a fresh counter starts in.
 *
 * **GREEN, and it must agree with `INITIAL_FPS`.** Nothing has been measured
 * when the badge first paints, so the opening state is a guess -- and the
 * optimistic guess is the right one: a red badge claiming the GPU is struggling,
 * before anything has been timed, is a false alarm on the one impression that
 * matters most.
 *
 * Green is the top band now, so it is both the optimistic guess and the band the
 * initial "60" readout actually falls in.
 */
export const INITIAL_BAND: Band = GREEN;

/** What a fresh counter shows: the target rate, matching `INITIAL_BAND`. */
const INITIAL_FPS = 60;

/** A counter's starting state. See `INITIAL_BAND` for why it is optimistic. */
export function startBand(): BandState {
  return Object.freeze({
    band: INITIAL_BAND,
    readout: readoutFor(INITIAL_FPS),
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
 * ## The readout and the band move on DIFFERENT schedules
 *
 * The number is written on every call; the colour is debounced. That asymmetry
 * is the whole shape of the function: a measurement the user can check against
 * what they are watching must never lag, while the colour is a large visual
 * change that should only move on sustained evidence.
 *
 * `now` is injected rather than read from `performance` so the dwell is testable
 * without waiting on a real clock.
 */
export function stepBand(
  state: BandState,
  fps: number,
  now: number,
  /**
   * Adopt a new band the instant it clears the margin, skipping the dwell.
   *
   * **FOR WHILE THE USER IS DRAGGING A PERFORMANCE SLIDER.** The dwell exists so
   * the colour does not flicker in the corner of the eye while someone is
   * watching the artwork -- but during a drag on Physics Rate or Motion Blur
   * they are looking straight at the control and asking what it costs, and a
   * colour that lags a quarter second behind the handle answers for where the
   * slider was rather than where it is. `ui/perfLabels.ts`'s `watchPerfDrag`
   * decides when this holds.
   *
   * The MARGIN still applies. Only the dwell is skipped: a reading must still
   * clear the band edge by `MARGIN_FPS` to count, so this makes the colour
   * prompt without making it jittery at a boundary.
   */
  immediate = false,
): BandState {
  // NOTHING MEASURED THIS FRAME -- see `fpsFrom`. Hold everything: a comparison
  // against NaN is false in both directions, so letting one through would
  // silently take whichever branch happened to be the `else`.
  if (!Number.isFinite(fps)) return state;

  const target = bandFor(fps);
  const next = advanceBand(state, target, fps, now, immediate);

  // **THE NUMBER IS WRITTEN ON EVERY CALL.** `advanceBand` only touches the
  // readout when it actually adopts a new band, which is not often enough --
  // the measurement has to move whether or not the colour did. Applied last, on
  // top of whatever came back.
  const readout = readoutFor(fps);
  if (readout === next.readout) return next;
  return Object.freeze({ ...next, readout });
}

/**
 * The band half of `stepBand`: hysteresis plus dwell, and nothing else.
 *
 * Split out so the readout rule above reads as one statement rather than being
 * threaded through four branches. The `readout` it writes is immediately
 * overridden by the caller; it is set here only so an adopted band never carries
 * a stale one even for an instant.
 */
function advanceBand(
  state: BandState,
  target: Band,
  fps: number,
  now: number,
  immediate: boolean,
): BandState {
  // Already in the target band: cancel any pending change and leave the colour
  // alone. The readout is the caller's business.
  if (target === state.band) {
    return state.pending === null
      ? state
      : Object.freeze({ ...state, pending: null, pendingSince: 0 });
  }

  // Not yet clear of the current band by the margin: treat it as noise. Which
  // direction the margin applies in depends on which way we are moving, so it is
  // measured against the CURRENT band's own edges rather than the target's.
  //
  // **CHECKED EVEN WHEN `immediate`.** The margin is what stops a reading parked
  // on a band edge from oscillating; skipping it during a drag would trade a
  // lagging colour for a strobing one, which is worse in exactly the moment the
  // user is watching most closely.
  if (!clearsMargin(state.band, fps)) {
    return state.pending === null
      ? state
      : Object.freeze({ ...state, pending: null, pendingSince: 0 });
  }

  // A new candidate. During a drag it is adopted on the spot; otherwise its
  // clock starts and the dwell decides.
  if (!immediate && state.pending !== target) {
    return Object.freeze({ ...state, pending: target, pendingSince: now });
  }

  // The same candidate as last time -- has it held long enough?
  if (!immediate && now - state.pendingSince < DWELL_MS) return state;

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
  // ceiling, so nothing can ever be "above" green.
  const ceiling = index <= 0 ? Number.POSITIVE_INFINITY : BAND_FLOOR[index - 1]![1];
  return [floor, ceiling];
}

/**
 * The three colours, as pale fills over a dark chrome.
 *
 * PALE, as the brief asks: this sits over the artwork permanently, and a
 * saturated badge would compete with the picture it is reporting on. These are
 * high-lightness, low-chroma versions of hues the rest of the interface already
 * uses, tuned to sit at a similar weight to one another.
 */
export const BAND_COLOR: Readonly<Record<Band, string>> = Object.freeze({
  [RED]: '#f5a3a3',
  [YELLOW]: '#f2d9a0',
  [GREEN]: '#a8dcb0',
});

/**
 * The same three hues, saturated for use on a SLIDER LABEL.
 *
 * **A second ramp, and it is not redundant.** The badge sits on a dark chrome
 * plate over the artwork, where pale is right -- a saturated badge would compete
 * with the picture. A slider label sits in a panel beside a column of OTHER
 * labels already drawn in a light grey (`rgba(232,232,234,0.7)`), and against
 * that neighbour the pale ramp is nearly invisible: the two are within a few
 * percent of the same lightness, so a screenshot of the Preferences tab showed
 * World Size, Physics Rate and Motion Blur looking essentially untinted.
 *
 * That was only ever going to be caught by looking at it. A browser check
 * asserting that an inline colour is PRESENT would have passed -- "present but
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
});

/**
 * The tooltip for each band.
 *
 * Red and yellow deliberately share one string: both mean "the GPU is not
 * keeping up", and the advice for the two is identical. Splitting them would
 * mean inventing a distinction the user cannot act on differently.
 *
 * **GREEN CARRIES WHAT BLUE USED TO SAY.** With blue gone, green is the top band
 * -- it means the frame rate is holding, so the useful thing to tell someone is
 * that there may be room to turn settings UP. The old green copy ("well
 * utilized") described a narrow strip just below a band that no longer exists,
 * and offered no action at all.
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
    'Fluoddity can be demanding, but it looks like your GPU can handle it! Try ' +
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
  [GREEN]: 'holding the frame rate',
});
