/**
 * Entry point.
 *
 * The desktop analogue is `main.py` (4 lines) plus the frame loop at
 * `orchestrator/orchestrator.py:256-365`. Step 1 has neither an Orchestrator
 * nor anything to orchestrate: this is the blocking `while not
 * window.should_close()` loop replaced by `requestAnimationFrame`, clearing to
 * black and nothing else.
 *
 * Steps 2-7 grow this into the real frame loop, at which point the ordering
 * constraints documented on the Python loop (pick-read before pick-write;
 * render inside the physics loop for motion blur; screen bind after the loop)
 * become load-bearing here too.
 */

import { acquireDevice, showUnavailableOverlay, WebGPUUnavailable } from './gpu/device.ts';
import { compileModule } from './gpu/shaderModule.ts';
import { createSurface } from './app/surface.ts';
import helloWgsl from './shaders/hello.wgsl';

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

  const surface = createSurface(canvas, device);

  // `helloWgsl` arrives with its #include already expanded by the Vite plugin.
  const module = await compileModule(device, 'hello', helloWgsl);

  // Invariant 5: callers guard on null. A failed compile leaves us with no
  // pipeline, and the loop below simply clears -- it does not crash, and it
  // does not stop, so an HMR edit that fixes the shader recovers.
  let pipeline: GPURenderPipeline | null = null;
  if (module !== null) {
    pipeline = device.createRenderPipeline({
      label: 'hello',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: surface.format }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  const frame = (): void => {
    if (deviceLost) return; // Stop cleanly rather than spinning on a dead device.

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: surface.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });

    if (pipeline !== null) {
      pass.setPipeline(pipeline);
      pass.draw(3);
    }

    pass.end();
    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);

  // Vite's HMR: re-import and recompile the shader in place rather than
  // reloading the page. This is dev-server ergonomics; it is NOT the runtime
  // reload affordance invariant 5 says the port should not carry (the `U` key,
  // the Simulation menu item, the Debug panel button) -- those stay gone.
  if (import.meta.hot) {
    import.meta.hot.accept('./shaders/hello.wgsl', async (mod) => {
      const source: unknown = mod?.default;
      if (typeof source !== 'string') return;
      const next = await compileModule(device, 'hello', source);
      if (next === null) return; // Logged, not fatal: keep the last good pipeline.
      pipeline = device.createRenderPipeline({
        label: 'hello',
        layout: 'auto',
        vertex: { module: next, entryPoint: 'vs_main' },
        fragment: { module: next, entryPoint: 'fs_main', targets: [{ format: surface.format }] },
        primitive: { topology: 'triangle-list' },
      });
    });
  }
}

start().catch((err: unknown) => {
  if (err instanceof WebGPUUnavailable) {
    showUnavailableOverlay('WebGPU unavailable', err.message);
  } else {
    showUnavailableOverlay('Startup failed', String(err));
  }
  console.error(err);
});
