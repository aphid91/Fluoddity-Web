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
import { createSurface } from './app/surface.ts';

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

  // NO SHADER IS COMPILED HERE, deliberately. Step 1's `hello.wgsl` and its
  // `common_stub.wgsl` were retired by Step 3, which replaced the stub with the
  // real `src/shaders/common.wgsl`. That file is pure declarations and pure
  // functions with no entry point, so it cannot form a pipeline on its own --
  // Step 4's `entity_update.wgsl` is its first consumer, and that is what wires
  // shader compilation back in here.
  //
  // Until then `common.wgsl` is validated by `common.wgsl.test.ts` (struct
  // layout, on every `npm test`) and by a manual browser compile check --
  // see "Verification" in web/README.md.
  //
  // `gpu/shaderModule.ts` is consequently unused for now. Keep it: Step 4 is
  // its caller, and invariant 5's log-don't-throw shape lives there.

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

    pass.end();
    device.queue.submit([encoder.finish()]);
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
