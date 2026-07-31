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
 *   - pick-resolve before input can dispatch a new pick (read before write)
 *   - `_overlay_args()`, which decides overlay visibility from the active tool
 *
 * WHAT IS DELIBERATELY MISSING ELSEWHERE: no picking (Step 6); no UI, no input,
 * no presets menu (Steps 7-10); no strafe field (Step 9).
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
  const num = (name: string, fallback: number): number => {
    const v = Number(params.get(name) ?? '');
    return params.has(name) && Number.isFinite(v) ? v : fallback;
  };
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

  const overlay = createDebugOverlay();
  let lastTime = performance.now();
  let frameMs = 0;

  // frameCount starts at 0, which IS the reset sentinel -- the first advance()
  // spawns every entity and clears the canvas. Nothing else needs to happen.
  const frame = (): void => {
    if (deviceLost) return; // Stop cleanly rather than spinning on a dead device.

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
    const schedule = blurSchedule(prefs.physicsSteps, prefs.motionBlurSamples);
    const at = sampleAt(schedule);

    // Uniforms are written BEFORE the encoder opens -- `queue.writeBuffer`
    // cannot interleave with an open encoder's passes. Nothing the camera reads
    // varies per sample, so one write covers the whole frame; see camera.ts.
    camera.beginFrame(frameState, schedule.samples);

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
      // Step 8 supplies the reticle (no cursor yet) and Step 9 the field (no
      // texture yet). The uniform lanes and both shader branches are already
      // in place, so wiring them is a value change, not a shader change.
      NO_OVERLAYS,
    );
    device.queue.submit([encoder.finish()]);

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
      `frame        ${frameMs.toFixed(2)} ms  (${(1000 / frameMs).toFixed(0)} fps)`,
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
