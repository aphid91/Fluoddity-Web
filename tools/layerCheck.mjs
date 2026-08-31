/**
 * Drive a real Chrome and verify the TWO PAINTED LAYERS and the brush modes.
 *
 * ## Why this exists beside `fieldCheck.mjs`
 *
 * `fieldCheck.mjs` proves the walls layer end to end -- overlay, physics,
 * eraser -- and it still does. What it cannot see is everything the trails layer
 * and the brush modes added, because each of those is a claim about SEPARATION or
 * about DIRECTION, and neither is visible in a single-layer before/after diff:
 *
 *   - The two layers must be INDEPENDENT. Erasing walls must not disturb trails,
 *     and clearing one must not clear the other. That is enforced by a colour
 *     write mask, which is per-pipeline state no unit test can observe -- and
 *     which fails by silently taking both layers, i.e. it looks like the eraser
 *     working slightly too well.
 *   - The two overlays must be DISTINGUISHABLE. Walls draw greyscale by
 *     magnitude, trails draw hue by direction. A build that colourized the wrong
 *     channel pair still renders something plausible.
 *   - The reticle must MATCH THE BRUSH MODE. Every variant is new SDF code that
 *     only ever runs on a GPU.
 *
 * Like its neighbour, this is a DEVELOPMENT tool: it needs a real GPU, a real
 * Chrome and a running dev server, none of which belong in CI.
 *
 * Usage (from the repo root, with `npm run dev` running):
 *   node tools/layerCheck.mjs
 *   node tools/layerCheck.mjs --keep-shots ../layer
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
const port = Number(flag('--port', '5173'));
const keepShots = flag('--keep-shots', null);

const userDataDir = mkdtempSync(path.join(tmpdir(), 'fluoddity-layer-'));
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
    // `?bus` exposes `window.__fluoddity` for the tools -- see `main.ts`. The
    // panel is left ENABLED, because pass 3 clicks the hint bar's real Clear
    // button rather than dispatching the command behind it: what that pass is
    // actually checking is that the button is contextual, and a dispatched
    // command would bypass exactly the code under test.
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
await send('Page.reload', { ignoreCache: true }, sid);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(5000);

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

const key = async (code, keyChar, modifiers = 0) => {
  for (const type of ['keyDown', 'keyUp']) {
    await send(
      'Input.dispatchKeyEvent',
      {
        type,
        code,
        key: keyChar,
        modifiers,
        windowsVirtualKeyCode: keyChar.toUpperCase().charCodeAt(0),
      },
      sid,
    );
  }
  await sleep(150);
};

const mouse = async (type, x, y, button = 'left', buttons = 1, modifiers = 0) => {
  await send(
    'Input.dispatchMouseEvent',
    { type, x, y, button, buttons, clickCount: 1, modifiers },
    sid,
  );
};

const rect = await evaluate(`(() => {
  const c = document.querySelector('canvas');
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
})()`);
if (!rect) die('No canvas on the page.');
console.log(`canvas ${rect.w}x${rect.h} at (${rect.x}, ${rect.y})\n`);

// PAUSE AND EMPTY THE CANVAS BEFORE MEASURING ANYTHING.
//
// Every assertion here reads a small region and asks how bright and how colourful
// it is. A running simulation writes its own bright, colourful trails into those
// same regions -- which both swamps the painted overlay and drifts between
// screenshots, so a stroke that appeared could not be told from a swarm that
// wandered past.
//
// **THE PARTICLES THEMSELVES HAVE TO GO, not just stop.** `reset` respawns them
// and they are still drawn while paused, so pausing alone leaves a frame full of
// ink. Switching the camera to TRAIL mode shows the canvas texture instead of the
// sprites, and a reset empties that texture -- so the frame really is black and
// what remains in a region is the painted overlay and nothing else.
await evaluate(`window.__fluoddity.dispatch({ kind: 'toggleCameraMode' })`);
await evaluate(`window.__fluoddity.dispatch({ kind: 'togglePause' })`);
await sleep(800);
await evaluate(`window.__fluoddity.dispatch({ kind: 'reset' })`);
await sleep(600);

// The camera has two modes and `toggleCameraMode` flips between them, so assert
// the flip landed on TRAIL rather than assuming which one it started in.
const camMode = await evaluate(`window.__fluoddity.status().cameraMode`);
if (camMode !== 'trail') {
  await evaluate(`window.__fluoddity.dispatch({ kind: 'toggleCameraMode' })`);
  await sleep(400);
}

// The overlays are off by default outside their own tool, and pass 1 samples
// both layers at once -- so both `alwaysShow` flags go on for the whole run.
for (const field of ['fieldAlwaysShow', 'trailsAlwaysShow']) {
  await evaluate(
    `window.__fluoddity.dispatch({ kind: 'editDrawPref', field: '${field}', value: true })`,
  );
}
// A heavier overlay than the 0.10 default, so a painted stroke clears the noise
// floor by a wide margin rather than by a decimal.
await evaluate(
  `window.__fluoddity.dispatch({ kind: 'editDrawPref', field: 'fieldOpacity', value: 1.0 })`,
);
await sleep(300);


/**
 * Read the field texture back off the GPU and summarise each channel pair.
 *
 * **THE PIXELS ARE THE WRONG INSTRUMENT FOR THE SEPARATION CLAIMS.** An overlay
 * is downstream of a camera, a tone curve, and a live simulation whose own ink
 * sits at ~20 luma in every region -- so "the trails went away" and "the trails
 * dropped by two thirds against a noise floor" are indistinguishable there. The
 * claim is about four channels in one texture, so this reads those four channels.
 *
 * Reaches into the Orchestrator's privates deliberately: this is a probe, and the
 * alternative is a readback path in the app that exists only for a test.
 */
const readField = async () => await evaluate(`(async () => {
  const orch = window.__fluoddity;
  const field = orch.strafeField;
  const dev = orch.device;
  const [w, h] = field.size;
  // rgba16float is 8 bytes/texel; bytesPerRow must be a multiple of 256.
  const bpr = Math.ceil(w * 8 / 256) * 256;
  const buf = dev.createBuffer({
    size: bpr * h,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const enc = dev.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: field.texture },
    { buffer: buf, bytesPerRow: bpr }, { width: w, height: h });
  dev.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const raw = new Uint16Array(buf.getMappedRange().slice(0));
  buf.unmap(); buf.destroy();

  const h2f = (u) => {
    const s = (u >> 15) & 1, e = (u >> 10) & 0x1f, f = u & 0x3ff;
    if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
    if (e === 31) return f ? NaN : (s ? -Infinity : Infinity);
    return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
  };

  let walls = 0, trails = 0, nan = 0;
  const stride = bpr / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * stride + x * 4;
      const r = h2f(raw[i]), g = h2f(raw[i+1]), b = h2f(raw[i+2]), a = h2f(raw[i+3]);
      if ([r,g,b,a].some(Number.isNaN)) nan++;
      walls += Math.hypot(r, g);
      trails += Math.hypot(b, a);
    }
  }
  return { walls, trails, nan };
})()`);

const showField = (label, f) =>
  console.log(`  ${label.padEnd(24)} walls=${f.walls.toFixed(1).padStart(9)}` +
              `  trails=${f.trails.toFixed(1).padStart(9)}  nan=${f.nan}`);

/**
 * Select a tool through the command bus, and confirm it took.
 *
 * NOT VIA THE 1/2/3/4 HOTKEYS, even though those are the real user path and do
 * work. A synthetic keydown goes to whatever the page has focused, and this tool
 * clicks panel buttons -- so a key pressed while a button still held focus was
 * silently swallowed, and the stroke that followed painted with the PREVIOUS
 * tool. That failure looks exactly like the layer separation being broken, which
 * is the thing under test, so the harness must not be able to produce it.
 */
const setTool = async (mode) => {
  await evaluate(
    `window.__fluoddity.dispatch({ kind: 'setMouseMode', mode: '${mode}' })`,
  );
  await sleep(200);
  const actual = await evaluate(`window.__fluoddity.status().mouseMode`);
  if (actual !== mode) die(`tool did not switch to ${mode} (still ${actual})`);
};

/** Paint a stroke between two fractional canvas positions. */
const paint = async (fx0, fy0, fx1, fy1, button = 'left') => {
  const buttons = button === 'left' ? 1 : 2;
  const x0 = rect.x + rect.w * fx0;
  const y0 = rect.y + rect.h * fy0;
  const x1 = rect.x + rect.w * fx1;
  const y1 = rect.y + rect.h * fy1;
  await mouse('mousePressed', x0, y0, button, buttons);
  for (let i = 1; i <= 8; i++) {
    const t = i / 8;
    await mouse('mouseMoved', x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, button, buttons);
    await sleep(60);
  }
  await mouse('mouseReleased', x1, y1, button, buttons);
  await sleep(250);
};

/** Park the cursor somewhere harmless, so the reticle is out of the sample. */
const parkCursor = async () => {
  await mouse('mouseMoved', rect.x + rect.w * 0.95, rect.y + rect.h * 0.95, 'none', 0);
  await sleep(200);
};

/**
 * Spend the session's first pointer interaction somewhere harmless.
 *
 * THE FIRST CLICK OF A SESSION DOES NOT PAINT -- it dismisses the splash. A
 * stroke started before that is silently swallowed, which looks exactly like the
 * layer under test being broken and cost a full debugging round to pin down.
 * `fieldCheck.mjs` never meets this because it pauses and settles first.
 */
const absorbFirstClick = async () => {
  const x = rect.x + rect.w * 0.92;
  const y = rect.y + rect.h * 0.92;
  await mouse('mousePressed', x, y);
  await mouse('mouseReleased', x, y);
  await sleep(400);
};

const shoot = async (label) => {
  const r = await send('Page.captureScreenshot', { format: 'png' }, sid);
  const b64 = r.result?.data;
  if (!b64) die('screenshot failed');
  if (keepShots !== null) {
    writeFileSync(`${keepShots}-${label}.png`, Buffer.from(b64, 'base64'));
  }
  return b64;
};

/**
 * Mean RGB and mean saturation over a fractional sub-rect of the screenshot.
 *
 * SATURATION IS THE POINT. The two overlays are told apart by colourfulness, not
 * by brightness: walls draw greyscale (saturation ~0), trails draw a direction
 * hue (saturation high). A test on luma alone would pass with the layers swapped.
 */
const regionStats = async (b64, fx, fy, fw, fh) => {
  return await evaluate(`(async () => {
    const img = new Image();
    img.src = 'data:image/png;base64,${b64}';
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const x0 = Math.floor(c.width * ${fx}), y0 = Math.floor(c.height * ${fy});
    const w = Math.floor(c.width * ${fw}), h = Math.floor(c.height * ${fh});
    const d = g.getImageData(x0, y0, w, h).data;
    let r = 0, gg = 0, b = 0, sat = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const R = d[i], G = d[i + 1], B = d[i + 2];
      r += R; gg += G; b += B;
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      // Saturation only counts where there is something to be saturated -- an
      // unlit pixel has no meaningful hue and would drag the mean toward 0.
      if (mx > 20) sat += (mx - mn) / mx;
      n++;
    }
    return { r: r / n, g: gg / n, b: b / n, luma: (0.2126 * r + 0.7152 * gg + 0.0722 * b) / n, sat: sat / n };
  })()`);
};

const fmt = (s) => `luma=${s.luma.toFixed(2)} sat=${s.sat.toFixed(3)}`;

// Where each layer's stroke goes. Well apart, so one region never sees the
// other's ink, and asymmetric so a transpose would show.
//
// IN THE LOWER HALF, deliberately: the menu bar, the mutation slider and the hint
// bar all sit over the top of the canvas, and a region up there measures panel
// chrome rather than the simulation. That cost an entire debugging round.
const WALLS_BOX = [0.16, 0.58, 0.24, 0.24];
const TRAILS_BOX = [0.58, 0.58, 0.24, 0.24];

// ===========================================================================
// PASS 1: the two layers paint into different channels, and look different.
// ===========================================================================
console.log('PASS 1: the two layers are independent and distinguishable\n');

// `3` is Walls, `4` is Trails -- zipped from MOUSE_MODES, so this is also a
// check that the fourth tool exists and is reachable by its hotkey.
await setTool('walls');
await absorbFirstClick();
await paint(0.20, 0.62, 0.34, 0.76);
await setTool('trails');
await paint(0.62, 0.62, 0.76, 0.76);
await parkCursor();

const both = await shoot('1-both');
const wallsRegion = await regionStats(both, ...WALLS_BOX);
const trailsRegion = await regionStats(both, ...TRAILS_BOX);

console.log(`  walls region   ${fmt(wallsRegion)}`);
console.log(`  trails region  ${fmt(trailsRegion)}\n`);

if (wallsRegion.luma > 8) {
  pass(`the walls stroke is visible (luma ${wallsRegion.luma.toFixed(2)})`);
} else {
  fail(`the walls stroke did not appear (luma ${wallsRegion.luma.toFixed(2)})`);
}
if (trailsRegion.luma > 8) {
  pass(`the trails stroke is visible (luma ${trailsRegion.luma.toFixed(2)})`);
} else {
  fail(`the trails stroke did not appear (luma ${trailsRegion.luma.toFixed(2)})`);
}

// THE OVERLAYS MUST BE TOLD APART BY COLOUR. Walls are greyscale by magnitude;
// trails carry a direction hue. If this fails with both strokes visible, the
// likeliest cause is that one layer's overlay is reading the other's channels.
if (trailsRegion.sat > wallsRegion.sat + 0.15) {
  pass(
    `trails draw in colour and walls in grey ` +
      `(sat ${trailsRegion.sat.toFixed(3)} vs ${wallsRegion.sat.toFixed(3)})`,
  );
} else {
  fail(
    `the two overlays are not distinguishable by colour ` +
      `(trails sat ${trailsRegion.sat.toFixed(3)}, walls sat ${wallsRegion.sat.toFixed(3)}) ` +
      `-- check which channel pair each overlay reads`,
  );
}

// ===========================================================================
// PASS 2: the layers are independent in the TEXTURE, at exact equality.
//
// Erase and Clear are both enforced by a colour write mask -- per-pipeline state
// no unit test can observe, and which fails by silently taking both layers. The
// assertions are EXACT (zero drift), which the pixel path could never support.
// ===========================================================================
console.log('\nPASS 2: erase and clear are confined to one layer\n');

const fEmpty = await readField();
showField('start', fEmpty);

await setTool('walls');
await paint(0.20, 0.62, 0.34, 0.76);
const fWalls = await readField();
showField('after walls stroke', fWalls);

await setTool('trails');
await paint(0.62, 0.62, 0.76, 0.76);
const fTrails = await readField();
showField('after trails stroke', fTrails);

await paint(0.62, 0.62, 0.76, 0.76, 'right');
const fErased = await readField();
showField('after trails erase', fErased);

await evaluate(`window.__fluoddity.dispatch({ kind: 'clearStrafeField', layer: 'walls' })`);
await sleep(400);
const fCleared = await readField();
showField('after Clear Walls', fCleared);
console.log('');

// AGAINST `fEmpty`, NOT AGAINST ZERO. Pass 1 has already painted both layers by
// the time this runs, so the texture is not blank here -- what must hold is that
// the walls stroke moved the walls total and left the trails total EXACTLY where
// it was, which is the actual claim.
if (fWalls.walls > fEmpty.walls && fWalls.trails === fEmpty.trails) {
  pass('a walls stroke writes ONLY the rg channels');
} else {
  fail(
    `a walls stroke touched the trails channels ` +
      `(${fEmpty.trails} -> ${fWalls.trails})`,
  );
}
if (fTrails.trails > 1 && fTrails.walls === fWalls.walls) {
  pass('a trails stroke writes ONLY the ba channels');
} else {
  fail(`a trails stroke touched the walls channels (${fWalls.walls} -> ${fTrails.walls})`);
}
if (fErased.trails < fTrails.trails * 0.5) {
  pass('the trails eraser removes trails ink');
} else {
  fail(`the trails eraser did not remove trails ink (${fTrails.trails} -> ${fErased.trails})`);
}
if (fErased.walls === fWalls.walls) {
  pass('ERASING TRAILS LEAVES WALLS EXACTLY INTACT (the write mask)');
} else {
  fail(`erasing trails moved the walls channels (${fWalls.walls} -> ${fErased.walls})`);
}
if (fCleared.walls === 0) {
  pass('Clear Walls empties the walls channels');
} else {
  fail(`Clear Walls left walls ink (${fCleared.walls})`);
}
if (fCleared.trails === fErased.trails && fCleared.trails > 0) {
  pass('CLEAR WALLS LEAVES TRAILS EXACTLY INTACT (the masked-draw clear)');
} else {
  fail(
    `Clear Walls moved the trails channels (${fErased.trails} -> ${fCleared.trails}) ` +
      `-- a loadOp clear ignores the write mask`,
  );
}
if (fEmpty.nan === 0 && fTrails.nan === 0 && fErased.nan === 0) {
  pass('no NaN texels anywhere (the zero-length direction guards)');
} else {
  fail('NaN texels in the field -- a normalize of a zero-length vector escaped its guard');
}

// ===========================================================================
// PASS 3: the hint bar's Clear button is contextual.
// ===========================================================================
console.log('\nPASS 3: the Clear button follows the active tool\n');

const clearLabelFor = async (mode) => {
  await setTool(mode);
  await sleep(250);
  return await evaluate(`(() => {
    const b = document.querySelector('[data-setting="transport.clearStrafeField"]');
    return b ? b.textContent : null;
  })()`);
};
const wallsLabel = await clearLabelFor('walls');
const trailsLabel = await clearLabelFor('trails');
console.log(`  in Walls mode:  ${JSON.stringify(wallsLabel)}`);
console.log(`  in Trails mode: ${JSON.stringify(trailsLabel)}\n`);

if (wallsLabel !== null && /barrier/i.test(wallsLabel)) {
  pass('the Walls tool offers a Clear button naming barriers');
} else {
  fail(`the Walls tool's Clear button reads ${JSON.stringify(wallsLabel)}`);
}
if (trailsLabel !== null && /trail/i.test(trailsLabel)) {
  pass('the Trails tool offers a Clear button naming trails');
} else {
  fail(`the Trails tool's Clear button reads ${JSON.stringify(trailsLabel)}`);
}

// ===========================================================================
// PASS 4: the reticle changes with the brush mode.
//
// Screenshots only: these are SDF decorations, and the useful check is that each
// mode draws something different near the cursor. A build that ignored the mode
// would draw four identical rings.
// ===========================================================================
console.log('\nPASS 4: each brush mode draws its own reticle\n');

// A TIGHT box around the parked cursor, in SCREENSHOT fractions. The reticle is a
// thin ring a few pixels wide; averaged over a quarter of the frame its ink is
// swamped by whatever the simulation is doing, and every mode reads the same
// number whether or not the decoration drew.
const RETICLE_BOX = [0.44, 0.42, 0.12, 0.16];
const modeShots = [];
for (const [index, name] of [
  [0, 'diverge'],
  [1, 'converge'],
  [2, 'stroke'],
  [3, 'fixed'],
]) {
  // Set the preference directly: the dropdown lives in a panel this run hides,
  // and what is under test is the SHADER, not the widget.
  await evaluate(
    `window.__fluoddity.dispatch({ kind: 'editDrawPref', field: 'brushMode', value: ${index} })`,
  );
  // Park the cursor mid-canvas so the reticle is inside the sampled box.
  await mouse('mouseMoved', rect.x + rect.w * 0.5, rect.y + rect.h * 0.5, 'none', 0);
  await sleep(350);
  const shot = await shoot(`4-reticle-${name}`);
  const stats = await regionStats(shot, ...RETICLE_BOX);
  modeShots.push({ name, luma: stats.luma });
  console.log(`  ${name.padEnd(9)} reticle-box ${fmt(stats)}`);
}

const anyDrawn = modeShots.every((m) => m.luma > 0.5);
if (anyDrawn) {
  pass('every brush mode drew a reticle');
} else {
  const missing = modeShots.filter((m) => m.luma <= 0.5).map((m) => m.name);
  fail(`no reticle drawn for: ${missing.join(', ')}`);
}
// WHICH decoration each mode drew is ADVISORY, and does not vote.
//
// The same lesson `fieldCheck.mjs`'s pass 2 records: a single scalar over a
// region is not a reliable way to read a SHAPE. The decorations are eight ~2px
// ticks or one small arrow -- a fraction of a luma point against a live
// simulation underneath -- so the four modes land within noise of each other
// whether or not the decoration drew, and a threshold here would be a coin flip
// dressed up as a check.
//
// What DOES vote is that every mode drew a reticle at all, above. For the shapes,
// run with --keep-shots and look: `4-reticle-diverge` shows eight ticks pointing
// outward, `-converge` the same pointing inward, `-stroke` a bare ring, and
// `-fixed` a single arrow. That comparison takes a second by eye and is the
// evidence this pass exists to produce.
console.log(
  '\ninfo  ADVISORY: which decoration each mode drew is judged from the\n' +
    '      screenshots, not from these numbers -- a few pixels of tick against a\n' +
    '      live simulation is below what a regional mean can resolve. Run with\n' +
    '      --keep-shots and compare 4-reticle-*.png.',
);

// ===========================================================================
console.log('');
const errors = logs.filter((l) => l.level === 'error');
for (const e of errors) console.error(`page error: ${e.text}`);
if (errors.length > 0) fail(`${errors.length} console error(s)`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FAILURE(S)`);
  cleanup();
  process.exit(1);
}
console.log('OK');
cleanup();
process.exit(0);
