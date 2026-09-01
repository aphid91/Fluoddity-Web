/**
 * Turn an exported archive into a share link for one of its states.
 *
 * THE POINT: proving the archive round-trips. The app records a graph of visited
 * states as deltas; this walks one of them back to a full `Project` and encodes
 * it exactly as `Shift+C` would. Paste the result into the app and you should be
 * looking at the state again -- and if you export an archive while sitting on a
 * state, the link this produces for the newest node should match the link the app
 * makes for what is on screen.
 *
 *     app: tick Strong Logging, work, Download Archive
 *       -> node tools/archiveToLink.mjs archive.json
 *       -> compare against Shift+C in the app
 *
 * The inverse of `linkToConfig.mjs`, and it follows that tool's conventions: the
 * document is validated through the REAL reader (`fromDocument`) before anything
 * is printed, so a link this emits cannot be one the app then refuses.
 *
 * ## WHAT IT CANNOT DO WITHOUT A GPU
 *
 * A `selection` delta -- a cohort commit -- stores the cohort NUMBER rather than
 * the eighty floats it produced, because the rule is a pure function of the
 * parent state and that number. Recovering it means running the real
 * `derive_entity_rule` from `rule.wgsl`, which needs a WGSL implementation;
 * `rule.wgsl`'s own header explains at length why reimplementing it in JS is a
 * mistake that produces plausible, wrong rules.
 *
 * So this tool reports `needsDeriver` rather than guessing. `--nearest` walks
 * back to the most recent ancestor that CAN be rebuilt and says how far it had to
 * go, which is what makes the tool useful today for the common case -- reroll and
 * slider work reconstruct exactly.
 *
 * Usage:
 *   node tools/archiveToLink.mjs archive.json
 *   node tools/archiveToLink.mjs archive.json --hash <nodeHash>
 *   node tools/archiveToLink.mjs archive.json --nearest
 *   node tools/archiveToLink.mjs archive.json --json      # the v8 document
 *   node tools/archiveToLink.mjs archive.json --stats     # what is in there
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fromDocument, toDocument } from '../src/config/persistence.ts';
import { encodeShareLink } from '../src/config/shareLink.ts';
import {
  latestNode,
  lineageOf,
  loadArchive,
  reconstruct,
} from '../src/archive/reconstruct.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : (argv[i + 1] ?? null);
};

const die = (message) => {
  console.error(`archiveToLink: ${message}`);
  process.exit(1);
};

if (has('--help') || has('-h')) {
  console.log(
    [
      'Turn an exported Fluoddity archive into a share link.',
      '',
      '  node tools/archiveToLink.mjs <archive.json> [options]',
      '',
      '      --hash <h>   Reconstruct this node. Default: the newest one',
      '      --nearest    If the target needs a GPU, use its closest rebuildable',
      '                   ancestor instead of failing',
      '      --json       Print the v8 document instead of a link',
      '      --stats      Summarize the archive and exit',
      '      --url <base> Print a full URL with this origin+path prefix',
      '',
      'A cohort-selection node cannot be rebuilt without running rule.wgsl;',
      'those are reported rather than approximated. See the file header.',
    ].join('\n'),
  );
  process.exit(0);
}

const file = argv.find((a, i) => {
  if (a.startsWith('-')) return false;
  const prev = argv[i - 1];
  return prev !== '--hash' && prev !== '--url';
});
if (file === undefined) die('no archive file given. See --help.');

const abs = path.resolve(ROOT, file);
if (!fs.existsSync(abs)) die(`no such file: ${file}`);

let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
} catch (err) {
  die(`${file} is not readable JSON:\n  ${String(err instanceof Error ? err.message : err)}`);
}

let archive;
try {
  archive = loadArchive(parsed);
} catch (err) {
  die(String(err instanceof Error ? err.message : err));
}

// --- stats ------------------------------------------------------------------

if (has('--stats')) {
  const kinds = new Map();
  for (const node of archive.nodes.values()) {
    const kind = node.delta === null ? 'root' : node.delta.kind;
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  console.log(`${archive.nodes.size} nodes, ${archive.roots.size} roots`);
  if (archive.derivation !== null) {
    console.log(`derivation ${archive.derivation.hash} (rule.wgsl shipped)`);
  }
  for (const [kind, n] of [...kinds].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(7)}  ${kind}`);
  }
  const newest = latestNode(archive);
  if (newest !== null) {
    console.log(`\nnewest: ${newest.hash}`);
    console.log(`  ${newest.label || '(unlabelled)'}  ${new Date(newest.visitedAt).toISOString()}`);
  }
  process.exit(0);
}

// --- pick the node ----------------------------------------------------------

const wanted = value('--hash');
const target = wanted ?? latestNode(archive)?.hash ?? null;
if (target === null) die('the archive contains no nodes.');
if (wanted !== null && !archive.nodes.has(wanted)) die(`no node with hash ${wanted}.`);

// --- reconstruct ------------------------------------------------------------

/** Reconstruct `hash`, or walk back to the nearest ancestor that works. */
function rebuild(hash) {
  const direct = reconstruct(archive, hash, null);
  if (direct.ok) return { project: direct.project, hash, back: 0 };
  if (!has('--nearest')) return { failure: direct.failure };

  // Walk the lineage from the target back toward the root, taking the first
  // ancestor that rebuilds. The chain is oldest-first, so it is walked in
  // reverse -- "nearest" means fewest steps back from where the user was.
  const lineage = lineageOf(archive, hash);
  if (!lineage.ok) return { failure: lineage.failure };
  const chain = [...lineage.chain].reverse();
  for (let i = 1; i < chain.length; i++) {
    const candidate = reconstruct(archive, chain[i].hash, null);
    if (candidate.ok) return { project: candidate.project, hash: chain[i].hash, back: i };
  }
  return { failure: direct.failure };
}

const built = rebuild(target);
if (built.failure !== undefined) {
  const f = built.failure;
  if (f.kind === 'needsDeriver') {
    die(
      `node ${f.hash} is a cohort selection (cohort ${f.cohort}).\n` +
        '  Rebuilding it means running derive_entity_rule from rule.wgsl, which\n' +
        '  needs a WGSL implementation -- this tool will not approximate it.\n' +
        '  Pass --nearest to use the closest ancestor that can be rebuilt.',
    );
  }
  die(`could not reconstruct ${target}: ${f.kind}${'detail' in f ? ` -- ${f.detail}` : ''}`);
}

if (built.back > 0) {
  console.error(
    `note: ${target} needed a GPU; using ancestor ${built.hash} (${built.back} step${
      built.back === 1 ? '' : 's'
    } back).`,
  );
}

// --- encode -----------------------------------------------------------------

const document = toDocument(built.project.configs, built.project.world);

// THROUGH THE REAL READER before emitting, exactly as `linkToConfig.mjs` does:
// a link this tool prints must not be one the app then refuses.
try {
  fromDocument(document, 'reconstructed archive state');
} catch (err) {
  die(
    'the reconstruction produced a document this version cannot read:\n  ' +
      String(err instanceof Error ? err.message : err),
  );
}

if (has('--json')) {
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  process.exit(0);
}

const fragment = encodeShareLink(document);
const base = value('--url');
process.stdout.write(`${base === null ? fragment : `${base}${fragment}`}\n`);
