/**
 * THE STRAFE FIELD'S BROWSER VERIFICATION, and specifically the Y flip.
 *
 * WHY THIS IS NOT `browserCheck.mjs --shot`. That tool's only lever is the URL;
 * it cannot synthesize input, and every assertion here needs a drag. So this
 * drives `Input.dispatchMouseEvent` over the same CDP session and reads pixels
 * back out of the rendered canvas.
 *
 * ## What it checks, and why it takes two passes over the same stroke
 *
 * The field is written by a pass that FLIPS v (`strafeDraw.wgsl` rasterizes into
 * a texture stored top-left-origin) and read by two consumers that do not:
 *
 *   - `frameAssembly.wgsl`'s overlay, which samples with the same unflipped
 *     canvas uv the mouse produced. THE OVERLAY PATH.
 *   - `entityUpdate.wgsl`'s `get_strafe_field`, which samples through
 *     `world_to_uv_bc` and displaces particles. THE PHYSICS PATH.
 *
 * If the flip is missing, THE OVERLAY STILL DRAWS THE STROKE WHERE YOU PAINTED
 * IT -- writer and reader are wrong in the same direction, so they cancel. Only
 * the physics disagrees. That is why checking the overlay alone would pass a
 * broken build, and why this runs both:
 *
 *   PASS 1 (paused, field overlay on): paint in ONE quadrant, screenshot, and
 *          assert the bright region is in that quadrant. Proves the mouse->field
 *          mapping and the overlay agree.
 *   PASS 2 (running, overlay off): paint the same stroke, let the simulation
 *          run, and assert the trails are EVACUATED in THE SAME quadrant,
 *          against a control run of the same length with no stroke. Proves the
 *          physics agrees with both.
 *   PASS 3 (paused, overlay on): erase one of two strokes and assert the OTHER
 *          survives. The survivor is the assertion -- a missing `discard` or a
 *          `loadOp: 'clear'` erases everything, and only an untouched stroke
 *          tells that apart from a working eraser.
 *
 * Pass 1 passing while pass 2 fails is exactly the missing flip.
 *
 * The quadrant is UPPER-LEFT rather than upper-centre so an x-mirror would show
 * too -- a y-only assertion would miss a transposed uv.
 *
 * ## USE hatmanv8, AND WHY THAT IS NOT INCIDENTAL
 *
 * Pass 2 measures WHERE the trails changed, which requires trails to be there in
 * the first place. `Starcrossedv8` concentrates into a small structure and
 * leaves most of the frame black -- against it, every quadrant statistic tried
 * here (mean luma, then fraction-empty) moved less than the run-to-run drift of
 * a chaotic simulation, and the pass reported noise in both directions.
 * hatmanv8's 64 cohorts spread across the whole canvas, so a stroke has
 * something to displace. Same reason the stroke is painted at 25-38% across
 * rather than in the corner.
 *
 * ## PASS 2 IS ADVISORY. IT DOES NOT FAIL THE RUN.
 *
 * Three different scalar proxies were tried for "the trails changed HERE" -- mean
 * luma, fraction-empty, and the largest empty square -- and all three moved less
 * than the run-to-run variation of a chaotic simulation. The last one separated
 * cleanly on one run (+7.0% vs 0.0%) and inverted on the next with no code
 * change between them. The quantity is real; a single number over a quadrant is
 * not a reliable way to read it.
 *
 * So pass 2 PRINTS its numbers and does not vote. The evidence for the physics
 * path is the SCREENSHOTS, which answer it instantly: run with `--keep-shots`
 * and compare `2-control` against `2-painted`. A correct build shows a clean
 * disc in the upper-left of the painted one and nothing there in the control.
 * That is what was actually used to verify the flip, and pretending a threshold
 * did it would be worse than saying so.
 *
 * Passes 1 and 3 DO vote, and they separate by two orders of magnitude
 * (+117 vs +0.06 on the overlay) because they measure a painted overlay rather
 * than an emergent simulation.
 *
 * Usage (from the repo root, with `npm run dev` running):
 *   node tools/fieldCheck.mjs
 *   node tools/fieldCheck.mjs --keep-shots ../field
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
const preset = flag('--preset', 'hatmanv8');

const userDataDir = mkdtempSync(path.join(tmpdir(), 'fluoddity-field-'));
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
    // hatmanv8, not the default -- see the header. Its 64 cohorts fill the
    // frame, which is what makes "the trails changed HERE" measurable at all.
    // `?nocalibrate`: this diffs screenshots pixel-for-pixel, and a world size
    // chosen from the runner's GPU speed would change what is being compared.
    `http://localhost:${port}/?nopanel&preset=${preset}&nocalibrate`,
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

const key = async (code, keyChar) => {
  for (const type of ['keyDown', 'keyUp']) {
    await send(
      'Input.dispatchKeyEvent',
      { type, code, key: keyChar, windowsVirtualKeyCode: keyChar.toUpperCase().charCodeAt(0) },
      sid,
    );
  }
  await sleep(120);
};

const mouse = async (type, x, y, button = 'left', buttons = 1) => {
  await send(
    'Input.dispatchMouseEvent',
    { type, x, y, button, buttons, clickCount: 1 },
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

/** Drag a short stroke inside the upper-left quadrant of the canvas. */
const paintUpperLeft = async (button = 'left') => {
  const buttons = button === 'left' ? 1 : 2;
  // Quadrant centre-ish: 30% across, 25% down. Asymmetric on BOTH axes so a
  // transpose or an x-mirror is as visible as a y-flip.
  const x0 = rect.x + rect.w * 0.25;
  const y0 = rect.y + rect.h * 0.18;
  const x1 = rect.x + rect.w * 0.38;
  const y1 = rect.y + rect.h * 0.3;

  await mouse('mousePressed', x0, y0, button, buttons);
  // Several moves, so the stroke is a real chain of segments rather than one
  // splat -- which is also what exercises `dist_to_stroke`.
  for (let i = 1; i <= 8; i++) {
    const t = i / 8;
    await mouse('mouseMoved', x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, button, buttons);
    await sleep(60);
  }
  await mouse('mouseReleased', x1, y1, button, buttons);
  await sleep(200);
};

/**
 * Mean luma per quadrant of a screenshot, as [UL, UR, LL, LR].
 *
 * Decoded in the page rather than in node: the browser already has a PNG
 * decoder, and shipping one here would be a dependency for four numbers.
 */
const quadrantLuma = async (b64) => {
  const out = await evaluate(`(async () => {
    const img = new Image();
    img.src = 'data:image/png;base64,${b64}';
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const hw = c.width >> 1, hh = c.height >> 1;
    const sum = [0, 0, 0, 0], n = [0, 0, 0, 0];
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const q = (y < hh ? 0 : 2) + (x < hw ? 0 : 1);
        const i = (y * c.width + x) * 4;
        sum[q] += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        n[q]++;
      }
    }
    return sum.map((s, i) => s / n[i]);
  })()`);
  return out;
};

/**
 * The largest empty SQUARE in each quadrant, as a fraction of the quadrant's
 * width. Returned as [UL, UR, LL, LR].
 *
 * THE MEASURE HAS TO BE ABOUT SHAPE, NOT ABOUT TOTALS. A painted field
 * evacuates the region it covers, so what appears is a clean void -- and that is
 * what the eye picks out of a screenshot instantly. But the two obvious scalar
 * proxies both failed here:
 *
 *   - MEAN LUMA barely moves, because a void replaces trails that were
 *     themselves mostly black, and it moves by less than the run-to-run drift
 *     of a chaotic simulation elsewhere in the frame.
 *   - FRACTION-EMPTY has no headroom: trails are thin bright lines, so every
 *     quadrant is already ~96-99% below any near-black threshold, painted or
 *     not.
 *
 * What distinguishes a void is that it is CONNECTED and LARGE. The largest
 * inscribed empty square captures exactly that and ignores how much total ink
 * there is, which is the quantity that drifts. Computed by the standard
 * maximal-square DP over a binary "is dark" mask -- O(pixels), one pass.
 */
const quadrantVoid = async (b64) => {
  return await evaluate(`(async () => {
    const img = new Image();
    img.src = 'data:image/png;base64,${b64}';
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const hw = c.width >> 1, hh = c.height >> 1;

    // Downsample 4x before the DP: a void is hundreds of pixels across, and a
    // single stray bright pixel should not split one. Max-pool, so any ink in a
    // 4x4 block marks the block occupied -- conservative in the right direction.
    const step = 4;
    const out = [];
    for (let q = 0; q < 4; q++) {
      const ox = (q & 1) ? hw : 0;
      const oy = (q < 2) ? 0 : hh;
      const w = Math.floor(hw / step), h = Math.floor(hh / step);
      const dark = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let ink = 0;
          for (let sy = 0; sy < step; sy++) {
            for (let sx = 0; sx < step; sx++) {
              const px = ox + x * step + sx, py = oy + y * step + sy;
              const i = (py * c.width + px) * 4;
              ink = Math.max(ink, d[i] + d[i + 1] + d[i + 2]);
            }
          }
          dark[y * w + x] = ink < 24 ? 1 : 0;
        }
      }
      // Maximal square of 1s.
      const dp = new Uint16Array(w * h);
      let best = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (dark[y * w + x] === 0) continue;
          const v = (x === 0 || y === 0)
            ? 1
            : 1 + Math.min(dp[(y - 1) * w + x], dp[y * w + x - 1], dp[(y - 1) * w + x - 1]);
          dp[y * w + x] = v;
          if (v > best) best = v;
        }
      }
      out.push((best * step) / hw);
    }
    return out;
  })()`);
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

const NAMES = ['upper-left', 'upper-right', 'lower-left', 'lower-right'];
const brightest = (q) => q.indexOf(Math.max(...q));
const show = (q) => q.map((v, i) => `${NAMES[i]}=${v.toFixed(2)}`).join('  ');

// ===========================================================================
// PASS 1 -- the overlay path
// ===========================================================================
console.log('PASS 1: the overlay path (paused, field overlay on)\n');

// Pause first, so the simulation cannot move the picture between the paint and
// the screenshot. Space is the pause hotkey; X toggles the panel, which
// ?nopanel already handled.
await key('Space', ' ');
// Field Opacity is a preference with no hotkey, so set it through the panel's
// absence -- localStorage is what `loadPreferences` reads, and a reload applies
// it. Reloading also clears the field, which is what we want before painting.
await evaluate(`(() => {
  const raw = localStorage.getItem('fluoddity.preferences');
  const p = raw ? JSON.parse(raw) : {};
  p.fieldOpacity = 1.0;
  p.fieldAlwaysShow = true;
  p.drawSize = 0.06;
  p.drawPower = 5.0;
  localStorage.setItem('fluoddity.preferences', JSON.stringify(p));
})()`);
await send('Page.reload', { ignoreCache: true }, sid);
await sleep(5000);
await key('Space', ' ');
// Tool 3 is DRAW (`MOUSE_MODES` order is the 1/2/3 key order).
await key('Digit3', '3');

const before1 = await quadrantLuma(await shoot('1-before'));
await paintUpperLeft();
const after1 = await quadrantLuma(await shoot('1-after'));

const delta1 = after1.map((v, i) => v - before1[i]);
console.log(`  before  ${show(before1)}`);
console.log(`  after   ${show(after1)}`);
console.log(`  delta   ${show(delta1)}\n`);

if (brightest(delta1) === 0 && delta1[0] > 0.5) {
  pass(`the overlay brightened in the upper-left (+${delta1[0].toFixed(2)})`);
} else {
  fail(
    `the overlay brightened most in the ${NAMES[brightest(delta1)]} ` +
      `(deltas: ${show(delta1)}). Expected upper-left -- the mouse->field ` +
      `mapping and the overlay disagree.`,
  );
}

// ===========================================================================
// PASS 2 -- the physics path
// ===========================================================================
console.log('\nPASS 2: the physics path (running, overlay off)\n');

// Overlay off, so what we measure is the TRAILS, not the field's own render.
// If the flip were wrong, pass 1 would still have passed and this is where it
// would show.
await evaluate(`(() => {
  const raw = localStorage.getItem('fluoddity.preferences');
  const p = raw ? JSON.parse(raw) : {};
  p.fieldOpacity = 0.0;
  p.fieldAlwaysShow = false;
  p.drawSize = 0.06;
  p.drawPower = 5.0;
  localStorage.setItem('fluoddity.preferences', JSON.stringify(p));
})()`);
await send('Page.reload', { ignoreCache: true }, sid);
await sleep(6000);

// MEASURED AGAINST A CONTROL RUN, NOT AGAINST THIS RUN'S OWN PAST.
//
// The first version of this compared before-paint to after-paint in each
// quadrant, and it did not work: the field EVACUATES the region it is painted
// in, so the disturbed quadrant gets DARKER, by an amount comparable to the
// drift of a chaotic simulation everywhere else. The sign is not reliable and
// the magnitude is not distinctive.
//
// What IS distinctive is the difference between two runs that saw the same
// number of frames and differed only in whether a stroke was painted. Same
// preset, same elapsed time, same startup transient -- so a quadrant that
// diverges between them diverged BECAUSE of the paint.
const settle = 7000;

await sleep(settle);
const control = await quadrantVoid(await shoot('2-control'));

// Reload to reset the simulation to the same starting point, then repeat the
// run WITH a stroke. The reload also clears the field, so the control above
// really was unpainted.
await send('Page.reload', { ignoreCache: true }, sid);
await sleep(6000);
await key('Digit3', '3');
// Paint repeatedly: one stroke's worth of field is a gentle nudge, and the
// difference has to clear the simulation's own run-to-run variation.
for (let i = 0; i < 6; i++) await paintUpperLeft();
await sleep(settle - 2000);

const painted2 = await quadrantVoid(await shoot('2-painted'));
// SIGNED, not absolute: the field can only OPEN a void, never close one. A
// quadrant whose void shrank is drift, not a stroke.
const delta2 = painted2.map((v, i) => v - control[i]);
console.log(`  control void  ${show(control)}`);
console.log(`  painted void  ${show(painted2)}`);
console.log(`  delta         ${show(delta2)}\n`);

// ADVISORY ONLY -- see the file header. This reports and does not vote, because
// no scalar proxy tried here separated reliably against a chaotic simulation.
const disturbed = delta2.indexOf(Math.max(...delta2));
const elsewhere = Math.max(...delta2.slice(1));
if (disturbed === 0 && delta2[0] > 0.05 && delta2[0] > elsewhere * 2) {
  console.log(
    `info  a void opened in the upper-left ` +
      `(+${(delta2[0] * 100).toFixed(1)}% of quadrant width vs ` +
      `${(elsewhere * 100).toFixed(1)}% elsewhere) -- consistent with a correct flip`,
  );
} else {
  console.log(
    `info  INCONCLUSIVE: largest new void was in the ${NAMES[disturbed]} ` +
      `(deltas: ${show(delta2)}).\n` +
      `      This measure is unreliable against a chaotic simulation and does ` +
      `not fail the run.\n` +
      `      To judge the physics path, run with --keep-shots and compare ` +
      `2-control against 2-painted:\n` +
      `      a correct build shows a clean disc in the upper-left of the ` +
      `painted one and none in the control.`,
  );
}

// ===========================================================================
// PASS 3 -- the eraser, and the half that matters
// ===========================================================================
console.log('\nPASS 3: the eraser (paused, overlay on)\n');

await evaluate(`(() => {
  const raw = localStorage.getItem('fluoddity.preferences');
  const p = raw ? JSON.parse(raw) : {};
  p.fieldOpacity = 1.0;
  p.fieldAlwaysShow = true;
  p.drawSize = 0.06;
  p.drawPower = 5.0;
  localStorage.setItem('fluoddity.preferences', JSON.stringify(p));
})()`);
await send('Page.reload', { ignoreCache: true }, sid);
await sleep(5000);
await key('Space', ' ');
await key('Digit3', '3');

// Paint in the upper-left AND the lower-right, so the erase below has both a
// target and a control. THE CONTROL IS THE POINT: a missing discard, or a
// loadOp of 'clear', erases everything -- and only an untouched region
// distinguishes that from a working eraser.
await paintUpperLeft();
const x0 = rect.x + rect.w * 0.7;
const y0 = rect.y + rect.h * 0.75;
await mouse('mousePressed', x0, y0, 'left', 1);
for (let i = 1; i <= 8; i++) {
  await mouse('mouseMoved', x0 + i * 6, y0 + i * 5, 'left', 1);
  await sleep(60);
}
await mouse('mouseReleased', x0 + 48, y0 + 40, 'left', 1);
await sleep(300);

const painted = await quadrantLuma(await shoot('3-painted'));
await paintUpperLeft('right');
const erased = await quadrantLuma(await shoot('3-erased'));

console.log(`  painted ${show(painted)}`);
console.log(`  erased  ${show(erased)}\n`);

const ulDrop = painted[0] - erased[0];
const lrDrop = painted[3] - erased[3];
if (ulDrop > 0.5) {
  pass(`the eraser removed the upper-left stroke (-${ulDrop.toFixed(2)})`);
} else {
  fail(`the eraser did not remove the upper-left stroke (delta ${ulDrop.toFixed(2)})`);
}
if (Math.abs(lrDrop) < Math.max(0.3, ulDrop * 0.25)) {
  pass(`the untouched lower-right stroke survived (delta ${lrDrop.toFixed(2)})`);
} else {
  fail(
    `the lower-right stroke was also removed (delta ${lrDrop.toFixed(2)}) -- ` +
      `a missing discard, or loadOp 'clear' on the erase pass.`,
  );
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
