/**
 * Where the desktop physics slider sits, as a pure rectangle comparison.
 *
 * WHY THESE EXIST. The rule is "go as far up as you can, but stop under
 * whatever is already in that column", and both of the things it stops under
 * are OPTIONAL: the FPS badge follows a preference, and the mutation bar only
 * counts when it actually overlaps this column. That is exactly the kind of
 * rule that is right in the case you looked at and wrong at the boundary, so
 * `physicsSliderTop` is pure and the boundary is testable. `reposition` needs a
 * DOM and is not covered here -- the same split `mutationOverlay.test.ts` draws
 * between `overlayTop` and its own `reposition`.
 *
 * ## NOTHING HERE PINS A DISTANCE, deliberately
 *
 * `STACK_GAP_PX` and `TOP_MARGIN_PX` are tuned by eye, which is the right way
 * to settle a margin and the wrong thing to write an assertion about: a test
 * that hard-codes "top is 2" fails on every nudge and teaches nothing when it
 * does. What these check is WHICH ARM FIRED -- did it go to the top, did it
 * stop under the badge, did it stop under the bar -- which is the actual rule
 * and is invariant under any spacing the constants are given.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { physicsSliderTop, type VerticalRect } from './physicsSlider.ts';

/**
 * The control itself, pinned to the right edge of a 1280px viewport.
 *
 * 44px wide (the button) at `right:8px`, which is where `ROOT_CSS` puts it.
 */
const SELF: VerticalRect = { left: 1228, right: 1272, bottom: 0 };

/** The FPS badge as it actually measures: top-right, ~28px tall. */
const BADGE: VerticalRect = { left: 1218, right: 1272, bottom: 28 };

/**
 * A centred mutation bar of `width`, on a viewport of `viewport`.
 *
 * **THE VIEWPORT ARGUMENT IS WHAT DECIDES OVERLAP**, and it is easy to get
 * wrong: the bar is centred, so it reaches this control's column only when it
 * is wide enough that `(viewport + width) / 2` passes `SELF.left`. A first
 * draft of these tests used a 1000px bar on a 1100px viewport -- which spans
 * 50..1050 and never comes near a control pinned at 1228 -- so three
 * "overlapping" cases were quietly asserting the non-overlapping arm.
 *
 * `overlappingBar` and `clearBar` below name the two cases rather than leaving
 * each call site to do that arithmetic in its head.
 */
function centredBar(width: number, viewport: number, bottom = 112): VerticalRect {
  const left = (viewport - width) / 2;
  return { left, right: left + width, bottom };
}

/** The viewport `SELF` is pinned to the right edge of. */
const VIEWPORT = 1280;

/** A bar wide enough to reach this control's column on `VIEWPORT`. */
function overlappingBar(bottom = 112): VerticalRect {
  // 1260 wide on 1280 spans 10..1270, which passes SELF.left (1228).
  const bar = centredBar(1260, VIEWPORT, bottom);
  assertReaches(bar, true);
  return bar;
}

/** A bar that stops short of this control's column on `VIEWPORT`. */
function clearBar(bottom = 112): VerticalRect {
  // 1000 wide on 1280 spans 140..1140, well clear of SELF.left (1228).
  const bar = centredBar(1000, VIEWPORT, bottom);
  assertReaches(bar, false);
  return bar;
}

/**
 * Guard the fixtures themselves, so a test cannot silently exercise the wrong
 * arm again. This is the check whose absence caused the bug described above.
 */
function assertReaches(bar: VerticalRect, expected: boolean): void {
  const overlaps = SELF.left < bar.right && bar.left < SELF.right;
  assert.equal(
    overlaps,
    expected,
    `fixture is wrong: bar ${String(bar.left)}..${String(bar.right)} vs ` +
      `control ${String(SELF.left)}..${String(SELF.right)}`,
  );
}

/**
 * Whether `top` cleared `rect` rather than going to the top margin.
 *
 * SPACING-AGNOSTIC by construction: the top arm cannot reach the obstacle's
 * bottom edge without the top margin growing past the obstacle's whole height,
 * at which point "at the top" would have stopped being true anyway.
 */
const clears = (top: number, rect: VerticalRect): boolean => top >= rect.bottom;

// ---------------------------------------------------------------------------
// Nothing in the way
// ---------------------------------------------------------------------------

test('with no badge and no bar it goes to the very top', () => {
  const top = physicsSliderTop(SELF, null, null);
  assert.ok(
    !clears(top, BADGE),
    `nothing above it, so nothing to pay clearance for (got ${String(top)})`,
  );
});

test('a bar that does not reach this column is not an obstacle', () => {
  // THE WHOLE POINT of the horizontal test. A 1000px bar on a 1280px viewport
  // still leaves this column clear, and dropping below a bar that is nowhere
  // near it would spend vertical space to buy nothing.
  const top = physicsSliderTop(SELF, clearBar(), null);
  assert.ok(!clears(top, BADGE), `no horizontal overlap, so no drop (got ${String(top)})`);
});

// ---------------------------------------------------------------------------
// The badge
// ---------------------------------------------------------------------------

test('a visible badge pushes it down, with no overlap test', () => {
  // The badge shares this column by construction -- both are `right:8px` -- so
  // its mere presence is the condition. No geometry to get wrong.
  const top = physicsSliderTop(SELF, null, BADGE);
  assert.ok(clears(top, BADGE), `the badge is above it, so clear it (got ${String(top)})`);
});

test('turning the badge off reclaims the space', () => {
  // `showFpsCounter` is a preference, and `reposition` passes null when the
  // element is `display:none`. The control must then rise -- reserving a gap
  // for a badge the user turned off is the failure this guards.
  const withBadge = physicsSliderTop(SELF, null, BADGE);
  const without = physicsSliderTop(SELF, null, null);
  assert.ok(without < withBadge, `absent badge must free space (${String(without)} < ${String(withBadge)})`);
  assert.ok(!clears(without, BADGE), 'and it goes all the way to the top');
});

// ---------------------------------------------------------------------------
// The mutation bar
// ---------------------------------------------------------------------------

test('a bar that overlaps this column pushes it below the bar', () => {
  const bar = overlappingBar();
  const top = physicsSliderTop(SELF, bar, null);
  assert.ok(clears(top, bar), `an overlap has to clear the bar (got ${String(top)})`);
});

test('touching edges are not a collision', () => {
  // A bar ending at exactly this control's left edge clears it, so the
  // comparison has to be strict. One pixel either side is the whole difference
  // between the two arms, which is what makes it worth a test.
  const touching: VerticalRect = { left: 200, right: SELF.left, bottom: 112 };
  const overlapping: VerticalRect = { left: 200, right: SELF.left + 1, bottom: 112 };
  assert.ok(
    !clears(physicsSliderTop(SELF, touching, null), touching),
    'ending exactly at the left edge is clear',
  );
  assert.ok(
    clears(physicsSliderTop(SELF, overlapping, null), overlapping),
    'one pixel of overlap is an overlap',
  );
});

test('the drop tracks the bar rather than assuming its height', () => {
  // Checks the RELATIONSHIP, not the number: the answer moves with `bottom`,
  // and by the same amount, so a taller bar pushes this down with it.
  const short = overlappingBar(100);
  const tall = overlappingBar(160);
  const delta = physicsSliderTop(SELF, tall, null) - physicsSliderTop(SELF, short, null);
  assert.equal(delta, 60, 'a bar 60px taller pushes the slider 60px further down');
});

// ---------------------------------------------------------------------------
// Both at once
// ---------------------------------------------------------------------------

test('with both in the way the LOWER one decides', () => {
  // The bar hangs below the badge, so it wins -- and the function takes the max
  // rather than depending on the order the rules are written in.
  const bar = overlappingBar();
  const top = physicsSliderTop(SELF, bar, BADGE);
  assert.ok(clears(top, bar), `the bar is the lower obstacle (got ${String(top)})`);
});

test('a badge below a short bar still decides', () => {
  // The reverse case, so the max is doing real work rather than the bar always
  // happening to be lower. A bar that ends ABOVE the badge must not pull the
  // control up over the badge.
  const shallowBar = overlappingBar(10);
  const top = physicsSliderTop(SELF, shallowBar, BADGE);
  assert.ok(clears(top, BADGE), `the badge is the lower obstacle here (got ${String(top)})`);
});

// ---------------------------------------------------------------------------
// Degrading
// ---------------------------------------------------------------------------

test('an unmeasured rect is treated as absent, not as an obstacle at zero', () => {
  // A hidden or not-yet-laid-out element measures as a zero-width rect. Reading
  // that as a real obstacle would push the control down for something that is
  // not on screen.
  const unmeasured: VerticalRect = { left: 0, right: 0, bottom: 400 };
  assert.equal(
    physicsSliderTop(SELF, unmeasured, null),
    physicsSliderTop(SELF, null, null),
    'a zero-width bar is the same as no bar',
  );
  assert.equal(
    physicsSliderTop(SELF, null, unmeasured),
    physicsSliderTop(SELF, null, null),
    'a zero-width badge is the same as no badge',
  );
});

test('a zero-width SELF still resolves, for the first frame', () => {
  // The control measures as zero on the frame before it is laid out. It must
  // not throw or produce NaN -- the next frame corrects the position.
  const unlaid: VerticalRect = { left: 0, right: 0, bottom: 0 };
  const top = physicsSliderTop(unlaid, centredBar(1000, 1100), BADGE);
  assert.ok(Number.isFinite(top), `got ${String(top)}`);
});
