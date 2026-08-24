/**
 * Drag a rectangle to choose what the share image shows.
 *
 * Plain DOM, following `mutationOverlay.ts` and `menuBar.ts` -- UI that has
 * outgrown Tweakpane lives as elements the panel owns.
 *
 * ## THE DUMMY SQUARE IS THE POINT OF THE WHOLE OVERLAY
 *
 * The stamp is a FIXED number of pixels: `qrStamp.ts` explains at length why it
 * cannot simply be scaled to taste, and `shareImage.ts` refuses to stamp a crop
 * that cannot hold one. That makes the minimum size a real constraint the user
 * has to be told about, and the honest way to tell them is to SHOW the square
 * while they drag rather than to reject the selection afterwards.
 *
 * So the preview square is not decoration. It is the constraint, drawn.
 *
 * ## THE MINIMUM IS ENFORCED THREE TIMES, AND THAT IS NOT REDUNDANCY
 *
 * The rectangle can be smaller than the stamp WHILE dragging -- clamping the
 * live rectangle would make the mouse and the box disagree, which reads as a
 * broken drag rather than as a limit. Instead:
 *
 *   1. while dragging, an undersized box is drawn in a REFUSING colour and the
 *      readout says what is short;
 *   2. on release, an undersized box is GROWN to the minimum around its own
 *      centre rather than rejected -- the user's intent was clear and the
 *      correction is visible in the result;
 *   3. `stampShareImage` still throws if something got through, because a
 *      silently unreadable stamp is the one outcome the feature cannot ship.
 *
 * Each layer catches what the one before it cannot, and only the third is a
 * safety net rather than a feature.
 *
 * ## DEVICE PIXELS ARE THE CURRENCY, CSS PIXELS ARE THE INTERFACE
 *
 * The stamp's minimum is in DEVICE pixels, because that is what survives a
 * platform's resize. Pointer events are in CSS pixels. On a 2x display those
 * differ by a factor of two, so a naive comparison would let a user on a HiDPI
 * screen select a region half the size they needed and get a stamp that fails
 * for a reason invisible on their machine. Every comparison below converts
 * first; `ratio` is read once per drag so it cannot change mid-gesture.
 */

/** How the overlay reports a finished drag. Rect is in CSS pixels. */
export interface CropSelection {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CropOverlayOptions {
  /**
   * Minimum crop side in DEVICE pixels, from `minimumCropFor`.
   *
   * Passed in rather than computed here because it depends on the payload, and
   * the payload depends on the live project -- the overlay must not have an
   * opinion about either.
   */
  readonly minDevicePx: number;
  /** Stamp side in DEVICE pixels, for the preview square. */
  readonly stampDevicePx: number;
  /** Stamp inset in DEVICE pixels, so the preview sits where the stamp will. */
  readonly insetDevicePx: number;
}

const ROOT_CSS = `
  position: fixed;
  inset: 0;
  z-index: 9000;
  cursor: crosshair;
  background: rgba(0, 0, 0, 0.35);
  touch-action: none;
`;

/**
 * The selection box.
 *
 * `box-shadow` with a huge spread is the trick that dims everything OUTSIDE the
 * selection without a second element or a canvas: the shadow paints outward
 * from the box, and the root's own dim is what it lands on. Two overlapping
 * translucent layers would double-darken at the edges; this does not.
 */
const BOX_CSS = `
  position: absolute;
  border: 1px solid #fff;
  box-shadow: 0 0 0 100vmax rgba(0, 0, 0, 0.45);
  pointer-events: none;
`;

/** The stamp preview: a dashed square where the QR will actually land. */
const STAMP_CSS = `
  position: absolute;
  border: 2px dashed rgba(255, 255, 255, 0.9);
  background: rgba(255, 255, 255, 0.14);
  pointer-events: none;
  box-sizing: border-box;
`;

const HINT_CSS = `
  position: absolute;
  padding: 4px 8px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.8);
  color: #fff;
  font: 12px system-ui, sans-serif;
  white-space: nowrap;
  pointer-events: none;
`;

const BANNER_CSS = `
  position: fixed;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 14px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.82);
  color: #fff;
  font: 13px system-ui, sans-serif;
  pointer-events: none;
`;

/** Refusing red, for a selection that is currently too small to stamp. */
const TOO_SMALL = 'rgba(255, 96, 96, 0.95)';

/**
 * Run one crop gesture.
 *
 * Resolves with the selection, or `null` if the user cancelled -- Escape, a
 * right-click, or a click without a drag. A promise rather than a callback pair
 * because the caller's flow is strictly sequential (pick a region, then stamp
 * it) and `await` states that better than two handlers.
 *
 * SELF-CONTAINED: it mounts its own elements, binds its own listeners, and
 * removes all of them before resolving, so a cancelled gesture leaves nothing
 * behind and a second call cannot collide with a first.
 */
export function pickCropRegion(options: CropOverlayOptions): Promise<CropSelection | null> {
  return new Promise((resolve) => {
    // READ ONCE. A drag that spanned a monitor change could otherwise compare
    // CSS pixels against a device ratio that no longer applies.
    const ratio = window.devicePixelRatio || 1;
    const minCss = options.minDevicePx / ratio;
    const stampCss = options.stampDevicePx / ratio;
    const insetCss = options.insetDevicePx / ratio;

    const root = document.createElement('div');
    root.style.cssText = ROOT_CSS;

    const box = document.createElement('div');
    box.style.cssText = BOX_CSS;
    box.style.display = 'none';

    const stamp = document.createElement('div');
    stamp.style.cssText = STAMP_CSS;
    stamp.style.display = 'none';

    const hint = document.createElement('div');
    hint.style.cssText = HINT_CSS;
    hint.style.display = 'none';

    const banner = document.createElement('div');
    banner.style.cssText = BANNER_CSS;
    banner.textContent =
      `Drag to choose the shareable area — at least ${Math.ceil(minCss)}px on each side. Esc to cancel.`;

    root.append(box, stamp, hint);
    document.body.append(root, banner);

    let startX = 0;
    let startY = 0;
    let dragging = false;
    let current: CropSelection | null = null;

    const rectFrom = (x: number, y: number): CropSelection => ({
      x: Math.min(startX, x),
      y: Math.min(startY, y),
      width: Math.abs(x - startX),
      height: Math.abs(y - startY),
    });

    const draw = (rect: CropSelection): void => {
      const fits = rect.width >= minCss && rect.height >= minCss;

      box.style.display = 'block';
      box.style.left = `${rect.x}px`;
      box.style.top = `${rect.y}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
      box.style.borderColor = fits ? '#fff' : TOO_SMALL;

      // The preview only appears once it would actually fit, because a stamp
      // square larger than the box it sits in would misrepresent the result --
      // the honest signal at that size is the red border and the readout.
      const room = rect.width >= stampCss + insetCss && rect.height >= stampCss + insetCss;
      stamp.style.display = room ? 'block' : 'none';
      if (room) {
        stamp.style.left = `${rect.x + rect.width - stampCss - insetCss}px`;
        stamp.style.top = `${rect.y + rect.height - stampCss - insetCss}px`;
        stamp.style.width = `${stampCss}px`;
        stamp.style.height = `${stampCss}px`;
        stamp.style.borderColor = fits ? 'rgba(255,255,255,0.9)' : TOO_SMALL;
      }

      hint.style.display = 'block';
      // In DEVICE pixels, which is what the resulting image will actually be --
      // quoting CSS pixels would understate the capture on a HiDPI screen and
      // make the number disagree with the file the user ends up with.
      const dw = Math.round(rect.width * ratio);
      const dh = Math.round(rect.height * ratio);
      hint.textContent = fits
        ? `${dw} x ${dh}`
        : `${dw} x ${dh} — too small, will grow to ${options.minDevicePx}`;
      hint.style.color = fits ? '#fff' : TOO_SMALL;
      // Above the box, unless that would put it off the top of the window.
      const above = rect.y - 24;
      hint.style.left = `${rect.x}px`;
      hint.style.top = `${above < 4 ? rect.y + rect.height + 6 : above}px`;
    };

    /** Grow an undersized rectangle around its centre, then clamp to the window. */
    const enforce = (rect: CropSelection): CropSelection => {
      const width = Math.max(rect.width, minCss);
      const height = Math.max(rect.height, minCss);
      let x = rect.x - (width - rect.width) / 2;
      let y = rect.y - (height - rect.height) / 2;
      x = Math.max(0, Math.min(window.innerWidth - width, x));
      y = Math.max(0, Math.min(window.innerHeight - height, y));
      return { x, y, width, height };
    };

    const finish = (result: CropSelection | null): void => {
      root.remove();
      banner.remove();
      window.removeEventListener('keydown', onKey, true);
      resolve(result);
    };

    function onKey(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      // Captured and stopped: Escape is bound elsewhere in the app, and a
      // cancelled crop must not also trigger whatever that is.
      event.preventDefault();
      event.stopPropagation();
      finish(null);
    }

    root.addEventListener('pointerdown', (event: PointerEvent) => {
      // Right or middle button cancels, matching the convention that a
      // secondary click backs out of a modal gesture.
      if (event.button !== 0) {
        finish(null);
        return;
      }
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      // Captured so the drag survives the pointer leaving the window, which is
      // the common case when selecting a region that runs to the screen edge.
      root.setPointerCapture(event.pointerId);
      draw(rectFrom(event.clientX, event.clientY));
    });

    root.addEventListener('pointermove', (event: PointerEvent) => {
      if (!dragging) return;
      current = rectFrom(event.clientX, event.clientY);
      draw(current);
    });

    root.addEventListener('pointerup', (event: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      const rect = rectFrom(event.clientX, event.clientY);
      // A click with no drag is a cancel, not a zero-sized selection that then
      // gets grown into an arbitrary square.
      if (rect.width < 8 && rect.height < 8) {
        finish(null);
        return;
      }
      finish(enforce(rect));
    });

    window.addEventListener('keydown', onKey, true);
  });
}
