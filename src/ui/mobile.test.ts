/**
 * The mobile-layout decision.
 *
 * WHY THIS TEST EXISTS. Detection is read exactly once, at startup, and the
 * whole GUI is BUILT from the result -- so a wrong answer is not a styling
 * glitch that a resize corrects, it is the wrong application for the rest of the
 * session. There is no DOM here and no device, so the failure modes that matter
 * are the ones a browser would never show us anyway:
 *
 *   1. A rule that reads anything other than the primary pointer. Screen size
 *      used to be half of it, which is what sent large tablets to the desktop
 *      layout; the cases below pin the sizes that regression would touch.
 *   2. Widening `pointer` to `any-pointer`, which now that size is gone is the
 *      only thing keeping touchscreen laptops on the desktop layout.
 *
 * A structural host rather than a real `window`, as `focusRelease.test.ts` uses
 * structural stubs: `node --test` has no `matchMedia`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectMobile, resolveMobile, type MediaQueryHost } from './mobile.ts';

/**
 * A host reporting one pointer kind.
 *
 * Takes no dimensions, and that absence is load-bearing: if a future edit
 * reintroduces a viewport test, it has nothing here to read and the omission
 * surfaces as a type error rather than as tablets quietly changing layout.
 */
function host(pointer: 'coarse' | 'fine'): MediaQueryHost {
  return { matchMedia: (query: string) => ({ matches: query.includes(pointer) }) };
}

// --- 1. a coarse pointer is the whole rule, at every size -----------------

test('a phone is mobile', () => {
  assert.equal(detectMobile(host('coarse')), true);
});

test('a large tablet IS mobile', () => {
  // THE CASE THIS FILE IS NOW MOST FOR, and the bug that removed the size test:
  // an iPad points coarsely at 1024pt and a 12.9" Pro at 1366pt. Both used to
  // fail a `<= 960` longer-edge check and get the desktop layout -- tooltips
  // that never open, context menus that never fire -- because the old rule
  // asked whether the screen had ROOM rather than whether the input could
  // hover. Size is not consulted at all now, so one coarse host covers every
  // tablet dimension there is.
  assert.equal(detectMobile(host('coarse')), true);
});

test('a large touchscreen monitor IS mobile', () => {
  // The device the old size test existed to protect, deliberately reversed. A
  // 27" touch monitor cannot hover or right-click either, so the touch layout
  // is the defensible default; `mobileMode: 'off'` is the escape hatch for an
  // owner who disagrees. Asserted so the reversal reads as intended rather
  // than as fallout.
  assert.equal(detectMobile(host('coarse')), true);
});

test('a mouse is NOT mobile', () => {
  // A fine pointer never gets the touch layout, at any window size -- the touch
  // gestures would be dead code sitting in front of working mouse handlers.
  assert.equal(detectMobile(host('fine')), false);
});

test('a touchscreen LAPTOP is NOT mobile', () => {
  // WHY THE QUERY IS `pointer` AND NOT `any-pointer`. A Surface has a coarse
  // pointer available, but its PRIMARY one is the trackpad, so `pointer`
  // answers `fine`. With the size test gone this query is the only thing
  // standing between every touchscreen laptop and the phone layout.
  assert.equal(
    detectMobile(host('fine')),
    false,
    'any-pointer would flip every touchscreen laptop to the touch layout',
  );
});

test('the query asks about the PRIMARY pointer', () => {
  // The above pinned by inspection rather than by stub convention: a host that
  // answers `true` to `any-pointer: coarse` and `false` to `pointer: coarse`
  // must come out desktop. The `host` helper cannot express this, since it
  // matches on substring and `pointer` is one inside `any-pointer`.
  const laptop: MediaQueryHost = {
    matchMedia: (query: string) => ({ matches: query.includes('any-pointer') }),
  };
  assert.equal(detectMobile(laptop), false, 'detection must not read any-pointer');
});

// --- 2. never throw, and default to the layout every device can drive ------

test('a host without matchMedia degrades to desktop', () => {
  // Detection runs before the first frame. Throwing here would take the app
  // down before it renders, and desktop is the safe fallback: a touch user can
  // still tap a desktop layout, a mouse user cannot pinch a touch one.
  assert.equal(detectMobile(null), false);
  const broken: MediaQueryHost = {
    matchMedia: () => {
      throw new Error('no matchMedia here');
    },
  };
  assert.equal(detectMobile(broken), false, 'a detection failure must not throw');
});

// --- 4. the preference overrides, and an unusable value defers -------------

test('the preference wins over detection in both directions', () => {
  // The escape hatch, and the way the touch layout is tested on a desktop.
  assert.equal(resolveMobile('on', false), true);
  assert.equal(resolveMobile('off', true), false);
});

test('auto defers to detection', () => {
  assert.equal(resolveMobile('auto', true), true);
  assert.equal(resolveMobile('auto', false), false);
});

test('an unrecognised mode defers to detection rather than picking a layout', () => {
  // The value round-trips through localStorage, so a hand-edited or
  // downgraded entry lands here. Detecting is the useful fallback; committing
  // to a fixed layout would strand whoever wrote it.
  assert.equal(resolveMobile('nonsense', true), true);
  assert.equal(resolveMobile('', false), false);
});
