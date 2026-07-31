/**
 * Entry point.
 *
 * The desktop analogue is `main.py` (4 lines) plus the frame loop at
 * `orchestrator/orchestrator.py:256-365`. There is still no Orchestrator --
 * Step 7 builds it, along with the command/status API. What is still missing
 * from THIS loop and belongs to Step 7:
 *
 *   - the pause branch (`orchestrator.py:304,320-322`): paused is one sample of
 *     a still image, and `advance()` is skipped while the render is not
 *   - `_apply_canvas_input` above the render, because painting binds its own
 *     target
 *   - `_overlay_args()`, which decides overlay visibility from the active tool
 *
 * Pick-resolve before input can dispatch a new pick is DONE (Step 6) -- it is
 * the first thing `frame()` does. When Step 7 adds the pause branch, that call
 * must stay OUTSIDE it: `runFrame` is what a paused frame skips, and clicking
 * to select has to keep working while paused.
 *
 * WHAT IS DELIBERATELY MISSING ELSEWHERE: no UI, no real input, no presets menu
 * (Steps 7-10); no strafe field (Step 9). Picking has no cursor yet either --
 * `?pick=x,y` stands in for one until Step 8.
 */

import { acquireDevice, showUnavailableOverlay, WebGPUUnavailable } from './gpu/device.ts';
import { createSurface, type Surface } from './app/surface.ts';
import { ParticleSystem } from './particleSystem/particleSystem.ts';
import {
  defaultPreset,
  preset as presetByName,
  presetNames,
} from './particleSystem/defaultConfig.ts';
import { Camera } from './camera/camera.ts';
import { CameraState, CAMERA_MODES, type CameraMode } from './camera/cameraState.ts';
import { blurSchedule, sampleAt } from './camera/blurSchedule.ts';
import { RenderTargets } from './app/renderTargets.ts';
import { Assembler } from './assembler/assembler.ts';
import { NO_OVERLAYS } from './assembler/assemblerUniforms.ts';
import { DEFAULT_PREFERENCES } from './prefs/preferences.ts';
import { screenToWorld } from './particleSystem/coords.ts';
import {
  type PickResult,
  DEFAULT_PICK_RADIUS_PX,
  isHit,
  radiusPxToWorld,
} from './particleSystem/pick.ts';
import { SelectionController, type SelectionHost } from './selection/selection.ts';

/**
 * The `?debug` readout.
 *
 * Step 4 has no UI at all, so without this a wrong frame count, a skipped pass
 * or a pipeline that failed to compile is indistinguishable from a wrong
 * physics constant -- they all just look like "the simulation is odd". It is
 * also the instrument for the performance question the plan asks about from
 * Step 5 onward (90 GPU passes per frame at the default rate).
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

/**
 * Format a pick for the debug readout, as `ui.py:385-391` does:
 * `#index (x, y) d=distance`, or `-` for nothing selected and `miss` for a
 * click that found nothing in range.
 */
function describeSelected(result: PickResult | null): string {
  if (result === null) return '-';
  if (!isHit(result)) return 'miss';
  return (
    `#${result.index}  (${result.pos[0].toFixed(3)}, ${result.pos[1].toFixed(3)})  ` +
    `d=${result.distance.toFixed(4)}`
  );
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

  // `?preset=<name>` picks one of the shipped presets by filename stem, for
  // A/B-ing against the desktop without editing code. Unknown names fall back
  // to the default with a console warning that lists what IS available -- an
  // unrecognised preset must not look like a broken engine.
  //
  // Step 7 replaces this with the real command/status API and a preset menu.
  const requested = new URLSearchParams(window.location.search).get('preset');
  let preset = defaultPreset();
  if (requested !== null) {
    try {
      preset = presetByName(requested);
    } catch {
      console.warn(
        `No preset "${requested}". Available: ${presetNames().join(', ')}. ` +
          `Falling back to ${preset.name}.`,
      );
    }
  }

  const system = await ParticleSystem.create({
    device,
    config: preset.config,
    world: preset.world,
  });

  // `?camera=trail|particles` overrides the default mode, so both can be A/B'd
  // against the desktop without editing code. THE MODE TOGGLE IS A TEST: the
  // two modes walk the same transform in opposite directions, so switching
  // between them must not shift or mirror the image (`camera.py:14-18`). If it
  // does, a Y flip is wrong. Step 8 gives this a real hotkey.
  const cameraState = new CameraState();
  // `?pan=x,y` and `?zoom=z` exist for the same reason as `?camera`: Step 8
  // owns real input, and until then the transform is untestable without them.
  // Cheap to keep, and Step 8 replaces them with WASD/QE and the scroll wheel.
  const params = new URLSearchParams(window.location.search);
  /** A numeric query param, or `fallback` when absent or unparseable. */
  const num = (name: string, fallback: number): number => {
    const v = Number(params.get(name) ?? '');
    return params.has(name) && Number.isFinite(v) ? v : fallback;
  };
  const zoomParam = Number(params.get('zoom'));
  if (Number.isFinite(zoomParam) && zoomParam > 0) cameraState.setZoom(zoomParam);
  const panParam = (params.get('pan') ?? '').split(',').map(Number);
  if (panParam.length === 2 && panParam.every((v) => Number.isFinite(v))) {
    cameraState.pan = [panParam[0]!, panParam[1]!];
  }
  // `?colorByCohort=1` / `?colorSensitivity=2` -- display-only overrides for
  // A/B, since the config that carries them is not editable until Step 7.
  const sensitivityParam = Number(params.get('colorSensitivity'));
  const colorSensitivityOverride = Number.isFinite(sensitivityParam) && params.has('colorSensitivity')
    ? sensitivityParam
    : null;
  const colorByCohortOverride = params.has('colorByCohort')
    ? params.get('colorByCohort') !== '0'
    : null;

  // See the note at the `present` call below.
  const reticleRadius = num('reticle', 0);
  const overlays =
    reticleRadius > 0
      ? {
          ...NO_OVERLAYS,
          reticleCenter: [0.5, 0.5] as const,
          reticleRadius,
          reticleDashed: params.has('dashed'),
        }
      : NO_OVERLAYS;

  // `?pick=x,y` dispatches ONE pick at a screen pixel a few frames in, and logs
  // the decoded result: index, distance, position, and the head of the derived
  // rule.
  //
  // STEP 8 OWNS REAL INPUT, and there is none in web/ yet. This exists because
  // without it the whole Step 6 path -- two dispatches, the atomic reduction,
  // the mapAsync readback, the GPU-derived rule -- would ship unexercised until
  // Step 8, by which point a mistranslation would look like a design choice.
  // Same reasoning, and the same shape, as `?reticle`.
  //
  // IT IS ALSO WHAT browserCheck.mjs CAN DRIVE: that tool's only lever is the
  // URL, so a query param is reachable by the existing verification path with
  // no changes to it, where a click handler would need CDP input plumbing.
  //
  // THIS IS STEP 6's AND STEP 8 DELETES IT. Step 8's job is a real
  // capture-aware handler in SELECT mode, which supersedes this entirely;
  // leaving it behind would be a second way to dispatch a pick.
  const pickParam = (params.get('pick') ?? '').split(',').map(Number);
  const pickAt: readonly [number, number] | null =
    pickParam.length === 2 && pickParam.every((v) => Number.isFinite(v))
      ? [pickParam[0]!, pickParam[1]!]
      : null;

  const requestedMode = new URLSearchParams(window.location.search).get('camera');
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

  const targets = new RenderTargets(device);
  const camera = await Camera.create(device, cameraState, targets);
  const assembler = await Assembler.create(device, targets, surface.format);

  // Display preferences. Step 7 loads these from localStorage; until then the
  // defaults plus URL overrides, so the sweeps Step 5 must verify are reachable.
  // Every one of these is a slider on the desktop.
  const prefs = {
    ...DEFAULT_PREFERENCES,
    physicsSteps: system.physicsSteps,
    motionBlurSamples: num('motionBlurSamples', DEFAULT_PREFERENCES.motionBlurSamples),
    brightness: num('brightness', DEFAULT_PREFERENCES.brightness),
    tonemapSoftness: num('tonemapSoftness', DEFAULT_PREFERENCES.tonemapSoftness),
    bloomEnabled: params.has('bloom')
      ? params.get('bloom') !== '0'
      : DEFAULT_PREFERENCES.bloomEnabled,
    bloomThreshold: num('bloomThreshold', DEFAULT_PREFERENCES.bloomThreshold),
    bloomIntensity: num('bloomIntensity', DEFAULT_PREFERENCES.bloomIntensity),
    bloomRadius: num('bloomRadius', DEFAULT_PREFERENCES.bloomRadius),
  };
  const stepsParam = Number(params.get('physicsSteps') ?? '');
  if (Number.isFinite(stepsParam) && stepsParam >= 1) {
    system.physicsSteps = Math.trunc(stepsParam);
    prefs.physicsSteps = system.physicsSteps;
  }

  // The startup summary. `compileModule` logs each module, but a NULL pipeline
  // is the thing that actually matters and it is easy to miss in the noise.
  const status = {
    ...system.pipelineStatus(),
    ...camera.pipelineStatus(),
    ...assembler.pipelineStatus(),
  };
  const failed = Object.entries(status).filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length > 0) {
    console.error(`Pipelines that FAILED to build: ${failed.join(', ')}`);
  } else {
    console.log(
      `All pipelines built. preset="${preset.name}" ` +
        `entities=${system.entityCount} canvas=${system.canvasSize.join('x')} ` +
        `physicsSteps=${system.physicsSteps}`,
    );
  }

  // --- selection ----------------------------------------------------------
  // A stand-in for Step 7's Project: the adopted rule and a generation counter,
  // as an IMMUTABLE record. Adoption returns a new object, so reference
  // identity means "the project changed" -- which is what `_record_history`
  // guards on (`selection_commands.py:198`), and what a spread copy anywhere in
  // the chain would silently break.
  //
  // Step 7 replaces this with the real Project and its history stack. What must
  // survive the swap is the ORDERING, not this type: resolve before input, and
  // outside the paused branch.
  interface StandInProject {
    readonly rule: readonly number[] | null;
    readonly revision: number;
  }
  let project: StandInProject = { rule: null, revision: 0 };
  let selected: PickResult | null = null;

  const selectionHost: SelectionHost<StandInProject, PickResult> = {
    requestPick(pixel) {
      const canvasSize = system.canvasSize;
      const target = screenToWorld(
        pixel,
        surface.size(),
        canvasSize,
        cameraState.pan,
        cameraState.zoom,
      );
      // Through the transform, not a fudge factor, so the tolerance is exactly
      // 40 screen pixels at any zoom (`picker.py:150-162`).
      const radius = radiusPxToWorld(
        DEFAULT_PICK_RADIUS_PX,
        surface.size(),
        canvasSize,
        cameraState.pan,
        cameraState.zoom,
      );
      console.log(
        `pick: dispatch at pixel (${pixel[0]}, ${pixel[1]}) -> world ` +
          `(${target[0].toFixed(4)}, ${target[1].toFixed(4)}) radius ${radius.toFixed(4)}`,
      );
      system.requestPick(target, radius);
    },
    retrievePick: () => system.retrievePick(),
    isHit,
    currentProject: () => project,
    adoptRule: (p, result) => ({ rule: result.rule, revision: p.revision + 1 }),
    setProject: (p) => {
      project = p;
    },
    recordHistory: (before, label) => {
      // Step 7 owns the real history stack. Logging is enough to prove the
      // entry is recorded against the CLICK-time state.
      console.log(`history: "${label}" (before revision ${before.revision})`);
    },
    setSelected: (result) => {
      selected = result;
    },
    describe: (result) => `select particle #${result.index}`,
  };
  const selection = new SelectionController(selectionHost);

  const overlay = createDebugOverlay();
  let lastTime = performance.now();
  let frameMs = 0;
  // Smoothed like frameMs: a raw per-frame delta is too noisy to read.
  let encodeMs = 0;
  let submitMs = 0;

  // frameCount starts at 0, which IS the reset sentinel -- the first advance()
  // spawns every entity and clears the canvas. Nothing else needs to happen.
  let frameIndex = 0;

  const frame = (): void => {
    if (deviceLost) return; // Stop cleanly rather than spinning on a dead device.

    // FINISH LAST FRAME'S SELECTION FIRST, before anything below can dispatch
    // a new pick. There is one result slot, so a new dispatch clobbers the
    // answer being read -- the read has to happen before the write, not after.
    //
    // Here rather than inside runFrame(): Step 7 makes runFrame conditional on
    // the pause state, and clicking to select must keep working while paused --
    // which is precisely when a user wants to inspect a particle
    // (`orchestrator.py:263-279`).
    const resolved = selection.resolve();
    if (resolved !== null) {
      if (isHit(resolved)) {
        const head = (resolved.rule ?? []).slice(0, 4).map((v) => v.toFixed(4));
        console.log(
          `pick: HIT #${resolved.index} at (${resolved.pos[0].toFixed(4)}, ` +
            `${resolved.pos[1].toFixed(4)}) d=${resolved.distance.toFixed(5)} ` +
            `rule[0..3]=[${head.join(', ')}] revision=${project.revision}`,
        );
      } else {
        console.log('pick: MISS -- nothing in range, project untouched');
      }
    }

    const now = performance.now();
    // Exponential smoothing: a raw per-frame delta is too noisy to read.
    frameMs += ((now - lastTime) - frameMs) * 0.1;
    lastTime = now;

    const windowSize = surface.size();

    // BEFORE the encoder opens. A ResizeObserver callback firing between
    // `createCommandEncoder` and `submit` would otherwise destroy a texture
    // whose view is already recorded -- see renderTargets.ts.
    if (targets.ensure(windowSize)) {
      camera.invalidateTargets();
      assembler.invalidateTargets();
    }

    const frameState = {
      canvas: system.currentCanvasTexture(),
      canvasSize: system.canvasSize,
      windowSize,
      entities: system.entityBufferForRendering(),
      entityCount: system.entityCount,
      // From the loaded preset, overridable for A/B. Step 7's Project owns the
      // selected config and replaces both with `project.config`.
      //
      // The override earns its keep on `colorByCohort`: all three shipped
      // presets set it false, so without a way to force it on, `col_params.y`
      // and the flat interpolation would ship untested until Step 10.
      colorSensitivity: colorSensitivityOverride ?? preset.config.colorSensitivity,
      colorByCohort: colorByCohortOverride ?? preset.config.colorByCohort,
    };

    // MOTION BLUR PUTS THE RENDER INSIDE THE PHYSICS LOOP. A displayed frame is
    // the average of `samples` renders taken `stride` sub-steps apart, so the
    // camera must see the simulation mid-advance rather than only at the end.
    // With blur off this is one render, on the last sub-step.
    //
    // Step 7 adds the paused branch here: paused is one sample of a still
    // image, since N samples of an unchanging scene is the same picture at N
    // times the cost (`orchestrator.py:301-304`).
    // The `?pick` one-shot. AFTER the resolve above, which is the ordering the
    // real input path must also keep: input dispatches, the next frame reads.
    //
    // Delayed a few frames so the entities have actually spawned and moved --
    // on frame 0 every entity is still at its reset position, so a pick would
    // be testing the spawn pattern rather than the pick path.
    if (pickAt !== null && frameIndex === 120) {
      selection.select(pickAt);
    }
    frameIndex++;

    const schedule = blurSchedule(prefs.physicsSteps, prefs.motionBlurSamples);
    const at = sampleAt(schedule);

    // Uniforms are written BEFORE the encoder opens -- `queue.writeBuffer`
    // cannot interleave with an open encoder's passes. Nothing the camera reads
    // varies per sample, so one write covers the whole frame; see camera.ts.
    camera.beginFrame(frameState, schedule.samples);

    // Per-phase ENCODE time. This measures the JS-side cost of recording
    // passes, which is the quantity the port plan flags as the likeliest place
    // the web becomes slower than the desktop -- WebGPU's per-pass encoder
    // overhead is meaningfully higher than GL's. It is NOT GPU time; the two
    // can diverge by an order of magnitude, and the mitigation differs
    // completely (encode-bound -> merge passes; GPU-bound -> reduce the rate).
    const tEncode = performance.now();
    const encoder = device.createCommandEncoder({ label: 'frame' });
    camera.clearAccumulator(encoder);
    system.runFrame(encoder, null, (enc, step) => {
      if (step % schedule.stride !== at) return;
      camera.render(enc, {
        ...frameState,
        // Re-pulled PER SAMPLE, not hoisted: the canvas double-buffer swaps
        // inside advance(), so a view captured before the loop is stale after
        // the first sub-step (`orchestrator.py:325-327`).
        canvas: system.currentCanvasTexture(),
      });
    });

    // AFTER the loop, not before: the camera binds its own targets for every
    // sample above, so binding the swap chain any earlier would be undone.
    assembler.present(
      encoder,
      camera.result(),
      surface.context.getCurrentTexture().createView(),
      {
        canvasSize: system.canvasSize,
        windowSize,
        pan: cameraState.pan,
        zoom: cameraState.zoom,
      },
      prefs,
      // Step 8 supplies the reticle from the real cursor and Step 9 the field.
      // The uniform lanes and both shader branches are already in place, so
      // wiring them is a value change, not a shader change.
      //
      // `?reticle=<radius>` (optionally `&dashed`) forces the ring on at a
      // fixed centre. It exists because the dashed ring's `arc` derivation is
      // the most easily-mistranslated arithmetic in frameAssembly.wgsl, and
      // without this it would sit unexercised until Step 10 -- by which point
      // a mistranslation would look like a design choice.
      overlays,
    );
    const tSimAndCamera = performance.now();
    device.queue.submit([encoder.finish()]);
    encodeMs += (performance.now() - tEncode - encodeMs) * 0.1;
    submitMs += (performance.now() - tSimAndCamera - submitMs) * 0.1;

    // AFTER submit, and it has to be: mapAsync may not be called while the
    // encoder that writes the buffer is still open. It resolves on a later
    // frame, which is what makes the whole path two-phase.
    system.beginPickReadback();

    overlay?.update([
      `preset       ${preset.name}`,
      `camera       ${cameraState.mode}`,
      `frameCount   ${system.frameCount}`,
      `entities     ${system.entityCount}`,
      `canvas       ${system.canvasSize.join(' x ')}`,
      `window       ${windowSize.join(' x ')}`,
      `physicsSteps ${system.physicsSteps}`,
      `blur         ${schedule.samples} samples, stride ${schedule.stride} ` +
        `(requested ${prefs.motionBlurSamples})`,
      // The desktop's `selected` status key, rendered as `ui.py:385-391` does:
      // `#index (x, y) d=distance`, or `-` when nothing is selected.
      `selected     ${describeSelected(selected)}${system.pickPending ? '  (pick in flight)' : ''}`,
      `bloom        ${prefs.bloomEnabled ? 'on' : 'off'}`,
      `frame        ${frameMs.toFixed(2)} ms  (${(1000 / frameMs).toFixed(0)} fps)`,
      `encode       ${encodeMs.toFixed(2)} ms  (submit ${submitMs.toFixed(2)} ms)`,
      `pipelines    ${Object.entries(status)
        .map(([n, ok]) => `${n}:${ok ? 'ok' : 'FAILED'}`)
        .join('  ')}`,
    ]);

    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}

start().catch((err: unknown) => {
  if (err instanceof WebGPUUnavailable) {
    showUnavailableOverlay('WebGPU unavailable', err.message);
  } else {
    showUnavailableOverlay('Startup failed', String(err));
  }
  console.error(err);
});
