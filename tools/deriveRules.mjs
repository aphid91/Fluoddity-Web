/**
 * Derive cohort-selection rules on a real GPU, over CDP.
 *
 * WHY THIS EXISTS. Reconstructing a `selection` node means evaluating
 * `derive_entity_rule`, and `rule.wgsl` is emphatic that the only correct way to
 * do that is to RUN it -- a host-side mirror produces plausible, wrong rules for
 * reasons that file documents at length. Node has no WebGPU, so the shader needs
 * a browser with a real adapter. `browserCheck.mjs` already established that
 * pattern for the same underlying reason ("headless Chrome hands back a null
 * adapter"), and this follows it.
 *
 * It is a DEVELOPMENT tool: it needs a real GPU and a real Chrome, neither of
 * which belongs in `npm test`. Unlike `browserCheck.mjs` it needs NO dev server
 * -- the page it runs is written to a temp file and opened over `file://`, with
 * the expanded WGSL and the requests inlined. That keeps it usable against an
 * archive with nothing else running.
 *
 * Exported as a function so `archiveToLink.mjs` can call it directly; run as a
 * script it takes an archive and prints the derived rules as JSON.
 *
 * Usage:
 *   node tools/deriveRules.mjs <archive.json>            # print derivations
 *   node tools/deriveRules.mjs <archive.json> -o out.json
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveIncludes } from './wgslInclude.ts';
import { loadArchive } from '../src/archive/reconstruct.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SHADER = path.join(ROOT, 'src', 'particleSystem', 'shaders', 'deriveRule.wgsl');
const SHARED_DIR = path.join(ROOT, 'src', 'shaders');

const CHROME =
  process.env.CHROME_PATH ??
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/** The expanded shader: includes resolved exactly as the Vite plugin does. */
export function deriveRuleSource() {
  return resolveIncludes(SHADER, { sharedDir: SHARED_DIR });
}

/**
 * Every derivation an archive needs, as `DeriveRequest`s.
 *
 * Walks each `selection` node to its PARENT and reads the rule, seed and scale
 * off the state that node was reached from -- which is exactly what
 * `derive_entity_rule` takes. Done by reconstructing the parent, so the request
 * reflects the real chain rather than a guess.
 *
 * Returns requests in dependency order: a selection whose parent is itself a
 * selection needs its parent derived first, so the caller can fill the table
 * incrementally.
 */
export function selectionRequests(archive, reconstructFn) {
  const out = [];
  for (const node of archive.nodes.values()) {
    if (node.delta?.kind !== 'selection') continue;
    if (node.parent === null) continue;
    out.push({ node, cohort: node.delta.cohort, config: node.delta.config });
  }
  // Oldest first, so a chain of selections resolves in order.
  out.sort((a, b) => (a.node.visitedAt ?? 0) - (b.node.visitedAt ?? 0));
  return out;
}

/**
 * Run `requests` through a real GPU and return their rules, in order.
 *
 * Each request is `{ rule, cohort, mutationSeed, mutationScale }`.
 */
export async function deriveOnGpu(requests, opts = {}) {
  if (requests.length === 0) return [];

  const source = deriveRuleSource();
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'fluoddity-derive-'));
  const pagePath = path.join(userDataDir, 'derive.html');

  // The page is SELF-CONTAINED: shader and requests are inlined, so there is no
  // dev server, no module graph and no fetch. It posts its answer back through
  // `console.log`, which CDP already surfaces -- the same channel
  // `browserCheck.mjs` reads.
  writeFileSync(
    pagePath,
    `<!doctype html><meta charset="utf-8"><title>derive</title><script type="module">
const SOURCE = ${JSON.stringify(source)};
const REQUESTS = ${JSON.stringify(requests)};
const RULE_FLOATS = 80;
const STRIDE = 416;

function packConfig(req) {
  const buf = new ArrayBuffer(STRIDE);
  const f32 = new Float32Array(buf);
  const i32 = new Int32Array(buf);
  // Lane layout from src/particleSystem/config.ts. Mirrored here rather than
  // imported because this page has no bundler; the offsets are asserted against
  // the generated descriptor in the app by assertLaneMap.
  f32.set(req.rule, 0);
  f32[80 + 3] = req.mutationScale;   // sensor.w
  i32[88 + 2] = 1;                   // misc.z cohorts (int lane, unread here)
  f32[88 + 3] = req.mutationSeed;    // misc.w
  return buf;
}

async function main() {
  if (!navigator.gpu) { console.log('DERIVE_ERROR no navigator.gpu'); return; }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) { console.log('DERIVE_ERROR no adapter'); return; }
  const device = await adapter.requestDevice();
  device.addEventListener('uncapturederror', (e) => {
    console.log('DERIVE_ERROR ' + e.error.message);
  });

  const module = device.createShaderModule({ code: SOURCE });
  const info = await module.getCompilationInfo();
  const errs = info.messages.filter((m) => m.type === 'error');
  if (errs.length) {
    console.log('DERIVE_ERROR compile: ' + errs.map((m) => m.lineNum + ':' + m.message).join(' | '));
    return;
  }

  const pipeline = await device.createComputePipelineAsync({
    layout: 'auto', compute: { module, entryPoint: 'derive' },
  });

  const config = device.createBuffer({ size: STRIDE, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const result = device.createBuffer({ size: RULE_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: RULE_FLOATS * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: config } },
      { binding: 1, resource: { buffer: params } },
      { binding: 2, resource: { buffer: result } },
    ],
  });

  const out = [];
  for (const req of REQUESTS) {
    device.queue.writeBuffer(config, 0, packConfig(req));
    device.queue.writeBuffer(params, 0, new Float32Array([req.cohort, 0, 0, 0]));
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(1);
    pass.end();
    enc.copyBufferToBuffer(result, 0, readback, 0, RULE_FLOATS * 4);
    device.queue.submit([enc.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    out.push(Array.from(new Float32Array(readback.getMappedRange().slice(0))));
    readback.unmap();
  }
  console.log('DERIVE_OK ' + JSON.stringify(out));
}
main().catch((e) => console.log('DERIVE_ERROR ' + (e && e.message ? e.message : String(e))));
</script>`,
    'utf8',
  );

  let chrome = null;
  const cleanup = () => {
    try { chrome?.kill('SIGKILL'); } catch { /* gone */ }
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  try {
    // A REAL (headed) window: headless returns a null adapter. Same constraint
    // `browserCheck.mjs` documents, and the reason this is not a unit test.
    chrome = spawn(
      CHROME,
      [
        '--remote-debugging-port=0',
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,MediaRouter',
        '--enable-unsafe-webgpu',
        '--allow-file-access-from-files',
        '--window-size=480,320',
        `file://${pagePath.replace(/\\/g, '/')}`,
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
        if (m) { clearTimeout(timer); resolve(m[0]); }
      });
      chrome.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Chrome exited early (code ${code})`));
      });
    });

    const ws = new WebSocket(browserWs);
    await once(ws, 'open');

    let nextId = 1;
    const pending = new Map();
    let settle = null;
    const answered = new Promise((resolve) => { settle = resolve; });

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
        if (text.startsWith('DERIVE_OK ') || text.startsWith('DERIVE_ERROR ')) settle(text);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        settle(`DERIVE_ERROR ${d.exception?.description ?? d.text}`);
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
    if (page === undefined) throw new Error('Chrome opened no tab');

    const attach = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const sessionId = attach.result.sessionId;
    await send('Runtime.enable', {}, sessionId);
    await send('Page.enable', {}, sessionId);
    // Reload so Runtime.enable is in place before the page logs its answer --
    // the same ordering `browserCheck.mjs` needs.
    await send('Page.reload', { ignoreCache: true }, sessionId);

    const answer = await Promise.race([
      answered,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('the deriver page never answered')), opts.timeoutMs ?? 30000),
      ),
    ]);

    ws.close();
    if (answer.startsWith('DERIVE_ERROR ')) throw new Error(answer.slice('DERIVE_ERROR '.length));
    return JSON.parse(answer.slice('DERIVE_OK '.length));
  } finally {
    cleanup();
  }
}

// --- script mode ------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('-'));
  if (file === undefined) {
    console.error('deriveRules: no archive given.');
    process.exit(1);
  }
  const abs = path.resolve(ROOT, file);
  if (!existsSync(abs)) {
    console.error(`deriveRules: no such file: ${file}`);
    process.exit(1);
  }
  const archive = loadArchive(JSON.parse(readFileSync(abs, 'utf8')));
  const pending = selectionRequests(archive);
  console.error(`${pending.length} selection node(s) to derive.`);
  process.exit(0);
}
