/**
 * Tests for the generated struct-layout descriptor.
 *
 * These check the *shipped snapshot*, not a parser -- the parser stays in
 * Python (see `layout.ts`). The failure mode being guarded against is a stale
 * or hand-edited `layout.generated.json`, which would silently reinterpret GPU
 * memory rather than erroring.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIG_DATA,
  CONFIG_DATA_FLOATS,
  CONFIG_DATA_STRIDE,
  ENTITY_STRIDE,
  WORLD_DATA_SIZE,
  assertLaneMap,
  layoutOf,
  memberOf,
} from './layout.ts';

// The struct table in docs/WEB_PORT_PLAN.md step 3, made executable.
test('struct sizes match the port plan', () => {
  assert.equal(layoutOf('FourierCenter').size, 32);
  assert.equal(layoutOf('Rule').size, 320);
  assert.equal(layoutOf('ConfigData').size, 416);
  assert.equal(layoutOf('WorldData').size, 32);
  assert.equal(layoutOf('Entity').size, 32);

  assert.equal(CONFIG_DATA_STRIDE, 416);
  assert.equal(WORLD_DATA_SIZE, 32);
  assert.equal(ENTITY_STRIDE, 32);
  assert.equal(CONFIG_DATA_FLOATS, 104);
});

// Names and order, so a rename or reordering that preserves sizes is still
// caught. Order matters: it is the byte order of the record.
test('struct members match common.glsl in name and order', () => {
  assert.deepEqual(
    CONFIG_DATA.members.map((m) => m.name),
    ['rule', 'sensor', 'force', 'misc', 'force2', 'misc2', 'misc3'],
  );
  assert.deepEqual(
    layoutOf('WorldData').members.map((m) => m.name),
    ['trail', 'bounds'],
  );
  assert.deepEqual(
    layoutOf('Entity').members.map((m) => m.name),
    ['pos_vel', 'misc'],
  );
  assert.deepEqual(
    layoutOf('FourierCenter').members.map((m) => m.name),
    ['frequency', 'amplitude'],
  );
});

test('ConfigData member byte offsets are the documented ones', () => {
  const offsets = Object.fromEntries(
    CONFIG_DATA.members.map((m) => [m.name, m.offset]),
  );
  assert.deepEqual(offsets, {
    rule: 0,
    sensor: 320,
    force: 336,
    misc: 352,
    force2: 368,
    misc2: 384,
    misc3: 400,
  });
});

// The claim that justifies treating `rule` as a flat 80-float memcpy in pack.ts
// rather than modelling FourierCenter nesting.
test('Rule is 10 FourierCenters at stride 32, contiguous', () => {
  const centers = memberOf('Rule', 'centers');
  assert.equal(centers.arrayLength, 10);
  assert.equal(centers.stride, 32);
  assert.equal(centers.floatCount, 80);
  assert.equal(centers.offset, 0);
  // stride x count == size means no padding between elements, which is what
  // makes the flat memcpy correct.
  assert.equal(centers.stride! * centers.arrayLength!, layoutOf('Rule').size);
});

// The TypeScript mirror of layout.py:125-142 (_assert_vec4_aligned). Redundant
// with the generator, which is the point: this also catches a hand-edited
// descriptor.
test('every struct is 16-byte regular', () => {
  for (const name of ['FourierCenter', 'Rule', 'ConfigData', 'WorldData', 'Entity']) {
    const struct = layoutOf(name);
    assert.equal(struct.size % 16, 0, `${name} size ${struct.size} not a multiple of 16`);
    for (const member of struct.members) {
      assert.equal(
        member.offset % 16,
        0,
        `${name}.${member.name} at offset ${member.offset} is not 16-byte aligned`,
      );
    }
  }
});

// floatIndex is what pack.ts indexes by, so it must actually equal offset/4.
test('floatIndex agrees with the byte offset', () => {
  for (const name of ['FourierCenter', 'Rule', 'ConfigData', 'WorldData', 'Entity']) {
    for (const member of layoutOf(name).members) {
      assert.equal(member.floatIndex, member.offset / 4, `${name}.${member.name}`);
      assert.equal(member.floatCount, member.size / 4, `${name}.${member.name}`);
    }
  }
});

test('members are contiguous and sum to the struct size', () => {
  for (const name of ['FourierCenter', 'Rule', 'ConfigData', 'WorldData', 'Entity']) {
    const struct = layoutOf(name);
    let cursor = 0;
    for (const member of struct.members) {
      assert.equal(member.offset, cursor, `${name}.${member.name} is not contiguous`);
      cursor += member.size;
    }
    assert.equal(cursor, struct.size, `${name} has trailing padding`);
  }
});

test('a missing struct or member fails loudly rather than returning undefined', () => {
  assert.throws(() => layoutOf('NoSuchStruct'), /has no struct "NoSuchStruct"/);
  assert.throws(() => memberOf('ConfigData', 'nope'), /has no member "nope"/);
});

// assertLaneMap is the drift guard config.ts calls. Test both directions:
// the real table passes, and a shifted one fails.
test('assertLaneMap accepts the true lane map', () => {
  assert.doesNotThrow(() =>
    assertLaneMap('ConfigData', {
      rule: 0,
      sensor: 80,
      force: 84,
      misc: 88,
      force2: 92,
      misc2: 96,
      misc3: 100,
    }),
  );
});

test('assertLaneMap rejects a lane map that has drifted', () => {
  // What a stale table looks like after a vec4 is inserted before misc3:
  // every later lane is four floats off.
  assert.throws(
    () => assertLaneMap('ConfigData', { misc3: 96 }),
    /is at float lane 100 .* but the LANE table says 96/s,
  );
  assert.throws(
    () => assertLaneMap('ConfigData', { nosuchmember: 0 }),
    /no member matching lane constant/,
  );
});
