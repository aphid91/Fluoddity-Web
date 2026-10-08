/**
 * Capture a swatch icon: drag a circle over the canvas, get a JPEG data URL.
 *
 * The studio's screenshot machinery, aimed at a circle -- `pickCropRegion` in
 * its circle mode for the gesture, `captureRegion` for the read (which owns
 * the rule that a WebGPU canvas is only readable inside a frame). This file
 * adds the two things an icon needs that a screenshot does not: a FIXED size,
 * and JPEG. See `swatchIcon.ts` for both.
 */

import { pickCropRegion } from '../ui/cropOverlay.ts';
import { captureRegion, imageToCanvas } from '../ui/shareCapture.ts';
import { ICON_JPEG_QUALITY, MIN_CAPTURE_RADIUS_CSS } from './swatchIcon.ts';

/**
 * Run one capture. Resolves with the icon as a data URL, or null when the user
 * cancelled -- Escape, a right-click, or a drag too short to count.
 *
 * `size` is the icon's side in pixels; the captured circle is scaled to it,
 * down or up.
 */
export async function captureCircleIcon(
  canvas: HTMLCanvasElement,
  size: number,
  instruction: string,
): Promise<string | null> {
  const region = await pickCropRegion({
    minDevicePx: 0,
    stampDevicePx: 0,
    insetDevicePx: 0,
    warnAboveDevicePx: 0,
    circle: { minRadiusCss: MIN_CAPTURE_RADIUS_CSS, instruction },
  });
  if (region === null) return null;

  // The overlay reports WINDOW coordinates; `captureRegion` wants them
  // relative to the canvas, which sand insets behind its sidebar and bar.
  const box = canvas.getBoundingClientRect();
  const x = region.x - box.left;
  const y = region.y - box.top;

  // CLIPPED TO THE CANVAS HERE, not left to `captureRegion`. Its clamp moves a
  // region that starts off the canvas without shortening it, which would read
  // the wrong pixels; a circle hanging off an edge is ordinary here. The part
  // that misses the canvas stays black, where the user saw nothing.
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(box.width, x + region.width);
  const y1 = Math.min(box.height, y + region.height);

  const out = document.createElement('canvas');
  out.width = size;
  out.height = size;
  const ctx = out.getContext('2d');
  if (ctx === null) throw new Error('could not get a 2D context for the icon');

  // BLACK UNDERNEATH: JPEG has no alpha, and the corners outside the circle
  // are hidden by the swatch's own rounding anyway.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);

  if (x1 > x0 && y1 > y0) {
    const shot = await captureRegion(canvas, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
    const k = size / region.width;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // Clipped to the circle so the corners are really black rather than
    // whatever surrounded it -- smaller files, and nothing outside the circle
    // shows if the icon is ever drawn unrounded.
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(
      imageToCanvas(shot),
      (x0 - x) * k,
      (y0 - y) * k,
      (x1 - x0) * k,
      (y1 - y0) * k,
    );
  }

  return out.toDataURL('image/jpeg', ICON_JPEG_QUALITY);
}

/**
 * An icon as a data URL, fetching it if it is a link.
 *
 * For saving a world: an icon that came from the world pack is a URL into the
 * pack folder, which the next export may empty. Saved inline, the library
 * world keeps its pictures whatever happens to the pack. An icon that cannot
 * be fetched is kept as it was rather than lost.
 */
export async function inlineIcon(icon: string): Promise<string> {
  if (icon.startsWith('data:')) return icon;
  try {
    const res = await fetch(icon);
    if (!res.ok) return icon;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error('read failed'));
      reader.readAsDataURL(blob);
    });
  } catch {
    return icon;
  }
}
