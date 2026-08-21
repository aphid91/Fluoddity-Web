import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BAND_COLOR,
  BAND_DESCRIPTION,
  BAND_LABEL_COLOR,
  BAND_TOOLTIP,
  BLUE,
  GREEN,
  RED,
  YELLOW,
  bandFor,
  estimateFps,
  readoutFor,
  startBand,
  stepBand,
} from './fpsBand.ts';

test('band thresholds match the specified ranges', () => {
  // The brief's edges, checked ON the boundary rather than near it: an
  // off-by-one in a `>=` is exactly the mistake a test at 34 and 36 would miss.
  assert.equal(bandFor(0), RED);
  assert.equal(bandFor(35), YELLOW, '35 is the bottom of yellow, not the top of red');
  assert.equal(bandFor(34.9), RED);
  assert.equal(bandFor(50), GREEN);
  assert.equal(bandFor(49.9), YELLOW);
  assert.equal(bandFor(70), BLUE);
  assert.equal(bandFor(69.9), GREEN);
  assert.equal(bandFor(1000), BLUE);
});

test('the readout stylizes headroom and prints real measurements', () => {
  // Below 60 is a MEASUREMENT and prints as a number.
  assert.equal(readoutFor(41), '41');
  assert.equal(readoutFor(59.6), '60', 'rounds rather than truncating');

  // 60..70 is above target with no headroom worth naming.
  assert.equal(readoutFor(60), '60');
  assert.equal(readoutFor(69.9), '60');

  // Above 70 is an ESTIMATE and is stylized, never printed as a frame rate.
  assert.equal(readoutFor(70), '60+');
  assert.equal(readoutFor(89.9), '60+');
  assert.equal(readoutFor(90), '60++');
  assert.equal(readoutFor(119.9), '60++');
  assert.equal(readoutFor(120), '60+++');
  assert.equal(readoutFor(400), '60+++');

  // No stylized readout may look like a measured number -- that is the whole
  // honesty argument in the module header, so it is asserted rather than
  // trusted to the three cases above.
  for (const fps of [70, 95, 130, 600]) {
    assert.match(readoutFor(fps), /^60\+{1,3}$/);
  }
});

test('a catastrophically slow frame still reads as a running app', () => {
  // Zero would suggest the app has STOPPED, which is a different failure from
  // "very slow" and would send the user looking for the wrong problem.
  assert.equal(readoutFor(0.2), '1');
  assert.equal(readoutFor(0), '1');
});

test('measured fps wins whenever frames are actually being missed', () => {
  // 25 fps measured, and a GPU that looks idle. Something OTHER than GPU work
  // is the constraint, and the user is watching a 25 fps app either way --
  // reporting headroom here would tell them their machine has room while they
  // watch it stutter.
  const fps = estimateFps(40, 2);
  assert.ok(fps < 30, `expected the measured 25 fps to win, got ${String(fps)}`);
});

test('headroom is estimated once the frame delta is vsync-capped', () => {
  // 16.7 ms frames (capped at 60) with only 4 ms of GPU work: roughly 4x
  // headroom, which is deep into the blue band.
  const fps = estimateFps(16.7, 4);
  assert.equal(bandFor(fps), BLUE);
  assert.equal(readoutFor(fps), '60+++');

  // The same capped frame delta with the GPU nearly full: no headroom, so this
  // must NOT read as blue despite hitting 60. This is the case a naive
  // frame-delta counter gets wrong, and the reason the probe exists.
  const tight = estimateFps(16.7, 16);
  assert.equal(bandFor(tight), GREEN);
  assert.equal(readoutFor(tight), '60');
});

test('a missing GPU reading degrades to the measured frame rate', () => {
  // `gpuMs === 0` is "the probe has nothing yet". It must not be treated as
  // "zero GPU time", which would divide into infinite headroom.
  const fps = estimateFps(16.7, 0);
  assert.ok(Number.isFinite(fps));
  assert.equal(bandFor(fps), GREEN, 'no reading means no headroom claim');
});

test('the band does not move until a change is sustained', () => {
  let state = startBand();
  assert.equal(state.band, GREEN, 'starts green so no first impression is a false alarm');

  // A single terrible sample must not change the COLOUR: the dwell has not
  // elapsed. (The number moves immediately -- asserted separately below.)
  state = stepBand(state, 20, 0);
  assert.equal(state.band, GREEN);

  // Still inside the dwell.
  state = stepBand(state, 20, 249);
  assert.equal(state.band, GREEN);

  // Past it, with the same band pending throughout.
  state = stepBand(state, 20, 251);
  assert.equal(state.band, RED);
});

test('a transient spike is discarded rather than starting the clock over', () => {
  let state = startBand();
  state = stepBand(state, 20, 0); // red pending
  // A single good frame mid-dwell cancels the pending change entirely.
  state = stepBand(state, 60, 100);
  assert.equal(state.pending, null);
  // So the clock restarts: this is measured from the SPIKE, not the original.
  state = stepBand(state, 20, 300);
  assert.equal(state.band, GREEN, 'the dwell restarted, so the colour has not moved');
  state = stepBand(state, 20, 600);
  assert.equal(state.band, RED);
});

test('the dwell is short enough to feel immediate', () => {
  // A quarter second: the colour should answer while a hand is still on the
  // slider that caused the change. Pinned as a property rather than as the
  // literal, so the constant can be tuned without editing this.
  let state = startBand();
  state = stepBand(state, 20, 0);
  state = stepBand(state, 20, 300);
  assert.equal(state.band, RED, 'the band should have moved well within 300ms');
});

test('a measured number is NEVER held back by the dwell', () => {
  // THE RULE THIS FILE EXISTS TO PIN. At or below 60 the readout is a
  // measurement of what the user is watching, so it must be current on the very
  // first reading -- even while the colour is still mid-dwell and disagrees.
  let state = startBand();
  assert.equal(state.band, GREEN);

  state = stepBand(state, 24, 0);
  assert.equal(state.readout, '24', 'the number moved on the first bad reading');
  assert.equal(state.band, GREEN, 'while the colour is still waiting out the dwell');

  // And it keeps tracking, every reading, throughout the dwell.
  state = stepBand(state, 31, 50);
  assert.equal(state.readout, '31');
  state = stepBand(state, 18, 100);
  assert.equal(state.readout, '18');
  assert.equal(state.band, GREEN, 'still mid-dwell');

  // The colour catches up once the evidence is sustained.
  state = stepBand(state, 18, 400);
  assert.equal(state.band, RED);
  assert.equal(state.readout, '18');
});

test('the number tracks across band boundaries without waiting', () => {
  // Walking down through yellow into red, the number must be right at every
  // step even though the colour lags each crossing by the dwell.
  let state = startBand();
  const walk: readonly (readonly [number, number])[] = [
    [55, 0],
    [45, 20],
    [40, 40],
    [30, 60],
  ];
  for (const [fps, at] of walk) {
    state = stepBand(state, fps, at);
    assert.equal(state.readout, String(fps), `readout should be ${String(fps)}`);
  }
});

test('the plus marks ARE debounced, unlike a measured number', () => {
  // Above 60 the readout is an estimate derived from the same headroom figure
  // the colour is, so the two must move together -- marks flickering while the
  // colour held steady would have them disagreeing on screen.
  let state = startBand();
  // Settle into blue at 60+.
  state = stepBand(state, 75, 0);
  state = stepBand(state, 75, 300);
  assert.equal(state.band, BLUE);
  assert.equal(state.readout, '60+');

  // A jump to 60+++ territory is still blue, so no band change is pending and
  // the marks do NOT immediately follow -- they are part of the debounced half.
  state = stepBand(state, 200, 320);
  assert.equal(state.readout, '60+', 'the marks held rather than jumping');
});

test('sitting exactly on an edge never flips the band', () => {
  let state = startBand();
  // Green runs 50..70. Readings jittering right at 50 are inside the margin,
  // so no amount of time at the edge may move the band -- this is the flicker
  // the hysteresis exists to kill.
  for (let t = 0; t < 60000; t += 100) {
    state = stepBand(state, t % 200 === 0 ? 49.9 : 50.1, t);
  }
  assert.equal(state.band, GREEN);
});

test('a decisive change still moves promptly', () => {
  // The margin must not be so wide that a real change is ignored. 20 fps is far
  // outside green, so it should be adopted as soon as the dwell allows.
  let state = startBand();
  state = stepBand(state, 20, 0);
  state = stepBand(state, 20, 251);
  assert.equal(state.band, RED);
});

test('the readout updates within a band as well as across one', () => {
  // The number is information at a glance and costs nothing; the COLOUR is what
  // draws the eye. Debouncing both would leave a visibly stale number.
  let state = startBand();
  state = stepBand(state, 20, 0);
  state = stepBand(state, 20, 251);
  assert.equal(state.band, RED);

  const before = state.readout;
  state = stepBand(state, 25, 300);
  assert.equal(state.band, RED, 'still red -- same band');
  assert.notEqual(state.readout, before, 'but the number tracked the change');
  assert.equal(state.readout, '25');
});

test('stepBand returns the receiver unchanged when nothing moved', () => {
  // Reference identity is the caller's signal to skip the DOM write, the same
  // contract `preferences.ts`'s `withValue` offers for skipping a save.
  const state = stepBand(startBand(), 60, 0);
  assert.equal(stepBand(state, 60, 100), state);
});

test('every band has both colours, a tooltip and a spoken description', () => {
  // Colour must never be the only signal, so a band that gained a fill without
  // gaining words would be a regression this catches.
  for (const band of [RED, YELLOW, GREEN, BLUE] as const) {
    assert.match(BAND_COLOR[band], /^#[0-9a-f]{6}$/i);
    assert.match(BAND_LABEL_COLOR[band], /^#[0-9a-f]{6}$/i);
    assert.ok(BAND_TOOLTIP[band].length > 0);
    assert.ok(BAND_DESCRIPTION[band].length > 0);
  }
});

test('the label ramp is more saturated than the badge ramp', () => {
  // The two ramps exist because a pale label is invisible beside the panel's
  // other labels -- that was a real defect, caught only by looking at a
  // screenshot. This pins the property that fixes it: for every band the label
  // colour must be further from grey than the badge colour is.
  //
  // "Distance from grey" is max(r,g,b) - min(r,g,b), which is chroma in the
  // crude-but-sufficient sense -- no colour space conversion needed to assert
  // that one is more colourful than the other.
  const chroma = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
    return Math.max(r!, g!, b!) - Math.min(r!, g!, b!);
  };
  for (const band of [RED, YELLOW, GREEN, BLUE] as const) {
    assert.ok(
      chroma(BAND_LABEL_COLOR[band]) > chroma(BAND_COLOR[band]),
      `${band}'s label colour is no more saturated than its badge colour`,
    );
  }
});

test('the struggling tooltip names all three settings to turn down', () => {
  // The tooltips are the only place the app explains what to DO about a colour,
  // so the actionable nouns are pinned. Matched loosely, so the prose can be
  // rewritten without editing this.
  for (const band of [RED, YELLOW] as const) {
    const text = BAND_TOOLTIP[band].toLowerCase();
    assert.match(text, /motion blur/);
    assert.match(text, /physics rate/);
    assert.match(text, /world size/);
  }
  // Blue offers the same three in the opposite direction.
  const blue = BAND_TOOLTIP[BLUE].toLowerCase();
  assert.match(blue, /motion blur/);
  assert.match(blue, /physics rate/);
  assert.match(blue, /world size/);
});
