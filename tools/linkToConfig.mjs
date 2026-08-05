/**
 * Turn a share link into a `.json` save file.
 *
 * THE POINT: promoting something you found by playing into a shipped preset.
 * The interesting configs come out of the app -- you mutate, you select, you
 * land on something worth keeping -- and until now the only way out was
 * File > Save, which writes to IndexedDB inside one browser profile. A share
 * link is already a complete v8 document; this unpacks it back onto disk, where
 * `npm run sync:configs` can pick it up as part of the Core library.
 *
 * So the round trip is:
 *
 *     app: Shift+C  ->  node tools/linkToConfig.mjs "<url>" -o configs/Name.json
 *                   ->  npm run sync:configs
 *
 * ## Why this is a tool and not a feature
 *
 * The browser cannot write to `configs/`. It could offer a download, and that
 * would land in `~/Downloads` with whatever name the browser chose, still
 * needing a move and a rename. Adding presets to the shipped library is a
 * repository edit -- it belongs at a shell prompt next to `sync:configs`, not
 * behind a button.
 *
 * ## It writes what the app writes
 *
 * The bytes are re-serialized with the same 2-space indent and trailing newline
 * as every file already in `configs/`, and with LF endings regardless of
 * platform -- git stores LF and `core.autocrlf` converts on checkout, so
 * emitting CRLF here would show up as a whole-file diff on Windows.
 *
 * VALIDATED THROUGH THE REAL READER before writing. `fromDocument` is the same
 * code the app runs on every boot, so a file this tool produces cannot be one
 * the app then refuses -- which is the entire failure mode worth preventing,
 * since the alternative is discovering it at `sync:configs` time or, worse, as
 * a broken entry in a shipped menu.
 *
 * Usage:
 *   node tools/linkToConfig.mjs "<url or #c=... or c=...>"
 *   node tools/linkToConfig.mjs "<url>" -o configs/MyPreset.json
 *   node tools/linkToConfig.mjs "<url>" --name MyPreset      # -> configs/MyPreset.json
 *   pbpaste | node tools/linkToConfig.mjs                    # reads stdin
 *   node tools/linkToConfig.mjs "<url>" --stdout             # print, write nothing
 *
 * Exits non-zero on a link it cannot read, and refuses to overwrite without
 * `--force`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fromDocument } from '../src/config/persistence.ts';
import { decodeShareText } from '../src/config/shareLink.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CONFIGS_DIR = path.join(ROOT, 'configs');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1] ?? null;
};

const die = (message) => {
  console.error(`linkToConfig: ${message}`);
  process.exit(1);
};

if (has('--help') || has('-h')) {
  // The header block above is the real documentation; this is the reminder.
  console.log(
    [
      'Turn a Fluoddity share link into a .json save file.',
      '',
      '  node tools/linkToConfig.mjs "<url>" [-o <path> | --name <stem>]',
      '  pbpaste | node tools/linkToConfig.mjs',
      '',
      '  -o, --out <path>   Where to write. Default: configs/<name>.json',
      '      --name <stem>  Shorthand for -o configs/<stem>.json',
      '      --stdout       Print the JSON instead of writing a file',
      '      --force        Overwrite an existing file',
      '',
      'Then run: npm run sync:configs',
    ].join('\n'),
  );
  process.exit(0);
}

/** The link, from the first non-flag argument or from stdin. */
const linkFromArgs = argv.find((a, i) => {
  if (a.startsWith('-')) return false;
  // Not the value of a flag that takes one.
  const prev = argv[i - 1];
  return prev !== '-o' && prev !== '--out' && prev !== '--name';
});

const link =
  linkFromArgs ??
  // No argument: read stdin, so `pbpaste | ...` and `xclip -o | ...` work. This
  // is the ergonomic path -- the link is on the clipboard by construction, since
  // Shift+C is what put it there.
  (fs.existsSync('/dev/stdin') || !process.stdin.isTTY
    ? fs.readFileSync(0, 'utf8')
    : null);

if (link === null || link.trim() === '') {
  die('no link given. Pass one as an argument or pipe it in. See --help.');
}

// --- decode -----------------------------------------------------------------

let document;
try {
  document = decodeShareText(link);
} catch (err) {
  die(`${String(err instanceof Error ? err.message : err)}`);
}
if (document === null) {
  die('that does not contain a Fluoddity share link (no "c=" fragment found).');
}

// THROUGH THE REAL READER, not a shape check. See the header.
let saved;
try {
  saved = fromDocument(document, 'share link');
} catch (err) {
  die(
    `the link decoded but is not a config this version can read:\n  ${String(
      err instanceof Error ? err.message : err,
    )}`,
  );
}

// --- serialize --------------------------------------------------------------
//
// The DECODED DOCUMENT is written, not a re-encoding of `saved`. Round-tripping
// through `toDocument` would silently drop anything the reader tolerates but
// does not model, and would make this tool's output depend on the reader's
// current shape rather than on what the sender actually had. `fromDocument`
// above proves it loads; that is what validation is for, and it is a separate
// job from deciding what to write.
const json = `${withFloatZeros(JSON.stringify(document, null, 2))}\n`;

/**
 * Write `1.0` where JavaScript would write `1`.
 *
 * PURELY COSMETIC, and worth the twelve lines anyway. Every file already in
 * `configs/` was written by the retired Python app, whose `json` module keeps a
 * float's `.0`; JavaScript has one number type and `JSON.stringify(1.0)` is
 * `"1"`. The reader does not care -- both parse to the same double, and
 * `deepEqual` on the parsed documents is exact -- but without this, a preset
 * promoted through this tool is textually unlike its neighbours in a way that
 * shows up in every future diff and makes the library look inconsistent.
 *
 * Scoped to VALUE POSITIONS ONLY (`: 1` and array members), so nothing touches
 * `"version": 8`, `"cohorts": 4` or the enum lanes, which are genuinely
 * integers on both sides and are written without a `.0` there too.
 */
function withFloatZeros(text) {
  return text
    .split('\n')
    .map((line) => {
      // `"key": <int>` -- but not the keys that are really integers.
      const INTEGER_KEYS = /"(version|cohorts|boundary_conditions|initial_conditions)"/;
      if (INTEGER_KEYS.test(line)) return line;
      return line
        .replace(/(:\s)(-?\d+)(,?)$/, '$1$2.0$3')
        .replace(/^(\s*)(-?\d+)(,?)$/, '$1$2.0$3');
    })
    .join('\n');
}

if (has('--stdout')) {
  process.stdout.write(json);
  process.exit(0);
}

const explicitOut = value('-o') ?? value('--out');
const stem = value('--name');
const outPath = explicitOut
  ? path.resolve(ROOT, explicitOut)
  : path.join(CONFIGS_DIR, `${stem ?? 'Shared'}.json`);

if (fs.existsSync(outPath) && !has('--force')) {
  die(`${path.relative(ROOT, outPath)} already exists. Pass --force to overwrite.`);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
// LF regardless of platform; see the header on why.
fs.writeFileSync(outPath, json, { encoding: 'utf8' });

const rel = path.relative(ROOT, outPath).replace(/\\/g, '/');
console.log(
  `Wrote ${rel} (${saved.configs.length} config${saved.configs.length === 1 ? '' : 's'}).`,
);
// Named explicitly rather than left implicit: a file in `configs/` does nothing
// until the manifest knows about it, and forgetting this step presents as a
// preset that exists on disk and not in the menu.
if (!explicitOut || outPath.startsWith(CONFIGS_DIR)) {
  console.log('Run `npm run sync:configs` to add it to the shipped library.');
}
