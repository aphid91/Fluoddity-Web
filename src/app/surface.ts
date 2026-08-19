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
  /**
   * Constrain the canvas to `aspect` (width/height), or null to fill the
   * viewport again.
   *
   * **FOR RECORDING, AND CSS-ONLY.** While an export runs, the video holds a
   * crop of the window with its own aspect; the canvas meanwhile still fills the
   * viewport, so the preview shows the world composed for the WINDOW's shape
   * while the file holds something differently shaped. The picture on screen
   * looks stretched relative to what is being written, which makes it impossible
   * to judge a recording as it happens.
   *
   * Shrinking the ELEMENT to the recording's aspect fixes that at the source:
   * the crop then fills the canvas exactly, and what you see is what you get.
   *
   * Nothing about the render path changes. This sets `style.width/height`, the
   * `ResizeObserver` below sees the new element size, and the backing store
   * follows exactly as it does for a browser resize -- which the whole pipeline
   * already handles every frame. The three aspect quantities in this file's
   * header keep their meanings; only `window_size` moves, and moving is what it
   * does.
   */
  setAspectLock(aspect: number | null): void;
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
    setAspectLock: (aspect) => {
      if (aspect === null || !Number.isFinite(aspect) || aspect <= 0) {
        // Back to the stylesheet's `width:100%; height:100%`. Clearing the
        // inline properties rather than reasserting those values keeps
        // `index.html` the single place the default geometry is stated.
        canvas.style.removeProperty('width');
        canvas.style.removeProperty('height');
        canvas.style.removeProperty('margin');
        return;
      }

      // Fit the largest box of this aspect inside the viewport, and centre it.
      // Measured from the PARENT rather than from `canvas.getBoundingClientRect`,
      // which is the box being changed -- reading it here would compound the
      // previous lock into the next one and walk the canvas smaller on every
      // call.
      const parent = canvas.parentElement;
      const availW = parent?.clientWidth ?? window.innerWidth;
      const availH = parent?.clientHeight ?? window.innerHeight;

      const byWidth = availW / aspect <= availH;
      const w = byWidth ? availW : availH * aspect;
      const h = byWidth ? availW / aspect : availH;

      canvas.style.width = `${Math.floor(w)}px`;
      canvas.style.height = `${Math.floor(h)}px`;
      // Centres in both axes. The canvas is a block in a full-height body, so
      // `auto` horizontal margins centre it across and the vertical remainder is
      // split explicitly -- `auto` does not centre vertically in flow layout.
      canvas.style.margin = `${Math.max(0, Math.floor((availH - h) / 2))}px auto`;
    },
    dispose: () => observer.disconnect(),
  };
}
