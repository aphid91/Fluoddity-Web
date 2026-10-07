/**
 * The ORIGINAL `mutate_rule`, on the host, for migrating v8 saves. Nothing else.
 *
 * ## Why this exists
 *
 * Up to save format 8, `rule.wgsl` mutated a frequency vec4 by ONE scalar
 * factor, so mutation could stretch a frequency but never turn it. Format 9
 * draws four. A v8 config with a single cohort and a nonzero mutation scale
 * therefore obeyed a rule the new shader can no longer produce from it, and
 * `persistence.ts` migrates it by baking: the rule its one cohort obeyed becomes
 * the stored rule, and the scale goes to 0. This computes that rule.
 *
 * ## Why a host mirror is safe HERE, when the GPU deriver exists to avoid one
 *
 * `rule.wgsl` warns that a 1-ULP difference fed to the chaotic hash produces a
 * completely different rule. Every step that feeds a hash below is exact in
 * f32 and therefore reproducible:
 *
 *   - the seed is single f32 ADDS of stored f32 values, which cannot be fused
 *     and round identically everywhere;
 *   - `pcg_hash` is u32 arithmetic (`Math.imul`, `>>> 0`);
 *   - `f32(h) / f32(0xffffffffu)` divides by 2^32 -- a power of two, so exact
 *     whatever the device's division accuracy.
 *
 * The only place a device may differ is the OUTPUT arithmetic, where a fused
 * multiply-add could move a final coefficient by 1 ULP. That cannot compound
 * here: the baked config has mutation scale 0, and mutating at amount 0 is the
 * exact identity, so nothing ever hashes the baked rule into a seed. The
 * generator (`pow`, FMA-heavy, the real trap) is never mirrored -- a zero-sentinel
 * rule is not mutated and needs no migration.
 *
 * Checked bit-for-bit against the real shader on a GPU over the whole shipped
 * corpus before the migration was committed. Do not reuse this for anything that
 * feeds its result back into a hash (the archive's selection chains do).
 *
 * A LEAF: no imports, testable under `node --test`.
 */

const f = Math.fround;

/** `rule.wgsl`'s rule length: 10 centers x (frequency vec4, amplitude vec4). */
const RULE_FLOATS = 80;

const scratch = new DataView(new ArrayBuffer(4));

/** `bitcast<u32>(x)` for an f32 value. */
function bits(x: number): number {
  scratch.setFloat32(0, x, true);
  return scratch.getUint32(0, true);
}

/** `hash.wgsl`'s `pcg_hash`, with WGSL's wrapping u32 multiplies. */
function pcgHash(seed: number): number {
  const state = (Math.imul(seed, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> (((state >>> 28) + 4) >>> 0)) ^ state) >>> 0, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

/** `hash(vec2f(x, y))`. `f32(0xffffffffu)` is 2^32, so the divide is exact. */
function hash(x: number, y: number): number {
  const h = pcgHash((bits(x) ^ pcgHash(bits(y))) >>> 0);
  return f(f(h) / 4294967296);
}

/** `hash4(vec2f(x, y))`, operand order kept exactly. */
function hash4(x: number, y: number): [number, number, number, number] {
  return [
    hash(x, y),
    hash(f(f(-x) + 5), f(f(-y) + 5)),
    hash(f(y - 100), f(x - 100)),
    hash(f(f(-y) + 25), f(f(-x) + 25)),
  ];
}

/**
 * The seed `derive_entity_rule` hands `mutate_rule`: the config's mutation seed
 * as the GPU holds it (f32) plus the cohort's floor.
 */
export function ruleSeedV1(mutationSeed: number, cohort: number): number {
  return f(f(mutationSeed) + Math.floor(cohort));
}

/**
 * The v8 `mutate_rule(rule, amount, cohort)`. `cohort` is the seed
 * `ruleSeedV1` returns, as on the GPU. Returns a new 80-float rule.
 */
export function mutateRuleV1(rule: readonly number[], amount: number, cohort: number): number[] {
  if (rule.length !== RULE_FLOATS) {
    throw new Error(`mutateRuleV1: rule must be ${RULE_FLOATS} floats, got ${rule.length}`);
  }
  const r = rule.map(f);
  const a = f(amount);
  // Center c: frequency at c*8 .. c*8+3, amplitude at c*8+4 .. c*8+7.
  const freq = (c: number, k: number) => r[c * 8 + k] ?? 0;
  const amp = (c: number, k: number) => r[c * 8 + 4 + k] ?? 0;

  // centers[4].frequency.xy + centers[7].amplitude.yx + centers[1].frequency.zw
  const sx = f(f(freq(4, 0) + amp(7, 1)) + freq(1, 2));
  const sy = f(f(freq(4, 1) + amp(7, 0)) + freq(1, 3));
  const seed = f(hash(sx, sy) + cohort);

  const halfA = f(a * 0.5);
  for (let i = 0; i < 10; i++) {
    // -0.5 + vec2f(-f32(i) + seed, f32(i))
    const h4 = hash4(f(-0.5 + f(-i + seed)), f(-0.5 + i));
    for (let k = 0; k < 4; k++) {
      const m = f(a * f(-1 + f(2 * (h4[k] ?? 0))));
      r[i * 8 + 4 + k] = f((r[i * 8 + 4 + k] ?? 0) + m);
    }
    // 1.0 + amount * 0.5 * (hash(vec2f(seed, f32(i))) - 0.5), left-associated
    const factor = f(1 + f(halfA * f(hash(seed, i) - 0.5)));
    for (let k = 0; k < 4; k++) r[i * 8 + k] = f((r[i * 8 + k] ?? 0) * factor);
  }
  return r;
}
