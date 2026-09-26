/**
 * Per-pass GPU timings, for the `?debug` overlay.
 *
 * Frame time says how slow a frame is; this says WHERE. Every pass that spreads
 * `timestampWrites(label)` into its descriptor gets a begin/end timestamp pair,
 * and the durations are summed per label per frame -- so `entity-update` reads
 * as the total over all physics sub-steps, which is the number that matters
 * when deciding what to optimise.
 *
 * ## Off unless asked for
 *
 * Needs the optional `timestamp-query` feature, and only runs when
 * `enablePassTimer` has been called (main.ts does so for `?debug`). When off,
 * `timestampWrites` returns `undefined`, which a pass descriptor treats exactly
 * like the field being absent.
 *
 * ## Chrome quantises timestamps
 *
 * To 100 us by default, as a timing-attack mitigation. Fine for passes costing
 * milliseconds; for sub-100 us passes launch Chrome with
 * `--enable-dawn-features=allow_unsafe_apis` or turn on
 * chrome://flags/#enable-webgpu-developer-features.
 *
 * ## Readback without stalling
 *
 * Results are copied into one of a few mappable buffers and read whenever the
 * map resolves, a frame or two later. A frame that finds no free buffer simply
 * goes untimed -- a skipped sample, never a stall.
 */

/** Timestamp slots per frame: two per pass. Generous for ~20 sub-steps x 3 passes plus rendering. */
const MAX_QUERIES = 1024;
const READBACK_BUFFERS = 3;
/** Smoothing for the displayed averages, like the overlay's frame time. */
const SMOOTHING = 0.1;

interface Readback {
  buffer: GPUBuffer;
  busy: boolean;
}

class PassTimer {
  private readonly querySet: GPUQuerySet;
  private readonly resolveBuffer: GPUBuffer;
  private readonly readbacks: Readback[] = [];

  /** Labels for this frame's passes, in query-pair order. */
  private labels: string[] = [];
  /** The readback this frame will land in, or null if the frame is untimed. */
  private current: Readback | null = null;
  /** Labels (with their query pairs) for each readback in flight. */
  private readonly inFlight = new Map<Readback, string[]>();

  readonly averages = new Map<string, number>();
  /** Whole-frame GPU time: sum of every timed pass. */
  total = 0;

  constructor(device: GPUDevice) {
    this.querySet = device.createQuerySet({ type: 'timestamp', count: MAX_QUERIES });
    this.resolveBuffer = device.createBuffer({
      label: 'pass-timer-resolve',
      size: MAX_QUERIES * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    for (let i = 0; i < READBACK_BUFFERS; i++) {
      this.readbacks.push({
        buffer: device.createBuffer({
          label: `pass-timer-readback-${i}`,
          size: MAX_QUERIES * 8,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        }),
        busy: false,
      });
    }
  }

  beginFrame(): void {
    this.labels = [];
    this.current = this.readbacks.find((r) => !r.busy) ?? null;
  }

  writes(label: string): GPUComputePassTimestampWrites | undefined {
    if (this.current === null) return undefined;
    const pair = this.labels.length;
    if ((pair + 1) * 2 > MAX_QUERIES) return undefined;
    this.labels.push(label);
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: pair * 2,
      endOfPassWriteIndex: pair * 2 + 1,
    };
  }

  resolve(encoder: GPUCommandEncoder): void {
    const target = this.current;
    if (target === null || this.labels.length === 0) {
      this.current = null;
      return;
    }
    const count = this.labels.length * 2;
    encoder.resolveQuerySet(this.querySet, 0, count, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, target.buffer, 0, count * 8);
    target.busy = true;
    this.inFlight.set(target, this.labels);
  }

  /** Call AFTER submit: mapAsync may not run while the writing encoder is open. */
  afterSubmit(): void {
    const target = this.current;
    this.current = null;
    if (target === null) return;
    const labels = this.inFlight.get(target);
    if (labels === undefined) return;
    const bytes = labels.length * 16;
    target.buffer.mapAsync(GPUMapMode.READ, 0, bytes).then(
      () => {
        const stamps = new BigUint64Array(target.buffer.getMappedRange(0, bytes).slice(0));
        target.buffer.unmap();
        target.busy = false;
        this.inFlight.delete(target);
        this.accumulate(labels, stamps);
      },
      () => {
        // Device lost or destroyed; nothing to read.
        target.busy = false;
        this.inFlight.delete(target);
      },
    );
  }

  private accumulate(labels: readonly string[], stamps: BigUint64Array): void {
    const frame = new Map<string, number>();
    let total = 0;
    labels.forEach((label, i) => {
      const begin = stamps[i * 2] ?? 0n;
      const end = stamps[i * 2 + 1] ?? 0n;
      // Some drivers occasionally report end < begin (or zeros); drop those.
      const ms = end > begin ? Number(end - begin) / 1e6 : 0;
      frame.set(label, (frame.get(label) ?? 0) + ms);
      total += ms;
    });
    // A label absent this frame decays toward zero rather than freezing.
    for (const label of this.averages.keys()) if (!frame.has(label)) frame.set(label, 0);
    for (const [label, ms] of frame) {
      const prev = this.averages.get(label);
      this.averages.set(label, prev === undefined ? ms : prev + (ms - prev) * SMOOTHING);
    }
    this.total += (total - this.total) * SMOOTHING;
  }
}

let timer: PassTimer | null = null;

/** Whether the adapter can do it: request this feature at device creation. */
export const PASS_TIMER_FEATURE: GPUFeatureName = 'timestamp-query';

/** Turn timing on. A no-op (returns false) if the device lacks timestamp queries. */
export function enablePassTimer(device: GPUDevice): boolean {
  if (!device.features.has(PASS_TIMER_FEATURE)) return false;
  timer ??= new PassTimer(device);
  return true;
}

/** Call once per frame, before any timed pass is encoded. */
export function beginTimedFrame(): void {
  timer?.beginFrame();
}

/** Spread into a compute or render pass descriptor: `timestampWrites: timestampWrites('x')`. */
export function timestampWrites(label: string): GPUComputePassTimestampWrites | undefined {
  return timer?.writes(label);
}

/** Call on the frame's encoder just before `finish()`. */
export function resolveTimedFrame(encoder: GPUCommandEncoder): void {
  timer?.resolve(encoder);
}

/** Call just after the frame's `queue.submit`. */
export function afterTimedSubmit(): void {
  timer?.afterSubmit();
}

/** Smoothed ms per label, largest first, plus the total. Null when timing is off. */
export function passTimings(): { total: number; passes: [string, number][] } | null {
  if (timer === null) return null;
  const passes = [...timer.averages].sort((a, b) => b[1] - a[1]);
  return { total: timer.total, passes };
}
