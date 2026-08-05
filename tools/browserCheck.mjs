/**
 * Drive a real Chrome over CDP, load the app, and report what the console said.
 *
 * WHY THIS EXISTS. `npm test` cannot compile WGSL: it runs under `node --test`,
 * and headless Chrome hands back a null adapter, so there is no device to
 * compile against. The structural tests in `shaders.test.ts` catch the mistakes
 * a compiler would NOT catch; this catches the ones it would. Between them the
 * gap is closed without either pretending to do the other's job.
 *
 * It is a DEVELOPMENT tool, not part of `npm test` -- it needs a real GPU, a
 * real Chrome and a running dev server, none of which belong in CI.
 *
 * Usage (from the repo root, with `npm run dev` already running):
 *   node tools/browserCheck.mjs
 *   node tools/browserCheck.mjs --url "?debug&preset=hatmanv8&camera=trail"
 *   node tools/browserCheck.mjs --shot ../shot.png
 *
 * Exits non-zero if any pipeline failed to build or the page logged an error.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

// `?nocalibrate` is appended to WHATEVER `--url` asks for, and is not optional.
// First-run calibration picks a world size from the machine's measured GPU
// speed, so without this every screenshot this tool takes would depend on how
// fast the runner is -- and comparing screenshots is the entire point of the
// tool. Appended rather than defaulted so a caller passing `--url` cannot
// silently drop it.
const query = withNoCalibrate(flag('--url', '?debug'));

function withNoCalibrate(q) {
  if (q.includes('nocalibrate')) return q;
  if (q === '' || q === '?') return '?nocalibrate';
  // A hash has to stay LAST: a share link's payload lives there, and
  // `?a#b&nocalibrate` would make the flag part of the fragment rather than the
  // query, where nothing reads it.
  const hash = q.indexOf('#');
  const [head, tail] = hash === -1 ? [q, ''] : [q.slice(0, hash), q.slice(hash)];
  const sep = head.includes('?') ? '&' : '?';
  return `${head}${sep}nocalibrate${tail}`;
}
const shotPath = flag('--shot', null);
const settleMs = Number(flag('--settle', '4000'));
const port = Number(flag('--port', '5173'));

const userDataDir = mkdtempSync(path.join(tmpdir(), 'fluoddity-cdp-'));
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

const fail = (message) => {
  console.error(message);
  cleanup();
  process.exit(1);
};

// A REAL (headed) window: headless returns a null adapter, which is the whole
// reason this cannot live in the test suite.
chrome = spawn(
  CHROME,
  [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--enable-unsafe-webgpu',
    '--window-size=1280,800',
    `http://localhost:${port}/${query}`,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

// Chrome prints the DevTools browser endpoint on stderr once it is listening.
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
}).catch((err) => fail(String(err)));

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

  // Flat mode (`flatten: true`) delivers a session's events on the SAME socket,
  // tagged with sessionId -- no Target.sendMessageToTarget wrapping, which is
  // both simpler and the only variant still maintained.
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args
      .map((a) => a.value ?? a.description ?? '')
      .join(' ');
    logs.push({ level: msg.params.type, text });
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    logs.push({ level: 'error', text: d.exception?.description ?? d.text });
  }
});

const send = (method, params = {}, sessionId) => {
  const id = nextId++;
  const payload = { id, method, params };
  if (sessionId !== undefined) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve) => pending.set(id, resolve));
};

const { result: targets } = await send('Target.getTargets');
const page = targets.targetInfos.find((t) => t.type === 'page');
if (page === undefined) fail('No page target -- Chrome opened no tab.');

const attach = await send('Target.attachToTarget', {
  targetId: page.targetId,
  flatten: true,
});
const sessionId = attach.result.sessionId;

await send('Runtime.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);
// Reload so Runtime.enable is in place before the app's own startup logging.
await send('Page.reload', { ignoreCache: true }, sessionId);

await new Promise((r) => setTimeout(r, settleMs));

if (shotPath !== null) {
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  if (shot.result?.data) {
    writeFileSync(shotPath, Buffer.from(shot.result.data, 'base64'));
    console.log(`screenshot -> ${shotPath}\n`);
  }
}

ws.close();
cleanup();

for (const { level, text } of logs) {
  const tag = level === 'error' ? 'ERROR' : level === 'warning' ? 'warn ' : '     ';
  console.log(`${tag} ${text}`);
}

if (logs.length === 0) {
  fail('\nNo console output at all -- is `npm run dev` running?');
}

const errors = logs.filter((l) => l.level === 'error' || /FAILED/.test(l.text));
if (errors.length > 0) {
  console.error(`\n${errors.length} error(s).`);
  process.exit(1);
}
console.log('\nOK');
