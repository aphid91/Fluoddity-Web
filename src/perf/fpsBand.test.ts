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
  fpsFrom,
  readoutFor,
  startBand,
  stepBand,
} from './fpsBand.ts';

test('band thresholds match the specified ranges', () => {
  // Checked ON each boundary rather than near it: an off-by-one in a `>=` is
  // exactly the mistake a test at 34 and 36 would miss.
  assert.equal(bandFor(0), RED);
  assert.equal(bandFor(35), YELLOW, '35 is the bottom of yellow, not the top of red');
  assert.equal(bandFor(34.9), RED);
  assert.equal(bandFor(50), GREEN);
  assert.equal(bandFor(49.9), YELLOW);
  assert.equal(bandFor(58), BLUE, 'blue is the top band: holding the frame rate');
  assert.equal(bandFor(57.9), GREEN);
  assert.equal(bandFor(60), BLUE);
});

test('the readout is always a number, capped at 60', () => {
  assert.equal(readoutFor(41), '41');
  assert.equal(readoutFor(59.6), '60', 'rounds rather than truncating');
  assert.equal(readoutFor(60), '60');

  // **CAPPED**, because rAF is vsync-paced: a 144 Hz display would otherwise
  // report the monitor rather than the simulation, which is budgeted for 60
  // whatever the panel does (`progression.ts`).
  assert.equal(readoutFor(144), '60');
  assert.equal(readoutFor(1000), '60');

  // No readout may carry a `+` any more -- the headroom marks are gone with the
  // estimate that produced them.
  for (const fps of [10, 45, 59, 70, 144, 600]) {
    assert.doesNotMatch(readoutFor(fps), /\+/);
  }
});

test('a catastrophically slow frame still reads as a running app', () => {
  // Zero would suggest the app has STOPPED, which is a different failure from
  // "very slow" and would send the user looking for the wrong problem.
  assert.equal(readoutFor(0.2), '1');
  assert.equal(readoutFor(0), '1');
});

test('fpsFrom converts a frame interval, and reports NaN for none', () => {
  assert.ok(Math.abs(fpsFrom(16.7) - 59.88) < 0.1);
  assert.ok(Math.abs(fpsFrom(50) - 20) < 0.001);
  // Zero is "nothing measured yet" -- `main.ts` holds it there for the whole of
  // a restart's warmup. It must not read as 0 fps, which would render as a red
  // "1": an alarm raised by the absence of data.
  assert.ok(Number.isNaN(fpsFrom(0)));
});

test('a NaN reading holds the previous state entirely', () => {
  // Comparisons against NaN are false in both directions, so an unguarded one
  // would silently take whichever branch happened to be the `else`.
  const settled = stepBand(startBand(), 45, 0);
  assert.equal(stepBand(settled, Number.NaN, 100), settled);
});

test('the band does not move until a change is sustained', () => {
  let state = startBand();
  assert.equal(state.band, BLUE, 'starts optimistic so no first impression is a false alarm');

  // A single terrible sample must not change the COLOUR: the dwell has not
  // elapsed. (The number moves immediately -- asserted separately below.)
  state = stepBand(state, 20, 0);
  assert.equal(state.band, BLUE);

  // Still inside the dwell.
  state = stepBand(state, 20, 249);
  assert.equal(state.band, BLUE);

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
  assert.equal(state.band, BLUE, 'the dwell restarted, so the colour has not moved');
  state = stepBand(state, 20, 600);
  assert.equal(state.band, RED);
});

test('the immediate flag adopts a new band with no dwell at all', () => {
  // While a performance slider is under the pointer the user is looking at the
  // control, not the artwork, and a quarter-second lag answers for where the
  // handle WAS. One reading is enough there.
  let state = startBand();
  state = stepBand(state, 20, 0, true);
  assert.equal(state.band, RED, 'adopted on the first reading, no dwell');
  assert.equal(state.readout, '20');
});

test('the immediate flag still respects the margin', () => {
  // Skipping the dwell must not also skip the hysteresis -- that would trade a
  // lagging colour for a strobing one, in the moment the user is watching most
  // closely. Settle into green, then offer a reading just past its edge.
  let state = stepBand(startBand(), 54, 0);
  state = stepBand(state, 54, 300);
  assert.equal(state.band, GREEN);

  // 49.9 is over the yellow line but inside the 3 fps margin.
  state = stepBand(state, 49.9, 400, true);
  assert.equal(state.band, GREEN, 'inside the margin, so still noise');

  // Well clear of it, and now the drag adopts at once.
  state = stepBand(state, 44, 420, true);
  assert.equal(state.band, YELLOW);
});

test('releasing the slider restores the dwell', () => {
  // The flag is per-call, so dropping it must put the debounce straight back.
  let state = stepBand(startBand(), 20, 0, true);
  assert.equal(state.band, RED);

  // Back to a fast reading with no flag: the colour waits again.
  state = stepBand(state, 60, 10, false);
  assert.equal(state.band, RED, 'debounced once more');
  state = stepBand(state, 60, 300, false);
  assert.equal(state.band, BLUE);
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
  assert.equal(state.band, BLUE);

  state = stepBand(state, 24, 0);
  assert.equal(state.readout, '24', 'the number moved on the first bad reading');
  assert.equal(state.band, BLUE, 'while the colour is still waiting out the dwell');

  // And it keeps tracking, every reading, throughout the dwell.
  state = stepBand(state, 31, 50);
  assert.equal(state.readout, '31');
  state = stepBand(state, 18, 100);
  assert.equal(state.readout, '18');
  assert.equal(state.band, BLUE, 'still mid-dwell');

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

test('the readout never contradicts a blue band', () => {
  // Blue now means "holding the frame rate", so its numbers are 58-60 and the
  // two halves of the badge cannot disagree the way they once could -- a blue
  // "20" was reachable when blue meant headroom from a separate measurement.
  let state = startBand();
  state = stepBand(state, 60, 0);
  state = stepBand(state, 60, 300);
  assert.equal(state.band, BLUE);
  assert.equal(state.readout, '60');
});

test('sitting exactly on an edge never flips the band', () => {
  // Settle into green first -- the counter now starts blue, and this is about
  // what happens once a band is established.
  let state = startBand();
  state = stepBand(state, 54, 0);
  state = stepBand(state, 54, 300);
  assert.equal(state.band, GREEN);

  // Green runs 50..58. Readings jittering right at 50 are inside the margin,
  // so no amount of time at the edge may move the band -- this is the flicker
  // the hysteresis exists to kill.
  for (let t = 1000; t < 61000; t += 100) {
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
