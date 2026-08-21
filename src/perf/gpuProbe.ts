/**
 * GPU busy time, sampled from the frame loop.
 *
 * ## Why this exists at all, and why the obvious thing does not work
 *
 * `main.ts` already times two things, and NEITHER is GPU time:
 *
 *   - `frameMs` is wall-clock delta between rAF callbacks. Vsync-capped, so it
 *     saturates at the refresh rate and cannot see how much room is left.
 *   - `orchestratorMs` is wall time around `orchestrator.frame()`. That is
 *     CPU-side ENCODING cost -- `submit` queues a command buffer and returns
 *     without waiting -- so it barely moves as GPU load changes.
 *
 * `Orchestrator.probeFrame` already states this in full and reaches the same
 * conclusion for calibration: `onSubmittedWorkDone()` is the thing that actually
 * waits for the GPU. This module is that instrument, adapted from a one-shot
 * measurement into a continuous one.
 *
 * ## Sampling, and why it is not every frame
 *
 * Awaiting the queue fence stalls the pipeline: the CPU stops feeding the GPU
 * until the outstanding work drains, which costs a little of exactly the
 * throughput this is trying to measure. Doing it every frame would be an
 * observer that changes what it observes, on every single frame, forever.
 *
 * So it samples -- one frame in `SAMPLE_INTERVAL`, about three times a second.
 * The cost is confined to those frames, the readout is a median over a rolling
 * window so a single stalled sample cannot swing the band, and the 19 frames
 * between samples run completely untouched.
 *
 * ## What it measures, and what it therefore excludes
 *
 * From `submit` to the fence resolving: everything the frame asked the GPU to
 * do -- physics, camera, blur, bloom, assembly. It does NOT include the
 * browser's own compositing of the finished canvas, which happens after and is
 * outside any API this page can reach.
 *
 * That omission is why the headroom estimate is presented as `+` marks rather
 * than as a frame rate -- see `fpsBand.ts`. It is also the conservative
 * direction: unmeasured work can only mean LESS headroom than reported, and the
 * band edges were chosen with that in mind.
 */

/**
 * Frames between samples. ~3 samples a second at 60 fps.
 *
 * Chosen so the stall is rare enough to be invisible while the window still
 * refills within a few seconds of a real change -- `WINDOW` samples at this rate
 * is about a two-second memory, which sits comfortably inside the band debounce
 * that consumes it.
 */
const SAMPLE_INTERVAL = 20;

/**
 * Samples kept for the median.
 *
 * Seven, for `calibrate.ts`'s reasoning at a smaller size: a single bad sample
 * -- a GC pause, another tab waking up -- must not be able to move the readout,
 * and a median over an odd count is thoroughly insensitive to one or two
 * outliers while staying cheap to sort.
 */
const WINDOW = 7;

/**
 * A rolling estimate of how long the GPU spends on one frame.
 *
 * Owned by `main.ts` and driven from the frame loop. Holds no GPU resources of
 * its own -- it only borrows the device's queue -- so there is nothing to
 * dispose.
 */
export class GpuProbe {
  private readonly device: GPUDevice;

  /** Frames since the last sample was STARTED. */
  private countdown = 0;

  /**
   * True while a fence is outstanding.
   *
   * Without this a slow GPU -- the exact case worth measuring -- would have
   * several probes in flight at once, each awaiting a queue that the others are
   * also waiting on. They would all resolve together and report the wall time of
   * the whole pile-up rather than of one frame.
   */
  private inFlight = false;

  private readonly samples: number[] = [];

  /** Injected for tests, and so the clock matches the one the caller uses. */
  private readonly now: () => number;

  constructor(device: GPUDevice, now: () => number = () => performance.now()) {
    this.device = device;
    this.now = now;
  }

  /**
   * Offer this frame as a sample. Cheap and synchronous on the frames it skips.
   *
   * **CALLED AFTER `orchestrator.frame()` HAS SUBMITTED.** The fence covers work
   * already queued, so calling it before submission would time an empty queue
   * and report near-zero -- which reads as infinite headroom, the most wrong
   * answer available.
   *
   * Fire-and-forget: the frame loop is synchronous and must not await anything,
   * so the result lands in `samples` whenever it lands and is read by whichever
   * later frame asks for it.
   */
  sample(): void {
    if (this.countdown > 0) {
      this.countdown--;
      return;
    }
    if (this.inFlight) return;

    this.countdown = SAMPLE_INTERVAL;
    this.inFlight = true;
    const started = this.now();

    void this.device.queue
      .onSubmittedWorkDone()
      .then(() => {
        this.push(this.now() - started);
      })
      .catch(() => {
        // A lost device is the realistic cause, and `main.ts` already stops the
        // loop on that. Nothing here is worth reporting: a missing sample means
        // the readout keeps its previous value, which is the right failure.
      })
      .finally(() => {
        this.inFlight = false;
      });
  }

  /** Keep the window at `WINDOW`, oldest out first. */
  private push(ms: number): void {
    this.samples.push(ms);
    if (this.samples.length > WINDOW) this.samples.shift();
  }

  /**
   * Median GPU frame time in ms, or 0 before enough samples have landed.
   *
   * **Zero means "no reading", and callers must treat it as such** --
   * `estimateFps` degrades to the measured frame rate on a zero, which is the
   * conservative direction. Returning a made-up number instead would put the
   * counter in whatever band the guess implied, silently.
   *
   * Waits for a HALF-FULL window rather than a single sample: the first sample
   * after startup lands while pipelines are still warming and reads high, and
   * publishing it would flash a red badge before the app has settled.
   */
  get frameMs(): number {
    if (this.samples.length < Math.ceil(WINDOW / 2)) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  }

  /**
   * Drop every sample, so the next reading is built from scratch.
   *
   * For the state changes that make the window meaningless rather than merely
   * stale: a world-size rebuild, coming back from a hidden tab, the end of an
   * export. Keeping samples across those would blend two different simulations'
   * costs into one median and report a number that was never true of either.
   */
  reset(): void {
    this.samples.length = 0;
    this.countdown = 0;
  }
}
