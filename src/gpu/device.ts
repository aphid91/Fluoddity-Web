/**
 * WebGPU adapter and device acquisition.
 *
 * The desktop analogue is `app_window/app_window.py`, which owns GLFW init and
 * the moderngl context. Per invariant 4 the `ctx` is the one sanctioned shared
 * substrate, created once and injected into every module at construction; the
 * `GPUDevice` plays exactly that role here.
 *
 * This module is a stateless helper in the `shared/` sense (invariant 1): it
 * holds no domain state.
 */

/**
 * Thrown when WebGPU cannot be used at all. `reason` distinguishes the two
 * causes, because they need different things from the user: `no-api` means the
 * browser lacks WebGPU entirely (update or switch browsers), while
 * `no-adapter` means the browser has it but no usable GPU was offered (often a
 * headless/VM/blocklisted-driver situation).
 */
export class WebGPUUnavailable extends Error {
  readonly reason: 'no-api' | 'no-adapter' | 'no-device';

  constructor(reason: 'no-api' | 'no-adapter' | 'no-device', message: string) {
    super(message);
    this.name = 'WebGPUUnavailable';
    this.reason = reason;
  }
}

export interface GpuContext {
  adapter: GPUAdapter;
  device: GPUDevice;
}

/**
 * The limits world size spends, each raised from its default to whatever the
 * adapter actually offers.
 *
 * WHY THIS EXISTS AT ALL
 * A device requested with no `requiredLimits` gets the WebGPU *defaults*, which
 * are a guaranteed floor, not what the hardware can do -- a discrete GPU that
 * reports 2 GiB of storage binding still hands you 128 MiB unless you ask. That
 * default silently capped world size at 6.9905, and the failure was invisible:
 * the entity buffer ALLOCATES fine (`maxBufferSize` is a roomier 256 MiB), then
 * `createBindGroup` fails validation, every later `submit()` is rejected, and
 * the canvas holds its last good frame forever. A permanent black screen that
 * looks like a physics bug.
 *
 * Three limits bind as world size grows, in this order. The world sizes are for
 * the DEFAULTS, and are what each request buys headroom past:
 *
 * - `maxStorageBufferBindingSize` (128 MiB) -- the entity buffer is bound whole,
 *   at 32 bytes per entity. Hit first, at world size 6.99.
 * - `maxBufferSize` (256 MiB) -- the same buffer's allocation. Hit at 13.98.
 * - `maxTextureDimension2D` (8192) -- the trail canvas edge is 1024*sqrt(size),
 *   so this is the ceiling on RESOLUTION rather than particle count. Hit at 64.
 *
 * Asking for the adapter's own value can never fail: `requestDevice` rejects a
 * limit HIGHER than the adapter's, and every one of these is read straight off
 * `adapter.limits`. Requesting them does not allocate anything -- it only
 * declines the browser's offer to cap us below the hardware.
 *
 * Deliberately NOT clamped to some supported world size. Per the decision to
 * trust the user's input, this buys the largest budget the machine can give and
 * leaves the spending to them; a request beyond it still fails loudly at buffer
 * creation rather than being silently rounded down.
 */
function worldSizeLimits(adapter: GPUAdapter): Record<string, number> {
  return {
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maxBufferSize: adapter.limits.maxBufferSize,
    maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
  };
}

/**
 * Acquire an adapter and device.
 *
 * Throws `WebGPUUnavailable` rather than returning null: there is no meaningful
 * degraded mode for "no GPU at all", and the caller's job is to show the
 * message. This is distinct from *shader compilation* failure, which is
 * non-fatal by invariant 5 -- see `compileModule`.
 *
 * The device is requested with `worldSizeLimits` raised to the adapter's own
 * maxima; see that function for which limits world size spends and why the
 * defaults are not enough.
 *
 * `onLost` fires if the device is lost later. We deliberately do NOT
 * auto-recreate the device: during the port a loss is a bug worth seeing, not
 * something to paper over with a silent restart.
 */
export async function acquireDevice(onLost?: (info: GPUDeviceLostInfo) => void): Promise<GpuContext> {
  if (!('gpu' in navigator) || navigator.gpu === undefined) {
    throw new WebGPUUnavailable(
      'no-api',
      'This browser does not support WebGPU. Try a current version of Chrome, Edge, or Safari 26+.',
    );
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) {
    throw new WebGPUUnavailable(
      'no-adapter',
      'WebGPU is present but no compatible GPU adapter was available. ' +
        'This usually means a blocklisted driver, a headless session, or a VM without GPU passthrough.',
    );
  }

  let device: GPUDevice;
  try {
    device = await adapter.requestDevice({ requiredLimits: worldSizeLimits(adapter) });
  } catch (err) {
    throw new WebGPUUnavailable('no-device', `Requesting a GPU device failed: ${String(err)}`);
  }

  // `device.lost` resolves rather than rejects, including on normal teardown;
  // `reason === 'destroyed'` is the deliberate case and is not an error.
  void device.lost.then((info) => {
    if (info.reason === 'destroyed') return;
    console.error(`WebGPU device lost (${info.reason}): ${info.message}`);
    onLost?.(info);
  });

  // Uncaptured validation errors are otherwise easy to miss in a rAF loop.
  device.addEventListener('uncapturederror', (event) => {
    console.error('WebGPU uncaptured error:', (event as GPUUncapturedErrorEvent).error.message);
  });

  return { adapter, device };
}

/**
 * Show a readable failure message over the page.
 *
 * The plan's requirement is explicit: a clear "WebGPU unavailable" message, not
 * a blank canvas. A black canvas is a *successful* frame in this app, so a
 * silent failure would be indistinguishable from working correctly.
 */
export function showUnavailableOverlay(title: string, detail: string): void {
  const existing = document.getElementById('gpu-error');
  existing?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'gpu-error';
  overlay.setAttribute('role', 'alert');

  const heading = document.createElement('h1');
  heading.textContent = title;

  const body = document.createElement('p');
  body.textContent = detail;

  overlay.append(heading, body);
  document.body.append(overlay);
}
