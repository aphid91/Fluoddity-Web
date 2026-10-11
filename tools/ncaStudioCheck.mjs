#!/usr/bin/env node
/**
 * End-to-end check of the NCA studio in a real (software) WebGPU browser.
 *
 *   npm run dev            (in another terminal)
 *   xvfb-run -a node tools/ncaStudioCheck.mjs [--url http://localhost:5173] [--out dir]
 *
 * HEADED under Xvfb, deliberately: headless Chromium + SwiftShader loses the
 * device as soon as a WebGPU canvas is configured (compute-only pages like the
 * parity check are fine headless). Needs `playwright` resolvable
 * (PLAYWRIGHT_MODULE overrides) and a Chromium (CHROME_PATH overrides).
 *
 * Drives the app through `?bus` (`window.__fluoddity`) and real mouse clicks:
 *
 *   1. loads, checks every pipeline compiled and frames advance;
 *   2. clicks a cohort twice -> it is highlighted, then adopted (weights stop
 *      being generated, one undo step recorded);
 *   3. grows the architecture (channels, hidden) -> weights re-embedded, no
 *      GPU errors, frames still advance;
 *   4. paints, erases and draws walls with the brush tools;
 *   5. undoes the adoption.
 *
 * Saves a screenshot after each stage into `--out` (default: cwd).
 */

import { createRequire } from 'node:module';
import * as path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const base = opt('--url', 'http://localhost:5173');
const out = opt('--out', '.');

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

const browser = await chromium.launch({
  headless: false,
  executablePath: process.env.CHROME_PATH || undefined,
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,WebGPU',
    '--ignore-gpu-blocklist',
    '--use-vulkan=swiftshader',
    '--use-webgpu-adapter=swiftshader',
  ],
});

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${base}/?nosplash&bus${opt('--preset', '') ? `&preset=${opt('--preset', '')}` : ''}`);
  await page.waitForFunction(() => window.__fluoddity !== undefined, null, { timeout: 60000 });
  const status = () =>
    page.evaluate(() => {
      const o = window.__fluoddity;
      const s = o.status();
      return {
        frame: s.frameCount,
        params: s.paramCount,
        generated: s.ruleIsGenerated,
        highlighted: s.highlightedCohort,
        cohorts: s.cohortCount,
        depth: s.historyDepth,
        canvas: s.canvasSize,
        channels: s.editConfig.channels,
        hidden: s.editConfig.hidden,
        pipes: o.pipelineStatus(),
      };
    });
  /** Poll until `pred(status)` holds (software WebGPU runs at a few fps). */
  const until = async (pred, ms = 8000) => {
    const t0 = Date.now();
    let st = await status();
    while (!pred(st) && Date.now() - t0 < ms) {
      await page.waitForTimeout(200);
      st = await status();
    }
    return st;
  };
  const shot = (name) => page.screenshot({ path: path.join(out, `nca-${name}.png`) });
  const dispatch = (cmd) => page.evaluate((c) => window.__fluoddity.dispatch(c), cmd);
  const edit = (source, field, value) =>
    dispatch({ kind: 'editSetting', setting: { source, field, label: field }, value });

  await page.waitForTimeout(3000);
  let s = await status();
  check(Object.values(s.pipes).every(Boolean), `pipelines compiled ${JSON.stringify(s.pipes)}`);
  const f0 = s.frame;
  await page.waitForTimeout(1500);
  s = await status();
  check(s.frame > f0, `frames advance (${f0} -> ${s.frame})`);
  console.log(`     ${s.canvas} grid, ${s.cohorts} cohorts, ${s.params} params/cohort`);
  await shot('1-start');

  // --- selection: the canvas fills the window's height; click the middle
  // cohort's area twice.
  const box = await page.locator('canvas').first().boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await dispatch({ kind: 'setMouseMode', mode: 'select' });
  const depth0 = s.depth;
  await page.mouse.click(cx, cy);
  s = await until((x) => x.highlighted >= 0);
  check(s.highlighted >= 0, `first click highlights a cohort (${s.highlighted})`);
  const lit = s.highlighted;
  await shot('2-highlight');
  await page.mouse.click(cx, cy);
  s = await until((x) => !x.generated);
  check(!s.generated, 'second click adopts the cohort (weights no longer generated)');
  check(s.depth === depth0 + 1, `one history entry (${depth0} -> ${s.depth})`);
  check(s.highlighted < 0, 'highlight cleared after commit');
  console.log(`     adopted cohort ${lit}`);
  await page.waitForTimeout(1500);
  await shot('3-adopted');

  // --- architecture growth
  const before = (await status()).frame;
  await edit('config', 'channels', 12);
  await edit('config', 'hidden', 48);
  // A channel change recompiles asynchronously, then resets (frame count drops).
  s = await until((x) => x.frame < before, 20000);
  check(s.channels === 12 && s.hidden === 48, `architecture now C=${s.channels} H=${s.hidden}`);
  check(!s.generated, 'grown network kept its weights (embedded, not regenerated)');
  const f1 = s.frame;
  await page.waitForTimeout(1500);
  s = await status();
  check(s.frame > f1, `frames advance after rebuild (${f1} -> ${s.frame}), ${s.params} params`);
  await shot('4-grown');

  // --- tools
  const drag = async (mode, x0, y0, x1, y1, button = 'left') => {
    await dispatch({ kind: 'setMouseMode', mode });
    await page.mouse.move(x0, y0);
    await page.mouse.down({ button });
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8);
      await page.waitForTimeout(60);
    }
    await page.mouse.up({ button });
  };
  await edit('prefs', 'drawSize', 0.03);
  await drag('walls', box.x + box.width * 0.2, cy, box.x + box.width * 0.8, cy);
  await drag('paint', cx, box.y + box.height * 0.2, cx, box.y + box.height * 0.45);
  await drag('erase', cx - 40, box.y + box.height * 0.7, cx + 40, box.y + box.height * 0.7);
  await page.waitForTimeout(1500);
  await shot('5-tools');

  // --- undo the architecture edits and the adoption
  for (let i = 0; i < 3; i++) await dispatch({ kind: 'undo' });
  await page.waitForTimeout(2000);
  s = await status();
  check(s.generated, 'undo restores the generated population');
  check(s.channels !== 12, `undo restores the architecture (C=${s.channels})`);
  await shot('6-undone');

  const real = errors.filter((e) => !e.includes('favicon') && !e.includes('404'));
  check(real.length === 0, `no console errors${real.length ? `: ${real.slice(0, 3).join(' | ')}` : ''}`);
} finally {
  await browser.close();
}
console.log(failures === 0 ? 'STUDIO OK' : `STUDIO FAILED (${failures})`);
process.exitCode = failures === 0 ? 0 : 1;
