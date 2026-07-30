/**
 * Entry point.
 *
 * The desktop analogue is `main.py` (4 lines) plus the frame loop at
 * `orchestrator/orchestrator.py:256-365`. There is still no Orchestrator --
 * Step 7 builds it, along with the command/status API and the real frame loop's
 * ordering constraints (pick-read before pick-write; render inside the physics
 * loop for motion blur). Step 4's loop is the minimum that runs the engine:
 * advance the simulation, then show the canvas.
 *
 * WHAT IS DELIBERATELY MISSING, so it is not mistaken for an oversight:
 * no camera, no bloom, no tone curve, no overlays (Step 5); no picking
 * (Step 6); no UI, no input, no presets menu (Steps 7-10). `presentPass` below
 * is a throwaway that Step 5 deletes -- see debugPresent.wgsl.
 */

import { acquireDevice, showUnavailableOverlay, WebGPUUnavailable } from './gpu/device.ts';
import { compileModule } from './gpu/shaderModule.ts';
import { createSurface, type Surface } from './app/surface.ts';
import { ParticleSystem } from './particleSystem/particleSystem.ts';
import {
  defaultPreset,
  preset as presetByName,
  presetNames,
} from './particleSystem/defaultConfig.ts';

import presentSource from './app/debugPresent.wgsl';

/** The throwaway present pass. Step 5 replaces this with the real camera. */
interface PresentPass {
  render(encoder: GPUCommandEncoder, target: GPUTextureView, canvas: GPUTextureView): void;
}

async function createPresentPass(
  device: GPUDevice,
  format: GPUTextureFormat,
): Promise<PresentPass | null> {
  const module = await compileModule(device, 'debugPresent.wgsl', presentSource);
  if (module === null) return null;

  const layout = device.createBindGroupLayout({
    label: 'present',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ],
  });
  const pipeline = device.createRenderPipeline({
    label: 'debug-present',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: 'vs_main' },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { topology: 'triangle-strip' },
  });
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

  return {
    render(encoder, target, canvas) {
      // The bind group is rebuilt per frame because the canvas double-buffer
      // swaps underneath it -- the same reason the desktop hands the texture to
      // the camera per frame rather than letting it hold a reference
      // (ARCHITECTURE.md rule 3).
      const group = device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: canvas },
          { binding: 1, resource: sampler },
        ],
      });
      const pass = encoder.beginRenderPass({
        label: 'debug-present',
        colorAttachments: [
          {
            view: target,
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(4);
      pass.end();
    },
  };
}

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
  const present = await createPresentPass(device, surface.format);

  // The startup summary. `compileModule` logs each module, but a NULL pipeline
  // is the thing that actually matters and it is easy to miss in the noise.
  const status = { ...system.pipelineStatus(), debugPresent: present !== null };
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

    const encoder = device.createCommandEncoder({ label: 'frame' });
    system.runFrame(encoder);
    present?.render(
      encoder,
      surface.context.getCurrentTexture().createView(),
      system.currentCanvasTexture(),
    );
    device.queue.submit([encoder.finish()]);

    overlay?.update([
      `preset       ${preset.name}`,
      `frameCount   ${system.frameCount}`,
      `entities     ${system.entityCount}`,
      `canvas       ${system.canvasSize.join(' x ')}`,
      `window       ${surface.size().join(' x ')}`,
      `physicsSteps ${system.physicsSteps}`,
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
