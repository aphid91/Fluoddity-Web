/**
 * Load every migrated v8 file through the app's OWN reader.
 *
 * `tools/migrate_v7.py` writes the format from the outside, in Python, so
 * nothing about it is checked by the TypeScript types. This closes that gap:
 * a migration that emits a file `fromDocument` rejects should fail HERE, at
 * migration time, rather than as a broken preset in the menu later.
 *
 * Usage: node tools/validateMigrated.ts <dir>
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fromDocument } from '../src/config/persistence.ts';
import { RULE_FLOAT_COUNT } from '../src/particleSystem/config.ts';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node tools/validateMigrated.ts <dir>');
  process.exit(2);
}

let ok = 0;
const failures: string[] = [];

for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
  try {
    const saved = fromDocument(JSON.parse(readFileSync(join(dir, name), 'utf8')), name);
    if (saved.configs.length !== 1) {
      throw new Error(`expected 1 config, got ${saved.configs.length}`);
    }
    const rule = saved.configs[0]!.rule;
    if (rule.length !== RULE_FLOAT_COUNT) {
      throw new Error(`rule has ${rule.length} floats, expected ${RULE_FLOAT_COUNT}`);
    }
    ok++;
  } catch (e) {
    failures.push(`${name}: ${(e as Error).message}`);
  }
}

console.log(`${ok} loaded through fromDocument(), ${failures.length} rejected`);
for (const f of failures) console.log(`  ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
