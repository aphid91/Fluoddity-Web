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
 *   PASS 6  FOCUS RELEASE. Drag a slider, then press a hotkey and assert the app
 *           actually received it. Tweakpane focuses the slider TRACK on
 *           mousedown and keeps it after the drag, so the panel silently held
 *           the keyboard. Includes the guard that matters most: clicking into a
 *           writable number field must LEAVE focus there, or the fix for the
 *           above makes every number field untypable.
 *
 * ## Why `?bus`
 *
 * Two of these assert what was STORED, not what is drawn -- the fold-back's snap
 * is invisible on screen, since a control at 1e-9 and one at 0 both render as an
 * unticked checkbox. `?bus` exposes the command bus so the run can read status
 * back, the same lever `configCheck.mjs` uses.
 *
 * Usage (from the repo root, with `npm run dev` running):
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

/**
 * Whether a `data-setting` element is on screen.
 *
 * Checks the whole ANCESTOR CHAIN, not just the element's own `display`. Tab
 * pages, collapsed folders and hidden panels all hide their contents from
 * above, and an element inside one is still `display:block` itself -- so the
 * naive check reported "shown" for controls the user could not see. That is the
 * worst possible answer from a visibility assertion.
 *
 * `offsetParent === null` catches every ancestor-hidden case in one test, and is
 * exactly how the tab check spells the same question.
 */
const visible = (key) =>
  evaluate(`(() => {
    const e = document.querySelector('[data-setting="${key}"]');
    if (!e) return 'absent';
    if (getComputedStyle(e).display === 'none') return 'hidden';
    return e.offsetParent === null ? 'hidden' : 'shown';
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

/**
 * Switch a panel to the Advanced tier, so every gated control exists.
 *
 * There are THREE tiers now, one per panel, and the gated controls this file
 * drives are all Project settings -- so this asks for `advancedProject` by name
 * rather than flipping a single global switch. The old one was
 * `editor.advanced`, a lone checkbox in an "Editor" folder inside Preferences
 * that governed everything at once; it no longer exists.
 *
 * **The click is asserted, not optional.** It used to be `?.click()`, which
 * silently did nothing when the selector missed -- so the run continued in
 * Basic and reported "ticking the gate left members [shown, absent, absent]",
 * which reads as a product bug rather than as a stale selector. A missing
 * checkbox is now a hard failure that says which one.
 */
const goAdvanced = async (field = 'advancedProject') => {
  const clicked = await evaluate(`(() => {
    const box = document.querySelector(
      '[data-setting="view.${field}"] input[type=checkbox]');
    if (!box) return false;
    if (!box.checked) box.click();
    return true;
  })()`);
  if (!clicked) die(`No Advanced checkbox for "${field}" -- the selector is stale.`);
  // A tier change rebuilds both panes, deferred through a microtask.
  await sleep(900);
};

/**
 * Put the persisted view state back to first-run defaults.
 *
 * **The tiers PERSIST now**, so a run inherits whatever the last one left in
 * `localStorage`. That made this file order-dependent in a way that only showed
 * up on the second run: `goAdvanced` found the box already ticked, skipped the
 * click, and skipped the rebuild -- so the panel kept a scroll position and a
 * folder layout the assertions below did not expect, and PASS 1 failed claiming
 * the checkbox had not revealed its slider.
 *
 * A check that passes only on a fresh profile is not a check. This runs before
 * anything asserts, so every run starts from the same place.
 */
const resetViewState = async () => {
  const changed = await evaluate(`(() => {
    const s = window.__fluoddity.status();
    const fields = ['advancedProject', 'advancedPreferences', 'advancedDrawing'];
    const on = fields.filter((f) => s[f]);
    for (const f of on) {
      window.__fluoddity.dispatch({ kind: 'editViewPref', field: f, value: false });
    }
    return on.length > 0;
  })()`);
  // RELOAD rather than trusting the dispatch to redraw. `editViewPref` changes
  // the stored tier but does not itself rebuild the panes -- that is the
  // checkbox handler's second half (`advancedToggle.ts`) -- so a reset done
  // through the bus leaves the panel showing the old tier. Reloading rebuilds
  // from the freshly-written preferences, which is exactly the state a first
  // run sees.
  if (changed) {
    await send('Page.reload', { ignoreCache: false }, sid);
    await sleep(5000);
  }
};

// ===========================================================================
// PASS 1 -- the gated latch
// ===========================================================================
console.log('\nPASS 1: the gated latch (press, drag to base, hold, release)\n');

// Before anything asserts: the tiers persist, so start from first-run defaults
// rather than from whatever the previous run left behind. See `resetViewState`.
await resetViewState();
await goAdvanced();

// Cohort Fences: GATED, base 0.0, plain (no curve, no inversion), and CONFIG so
// its value is readable straight out of `editConfig`.
const FENCES = 'config.cohortFences';

// Open it first, so there is a slider to drag at all.
//
// The settle is generous because the reveal is not synchronous with the click:
// the checkbox dispatches, the Orchestrator applies it, the NEXT frame's
// `refresh` publishes the new value, and only then does `applyVisibility` swap
// which of the two blades is hidden. Reading at 700ms caught the frame before
// that swap and reported "the checkbox did not reveal the slider" -- a timing
// artifact that reads exactly like a product bug.
await evaluate(
  `document.querySelector('[data-setting="${FENCES}.gate"] input[type=checkbox]')?.click()`,
);
await sleep(1200);

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
// PASS 4 -- the two panels: per-panel tiers, the tool-driven tabs, the overlay
// ===========================================================================
console.log('\nPASS 4: the two panels, the tabs, and the overlay\n');

/**
 * Which tab the strip says is active, by its accent underline.
 *
 * **Asserts the buttons are actually ON SCREEN first.** An earlier version only
 * looked for the accent, which it found on a strip that had been inserted
 * inside a `display:none` header -- so every tab assertion passed while the tabs
 * were invisible to a user. `offsetParent` is null for anything in a hidden
 * subtree, which catches that no matter how many levels up the hiding is.
 */
const activeTab = () =>
  evaluate(`(() => {
    const all = [...document.querySelectorAll('[data-tab]')];
    if (all.length !== 2) return \`expected 2 tabs, found \${all.length}\`;
    const shown = all.filter((b) => b.offsetParent !== null);
    if (shown.length !== 2) return \`only \${shown.length} of 2 tabs are visible\`;
    const on = shown.filter((b) => b.style.boxShadow && b.style.boxShadow !== 'none');
    return on.length === 1 ? on[0].dataset.tab : \`ambiguous:\${on.length}\`;
  })()`);

const setTool = async (mode) => {
  await evaluate(
    `window.__fluoddity.dispatch({ kind: 'setMouseMode', mode: '${mode}' })`,
  );
  // The tab follows the tool from `Panel.refresh`, so it needs a frame.
  await sleep(300);
};

// --- both panels exist, on the sides they claim ---------------------------
const sides = await evaluate(`(() => {
  const l = document.getElementById('fluoddity-panel-left');
  const r = document.getElementById('fluoddity-panel-right');
  if (!l || !r) return 'missing';
  const lr = l.getBoundingClientRect(), rr = r.getBoundingClientRect();
  return lr.x < rr.x ? 'ok' : 'swapped';
})()`);
if (sides === 'ok') {
  pass('two panels, Project left and Settings right');
} else {
  fail(`the two panels are "${sides}"`);
}

// --- the parked sections are parked ---------------------------------------
const parked = await evaluate(`(() => {
  const ids = [...document.querySelectorAll('[data-section]')]
    .map((e) => e.dataset.section);
  return ids.filter((i) => i === 'transport' || i === 'debug').join(',');
})()`);
if (parked === '') {
  pass('Transport and Debug are parked, not rendered');
} else {
  fail(`a parked section is on screen: ${parked}`);
}

// --- THE TIER REBUILD, which is the bug this pass exists for ---------------
//
// A tier is the one thing a per-frame refresh cannot express: refresh writes
// VALUES into blades that already exist, and a tier decides which blades exist
// at all. So the checkbox has to dispatch AND request a rebuild, and an early
// version did only the first -- the preference flipped and persisted, and the
// panel went on showing Basic. Everything reported success except the screen.
// Asserting the stored flag alone would have passed that; this asserts a
// control that ONLY EXISTS in Advanced.
const ADV_ONLY = 'prefs.tonemapSoftness';
await goAdvanced('advancedPreferences');
if ((await visible(ADV_ONLY)) === 'shown') {
  pass('ticking Advanced REBUILT the panel, not just the preference');
} else {
  fail(
    `Advanced is stored but ${ADV_ONLY} is "${await visible(ADV_ONLY)}". The ` +
      'checkbox must call requestRebuild() as well as dispatching -- a tier ' +
      'changes which controls EXIST, which no refresh can do.',
  );
}

// --- the tiers are independent --------------------------------------------
const tiers = await Promise.all([
  statusOf('advancedProject'),
  statusOf('advancedPreferences'),
  statusOf('advancedDrawing'),
]);
if (tiers[0] === true && tiers[1] === true && tiers[2] === false) {
  pass('the three tiers are independent (drawing untouched by the other two)');
} else {
  fail(`tiers are ${JSON.stringify(tiers)}; expected [true, true, false]`);
}

// --- the tabs follow the tool, as a TRANSITION ----------------------------
await setTool('select');
const t0 = await activeTab();
await setTool('shove');
const t1 = await activeTab();
if (t0 === 'preferences' && t1 === 'drawing') {
  pass('entering a brush tool brought Drawing Controls forward');
} else {
  fail(`select -> shove gave tabs "${t0}" -> "${t1}"`);
}

// Between two brush tools: the tab must NOT move. Clicked back to Preferences
// first, so "did not move" is distinguishable from "was already there".
await evaluate(`document.querySelector('[data-tab="preferences"]').click()`);
await sleep(200);
await setTool('draw');
const t2 = await activeTab();
if (t2 === 'preferences') {
  pass('shove -> draw left the manually chosen tab alone');
} else {
  fail(`shove -> draw moved the tab to "${t2}"; a within-group move must not`);
}

await setTool('select');
const t3 = await activeTab();
if (t3 === 'preferences') {
  pass('leaving for a non-brush tool shows Preferences');
} else {
  fail(`draw -> select gave tab "${t3}"`);
}

// --- the mutation overlay --------------------------------------------------
const overlay = await evaluate(`(() => {
  const root = document.getElementById('fluoddity-mutation');
  if (!root) return 'absent';
  const slider = root.querySelector('[data-setting="config.mutationScale"]');
  const button = root.querySelector('[data-setting="config.mutationSeed.randomize"]');
  if (!slider || !button) return 'incomplete';
  // The root must not eat canvas drags: it spans the full width to centre its
  // contents, so only the bar inside it may take the pointer.
  if (getComputedStyle(root).pointerEvents !== 'none') return 'pointer-trap';
  return 'ok';
})()`);
if (overlay === 'ok') {
  pass('the mutation overlay has its slider and Reroll button, and passes drags through');
} else {
  fail(`the mutation overlay is "${overlay}"`);
}

// Mutation Scale must NOT also be in the Project panel -- one control, one place.
const inPanel = await evaluate(`(() => {
  const left = document.getElementById('fluoddity-panel-left');
  return left?.querySelector('[data-setting="config.mutationScale"]') !== null;
})()`);
if (!inPanel) {
  pass('Mutation Scale is only in the overlay, not also in the Project panel');
} else {
  fail('Mutation Scale is in BOTH the overlay and the Project panel');
}

// The Reroll button drives the same command the old Randomize did.
await evaluate(
  `window.__fluoddity.dispatch({ kind: 'editSetting',
     setting: { field: 'mutationScale', source: 'config', label: 'Mutation Scale' },
     value: 0.5 })`,
);
await sleep(200);
const seedBefore = await statusOf('editConfig.mutationSeed');
await evaluate(
  `document.querySelector('[data-setting="config.mutationSeed.randomize"]').click()`,
);
await sleep(300);
const seedAfter = await statusOf('editConfig.mutationSeed');
if (seedBefore !== seedAfter) {
  pass(`Reroll Mutations moved the seed (${seedBefore} -> ${seedAfter})`);
} else {
  fail(`Reroll Mutations left the seed at ${seedBefore}`);
}

// ===========================================================================
// PASS 5 -- dragging a bipolar gated slider ACROSS zero
// ===========================================================================
//
// THE GESTURE THAT BROKE. Gravity (Strafe) runs -1..1 and passes through
// exactly zero between real values. `gateOpen` tests `!== 0` deliberately (a
// tolerance would collapse the control around a deliberate hair's-breadth
// setting), so at that instant the derivation says "every gated field is zero"
// -- and `forced` has already been retired by `sync`, because the value went
// non-zero earlier in the same drag. Nothing was holding the gate: the checkbox
// unticked itself mid-drag and took the slider with it.
//
// This drags right, then back across the centre, and asserts the slider is
// still on screen at every step WITHOUT releasing the button.
console.log('\nPASS 5: dragging a gravity slider across zero\n');

await setTool('select');

// Re-tick the gate: PASS 2 left it unticked and its fields zeroed.
if ((await visible(GATE)) !== 'shown') die('The Gravity gate is not on screen.');
await evaluate(
  `document.querySelector('[data-setting="${GATE}"] input[type=checkbox]')?.click()`,
);
await sleep(600);

const zeroTrack = await trackOf(STRAFE);
if (zeroTrack === null) die('Could not find the Gravity (Strafe) track for PASS 5.');
const zy = zeroTrack.y + zeroTrack.h * 0.5;
const at = (f) => zeroTrack.x + zeroTrack.w * f;

// A bipolar slider's zero is its MIDPOINT, so 0.5 of the track is the hazard.
await mouse('mousePressed', at(0.5), zy);
await sleep(80);

const steps = [0.8, 0.65, 0.5, 0.35, 0.2, 0.5];
let vanishedAt = null;
for (const f of steps) {
  await mouse('mouseMoved', at(f), zy);
  await sleep(120);
  if ((await visible(STRAFE)) !== 'shown') {
    vanishedAt = f;
    break;
  }
}
await mouse('mouseReleased', at(vanishedAt ?? 0.5), zy, 0);
await sleep(400);

if (vanishedAt === null) {
  pass('the slider stayed on screen across zero, in both directions');
} else {
  fail(
    `the slider vanished mid-drag at track fraction ${vanishedAt}. The gate ` +
      'must stay HELD for the whole gesture -- see GateState.held.',
  );
}

// The hold must not leak: releasing at the centre means the value really is
// zero, and the gate should now close on its own.
const restingValue = await statusOf('editConfig.gravityStrafe');
const gateAfter = await evaluate(
  `document.querySelector('[data-setting="${GATE}"] input[type=checkbox]')?.checked`,
);
if (Math.abs(restingValue) < 0.02 && gateAfter === false) {
  pass(`releasing at zero closed the gate again (value ${restingValue})`);
} else if (Math.abs(restingValue) >= 0.02 && gateAfter === true) {
  pass(`releasing off-zero left the gate open (value ${restingValue.toFixed(3)})`);
} else {
  fail(
    `after release: value=${restingValue} gate=${gateAfter}. A released hold ` +
      'must hand the answer back to the derivation, not pin the gate open.',
  );
}

// ===========================================================================
// PASS 6 -- focus release: the keyboard comes back after using the panel
// ===========================================================================
/**
 * WHY THIS PASS EXISTS. Tweakpane focuses the slider TRACK on mousedown
 * (`tweakpane.js:3293`) and the track keeps focus after the drag ends, so the
 * panel silently held the keyboard: hotkeys either died outright (a focused
 * read-only readout tripped the editable-target gate) or fired ALONGSIDE
 * Tweakpane's own arrow stepping. `focusRelease.ts` fixes it, and only a real
 * browser can check it -- the decision is unit-tested in `focusRelease.test.ts`,
 * but the WIRING (delegated listener order against `addInput`'s own Enter
 * handler, the `closest` traversal, and what `document.activeElement` actually
 * ends up being) has no meaning without DOM.
 *
 * `togglePause` rather than `reset` as the end-to-end probe: both travel the
 * identical `window` keydown path in `inputBinding.ts`, but pause is readable
 * from status afterwards while a reset leaves no observable trace. The question
 * being asked is "did the keystroke reach the app", not "what did it do".
 */
console.log('\nPASS 6: focus release (drag a slider, then use the keyboard)\n');

/** Where focus is, as a short label -- the panel marker is what actually matters. */
const focusReport = () =>
  evaluate(`(() => {
    const a = document.activeElement;
    if (!a) return 'none';
    const inPanel = a.closest('[data-fluoddity-panel]') !== null;
    return (inPanel ? 'PANEL:' : 'free:') + a.tagName.toLowerCase() +
      (a.className ? '.' + String(a.className).split(' ')[0] : '');
  })()`);

/** A raw key to the PAGE, not to an element -- it must reach the window listener. */
const pageKey = async (code, keyChar, vk) => {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, code, key: keyChar, windowsVirtualKeyCode: vk }, sid);
  }
  await sleep(250);
};

/** Press Space and report whether the app saw it. */
const spaceTogglesPause = async () => {
  const before = await statusOf('paused');
  await pageKey('Space', ' ', 32);
  const after = await statusOf('paused');
  if (before !== after) {
    await pageKey('Space', ' ', 32); // Put it back, so passes stay independent.
    return true;
  }
  return false;
};

// An UNGATED slider, so this pass does not depend on the gate machinery or on
// the Advanced tier. `config.mutationScale` looks like the obvious choice and is
// the wrong one: it is the canvas overlay's plain `<input type=range>`
// (`mutationOverlay.ts`), not a Tweakpane blade, so it has no `tp-sldv_t` track
// and none of the focus behaviour under test here.
const MUTATION = 'prefs.brightness';
const mutTrack = await trackOf(MUTATION);
if (mutTrack === null) die(`Could not find the ${MUTATION} track for PASS 6.`);

// --- 6a: a slider drag must not keep the keyboard -------------------------
const mutBefore = await statusOf('editPrefs.brightness');
const my = mutTrack.y + mutTrack.h / 2;
await mouse('mousePressed', mutTrack.x + mutTrack.w * 0.25, my);
await mouse('mouseMoved', mutTrack.x + mutTrack.w * 0.65, my);
await mouse('mouseReleased', mutTrack.x + mutTrack.w * 0.65, my, 0);
await sleep(300);

// Assert the drag REALLY HAPPENED first. Without this, every focus assertion
// below would pass trivially on a drag that missed the track and moved nothing.
const mutAfter = await statusOf('editPrefs.brightness');
if (mutAfter === mutBefore) {
  fail(`the PASS 6 drag did not move ${MUTATION} (${mutBefore}). The track selector is stale.`);
} else {
  pass(`the drag moved ${MUTATION} ${mutBefore} -> ${mutAfter}`);
}

const afterDrag = await focusReport();
if (afterDrag.startsWith('PANEL:')) {
  fail(
    `after a slider drag focus was still in the panel (${afterDrag}). The ` +
      'pointerup release in focusRelease.ts did not fire.',
  );
} else {
  pass(`a slider drag left focus outside the panel (${afterDrag})`);
}

if (await spaceTogglesPause()) {
  pass('Space reached the app immediately after a slider drag');
} else {
  fail('Space did NOT reach the app after a slider drag -- the panel still holds the keyboard.');
}

// --- 6b: the over-blur guard ----------------------------------------------
/**
 * THE ASSERTION THAT PROTECTS THE FIX FROM ITSELF. A blanket "release on any
 * pointerup" would blur a text field between the click that focused it and the
 * first keystroke, making every number field in the panel impossible to type
 * into. Nothing else in this file would notice, because no other check asserts
 * that focus STAYED somewhere.
 */
const WORLD = 'prefs.worldSize';
const fieldBox = await evaluate(`(() => {
  const e = document.querySelector('[data-setting="${WORLD}"]');
  if (!e) return null;
  e.scrollIntoView({ block: 'center' });
  const i = e.querySelector('input');
  if (!i) return null;
  const r = i.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`);
if (fieldBox === null) die(`No text input for ${WORLD} -- the selector is stale.`);
await sleep(200);

await mouse('mousePressed', fieldBox.x, fieldBox.y);
await mouse('mouseReleased', fieldBox.x, fieldBox.y, 0);
await sleep(250);
const afterClick = await focusReport();
if (afterClick === 'PANEL:input') {
  pass('clicking into a writable number field KEPT focus (it stays typable)');
} else {
  fail(
    `clicking a number field left focus at ${afterClick}; it must stay on the ` +
      'input, or the field cannot be typed into at all.',
  );
}

// --- 6c: Enter commits AND hands the keyboard back ------------------------
const worldBefore = await statusOf('editPrefs.worldSize');
const typed = Number((worldBefore * 1.5).toFixed(3));
await evaluate(`(() => {
  const i = document.querySelector('[data-setting="${WORLD}"] input');
  i.focus();
  i.value = '${typed}';
})()`);
await pageKey('Enter', 'Enter', 13);
await sleep(400);

const worldAfter = await statusOf('editPrefs.worldSize');
if (Math.abs(worldAfter - typed) < 1e-6) {
  pass(`Enter committed World Size ${worldBefore} -> ${worldAfter}`);
} else {
  fail(
    `Enter did not commit: wanted ${typed}, got ${worldAfter}. The delegated ` +
      'keydown must be on the BUBBLE phase so the field commits first.',
  );
}

// The field must not have snapped back to the pre-commit number. That is the
// stale-`live` flicker (`controls.ts`), which reads as a silent rejection.
const shown = await evaluate(
  `document.querySelector('[data-setting="${WORLD}"] input').value`,
);
if (Math.abs(Number(shown) - typed) < 1e-6) {
  pass(`the field still shows the committed value (${shown})`);
} else {
  fail(`the field reverted to "${shown}" after committing ${typed} -- \`live\` is stale.`);
}

const afterEnter = await focusReport();
if (afterEnter.startsWith('PANEL:')) {
  fail(`Enter left focus in the panel (${afterEnter}).`);
} else {
  pass(`Enter released focus (${afterEnter})`);
}

if (await spaceTogglesPause()) {
  pass('Space reached the app immediately after an Enter commit');
} else {
  fail('Space did NOT reach the app after Enter -- the field still holds the keyboard.');
}

// --- 6d: Escape abandons AND hands the keyboard back ----------------------
const keepValue = await statusOf('editPrefs.worldSize');
await evaluate(`(() => {
  const i = document.querySelector('[data-setting="${WORLD}"] input');
  i.focus();
  i.value = '${Number((keepValue * 2).toFixed(3))}';
})()`);
await pageKey('Escape', 'Escape', 27);
await sleep(300);

const afterEscape = await statusOf('editPrefs.worldSize');
if (Math.abs(afterEscape - keepValue) < 1e-6) {
  pass(`Escape abandoned the edit (World Size still ${afterEscape})`);
} else {
  fail(`Escape committed ${afterEscape}; it must abandon, leaving ${keepValue}.`);
}

const escFocus = await focusReport();
if (escFocus.startsWith('PANEL:')) {
  fail(`Escape left focus in the panel (${escFocus}).`);
} else {
  pass(`Escape released focus (${escFocus})`);
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
