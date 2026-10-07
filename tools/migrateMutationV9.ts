/**
 * Rewrite the shipped presets in `configs/` from save format 8 to 9.
 *
 * v9 changed frequency mutation (one random factor per vec4 became four, at
 * twice the range), and `persistence.ts`'s `migrateMutationV8` already migrates
 * any v8 document on the way in. This bakes that result into the files the repo
 * ships, so the presets are v9 at rest and their diffs say what changed.
 *
 * ## Patched as TEXT, not re-serialized
 *
 * The presets were written by Python, which prints `1.0` where `JSON.stringify`
 * prints `1`. Re-serializing would rewrite nearly every line of 122 files to
 * change a handful. So this edits only what the migration changes: the
 * `version`, and for a BAKED config its `rule` array and `mutation_scale`.
 *
 * ## Verified, per file, before anything is written
 *
 * `fromDocument(patched)` must equal `fromDocument(original)` exactly -- the v9
 * file read as-is against the v8 file read through the migration. A patch that
 * landed on the wrong config, or a number that did not round-trip, fails here
 * rather than shipping.
 *
 * `configs/custom/` is skipped: it is not shipped, and `fromDocument` migrates
 * those files whenever they are read anyway.
 *
 * Usage:
 *   node tools/migrateMutationV9.ts            # rewrite, then report
 *   node tools/migrateMutationV9.ts --check    # report only, write nothing
 *
 * Then `npm run sync:configs` to copy the result into `public/configs/`.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MIGRATED_VERSION, fromDocument, migrateMutationV8 } from '../src/config/persistence.ts';
import type { SimulationConfig } from '../src/particleSystem/config.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = path.join(ROOT, 'configs');
const check = process.argv.includes('--check');

function presets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return e.name === 'custom' ? [] : presets(path.join(dir, e.name));
    return e.name.endsWith('.json') ? [path.join(dir, e.name)] : [];
  });
}

/** Replace the `n`th match of `re` (global) with `replace(match)`. */
function replaceNth(text: string, re: RegExp, n: number, replace: (m: RegExpExecArray) => string): string {
  let seen = 0;
  for (const m of text.matchAll(re)) {
    if (seen++ === n) return text.slice(0, m.index) + replace(m) + text.slice(m.index + m[0].length);
  }
  throw new Error(`pattern ${re} has no occurrence #${n}`);
}

const baked: string[] = [];
const multiCohort: string[] = [];
let rewritten = 0;

for (const file of presets(SOURCE_DIR)) {
  const name = path.relative(SOURCE_DIR, file).replace(/\\/g, '/');
  const original = readFileSync(file, 'utf8');
  const doc = JSON.parse(original) as { version?: unknown; configs?: unknown[] };
  if (doc.version !== MIGRATED_VERSION) continue;

  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const expected = fromDocument(doc, name);
  const raw = fromDocument({ ...doc, version: 9 }, name).configs;

  let text = original.replace(/"version": 8\b/, '"version": 9');
  raw.forEach((before: SimulationConfig, i: number) => {
    const after = migrateMutationV8(before);
    const label = raw.length > 1 ? `${name} #${i}` : name;
    if (after === before) {
      if (before.mutationScale !== 0 && before.cohorts > 1 && before.rule.some((v) => v !== 0)) {
        multiCohort.push(`${label}  (cohorts ${before.cohorts}, mutation ${before.mutationScale})`);
      }
      return;
    }
    baked.push(label);
    text = replaceNth(text, /"rule": \[([^\]]*)\]/g, i, (m) => {
      const indent = /\n([ \t]*)\S/.exec(m[1] ?? '')?.[1] ?? '';
      const closing = /\n([ \t]*)$/.exec(m[1] ?? '')?.[1] ?? '';
      const body = after.rule.map((v) => `${indent}${String(v)}`).join(`,${eol}`);
      return `"rule": [${eol}${body}${eol}${closing}]`;
    });
    text = replaceNth(text, /"mutation_scale": -?[\d.eE+-]+/g, i, () => '"mutation_scale": 0.0');
  });

  const patched = fromDocument(JSON.parse(text), name);
  if (!isDeepStrictEqual(patched, expected)) {
    throw new Error(`${name}: the patched file does not read back as its migration`);
  }
  if (!check) writeFileSync(file, text, 'utf8');
  rewritten++;
}

console.log(`${check ? 'Would rewrite' : 'Rewrote'} ${rewritten} preset(s) from v8 to v9.`);
console.log(`\nBaked (single cohort, mutation now 0) -- ${baked.length}:`);
for (const b of baked) console.log(`  ${b}`);
console.log(`\nMulti-cohort, NOT migratable -- worth a look -- ${multiCohort.length}:`);
for (const m of multiCohort) console.log(`  ${m}`);
