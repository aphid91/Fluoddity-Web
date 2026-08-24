/**
 * The calibration path.
 *
 * The ladder's correctness rests entirely on the path ASCENDING: it stops at
 * the first rung that misses the budget and keeps everything below it, which is
 * only sound if a rung that fails implies every rung above it would fail too.
 * A non-monotonic path would silently truncate at a cheap rung and hand the
 * user settings far below what their machine can hold.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROGRESSION, TARGET_FRAME_MS, HEADROOM, budgetMs, cost } from './progression.ts';
import { PREFS, settingFor } from '../ui/settingsSpec.ts';

test('cost ascends strictly along the path', () => {
  for (let i = 1; i < PROGRESSION.length; i++) {
    const prev = PROGRESSION[i - 1]!;
    const rung = PROGRESSION[i]!;
    assert.ok(
      cost(rung) > cost(prev),
      `rung ${i} (cost ${cost(rung)}) is not more expensive than rung ${i - 1} ` +
        `(cost ${cost(prev)}) -- the ladder's stop-at-first-failure is unsound`,
    );
  }
});

test('exactly one knob moves per step', () => {
  // The scheme alternates deliberately: raise world, then physics, then world
  // again. Moving both at once would make a failed rung ambiguous about which
  // knob was responsible, and would skip settings worth offering.
  for (let i = 1; i < PROGRESSION.length; i++) {
    const prev = PROGRESSION[i - 1]!;
    const rung = PROGRESSION[i]!;
    const worldMoved = rung.worldSize !== prev.worldSize;
    const physicsMoved = rung.physicsSteps !== prev.physicsSteps;
    assert.ok(
      worldMoved !== physicsMoved,
      `rung ${i} moves ${worldMoved && physicsMoved ? 'both knobs' : 'neither knob'}`,
    );
  }
});

test('neither knob ever decreases', () => {
  for (let i = 1; i < PROGRESSION.length; i++) {
    const prev = PROGRESSION[i - 1]!;
    const rung = PROGRESSION[i]!;
    assert.ok(rung.worldSize >= prev.worldSize, `world size falls at rung ${i}`);
    assert.ok(rung.physicsSteps >= prev.physicsSteps, `physics rate falls at rung ${i}`);
  }
});

test('the path runs from the specified floor to the specified ceiling', () => {
  // The endpoints are the whole agreement about what calibration may hand
  // someone automatically: nothing lighter than the floor is worth running, and
  // nothing heavier than the ceiling should be chosen without the user asking.
  assert.deepEqual({ ...PROGRESSION[0] }, { worldSize: 0.1, physicsSteps: 1 });
  assert.deepEqual({ ...PROGRESSION.at(-1) }, { worldSize: 1.0, physicsSteps: 20 });
});

test('every rung is a setting the user could also dial in by hand', () => {
  // A calibrated result lands in the same preferences the panel edits, so a
  // rung outside the control's range would display as an out-of-range slider
  // and be un-restorable once moved.
  const bound = (field: string): { lo: number; hi: number } => {
    const spec = settingFor(PREFS, field);
    assert.ok(spec !== null, `no ${field} preference setting`);
    return { lo: spec.lo, hi: spec.hi };
  };
  const world = bound('worldSize');
  const physics = bound('physicsSteps');

  for (const [i, rung] of PROGRESSION.entries()) {
    assert.ok(
      rung.worldSize >= world.lo && rung.worldSize <= world.hi,
      `rung ${i} world size ${rung.worldSize} is outside ${world.lo}..${world.hi}`,
    );
    assert.ok(
      rung.physicsSteps >= physics.lo && rung.physicsSteps <= physics.hi,
      `rung ${i} physics rate ${rung.physicsSteps} is outside ${physics.lo}..${physics.hi}`,
    );
    assert.equal(rung.physicsSteps, Math.trunc(rung.physicsSteps), `rung ${i} is fractional`);
  }
});

test('the budget leaves room for the rest of the frame', () => {
  // A probe times physics ONLY -- no camera, no assembler, no compositing --
  // so calibrating to the whole 16.7 ms would pick a rung that is affordable
  // in isolation and over budget in practice, on every machine.
  assert.ok(HEADROOM > 0 && HEADROOM < 1);
  assert.equal(budgetMs(), TARGET_FRAME_MS * HEADROOM);
  assert.ok(budgetMs() < TARGET_FRAME_MS);
});

test('the progression is frozen', () => {
  // Shared, module-level, and read on the startup path. A caller that mutated
  // it would change calibration for every later visitor in the same session.
  assert.ok(Object.isFrozen(PROGRESSION));
  for (const rung of PROGRESSION) assert.ok(Object.isFrozen(rung));
});
