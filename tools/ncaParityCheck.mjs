#!/usr/bin/env node
/**
 * Headless GPU parity check for the NCA kernels.
 *
 *   npm run dev            (in another terminal)
 *   node tools/ncaParityCheck.mjs [--url http://localhost:5173]
 *
 * Launches Chromium through Playwright with WebGPU on SwiftShader (works in a
 * headless container with no GPU), opens `/tools/ncaParity.html`, and exits
 * non-zero unless every case matches `cpuStep` within tolerance.
 *
 * Needs `playwright` resolvable (a global install is fine: set NODE_PATH or
 * PLAYWRIGHT_MODULE) and a Chromium -- CHROME_PATH overrides the binary.
 */

import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const urlArg = args.indexOf('--url');
const base = urlArg >= 0 ? args[urlArg + 1] : 'http://localhost:5173';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

export const WEBGPU_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan,WebGPU',
  '--ignore-gpu-blocklist',
  '--use-vulkan=swiftshader',
  '--use-webgpu-adapter=swiftshader',
  '--disable-vulkan-surface',
];

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: WEBGPU_ARGS,
});
try {
  const page = await browser.newPage();
  const seen = new Set();
  page.on('console', (m) => {
    const text = m.text();
    if ((m.type() === 'error' || m.type() === 'warning') && !seen.has(text)) {
      seen.add(text);
      console.log(`[page ${m.type()}] ${text}`);
    }
  });
  await page.goto(`${base}/tools/ncaParity.html`);
  await page.waitForFunction(() => window.__ncaParity !== undefined, null, { timeout: 180000 });
  const result = await page.evaluate(() => window.__ncaParity);
  for (const r of result.results ?? []) {
    console.log(`${r.maxDiff <= 1e-3 * Math.max(1, r.maxAbs) ? 'ok  ' : 'FAIL'} ${r.name}  maxDiff=${r.maxDiff.toExponential(2)} maxAbs=${r.maxAbs.toFixed(3)}`);
  }
  if (result.errors?.length) console.log('GPU errors:', [...new Set(result.errors)].slice(0, 3));
  console.log(result.ok ? 'PARITY OK' : 'PARITY FAILED');
  process.exitCode = result.ok ? 0 : 1;
} finally {
  await browser.close();
}
