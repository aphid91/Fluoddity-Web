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
 * Nothing is missing now: Step 10 finished, and `ui/panel.ts` is the real
 * interface. Step 7's flat registry dump (`ui/thinPanel.ts`) was deleted with
 * the `?ui=thin` escape hatch that kept it reachable through Step 10's
 * sub-steps.
 */

import { acquireDevice, showUnavailableOverlay, WebGPUUnavailable } from './gpu/device.ts';
import { createSurface, type Surface } from './app/surface.ts';
import { CAMERA_MODES, type CameraMode } from './camera/cameraState.ts';
import { type SavedConfig, fromDocument } from './config/persistence.ts';
import { SHARED_LINK_NAME, decodeShareLink } from './config/shareLink.ts';
import { Orchestrator } from './orchestrator/orchestrator.ts';
import { calibrate } from './calibration/calibrate.ts';
import { ALWAYS_CALIBRATE } from './orchestrator/featureFlags.ts';
import { bindInput } from './ui/inputBinding.ts';
import { Panel } from './ui/panel.ts';

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

  // --- the share link --------------------------------------------------------
  //
  // Read BEFORE `create`, so a shared project is what the app OPENS rather than
  // something it switches to a moment later. See `OrchestratorOptions.openWith`
  // for the three things loading-afterwards gets wrong.
  //
  // A BAD LINK MUST NOT TAKE THE APP DOWN. `start()`'s catch renders the
  // unavailable banner, which is the right response to a missing GPU and
  // entirely the wrong one to a link that got truncated in a chat client -- the
  // app is fine, only the link is not. So this fails soft: warn, remember why,
  // and open the default preset. The user is told once the panel exists to tell
  // them with.
  //
  // THE HASH IS LEFT IN THE ADDRESS BAR. Stripping it with `replaceState` would
  // tidy things up and would break refresh: F5 or a restored tab would lose the
  // shared project with no way back, and for a link someone was sent that is
  // real data loss -- they may have no other copy. The cost of keeping it is
  // that the URL describes the state the tab ARRIVED in rather than its live
  // state, which is what a fragment normally means anyway, and `Shift+C`
  // regenerates a correct one on demand.
  //
  // NO `hashchange` LISTENER either. Reacting to one would replace the live
  // project and discard unsaved edits in response to a gesture the user does not
  // think of as "open a file". Nothing in the app writes the hash and there are
  // no in-page anchors, so the only way to fire one is to paste a second link
  // into a tab that already has one -- where the right answer is a reload, which
  // the user already has.
  let openWith: { saved: SavedConfig; name: string } | undefined;
  let shareLinkError = '';
  try {
    const shared = decodeShareLink(window.location.hash);
    if (shared !== null) {
      openWith = { saved: fromDocument(shared, 'shared link'), name: SHARED_LINK_NAME };
    }
  } catch (err: unknown) {
    // Covers both halves: `decodeShareLink` on a payload that will not
    // decompress or parse, and `fromDocument` on one that parses into something
    // that is not a v8 document -- most likely a link from a future version.
    shareLinkError = String(err);
    console.warn(`Ignoring the share link in the URL: ${shareLinkError}`);
  }

  const orchestrator = await Orchestrator.create({
    device,
    surface,
    // `?preset=<stem>` still works and is still worth keeping: `browserCheck.mjs`
    // drives the page by URL, so this is how an automated check reaches a
    // preset without synthesizing a click on a panel button.
    ...(params.has('preset') ? { presetName: params.get('preset') ?? undefined } : {}),
    ...(openWith !== undefined ? { openWith } : {}),
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
  //
  // The welcome splash comes up with it. `?nosplash` suppresses the automatic
  // first showing for the same reason `?nopanel` exists: `browserCheck.mjs`
  // compares screenshots, and a full-frame overlay would change what those
  // compare. Help > Welcome / Controls still opens it either way.
  //
  // **THE SPLASH IS A FIRST-RUN EXPERIENCE, NOT A TOLL BOOTH.** It used to come
  // up on every single load, which is right exactly once and an obstacle every
  // time after -- a full-frame overlay between someone and the app they came
  // back to use, pausing the simulation until they clear it. `calibrated` is
  // the same signal that gates calibration, so the two arrive together: a first
  // visit gets the welcome copy WITH the progress line under it, and every
  // visit after starts straight in the app. Help > Welcome / Controls is how
  // you get it back.
  //
  // `ALWAYS_CALIBRATE` is a development flag that forces every load to behave
  // like a first one, for tuning the ladder without clearing `localStorage`
  // between runs. Off in anything shipped -- see `orchestrator/featureFlags.ts`.
  const firstVisit = ALWAYS_CALIBRATE || !orchestrator.preferences.calibrated;

  // `let`, and the callback reads it rather than closing over a value, because
  // the Panel needs a calibration callback that reports progress THROUGH the
  // Panel -- a circular reference the constructor cannot be handed. The callback
  // only ever runs after construction has returned, so the binding is always
  // assigned by the time it is read.
  let panel: Panel | null = null;
  panel = params.has('nopanel')
    ? null
    : new Panel({
        bus: orchestrator,
        showSplash: firstVisit && !params.has('nosplash'),
        // THE APP OPENS ON THE PICTURE. The panels are two 320px columns of
        // controls over a piece whose whole point is being looked at, and the
        // mutation bar -- which `X` never hid -- already carries the controls
        // worth reaching for while watching, including the gear that brings
        // these back.
        startHidden: true,
        // Follows every route that hides the panels, not just `X`: the Editor
        // menu item and the overlay's gear go through `setHidden` too, and
        // before this the menu route left `panelOpen` true and the Orchestrator
        // building settings payloads for an invisible panel.
        onHiddenChange: () => {
          orchestrator.panelOpen = panel?.isOpen ?? false;
        },
        // Omitted under `?nocalibrate`, which leaves `Panel.calibrate()` inert
        // and so also disables the re-run on Reset Editor Preferences.
        ...(params.has('nocalibrate')
          ? {}
          : {
              runCalibration: async (): Promise<void> => {
                // Held across the two callbacks so resuming can restore the
                // progress line rather than blanking it -- `onProgress` does
                // not fire again until the NEXT rung starts.
                let progress = '';
                const rung = await calibrate(orchestrator, {
                  onProgress: (done, total) => {
                    progress = `Calibrating for your display… (${done}/${total})`;
                    panel?.setSplashStatus(progress);
                  },
                  // A hidden tab is throttled hard enough that measuring it
                  // would misjudge the GPU badly, so the walk waits. Say so:
                  // the splash is locked shut meanwhile, and a frozen counter
                  // with no explanation reads as a hang.
                  onWaiting: (waiting) => {
                    panel?.setSplashStatus(
                      waiting
                        ? 'Paused while this tab is in the background — ' +
                            'calibration resumes when you come back.'
                        : progress,
                    );
                  },
                });
                console.info(
                  `Calibrated to world size ${rung.worldSize}, physics rate ` +
                    `${rung.physicsSteps}. Change either in Preferences > Simulation.`,
                );
              },
            }),
      });
  // FROM `isOpen`, not from `panel !== null`: the panels now start hidden, so
  // "a panel exists" and "a panel is visible" are different facts and only the
  // second one decides whether the settings payloads are worth building.
  orchestrator.panelOpen = panel?.isOpen ?? false;

  // Reported HERE rather than where it was caught, because until now there was
  // nothing on screen to report it with. Actionable text only -- the raw error
  // is already in the console and names nothing a user can act on.
  if (shareLinkError !== '') {
    panel?.notify(
      'That share link could not be read — it was most likely truncated on its ' +
        'way to you. Opened the default project instead.',
      'error',
    );
  }

  // --- input (Step 8) --------------------------------------------------------
  // Every listener lives in `ui/inputBinding.ts`; what comes back is a tracker
  // to freeze once per frame. `toggleUi` is the `X` key: the panel's own
  // business, so it is handled here rather than sent through the command bus
  // (`ui.py:471-473`). `panelOpen` follows it through the `onHiddenChange`
  // above, where every route -- this key, the Editor menu item and the
  // overlay's gear -- converges, so this handler no longer sets it itself.
  const input = bindInput({
    surface,
    dispatch: (command) => orchestrator.dispatch(command),
    toggleUi: () => {
      if (panel === null) return; // `?nopanel`: nothing to toggle.
      panel.setHidden(!panel.hidden);
    },
    // `?nopanel` takes the toast with the panel, so there would be nowhere to
    // report the result. Copying silently is worse than not copying.
    copyShareLink: () => panel?.copyShareLink(),
    pasteShareLink: () => panel?.pasteShareLink(),
  });

  // --- first-run calibration -------------------------------------------------
  //
  // A new visitor otherwise gets `worldSize: 1.0, physicsSteps: 30` regardless
  // of what their machine can hold -- fine on a discrete GPU, a slideshow on an
  // integrated one. `calibration/calibrate.ts` walks a fixed progression of
  // settings and keeps the heaviest that stays inside a 60 fps budget.
  //
  // GOES THROUGH `Panel.calibrate()` rather than calling `calibrate` directly,
  // so this shares one path with the OTHER trigger -- Reset Editor Preferences,
  // which puts someone back on defaults their machine was never measured
  // against. That path holds the splash up and locked for the duration; doing
  // it here too is what makes the two behave identically.
  //
  // **DELIBERATELY NOT AWAITED.** The rAF loop below has to start immediately:
  // calibration runs behind the welcome splash so the wait costs the user
  // nothing, and that only works if the splash is up and the simulation is
  // visible while the probes run. Awaiting here would blank the screen for the
  // whole walk, which is precisely the first impression this exists to avoid.
  //
  // The two loops overlap safely. Both submit work to the same queue, which
  // serializes them; rung transitions go through `rebuildSystem`, which builds
  // the replacement before dropping the old one, so the rAF loop always reads a
  // valid system. It may render one frame at a rung the ladder has already
  // moved past, which is invisible.
  //
  // `?nocalibrate` is REQUIRED BY THE VERIFICATION TOOLS, not a convenience:
  // `browserCheck.mjs` compares screenshots, and a run whose world size depends
  // on the runner's GPU would make every one of those comparisons meaningless.
  // It is handled at construction, by withholding `runCalibration` entirely.
  if (firstVisit) void panel?.calibrate();

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

    // Frozen ONCE and handed to both, so the panel's readout and the physics
    // cannot disagree about where the mouse was -- which is the whole reason
    // `InputState` is rebuilt per frame rather than polled.
    const frameInput = input.tracker.freeze(dt);

    const tOrchestrator = performance.now();
    orchestrator.frame(frameInput);
    orchestratorMs += (performance.now() - tOrchestrator - orchestratorMs) * 0.1;

    // AFTER the frame, so the panel shows what the simulation actually holds --
    // including changes the panel did not cause (undo, a preset load).
    panel?.refresh(orchestrator.status(), frameInput);

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
