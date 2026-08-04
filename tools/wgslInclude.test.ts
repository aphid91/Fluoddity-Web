/**
 * Tests for the WGSL `#include` resolver.
 *
 * Each case maps to a documented behaviour of `shared/gl_utils.py:22-70`. Note
 * that only case 1 reflects what the real shader tree does today: all 9
 * `#include`s in the Python codebase are `#include "common.glsl"`, one level
 * deep, every one resolving via the shared-directory fallback. The recursion,
 * diamond guard and cycle termination are headroom for `common.wgsl`'s growth
 * through Steps 3-4, and are tested here so that headroom is known to work
 * rather than assumed.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveIncludes } from './wgslInclude.ts';

let root: string;
let sharedDir: string;
let moduleDir: string;

/** Write a file under the temp tree, creating parent directories as needed. */
function w(relPath: string, contents: string): string {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents, 'utf8');
  return full;
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wgsl-include-'));
  sharedDir = path.join(root, 'shared', 'shaders');
  moduleDir = path.join(root, 'module', 'shaders');
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.mkdirSync(moduleDir, { recursive: true });
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// 1. One-level include via the shared dir -- the only case the real tree uses.
test('resolves a one-level include through the shared directory', () => {
  w('shared/shaders/common.wgsl', 'fn shared_fn() -> f32 { return 1.0; }');
  const entry = w('module/shaders/entity.wgsl', '#include "common.wgsl"\nfn main() {}');

  const out = resolveIncludes(entry, { sharedDir });

  assert.match(out, /fn shared_fn\(\) -> f32/);
  assert.match(out, /fn main\(\) \{\}/);
  assert.match(out, /\/\/ ==== begin include: common\.wgsl ====/);
  assert.match(out, /\/\/ ==== end include: common\.wgsl ====/);
});

// 2. Diamond: A includes B and C, both include D. D must appear exactly once.
test('a diamond include emits the shared leaf exactly once', () => {
  w('shared/shaders/d.wgsl', 'const D_MARKER: i32 = 4;');
  w('shared/shaders/b.wgsl', '#include "d.wgsl"\nconst B: i32 = 2;');
  w('shared/shaders/c.wgsl', '#include "d.wgsl"\nconst C: i32 = 3;');
  const entry = w('module/shaders/diamond.wgsl', '#include "b.wgsl"\n#include "c.wgsl"');

  const out = resolveIncludes(entry, { sharedDir });

  const occurrences = out.split('const D_MARKER').length - 1;
  assert.equal(occurrences, 1, 'D was included more than once');
  assert.match(out, /const B: i32 = 2;/);
  assert.match(out, /const C: i32 = 3;/);
});

// 3. Cycle terminates. The guard is marked before recursing, which is what
//    stops A -> B -> A from blowing the stack.
test('a cycle terminates instead of recursing forever', () => {
  w('shared/shaders/cycle_b.wgsl', '#include "cycle_a.wgsl"\nconst B_MARK: i32 = 2;');
  w('shared/shaders/cycle_a.wgsl', '#include "cycle_b.wgsl"\nconst A_MARK: i32 = 1;');
  const entry = w('module/shaders/cycle_entry.wgsl', '#include "cycle_a.wgsl"');

  const out = resolveIncludes(entry, { sharedDir });

  assert.match(out, /const A_MARK: i32 = 1;/);
  assert.match(out, /const B_MARK: i32 = 2;/);
});

// 4. Sibling-first: a file beside the includer wins over the shared one.
test('an include beside the including file wins over the shared directory', () => {
  w('shared/shaders/pick.wgsl', 'const SOURCE: i32 = 0;  // shared');
  w('module/shaders/pick.wgsl', 'const SOURCE: i32 = 1;  // sibling');
  const entry = w('module/shaders/uses_pick.wgsl', '#include "pick.wgsl"');

  const out = resolveIncludes(entry, { sharedDir });

  assert.match(out, /const SOURCE: i32 = 1;/);
  assert.doesNotMatch(out, /const SOURCE: i32 = 0;/);
});

// 5. A missing include throws, naming the file and line. At build time this is
//    deliberately fatal -- see the divergence note in wgslInclude.ts.
test('a missing include throws with file and line number', () => {
  const entry = w('module/shaders/missing.wgsl', 'fn a() {}\n#include "nope.wgsl"');

  assert.throws(
    () => resolveIncludes(entry, { sharedDir }),
    (err: Error) => {
      assert.match(err.message, /:2:/, 'message should carry the line number');
      assert.match(err.message, /#include "nope\.wgsl" not found/);
      assert.match(err.message, /looked in/);
      return true;
    },
  );
});

// 6. The regex is anchored: leading whitespace is fine, trailing content is not.
test('leading whitespace resolves; trailing content does not', () => {
  w('shared/shaders/ws.wgsl', 'const WS_MARK: i32 = 7;');

  const indented = w('module/shaders/indented.wgsl', '  \t#include "ws.wgsl"  ');
  assert.match(resolveIncludes(indented, { sharedDir }), /const WS_MARK: i32 = 7;/);

  // Trailing content means the line is not an include directive at all, so it
  // is passed through verbatim -- and notably NOT treated as a missing include.
  const trailing = w('module/shaders/trailing.wgsl', '#include "ws.wgsl" // comment');
  const out = resolveIncludes(trailing, { sharedDir });
  assert.doesNotMatch(out, /const WS_MARK/);
  assert.match(out, /#include "ws\.wgsl" \/\/ comment/);
});

// The dependency callback is what drives Vite's watch registration; if it
// stops firing, editing common.wgsl silently stops refreshing its dependents.
test('onDependency fires once per resolved include with an absolute path', () => {
  w('shared/shaders/dep_leaf.wgsl', 'const LEAF: i32 = 1;');
  w('shared/shaders/dep_mid.wgsl', '#include "dep_leaf.wgsl"\nconst MID: i32 = 2;');
  const entry = w('module/shaders/dep_entry.wgsl', '#include "dep_mid.wgsl"');

  const seen: string[] = [];
  resolveIncludes(entry, { sharedDir, onDependency: (p) => seen.push(p) });

  assert.equal(seen.length, 2);
  assert.ok(seen.every((p) => path.isAbsolute(p)), 'paths should be absolute');
  assert.ok(seen.some((p) => p.endsWith('dep_mid.wgsl')));
  assert.ok(seen.some((p) => p.endsWith('dep_leaf.wgsl')));
});
