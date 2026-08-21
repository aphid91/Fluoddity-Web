/**
 * Auto-calibrate Physics Rate against the project the user actually has open.
 *
 * `nextStep` in `rateSearch.ts` decides WHERE to probe; this drives those probes
 * against real frames and commits the answer. The split is the one
 * `calibration/calibrate.ts` and `calibration/progression.ts` already draw, and
 * for the same reason: the decision rule is worth testing exhaustively against
 * synthetic machines, and the frame-driving half needs a browser to mean
 * anything.
 *
 * ## How this differs from first-run calibration
 *
 * `calibration/calibrate.ts` walks a fixed ladder behind the welcome splash,
 * probing a MINIMAL frame (physics only, no camera, no assembler) and resetting
 * the simulation when it commits. That is right for a first visit: there is no
 * project yet, nothing on screen to preserve, and the question is "what can this
 * machine broadly handle".
 *
 * This answers a different question -- "what can it handle for THIS piece, as it
 * is right now" -- so almost every one of those choices inverts:
 *
 *   - **Real frames, not probe frames.** The measurement has to include the
 *     camera, motion blur and bloom, because those are what the user has turned
 *     on and they come out of the same 16.7 ms.
 *   - **Nothing is reset.** Whatever is on screen keeps running; only the
 *     physics rate moves. A calibration that wiped the user's work to measure it
 *     would be measuring something they no longer had.
 *   - **No splash, no lock.** The simulation stays visible, which is the point:
 *     they can watch the search happen.
 *
 * ## Timing comes from the caller
 *
 * This module never reads a clock or calls `requestAnimationFrame`. `main.ts`
 * owns the frame loop and already measures frame intervals for the FPS counter,
 * so it feeds them in through `onFrame` and this decides what to do with them.
 * That keeps the whole thing driveable from a test with a synthetic clock, and
 * avoids a second frame loop racing the real one.
 */

import { type Probe, nextStep } from './rateSearch.ts';

/** Frames discarded after a rate change, before any are measured. */
const SETTLE_FRAMES = 5;

/** Frames averaged into one measurement, after the settle. */
const MEASURE_FRAMES = 15;

/**
 * A frame slower than this is a discontinuity, not a slow frame.
 *
 * The same guard the FPS counter's window uses, and for the same reason: a tab
 * that was backgrounded mid-probe, or a long task on the main thread, produces
 * an interval measured in seconds. Averaging one in would poison the probe and
 * send the search somewhere arbitrary. Discarded rather than clamped, so the
 * probe simply takes a frame or two longer.
 */
const OUTLIER_MS = 500;

/** What the caller shows while this runs. */
export interface CalibrationProgress {
  /** Which probe is running, 1-based. */
  readonly probe: number;
  /** The rate being measured right now. */
  readonly rate: number;
}

export interface AutoCalibrateOptions {
  /** The slider's own bounds, so the search cannot leave them. */
  readonly lo: number;
  readonly hi: number;
  /** Where to start. The user's current setting -- often already the answer. */
  readonly startRate: number;
  /** Apply a rate to the live simulation. Called once per probe. */
  readonly setRate: (rate: number) => void;
  /** Progress, for the button label. */
  readonly onProgress?: (progress: CalibrationProgress) => void;
}

/**
 * A calibration run in flight.
 *
 * The caller creates one, feeds it every frame interval through `onFrame`, and
 * stops when `finished` turns true. `result` is the committed rate.
 *
 * **A STATE MACHINE RATHER THAN AN ASYNC FUNCTION**, deliberately. An `await`-
 * based version would need its own rAF loop, which would race `main.ts`'s --
 * two loops both advancing the simulation, each seeing half the frames. Driving
 * it from the existing loop means the frames measured are exactly the frames the
 * user is watching.
 */
export class AutoCalibration {
  private readonly opts: AutoCalibrateOptions;
  private readonly history: Probe[] = [];

  /** Frames seen at the current rate, including the ones being discarded. */
  private seen = 0;
  /** Intervals kept for the current probe's mean. */
  private samples: number[] = [];

  private rate: number;
  private done = false;
  private committed: number | null = null;

  constructor(opts: AutoCalibrateOptions) {
    this.opts = opts;
    this.rate = Math.round(opts.startRate);
    // The first probe measures where the user already is, which is both the
    // cheapest useful sample and often the final answer.
    this.opts.setRate(this.rate);
    this.opts.onProgress?.({ probe: 1, rate: this.rate });
  }

  /** Whether the run has finished. `result` holds the answer once it has. */
  get finished(): boolean {
    return this.done;
  }

  /** The committed rate, or null while the run is still going. */
  get result(): number | null {
    return this.committed;
  }

  /** The rate currently being measured, for the progress label. */
  get probingRate(): number {
    return this.rate;
  }

  /** How many probes have completed. */
  get probeCount(): number {
    return this.history.length;
  }

  /**
   * Offer one frame interval.
   *
   * Discards the settle frames, averages the rest, and advances the search when
   * a probe completes. Cheap and synchronous -- the common frame appends one
   * number to an array.
   */
  onFrame(frameMs: number): void {
    if (this.done) return;

    this.seen++;
    // The settle: pipeline warm-up and `ensureUniformCapacity` growing the
    // uniform buffers as the rate rises (`particleSystem.ts`). `calibrate.ts`
    // discards 2 for a physics-only change; this discards more because it is
    // also measuring the full render path rather than physics alone.
    if (this.seen <= SETTLE_FRAMES) return;

    // See `OUTLIER_MS`. The frame is dropped without counting toward the probe,
    // so a stall costs a frame rather than corrupting a measurement.
    if (frameMs > 0 && frameMs < OUTLIER_MS) this.samples.push(frameMs);

    if (this.samples.length < MEASURE_FRAMES) return;

    // The probe is complete: average it, and ask the search what to do next.
    let total = 0;
    for (const ms of this.samples) total += ms;
    this.history.push({ rate: this.rate, frameMs: total / this.samples.length });

    const step = nextStep(this.history, this.opts.lo, this.opts.hi);
    if (step.kind === 'done') {
      this.committed = step.rate;
      this.done = true;
      this.opts.setRate(step.rate);
      return;
    }

    this.rate = step.rate;
    this.seen = 0;
    this.samples = [];
    this.opts.setRate(step.rate);
    this.opts.onProgress?.({ probe: this.history.length + 1, rate: step.rate });
  }

  /**
   * Abandon the run, restoring the rate the user started from.
   *
   * For the caller that needs to stop early -- an export starting, the panel
   * being disposed, the user pressing the button again.
   *
   * **RESTORES RATHER THAN COMMITTING**, which is the opposite of what
   * `calibrate.ts` does when its walk is cut short. The difference is whose
   * setting it is: first-run calibration is replacing a compiled-in default
   * nobody chose, so anything measured beats it. Here the user had a rate they
   * had picked, and the search has since moved it several times for its own
   * purposes. Committing a half-finished search would leave them at a value that
   * is neither their choice nor a finished answer -- and they cannot tell which
   * they got. Putting it back is the only unambiguous outcome.
   */
  cancel(): void {
    if (this.done) return;
    this.done = true;
    this.committed = null;
    this.opts.setRate(Math.round(this.opts.startRate));
  }
}
