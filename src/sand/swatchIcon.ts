/**
 * Swatch icons: a captured picture standing in for a swatch's flat colour, or
 * for a world's stand-in artwork in the World menu.
 *
 * ## AN ICON IS AN IMAGE URL, and which kind depends on where it lives
 *
 *   data:image/jpeg;base64,...   a fresh capture, and every icon in the
 *                                author's own storage (session, world library)
 *   <id>.<hash>.jpg              in a world pack: a file beside the manifest,
 *                                named by its content like every other asset
 *   https://...                  a pack icon once `builtinWorlds.ts` has
 *                                resolved it against the pack's address
 *
 * One field type covers all three, so nothing that carries an icon has to know
 * where it came from -- the swatch hands it to CSS, and the pack exporter
 * `fetch`es it, which reads a data URL as readily as a file. A future gallery
 * serving worlds from object storage is the third row with a different host:
 * documents keep pointing at their icons, the icons stay out of the JSON.
 *
 * ## SQUARE JPEGS, clipped to the circle by the stylesheet
 *
 * JPEG has no alpha, so the capture is a square whose corners outside the
 * circle are filled black. Every place an icon is drawn is already a circle
 * (`border-radius: 50%`), which hides them.
 *
 * ## Sized for a 3x screen
 *
 * A tray swatch is 44 CSS px across and a World menu swatch 56, both scaled by
 * the UI scale. The stored sizes cover those at 3x with a little to spare, so
 * an icon is sharp on a phone and is only ever DOWNscaled by the browser.
 *
 * ## A LEAF
 *
 * Imports nothing, so the validation is testable under `node --test`.
 */

/** Pixels per side of a tray swatch's icon. */
export const SWATCH_ICON_PX = 128;

/** Pixels per side of a world's icon, shown larger in the World menu. */
export const WORLD_ICON_PX = 192;

/** JPEG quality for captured icons. */
export const ICON_JPEG_QUALITY = 0.85;

/**
 * The smallest drag radius, in CSS pixels, that counts as a capture. A tap, or
 * a drag shorter than this, cancels -- and cancelling clears the icon.
 */
export const MIN_CAPTURE_RADIUS_CSS = 12;

/**
 * The longest icon accepted from storage.
 *
 * A captured icon is a few kilobytes. The cap exists so a hand-edited or
 * hostile document cannot park megabytes in a session that lives in
 * localStorage; it is far above anything a capture produces.
 */
export const MAX_ICON_LENGTH = 512 * 1024;

const DATA_URL = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
const HTTP_URL = /^https?:\/\/[^\x00-\x20\x7f"'\\]+$/;
/** A pack file name -- the same rule `worldPack.ts` applies to its assets. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:jpe?g|png|webp)$/;

/**
 * A stored icon, or null for anything else.
 *
 * STRICT, because the value ends up inside a CSS `url(...)`: only a base64
 * image data URL, a plain http(s) URL, or a bare pack file name gets through.
 * Nothing with quotes, backslashes, whitespace or control characters, so it
 * cannot escape the
 * `url()` it is put in, and no `javascript:` or other scheme.
 */
export function readSwatchIcon(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '' || raw.length > MAX_ICON_LENGTH) return null;
  if (DATA_URL.test(raw) || HTTP_URL.test(raw) || FILE_NAME.test(raw)) return raw;
  return null;
}

/** Whether an icon is a pack file name, to be resolved against the pack. */
export function isRelativeIcon(icon: string): boolean {
  return FILE_NAME.test(icon);
}

/**
 * An icon as a URL the browser can load: a pack file name resolved against
 * `base` (an absolute URL ending in '/'), anything else as it is.
 */
export function resolveIcon(icon: string, base: string): string {
  return isRelativeIcon(icon) ? new URL(icon, base).href : icon;
}

/** An icon as a CSS `url()`. Safe for any value `readSwatchIcon` accepted. */
export function iconToCss(icon: string): string {
  return `url("${icon}")`;
}

/** The pack file extension for an image's MIME type. */
export function iconExtension(mime: string): 'jpg' | 'png' | 'webp' {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}
