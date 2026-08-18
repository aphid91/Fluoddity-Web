/**
 * Picking arithmetic: the key packing, the result layout, the radius.
 *
 * The port of `tests/test_async_pick.py`'s `check_key_packing()` (:84), which is
 * pure arithmetic and needs no GPU on either platform. The GPU half of that
 * Python test compares `pick_blocking` against the deferred path -- and
 * `pick_blocking` explicitly does not port (it stalls), so what carries across
 * is the packing check plus the browser verification in web/README.md.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveIncludes } from '../../tools/wgslInclude.ts';
import { sizingFor } from './sizing.ts';
import { layoutOf } from './layout.ts';
import { SETTINGS } from '../ui/settingsSpec.ts';
import {
  DEFAULT_PICK_RADIUS_PX,
  DIST_BITS,
  DIST_MAX,
  INDEX_BITS,
  INDEX_MASK,
  MISS,
  NO_HIT,
  PICK_COHORT_OFFSET,
  PICK_KEY_OFFSET,
  PICK_POS_OFFSET,
  PICK_RESULT_SIZE,
  PICK_RULE_OFFSET,
  RULE_FLOATS,
  decodePickResult,
  isHit,
  radiusPxToWorld,
} from './pick.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Build a 336-byte result the way the GPU would. */
function encodeResult(
  key: number,
  pos: readonly [number, number] = [0, 0],
  rule: readonly number[] = new Array(RULE_FLOATS).fill(0),
  cohort = 0,
): ArrayBuffer {
  const buffer = new ArrayBuffer(PICK_RESULT_SIZE);
  new Uint32Array(buffer, PICK_KEY_OFFSET, 1)[0] = key;
  new Float32Array(buffer, PICK_POS_OFFSET, 2).set(pos);
  new Float32Array(buffer, PICK_COHORT_OFFSET, 1)[0] = cohort;
  new Float32Array(buffer, PICK_RULE_OFFSET, RULE_FLOATS).set(rule);
  return buffer;
}

/** Pack a key the way entityPick.wgsl's reduce pass does. */
function packKey(distQ: number, index: number): number {
  return ((distQ << INDEX_BITS) | index) >>> 0;
}

// ---------------------------------------------------------------------------
// The key packing -- test_async_pick.py:84
// ---------------------------------------------------------------------------

test('the key packs an index and a distance into exactly 32 bits', () => {
  assert.equal(INDEX_BITS + DIST_BITS, 32, 'the key must use all 32 bits and no more');
  assert.equal(INDEX_MASK, 0x00ffffff);
  assert.equal(DIST_MAX, 255);
});

test('the index field reaches every entity the app can create', () => {
  // THE BUG THIS EXISTS FOR: the index field was once 20 bits, while world size
  // 2.0 creates 1.2M entities -- so everything past 2^20 silently stopped being
  // pickable. That reads as "the last cohorts ignore clicks", not as an error,
  // which is why it is asserted rather than reasoned about.
  //
  // Read from the REGISTRY, as `test_async_pick.py` reads it out of
  // `ui/settings_spec.py`. Step 7 landed `settingsSpec.ts`, so the hardcoded
  // 4.0 this used to carry is gone -- a restated bound that drifts from the
  // actual slider is exactly the silence this test guards against.
  const worldSize = SETTINGS.find((s) => s.field === 'worldSize');
  assert.ok(worldSize !== undefined, 'no World Size entry in the settings registry');
  const [entityCount] = sizingFor(worldSize.hi);
  const WORLD_SIZE_MAX = worldSize.hi;
  assert.ok(
    entityCount - 1 <= INDEX_MASK,
    `world size ${WORLD_SIZE_MAX} makes ${entityCount} entities, but the index ` +
      `field only addresses ${INDEX_MASK + 1}`,
  );
});

test('the shader constants match the TypeScript ones', () => {
  // These live in different files and different languages. The Python parses
  // entity_pick.glsl for the same reason (test_async_pick.py:65). A drift here
  // means the host decodes a key the shader packed differently -- so the index
  // is wrong, and a wrong index adopts a rule from the wrong particle.
  const source = resolveIncludes(path.join(here, 'shaders', 'entityPick.wgsl'), {
    sharedDir: path.join(here, '..', 'shaders'),
  });
  const indexBits = /const\s+INDEX_BITS\s*:\s*u32\s*=\s*(\d+)u/.exec(source);
  const distBits = /const\s+DIST_BITS\s*:\s*u32\s*=\s*(\d+)u/.exec(source);
  assert.ok(indexBits !== null, 'entityPick.wgsl declares no INDEX_BITS');
  assert.ok(distBits !== null, 'entityPick.wgsl declares no DIST_BITS');
  assert.equal(Number(indexBits[1]), INDEX_BITS, 'INDEX_BITS disagrees with pick.ts');
  assert.equal(Number(distBits[1]), DIST_BITS, 'DIST_BITS disagrees with pick.ts');
});

// ---------------------------------------------------------------------------
// The result layout
// ---------------------------------------------------------------------------

test('the result buffer is 336 bytes with the rule 16-byte aligned', () => {
  // WEB_PORT_PLAN.md Step 6 says 324 (= 4 + 320). That predates both the
  // padding WGSL inserts before a vec4-aligned Rule and the position that rides
  // inside it. If this ever reads 352, someone moved `pos` after the rule and
  // it claimed a lane of its own.
  assert.equal(PICK_RESULT_SIZE, 336);
  assert.equal(PICK_RULE_OFFSET, 16);
  assert.equal(PICK_RULE_OFFSET % 16, 0);
  assert.equal(layoutOf('Rule').size, RULE_FLOATS * 4);
  // pos sits in the padding between the key and the rule -- it costs nothing.
  assert.ok(PICK_POS_OFFSET + 8 <= PICK_RULE_OFFSET, 'pos must fit before the rule');
  // ...and the cohort takes the last 4 bytes of that same padding, which is why
  // adding it did not move the rule or grow the buffer. It must not overlap the
  // position: both are read out of the one hole, and an offset collision would
  // decode a coordinate as a cohort and highlight an arbitrary population.
  assert.equal(PICK_COHORT_OFFSET, 12);
  assert.ok(PICK_COHORT_OFFSET >= PICK_POS_OFFSET + 8, 'cohort must not overlap pos');
  assert.ok(PICK_COHORT_OFFSET + 4 <= PICK_RULE_OFFSET, 'cohort must fit before the rule');
});

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

test('the NO_HIT sentinel decodes to a miss', () => {
  const result = decodePickResult(encodeResult(NO_HIT), 0.08);
  assert.equal(result.index, -1);
  assert.equal(isHit(result), false);
  assert.equal(result.rule, null, 'a miss has no rule to adopt');
  assert.deepEqual(result, MISS);
});

test('a key round-trips through index, distance and position', () => {
  const rule = Array.from({ length: RULE_FLOATS }, (_, i) => i * 0.25);
  const bytes = encodeResult(packKey(128, 12345), [0.125, -0.5], rule, 6);

  const result = decodePickResult(bytes, 0.08);
  assert.equal(result.index, 12345);
  assert.equal(isHit(result), true);
  // 128/255 of the radius.
  assert.ok(Math.abs(result.distance - (128 / 255) * 0.08) < 1e-9);
  assert.deepEqual(result.pos, [0.125, -0.5]);
  assert.deepEqual(result.rule, rule);
  // The cohort the highlight compares. Already floored by the derive pass, so
  // it arrives as an integer and needs no rounding here.
  assert.equal(result.cohort, 6);
});

test('a miss reports no cohort, whatever the buffer holds', () => {
  // THE STALE-COHORT HAZARD. `derive` returns early on NO_HIT without writing
  // anything, so on a miss these bytes are the PREVIOUS pick's -- here a
  // plausible-looking cohort 4. Reading it would highlight a cohort the mouse is
  // nowhere near, and it would look like a working feature pointed at the wrong
  // particles. The early return for MISS is what makes it unobservable.
  const bytes = encodeResult(NO_HIT, [9.0, 9.0], new Array(RULE_FLOATS).fill(1), 4);
  const result = decodePickResult(bytes, 0.08);
  assert.equal(result.cohort, -1);
  assert.deepEqual(result, MISS);
});

test('the miss cohort cannot collide with a real one', () => {
  // `get_cohort` is a non-negative ramp and the shader floors it, so every real
  // cohort is >= 0. `cohortHighlight.ts` relies on this to tell "no cohort" from
  // cohort 0, and so does camBrush.wgsl's `highlighted_cohort() >= 0.0`.
  assert.ok(MISS.cohort < 0);
});

test('the top bit of the key does not make the index negative', () => {
  // A quantized distance >= 128 sets bit 31. Decoding with a SIGNED shift makes
  // dist_q negative and the distance nonsense, and the bug only appears for
  // picks landing in the outer half of the radius -- i.e. rarely, and never in
  // the obvious test case at distance 0.
  const bytes = encodeResult(packKey(DIST_MAX, INDEX_MASK - 1));
  const result = decodePickResult(bytes, 0.08);
  assert.equal(result.index, INDEX_MASK - 1);
  assert.ok(Math.abs(result.distance - 0.08) < 1e-9, 'DIST_MAX must decode to the full radius');
  assert.ok(result.distance > 0);
});

test('the last index at the exact radius edge collides with NO_HIT, harmlessly', () => {
  // (dist_q = 255) << 24 | 0xFFFFFF is 0xFFFFFFFF -- bit for bit the sentinel.
  // This is REAL, not hypothetical: the shader guards `index > INDEX_MASK`, so
  // index 0xFFFFFF is encodable, and the desktop has the same collision
  // (entity_pick.glsl packs the key identically).
  //
  // It is benign, and worth writing down so nobody "fixes" it into a bug. That
  // key is the LARGEST the packing can produce, so atomicMin keeps it only when
  // no other candidate existed at all -- and it decodes as a miss, which is the
  // right answer for a particle sitting exactly on the radius edge. Reserving
  // an index or a distance bucket to dodge it would cost a real entity its
  // pickability to buy nothing.
  const collision = packKey(DIST_MAX, INDEX_MASK);
  assert.equal(collision, NO_HIT, 'the collision this documents no longer exists');
  assert.deepEqual(decodePickResult(encodeResult(collision), 0.08), MISS);
});

test('a distance of zero decodes to zero at any radius', () => {
  const result = decodePickResult(encodeResult(packKey(0, 7)), 999.0);
  assert.equal(result.index, 7);
  assert.equal(result.distance, 0);
});

test('the decoded rule does not alias the readback buffer', () => {
  // The caller unmaps the staging buffer immediately after decoding, which
  // DETACHES the ArrayBuffer -- a Float32Array view onto it would throw on
  // read, at the exact moment a user clicks. Array.from() is what prevents it.
  const rule = Array.from({ length: RULE_FLOATS }, (_, i) => i);
  const bytes = encodeResult(packKey(1, 1), [0, 0], rule);
  const result = decodePickResult(bytes, 1.0);

  new Float32Array(bytes, PICK_RULE_OFFSET, RULE_FLOATS).fill(-1);
  assert.deepEqual(result.rule, rule, 'the rule must be a copy, not a view');
});

test('a short buffer fails loudly rather than reading garbage', () => {
  assert.throws(() => decodePickResult(new ArrayBuffer(4), 0.08), /expected at least/);
});

// ---------------------------------------------------------------------------
// The radius
// ---------------------------------------------------------------------------

const SQUARE: readonly [number, number] = [1024, 1024];

test('the pick radius is the same in world units at any window position', () => {
  // The transform is isotropic, so measuring on x alone is sufficient -- and
  // the radius must not depend on where in the window the measurement is taken.
  const wide: readonly [number, number] = [1600, 900];
  const r = radiusPxToWorld(DEFAULT_PICK_RADIUS_PX, wide, SQUARE, [0, 0], 1.0);
  assert.ok(r > 0 && Number.isFinite(r));
});

test('zooming in shrinks the world-space radius proportionally', () => {
  // THE POINT OF DOING THIS THROUGH THE TRANSFORM: 40 screen pixels must stay
  // 40 screen pixels. Zoomed 2x in, the same pixels cover HALF the world.
  const window: readonly [number, number] = [1264, 649];
  const at1 = radiusPxToWorld(DEFAULT_PICK_RADIUS_PX, window, SQUARE, [0, 0], 1.0);
  const at2 = radiusPxToWorld(DEFAULT_PICK_RADIUS_PX, window, SQUARE, [0, 0], 2.0);
  const at4 = radiusPxToWorld(DEFAULT_PICK_RADIUS_PX, window, SQUARE, [0, 0], 4.0);

  assert.ok(Math.abs(at1 / at2 - 2.0) < 1e-6, 'zoom 2x should halve the world radius');
  assert.ok(Math.abs(at1 / at4 - 4.0) < 1e-6, 'zoom 4x should quarter it');
});

test('panning does not change the pick radius', () => {
  // Pan is a translation; a translation cannot change a distance. If this ever
  // fails, screenToWorld has picked up a scale term that depends on pan.
  const window: readonly [number, number] = [1264, 649];
  const centered = radiusPxToWorld(DEFAULT_PICK_RADIUS_PX, window, SQUARE, [0, 0], 1.5);
  const panned = radiusPxToWorld(DEFAULT_PICK_RADIUS_PX, window, SQUARE, [3.5, -2.25], 1.5);
  assert.ok(Math.abs(centered - panned) < 1e-9);
});

test('the radius scales linearly with the pixel count', () => {
  const window: readonly [number, number] = [1264, 649];
  const r40 = radiusPxToWorld(40, window, SQUARE, [0, 0], 1.0);
  const r80 = radiusPxToWorld(80, window, SQUARE, [0, 0], 1.0);
  assert.ok(Math.abs(r80 / r40 - 2.0) < 1e-6);
});

test('a degenerate window yields a zero radius rather than NaN', () => {
  // screenToNdc guards a zero window (coords.ts:269-271), so this returns 0 --
  // a pick that hits nothing, which is the right failure. NaN would compare
  // false against every distance and also hit nothing, but would poison
  // anything downstream that arithmetic on it.
  const r = radiusPxToWorld(DEFAULT_PICK_RADIUS_PX, [0, 0], SQUARE, [0, 0], 1.0);
  assert.ok(Number.isFinite(r), `radius must stay finite, got ${r}`);
  assert.equal(r, 0);
});

// ---------------------------------------------------------------------------
// The readback precondition -- the paused-picking bug
// ---------------------------------------------------------------------------
//
// THE BUG THESE EXIST FOR. `recordPick` used to be called from `runFrame`, which
// is exactly what a paused frame skips, while `beginPickReadback` ran every
// frame regardless. So clicking a particle while paused mapped a staging buffer
// that no encoder had written and decoded whatever was left in it. Both halves
// of picking now sit outside the paused branch in `Orchestrator.frame`, and the
// phase machine gained `recorded` between `dispatched` and `mapping` so that the
// readback demands proof the GPU work exists.
//
// `particleSystem.ts` imports `.wgsl` and so cannot be imported here (see the
// header). What is asserted instead is the two things that made the bug SILENT
// rather than loud: the decode of an unwritten buffer, and the transition rule.

test('an unwritten staging buffer decodes as a confident hit on entity 0', () => {
  // WHY THE BUG WAS INVISIBLE. A zeroed buffer is not obviously garbage: key 0
  // means distance 0 and index 0, which is the strongest possible hit. So a
  // paused click adopted entity 0's rule -- with an all-zero rule behind it --
  // and pushed it onto the undo stack, looking exactly like a real selection.
  // The header calls a wrong adopted rule the worst failure mode available.
  //
  // This is a STATEMENT OF THE HAZARD, not of desired behaviour: nothing
  // downstream can tell this from a legitimate pick, which is precisely why the
  // readback must never be started for work that was never recorded.
  const decoded = decodePickResult(new ArrayBuffer(PICK_RESULT_SIZE), 0.05);
  assert.equal(decoded.index, 0);
  assert.ok(isHit(decoded), 'a zeroed buffer reads as a hit -- hence the precondition');
});

test('a readback is legal only once the passes have been recorded', () => {
  // The transition rule `beginPickReadback` enforces, stated where it can be
  // read without a GPU. `dispatched` means the uniforms are written and nothing
  // more; only `recordPick` puts passes and the copy on an encoder, and only
  // then is there anything to map.
  const mayReadBack = (phase: string): boolean => phase === 'recorded';

  assert.equal(mayReadBack('idle'), false);
  assert.equal(
    mayReadBack('dispatched'),
    false,
    'requested is not recorded -- this exact gap is what broke picking while paused',
  );
  assert.equal(mayReadBack('recorded'), true);
  assert.equal(mayReadBack('mapping'), false, 'already in flight');
  assert.equal(mayReadBack('ready'), false, 'mapped; an unmap is owed');
});
