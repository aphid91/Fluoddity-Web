/**
 * GPU struct layouts, read from a checked-in descriptor.
 *
 * `layout.fixture.json` states the byte offset, size and float lane of every
 * member of every struct the host packs. `src/shaders/common.wgsl` declares the
 * same structs to the GPU. **They are two statements of one fact**, and the
 * assertions in this module are what keep them from disagreeing.
 *
 * The descriptor was originally produced by the Python desktop app's
 * `layout.py`, which regex-parsed the GLSL at import so the packing code could
 * never drift from the shader. That app is gone and the parser with it. There
 * is deliberately no replacement: shader hot-reload is gone too
 * (ARCHITECTURE.md invariant 5), so a runtime parser has nothing to do, and a
 * WGSL parser written to re-derive a file that changes about once a year would
 * be more code to get subtly wrong than the thing it checks.
 *
 * ## Why this module asserts rather than merely reads
 *
 * A struct layout mismatch does not crash. It silently reinterprets GPU memory
 * and the simulation just behaves subtly wrong. Failing loudly at module load
 * is the entire point of this file.
 *
 * The assertion that earns the design is `assertLaneMap`, called from
 * `config.ts`: it checks the hand-written lane constants against the descriptor's
 * offsets, so adding a `vec4` to `ConfigData` fails loudly instead of silently
 * shifting every lane by four floats.
 *
 * ## Changing a struct
 *
 * Edit `common.wgsl` AND `layout.fixture.json` in the same commit. The checks
 * here and in `common.wgsl.test.ts` will tell you if you missed one; nothing
 * will regenerate the other for you.
 */

import descriptor from './layout.fixture.json' with { type: 'json' };

/** One member of a GPU struct, as the descriptor describes it. */
export interface LayoutMember {
  readonly name: string;
  /** Byte offset from the start of the struct. Always 16-byte aligned. */
  readonly offset: number;
  readonly size: number;
  /** `'vec4'`, or the name of a struct declared earlier in `common.wgsl`. */
  readonly type: string;
  /** `offset / 4` -- the index into a Float32Array view of the record. */
  readonly floatIndex: number;
  readonly floatCount: number;
  /** Present only for array members; `Rule.centers` is the only one. */
  readonly arrayLength?: number;
  readonly stride?: number;
}

export interface LayoutStruct {
  readonly size: number;
  readonly float32Count: number;
  readonly members: readonly LayoutMember[];
}

const structs = descriptor.structs as unknown as Readonly<Record<string, LayoutStruct>>;

/** Look up a struct, failing loudly rather than returning undefined. */
export function layoutOf(name: string): LayoutStruct {
  const struct = structs[name];
  if (struct === undefined) {
    throw new Error(
      `layout.fixture.json has no struct "${name}". Either it was renamed in ` +
        `common.wgsl without the descriptor following, or the caller is asking ` +
        `for something that never existed.`,
    );
  }
  return struct;
}

/** Byte offset of a named member, failing loudly if it is gone. */
export function memberOf(structName: string, memberName: string): LayoutMember {
  const member = layoutOf(structName).members.find((m) => m.name === memberName);
  if (member === undefined) {
    throw new Error(
      `struct ${structName} has no member "${memberName}" in ` +
        `layout.fixture.json. Update it alongside common.wgsl.`,
    );
  }
  return member;
}

export const CONFIG_DATA = layoutOf('ConfigData');
export const WORLD_DATA = layoutOf('WorldData');
export const ENTITY = layoutOf('Entity');

/** Stride between consecutive `ConfigData` records in the ConfigBuffer. */
export const CONFIG_DATA_STRIDE = CONFIG_DATA.size;
export const WORLD_DATA_SIZE = WORLD_DATA.size;
/** Stride between consecutive `Entity` records in the EntityBuffer. */
export const ENTITY_STRIDE = ENTITY.size;

/** Float32 lanes per ConfigData record. 416 / 4 = 104. */
export const CONFIG_DATA_FLOATS = CONFIG_DATA.float32Count;

/**
 * Sizes the rest of `particleSystem/` hardcodes as strides, checked at module
 * load. The vec4-only rule guarantees 16-byte alignment, so a struct can grow
 * LEGALLY and still invalidate every one of those hardcoded strides -- which is
 * a silent wrong-memory bug, not a crash. This is the tripwire.
 */
const EXPECTED_SIZES: Readonly<Record<string, number>> = {
  FourierCenter: 32,
  Rule: 320,
  ConfigData: 416,
  WorldData: 32,
  Entity: 32,
};

for (const [name, expected] of Object.entries(EXPECTED_SIZES)) {
  const actual = layoutOf(name).size;
  if (actual !== expected) {
    throw new Error(
      `struct ${name} is ${actual} bytes in layout.fixture.json, expected ` +
        `${expected}. Every hardcoded stride in src/particleSystem assumes ` +
        `the expected value.`,
    );
  }
}

// `Rule.centers` is the one array member in the whole layout. std430's
// array-of-struct stride here equals WGSL's `array<FourierCenter,10>` stride
// (32 bytes either way), so there is no stride divergence to work around --
// which is what lets pack.ts treat `rule` as a flat 80-float memcpy. Assert it
// rather than trusting the comment.
{
  const centers = memberOf('Rule', 'centers');
  if (centers.stride !== 32 || centers.arrayLength !== 10) {
    throw new Error(
      `Rule.centers is ${centers.arrayLength} x ${centers.stride} bytes, ` +
        `expected 10 x 32. WGSL's array<FourierCenter,10> stride would no ` +
        `longer match std430's.`,
    );
  }
}

// The vec4-only rule: every struct a multiple of 16 bytes, every member
// 16-byte aligned. It is what makes std430 and WGSL agree on this layout in the
// first place, so it is checked here rather than left as a convention someone
// could quietly break by hand-editing the descriptor.
for (const [name, struct] of Object.entries(structs)) {
  if (struct.size % 16 !== 0) {
    throw new Error(
      `struct ${name} is ${struct.size} bytes, not a multiple of 16.`,
    );
  }
  for (const member of struct.members) {
    if (member.offset % 16 !== 0) {
      throw new Error(
        `struct ${name}: member "${member.name}" is at offset ${member.offset}, ` +
          `not 16-byte aligned.`,
      );
    }
  }
}

/**
 * Check hand-written float-lane constants against the descriptor's offsets.
 *
 * **This is the assertion the whole descriptor design exists for.** `config.ts`
 * states which float means what (`LANE`); the descriptor states where each vec4
 * begins. If someone adds a `vec4` to `ConfigData`, every lane after the
 * insertion point shifts by four floats -- and without this check the host would
 * keep writing `hazard_rate` where the shader now reads something else. No
 * error, no crash, just subtly wrong physics.
 *
 * Called from `config.ts` at module load rather than declared there, so the
 * failure surfaces at import time on the first thing that touches a config.
 */
export function assertLaneMap(
  structName: string,
  lanes: Readonly<Record<string, number>>,
): void {
  const struct = layoutOf(structName);
  for (const [memberName, lane] of Object.entries(lanes)) {
    const member = struct.members.find(
      (m) => m.name.toLowerCase() === memberName.toLowerCase(),
    );
    if (member === undefined) {
      throw new Error(
        `${structName} has no member matching lane constant "${memberName}". ` +
          `Either common.wgsl renamed it or the LANE table is stale.`,
      );
    }
    if (member.floatIndex !== lane) {
      throw new Error(
        `${structName}.${member.name} is at float lane ${member.floatIndex} in ` +
          `layout.fixture.json, but the LANE table says ${lane}. The struct ` +
          `changed and the lane constants did not follow -- packing would write ` +
          `every field after this point into the wrong place, silently.`,
      );
    }
  }
}
