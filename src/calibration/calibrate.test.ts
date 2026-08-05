/**
 * The calibration ladder.
 *
 * Driven against a fake target with an injected clock, so the walk is tested
 * without a GPU and without waiting real milliseconds. What matters here is the
 * decision logic -- where it stops, what it commits, and that it commits at all
 * on every exit path -- since the failure mode of getting that wrong is a user
 * silently stranded on the wrong settings.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { calibrate, type CalibrationTarget } from './calibrate.ts';
import { PROGRESSION, budgetMs, cost, type Rung } from './progression.ts';

/**
 * A target whose probe time is a function of the rung's cost.
 *
 * `msPerCost` is the machine being simulated: multiply it by a rung's cost to
 * get that rung's frame time. Higher is slower.
 */
function fakeTarget(
  msPerCost: number,
  opts: { throwAt?: number } = {},
): CalibrationTarget & {
  committed: Rung | null;
  clock: () => number;
  probes: number;
} {
  let current: Rung = { worldSize: PROGRESSION[0]!.worldSize, physicsSteps: PROGRESSION[0]!.physicsSteps };
  let t = 0;
  const state = {
    committed: null as Rung | null,
    probes: 0,
    clock: (): number => t,
    calibrateTo: (worldSize: number, physicsSteps: number): Promise<void> => {
      current = { worldSize, physicsSteps };
      return Promise.resolve();
    },
    probeFrame: (): Promise<void> => {
      state.probes++;
      if (opts.throwAt !== undefined && state.probes >= opts.throwAt) {
        return Promise.reject(new Error('device lost'));
      }
      // The clock only advances inside a probe, so the elapsed time the ladder
      // measures is exactly this rung's simulated frame time.
      t += cost(current) * msPerCost;
      return Promise.resolve();
    },
    commitCalibration: (worldSize: number, physicsSteps: number): void => {
      state.committed = { worldSize, physicsSteps };
    },
  };
  return state;
}

test('a fast machine reaches the top rung', () => {
  // Fast enough that even cost 20 lands inside the budget.
  const msPerCost = budgetMs() / 20 / 2;
  const target = fakeTarget(msPerCost);
  return calibrate(target, { now: target.clock }).then((rung) => {
    assert.deepEqual({ ...rung }, { ...PROGRESSION.at(-1)! });
    assert.deepEqual(target.committed, { ...PROGRESSION.at(-1)! });
  });
});

test('a slow machine falls back to the unprobed floor', () => {
  // So slow that even rung 1 (cost 0.25) misses the budget.
  const msPerCost = budgetMs() / 0.25 * 2;
  const target = fakeTarget(msPerCost);
  return calibrate(target, { now: target.clock }).then((rung) => {
    assert.deepEqual({ ...rung }, { ...PROGRESSION[0]! });
    assert.deepEqual(target.committed, { ...PROGRESSION[0]! });
  });
});

test('it stops at the last rung that fit, not the first that did not', () => {
  // Tuned so cost 6.0 fits and cost 9.0 does not: the answer must be the
  // (0.6, 10) rung, and NOT the (0.6, 15) rung that failed.
  const msPerCost = budgetMs() / 7.5;
  const target = fakeTarget(msPerCost);
  return calibrate(target, { now: target.clock }).then((rung) => {
    assert.deepEqual({ ...rung }, { worldSize: 0.6, physicsSteps: 10 });
    assert.ok(cost(rung) * msPerCost <= budgetMs(), 'committed a rung over budget');
  });
});

test('a rung exactly at the budget passes', () => {
  // The comparison is `>`, so landing exactly on the budget is affordable.
  // Worth pinning: flipping it to `>=` would cost a rung on every machine whose
  // hardware happens to sit on a boundary.
  const target = fakeTarget(budgetMs() / 2.5);
  return calibrate(target, { now: target.clock }).then((rung) => {
    assert.deepEqual({ ...rung }, { worldSize: 0.25, physicsSteps: 10 });
  });
});

test('a thrown probe commits whatever had already passed', () => {
  // A device lost mid-walk must not lose the rungs already measured, and must
  // not propagate -- calibration runs on the startup path.
  const msPerCost = budgetMs() / 20 / 2; // Fast: nothing would fail on its own.
  // Rung 1 costs 5 probes (2 warm-up + 3 timed), so throwing on the 11th lands
  // in rung 3, after rungs 1 and 2 have passed.
  const target = fakeTarget(msPerCost, { throwAt: 11 });
  return calibrate(target, { now: target.clock }).then((rung) => {
    assert.deepEqual({ ...rung }, { worldSize: 0.25, physicsSteps: 10 });
    assert.deepEqual(target.committed, { worldSize: 0.25, physicsSteps: 10 });
  });
});

test('cancelling commits what passed and stops probing', () => {
  const msPerCost = budgetMs() / 20 / 2;
  const target = fakeTarget(msPerCost);
  let calls = 0;
  return calibrate(target, {
    now: target.clock,
    // Asked ONCE PER RUNG, before that rung is probed. The first two calls let
    // rungs 1 and 2 through; the third ends the walk before rung 3 is touched.
    cancelled: () => ++calls > 2,
  }).then((rung) => {
    assert.deepEqual({ ...rung }, { worldSize: 0.25, physicsSteps: 10 });
    assert.deepEqual(target.committed, { worldSize: 0.25, physicsSteps: 10 });
    // 2 rungs x (2 warm-up + 3 timed). Nothing was probed after the cancel.
    assert.equal(target.probes, 10);
  });
});

test('the wall-clock ceiling ends a walk that is passing but slow', () => {
  // Every rung fits the per-frame budget, but the walk as a whole takes too
  // long. The ceiling is the only thing that stops this case -- the per-rung
  // check never fires.
  const target = fakeTarget(budgetMs() / 20 / 2);
  let now = 0;
  return calibrate(target, {
    // Two rungs' worth of probes is 10; past that the clock reads beyond the
    // 3 s ceiling, so the walk ends before rung 3 despite every rung fitting.
    now: () => (target.probes >= 10 ? 99_999 : now++),
  }).then((rung) => {
    assert.deepEqual({ ...rung }, { worldSize: 0.25, physicsSteps: 10 });
    assert.deepEqual(target.committed, { worldSize: 0.25, physicsSteps: 10 });
    // The ceiling, not the budget: every rung probed was comfortably fast.
    assert.equal(target.probes, 10);
  });
});

test('progress is reported once per probed rung', () => {
  const target = fakeTarget(budgetMs() / 20 / 2);
  const seen: number[] = [];
  return calibrate(target, {
    now: target.clock,
    onProgress: (done, total) => {
      seen.push(done);
      // The floor is not probed, so the denominator is the number of rungs that
      // actually get measured -- a progress line reading "1/7" that can only
      // ever reach 6 would be wrong.
      assert.equal(total, PROGRESSION.length - 1);
    },
  }).then(() => {
    assert.deepEqual(seen, [1, 2, 3, 4, 5, 6]);
  });
});

test('warm-up frames are not timed', () => {
  // The first frames after a settings change pay one-off costs -- pipeline
  // warm-up, first-touch allocation, uniform buffer growth. If those were
  // timed, this machine (fast in the steady state, catastrophically slow on its
  // first frame at each rung) would fail rung 1 and fall back to the floor.
  let probes = 0;
  let t = 0;
  const target: CalibrationTarget & { committed: Rung | null } = {
    committed: null,
    calibrateTo: () => {
      probes = 0; // Each rung gets its own expensive first frames.
      return Promise.resolve();
    },
    probeFrame: () => {
      t += probes++ < 2 ? 10_000 : 0.01;
      return Promise.resolve();
    },
    commitCalibration: (worldSize, physicsSteps) => {
      target.committed = { worldSize, physicsSteps };
    },
  };
  return calibrate(target, { now: () => t }).then((rung) => {
    // It still stops on the wall-clock ceiling -- 10 s of warm-up blows past
    // 3 s -- but the rung it reached proves the warm-up was excluded from the
    // per-rung timing rather than failing it outright.
    assert.ok(cost(rung) > cost(PROGRESSION[0]!), 'warm-up frames were timed');
  });
});
