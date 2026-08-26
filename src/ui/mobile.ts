/**
 * Whether this session runs the touch layout, decided once at startup.
 *
 * ## Why a media query and not the user agent
 *
 * `navigator.userAgent` is a string browsers actively lie in -- iPadOS reports
 * itself as a Mac by default, and the tablet/phone distinction has never been
 * reliably encoded anywhere in it. What this file actually needs to know is not
 * "is this a phone" but one answerable question: **can the user point
 * precisely**. That is a CSS media feature, readable synchronously before the
 * first frame.
 *
 * There is also no "mobile version" for a phone to navigate to. Serving a
 * separate document per device class is a convention that predates responsive
 * layout; one page that branches internally is what replaced it.
 *
 * ## Why screen size is NOT part of the test
 *
 * It used to be: the rule also required the longer viewport edge to fall under
 * a threshold, which was set below the iPad's 1024pt to keep tablets on the
 * desktop layout on the grounds that they have the room for it. **That was the
 * wrong question.** Room is not what the desktop layout needs -- it needs HOVER
 * and RIGHT-CLICK, and a 12.9" iPad has neither. Sizing the rule to the screen
 * shipped tooltips that never open and context menus that never fire to every
 * large tablet, which is precisely the hardware the touch layout is for.
 *
 * A coarse pointer is the whole signal, at any size. The 27" touchscreen
 * monitor the size test was there to protect is both rarer than a tablet and
 * subject to the same limitation -- it cannot hover either -- so the touch
 * layout is a defensible answer for it too. Where it is not, `mobileMode` is
 * the escape hatch.
 *
 * `pointer` (not `any-pointer`) asks about the PRIMARY input, which is the one
 * the layout should be built for. **This is what still keeps touchscreen
 * laptops on the desktop layout**, and with the size test gone it is the only
 * thing that does: a Surface with a trackpad answers `fine`, because the
 * trackpad is primary. Widening this to `any-pointer` would flip every one of
 * them to touch.
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
 * Dropping the size test makes that latch strictly safer than it was. Viewport
 * dimensions were the one input to this decision that changed mid-session --
 * on rotation, on a window drag -- and the rule had to read the LONGER edge
 * specifically so that a rotated phone could not flip the answer. Pointer kind
 * does not change while the page is open.
 */

import { DROPDOWN_MODES } from './settingsSpec.ts';

/**
 * The three states of the preference that overrides detection.
 *
 * `'auto'` is the default and means "use `detectMobile`". The other two exist
 * because **detection will be wrong for somebody** -- a hybrid device, a
 * browser that misreports `pointer`, a large touchscreen whose owner wants the
 * desktop layout anyway -- and being stuck in a layout that does not suit the
 * hardware, with the control that would fix it living inside that layout, is a
 * dead end.
 *
 * `'off'` carries more weight now that size is out of the rule: it is the
 * answer for a big touchscreen that would rather have the desktop layout, a
 * case detection used to decide on its own by measuring the viewport.
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

/**
 * The `matchMedia`-shaped slice this module needs, so tests can supply one.
 *
 * `window` satisfies this structurally. It carried `innerWidth`/`innerHeight`
 * while the rule consulted viewport size; both are gone because nothing here
 * reads them any more, and leaving them would oblige every caller and stub to
 * supply dimensions that no longer influence the answer.
 */
export interface MediaQueryHost {
  matchMedia(query: string): { readonly matches: boolean };
}

/**
 * Whether the primary pointer is coarse. Ignores the preference.
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
    // The ENTIRE rule: no hover and no right-click, whatever the screen size.
    // See the header for why viewport dimensions are deliberately not consulted.
    return host.matchMedia('(pointer: coarse)').matches;
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
