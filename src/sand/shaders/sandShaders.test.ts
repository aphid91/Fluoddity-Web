/**
 * Structural checks on the sand modality's brush shaders.
 *
 * Same contract as `particleSystem/shaders/shaders.test.ts`: nothing here
 * compiles WGSL (that needs a real device), so what is covered is the class of
 * mistake a compiler would not catch. For these two passes that is mostly the
 * free-list protocol, where every failure is silent and none is visible in a
 * screenshot:
 *
 *   - a workgroup size drifting from the host's dispatch arithmetic, which
 *     under-dispatches and quietly spawns fewer particles than asked for;
 *   - the creation pass gaining a `free_list_give`, or the eraser a
 *     `free_list_take`, which breaks the monotonic-head invariant that makes
 *     the atomic reservation safe at all;
 *   - the eraser losing its dead test, which double-frees an index and hands
 *     the same particle to two future brushes.
 *
 * Assertions run against the EXPANDED source, so an include that stopped
 * resolving fails here too.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveIncludes } from '../../../tools/wgslInclude.ts';
// From the LEAF, not from `sandPasses.ts`: that module imports `.wgsl`, which
// only resolves through the Vite plugin and cannot be imported under node.
import {
  KILL_WORKGROUP_SIZE,
  SPAWN_WORKGROUP_SIZE,
  workgroupsFor,
} from '../sandDispatch.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = path.join(here, '..', '..', 'shaders');

function expand(name: string): string {
  return resolveIncludes(path.join(here, name), { sharedDir: SHARED_DIR });
}

const SPAWN = expand('spawn.wgsl');
const KILL = expand('kill.wgsl');

// ---------------------------------------------------------------------------
// Workgroup sizes
// ---------------------------------------------------------------------------

test('spawn.wgsl declares the workgroup size the host dispatches with', () => {
  assert.match(SPAWN, new RegExp(`@workgroup_size\\(${SPAWN_WORKGROUP_SIZE}\\)`));
});

test('kill.wgsl declares the workgroup size the host dispatches with', () => {
  assert.match(KILL, new RegExp(`@workgroup_size\\(${KILL_WORKGROUP_SIZE}\\)`));
});

test('workgroupsFor rounds up, so the tail is covered', () => {
  assert.equal(workgroupsFor(1, 64), 1);
  assert.equal(workgroupsFor(64, 64), 1);
  assert.equal(workgroupsFor(65, 64), 2);
  // Zero work is zero groups -- the spawn path returns before dispatching, but
  // a zero-group dispatch is legal and must not become one group.
  assert.equal(workgroupsFor(0, 64), 0);
});

// ---------------------------------------------------------------------------
// The monotonic-head invariant
//
// THIS IS THE LOAD-BEARING ONE. Creation and deletion are separate passes so
// that within each the free-list head moves in ONE direction only. An atomic
// alone does not make the reservation safe -- a thread that loses an atomic
// still executes its writes -- so if either pass gained the other's operation,
// two particles could be handed the same slot.
// ---------------------------------------------------------------------------

test('the creation pass only TAKES slots', () => {
  assert.ok(SPAWN.includes('free_list_take'), 'spawn reserves an index');
  // `free_list_give` appears in the included freeList.wgsl definition, so the
  // test is that spawn's own body never CALLS it.
  const body = SPAWN.slice(SPAWN.indexOf('fn main'));
  assert.ok(!body.includes('free_list_give'), 'spawn must not return slots');
});

test('the eraser only GIVES slots back', () => {
  assert.ok(KILL.includes('free_list_give'), 'kill returns the index');
  const body = KILL.slice(KILL.indexOf('fn main'));
  assert.ok(!body.includes('free_list_take'), 'kill must not reserve slots');
});

// ---------------------------------------------------------------------------
// Double-free and resurrection
// ---------------------------------------------------------------------------

test('the eraser skips already-dead particles', () => {
  // Without this the eraser pushes the same index every frame it is dragged
  // over the same ground -- a double free, and the same slot handed to two
  // future brushes.
  assert.ok(KILL.includes('e_is_dead'), 'kill tests for dead before pushing');
});

test('the creation pass checks its reservation succeeded', () => {
  // An empty pool is NORMAL (a full world with the brush still down), so the
  // reservation can fail and the result must be tested. Writing to NO_SLOT
  // would index past the entity buffer.
  assert.ok(SPAWN.includes('NO_SLOT'), 'spawn guards an empty pool');
});

test('the creation pass bounds its work by the CPU-supplied count', () => {
  // How many is the CPU's decision; only WHICH needs an atomic. Losing this
  // check would spawn a whole workgroup's worth regardless of the brush.
  assert.ok(SPAWN.includes('spawn_count()'), 'spawn honours the count uniform');
});

// ---------------------------------------------------------------------------
// Declaration order
//
// The free-list operations NAME the `freelist` binding rather than taking a
// pointer to it, because a storage-space pointer parameter needs the
// `unrestricted_pointer_parameters` language feature that is not baseline
// WebGPU. That forces an order -- struct, then binding, then operations -- and
// getting it wrong is a compile failure on the GPU, which these node tests
// cannot see. Pinning it here is the only cheap guard available.
// ---------------------------------------------------------------------------

const ORDERED = [
  ['spawn.wgsl', SPAWN],
  ['kill.wgsl', KILL],
] as const;

for (const [name, source] of ORDERED) {
  test(`${name} declares FreeList, then the binding, then the operations`, () => {
    const struct = source.indexOf('struct FreeList');
    const binding = source.indexOf('freelist : FreeList');
    const ops = source.indexOf('fn free_list_take');

    assert.ok(struct >= 0, 'the struct is included');
    assert.ok(binding >= 0, 'a binding named `freelist` is declared');
    assert.ok(ops >= 0, 'the operations are included');
    assert.ok(struct < binding, 'the struct precedes the binding that uses it');
    assert.ok(binding < ops, 'the binding precedes the functions that name it');
  });
}

test('no free-list function takes a storage pointer', () => {
  // `ptr<storage, ...>` as a parameter needs a non-baseline language feature.
  // It would compile on some implementations and fail on others.
  //
  // Matched on `fn ... ptr<storage` rather than on the bare type, because
  // freeList.wgsl's header QUOTES the rejected signature while explaining why it
  // is rejected -- and a comment is exactly where that explanation belongs.
  for (const [name, source] of ORDERED) {
    const declarations = source.match(/^\s*fn\s+\w+\s*\([^)]*\)/gm) ?? [];
    for (const decl of declarations) {
      assert.ok(!decl.includes('ptr<storage'), `${name}: ${decl.trim()}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Scatter
// ---------------------------------------------------------------------------

test('spawn samples the disc uniformly by AREA', () => {
  // sqrt() on the radius draw. Without it, area growing as r^2 piles two thirds
  // of the particles into the middle third of the brush -- which reads as a
  // brush with a hot centre rather than as a bug.
  assert.match(SPAWN, /sqrt\(hash\(/);
});

test('both brushes paint along a SEGMENT, not a point', () => {
  // A point brush visibly breaks into dots on a fast drag, because nothing
  // connects one frame's cursor to the next.
  assert.ok(SPAWN.includes('u.stroke.xy') && SPAWN.includes('u.stroke.zw'));
  assert.ok(KILL.includes('distance_to_segment'));
});

test('the eraser survives a zero-length stroke', () => {
  // A click that has not moved yet. dot(ab,ab) is 0, and 0/0 is NaN -- a NaN
  // distance compares false against every radius, so the eraser would silently
  // do nothing on a stationary click.
  assert.ok(KILL.includes('denom <= 0.0'));
});
