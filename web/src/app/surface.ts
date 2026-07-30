/**
 * Canvas sizing and swap-chain configuration.
 *
 * The desktop analogue is `app_window/app_window.py`: it caches the framebuffer
 * size and keeps the GL viewport in step on resize.
 *
 * ===========================================================================
 * THREE INDEPENDENT ASPECT QUANTITIES
 * ===========================================================================
 * These names are carried over verbatim from `particle_system/coords.py:17-24`
 * and `docs/ARCHITECTURE.md`. They are kept identical on purpose: Steps 2-5 of
 * the port are mechanical translations of that math, and renaming here would
 * break the correspondence that makes them mechanical. Conflating the three is
 * the single biggest source of confusion in this domain.
 *
 *   canvas_size   The simulation texture's dimensions. Defines WORLD SPACE.
 *                 Changing it changes the shape of the simulated world.
 *                 NOT the <canvas> element. (Arrives in Step 2.)
 *
 *   window_size   The framebuffer's dimensions in pixels. Changes when the
 *                 user resizes the window. Must NOT move a particle.
 *
 *   letterbox     How the canvas is fitted into the window when their aspects
 *                 disagree. Derived from the two above; never stored.
 *
 * The one line the desktop does not need:
 *
 *   window_size   == canvas.width / canvas.height, the BACKING STORE size in
 *                 device pixels. NOT clientWidth/clientHeight (those are CSS
 *                 pixels), and NOT the browser window.
 *
 * On the desktop `window_size` comes from `glfw.get_framebuffer_size`, not
 * `get_window_size` -- so "window" has meant "framebuffer" all along, and the
 * browser equivalent of that distinction is CSS pixels vs device pixels.
 */

/** Framebuffer size in device pixels: the `window_size` of the desktop code. */
export type WindowSize = readonly [number, number];

export interface Surface {
  readonly canvas: HTMLCanvasElement;
  readonly context: GPUCanvasContext;
  readonly format: GPUTextureFormat;
  /** Current framebuffer size in device pixels. Never returns a zero component. */
  size(): WindowSize;
  dispose(): void;
}

/**
 * Configure a canvas for WebGPU and keep its backing store tracking the
 * element's real device-pixel size.
 */
export function createSurface(canvas: HTMLCanvasElement, device: GPUDevice): Surface {
  const context = canvas.getContext('webgpu');
  if (context === null) {
    throw new Error('Failed to acquire a WebGPU canvas context.');
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  // Cached so the render path never measures per frame -- the same reasoning as
  // the desktop's cached `_size` ("so the render path never syscalls per frame").
  let size: WindowSize = [1, 1];

  const maxDim = device.limits.maxTextureDimension2D;

  const applySize = (widthPx: number, heightPx: number): void => {
    // The desktop guards this because minimizing reports 0x0 and a zero
    // viewport is invalid. The browser has the same hazard from a different
    // cause: a `display: none` or not-yet-laid-out canvas measures 0. A
    // zero-sized texture is invalid in both APIs, so clamp to at least 1 and
    // leave the previous size in place.
    const w = Math.max(1, Math.min(maxDim, Math.floor(widthPx)));
    const h = Math.max(1, Math.min(maxDim, Math.floor(heightPx)));
    if (w === canvas.width && h === canvas.height) return;

    canvas.width = w;
    canvas.height = h;
    size = [w, h];
    // No reconfigure() needed: the swap chain follows canvas.width/height.
  };

  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      // `devicePixelContentBoxSize` is exact device pixels -- it avoids the
      // rounding error you get from multiplying a CSS size by devicePixelRatio
      // at fractional zoom levels. Not universally supported, hence the
      // fallback.
      const exact = entry.devicePixelContentBoxSize?.[0];
      if (exact !== undefined) {
        applySize(exact.inlineSize, exact.blockSize);
        continue;
      }
      const box = entry.contentBoxSize?.[0];
      const dpr = window.devicePixelRatio || 1;
      if (box !== undefined) {
        applySize(box.inlineSize * dpr, box.blockSize * dpr);
      } else {
        applySize(entry.contentRect.width * dpr, entry.contentRect.height * dpr);
      }
    }
  });

  try {
    observer.observe(canvas, { box: 'device-pixel-content-box' });
  } catch {
    // Safari historically rejects the device-pixel box option.
    observer.observe(canvas);
  }

  // Seed the size immediately: ResizeObserver's first callback is async, and
  // the first frame may render before it arrives.
  const rect = canvas.getBoundingClientRect();
  applySize(rect.width * (window.devicePixelRatio || 1), rect.height * (window.devicePixelRatio || 1));

  return {
    canvas,
    context,
    format,
    size: () => size,
    dispose: () => observer.disconnect(),
  };
}
