/**
 * Turn a `.json` v8 save into a share link. The inverse of `linkToConfig.mjs`.
 *
 * THE POINT: a document produced OUTSIDE the app -- by the ASAL optimizer in
 * `flu-opt`, which searches Fluoddity physics against a CLIP prompt -- needs a
 * way into the app that does not involve File > Load. A share string pastes with
 * Shift+V, so a search result becomes something you can look at in one step.
 *
 * `archiveToLink.mjs` already does this for an archive node; this does it for a
 * bare document, which is what an external producer actually has.
 *
 * VALIDATED THROUGH THE REAL READER before anything is printed, exactly as the
 * two neighbouring tools are: `fromDocument` is the code the app runs on every
 * boot, so a string this emits cannot be one the app then refuses. That matters
 * more here than usual -- the producer is a Python script in another repository,
 * so this is the only place its output meets the real format.
 *
 * RE-EMITTED THROUGH `toDocument` rather than encoded as read. The optimizer
 * writes what it believes v8 looks like; passing it through the reader and the
 * writer means the bytes encoded here are the app's own spelling of that
 * document, with unknown keys dropped rather than carried.
 *
 * Usage:
 *   node tools/configToLink.mjs best.json
 *   node tools/configToLink.mjs best.json -o best.txt
 *   node tools/configToLink.mjs best.json --url https://example.com/fluoddity/
 */

import * as fs from 'node:fs';

import { fromDocument, toDocument } from '../src/config/persistence.ts';
import { encodeShareLink } from '../src/config/shareLink.ts';

const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};

const input = argv.find((a) => !a.startsWith('-') && argv[argv.indexOf(a) - 1] !== '-o'
  && argv[argv.indexOf(a) - 1] !== '--url');
if (!input) {
  console.error('usage: node tools/configToLink.mjs <file.json> [-o out.txt] [--url BASE]');
  process.exit(2);
}

let doc;
try {
  doc = JSON.parse(fs.readFileSync(input, 'utf8'));
} catch (e) {
  console.error(`${input}: not readable JSON -- ${e.message}`);
  process.exit(1);
}

// The real reader. A document that fails here would fail in the app.
let parsed;
try {
  parsed = fromDocument(doc, input);
} catch (e) {
  console.error(`${input}: ${e.message}`);
  process.exit(1);
}

const fragment = encodeShareLink(toDocument(parsed.configs, parsed.world, parsed.notes));
const base = valueOf('--url');
const text = base ? `${base}${fragment}` : fragment;

const out = valueOf('-o');
if (out) {
  fs.writeFileSync(out, `${text}\n`, 'utf8');
  console.error(`${out}: ${text.length} chars, ${parsed.configs.length} configs`);
} else {
  console.log(text);
}
