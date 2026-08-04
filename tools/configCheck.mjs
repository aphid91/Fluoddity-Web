/**
 * Storage verification: the manifest, IndexedDB, and the reload that proves it.
 *
 * WHY THIS EXISTS SEPARATELY FROM `npm test`. `configStore.test.ts` covers the
 * merge and the ordering against injected data, and `persistence.test.ts` covers
 * the format against real files -- both pure, both fast. Neither touches
 * `fetch` or `indexedDB`, because `node --test` has neither.
 *
 * What only a browser can answer:
 *
 *   PASS 1  the app boots from the FETCHED manifest, with no preset compiled in.
 *   PASS 2  a save survives A FULL PAGE RELOAD. This is the whole assertion --
 *           an in-memory Map passes every step up to it, so nothing before the
 *           reload distinguishes real persistence from a convincing fake.
 *   PASS 3  loading a saved config restores its settings AND its camera, and a
 *           shipped preset refuses to be deleted.
 *
 * Usage (from the repo root, with `npm run dev` running):
 *   node tools/configCheck.mjs
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

const userDataDir = mkdtempSync(path.join(tmpdir(), 'fluoddity-config-'));
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
const fail = (m) => {
  console.error(`FAIL  ${m}`);
  failures.push(m);
};
const pass = (m) => console.log(`ok    ${m}`);
const die = (m) => {
  console.error(m);
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
    `http://localhost:${port}/?nopanel&bus`,
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
const logs = [];

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id !== undefined) {
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    logs.push({
      level: msg.params.type,
      text: msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '),
    });
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    logs.push({ level: 'error', text: d.exception?.description ?? d.text });
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
const evaluate = async (expression) => {
  const r = await send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sid,
  );
  if (r.result?.exceptionDetails) {
    die(`evaluate failed: ${JSON.stringify(r.result.exceptionDetails.text ?? r.result.exceptionDetails)}`);
  }
  return r.result?.result?.value;
};

const reload = async () => {
  logs.length = 0;
  await send('Page.reload', { ignoreCache: true }, sid);
  await sleep(6000);
};

/** Read every record straight out of IndexedDB, bypassing the app. */
const readDb = async () =>
  await evaluate(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('fluoddity', 1);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const tx = db.transaction('configs', 'readonly');
    const all = await new Promise((res, rej) => {
      const r = tx.objectStore('configs').getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return all.map((r) => ({
      id: r.id, category: r.category, name: r.name,
      version: r.document?.version,
      configs: r.document?.configs?.length ?? 0,
      hasCamera: r.document?.camera !== undefined,
      sensorGain: r.document?.configs?.[0]?.sensor?.gain,
    }));
  })()`);

// ===========================================================================
console.log('PASS 1: booting from the fetched manifest\n');
// ===========================================================================

await reload();

const manifest = await evaluate(`(async () => {
  const r = await fetch('configs/manifest.json');
  const m = await r.json();
  return { ok: r.ok, categories: m.categories.map((c) => c.name),
           count: m.categories.reduce((n, c) => n + c.entries.length, 0) };
})()`);

if (manifest?.ok && manifest.count > 0) {
  pass(`manifest served: ${manifest.count} preset(s) in [${manifest.categories.join(', ')}]`);
} else {
  fail(`manifest.json did not serve: ${JSON.stringify(manifest)}`);
}

const booted = logs.find((l) => /All pipelines built/.test(l.text));
if (booted && /preset="Starcrossedv8"/.test(booted.text)) {
  pass('the app booted on the default preset, read over HTTP');
} else {
  fail(`the app did not boot on Starcrossedv8: ${booted?.text ?? '(no startup line)'}`);
}

// The deleted preset path must not be reachable from the running module graph.
//
// NOT asserted by fetching the file: Vite's dev server answers from its own
// cache and happily returned HTTP 200 for a file already unlinked from disk.
// What matters anyway is that nothing IMPORTS it -- a stray copy on disk is
// harmless, a live import means the deletion did not happen. `import()` of a
// non-existent module is the check that cannot be satisfied by a cache hit.
const stale = await evaluate(`(async () => {
  try {
    await import('/src/particleSystem/defaultConfig.ts');
    return 'still importable';
  } catch {
    return 'gone';
  }
})()`);
if (stale === 'gone') {
  pass('defaultConfig.ts is no longer importable');
} else {
  fail(`defaultConfig.ts ${stale} -- the Step 4 preset path was not deleted`);
}

// ===========================================================================
console.log('\nPASS 2: a save survives a page reload\n');
// ===========================================================================

const before = await readDb();
if ((before?.length ?? 0) === 0) {
  pass('IndexedDB starts empty');
} else {
  fail(`IndexedDB was not empty at start: ${JSON.stringify(before)}`);
}

// Drive the real command path rather than writing to IDB directly -- the point
// is that saveConfig works, not that IndexedDB does.
//
// `editSetting` carries the SETTING OBJECT, not its field name, so the registry
// is imported to find it. That is the boundary's own shape: the panel holds
// `Setting` records and dispatches them whole, which is what lets the handler
// know a control's source and kind without a lookup table.
await evaluate(`(async () => {
  const spec = await import('/src/ui/settingsSpec.ts');
  const setting = spec.SETTINGS.find((s) => s.field === 'sensorGain');
  if (!setting) throw new Error('no sensorGain in the registry');
  window.__setting = setting;
  const bus = window.__fluoddity;
  bus.dispatch({ kind: 'editSetting', setting, value: 0.777 });
  bus.dispatch({ kind: 'saveConfig', name: 'check me/please' });
})()`);
await sleep(1500);

const savedNow = await readDb();
const record = savedNow?.[0];
if (savedNow?.length === 1 && record.name === 'check meplease') {
  // `sanitizeName` REMOVES the slash rather than replacing it, so "a/b" and
  // "ab" are the same name -- substituting would make two names collide.
  pass(`saved under the sanitized name "${record.name}" in ${record.category}`);
} else {
  fail(`expected one record named "check meplease", got ${JSON.stringify(savedNow)}`);
}

if (record?.version === 8 && record?.hasCamera && record?.configs >= 1) {
  pass('the stored document is v8, carries a camera, and holds every config slot');
} else {
  fail(`stored document is malformed: ${JSON.stringify(record)}`);
}

if (Math.abs((record?.sensorGain ?? 0) - 0.777) < 1e-6) {
  pass('the edited value made it into the saved document');
} else {
  fail(`sensor gain was not saved: ${record?.sensorGain}`);
}

// THE ASSERTION THIS WHOLE TOOL EXISTS FOR.
await reload();
const afterReload = await readDb();
if (afterReload?.length === 1 && afterReload[0].name === 'check meplease') {
  pass('THE SAVE SURVIVED A FULL PAGE RELOAD');
} else {
  fail(`the save did not survive a reload: ${JSON.stringify(afterReload)}`);
}

const categories = await evaluate(
  `JSON.stringify(window.__fluoddity.status().configCategories)`,
);
if (/"Custom"\s*:\s*\[\s*"check meplease"/.test(categories ?? '')) {
  pass('the reloaded catalog lists it under Custom');
} else {
  fail(`the catalog does not show the save: ${categories}`);
}

// ===========================================================================
console.log('\nPASS 3: loading back, and the delete guard\n');
// ===========================================================================

// Move away from the saved values, then load the save and check they return.
// The page reloaded above, so the setting has to be looked up again.
await evaluate(`(async () => {
  const spec = await import('/src/ui/settingsSpec.ts');
  const setting = spec.SETTINGS.find((s) => s.field === 'sensorGain');
  const bus = window.__fluoddity;
  bus.dispatch({ kind: 'editSetting', setting, value: 0.111 });
  bus.dispatch({ kind: 'loadConfig', category: 'Custom', name: 'check meplease' });
})()`);
await sleep(1500);

// `panelOpen` is turned OFF by `?nopanel`, and `settingsSources()` then returns
// frozen empties on purpose -- building `editConfig` copies the 80-float rule
// every frame, which is pure garbage for a panel nobody is looking at. So this
// turns it back on for the read rather than treating an empty payload as a
// failure to load.
const loaded = await evaluate(`(() => {
  const bus = window.__fluoddity;
  bus.panelOpen = true;
  const s = bus.status();
  bus.panelOpen = false;
  return { gain: s.editConfig.sensorGain, project: s.projectName,
           canRevert: s.canRevert, canSave: s.canSave, busy: s.configBusy };
})()`);

if (Math.abs((loaded?.gain ?? 0) - 0.777) < 1e-6) {
  pass(`loading restored the saved value (sensorGain ${loaded.gain})`);
} else {
  fail(`loading did not restore the saved value: ${loaded?.gain}`);
}
if (loaded?.project === 'check meplease' && loaded?.canRevert === true) {
  pass('the project took the config name and can be reverted');
} else {
  fail(`project/revert state is wrong: ${JSON.stringify(loaded)}`);
}
if (loaded?.busy === '') {
  // `configBusy` must clear in BOTH arms; a stuck "Loading..." is the failure
  // mode a rejected promise would leave behind.
  pass('configBusy cleared after the load settled');
} else {
  fail(`configBusy did not clear: "${loaded?.busy}"`);
}
if (loaded?.canSave === true) {
  pass('storage reports itself writable');
} else {
  fail('storage reports itself read-only, but IndexedDB is available here');
}

// A shipped preset must refuse deletion: it is part of the build, so a delete
// would appear to work and then reappear on the next reload.
await evaluate(
  `window.__fluoddity.dispatch({ kind: 'deleteConfig', category: 'Core', name: 'hatmanv8' })`,
);
await sleep(800);
const guard = await evaluate(`window.__fluoddity.status().saveError`);
if (/shipped preset/.test(guard ?? '')) {
  pass(`deleting a shipped preset was refused: "${guard}"`);
} else {
  fail(`no delete guard fired; saveError was "${guard}"`);
}

// And a real delete works.
await evaluate(
  `window.__fluoddity.dispatch({ kind: 'deleteConfig', category: 'Custom', name: 'check meplease' })`,
);
await sleep(1200);
const emptied = await readDb();
if ((emptied?.length ?? 1) === 0) {
  pass('deleting a user save removed it from IndexedDB');
} else {
  fail(`the save was not deleted: ${JSON.stringify(emptied)}`);
}

// ===========================================================================
ws.close();
cleanup();

const errors = logs.filter((l) => l.level === 'error' || /FAILED/.test(l.text));
for (const e of errors) console.error(`ERROR ${e.text}`);

if (failures.length > 0 || errors.length > 0) {
  console.error(`\n${failures.length} check(s) failed, ${errors.length} console error(s).`);
  process.exit(1);
}
console.log('\nOK');
