/**
 * Structural checks on the stamp passes.
 *
 * Nothing here compiles WGSL -- that needs a device. What is covered is the
 * class of mistake a compiler would not catch and a screenshot would not show:
 * AGREEMENT between the count pass and the scatter pass about which particles
 * are in the box, between the shaders and the host about workgroup sizes, and
 * between the passes and the free-list protocol about which direction each
 * moves the head.
 *
 * Every one of those, if broken, produces a stamp that looks plausible and is
 * quietly wrong -- a few particles missing, a seam duplicated, a slot leaked.
 * That is the same failure family the compaction shaders are tested against,
 * and for the same reason.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as fs from 'node:fs';

import { resolveIncludes } from '../../../tools/wgslInclude.ts';
import {
  STAMP_CLEAR_WORKGROUP_SIZE,
  STAMP_PASTE_WORKGROUP_SIZE,
  STAMP_WORKGROUP_SIZE,
} from '../stampDispatch.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = path.join(here, '..', '..', 'shaders');

/**
 * The shader with its includes inlined -- what the GPU actually compiles.
 *
 * Use for anything that must hold across the whole translation unit, such as a
 * declared workgroup size or the presence of a shared helper.
 */
function expand(name: string): string {
  return resolveIncludes(path.join(here, name), { sharedDir: SHARED_DIR });
}

/**
 * The shader's OWN text, with nothing inlined.
 *
 * ## Why several assertions below need this and not the expansion
 *
 * `freeListOps.wgsl` DEFINES both `free_list_take` and `free_list_give`, so
 * every shader that includes it contains both names after expansion --
 * regardless of which it calls. Asserting "paste never gives" against the
 * expanded text therefore always fails, and asserting the converse would always
 * pass, which is worse: a test that cannot fail is a test that is not checking
 * anything.
 *
 * The question these ask is about the CALL SITES, which live in the shader's own
 * body. So they read it directly.
 */
function raw(name: string): string {
  return fs.readFileSync(path.join(here, name), 'utf8');
}

const COUNT = expand('stampCount.wgsl');
const SCATTER = expand('stampScatter.wgsl');
const PASTE = expand('stampPaste.wgsl');
const CLEAR = expand('stampClear.wgsl');

const COUNT_SRC = raw('stampCount.wgsl');
const SCATTER_SRC = raw('stampScatter.wgsl');
const PASTE_SRC = raw('stampPaste.wgsl');
const CLEAR_SRC = raw('stampClear.wgsl');

// ---------------------------------------------------------------------------
// Workgroup sizes.
// ---------------------------------------------------------------------------

test('count and scatter declare the host workgroup size', () => {
  // They must agree with each other AND with the host: the scatter reads the
  // offset that count's workgroup produced, so a different partition sends it to
  // the wrong partial and packs particles on top of each other.
  const expected = new RegExp(`@workgroup_size\\(${STAMP_WORKGROUP_SIZE}\\)`);
  assert.match(COUNT, expected);
  assert.match(SCATTER, expected);
});

test('paste and clear declare their host workgroup sizes', () => {
  assert.match(PASTE, new RegExp(`@workgroup_size\\(${STAMP_PASTE_WORKGROUP_SIZE}\\)`));
  assert.match(CLEAR, new RegExp(`@workgroup_size\\(${STAMP_CLEAR_WORKGROUP_SIZE}\\)`));
});

// ---------------------------------------------------------------------------
// THE BOX PREDICATE.
//
// Count and scatter must apply the SAME test. If they disagreed, the scan would
// produce offsets for one set of particles while the scatter wrote a different
// set. That is why the test lives in a shared include rather than being written
// out twice -- and this asserts that it stayed that way.
// ---------------------------------------------------------------------------

test('count and scatter both reach the predicate through the shared include', () => {
  for (const [name, source] of [['count', COUNT], ['scatter', SCATTER]] as const) {
    assert.ok(
      source.includes('fn stamp_box_contains'),
      `${name} must pull in stampBox.wgsl rather than restating the test`,
    );
  }
});

test('the box test is half-open, matching boxContains on the host', () => {
  // `>= min` and `< max`. Two boxes sharing an edge must partition the points on
  // it, or a cut-and-paste of two halves duplicates the seam. `stampBox.test.ts`
  // asserts the host half of this pair.
  const predicate = /p\.x >= lo\.x && p\.x < hi\.x && p\.y >= lo\.y && p\.y < hi\.y/;
  assert.match(COUNT, predicate);
});

test('every pass tests liveness before reading a position', () => {
  // A dead slot's position is whatever was left there and could easily fall
  // inside the box. Without this a stamp captures ghosts, and a region clear
  // double-frees them.
  for (const [name, source] of [
    ['count', COUNT],
    ['scatter', SCATTER],
    ['clear', CLEAR],
    ['paste', PASTE],
  ] as const) {
    assert.ok(source.includes('e_is_dead'), `${name} must test e_is_dead`);
  }
});

// ---------------------------------------------------------------------------
// THE FREE-LIST PROTOCOL.
//
// The head must move monotonically within any one pass. Copy takes nothing and
// gives nothing; paste only takes; clear only gives. A pass doing both would
// reintroduce exactly the interleaving the protocol forbids.
// ---------------------------------------------------------------------------

test('the copy passes do not touch the free list at all', () => {
  // A copy must not disturb the scene it is capturing -- which is what makes it
  // safe to run on the frame the user presses go.
  for (const [name, source] of [['count', COUNT], ['scatter', SCATTER]] as const) {
    assert.ok(
      !source.includes('free_list_take') && !source.includes('free_list_give'),
      `${name} must not touch the pool`,
    );
  }
});

/**
 * A shader's code with its comments removed.
 *
 * These files carry long explanatory headers, and several of them discuss the
 * very constructs the assertions below search for -- `return`, `free_list_give`
 * -- in prose explaining why the code does NOT do that. Matching against raw
 * text therefore tests the documentation instead of the code, and fails on a
 * shader that is correct.
 */
function stripComments(source: string): string {
  return source.replace(/\/\/.*$/gm, '');
}

/** Call sites of a free-list operation in a shader's own body. */
function callsFreeListOp(source: string, op: 'take' | 'give'): boolean {
  // `free_list_take()` / `free_list_give(...)` as a CALL, not the definition --
  // which is why this runs against raw source. See `raw`.
  //
  // Comments stripped for the reason `stripComments` gives: these headers
  // discuss both operations by name while explaining which one the pass is
  // allowed to use, so prose would satisfy the search either way.
  return new RegExp(`free_list_${op}\\s*\\(`).test(stripComments(source));
}

test('the copy passes bind the entity buffer read-only', () => {
  // Structural proof that a copy cannot mutate the world.
  assert.match(SCATTER, /var<storage, read>\s+src\s+:\s+array<Entity>/);
  assert.match(COUNT, /var<storage, read>\s+entities\s+:\s+array<Entity>/);
});

test('paste only takes from the pool, never gives', () => {
  assert.ok(callsFreeListOp(PASTE_SRC, 'take'), 'paste must reserve slots');
  assert.ok(
    !callsFreeListOp(PASTE_SRC, 'give'),
    'a pass that both takes and gives breaks the monotonic-head invariant',
  );
});

test('clear only gives to the pool, never takes', () => {
  assert.ok(callsFreeListOp(CLEAR_SRC, 'give'), 'a region clear must return slots');
  assert.ok(
    !callsFreeListOp(CLEAR_SRC, 'take'),
    'a pass that both gives and takes breaks the monotonic-head invariant',
  );
});

test('clear pushes to the pool before zeroing the entity', () => {
  // Matching `kill.wgsl` and the BC_KILL branch in entityUpdate: a reader racing
  // this must see either a live particle or a dead one, never a live index
  // sitting on the free list.
  const push = CLEAR_SRC.indexOf('free_list_give(index)');
  const zero = CLEAR_SRC.indexOf('entities[index] = make_entity_dead()');
  assert.ok(push > 0 && zero > 0, 'both writes must be present');
  assert.ok(push < zero, 'the push must precede the zeroing');
});

test('paste tests the reservation against NO_SLOT', () => {
  // An unguarded reservation writes past the entity buffer when the pool is
  // empty -- which in WGSL is a dropped access, not a crash, presenting as one
  // particle at index 0 behaving strangely.
  assert.ok(PASTE.includes('NO_SLOT'), 'paste must test for an empty pool');
});

// ---------------------------------------------------------------------------
// THE IDENTITY EARLY-OUT.
//
// The whole-scene restore is the common case and must be bit-exact: the generic
// rescale round-trips through a divide and a multiply, which is not the identity
// in f32. The host hit this in `remapPoint` and a unit test caught it; this is
// the same guard on the GPU side.
// ---------------------------------------------------------------------------

test('the remap short-circuits when the boxes match exactly', () => {
  assert.ok(
    PASTE.includes('fn stamp_remap_point'),
    'paste must reach the remap through the shared include',
  );
  assert.match(
    PASTE,
    /if \(all\(src_lo == dst_lo\) && all\(src_hi == dst_hi\)\) \{\s*return p;/,
    'an identical box pair must return the point untouched',
  );
});

test('the scatter stores positions verbatim, leaving the remap to paste', () => {
  // Remapping on copy would bake the source box into the stored bytes and make
  // a stamp re-pastable only into the box it came from.
  //
  // RAW SOURCE: `stampBox.wgsl` DEFINES `stamp_remap_point` and the scatter
  // includes it, so the expanded text contains the name either way. The question
  // is whether the scatter CALLS it.
  assert.ok(
    !/stamp_remap_point\s*\(/.test(SCATTER_SRC),
    'a copy must store world coordinates as they were',
  );
  assert.match(SCATTER_SRC, /dst\[destination\] = src\[index\]/);
});

// ---------------------------------------------------------------------------
// Bounds.
// ---------------------------------------------------------------------------

test('the scatter bounds its write against the destination capacity', () => {
  // The block is sized from a count the host read back, which is a frame or more
  // old -- the world may have gained particles since. Without the bound the
  // write is silently dropped and the stamp is short by however many the buffer
  // was over.
  assert.ok(
    SCATTER.includes('dst_capacity()'),
    'the scatter must clamp against the allocated block',
  );
});

test('every pass bounds-checks its invocation index', () => {
  // Dispatches round up, so the last workgroup runs partly out of range. Each
  // pass must guard -- either by returning early (`index >= count`) or by
  // contributing a zero (`index < count`), which is what the count pass does
  // because it may not return before its barriers.
  for (const [name, source] of [
    ['count', COUNT_SRC],
    ['scatter', SCATTER_SRC],
    ['paste', PASTE_SRC],
    ['clear', CLEAR_SRC],
  ] as const) {
    assert.ok(
      /\b(index|i)\s*(>=|<)\s*\w+\(\)/.test(source),
      `${name} must bound its invocation -- dispatches round up`,
    );
  }
});

test('the count reduction never returns before a barrier', () => {
  // A `return` before a `workgroupBarrier` is undefined behaviour in WGSL, and
  // the last workgroup of a ragged buffer takes that path every time -- which is
  // why the out-of-range case contributes a zero rather than bailing out.
  //
  // SCOPED TO THIS SHADER'S OWN `main`. The expanded text carries every included
  // helper, and several of those return early for reasons of their own; scanning
  // the whole translation unit would flag them and say nothing about this pass.
  //
  // COMMENTS ARE STRIPPED FIRST. The body explains at length why it does NOT
  // return early, so the word appears in prose well before the first barrier --
  // and a test that reads comments is testing the documentation rather than the
  // code. It failed on exactly that.
  const body = stripComments(COUNT_SRC.slice(COUNT_SRC.indexOf('fn main')));
  const firstBarrier = body.indexOf('workgroupBarrier');
  const firstReturn = body.search(/\breturn\b/);
  assert.ok(firstBarrier > 0, 'the reduction must barrier');
  assert.ok(
    firstReturn === -1 || firstReturn > firstBarrier,
    'no invocation may return before the reduction barriers',
  );
});
