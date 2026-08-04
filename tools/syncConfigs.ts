/**
 * Copy the preset library into `public/` and write the index that finds it.
 *
 * ## Why this exists at all
 *
 * NO BROWSER CAN ENUMERATE A DIRECTORY. The app needs to show a menu of shipped
 * presets, so the enumeration has to happen before the browser gets there. This
 * script is that step: it walks `configs/`, copies what it finds under
 * `public/configs/`, and writes `manifest.json` listing the result.
 *
 * ## Why the files are copied rather than imported
 *
 * `public/` is the one directory Vite copies verbatim -- no bundling, no content
 * hash -- so the app FETCHES presets at runtime instead of importing them. That
 * is what stops presets from being code: adding one is a file drop plus a
 * `npm run sync:configs`, not a rebuild of a `.ts` module.
 *
 * They are also copied BYTE FOR BYTE, not pre-digested into some friendlier
 * shape. The reader in `src/config/persistence.ts` is the same code path a user
 * loading their own saved file takes, and shipping the raw bytes means that path
 * is exercised by every preset on every boot. A pre-digested blob would hide a
 * format mismatch until someone opened a real save.
 *
 * ## Categories
 *
 * Files sitting directly in `configs/` are "Core"; each subdirectory becomes its
 * own category named after the folder. Core sorts first, then the rest
 * alphabetically -- the flat concatenation of that order is the LEFT/RIGHT
 * preset cycle, so it is load-bearing rather than cosmetic.
 *
 * This ordering rule (and the `custom/` exclusion below) came from
 * `persistence.discover()` in the retired Python app, which is where the web
 * app inherited its preset library. It is reimplemented here rather than
 * referenced because it is twenty lines of `readdir` and there is no longer a
 * second implementation for it to drift from.
 *
 * Usage:
 *   npm run sync:configs          # write
 *   npm run sync:configs:check    # verify committed output is current, write nothing
 */

import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FORMAT_VERSION, fromDocument } from '../src/config/persistence.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const SOURCE_DIR = path.join(ROOT, 'configs');
const OUT_DIR = path.join(ROOT, 'public', 'configs');
const MANIFEST = path.join(OUT_DIR, 'manifest.json');

/**
 * Files directly in `configs/` land under this category name.
 * Matches the label the UI shows, and sorts first.
 */
const CORE_CATEGORY = 'Core';

/**
 * `configs/custom/` is local working state -- where the retired desktop app put
 * user saves, and where a developer's scratch presets accumulate. It is not
 * shipped. The browser's equivalent is IndexedDB, which is per-user by
 * construction and needs nothing from the build.
 *
 * Named here because "why is my saved config missing from the build" is a
 * reasonable question with a non-obvious answer.
 */
const EXCLUDED_DIRS = new Set(['custom']);

interface Entry {
  readonly name: string;
  /** Manifest-relative, always forward-slashed: the browser resolves it as a URL. */
  readonly path: string;
  readonly source: string;
}

interface Category {
  readonly name: string;
  readonly entries: readonly Entry[];
}

/**
 * Sort preset and category names CASE-INSENSITIVELY.
 *
 * This is a deliberate choice, not an inherited one. The Python `discover()`
 * sorted `Path` objects, whose comparison is case-insensitive on Windows and
 * case-SENSITIVE on Linux -- so the shipped menu order depended on who ran the
 * generator, with `hatmanv8` landing either before or after `Starcrossedv8`.
 * Since the order is the LEFT/RIGHT preset cycle, that is worth pinning down.
 * Case-insensitive is both the platform-independent answer and the one a user
 * reading an alphabetical menu expects.
 */
const byName = (a: string, b: string): number =>
  a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;

/** JSON files in one directory, sorted, as manifest entries under `category`. */
async function readCategory(dir: string, category: string): Promise<Entry[]> {
  const names = (await fs.readdir(dir))
    .filter((n) => n.endsWith('.json'))
    .sort(byName);
  return names.map((n) => ({
    name: path.basename(n, '.json'),
    path: `${category}/${n}`,
    source: path.join(dir, n),
  }));
}

/** Every shipped category, in menu order: Core first, then alphabetical. */
async function discover(): Promise<Category[]> {
  if (!existsSync(SOURCE_DIR)) {
    throw new Error(`no configs directory at ${SOURCE_DIR}`);
  }

  const core = await readCategory(SOURCE_DIR, CORE_CATEGORY);
  const categories: Category[] = core.length
    ? [{ name: CORE_CATEGORY, entries: core }]
    : [];

  const subdirs = (await fs.readdir(SOURCE_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && !EXCLUDED_DIRS.has(d.name))
    .map((d) => d.name)
    .sort(byName);

  for (const name of subdirs) {
    const entries = await readCategory(path.join(SOURCE_DIR, name), name);
    if (entries.length) categories.push({ name, entries });
  }

  if (!categories.length) {
    throw new Error(
      `no presets found under ${SOURCE_DIR}. The app cannot start without at ` +
        `least one shipped preset.`,
    );
  }
  return categories;
}

/**
 * Parse every preset through the app's own reader, discarding the result.
 *
 * This is the build-time validation, and it is the reason this script is worth
 * more than a `cp -r`: a malformed or wrong-version file fails HERE, with
 * `persistence.ts`'s own error message, rather than at runtime in a browser
 * where the only symptom is a menu entry that does nothing.
 */
async function validate(categories: readonly Category[]): Promise<void> {
  const problems: string[] = [];
  for (const category of categories) {
    for (const entry of category.entries) {
      const where = path.relative(ROOT, entry.source);
      try {
        fromDocument(JSON.parse(await fs.readFile(entry.source, 'utf8')), where);
      } catch (e) {
        // `fromDocument` already prefixes its own messages with `where`; a JSON
        // syntax error does not. Prefix only when it is missing, so the common
        // case does not read `foo.json: foo.json: ...`.
        const message = e instanceof Error ? e.message : String(e);
        problems.push(`  ${message.startsWith(where) ? message : `${where}: ${message}`}`);
      }
    }
  }
  if (problems.length) {
    throw new Error(`these presets are not loadable:\n${problems.join('\n')}`);
  }
}

function manifestDocument(categories: readonly Category[]): string {
  const doc = {
    _comment:
      'GENERATED by tools/syncConfigs.ts from configs/. Do not edit by hand. ' +
      'Regenerate with: npm run sync:configs',
    version: FORMAT_VERSION,
    // AN ARRAY, NOT AN OBJECT. The order is the LEFT/RIGHT preset cycle, and
    // JSON object key order is insertion-ordered in practice but not by
    // specification. An array puts the order in the data rather than in an
    // assumption about it.
    categories: categories.map((c) => ({
      name: c.name,
      entries: c.entries.map((e) => ({ name: e.name, path: e.path })),
    })),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Every file the output directory should contain, as path -> contents. */
async function plan(categories: readonly Category[]): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  files.set(MANIFEST, Buffer.from(manifestDocument(categories), 'utf8'));
  for (const category of categories) {
    for (const entry of category.entries) {
      files.set(path.join(OUT_DIR, ...entry.path.split('/')), await fs.readFile(entry.source));
    }
  }
  return files;
}

/** Every file currently in the output directory. */
async function existing(): Promise<string[]> {
  if (!existsSync(OUT_DIR)) return [];
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const d of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) await walk(full);
      else found.push(full);
    }
  };
  await walk(OUT_DIR);
  return found;
}

/**
 * Write the planned files and delete anything else under `public/configs/`.
 *
 * A MIRROR, not an overlay. An earlier version of this step only ever wrote,
 * which left a preset behind in `public/` after it was removed from `configs/`
 * -- shipped, unreferenced by the manifest, and invisible in review. Deleting
 * the difference is what makes `configs/` the single statement of what ships.
 */
async function write(files: Map<string, Buffer>): Promise<void> {
  for (const stale of await existing()) {
    if (!files.has(stale)) {
      await fs.rm(stale);
      console.log(`removed ${path.relative(ROOT, stale)}`);
    }
  }
  for (const [dest, contents] of files) {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, contents);
    console.log(`wrote   ${path.relative(ROOT, dest)}`);
  }
}

/** Report what `write` would change, without changing it. */
async function check(files: Map<string, Buffer>): Promise<string[]> {
  const stale: string[] = [];
  for (const orphan of await existing()) {
    if (!files.has(orphan)) stale.push(`${path.relative(ROOT, orphan)} is no longer in configs/`);
  }
  for (const [dest, contents] of files) {
    const rel = path.relative(ROOT, dest);
    if (!existsSync(dest)) stale.push(`${rel} is missing`);
    else if (!(await fs.readFile(dest)).equals(contents)) stale.push(`${rel} is out of date`);
  }
  return stale;
}

async function main(): Promise<number> {
  const categories = await discover();
  await validate(categories);
  const files = await plan(categories);

  if (process.argv.includes('--check')) {
    const stale = await check(files);
    if (stale.length) {
      for (const s of stale) console.error(`STALE: ${s}`);
      console.error('\nRun: npm run sync:configs');
      return 1;
    }
    console.log(`public/configs is current (${files.size - 1} presets).`);
    return 0;
  }

  await write(files);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`sync:configs: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
