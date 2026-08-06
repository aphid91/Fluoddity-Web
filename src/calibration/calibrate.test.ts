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
    // Mirrors the real one: a rebuild happens only when the world size moves,
    // and that is what drives the much longer burn-in.
    calibrateTo: (worldSize: number, physicsSteps: number): Promise<boolean> => {
      const rebuilt = worldSize !== current.worldSize;
      current = { worldSize, physicsSteps };
      return Promise.resolve(rebuilt);
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
    commitCalibration: (worldSize: number, physicsSteps: number): Promise<void> => {
      state.committed = { worldSize, physicsSteps };
      return Promise.resolve();
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
  // Rung 1 costs 35 probes (25 burn-in + 10 timed) and rung 2 costs 12, so
  // throwing on the 48th lands in rung 3, after rungs 1 and 2 have passed.
  const target = fakeTarget(msPerCost, { throwAt: 48 });
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
    // Rung 1 moves the world (25 burn-in + 10 timed); rung 2 moves only the
    // physics rate on the same warm system (2 warm-up + 10 timed). Nothing was
    // probed after the cancel.
    assert.equal(target.probes, 35 + 12);
  });
});

test('the wall-clock ceiling ends a walk that is passing but slow', () => {
  // Every rung fits the per-frame budget, but the walk as a whole takes too
  // long. The ceiling is the only thing that stops this case -- the per-rung
  // check never fires.
  const target = fakeTarget(budgetMs() / 20 / 2);
  let now = 0;
  return calibrate(target, {
    // Two rungs' worth of probes is 47; past that the clock reads beyond the
    // ceiling, so the walk ends before rung 3 despite every rung fitting.
    now: () => (target.probes >= 47 ? 99_999 : now++),
  }).then((rung) => {
    assert.deepEqual({ ...rung }, { worldSize: 0.25, physicsSteps: 10 });
    assert.deepEqual(target.committed, { worldSize: 0.25, physicsSteps: 10 });
    // The ceiling, not the budget: every rung probed was comfortably fast.
    assert.equal(target.probes, 47);
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

test('the walk does not resolve until the commit has settled', async () => {
  // The commit rebuilds the simulation and resets it, and `Panel.calibrate`
  // unlocks the splash the moment this resolves. Returning early would release
  // the user into an app still reshaping itself -- the exact state the lock is
  // there to hide -- so the await is load-bearing, not tidiness.
  let settled = false;
  const target: CalibrationTarget = {
    calibrateTo: () => Promise.resolve(false),
    probeFrame: () => Promise.resolve(),
    commitCalibration: async () => {
      await Promise.resolve();
      settled = true;
    },
  };
  await calibrate(target, { now: () => 0 });
  assert.ok(settled, 'calibrate resolved before the commit finished');
});

test('a commit that throws is contained', () => {
  // Same reasoning as a thrown probe: this runs on the startup path, and the
  // rebuild it triggers touches the GPU. It must not reject into `Panel`'s
  // `finally` as an unhandled path or leave the splash locked.
  const target: CalibrationTarget = {
    calibrateTo: () => Promise.resolve(false),
    probeFrame: () => Promise.resolve(),
    commitCalibration: () => Promise.reject(new Error('rebuild failed')),
  };
  return calibrate(target, { now: () => 0 }).then((rung) => {
    assert.ok(rung !== undefined, 'calibrate rejected instead of returning');
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
      return Promise.resolve(false);
    },
    probeFrame: () => {
      t += probes++ < 2 ? 10_000 : 0.01;
      return Promise.resolve();
    },
    commitCalibration: (worldSize, physicsSteps) => {
      target.committed = { worldSize, physicsSteps };
      return Promise.resolve();
    },
  };
  return calibrate(target, { now: () => t }).then((rung) => {
    // It still stops on the wall-clock ceiling -- 20 s of warm-up blows past it
    // -- but the rung it reached proves the warm-up was excluded from the
    // per-rung timing rather than failing it outright.
    assert.ok(cost(rung) > cost(PROGRESSION[0]!), 'warm-up frames were timed');
  });
});

test('nothing is probed until the page is visible', async () => {
  // A hidden tab is throttled hard -- rAF stops, GPU work is deprioritised --
  // so probes run in that state time as wildly slow and would fail rungs the
  // machine holds easily. The result would then be committed permanently, since
  // `calibrated` is set either way. So the walk must not start at all.
  const target = fakeTarget(budgetMs() / 20 / 2);
  let release = (): void => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });

  const walk = calibrate(target, {
    now: target.clock,
    waitUntilVisible: () => gate,
  });

  // Give the walk every chance to misbehave before the gate opens.
  for (let i = 0; i < 10; i++) await null;
  assert.equal(target.probes, 0, 'probed while the page was hidden');
  assert.equal(target.committed, null, 'committed while the page was hidden');

  release();
  const rung = await walk;
  assert.ok(target.probes > 0, 'never probed after becoming visible');
  assert.deepEqual({ ...rung }, { ...PROGRESSION.at(-1)! });
});

test('waiting for visibility is not charged against the ceiling', async () => {
  // The ceiling stops a pathologically slow GPU from holding the splash
  // forever. A backgrounded tab is not that -- it is the user not looking --
  // and charging the wait would abort the walk of anyone who opened the site in
  // a background tab and came back a minute later. Which is the exact case the
  // gating exists to serve.
  const target = fakeTarget(budgetMs() / 20 / 2);
  let clock = 0;
  let release = (): void => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });

  const walk = calibrate(target, {
    now: () => clock,
    // Blocks once, before the first rung.
    waitUntilVisible: (() => {
      let first = true;
      return () => {
        if (!first) return Promise.resolve();
        first = false;
        return gate;
      };
    })(),
  });

  for (let i = 0; i < 10; i++) await null;
  // A very long time passes while hidden -- far beyond the ceiling.
  clock = 60_000;
  release();

  const rung = await walk;
  // It still reached the top: the wait was excluded, so the ceiling never fired.
  assert.deepEqual({ ...rung }, { ...PROGRESSION.at(-1)! });
});

test('backgrounding mid-walk pauses rather than corrupting the result', async () => {
  // The rungs already banked were measured while visible and stay valid; the
  // walk picks up where it left off instead of measuring a throttled rung and
  // failing it. Anything else would produce the under-calibration this gating
  // is here to prevent, just later in the ladder.
  const target = fakeTarget(budgetMs() / 20 / 2);
  const waitingEvents: boolean[] = [];
  let release = (): void => {};
  let calls = 0;

  const rung = await calibrate(target, {
    now: target.clock,
    onWaiting: (w) => waitingEvents.push(w),
    waitUntilVisible: () => {
      // Visible except once, partway down the ladder.
      if (++calls !== 3) return Promise.resolve();
      return new Promise<void>((r) => {
        release = r;
        // Resolve on a later microtask, so the walk genuinely suspends.
        queueMicrotask(() => {
          release();
        });
      });
    },
  });

  assert.deepEqual({ ...rung }, { ...PROGRESSION.at(-1)! }, 'the walk did not finish');
  // Reported exactly one suspend/resume pair, and only for the blocking wait.
  assert.deepEqual(waitingEvents, [true, false]);
});

test('a visible page never reports waiting', async () => {
  // The common path. `onWaiting` firing here would flash a "come back" message
  // on screen once per rung for every user.
  const target = fakeTarget(budgetMs() / 20 / 2);
  const waitingEvents: boolean[] = [];
  await calibrate(target, {
    now: target.clock,
    onWaiting: (w) => waitingEvents.push(w),
    waitUntilVisible: () => Promise.resolve(),
  });
  assert.deepEqual(waitingEvents, []);
});

test('a rebuilt rung burns far more frames than a physics-only one', () => {
  // THE FIX FOR OVER-CONSERVATIVE FIRST RUNS. A world-size change builds a new
  // ParticleSystem whose frameCount starts at zero, and zero is the reset
  // sentinel: the frames right after it regenerate every entity and clear the
  // canvas, costing far more than the steady state that follows. Measuring
  // across them failed rungs the machine could actually hold -- which is why
  // re-calibrating later, from an already-warm simulation, landed better. A
  // physics-only rung inherits that warm simulation and needs no such settling.
  const perRung: number[] = [];
  let probes = 0;
  let world = PROGRESSION[0]!.worldSize;
  const target: CalibrationTarget = {
    calibrateTo: (worldSize: number) => {
      if (perRung.length > 0 || probes > 0) perRung.push(probes);
      probes = 0;
      const rebuilt = worldSize !== world;
      world = worldSize;
      return Promise.resolve(rebuilt);
    },
    probeFrame: () => {
      probes++;
      return Promise.resolve();
    },
    commitCalibration: () => {
      perRung.push(probes);
      return Promise.resolve();
    },
  };
  return calibrate(target, { now: () => 0 }).then(() => {
    // The progression alternates world / physics all the way down, so the probe
    // counts alternate too: 35 (25 burn-in + 10 timed) then 12 (2 warm-up + 10).
    assert.deepEqual(perRung, [35, 12, 35, 12, 35, 12]);
  });
});
