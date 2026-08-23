/**
 * Whether this session runs the touch layout, decided once at startup.
 *
 * ## Why a media query and not the user agent
 *
 * `navigator.userAgent` is a string browsers actively lie in -- iPadOS reports
 * itself as a Mac by default, and the tablet/phone distinction has never been
 * reliably encoded anywhere in it. What this file actually needs to know is not
 * "is this a phone" but two answerable questions: **can the user point
 * precisely**, and **is there room for the desktop layout**. Both are CSS media
 * features, and both are readable synchronously before the first frame.
 *
 * There is also no "mobile version" for a phone to navigate to. Serving a
 * separate document per device class is a convention that predates responsive
 * layout; one page that branches internally is what replaced it.
 *
 * ## Both halves are required, and each rejects a real device
 *
 *   - `pointer: coarse` alone accepts a 27" touchscreen monitor, where the
 *     desktop layout fits comfortably and is what the user wants.
 *   - the width test alone accepts a narrow desktop WINDOW, where the pointer is
 *     a mouse and every touch gesture in `touchGestures.ts` would be dead code
 *     sitting in front of working mouse handlers.
 *
 * `pointer` (not `any-pointer`) asks about the PRIMARY input, which is the one
 * the layout should be built for. A laptop with a touchscreen answers `fine`.
 *
 * ## Latched, deliberately
 *
 * This is read ONCE, by `main.ts`, and handed down as a constructor argument to
 * everything that branches on it. Nothing re-reads it and there is no resize
 * listener, because the layout is built from it rather than merely styled by it
 * -- `Panel` mounts a different number of containers, `MutationOverlay` builds
 * different rows, and the menu binds different events. Rebuilding all of that
 * when a phone rotates, or when the URL bar collapses and fires a resize, is a
 * large amount of teardown for a question whose answer almost never changes.
 *
 * The width test is therefore against the LARGER viewport dimension, so a phone
 * held in landscape is still a phone. Reading `innerWidth` directly would flip
 * a 900px-wide landscape phone to the desktop layout on rotation -- and since
 * nothing re-reads this, whichever orientation happened to be live at load
 * would silently decide the whole session.
 */

import { DROPDOWN_MODES } from './settingsSpec.ts';

/**
 * Longest viewport edge that still counts as small, in CSS pixels.
 *
 * Compared against the LONGER side of the viewport (see the header), so this is
 * a statement about the device rather than about how it is being held -- which
 * is what makes the number large enough to need explaining.
 *
 * **IT HAS TO CLEAR THE TALL SIDE OF A BIG PHONE, NOT THE WIDE SIDE.** Modern
 * phones are long: an iPhone 14 is 390x844 and a 14 Pro Max is 430x932, so a
 * threshold chosen by eye from portrait WIDTHS (720, 820) rejects every one of
 * them and quietly ships the desktop layout to exactly the devices this work is
 * for. 960 clears the tallest phones with room to spare.
 *
 * The ceiling above it is the iPad, whose shorter edge is 768pt and whose
 * LONGER edge is 1024pt. Only the longer edge is consulted here, so any value
 * below 1024 keeps tablets on the desktop layout -- they have the screen for it,
 * and with a keyboard attached they have a precise pointer too. 960 sits inside
 * that gap rather than at either end of it.
 *
 * A phone big enough to exceed this, or a tablet small enough to fall under it,
 * is what the `mobileMode` preference is for.
 */
export const MOBILE_MAX_EDGE_PX = 960;

/**
 * The three states of the preference that overrides detection.
 *
 * `'auto'` is the default and means "use `detectMobile`". The other two exist
 * because **detection will be wrong for somebody** -- a hybrid device, an
 * unusual window size, a browser that misreports `pointer` -- and being stuck
 * in a layout that does not suit the hardware, with the control that would fix
 * it living inside that layout, is a dead end.
 *
 * It is also how the touch layout gets tested on a desktop, which is worth as
 * much during development as the escape hatch is in the field.
 */
export const MOBILE_MODES = ['auto', 'on', 'off'] as const;
export type MobileMode = (typeof MOBILE_MODES)[number];

/**
 * Compile-time proof that this file and the dropdown agree on the mode COUNT.
 *
 * The registry owns the user-facing labels (`DROPDOWN_MODES.mobileMode`) and
 * this file owns the internal names, because the two are different vocabularies
 * -- "Always Touch" is what a user picks, `'on'` is what `resolveMobile` reads.
 * What they must never disagree about is how many there are and what order they
 * are in, since the stored preference is an INDEX shared between them.
 *
 * A mismatch is otherwise invisible: adding a fourth label would give the panel
 * a dropdown entry that `mobileModeFromValue` silently reads as `'auto'`. This
 * turns that into a build error. It costs nothing at runtime -- `satisfies` and
 * the type alias are both erased.
 */
type _ModeCountsAgree = typeof MOBILE_MODES extends {
  readonly length: (typeof DROPDOWN_MODES.mobileMode)['length'];
}
  ? true
  : ['MOBILE_MODES and DROPDOWN_MODES.mobileMode must stay the same length'];
const _modeCountsAgree: _ModeCountsAgree = true;
void _modeCountsAgree;

/**
 * The stored `mobileMode` INDEX as a mode. Out of range degrades to `'auto'`.
 *
 * The preference is an index rather than a string (see `Preferences.mobileMode`
 * for why), so this is the one place the two representations meet -- the same
 * job `mouseModeFromValue` does for the toolbar, in the other direction.
 *
 * **MEMBER ORDER IS THE STORED FORMAT.** Reordering `MOBILE_MODES` silently
 * reinterprets every already-stored preference, so a user who chose "always
 * desktop" would come back to something else. Append only.
 *
 * DEGRADES RATHER THAN THROWS, for the reason `loadPreferences` never throws: a
 * bad value in `localStorage` outlives a reload, and a startup crash over one
 * would make the app permanently unstartable until site data was cleared by
 * hand. `'auto'` is the safe landing because it re-derives from the device.
 */
export function mobileModeFromValue(index: number): MobileMode {
  return MOBILE_MODES[index] ?? 'auto';
}

/** The `matchMedia`-shaped slice this module needs, so tests can supply one. */
export interface MediaQueryHost {
  matchMedia(query: string): { readonly matches: boolean };
  readonly innerWidth: number;
  readonly innerHeight: number;
}

/**
 * Whether the hardware looks like a phone. Ignores the preference.
 *
 * Split from `resolveMobile` so the two decisions are separately testable: this
 * one is about the device, and the caller's is about what the user asked for.
 *
 * **NEVER THROWS.** `matchMedia` is absent in `node --test` and can throw in an
 * exotic embedding; a detection failure must degrade to the desktop layout
 * rather than take the app down before it renders. Desktop is the safe default
 * because it is the layout every input device can drive -- a mouse user handed
 * the touch layout has no gestures for pan and zoom, while a touch user handed
 * the desktop layout can still tap everything, just less comfortably.
 */
export function detectMobile(host: MediaQueryHost | null = globalHost()): boolean {
  if (host === null) return false;
  try {
    if (!host.matchMedia('(pointer: coarse)').matches) return false;
    // The LONGER side, so orientation cannot change the answer. See the header.
    const edge = Math.max(host.innerWidth, host.innerHeight);
    return edge <= MOBILE_MAX_EDGE_PX;
  } catch {
    return false;
  }
}

/** `window`, or `null` where there is none (tests, SSR). */
export function globalHost(): MediaQueryHost | null {
  try {
    return typeof window === 'undefined' ? null : window;
  } catch {
    return null;
  }
}

/**
 * The final answer: the preference, or detection when it defers.
 *
 * A pure function of its two arguments, which is what lets `main.ts` hold the
 * result in one `const` and hand it out. An unrecognised mode is treated as
 * `'auto'` rather than rejected -- the value round-trips through `localStorage`
 * and a hand-edited or downgraded entry should fall back to detecting, not to
 * an arbitrary layout.
 */
export function resolveMobile(mode: MobileMode | string, detected: boolean): boolean {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return detected;
}
