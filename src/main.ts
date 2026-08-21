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
import { RECORDING_FPS, driverAction } from './recorder/recordingSettings.ts';
// Static, and deliberately so: the file picker must run before any await in the
// export click handler. Both this and `recordingSettings.ts` are leaves that
// pull in neither mediabunny nor the GPU. See `recorder/saveFile.ts`.
import { chooseRecordingFile } from './recorder/saveFile.ts';
import { calibrate } from './calibration/calibrate.ts';
import { ALWAYS_CALIBRATE } from './orchestrator/featureFlags.ts';
import { bindInput } from './ui/inputBinding.ts';
import { Panel } from './ui/panel.ts';
import { fpsFrom, startBand, stepBand } from './perf/fpsBand.ts';

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
  // compare. Help > Welcome still opens it either way.
  //
  // **THE SPLASH IS A FIRST-RUN EXPERIENCE, NOT A TOLL BOOTH.** It used to come
  // up on every single load, which is right exactly once and an obstacle every
  // time after -- a full-frame overlay between someone and the app they came
  // back to use, pausing the simulation until they clear it. `calibrated` is
  // the same signal that gates calibration, so the two arrive together: a first
  // visit gets the welcome copy WITH the progress line under it, and every
  // visit after starts straight in the app. Help > Welcome is how you get it
  // back, and Help > Controls/Guide (or `H`) is where the details went.
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
        // menu item and the corner gear go through `setHidden` too, and
        // before this the menu route left `panelOpen` true and the Orchestrator
        // building settings payloads for an invisible panel.
        onHiddenChange: () => {
          orchestrator.panelOpen = panel?.isOpen ?? false;
        },
        // Video recording. Supplied HERE because this is the one place that
        // holds both halves -- the device to record with and the orchestrator to
        // attach the recorder to -- and because `CommandBus` deliberately admits
        // neither (see `PanelOptions.recording`).
        //
        // The dynamic `import()` is what keeps mediabunny out of the main
        // bundle: this closure body does not run until someone presses Export,
        // so a session that never records never fetches the encoder.
        recording: {
          // STATICALLY imported, unlike the two below, and that is the whole
          // reason `saveFile.ts` is a module of its own: this must be callable
          // with no preceding await or the click's user activation is gone and
          // `showSaveFilePicker` refuses. See that file's header.
          chooseFile: chooseRecordingFile,
          // The recording sliders' ceiling, read fresh: the window changes
          // whenever the user drags the browser edge, and a captured size would
          // let them ask for a recording larger than the window they now have.
          windowSize: () => surface.size(),
          setCropPreview: (resolution) => {
            orchestrator.setCropPreview(resolution);
          },
          start: async (settings, file) => {
            const { VideoRecorder } = await import('./recorder/recorder.ts');
            const recorder = await VideoRecorder.start(device, settings, file);
            orchestrator.setRecorder(recorder);
            return recorder;
          },
          finish: async (recorder) => {
            // DETACHED FIRST. `finish()` finalizes the muxer and frees the
            // capture target, so a frame rendered between those two steps would
            // present into a destroyed swap chain -- a validation error rather
            // than a wrong picture, but on the frame loop, which means every
            // subsequent frame too.
            orchestrator.setRecorder(null);
            return recorder.finish();
          },
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
  // corner gear -- converges, so this handler no longer sets it itself.
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
    // `?nopanel` takes the splash with the panel, so there is nothing to open.
    showGuide: () => panel?.showGuide(),
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
  // The recording's frame interval, for the fixed `dt` below. A plain import
  // rather than a lazy one: `recordingSettings.ts` is a pure leaf holding
  // constants and arithmetic, with no mediabunny and no GPU behind it, so it
  // costs a few hundred bytes and none of what the lazy loading is protecting.
  let lastTime = performance.now();
  let firstFrame = true;
  let frameMs = 0;
  // Smoothed like frameMs: a raw per-frame delta is too noisy to read.
  let orchestratorMs = 0;

  // --- the frame-rate counter ------------------------------------------------
  //
  // Driven from the interval between rAF callbacks, which is the rate the user
  // is actually watching. An earlier version paired that with a GPU-side
  // measurement to estimate headroom above 60; that estimate and its instrument
  // are gone. `perf/fpsBand.ts`'s header records what was tried and why it could
  // not be made to work.
  let band = startBand();

  /**
   * How much recent history the counter averages over.
   *
   * 250 ms, matching the colour's dwell. **This one number replaces the entire
   * warmup-and-restart apparatus that used to sit here** -- a rebuild counter, a
   * live-change counter, a staleness flag, and hooks on world size, physics
   * rate, recording and tab visibility, all of which existed to stop a stall
   * from poisoning a long-memory average.
   *
   * A window this short forgets a stall by itself, in a quarter second, without
   * needing to know what caused it. The apparatus was not only unnecessary but
   * actively harmful: every settings change blanked the readout for up to a
   * second and a half, which is exactly when someone is watching it.
   *
   * So the counter now measures every frame, always, and the only thing that
   * waits is the colour.
   */
  const FPS_WINDOW_MS = 250;

  /**
   * Frame arrival times and their intervals, newest last, trimmed to the window.
   *
   * A plain mean over real intervals rather than an exponential average: an EMA
   * has an infinite tail, so there is no bound on how long a single pathological
   * frame can influence the readout. A window has exactly one -- `FPS_WINDOW_MS`.
   */
  const fpsWindow: { at: number; ms: number }[] = [];

  const pushFrameSample = (at: number, ms: number): void => {
    // **A GUARD, NOT A WARMUP.** One frame can legitimately measure something
    // that is not a frame interval at all: the first frame after startup covers
    // device acquisition and pipeline compilation, and the first after a
    // backgrounded tab covers however long the tab was away -- `calibrate.ts`
    // documents that rAF stops entirely while hidden. Both are seconds long, and
    // both would drag the mean down for the whole window.
    //
    // A frame slower than this is not slow, it is a discontinuity. 500 ms is
    // two frames at 4 fps, well below anything the simulation produces on its
    // own and well above any real stutter worth reporting.
    if (ms > 0 && ms < 500) fpsWindow.push({ at, ms });
    while (fpsWindow.length > 0 && at - fpsWindow[0]!.at > FPS_WINDOW_MS) {
      fpsWindow.shift();
    }
  };

  /** Mean frame interval across the window, or 0 when there is nothing to report. */
  const windowFrameMs = (): number => {
    if (fpsWindow.length === 0) return 0;
    let total = 0;
    for (const sample of fpsWindow) total += sample.ms;
    return total / fpsWindow.length;
  };

  /**
   * True while a recorded frame is being encoded.
   *
   * The rAF loop is synchronous and `addFrame()` is not, so without this a
   * second rAF callback would fire mid-encode, run the physics again, and
   * overwrite the capture canvas with a frame the encoder had not yet read.
   * The result is dropped and duplicated frames, silently. Skipping the whole
   * frame while one is in flight is what makes the slow trickle safe.
   */
  let encoding = false;

  const frame = (): void => {
    if (deviceLost) return; // Stop cleanly rather than spinning on a dead device.

    // The encoder still holds last frame's canvas. Come back next rAF -- see
    // `encoding`. The clock is NOT advanced here, so the skipped time does not
    // land as one huge `dt` on the frame that follows.
    if (encoding) {
      requestAnimationFrame(frame);
      return;
    }

    const now = performance.now();
    const elapsed = now - lastTime;
    // Exponential smoothing: a raw per-frame delta is too noisy to READ. This
    // one is for the `?debug` overlay, which wants a steady number more than a
    // responsive one.
    //
    // **THE FPS COUNTER DOES NOT USE THIS.** At alpha 0.1 it needs ~22 frames to
    // shed a value, which is a third of a second of visible lag after any real
    // change and considerably worse after a stall. The counter keeps its own
    // short rolling window instead -- see `fpsWindow`.
    frameMs += (elapsed - frameMs) * 0.1;
    lastTime = now;

    // The counter's own measurement: a plain mean over the last quarter second
    // of real frame intervals. Independent of `frameMs` above, and deliberately
    // so -- this one is tuned for responsiveness rather than for steadiness.
    //
    // **NO WARMUP AND NO RESTART GATE.** Both existed to stop a stall from
    // poisoning a long-memory average; a window this short forgets a stall on
    // its own within 250 ms, so the machinery that used to discard frames --
    // and which made the readout visibly sticky after every settings change --
    // is gone. Every frame is measured, always.
    pushFrameSample(now, elapsed);

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
    // **A FIXED `dt` WHILE RECORDING, NOT THE MEASURED ONE.** Camera panning
    // integrates `speed * dt`, so a wall-clock delta ties camera speed to how
    // long each frame took to render -- and an offline render's frames take
    // wildly varying, arbitrarily long times. A pan held through an export
    // would visibly accelerate exactly where the physics got expensive, which
    // is motion nobody asked for and cannot be fixed afterwards.
    //
    // The recording's own frame interval is the honest answer: it is what the
    // timestamps handed to the encoder say the gap is, so the camera moves
    // through the export at precisely the rate the finished video plays back.
    const recorder = orchestrator.activeRecorder;
    const dt = firstFrame
      ? 0
      : recorder !== null
        ? 1 / RECORDING_FPS
        : elapsed / 1000;
    firstFrame = false;

    // Frozen ONCE and handed to both, so the panel's readout and the physics
    // cannot disagree about where the mouse was -- which is the whole reason
    // `InputState` is rebuilt per frame rather than polled.
    const frameInput = input.tracker.freeze(dt);

    const tOrchestrator = performance.now();
    orchestrator.frame(frameInput);
    orchestratorMs += (performance.now() - tOrchestrator - orchestratorMs) * 0.1;

    // --- the frame-rate counter ----------------------------------------------
    //
    // The states below all mean "the current average no longer describes what is
    // on screen", and each restarts rather than smoothing across:
    //
    // Two states, and only two. Everything else -- a rebuild, a physics-rate
    // change, a tab coming back -- is now handled by the window simply being
    // short: it forgets a transient within `FPS_WINDOW_MS` without needing to be
    // told one happened.
    //
    //   - AN EXPORT. Recording deliberately runs slow -- it renders at the
    //     capture resolution and encodes every frame -- so measuring through one
    //     would show red and tell the user their GPU is struggling when what is
    //     really happening is the export they asked for.
    //   - A PAUSE. `frame()` takes the branch that skips `runFrame` entirely and
    //     re-renders a still, so the frame rate stops describing the simulation
    //     and starts describing an idle loop.
    //
    // Both FREEZE the badge rather than resetting it: the last honest reading is
    // better than a fabricated one, and a badge that jumped to blue every time
    // someone hit Space would be noise.
    //
    // `frameStatus`, NOT `status`: the outer `status` is the pipeline-build
    // result the debug overlay prints below, and shadowing it here would make
    // that readout print this frame's `Status` instead -- a silent wrong answer
    // in the one surface that exists for diagnosing wrong answers.
    const frameStatus = orchestrator.status();
    const recording = recorder !== null;

    if (!recording && !frameStatus.paused) {
      band = stepBand(band, fpsFrom(windowFrameMs()), now);
    }

    // AFTER the frame, so the panel shows what the simulation actually holds --
    // including changes the panel did not cause (undo, a preset load).
    panel?.refresh(frameStatus, frameInput, {
      band: band.band,
      readout: band.readout,
    });

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

    // --- the recording hand-off ----------------------------------------------
    //
    // AFTER `orchestrator.frame()`, which has already recorded the recording
    // pass onto this frame's encoder AND submitted it. The capture canvas holds
    // the finished frame by the time this runs, which is the ordering
    // `addFrame()` depends on -- it reads that canvas.
    //
    // **PAUSING PAUSES THE RECORDING.** A paused frame is a STILL:
    // `orchestrator.frame()` takes the branch that skips `runFrame` entirely and
    // re-renders the frozen state, so encoding it would append a duplicate of
    // the previous frame to the file. Doing that for as long as the pause lasts
    // is exactly the "dead space in the middle of the video" this must not
    // produce.
    //
    // Because the frame COUNTER only advances on frames that are actually
    // encoded, the finished clip holds precisely `duration * fps` frames of real
    // motion however many times the user paused along the way. The physics frame
    // count is invariant under pausing, which is what makes the pause safe to
    // use as an inspection tool mid-export.
    //
    // **COMPLETION IS CHECKED OUTSIDE THE PAUSE GATE**, and it has to be. The
    // last frame can land on the very frame the user pauses -- or they may pause
    // and then press Cancel, which sets `finished` without any frame being
    // encoded. Gating the finalize on `!paused` would strand both: the file
    // would never be written, and the only way out would be to unpause a
    // recording the user had already ended.
    //
    // The three-way choice itself lives in `driverAction`, in the leaf, so the
    // precedence between "finished" and "paused" is stated once and tested --
    // see its docstring. This callback is where it is ACTED on, not where it is
    // decided.
    if (recorder !== null) {
      const action = driverAction({
        finished: recorder.finished,
        paused: orchestrator.status().paused,
      });
      if (action === 'finalize') {
        // Finalize and download. `finishExport` detaches the recorder first, so
        // the next frame renders normally rather than into a freed target.
        void panel?.finishExport();
      } else if (action === 'encode') {
        // **THE AWAIT IS THE BACKPRESSURE.** `addFrame()` resolves when the
        // encoder is ready for another, so this is what stops a fast stretch of
        // simulation from queueing unbounded VideoFrames and killing the tab.
        // `encoding` holds the rAF loop off until it lands -- see its comment.
        encoding = true;
        void recorder
          .addFrame()
          .catch((err: unknown) => {
            console.warn('Dropped a recorded frame:', err);
          })
          .finally(() => {
            encoding = false;
            // The clock restarts HERE rather than at the top of the next frame:
            // everything between the two is encode time, and letting it show up
            // as `elapsed` would report a frame rate measuring the encoder.
            lastTime = performance.now();
          });
      }
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
