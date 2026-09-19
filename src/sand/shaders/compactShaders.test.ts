/**
 * Structural checks on the GPU-only compaction passes.
 *
 * Nothing here compiles WGSL -- that needs a device. What is covered is the
 * class of mistake a compiler would not catch and a screenshot would not show,
 * which for these four passes is mostly AGREEMENT: between the count pass and
 * the scatter pass about how the buffer is partitioned, between the shaders and
 * the host arithmetic about workgroup sizes, and between the scatter and
 * `freeList.ts` about fill order.
 *
 * Every one of those, if broken, produces a world that looks plausible and is
 * quietly wrong -- which is the entire history of this subsystem.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveIncludes } from '../../../tools/wgslInclude.ts';
import {
  COMPACT_WORKGROUP_SIZE,
  SCAN_ELEMENTS_PER_GROUP,
} from '../../particleSystem/compactPlan.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = path.join(here, '..', '..', 'shaders');

function expand(name: string): string {
  return resolveIncludes(path.join(here, name), { sharedDir: SHARED_DIR });
}

const COUNT = expand('compactCount.wgsl');
const SCAN = expand('compactScan.wgsl');
const SCATTER = expand('compactScatter.wgsl');
const FINALIZE = expand('compactFinalize.wgsl');

const PASSES = [
  ['compactCount.wgsl', COUNT],
  ['compactScan.wgsl', SCAN],
  ['compactScatter.wgsl', SCATTER],
  ['compactFinalize.wgsl', FINALIZE],
] as const;

// ---------------------------------------------------------------------------
// Workgroup sizes
//
// THE COUNT AND SCATTER PASSES MUST AGREE EXACTLY. The scatter reads the offset
// that count's workgroup produced; if they partitioned the buffer differently
// the scatter would read the wrong partial and pack particles on top of each
// other. The failure is silent and size-dependent.
// ---------------------------------------------------------------------------

test('count and scatter declare the host workgroup size', () => {
  const expected = new RegExp(`@workgroup_size\\(${COMPACT_WORKGROUP_SIZE}\\)`);
  assert.match(COUNT, expected);
  assert.match(SCATTER, expected);
});

test('the scan workgroup covers two elements per thread', () => {
  assert.match(SCAN, new RegExp(`@workgroup_size\\(${COMPACT_WORKGROUP_SIZE}\\)`));
  // The workgroup array must be sized to the elements per group, not to the
  // thread count -- a 256-element array with 512 elements scanned would read
  // and write out of bounds through the whole up-sweep.
  assert.ok(
    SCAN.includes(`array<u32, ${SCAN_ELEMENTS_PER_GROUP}>`),
    `the scan's workgroup array must hold ${SCAN_ELEMENTS_PER_GROUP} elements`,
  );
});

test('the finalize pass is a single invocation', () => {
  // It writes two scalars. More than one invocation would have them racing to
  // write the same words.
  assert.match(FINALIZE, /@workgroup_size\(1\)/);
});

// ---------------------------------------------------------------------------
// Barrier discipline
//
// A `workgroupBarrier` that only some invocations reach is undefined behaviour
// in WGSL. On a ragged final workgroup -- which every buffer whose size is not
// a multiple of 256 has -- that is the NORMAL case, not a corner. So the
// out-of-range invocations must fall through to the barriers rather than
// returning early.
// ---------------------------------------------------------------------------

test('the count pass does not return before its barriers', () => {
  const body = COUNT.slice(COUNT.indexOf('fn main'));
  const firstBarrier = body.indexOf('workgroupBarrier');
  const earlyReturn = body.indexOf('return;');
  assert.ok(firstBarrier >= 0, 'the reduction barriers exist');
  assert.ok(
    earlyReturn === -1 || earlyReturn > firstBarrier,
    'an out-of-range invocation must reach the barrier, not return before it',
  );
});

test('the scatter pass does not return before its barrier', () => {
  const body = SCATTER.slice(SCATTER.indexOf('fn main'));
  const firstBarrier = body.indexOf('workgroupBarrier');
  const earlyReturn = body.indexOf('return;');
  assert.ok(firstBarrier >= 0);
  assert.ok(
    earlyReturn === -1 || earlyReturn > firstBarrier,
    'the bounds check must come after the barrier',
  );
});

// ---------------------------------------------------------------------------
// The free list
// ---------------------------------------------------------------------------

// THE REGRESSION GUARD for the leak that motivated this rewrite.
//
// The previous compaction claimed destination slots with an atomic cursor and
// never told the free list, leaking one slot per relocation -- 69,184 in the
// audit that caught it. The scatter must WRITE the pool, not patch it.
test('the scatter writes free-list slots directly', () => {
  assert.ok(
    SCATTER.includes('freelist.slots[slot] = index'),
    'dead indices are written into the pool by position, not pushed',
  );
  const body = SCATTER.slice(SCATTER.indexOf('fn main'));
  assert.ok(
    !body.includes('free_list_take') && !body.includes('free_list_give'),
    'no push or pop: the pool is rebuilt from scratch, not mutated',
  );
});

// THE REGRESSION GUARD for the mark creeping again.
//
// `freeList.ts` is emphatic that the stack pops slots[head-1], so a DESCENDING
// fill puts the lowest free index on top and allocation runs upward from the
// bottom. An ascending fill here would still produce a valid pool -- every
// index present exactly once -- while quietly undoing the property that makes
// the high-water mark useful at all.
// THE REGRESSION GUARD for a buffer that reads as entirely alive.
//
// `dst` is scratch, and an unwritten entity is 32 zero bytes -- which is NOT a
// dead particle. Zero is a valid config index, so a zeroed slot is a LIVE
// particle on config 0; `deadEntityBytes` documents this at length.
//
// The first version of the scatter wrote only the live destinations and left
// the rest untouched. The audit was unambiguous: live 6,000,000 of 6,000,000,
// the whole tail above the mark simultaneously alive AND in the free list. The
// scan and the mark were both correct; only the tail was garbage.
test('the scatter marks the tail dead rather than leaving it zeroed', () => {
  assert.ok(
    SCATTER.includes('make_entity_dead()'),
    'every slot at or above the live count must be written dead, because an ' +
      'unwritten one reads as alive on config 0',
  );
  assert.match(
    SCATTER,
    /index >= live_count\(\)/,
    'and the tail is exactly the range at or above the live count',
  );
});

test('the scatter fills the pool descending, lowest index on top', () => {
  assert.ok(
    SCATTER.includes('free_total - 1u - dead_before'),
    'the slot position must invert the dead rank, or allocation runs downward',
  );
});

test('only the finalize pass writes the head', () => {
  // The head must not move while the scatter is still writing slots, or a
  // spawn racing the tail could pop an index that has not been written yet.
  assert.ok(FINALIZE.includes('atomicStore(&freelist.head'));
  assert.ok(
    !SCATTER.includes('atomicStore(&freelist.head'),
    'the scatter must leave the head alone',
  );
});

test('the finalize pass publishes the live count as the mark', () => {
  // For a packed buffer the highest live index is live-1, so the mark IS the
  // live count. Anything else here would be an estimate, which is what the GPU
  // rewrite exists to stop.
  assert.ok(FINALIZE.includes('result[0] = live'));
});

test('the finalize pass clamps the total it was handed', () => {
  // A corrupt scan total would otherwise produce a head of entity_count - huge,
  // which underflows u32 and offers billions of slots.
  assert.ok(FINALIZE.includes('min(scratch[u.params.y], entity_count)'));
});

// ---------------------------------------------------------------------------
// Declaration order for the free-list include
// ---------------------------------------------------------------------------

test('passes using FreeList declare struct, binding, then use', () => {
  for (const [name, source] of [
    ['compactScatter.wgsl', SCATTER],
    ['compactFinalize.wgsl', FINALIZE],
  ] as const) {
    const struct = source.indexOf('struct FreeList');
    const binding = source.indexOf('freelist : FreeList');
    assert.ok(struct >= 0, `${name}: the struct is included`);
    assert.ok(binding >= 0, `${name}: a binding named freelist is declared`);
    assert.ok(struct < binding, `${name}: struct precedes binding`);
  }
});

// ---------------------------------------------------------------------------
// Reserved keywords
//
// `target` is reserved in WGSL and naming a function with it is a PARSE error,
// which leaves the pipeline null and the pass silently doing nothing. That
// shipped once in the previous compaction.
// ---------------------------------------------------------------------------

test('no compaction pass declares a function with a reserved keyword', () => {
  const RESERVED = ['target', 'filter', 'sample', 'texture', 'binding', 'access'];
  for (const [name, source] of PASSES) {
    for (const word of RESERVED) {
      assert.ok(
        !new RegExp(`\\bfn\\s+${word}\\s*\\(`).test(source),
        `${name} declares fn ${word}(), which WGSL reserves`,
      );
    }
  }
});

test('no compaction pass takes a storage pointer parameter', () => {
  // Needs `unrestricted_pointer_parameters`, which is not baseline WebGPU --
  // it compiles on some implementations and fails on others.
  for (const [name, source] of PASSES) {
    const declarations = source.match(/^\s*fn\s+\w+\s*\([^)]*\)/gm) ?? [];
    for (const decl of declarations) {
      assert.ok(!decl.includes('ptr<storage'), `${name}: ${decl.trim()}`);
    }
  }
});
