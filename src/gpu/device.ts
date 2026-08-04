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
 * Acquire an adapter and device.
 *
 * Throws `WebGPUUnavailable` rather than returning null: there is no meaningful
 * degraded mode for "no GPU at all", and the caller's job is to show the
 * message. This is distinct from *shader compilation* failure, which is
 * non-fatal by invariant 5 -- see `compileModule`.
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
    device = await adapter.requestDevice();
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
