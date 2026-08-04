/**
 * Checks `common.wgsl`'s struct declarations against `layout.fixture.json`.
 *
 * ## Why this test exists
 *
 * The GPU struct layout is hand-authored in two places. `layout.fixture.json`
 * is what the host packs against (`pack.ts`, guarded by `assertLaneMap`);
 * `common.wgsl` is what the GPU actually reads. Nothing else compares the two,
 * and nothing generates either from the other.
 *
 * A divergence between them does not crash and does not error. The host packs
 * 416 bytes to one plan and the shader reads them to another, and the
 * simulation is just subtly wrong. This is the shader-side counterpart of
 * `assertLaneMap`: that one guards host packing against the descriptor, this
 * one guards the shader against it, and together they close the loop.
 *
 * ## What the scanner is and is not
 *
 * It is NOT a general WGSL parser. It reads one hand-authored file written in a
 * known style, and it throws on anything it does not recognise rather than
 * skipping it silently -- a scanner that quietly ignores a member it cannot
 * parse would pass while the layout drifted, which is the one outcome that
 * would make this test worse than useless.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveIncludes } from '../../tools/wgslInclude.ts';
import { layoutOf, memberOf } from '../particleSystem/layout.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const COMMON_WGSL = path.join(here, 'common.wgsl');

/** Every struct the descriptor knows about, and so every one that must match. */
const LAYOUT_STRUCTS = [
  'FourierCenter',
  'Rule',
  'ConfigData',
  'WorldData',
  'Entity',
] as const;

interface ScannedMember {
  readonly name: string;
  /** The type as written, comments and whitespace stripped. */
  readonly type: string;
}

/**
 * Split a struct body on the commas that separate members.
 *
 * A plain `body.split(',')` is wrong: `array<FourierCenter, 10>` contains a
 * comma of its own, and splitting on it tears `Rule.centers` in half. Tracking
 * `<` / `>` depth is enough for WGSL type syntax, which is where the only
 * nested commas in this file occur.
 */
function splitMembers(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '<') depth++;
    else if (ch === '>') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

/**
 * Pull `struct Name { ... }` blocks out of WGSL source.
 *
 * Read through `resolveIncludes` rather than `readFileSync` so the test sees
 * exactly the text the Vite plugin hands the GPU. `common.wgsl` includes
 * nothing today; if Step 4 ever splits it, this keeps working.
 */
function scanStructs(source: string): Map<string, ScannedMember[]> {
  // Strip line comments first: every lane annotation in common.wgsl is a `//`
  // comment sitting on the same line as a member, and several contain braces
  // and commas that would otherwise confuse the member split.
  const code = source.replace(/\/\/[^\n]*/g, '');

  const structs = new Map<string, ScannedMember[]>();
  const structRe = /\bstruct\s+(\w+)\s*\{([^}]*)\}/g;

  let match: RegExpExecArray | null;
  while ((match = structRe.exec(code)) !== null) {
    const name = match[1]!;
    const body = match[2]!;

    const members: ScannedMember[] = [];
    for (const raw of splitMembers(body)) {
      const entry = raw.trim();
      if (entry === '') continue; // Trailing comma after the last member.

      // `name: type` and nothing else. Anything that does not match is a
      // construct this scanner was not written for -- fail rather than skip.
      const m = /^(\w+)\s*:\s*(.+)$/s.exec(entry);
      if (m === null) {
        throw new Error(
          `common.wgsl: could not parse member "${entry}" of struct ${name}. ` +
            `The scanner in this test understands "name: type" only -- if the ` +
            `file grew a construct it does not know, teach it rather than ` +
            `loosening it, or the layout check silently stops covering that member.`,
        );
      }
      members.push({ name: m[1]!, type: m[2]!.replace(/\s+/g, ' ').trim() });
    }
    structs.set(name, members);
  }
  return structs;
}

const scanned = scanStructs(resolveIncludes(COMMON_WGSL, { sharedDir: here }));

/**
 * Descriptor type -> the WGSL spellings that satisfy it.
 *
 * `vec4` is the only scalar-bearing type the vec4-only rule permits; both
 * spellings are legal WGSL and the file may use either.
 */
const VEC4_SPELLINGS = new Set(['vec4f', 'vec4<f32>']);

test('common.wgsl declares every struct in the descriptor', () => {
  for (const name of LAYOUT_STRUCTS) {
    assert.ok(
      scanned.has(name),
      `layout.fixture.json describes struct ${name}, but common.wgsl does ` +
        `not declare it. The GPU would not agree with the host packing.`,
    );
  }
});

test('struct members match the descriptor in name and order', () => {
  for (const name of LAYOUT_STRUCTS) {
    const expected = layoutOf(name).members.map((m) => m.name);
    const actual = scanned.get(name)!.map((m) => m.name);
    assert.deepEqual(
      actual,
      expected,
      `common.wgsl's ${name} members are [${actual.join(', ')}] but ` +
        `layout.fixture.json says [${expected.join(', ')}]. Member order IS ` +
        `the byte order of the record: a mismatch means the shader reads every ` +
        `field after the divergence from the wrong offset, silently.`,
    );
  }
});

test('struct member types correspond to the descriptor', () => {
  for (const name of LAYOUT_STRUCTS) {
    const members = scanned.get(name)!;
    for (const member of members) {
      const described = memberOf(name, member.name);
      if (described.type === 'vec4') {
        // Array members carry their element type in the descriptor, so an
        // array-of-vec4 would land here too; none exists today.
        const bare = member.type.replace(/^array<(.+),\s*\d+>$/s, '$1').trim();
        assert.ok(
          VEC4_SPELLINGS.has(bare),
          `${name}.${member.name} is "${member.type}" in common.wgsl but the ` +
            `descriptor calls it a vec4.`,
        );
      } else {
        // A struct-typed member: match by name, allowing the array wrapper.
        assert.ok(
          member.type.includes(described.type),
          `${name}.${member.name} is "${member.type}" in common.wgsl but the ` +
            `descriptor calls it ${described.type}.`,
        );
      }
    }
  }
});

// The claim docs/WEB_PORT_PLAN.md step 3 rests on: std430's array-of-struct
// stride already equals WGSL's, so there is no stride divergence to work
// around. That only holds while the array is exactly this shape.
test('Rule.centers is array<FourierCenter, 10>', () => {
  const centers = scanned.get('Rule')!.find((m) => m.name === 'centers');
  assert.ok(centers !== undefined, 'Rule has no `centers` member in common.wgsl');

  const m = /^array<\s*(\w+)\s*,\s*(\d+)\s*>$/.exec(centers.type);
  assert.ok(m !== null, `Rule.centers is "${centers.type}", expected an array<...>`);

  const described = memberOf('Rule', 'centers');
  assert.equal(m[1], 'FourierCenter');
  assert.equal(
    Number(m[2]),
    described.arrayLength,
    `common.wgsl declares ${m[2]} centers, the descriptor says ` +
      `${described.arrayLength}.`,
  );
});

// Rule 1 of common.wgsl's header, restated on the shader side. layout.py
// enforces it for the GLSL; nothing enforced it for the WGSL until this test.
test('every struct member is a vec4 or another layout struct', () => {
  for (const name of LAYOUT_STRUCTS) {
    for (const member of scanned.get(name)!) {
      const bare = member.type.replace(/^array<(.+),\s*\d+>$/s, '$1').trim();
      const ok = VEC4_SPELLINGS.has(bare) || LAYOUT_STRUCTS.includes(bare as never);
      assert.ok(
        ok,
        `${name}.${member.name} is "${member.type}". The vec4-only rule permits ` +
          `a vec4, a fixed-size array of vec4, or another struct that obeys the ` +
          `rule -- std430 and WGSL do not agree on layout for anything else.`,
      );
    }
  }
});

// BounceResult is not a layout struct (it never touches a buffer), so it is
// deliberately outside LAYOUT_STRUCTS and exempt from the vec4-only rule. This
// asserts it is still there, since world_bounce's signature is what Step 4
// destructures at its one call site.
test('BounceResult carries world_bounce output', () => {
  const result = scanned.get('BounceResult');
  assert.ok(result !== undefined, 'common.wgsl no longer declares BounceResult');
  assert.deepEqual(result.map((m) => m.name), ['pos', 'vel']);
});
