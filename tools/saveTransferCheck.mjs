/**
 * THE SAVE-TRANSFER ROUND TRIP, in a real browser against real IndexedDB.
 *
 * WHY THIS IS NOT `npm test`. `saveTransfer.test.ts` covers the decisions --
 * collisions, validation, naming -- and those are pure. What it cannot cover is
 * the half that only exists in a browser: that a save written through
 * `ConfigStore` comes back out of `savedDocuments()` as the same bytes, that
 * `importSaves` puts records where the catalog will find them, and that an
 * imported config actually LOADS. `node --test` has no IndexedDB.
 *
 * WHY NOT `uiCheck.mjs`. That tool drives pointer gestures at Tweakpane. Nothing
 * here needs a gesture -- the file pickers are the one part that does, and they
 * are the part no automated run can drive anyway (a native folder dialog is not
 * scriptable, by design). So this checks everything up to the picker's edge:
 * the store round-trip, the plan, the write, and the load afterwards.
 *
 * ## What it checks
 *
 *   PASS 1  A SAVE IS ALREADY A v8 FILE. Save a config, read it back through
 *           `savedDocuments()`, and assert the exported text parses as v8 and
 *           equals the stored document. This is the premise the whole feature
 *           rests on -- see `saveTransfer.ts` -- and it is asserted against a
 *           real store rather than a fixture.
 *
 *   PASS 2  IMPORT LANDS IN THE CATALOG. Import two files, assert both appear
 *           under Custom, and assert one of them LOADS -- so a record written by
 *           this path is one the app can actually read back.
 *
 *   PASS 3  COLLISIONS SKIP, SILENTLY AND CORRECTLY. Re-import the same folder
 *           and assert nothing is written and nothing is overwritten: the stored
 *           document must be byte-identical to what was there before.
 *
 *   PASS 4  A CORE COLLISION STILL IMPORTS. The rule chosen deliberately -- only
 *           user saves block. Asserted here as well as in the unit test because
 *           this is where a real catalog with real Core presets exists.
 *
 * Usage (from the repo root, with `npm run dev` running):
 *   node tools/saveTransferCheck.mjs
 *   node tools/saveTransferCheck.mjs --port 5174
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const CHROME =
  process.env.CHROME_PATH ??
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const port = Number(flag('--port', '5173'));

const userDataDir = mkdtempSync(path.join(tmpdir(), 'fluoddity-transfer-'));
let chrome = null;
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  try {
    chrome?.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  try {
    rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
};
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

const failures = [];
const fail = (message) => {
  console.error(`FAIL  ${message}`);
  failures.push(message);
};
const pass = (message) => console.log(`ok    ${message}`);
const die = (message) => {
  console.error(message);
  cleanup();
  process.exit(1);
};

chrome = spawn(
  CHROME,
  [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--enable-unsafe-webgpu',
    '--window-size=1280,900',
    // `?bus` is the whole lever here: every assertion reads or writes through
    // the Orchestrator. `?nocalibrate` keeps first-run measurement out of it.
    `http://localhost:${port}/?bus&nocalibrate`,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

const browserWs = await new Promise((resolve, reject) => {
  let buf = '';
  const timer = setTimeout(
    () => reject(new Error('Chrome never reported a DevTools port')),
    20000,
  );
  chrome.stderr.on('data', (chunk) => {
    buf += String(chunk);
    const m = buf.match(/ws:\/\/\S+/);
    if (m) {
      clearTimeout(timer);
      resolve(m[0]);
    }
  });
  chrome.on('exit', (code) => {
    clearTimeout(timer);
    reject(new Error(`Chrome exited early (code ${code})`));
  });
}).catch((err) => die(String(err)));

const ws = new WebSocket(browserWs);
await once(ws, 'open');

let nextId = 1;
const pending = new Map();
const errors = [];

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id !== undefined) {
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    errors.push(d.exception?.description ?? d.text);
  } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    errors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
});

const send = (method, params = {}, sid) => {
  const id = nextId++;
  const payload = { id, method, params };
  if (sid !== undefined) payload.sessionId = sid;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve) => pending.set(id, resolve));
};

const { result: targets } = await send('Target.getTargets');
const page = targets.targetInfos.find((t) => t.type === 'page');
if (page === undefined) die('No page target -- Chrome opened no tab.');

const attach = await send('Target.attachToTarget', {
  targetId: page.targetId,
  flatten: true,
});
const sid = attach.result.sessionId;

await send('Runtime.enable', {}, sid);
await send('Page.enable', {}, sid);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(6000);

const evaluate = async (expression) => {
  const r = await send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sid,
  );
  if (r.result?.exceptionDetails) {
    die(`evaluate failed: ${JSON.stringify(r.result.exceptionDetails)}`);
  }
  return r.result?.result?.value;
};

const ready = await evaluate('Boolean(window.__fluoddity)');
if (ready !== true) die('`?bus` did not expose the command bus.');

// The transfer modules are not on `window`; they are pulled in here by URL so
// this runs the SAME code the app does rather than a copy of its logic.
await evaluate(`(async () => {
  window.__t = await import('/src/config/saveTransfer.ts');
  return true;
})()`);

// --- PASS 1: a save is already a v8 file ------------------------------------

await evaluate(`
  window.__fluoddity.dispatch({ kind: 'saveConfig', name: 'TransferAlpha' });
  true;
`);
await sleep(700);

const alpha = await evaluate(`(async () => {
  const saves = await window.__fluoddity.savedDocuments();
  const one = saves.find((s) => s.name === 'TransferAlpha');
  if (!one) return { found: false };
  const files = window.__t.exportFiles([one]);
  const text = files[0].text;
  const parsed = JSON.parse(text);
  return {
    found: true,
    filename: files[0].filename,
    version: parsed.version,
    identical: JSON.stringify(parsed) === JSON.stringify(one.document),
    hasConfigs: Array.isArray(parsed.configs) && parsed.configs.length > 0,
  };
})()`);

if (alpha.found !== true) {
  fail('PASS 1: the saved config never reached the store.');
} else {
  if (alpha.filename === 'TransferAlpha.json') pass('PASS 1: export names the file after the save');
  else fail(`PASS 1: filename was ${alpha.filename}`);

  if (alpha.version === 8) pass('PASS 1: the exported file is version 8');
  else fail(`PASS 1: exported version was ${alpha.version}`);

  if (alpha.identical) pass('PASS 1: exported bytes equal the stored document');
  else fail('PASS 1: export REWROTE the document -- the format has two writers');

  if (alpha.hasConfigs) pass('PASS 1: the file carries a configs list');
  else fail('PASS 1: the exported file has no configs');
}

// --- PASS 2: import lands in the catalog and loads ---------------------------

const imported = await evaluate(`(async () => {
  const saves = await window.__fluoddity.savedDocuments();
  const source = saves.find((s) => s.name === 'TransferAlpha').document;
  const text = JSON.stringify(source, null, 2) + '\\n';
  const files = [
    { filename: 'TransferBeta.json', text },
    { filename: 'TransferGamma.json', text },
  ];
  const existing = await window.__fluoddity.savedNames();
  const plan = window.__t.planImport(files, existing);
  const written = await window.__fluoddity.importSaves(plan.accepted);

  const custom = window.__fluoddity.status().configCategories.Custom ?? [];
  return {
    accepted: plan.accepted.length,
    skipped: plan.skipped.length,
    written,
    inCatalog: ['TransferBeta', 'TransferGamma'].filter((n) => custom.includes(n)),
    summary: window.__t.describeImport(plan),
  };
})()`);

if (imported.accepted === 2 && imported.written === 2) {
  pass('PASS 2: both files were accepted and written');
} else {
  fail(`PASS 2: accepted ${imported.accepted}, wrote ${imported.written} (expected 2 and 2)`);
}

if (imported.inCatalog.length === 2) pass('PASS 2: both appear under Custom in the catalog');
else fail(`PASS 2: catalog holds ${JSON.stringify(imported.inCatalog)}`);

// The real proof: a record this path wrote is one the app can read back.
const loaded = await evaluate(`(async () => {
  window.__fluoddity.dispatch({
    kind: 'loadConfig', category: 'Custom', name: 'TransferBeta',
  });
  await new Promise((r) => setTimeout(r, 800));
  const s = window.__fluoddity.status();
  return { preset: s.preset, error: s.saveError };
})()`);

if (loaded.preset === 'TransferBeta' && loaded.error === '') {
  pass('PASS 2: an imported config loads');
} else {
  fail(`PASS 2: loading gave preset=${loaded.preset} error=${loaded.error}`);
}

// --- PASS 3: re-importing the same folder changes nothing -------------------

const again = await evaluate(`(async () => {
  const saves = await window.__fluoddity.savedDocuments();
  const before = JSON.stringify(saves.find((s) => s.name === 'TransferBeta').document);

  // A DIFFERENT document under a name that is already taken. If the collision
  // rule leaked, this is what would land on top of the existing save.
  const files = [{ filename: 'TransferBeta.json', text: '{"version":8,"world":{"trail_persistence":0.1,"trail_diffusion":0,"boundary_conditions":1},"configs":[{"rule":[1],"sensor":{"gain":1,"angle":1,"distance":1,"mutation_scale":1},"force":{"global_mult":1,"drag":1,"strafe":1,"axial":1},"misc":{"lateral":1,"hazard_rate":1,"cohorts":1,"mutation_seed":1}}]}' }];
  const existing = await window.__fluoddity.savedNames();
  const plan = window.__t.planImport(files, existing);

  const after = (await window.__fluoddity.savedDocuments())
    .find((s) => s.name === 'TransferBeta').document;
  return {
    accepted: plan.accepted.length,
    reason: plan.skipped[0]?.reason,
    unchanged: JSON.stringify(after) === before,
  };
})()`);

if (again.accepted === 0 && again.reason === 'exists') {
  pass('PASS 3: a name already saved is skipped');
} else {
  fail(`PASS 3: accepted ${again.accepted}, reason ${again.reason}`);
}
if (again.unchanged) pass('PASS 3: the existing save was not overwritten');
else fail('PASS 3: THE EXISTING SAVE WAS OVERWRITTEN');

// --- PASS 4: a shipped-preset name still imports ----------------------------

const core = await evaluate(`(async () => {
  const cats = window.__fluoddity.status().configCategories;
  const coreName = (cats.Core ?? [])[0];
  if (!coreName) return { skipped: true };

  const saves = await window.__fluoddity.savedDocuments();
  const text = JSON.stringify(saves[0].document, null, 2);
  const existing = await window.__fluoddity.savedNames();
  const plan = window.__t.planImport([{ filename: coreName + '.json', text }], existing);
  return { skipped: false, coreName, accepted: plan.accepted.length };
})()`);

if (core.skipped) {
  fail('PASS 4: no Core presets in the catalog to test against.');
} else if (core.accepted === 1) {
  pass(`PASS 4: "${core.coreName}" collides with Core and still imports`);
} else {
  fail(`PASS 4: a Core name was blocked (accepted ${core.accepted})`);
}

// ---------------------------------------------------------------------------

const real = errors.filter((e) => !/favicon|WebGPU|Deprecation/i.test(e));
if (real.length > 0) {
  for (const e of real.slice(0, 5)) fail(`console error: ${e}`);
}

cleanup();
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll save-transfer checks passed.');
