#!/usr/bin/env node
/**
 * `npm test`: every `*.test.ts` under `src/` and `tools/`, minus the modules
 * SET ASIDE on the NCA experiments branch (built on the particle system, not
 * compiled here -- the same list `tsconfig.json` excludes).
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';

const SET_ASIDE = [
  'src/sand/',
  'src/stamp/',
  'src/worlds/',
  'src/archive/',
  'src/particleSystem/',
  'tools/migrateMutationV9',
  'tools/validateMigrated',
];

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.test.ts')) out.push(full.split(path.sep).join('/'));
  }
  return out;
}

const files = [...walk('src', []), ...walk('tools', [])]
  .filter((f) => !SET_ASIDE.some((p) => f.startsWith(p)))
  .sort();
const result = spawnSync(process.execPath, ['--test', ...files, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
