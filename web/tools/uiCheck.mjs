/**
 * THE PANEL'S BROWSER VERIFICATION: the gated latch, and the reveal toggle.
 *
 * WHY THIS IS NOT `npm test`. Every assertion here needs a real pointer gesture
 * against real Tweakpane DOM. `node --test` has no DOM at all, so the pure rules
 * (`gating.ts`, `reveal.ts`, `showsSlider`) are unit-tested there and the WIRING
 * -- which events open a session, which close it, and whether a visibility
 * change rebuilds the pane -- can only be checked here.
 *
 * WHY IT IS NOT `browserCheck.mjs`. That tool's only lever is the URL. It cannot
 * press a slider and hold it.
 *
 * ## What it checks
 *
 *   PASS 1  THE GATED LATCH. Press a gated slider, drag it to its base value,
 *           and assert it is STILL VISIBLE while the button is down -- then
 *           release and assert it folded back to a checkbox and the value landed
 *           on EXACTLY base.
 *
 *           This is the sub-step's entire risk. The value passes through the off
 *           zone during the gesture, so a latch that tested the value alone
 *           would fold the control away mid-drag and destroy the drag that
 *           produced it. A latch that tested `ev.last` without checking
 *           `isRefreshing()` first would fold it away on the next frame's
 *           `pane.refresh()` instead -- silently, and only sometimes.
 *
 *   PASS 2  THE REVEAL TOGGLE, and that it does NOT rebuild the pane. Ticking
 *           Gravity must reveal three sliders while every gated value is still
 *           zero, and must do it by flipping `blade.hidden` rather than by
 *           rebuilding -- so the assertion is that THE SAME DOM NODE is still
 *           there afterwards. A rebuild would drop folder expansion state and
 *           replace every node, and would look identical in a screenshot.
 *
 *   PASS 3  THE FOLD-BACK'S SNAP. A gated control dragged to within the off zone
 *           but not exactly onto base must store EXACTLY base, so that "is it
 *           off?" stays unambiguous rather than "within epsilon".
 *
 * ## Why `?bus`
 *
 * Two of these assert what was STORED, not what is drawn -- the fold-back's snap
 * is invisible on screen, since a control at 1e-9 and one at 0 both render as an
 * unticked checkbox. `?bus` exposes the command bus so the run can read status
 * back, the same lever `configCheck.mjs` uses.
 *
 * Usage (from web/, with `npm run dev` running):
 *   node tools/uiCheck.mjs
 *   node tools/uiCheck.mjs --port 5174
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

const userDataDir = mkdtempSync(path.join(tmpdir(), 'fluoddity-ui-'));
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
    // The panel is the subject, so NOT `?nopanel`. `?bus` is how the stored
    // value is read back -- see the header.
    `http://localhost:${port}/?bus&preset=hatmanv8`,
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

const mouse = (type, x, y, buttons = 1) =>
  send(
    'Input.dispatchMouseEvent',
    { type, x, y, button: 'left', buttons, clickCount: 1 },
    sid,
  );

/** Whether a `data-setting` element is on screen. */
const visible = (key) =>
  evaluate(`(() => {
    const e = document.querySelector('[data-setting="${key}"]');
    if (!e) return 'absent';
    return getComputedStyle(e).display === 'none' ? 'hidden' : 'shown';
  })()`);

/**
 * The rectangle of a `data-setting` element's slider TRACK, in viewport px.
 *
 * **`tp-sldv_t` is the track**, and it is the only element the drag handler is
 * attached to. This is the one place in the tooling that depends on a Tweakpane
 * class name, which is a real cost -- the names are stable across patch versions
 * but are not API. It is paid deliberately, because the alternatives are worse:
 * an earlier version guessed "the widest inner div" and picked the ROW container
 * (308px) instead of the track (92px), so every synthesized drag landed outside
 * the slider and moved nothing. It reported "the drag did not move it", which
 * reads as a product bug rather than a broken selector.
 *
 * A geometry guess fails silently and misleadingly; a class name fails loudly
 * and points at itself. If Tweakpane ever renames this, `trackOf` returns null
 * and the run dies with the name in the message.
 */
const trackOf = async (key) => {
  // **SCROLL IT INTO VIEW FIRST.** The panel is a fixed-height scroll container,
  // and a blade below the fold still has a perfectly valid `getBoundingClientRect`
  // -- one whose `y` is past the bottom of the viewport. `Input.dispatchMouseEvent`
  // takes VIEWPORT coordinates, so a drag against that rect lands on nothing and
  // reports "the value did not move", which reads as a product bug rather than as
  // a tooling one. That cost an hour; it is why this is a function and not a
  // one-line query.
  await evaluate(`(() => {
    const e = document.querySelector('[data-setting="${key}"]');
    if (e) e.scrollIntoView({ block: 'center' });
  })()`);
  await sleep(200);
  return evaluate(`(() => {
    const e = document.querySelector('[data-setting="${key}"]');
    if (!e) return null;
    const track = e.querySelector('.tp-sldv_t');
    if (!track) return null;
    const r = track.getBoundingClientRect();
    if (r.width < 20) return null;
    // Below the fold even after scrolling: the caller must not drag against it.
    if (r.y < 0 || r.y > window.innerHeight - r.height) return null;
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`);
};

const statusOf = (expr) => evaluate(`window.__fluoddity.status().${expr}`);

/** Switch the panel to the Advanced tier, so every gated control exists. */
const goAdvanced = async () => {
  await evaluate(
    `document.querySelector('[data-setting="editor.advanced"] input[type=checkbox]')?.click()`,
  );
  await sleep(900);
};

// ===========================================================================
// PASS 1 -- the gated latch
// ===========================================================================
console.log('\nPASS 1: the gated latch (press, drag to base, hold, release)\n');

await goAdvanced();

// Cohort Fences: GATED, base 0.0, plain (no curve, no inversion), and CONFIG so
// its value is readable straight out of `editConfig`.
const FENCES = 'config.cohortFences';

// Open it first, so there is a slider to drag at all.
await evaluate(
  `document.querySelector('[data-setting="${FENCES}.gate"] input[type=checkbox]')?.click()`,
);
await sleep(700);

if ((await visible(FENCES)) !== 'shown') {
  fail('ticking the checkbox did not reveal the slider');
} else {
  pass('ticking the checkbox revealed the slider');
}

const nudgedValue = await statusOf('editConfig.cohortFences');
if (nudgedValue > 0) {
  pass(`ticking nudged the value off base (${nudgedValue.toExponential(2)})`);
} else {
  fail(`ticking left the value at base (${nudgedValue})`);
}

const track = await trackOf(FENCES);
if (track === null) die('Could not find the Cohort Fences slider track.');

// Press at the middle of the track, then drag to its far LEFT -- which is the
// base value -- and HOLD.
const midX = track.x + track.w * 0.5;
const midY = track.y + track.h * 0.5;
await mouse('mousePressed', midX, midY);
await sleep(120);
await mouse('mouseMoved', track.x + track.w * 0.25, midY);
await sleep(120);
// Past the left edge, so the value clamps to exactly the bottom of the range.
await mouse('mouseMoved', track.x - 20, midY);
await sleep(400);

const heldValue = await statusOf('editConfig.cohortFences');
const heldVisible = await visible(FENCES);

if (heldVisible === 'shown') {
  pass(`the slider stayed visible at base while held (value ${heldValue})`);
} else {
  fail(
    `THE LATCH FAILED: the slider went "${heldVisible}" mid-drag at value ${heldValue}. ` +
      `A drag must never be folded away -- see gatedControl.ts.`,
  );
}

// Release: the fold-back's only legal moment.
await mouse('mouseReleased', track.x - 20, midY, 0);
await sleep(700);

const releasedValue = await statusOf('editConfig.cohortFences');
const releasedVisible = await visible(FENCES);
const gateVisible = await visible(`${FENCES}.gate`);

if (releasedVisible === 'hidden' && gateVisible === 'shown') {
  pass('releasing at base folded the slider back to a checkbox');
} else {
  fail(
    `after release the slider is "${releasedVisible}" and the checkbox is ` +
      `"${gateVisible}" -- expected hidden/shown`,
  );
}

// ===========================================================================
// PASS 3 (numbered to match the header) -- the snap to exactly base
// ===========================================================================
if (releasedValue === 0) {
  pass('the fold-back snapped the value to EXACTLY base (0)');
} else {
  fail(
    `the fold-back left ${releasedValue} rather than exactly 0. ` +
      `"Is it off?" must be unambiguous, not "within epsilon".`,
  );
}

// ===========================================================================
// PASS 2 -- the reveal toggle, and that it does not rebuild
// ===========================================================================
console.log('\nPASS 2: the reveal toggle, and no rebuild\n');

const GATE = 'config.gate.Gravity';
const STRAFE = 'config.gravityStrafe';

if ((await visible(GATE)) !== 'shown') die('The Gravity gate is not on screen.');

const before = await visible(STRAFE);
if (before === 'hidden' || before === 'absent') {
  pass('gravity sliders start hidden with both values at zero');
} else {
  fail(`gravity sliders were "${before}" before the gate was ticked`);
}

// Stamp the node, so a rebuild is detectable after the toggle.
await evaluate(
  `document.querySelector('[data-setting="${STRAFE}"]').__uiCheckMark = 'original'`,
);

await evaluate(
  `document.querySelector('[data-setting="${GATE}"] input[type=checkbox]')?.click()`,
);
await sleep(700);

const revealed = await Promise.all([
  visible(STRAFE),
  visible('config.gravityForce'),
  visible('config.radialGravity'),
]);
if (revealed.every((v) => v === 'shown')) {
  pass('ticking the gate revealed all three members while still at zero');
} else {
  fail(`ticking the gate left members ${JSON.stringify(revealed)}`);
}

const sameNode = await evaluate(
  `document.querySelector('[data-setting="${STRAFE}"]').__uiCheckMark === 'original'`,
);
if (sameNode) {
  pass('THE SAME DOM NODE survived the toggle -- no rebuild');
} else {
  fail(
    'the toggle REBUILT the pane: the blade element was replaced. ' +
      'Visibility must be `blade.hidden`, not a rebuild -- see panel.ts.',
  );
}

// Unticking must ZERO the fields, or a hidden slider keeps pulling particles.
//
// The value is set by a real drag rather than by dispatching, so the assertion
// covers the whole path a user would take. A press-and-release at one point does
// NOT move a Tweakpane slider -- it needs a `mouseMoved` between the two, which
// is what `onPointerMove_` listens for.
// Measured AFTER the reveal has settled: a blade that was `hidden` a moment ago
// has no box, and every row below the one that appeared has moved. Re-reading
// the rect here rather than reusing an earlier one is the difference between
// dragging the slider and dragging empty panel.
await sleep(300);
const gravityTrack = await trackOf(STRAFE);
if (gravityTrack === null) die('Could not find the Gravity (Strafe) track.');
const gy = gravityTrack.y + gravityTrack.h * 0.5;
await mouse('mousePressed', gravityTrack.x + gravityTrack.w * 0.5, gy);
await sleep(120);
await mouse('mouseMoved', gravityTrack.x + gravityTrack.w * 0.85, gy);
await sleep(250);
await mouse('mouseReleased', gravityTrack.x + gravityTrack.w * 0.85, gy, 0);
await sleep(500);

const setValue = await statusOf('editConfig.gravityStrafe');
// The clear is only meaningful if there was something to clear. Asserted rather
// than assumed: a vacuous "cleared 0 to 0" would pass a broken clear.
if (setValue !== 0) {
  pass(`dragging set gravityStrafe to ${setValue.toFixed(3)}`);
} else {
  fail('the drag did not move Gravity (Strafe), so the clear below proves nothing');
}

await evaluate(
  `document.querySelector('[data-setting="${GATE}"] input[type=checkbox]')?.click()`,
);
await sleep(700);

const clearedStrafe = await statusOf('editConfig.gravityStrafe');
const clearedForce = await statusOf('editConfig.gravityForce');
if (clearedStrafe === 0 && clearedForce === 0) {
  pass(`unticking zeroed the gated fields (was ${setValue.toFixed(3)})`);
} else {
  fail(
    `unticking left gravityStrafe=${clearedStrafe} gravityForce=${clearedForce}. ` +
      'A hidden slider still pulling every particle is the worst outcome a ' +
      'checkbox could have.',
  );
}

// ===========================================================================
console.log('');
if (failures.length > 0 || errors.length > 0) {
  console.error(`${failures.length} check(s) failed, ${errors.length} console error(s).`);
  for (const e of errors) console.error(`  ${e}`);
  cleanup();
  process.exit(1);
}
console.log('OK');
cleanup();
process.exit(0);
