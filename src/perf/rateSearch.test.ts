import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_PROBES, type Probe, TARGET_MS, nextStep } from './rateSearch.ts';

const LO = 1;
const HI = 120;

/**
 * Run the search against a synthetic machine and report where it landed.
 *
 * `costOf` is the machine: it maps a physics rate to the frame time that rate
 * would produce. Driving the search this way is the whole reason `nextStep` is
 * pure -- a fast GPU, a slow one, a noisy one and a vsync-capped one are four
 * one-line functions here and four impossible-to-arrange test fixtures in a
 * browser.
 */
function run(
  costOf: (rate: number) => number,
  startRate: number,
): { rate: number; probes: number[] } {
  const history: Probe[] = [];
  const probes: number[] = [];
  let next = startRate;

  for (let i = 0; i <= MAX_PROBES + 2; i++) {
    probes.push(next);
    history.push({ rate: next, frameMs: costOf(next) });
    const step = nextStep(history, LO, HI);
    if (step.kind === 'done') return { rate: step.rate, probes };
    next = step.rate;
  }
  throw new Error('the search never terminated');
}

/**
 * A machine whose frame time is linear in the physics rate, vsync-capped.
 *
 * `msPerStep` is how much one sub-step costs. The cap is what makes this
 * realistic and what makes a naive binary search fail: everything cheap enough
 * reports the same 16.7 ms.
 */
function machine(msPerStep: number, overhead = 4): (rate: number) => number {
  return (rate) => Math.max(TARGET_MS, overhead + rate * msPerStep);
}

test('a fast machine is driven up toward the ceiling', () => {
  // 0.05 ms per sub-step: rate 120 costs 4 + 6 = 10 ms, comfortably inside the
  // budget, so the whole range is affordable and the search should say so.
  const { rate } = run(machine(0.05), 5);
  assert.ok(rate >= 100, `expected a high rate on a fast machine, got ${String(rate)}`);
});

test('a slow machine is driven down to something it can hold', () => {
  // 2 ms per sub-step: only ~6 sub-steps fit in the budget.
  const { rate } = run(machine(2), 60);
  assert.ok(rate >= 1 && rate <= 8, `expected a low rate, got ${String(rate)}`);
});

test('a heavy project is walked DOWN from a high starting rate', () => {
  // The mirror of the plateau case, and the one a real heavy world produces:
  // the user is at a rate their project cannot afford, so every probe is over
  // budget and the search must descend by estimate rather than climb.
  //
  // 1.2 ms per sub-step over 6 ms of fixed cost -- roughly what a multi-million
  // entity world looks like. Rate 8 is the last affordable rung.
  const cost = machine(1.2, 6);
  const { rate, probes } = run(cost, 60);

  assert.ok(
    cost(rate) <= TARGET_MS + 1,
    `committed ${String(rate)}, which costs ${cost(rate).toFixed(1)}ms`,
  );
  // The first move must be DOWNWARD -- a climb here would be measuring rates the
  // machine has already shown it cannot hold.
  assert.ok(
    probes[1]! < probes[0]!,
    `expected a descent, probed ${probes.join(' -> ')}`,
  );
});

test('the committed rate is actually affordable on the machine that was probed', () => {
  // THE PROPERTY THAT MATTERS. Across a wide spread of machines and starting
  // points, whatever the search commits must genuinely fit in the frame budget
  // -- a calibration that leaves the user over budget has failed at its one job.
  for (const msPerStep of [0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5]) {
    for (const start of [1, 5, 20, 60, 120]) {
      const cost = machine(msPerStep);
      const { rate } = run(cost, start);
      assert.ok(
        cost(rate) <= TARGET_MS + 1,
        `msPerStep=${String(msPerStep)} start=${String(start)} committed ${String(rate)}, ` +
          `which costs ${cost(rate).toFixed(1)}ms`,
      );
    }
  }
});

test('the search always terminates well inside its probe budget', () => {
  for (const msPerStep of [0.02, 0.1, 0.5, 2, 5]) {
    for (const start of [1, 5, 20, 60, 120]) {
      const { probes } = run(machine(msPerStep), start);
      assert.ok(
        probes.length <= MAX_PROBES,
        `msPerStep=${String(msPerStep)} start=${String(start)} took ${String(probes.length)} probes`,
      );
    }
  }
});

test('a machine that cannot hold 60 fps at all lands on the floor', () => {
  // 30 ms of fixed overhead: over budget even at rate 1, so nothing is
  // affordable. The floor is the honest answer -- and it must not return some
  // never-probed estimate that is known to be too slow.
  const { rate } = run(() => 30, 40);
  assert.equal(rate, LO);
});

test('the plateau is climbed rather than bisected', () => {
  // A machine where everything up to rate 40 is capped and beyond it is not.
  // The search must WALK UP through the plateau -- a bisection would have no
  // gradient to work from and could stop anywhere in it.
  const cost = (rate: number): number => (rate <= 40 ? TARGET_MS : 4 + rate * 0.4);
  const { rate, probes } = run(cost, 5);

  assert.ok(rate >= 30, `expected the plateau to be climbed, landed at ${String(rate)}`);
  // Each plateau probe must be strictly higher than the last, which is what
  // "climbing" means and what distinguishes it from bisection.
  const climbing = probes.slice(0, 3);
  for (let i = 1; i < climbing.length; i++) {
    assert.ok(
      climbing[i]! > climbing[i - 1]!,
      `probe ${String(i)} did not climb: ${climbing.join(' -> ')}`,
    );
  }
});

test('one wild measurement cannot fling the rate to a bound', () => {
  // A GC pause on the first probe: 400 ms, ~24x over budget. Unclamped, the
  // proportion would divide the rate by 24 and land on the floor. The clamp
  // means it costs a probe instead.
  let first = true;
  const cost = (rate: number): number => {
    if (first) {
      first = false;
      return 400;
    }
    return Math.max(TARGET_MS, 4 + rate * 0.1);
  };
  const { rate } = run(cost, 60);
  assert.ok(rate > LO, `a single spike drove the search to the floor (${String(rate)})`);
});

test('the answer keeps a safety margin below the exact budget', () => {
  // Tuning to precisely 60 fps stops holding it the moment the GPU warms up or
  // another window takes a slice. The committed rate should sit under the one
  // that exactly filled the frame.
  //
  // 0.25 ms per sub-step with 4 ms of overhead: rate 50 costs exactly 16.5 ms,
  // so 50 is the last affordable rung and the answer must come in below it.
  // (A machine fast enough to afford the whole slider is a different case --
  // there the ceiling IS the right answer, which is why this picks a cost curve
  // whose edge falls inside the range.)
  const cost = machine(0.25, 4);
  const { rate } = run(cost, 60);
  assert.ok(rate < 50, `expected a margin below the affordable edge, got ${String(rate)}`);
  assert.ok(rate > 30, `but not a wasteful one, got ${String(rate)}`);
});

test('nextStep is pure -- the same history always gives the same answer', () => {
  const history: readonly Probe[] = [
    { rate: 20, frameMs: 25 },
    { rate: 13, frameMs: 18 },
  ];
  const a = nextStep(history, LO, HI);
  const b = nextStep(history, LO, HI);
  assert.deepEqual(a, b);
});

test('a proposed rate is always inside the slider bounds', () => {
  // The search must never suggest something the user could not also dial in by
  // hand -- `settingsSpec` bounds physics rate at 1..120.
  for (const msPerStep of [0.01, 0.1, 1, 10]) {
    for (const start of [1, 60, 120]) {
      const { rate, probes } = run(machine(msPerStep), start);
      for (const probe of probes) {
        assert.ok(probe >= LO && probe <= HI, `probed out of bounds: ${String(probe)}`);
      }
      assert.ok(rate >= LO && rate <= HI, `committed out of bounds: ${String(rate)}`);
    }
  }
});
