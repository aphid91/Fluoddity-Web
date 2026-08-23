/**
 * The mobile-layout decision.
 *
 * WHY THIS TEST EXISTS. Detection is read exactly once, at startup, and the
 * whole GUI is BUILT from the result -- so a wrong answer is not a styling
 * glitch that a resize corrects, it is the wrong application for the rest of the
 * session. There is no DOM here and no device, so the two failure modes that
 * matter are the ones a browser would never show us anyway:
 *
 *   1. A rule that accepts too much. Both halves of the test reject a real
 *      device on their own (see `mobile.ts`), and dropping either -- which reads
 *      like a harmless simplification -- hands the touch layout to a desktop
 *      user, who then has no gestures for pan and zoom.
 *   2. Orientation flipping the answer. The width test is against the LONGER
 *      viewport edge for this reason, and comparing `innerWidth` instead is the
 *      single most natural way to write it wrong.
 *
 * A structural host rather than a real `window`, as `focusRelease.test.ts` uses
 * structural stubs: `node --test` has no `matchMedia`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectMobile,
  resolveMobile,
  MOBILE_MAX_EDGE_PX,
  type MediaQueryHost,
} from './mobile.ts';

/** A host reporting one pointer kind and one viewport. */
function host(pointer: 'coarse' | 'fine', width: number, height: number): MediaQueryHost {
  return {
    matchMedia: (query: string) => ({ matches: query.includes(pointer) }),
    innerWidth: width,
    innerHeight: height,
  };
}

// --- 1. the two halves, and what each one alone would let through ----------

test('a phone is mobile', () => {
  // REAL DIMENSIONS, not round numbers, and that is the point of this case.
  // Phones are LONG: the first draft of `MOBILE_MAX_EDGE_PX` was picked from
  // portrait widths and rejected both of these, which would have shipped the
  // desktop layout to the exact devices this work is for.
  assert.equal(detectMobile(host('coarse', 390, 844)), true, 'iPhone 14');
  assert.equal(detectMobile(host('coarse', 430, 932)), true, 'iPhone 14 Pro Max');
  assert.equal(detectMobile(host('coarse', 360, 800)), true, 'a common Android');
});

test('a large touchscreen is NOT mobile', () => {
  // THE CASE `pointer: coarse` ALONE GETS WRONG. A 27" touch monitor points
  // coarsely and has room for the full desktop layout, which is what its user
  // wants -- dropping the width test hands them a phone UI on a huge screen.
  assert.equal(
    detectMobile(host('coarse', 1920, 1080)),
    false,
    'width must be part of the rule, or big touchscreens get the phone layout',
  );
});

test('a narrow desktop WINDOW is NOT mobile', () => {
  // THE CASE THE WIDTH TEST ALONE GETS WRONG, and the more likely of the two:
  // anyone can drag a browser window narrow. The pointer is a mouse, so the
  // touch gestures would be dead code in front of working mouse handlers.
  assert.equal(
    detectMobile(host('fine', 700, 900)),
    false,
    'a mouse must never get the touch layout, however narrow the window',
  );
});

// --- 2. orientation must not decide the session ---------------------------

test('a phone in LANDSCAPE is still mobile', () => {
  // THE ASSERTION THIS FILE IS MOST FOR. Nothing re-reads detection, so if this
  // is wrong the layout is decided by which way the phone happened to be held
  // at load. 844x390 is the iPhone above, rotated -- the longer edge is
  // unchanged, which is the whole reason the rule reads it.
  assert.equal(
    detectMobile(host('coarse', 844, 390)),
    true,
    'comparing innerWidth instead of the longer edge breaks rotation',
  );
});

test('an iPad is NOT mobile in either orientation', () => {
  // THE CEILING, and why `MOBILE_MAX_EDGE_PX` cannot simply be raised until the
  // phones pass. A tablet points coarsely and has the screen for the desktop
  // layout; its 1024pt longer edge is what the threshold sits below. Landscape
  // is the case that would break first, since its 1024 arrives as innerWidth.
  assert.equal(detectMobile(host('coarse', 768, 1024)), false, 'iPad portrait');
  assert.equal(detectMobile(host('coarse', 1024, 768)), false, 'iPad landscape');
});

test('the threshold is inclusive at the boundary', () => {
  const edge = MOBILE_MAX_EDGE_PX;
  assert.equal(detectMobile(host('coarse', 400, edge)), true);
  assert.equal(detectMobile(host('coarse', 400, edge + 1)), false);
});

// --- 3. never throw, and default to the layout every device can drive ------

test('a host without matchMedia degrades to desktop', () => {
  // Detection runs before the first frame. Throwing here would take the app
  // down before it renders, and desktop is the safe fallback: a touch user can
  // still tap a desktop layout, a mouse user cannot pinch a touch one.
  assert.equal(detectMobile(null), false);
  const broken: MediaQueryHost = {
    matchMedia: () => {
      throw new Error('no matchMedia here');
    },
    innerWidth: 390,
    innerHeight: 844,
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
