/**
 * The offscreen render targets: the per-sample HDR buffer and the accumulator.
 * A port of `camera.py:250-287`'s `_ensure_buffers` / `_release_buffers`.
 *
 * The bloom mip chain is sized from the same window but owned by `bloom.ts`,
 * because it allocates LAZILY -- nothing until the first `process()`, so bloom
 * left switched off costs no VRAM at all (`bloom.py:20-23`).
 *
 * ## Why polled rather than driven by a resize event
 *
 * `Surface` exposes `size()` and a `ResizeObserver`, so an event-driven rebuild
 * looks natural. It is a trap: a `ResizeObserver` callback can fire between
 * `createCommandEncoder()` and `submit()`, and destroying a texture whose view
 * is already recorded into an open encoder is a validation error. Calling
 * `ensure()` once at the top of the frame, before the encoder opens, makes that
 * impossible by construction -- and it is also exactly what the desktop does
 * (`camera.py:250`'s `_ensure_buffers` is called from `begin_frame`).
 */

/**
 * 16-bit float, 4 components. `camera.py:60-64`'s `_HDR_DTYPE = 'f2'`: half the
 * bandwidth of 32-bit, and its range (~65504) is far beyond anything the canvas
 * produces. Filterable AND blendable in base WebGPU -- no optional features,
 * which is why the port could be planned around it.
 */
export const HDR_FORMAT: GPUTextureFormat = 'rgba16float';

/**
 * Should the targets be rebuilt for this window size?
 *
 * Exported and pure so the two rules are testable without a device:
 * a zero-sized window is REFUSED rather than clamped (minimizing reports 0x0,
 * which is not a legal texture size -- the buffers are left alone and rendering
 * no-ops until the window comes back), and an unchanged size is a no-op.
 */
export function targetsNeedRebuild(
  current: readonly [number, number] | null,
  next: readonly [number, number],
): boolean {
  const [w, h] = next;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return false;
  if (current === null) return true;
  return current[0] !== w || current[1] !== h;
}

interface Target {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
}

export class RenderTargets {
  private readonly device: GPUDevice;

  private hdrTarget: Target | null = null;
  private accumTarget: Target | null = null;
  private currentSize: readonly [number, number] | null = null;

  /**
   * Linear, clamp-to-edge. The clamp is NOT incidental: the bloom chain samples
   * the accumulator with offset taps, and repeat would wrap a bright edge's
   * glow around to the opposite side of the screen (`camera.py:270-273`).
   */
  readonly sampler: GPUSampler;

  constructor(device: GPUDevice) {
    this.device = device;
    this.sampler = device.createSampler({
      label: 'hdr-linear-clamp',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
  }

  /** The size the targets are currently allocated for, or null before the first. */
  get size(): readonly [number, number] | null {
    return this.currentSize;
  }

  /** One temporal sample, redrawn from scratch every `render()` call. */
  get hdr(): GPUTextureView | null {
    return this.hdrTarget?.view ?? null;
  }

  /** The running sum of this cycle's samples, each pre-weighted by 1/N. */
  get accum(): GPUTextureView | null {
    return this.accumTarget?.view ?? null;
  }

  /**
   * Allocate or reallocate for `windowSize`. Call once per frame, BEFORE the
   * encoder opens. Returns true if anything was rebuilt, so the caller can
   * invalidate the bind groups that reference these views.
   */
  ensure(windowSize: readonly [number, number]): boolean {
    if (!targetsNeedRebuild(this.currentSize, windowSize)) return false;

    this.release();

    const [width, height] = windowSize;
    const make = (label: string): Target => {
      const texture = this.device.createTexture({
        label,
        size: { width, height },
        format: HDR_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      return { texture, view: texture.createView() };
    };

    this.hdrTarget = make('hdr');
    this.accumTarget = make('accum');
    this.currentSize = [width, height];
    return true;
  }

  /** Free the targets. Called on resize and at shutdown. */
  release(): void {
    this.hdrTarget?.texture.destroy();
    this.accumTarget?.texture.destroy();
    this.hdrTarget = null;
    this.accumTarget = null;
    this.currentSize = null;
  }
}
