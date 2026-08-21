/**
 * THE FPS COUNTER'S BROWSER VERIFICATION.
 *
 * WHY THIS IS NOT `npm test`. The band arithmetic is pure and is unit-tested in
 * `src/perf/fpsBand.test.ts`; what cannot be tested there is everything that
 * needs a real GPU and a real frame loop -- whether the probe ever produces a
 * reading at all, whether the badge survives `X`, whether the click reaches the
 * Preferences tab, and whether the three labels actually get tinted. A DOM-less
 * runner can answer none of those.
 *
 * WHY IT IS NOT `uiCheck.mjs`. That tool asserts the gated latch and focus
 * release, and its passes are built around synthesized DRAGS. This one is about
 * a widget outside both panes whose value comes from the GPU, so it shares the
 * CDP plumbing and none of the subject matter.
 *
 * ## What it checks
 *
 *   PASS 1  THE BADGE EXISTS AND SAYS SOMETHING. The counter must be on screen
 *           with a readout matching the shapes `readoutFor` can produce. This is
 *           the end-to-end assertion that the probe produced a reading at all --
 *           if `onSubmittedWorkDone` never resolved, the warmup would never
 *           finish and this is what would catch it.
 *
 *   PASS 2  IT SURVIVES `X`. The badge is deliberately NOT hidden with the
 *           panels, because it is the route back to the settings it reports on
 *           and the panels start hidden. A regression here is invisible in any
 *           screenshot taken with the panels open, which is most of them.
 *
 *   PASS 3  THE CLICK REVEALS THE PANELS AND SELECTS PREFERENCES. The whole
 *           point of the button. Asserted from a HIDDEN start, which is the
 *           app's default state and the case that actually matters.
 *
 *   PASS 4  THE THREE LABELS ARE TINTED, and the Motion Blur CHECKBOX is not.
 *           That exclusion is a deliberate requirement, and it is the kind of
 *           thing that silently regresses when `labelOf` meets a new Tweakpane
 *           version.
 *
 *   PASS 5  THE PREFERENCE TURNS IT OFF, and clears the tint with it.
 *
 * Usage (from the repo root, with `npm run dev` running):
 *   node tools/fpsCheck.mjs
 *   node tools/fpsCheck.mjs --port 5174
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

const userDataDir = mkdtempSync(path.join(tmpdir(), 'fluoddity-fps-'));
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
    // `?nocalibrate` because calibration reshapes the simulation repeatedly and
    // restarts the counter's window each time it does -- the run would spend its
    // whole budget in warmup.
    //
    // **`?nosplash` IS LOAD-BEARING HERE, not tidiness.** The splash PAUSES the
    // simulation while it is up (`Panel`'s `onVisibilityChange`), and a paused
    // frame is deliberately never sampled -- so without this the probe would
    // collect nothing for as long as the splash stood, the warmup would never
    // finish, and every assertion below would fail against an empty badge. That
    // is exactly how this check failed the first time it was run.
    //
    // NO `?preset`: an unknown name is not an error, it warns and opens the
    // first preset instead, which made an earlier version of this run look like
    // a product bug. The default preset is what a user sees anyway.
    `http://localhost:${port}/?bus&nocalibrate&nosplash`,
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

// **THE WARMUP IS 90 FRAMES**, plus the probe's own half-window before it
// publishes anything, plus the band's 3s dwell before it can leave green. At 60
// fps that is comfortably under ten seconds; this waits longer than it needs to
// because the alternative -- a run that fails on a slow machine for timing
// reasons -- reads as a product bug.
await sleep(14000);

const FPS = '[data-setting="transport.fps"]';

// --- PASS 1: the badge exists and carries a readout -------------------------
//
// The regex is `readoutFor`'s full range: a number, or 60 with one to three
// plus marks. Anything else means the two have drifted apart.
const readout = await evaluate(`(() => {
  const e = document.querySelector('${FPS}');
  if (!e) return null;
  return { text: e.textContent, color: e.style.color, title: e.title };
})()`);

if (readout === null) {
  fail('the FPS counter is not in the document at all');
} else if (!/^(\d+|60\+{1,3})$/.test(readout.text)) {
  fail(`the readout "${readout.text}" is not a shape readoutFor can produce`);
} else if (readout.color === '') {
  fail('the readout has no band colour');
} else if (!/GPU|demanding/i.test(readout.title)) {
  fail(`the tooltip does not look like a band tooltip: "${readout.title}"`);
} else {
  pass(`the badge reads "${readout.text}" in ${readout.color}`);
}

// --- PASS 2: it survives the panels being hidden ----------------------------
//
// THE POINT OF THE WIDGET. Hiding the panels must not take the badge with it,
// because the badge is the way back to them -- and the panels START hidden
// (`startHidden: true` in `main.ts`), which is what this asserts against.
//
// **NOT `offsetParent`, and that is not a shortcut.** `uiCheck.mjs` uses
// `offsetParent === null` as its ancestor-hidden test, which is right for a
// blade inside a pane and WRONG here: `offsetParent` is null for ANY
// `position:fixed` element regardless of visibility, and the badge is fixed to
// the top-right corner. Copying that helper reported the badge as hidden while
// it was plainly on screen. `getBoundingClientRect` is the test that actually
// distinguishes the two -- a hidden element has no box.
//
// The panels are hidden HERE by driving the same route the gear and the menu
// item use, rather than by synthesizing `X`: CDP key events do not reliably
// reach a page whose focus the automation never established, so a failure would
// be ambiguous between "the badge vanished" and "the keystroke never arrived".
// `uiCheck.mjs` PASS 6 is where the key binding itself is covered.
const beforeToggle = await evaluate(`(() => {
  const panel = document.getElementById('fluoddity-panel-right');
  return getComputedStyle(panel).display === 'none' ? 'hidden' : 'shown';
})()`);

// The gear on the mutation bar is the on-screen route to the same `setHidden`.
// If the panels already start hidden -- which is the default -- there is
// nothing to toggle and the assertion below still holds.
if (beforeToggle === 'shown') {
  await evaluate(
    `document.querySelector('[data-setting="transport.toggleUi"]')?.click()`,
  );
  await sleep(400);
}

const afterHide = await evaluate(`(() => {
  const e = document.querySelector('${FPS}');
  if (!e) return 'absent';
  if (getComputedStyle(e).display === 'none') return 'hidden';
  // A fixed element has a real box when visible and a zero-sized one when not.
  const r = e.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return 'hidden';
  const panel = document.getElementById('fluoddity-panel-right');
  return getComputedStyle(panel).display === 'none'
    ? 'shown-panels-hidden'
    : 'shown-panels-shown';
})()`);

if (afterHide === 'shown-panels-hidden') {
  pass('the badge stays on screen while the panels are hidden');
} else if (afterHide === 'shown-panels-shown') {
  fail('the panels never hid -- this pass proves nothing');
} else {
  fail(`the badge went away with the panels (${afterHide}); it must outlive them`);
}

// --- PASS 3: the click reveals the panels and selects Preferences -----------
//
// From the HIDDEN state left by PASS 2, which is the app's default and the case
// that matters: a click that only worked with the panels already open would be
// useless in exactly the situation the button exists for.
const box = await evaluate(`(() => {
  const e = document.querySelector('${FPS}');
  const r = e.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`);

for (const type of ['mousePressed', 'mouseReleased']) {
  await send(
    'Input.dispatchMouseEvent',
    { type, x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 },
    sid,
  );
}
await sleep(500);

const afterClick = await evaluate(`(() => {
  const panel = document.getElementById('fluoddity-panel-right');
  const shown = getComputedStyle(panel).display !== 'none';
  const prefs = document.querySelector('[data-section="preferences"]');
  const prefsShown = prefs !== null && getComputedStyle(prefs).display !== 'none';
  // The three tinted controls must be REACHABLE, not merely present: a tab that
  // is displayed but whose contents are inside a collapsed folder is not what
  // this click promised.
  const world = document.querySelector('[data-setting="prefs.worldSize"]');
  return { shown, prefsShown, worldReachable: world !== null && world.offsetParent !== null };
})()`);

if (afterClick.shown && afterClick.prefsShown && afterClick.worldReachable) {
  pass('clicking the badge reveals the panels with Preferences in front');
} else {
  fail(
    'the click did not bring up the performance settings: ' +
      JSON.stringify(afterClick),
  );
}

// --- PASS 4: the three labels are tinted, the checkbox is not ---------------
//
// The tint is applied by `perfLabels.ts` through `data-setting`, and the label
// element inside a blade is found structurally -- so this is where a Tweakpane
// internals change would show up. It fails soft in the app (no tint), which is
// precisely why it needs an assertion here rather than a crash to announce it.
// The label is a DIRECT CHILD of the blade (`tp-lblv_l` beside `tp-lblv_v`),
// not nested in a row -- walking a presumed row's children finds nothing, which
// is the bug this pass caught on its first run. Deliberately re-derived here
// rather than importing `labelOf`: a check that shared the app's own traversal
// would agree with it even when both are wrong.
const tint = await evaluate(`(() => {
  const seen = {};
  for (const key of ['prefs.worldSize','prefs.physicsSteps','prefs.motionBlurSamples']) {
    const colors = [];
    for (const blade of document.querySelectorAll('[data-setting="' + key + '"]')) {
      const input = blade.querySelector('input');
      const isCheckbox = input !== null && input.type === 'checkbox';
      for (const cell of blade.children) {
        if (cell.querySelector('input,select,button')) continue;
        if (!(cell.textContent ?? '').trim()) continue;
        colors.push({ checkbox: isCheckbox, color: cell.style.color, text: cell.textContent.trim() });
        break;
      }
    }
    seen[key] = colors;
  }
  return seen;
})()`);

// Every non-checkbox label among the three must carry an inline colour. The
// Motion Blur checkbox, if it is the blade currently showing, must not.
let tinted = 0;
let checkboxTinted = false;
for (const [key, cells] of Object.entries(tint)) {
  for (const cell of cells) {
    if (cell.checkbox) {
      if (cell.color !== '') checkboxTinted = true;
      continue;
    }
    if (cell.color !== '') tinted++;
    else fail(`${key}'s label carries no tint`);
  }
}

if (checkboxTinted) {
  fail('the Motion Blur CHECKBOX was tinted; only its slider label should be');
} else if (tinted >= 2) {
  // Two rather than three: Motion Blur is GATED, so at one sample its slider is
  // folded away and only the checkbox is on screen -- which is the default. The
  // other two are always sliders.
  pass(`${tinted} performance labels are tinted, and the checkbox is not`);
} else {
  fail(`only ${tinted} labels were tinted; expected at least 2`);
}

// --- PASS 5: the preference turns it off, and clears the tint --------------
//
// **BY CLICKING THE REAL CHECKBOX**, not by dispatching a synthesized command.
// `editSetting` carries a whole `Setting` from the registry, and a hand-built
// stand-in would be asserting against a shape this run invented rather than the
// one the app uses -- it would keep passing after a registry change that broke
// the actual control. The checkbox is also the only thing a user can press.
// **THE PANELS MUST BE OPEN FIRST**, and PASS 2 may have left them shut. A
// `.click()` on an input inside a `display:none` container does not reach
// Tweakpane's handler, so the preference never moves and the badge -- correctly
// -- stays visible. That failure reads exactly like a product bug and is not
// one; it cost a debugging pass. PASS 3 already established that clicking the
// badge opens the panels, so this reuses it rather than assuming a state.
await evaluate(`(() => {
  const panel = document.getElementById('fluoddity-panel-right');
  if (getComputedStyle(panel).display === 'none') {
    document.querySelector('${FPS}').click();
  }
})()`);
await sleep(600);

const toggled = await evaluate(`(() => {
  const blade = document.querySelector('[data-setting="prefs.showFpsCounter"]');
  if (!blade) return 'absent';
  if (blade.offsetParent === null) return 'not reachable -- panel still shut';
  blade.scrollIntoView({ block: 'center' });
  const input = blade.querySelector('input[type=checkbox]');
  if (!input) return 'no checkbox';
  input.click();
  return 'clicked';
})()`);
if (toggled !== 'clicked') {
  fail(`could not reach the Show FPS Counter checkbox (${toggled})`);
}
await sleep(800);

const afterOff = await evaluate(`(() => {
  const e = document.querySelector('${FPS}');
  const hidden = e === null || getComputedStyle(e).display === 'none';
  const world = document.querySelector('[data-setting="prefs.worldSize"]');
  let label = '';
  if (world) {
    for (const cell of world.children) {
      if (cell.querySelector('input,select,button')) continue;
      if (!(cell.textContent ?? '').trim()) continue;
      label = cell.style.color;
      break;
    }
  }
  return { hidden, label };
})()`);

if (!afterOff.hidden) {
  fail('turning off Show FPS Counter left the badge on screen');
} else if (afterOff.label === '' || /232/.test(afterOff.label)) {
  pass('the preference hides the badge and clears the label tint');
} else {
  fail(`the badge hid but the label kept its tint (${afterOff.label})`);
}

// --- console errors ---------------------------------------------------------
//
// A WebGPU validation error or an uncaught exception would otherwise pass
// silently: every assertion above reads the DOM, and a broken frame loop still
// leaves the last-painted DOM in place.
const relevant = errors.filter((e) => !/favicon/i.test(e));
if (relevant.length > 0) {
  fail(`console errors during the run:\n  ${relevant.join('\n  ')}`);
} else {
  pass('no console errors');
}

cleanup();
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll FPS counter checks passed.');
process.exit(0);
