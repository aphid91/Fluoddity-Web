/**
 * Entry point.
 *
 * The desktop analogue is `main.py` (4 lines) plus `Orchestrator.run()`
 * (`orchestrator.py:256-365`). **Step 7 moved the frame loop out of here** and
 * into `orchestrator/orchestrator.ts`, which is where it belongs: this file now
 * acquires a device, builds the Orchestrator and the panel, and turns
 * `requestAnimationFrame` into calls on them.
 *
 * What that leaves here is the three things that are genuinely the entry
 * point's: device acquisition and the unavailable/lost paths, the `?debug`
 * readout, and the startup URL overrides.
 *
 * ## What is still missing, and which step owns it
 *
 *   - **The strafe field (Step 9).** SHOVE and DRAW select as tools and show
 *     the reticle; neither paints.
 *   - **Storage (Step 9).** Presets are the three baked in at build time;
 *     saving reports through `saveError` rather than writing.
 *   - **The real UI (Step 10).** `ui/thinPanel.ts` is the flat registry dump
 *     the plan asks Milestone 1 for.
 */

import { acquireDevice, showUnavailableOverlay, WebGPUUnavailable } from './gpu/device.ts';
import { createSurface, type Surface } from './app/surface.ts';
import { CAMERA_MODES, type CameraMode } from './camera/cameraState.ts';
import { Orchestrator } from './orchestrator/orchestrator.ts';
import { bindInput } from './ui/inputBinding.ts';
import { ThinPanel } from './ui/thinPanel.ts';

/**
 * The `?debug` readout.
 *
 * The panel now shows most of this, and the overlay is still worth keeping:
 * it carries the frame TIMINGS, which are the instrument for the performance
 * question the plan asks about from Step 5 onward, and it renders without
 * Tweakpane in the loop -- so a panel that failed to build is still diagnosable.
 */
function createDebugOverlay(): { update(lines: readonly string[]): void } | null {
  if (!new URLSearchParams(window.location.search).has('debug')) return null;

  const el = document.createElement('pre');
  el.id = 'debug-overlay';
  el.style.cssText =
    'position:fixed;top:0;left:0;margin:0;padding:8px 12px;z-index:10;' +
    'font:12px/1.5 ui-monospace,monospace;color:#0f0;background:rgba(0,0,0,.65);' +
    'pointer-events:none;white-space:pre;';
  document.body.append(el);
  return {
    update(lines) {
      el.textContent = lines.join('\n');
    },
  };
}

async function start(): Promise<void> {
  const canvas = document.getElementById('app');
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('No <canvas id="app"> in the document.');
  }

  let deviceLost = false;
  const { device } = await acquireDevice((info) => {
    deviceLost = true;
    showUnavailableOverlay('GPU device lost', info.message || String(info.reason));
  });

  const surface: Surface = createSurface(canvas, device);

  // A vertex-visible storage buffer is what brush.wgsl needs to read entities
  // in its vertex stage. WebGPU's compatibility mode can report zero of them,
  // and the failure would otherwise be an opaque pipeline error.
  if (device.limits.maxStorageBuffersPerShaderStage === 0) {
    console.error(
      'This adapter exposes no storage buffers per shader stage, so the brush ' +
        'splat cannot read the entity buffer in its vertex stage. The trail ' +
        'canvas will stay empty.',
    );
  }

  const params = new URLSearchParams(window.location.search);

  const orchestrator = await Orchestrator.create({
    device,
    surface,
    // `?preset=<stem>` still works and is still worth keeping: `browserCheck.mjs`
    // drives the page by URL, so this is how an automated check reaches a
    // preset without synthesizing a click on a panel button.
    ...(params.has('preset') ? { presetName: params.get('preset') ?? undefined } : {}),
  });

  // --- startup camera overrides ---------------------------------------------
  // `?camera`, `?zoom` and `?pan` predate real input and outlive it, for the
  // same reason `?preset` does: they are the only lever `browserCheck.mjs` has.
  //
  // **`?camera` IS THE FLIP TEST.** The two modes walk the same transform in
  // opposite directions, so switching between them must not shift or mirror the
  // image (`camera.py:14-18`). If it does, a Y flip is wrong.
  const cameraState = orchestrator.cameraState;
  const requestedMode = params.get('camera');
  if (requestedMode !== null) {
    if ((CAMERA_MODES as readonly string[]).includes(requestedMode)) {
      cameraState.mode = requestedMode as CameraMode;
    } else {
      console.warn(
        `No camera mode "${requestedMode}". Available: ${CAMERA_MODES.join(', ')}. ` +
          `Falling back to ${cameraState.mode}.`,
      );
    }
  }
  const zoomParam = Number(params.get('zoom'));
  if (Number.isFinite(zoomParam) && zoomParam > 0) cameraState.setZoom(zoomParam);
  const panParam = (params.get('pan') ?? '').split(',').map(Number);
  if (panParam.length === 2 && panParam.every((v) => Number.isFinite(v))) {
    cameraState.pan = [panParam[0]!, panParam[1]!];
  }

  // `?bus` exposes the command bus for automated checks.
  //
  // OFF BY DEFAULT and gated on the URL, like `?preset` and `?nopanel`, because
  // it is the same kind of affordance: `configCheck.mjs` has to dispatch a save
  // and read the status back, and a page driven only by synthetic clicks cannot
  // do that on a panel whose real dialog is Step 10's. Nothing in the app reads
  // this -- it exists for the verification tools and disappears without them.
  if (params.has('bus')) {
    (window as unknown as Record<string, unknown>)['__fluoddity'] = orchestrator;
  }

  // The startup summary. `compileModule` logs each module, but a NULL pipeline
  // is the thing that actually matters and it is easy to miss in the noise.
  const status = orchestrator.pipelineStatus();
  const failed = Object.entries(status)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  if (failed.length > 0) {
    console.error(`Pipelines that FAILED to build: ${failed.join(', ')}`);
  } else {
    const d = orchestrator.diagnostics;
    console.log(
      `All pipelines built. preset="${d.preset}" entities=${d.entityCount} ` +
        `canvas=${d.canvasSize.join('x')} physicsSteps=${d.physicsSteps}`,
    );
  }

  // --- the UI ---------------------------------------------------------------
  // `?nopanel` suppresses it. `browserCheck.mjs` takes screenshots for the
  // visual A/B, and a 320px panel over the right-hand third of the frame would
  // change what those compare -- so the automated path can turn it off without
  // the panel having to know a verification tool exists.
  const panel = params.has('nopanel') ? null : new ThinPanel({ bus: orchestrator });
  orchestrator.panelOpen = panel !== null;

  // --- input (Step 8) --------------------------------------------------------
  // Every listener lives in `ui/inputBinding.ts`; what comes back is a tracker
  // to freeze once per frame. `toggleUi` is the `X` key: the panel's own
  // business, so it is handled here rather than sent through the command bus
  // (`ui.py:471-473`). `panelOpen` follows it, so the Orchestrator stops
  // building settings payloads for a panel nobody can see.
  const input = bindInput({
    surface,
    dispatch: (command) => orchestrator.dispatch(command),
    toggleUi: () => {
      if (panel === null) return; // `?nopanel`: nothing to toggle.
      panel.setHidden(!panel.hidden);
      orchestrator.panelOpen = panel.isOpen;
    },
  });

  const overlay = createDebugOverlay();
  let lastTime = performance.now();
  let firstFrame = true;
  let frameMs = 0;
  // Smoothed like frameMs: a raw per-frame delta is too noisy to read.
  let orchestratorMs = 0;

  const frame = (): void => {
    if (deviceLost) return; // Stop cleanly rather than spinning on a dead device.

    const now = performance.now();
    const elapsed = now - lastTime;
    // Exponential smoothing: a raw per-frame delta is too noisy to READ. This
    // one is for the overlay only.
    frameMs += (elapsed - frameMs) * 0.1;
    lastTime = now;

    // **THE RAW DELTA, NOT `frameMs`.** Camera panning is `speed * dt`, and a
    // smoothed dt lags the real clock -- so a pan would keep accelerating for
    // several frames after the key went down and keep coasting after it came
    // up. `frameMs` is smoothed precisely because it is unreadable otherwise,
    // which is the opposite of what integration wants.
    //
    // `firstFrame` keeps the contract at `inputState.ts:84-91`: dt is zero on
    // the first frame, and `applyCameraKeys` early-returns on a non-positive
    // one. The first `elapsed` measures the gap since `start()` ran, which is
    // however long device acquisition and pipeline compilation took -- easily
    // hundreds of milliseconds, and it would land as one enormous camera step.
    const dt = firstFrame ? 0 : elapsed / 1000;
    firstFrame = false;

    const tOrchestrator = performance.now();
    orchestrator.frame(input.tracker.freeze(dt));
    orchestratorMs += (performance.now() - tOrchestrator - orchestratorMs) * 0.1;

    // AFTER the frame, so the panel shows what the simulation actually holds --
    // including changes the panel did not cause (undo, a preset load).
    panel?.refresh(orchestrator.status());

    if (overlay !== null) {
      const d = orchestrator.diagnostics;
      const schedule = orchestrator.currentSchedule();
      overlay.update([
        `preset       ${d.preset}`,
        `camera       ${d.camMode}`,
        `tool         ${d.mouseMode}${d.paused ? '   PAUSED' : ''}`,
        `frameCount   ${d.frameCount}`,
        `entities     ${d.entityCount}`,
        `canvas       ${d.canvasSize.join(' x ')}`,
        `window       ${surface.size().join(' x ')}`,
        `physicsSteps ${d.physicsSteps}`,
        `blur         ${schedule.samples} samples, stride ${schedule.stride} ` +
          `(requested ${d.motionBlurSamples})`,
        `selected     ${describeSelected(d.selected)}${d.pickPending ? '  (pick in flight)' : ''}`,
        `bloom        ${d.bloomEnabled ? 'on' : 'off'}`,
        `frame        ${frameMs.toFixed(2)} ms  (${(1000 / frameMs).toFixed(0)} fps)`,
        `orchestrator ${orchestratorMs.toFixed(2)} ms`,
        `pipelines    ${Object.entries(status)
          .map(([n, ok]) => `${n}:${ok ? 'ok' : 'FAILED'}`)
          .join('  ')}`,
      ]);
    }

    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}

/** `#index (x, y) d=distance`, or `-`/`miss`. As `ui.py:385-391` renders it. */
function describeSelected(
  result: { index: number; pos: readonly [number, number]; distance: number } | null,
): string {
  if (result === null) return '-';
  if (result.index < 0) return 'miss';
  return (
    `#${result.index}  (${result.pos[0].toFixed(3)}, ${result.pos[1].toFixed(3)})  ` +
    `d=${result.distance.toFixed(4)}`
  );
}

start().catch((err: unknown) => {
  if (err instanceof WebGPUUnavailable) {
    showUnavailableOverlay('WebGPU unavailable', err.message);
  } else {
    showUnavailableOverlay('Startup failed', String(err));
  }
  console.error(err);
});
