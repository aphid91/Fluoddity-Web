import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AutoCalibration } from './autoCalibrate.ts';
import { TARGET_MS } from './rateSearch.ts';

const LO = 1;
const HI = 120;

/**
 * Drive a calibration to completion against a synthetic machine.
 *
 * Feeds frames the way `main.ts` does, so this exercises the settle/measure
 * counting and the outlier guard as well as the search itself.
 */
function drive(
  costOf: (rate: number) => number,
  startRate: number,
  opts: { maxFrames?: number; injectStall?: number } = {},
): { result: number | null; frames: number; rates: number[] } {
  const rates: number[] = [];
  let current = startRate;

  const run = new AutoCalibration({
    lo: LO,
    hi: HI,
    startRate,
    setRate: (rate) => {
      current = rate;
      rates.push(rate);
    },
  });

  const maxFrames = opts.maxFrames ?? 2000;
  let frames = 0;
  while (!run.finished && frames < maxFrames) {
    frames++;
    const stall = opts.injectStall === frames;
    run.onFrame(stall ? 4000 : costOf(current));
  }
  return { result: run.result, frames, rates };
}

/** Linear cost, vsync-capped -- the same model `rateSearch.test.ts` uses. */
function machine(msPerStep: number, overhead = 4): (rate: number) => number {
  return (rate) => Math.max(TARGET_MS, overhead + rate * msPerStep);
}

test('a run completes and commits an affordable rate', () => {
  const cost = machine(0.5);
  const { result } = drive(cost, 40);
  assert.ok(result !== null, 'the run should have committed something');
  assert.ok(
    cost(result) <= TARGET_MS + 1,
    `committed ${String(result)}, which costs ${cost(result).toFixed(1)}ms`,
  );
});

test('a run finishes in a couple of seconds of frames', () => {
  // 20 frames per probe (5 settle + 15 measure) and at most 8 probes is 160
  // frames, under three seconds at 60 fps. A button that took ten seconds would
  // feel broken.
  for (const start of [1, 20, 60, 120]) {
    const { frames } = drive(machine(0.3), start);
    assert.ok(frames <= 200, `start=${String(start)} took ${String(frames)} frames`);
  }
});

test('the rate is applied to the simulation at every probe', () => {
  // The user is meant to SEE the search happen -- the slider jumping is the
  // feedback that something is underway.
  const { rates } = drive(machine(0.4), 30);
  assert.ok(rates.length >= 2, 'expected the rate to move during the search');
  // The first application is the starting rate, from the constructor.
  assert.equal(rates[0], 30);
});

test('settle frames are discarded rather than measured', () => {
  // A machine that reports a catastrophic first few frames after every change,
  // then settles. If the settle frames were measured, the search would see a
  // machine far slower than it is and drive the rate to the floor.
  let sinceChange = 0;
  let current = 40;
  const run = new AutoCalibration({
    lo: LO,
    hi: HI,
    startRate: 40,
    setRate: (rate) => {
      current = rate;
      sinceChange = 0;
    },
  });

  let frames = 0;
  while (!run.finished && frames < 2000) {
    frames++;
    sinceChange++;
    // The first 5 frames after any change are 10x too slow.
    const settled = Math.max(TARGET_MS, 4 + current * 0.1);
    run.onFrame(sinceChange <= 5 ? settled * 10 : settled);
  }

  assert.ok(run.result !== null);
  // 0.1ms per step means even the ceiling is affordable, so a search that
  // ignored the settle frames lands high. One that measured them lands low.
  assert.ok(
    run.result! > 40,
    `settle frames leaked into the measurement (landed at ${String(run.result)})`,
  );
});

test('a single stalled frame does not corrupt a probe', () => {
  // A 4-second frame -- a backgrounded tab, or a long task. It must be dropped
  // rather than averaged in, or one probe would report an impossibly slow
  // machine and the search would dive.
  const cost = machine(0.1);
  const clean = drive(cost, 60);
  const stalled = drive(cost, 60, { injectStall: 8 });
  assert.equal(
    stalled.result,
    clean.result,
    'a stalled frame changed the outcome; the outlier guard is not working',
  );
});

test('progress is reported for each probe', () => {
  const seen: { probe: number; rate: number }[] = [];
  let current = 30;
  const run = new AutoCalibration({
    lo: LO,
    hi: HI,
    startRate: 30,
    setRate: (rate) => {
      current = rate;
    },
    onProgress: (p) => seen.push({ ...p }),
  });

  const cost = machine(0.5);
  let frames = 0;
  while (!run.finished && frames < 2000) {
    frames++;
    run.onFrame(cost(current));
  }

  assert.ok(seen.length >= 1, 'expected at least one progress report');
  assert.equal(seen[0]!.probe, 1, 'the first report is probe 1');
  // Probe numbers must ascend without gaps.
  for (let i = 1; i < seen.length; i++) {
    assert.equal(seen[i]!.probe, seen[i - 1]!.probe + 1);
  }
});

test('cancelling restores the starting rate', () => {
  // THE PROPERTY THAT MATTERS FOR CANCEL. The search moves the rate several
  // times for its own purposes; abandoning midway must not leave the user at
  // one of those intermediate values, which is neither their choice nor an
  // answer -- and which they could not tell apart from a finished result.
  let current = 25;
  const run = new AutoCalibration({
    lo: LO,
    hi: HI,
    startRate: 25,
    setRate: (rate) => {
      current = rate;
    },
  });

  const cost = machine(2); // slow, so the search will move the rate a long way
  for (let i = 0; i < 60; i++) run.onFrame(cost(current));
  assert.notEqual(current, 25, 'the search should have moved the rate by now');

  run.cancel();
  assert.equal(current, 25, 'cancel must put the original rate back');
  assert.equal(run.result, null, 'a cancelled run has no result');
  assert.ok(run.finished);
});

test('frames after completion are ignored', () => {
  // `main.ts` feeds every frame; the run must not keep reacting once it is done.
  const cost = machine(0.5);
  let current = 40;
  const run = new AutoCalibration({
    lo: LO,
    hi: HI,
    startRate: 40,
    setRate: (rate) => {
      current = rate;
    },
  });
  let frames = 0;
  while (!run.finished && frames < 2000) {
    frames++;
    run.onFrame(cost(current));
  }
  const settled = run.result;
  for (let i = 0; i < 100; i++) run.onFrame(cost(current));
  assert.equal(run.result, settled, 'a finished run must not keep searching');
});

test('a machine that cannot hold 60 fps lands on the floor', () => {
  const { result } = drive(() => 40, 30);
  assert.equal(result, LO);
});
