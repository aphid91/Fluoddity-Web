/**
 * Entry point for the sand modality.
 *
 * The counterpart of `src/main.ts`, and the same three jobs: acquire a device,
 * build the engine and the orchestrator, and turn `requestAnimationFrame` into
 * calls on them. What differs is everything above the engine -- the UI is a
 * hotbar rather than a registry panel, and a click paints rather than picks.
 *
 * ## Hotkeys
 *
 *   1-9, 0   select a palette square in the active row
 *   X        swap which row the number keys address
 *   SPACE    pause / resume. The world starts PAUSED, arranging.
 *   R        restore the initial conditions
 *   left     paint particles from the selected square
 *   right    erase
 */

import { acquireDevice, showUnavailableOverlay } from '../gpu/device.ts';
import { createSurface } from '../app/surface.ts';
import { RenderTargets } from '../app/renderTargets.ts';
import { Camera } from '../camera/camera.ts';
import { CameraState } from '../camera/cameraState.ts';
import { Assembler } from '../assembler/assembler.ts';
import { StrafeField } from '../strafeField/strafeField.ts';
import { ParticleSystem } from '../particleSystem/particleSystem.ts';
import {
  type ConfigEntry,
  CUSTOM_CATEGORY,
  ConfigStore,
  DEFAULT_PRESET_NAME,
} from '../config/configStore.ts';
import { toDocument } from '../config/persistence.ts';
import { BC, makeWorldSettings } from '../particleSystem/config.ts';
import { canvasDimensions, sizingFor } from '../particleSystem/sizing.ts';
import { loadPreferences } from '../prefs/preferences.ts';
import { screenNdcToWorld, screenToNdc } from '../particleSystem/coords.ts';
import { SandOrchestrator } from './sandOrchestrator.ts';
import { SandUi } from './sandUi.ts';
import { BRUSH_ERASE, BRUSH_SPAWN, type BrushAction } from './brushInput.ts';
import { positionForDigit, toolSlot } from './palette.ts';
import { TOOL_CONFIG } from './tool.ts';
import { SandPrefs } from './sandPrefs.ts';

/**
 * The first config in the catalog, in the order the menu shows.
 *
 * `order` rather than `Object.keys`, because the order is load-bearing -- Core
 * first, then alphabetically -- and JSON key order is insertion-ordered in every
 * engine but not specified to be.
 */
function firstEntry(store: ConfigStore): ConfigEntry | null {
  const catalog = store.catalog();
  for (const category of catalog.order) {
    const name = catalog.categories[category]?.[0];
    if (name !== undefined) {
      const entry = store.entry(category, name);
      if (entry !== null) return entry;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('app');
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('No <canvas id="app"> in the document.');
  }

  const { device } = await acquireDevice((info) => {
    showUnavailableOverlay('GPU device lost', info.message || String(info.reason));
  });
  const surface = createSurface(canvas, device);

  const prefs = loadPreferences();
  const [entityCount, canvasDim] = sizingFor(prefs.worldSize);
  const canvasSize = canvasDimensions(prefs.canvasAspect, canvasDim);

  // The world a sand scene runs under until a master config is loaded.
  //
  // BC_KILL is the point: a particle leaving the world is destroyed rather than
  // wrapped or respawned, which is requirement 7 and the worked example of the
  // sinks system.
  const defaultWorld = makeWorldSettings({ boundaryConditions: BC.KILL });

  const store = await ConfigStore.open();
  // The default preset if it is present, otherwise the first config in the
  // first ordered category -- a fresh install with a renamed default should
  // still open with something rather than failing.
  const seedEntry = store.entryByName(DEFAULT_PRESET_NAME) ?? firstEntry(store);
  const seed =
    seedEntry === null
      ? null
      : await store.read(seedEntry).catch(() => null);
  if (seed === null || seed.configs[0] === undefined) {
    throw new Error('No configs available to seed the palette.');
  }
  const fallbackConfig = seed.configs[0];

  const system = await ParticleSystem.create({
    device,
    config: fallbackConfig,
    world: defaultWorld,
    canvasSize,
    entityCount,
    // FROM WORLD SIZE, not from the entity count. They are the same number at
    // startup, but Max Particles moves the entity count alone -- so the scale
    // has to come from the thing that actually defines the world's size, or
    // raising the cap would silently retune every force.
    sqrtWorldSize: Math.sqrt(prefs.worldSize),
    physicsSteps: prefs.physicsSteps,
    // THE FLAG THAT MAKES THIS A SAND WORLD: particles can be born and die, the
    // free list is sized to the entity count, and the world starts empty.
    lifetimes: true,
  });

  const field = await StrafeField.create(device, system.canvasSize);
  field.setWrap(false);
  system.setStrafeField(field.view(), field.size);

  const targets = new RenderTargets(device);
  const camera = await Camera.create(device, new CameraState(), targets);
  const assembler = await Assembler.create(device, targets, surface.format);
  assembler.setStrafeField(field.view());

  const orch = await SandOrchestrator.create({
    device,
    system,
    camera,
    assembler,
    field,
    targets,
  });
  orch.fallbackWorld = defaultWorld;

  // The master square opens holding the default preset, so the world has a
  // trail persistence from the first frame and the compatibility test has
  // something to compare against.
  orch.palette.set(0, {
    tool: TOOL_CONFIG,
    config: fallbackConfig,
    world: seed.world,
    name: seedEntry?.name ?? DEFAULT_PRESET_NAME,
  });
  orch.applyPalette(fallbackConfig, defaultWorld);

  const ui = new SandUi(orch.palette, store, {
    onSelect: (slot) => orch.palette.select(slot),
    onBrushSize: (index) => orch.brush.setSize(index),
    // A field tool square carries no config, so the palette's ConfigData upload
    // is unaffected -- `configsForUpload` fills it with the master's stand-in
    // exactly as it does an empty square, and nothing points at it.
    onLoadTool: (slot, tool) => orch.palette.set(slot, toolSlot(tool)),
    onWeight: (weight) => {
      orch.brush.weight = weight;
    },
    onClear: (what) => {
      if (what === 'particles') orch.clearParticles();
      else orch.clearField(what);
    },
    onLoad: (slot, entry) => {
      void (async () => {
        try {
          const loaded = await store.read(entry);
          if (loaded.configs[0] === undefined) return;
          orch.palette.set(slot, {
            tool: TOOL_CONFIG,
            config: loaded.configs[0],
            world: loaded.world,
            name: entry.name,
          });
          orch.applyPalette(fallbackConfig, defaultWorld);
        } catch (e) {
          console.error(`Could not load ${entry.name}: ${String(e)}`);
        }
      })();
    },
  });

  // Preferences: world size, canvas aspect, physics rate, brightness, bloom.
  // Driven by the shared settings registry, so this window is a filter over
  // data the studio already declares rather than a second list of controls.
  //
  // `live` is what the frame loop reads. A preference change swaps the whole
  // object rather than mutating one, so a frame always renders one coherent set.
  let live = prefs;
  const prefsWindow = new SandPrefs(prefs, orch.palette, entityCount, {
    onChange: (next) => {
      live = next;
      system.physicsSteps = next.physicsSteps;
    },
    onRestartRequired: (next) => {
      live = next;
      // The snapshot holds copies of buffers that a resize replaces, so it
      // describes a world that will no longer exist. Dropping it is better than
      // keeping one that errors on use.
      orch.invalidateInitialConditions();
      // Rebuilding the whole system at a new size is a larger change than this
      // step takes on; the user is told rather than silently ignored.
      console.warn(
        'World Size and Canvas Aspect take effect on reload in this modality.',
      );
    },
    // A live edit rewrites that ConfigData slot, so every particle already
    // painted from the square obeys the new settings on the next step -- which
    // is what makes tweaking gravity to watch its effect useful at all.
    onConfigEdit: (slot, config, world) => {
      orch.palette.edit(slot, config, world);
      orch.applyPalette(fallbackConfig, defaultWorld);
    },
    onSaveConfig: (slot, name) => {
      void (async () => {
        const entry = orch.palette.at(slot);
        if (entry.config === null || entry.world === null) return;
        try {
          // The SAME custom library the studio writes to, through the same
          // document writer -- so a config saved here opens there unchanged.
          await store.write(
            CUSTOM_CATEGORY,
            name,
            toDocument([entry.config], entry.world),
          );
          // Rename the square to what was just saved, so the palette reflects
          // where the settings now live.
          orch.palette.set(slot, { ...entry, name });
          ui.setStatus(`Saved "${name}" to ${CUSTOM_CATEGORY}`);
        } catch (e) {
          console.error(`Could not save ${name}: ${String(e)}`);
          ui.setStatus(`Save failed: ${String(e)}`);
        }
      })();
    },
    // MAX PARTICLES: rebuild the entity buffer at a new size, carrying the live
    // particles across. Heavy and deliberate, which is why it only fires on a
    // committed value -- see the field's note in sandPrefs.
    onMaxParticles: (count) => {
      void (async () => {
        try {
          ui.setStatus(`Resizing to ${count.toLocaleString()} particles…`);
          await orch.resizeEntities(count, fallbackConfig, defaultWorld);
          ui.setStatus(`Max particles: ${count.toLocaleString()}`);
        } catch (e) {
          console.error(`Could not resize to ${count}: ${String(e)}`);
          ui.setStatus(`Resize failed: ${String(e)}`);
        }
      })();
    },
  });

  // --- input --------------------------------------------------------------
  // Owned here, in one place, for the reason `ui/` owns every callback in the
  // studio: two modules installing listeners on the same canvas means ambiguity
  // about who sees a click first.

  let pointer: { x: number; y: number } | null = null;
  let buttons = 0;
  /** Shift arms the line tool in the painting tools. Tracked on both edges. */
  let shiftHeld = false;

  canvas.addEventListener('pointermove', (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    buttons = e.buttons;
  });
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointer = { x: e.clientX, y: e.clientY };
    buttons = e.buttons;
  });
  const endStroke = (e: PointerEvent): void => {
    buttons = e.buttons;
    // The stroke ends when the LAST button comes up, so releasing one of two
    // held buttons does not break a drag that is still in progress.
    if (buttons === 0) orch.brush.release();
  };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('pointerleave', () => {
    pointer = null;
    buttons = 0;
    orch.brush.release();
  });
  // Right-drag is the eraser, so the context menu must not interrupt it.
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('keyup', (e) => {
    shiftHeld = e.shiftKey;
  });
  // Releasing focus mid-gesture would otherwise leave Shift stuck on.
  window.addEventListener('blur', () => {
    shiftHeld = false;
  });

  window.addEventListener('keydown', (e) => {
    shiftHeld = e.shiftKey;
    // A typed field owns its own keys -- the Weight input in particular, where
    // `1`-`0` must enter digits rather than switch palette squares.
    if (e.target instanceof HTMLInputElement) return;

    if (e.key === 'Escape') {
      ui.closeLoader();
      return;
    }
    // The browser is modal: it would be confusing for the world to keep
    // responding to keys aimed at a list of configs.
    if (ui.loaderOpen) return;

    const digit = positionForDigit(e.key);
    if (digit !== null) {
      orch.palette.selectPosition(digit);
      return;
    }
    if (e.key === 'x' || e.key === 'X') {
      orch.palette.swapRows();
    } else if (e.key === ' ') {
      e.preventDefault();
      orch.togglePause();
    } else if (e.key === 'r' || e.key === 'R') {
      orch.reset();
    }
  });

  // --- frame loop ----------------------------------------------------------

  let last = performance.now();

  const frame = (now: number): void => {
    // Clamped: a backgrounded tab returns a dt of many seconds, which would ask
    // the brush for a whole world's worth of particles in one frame.
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;

    const size = surface.size();
    let cursor = null;
    if (pointer !== null) {
      const rect = canvas.getBoundingClientRect();
      const px: readonly [number, number] = [
        ((pointer.x - rect.left) / rect.width) * size[0],
        ((pointer.y - rect.top) / rect.height) * size[1],
      ];
      const state = camera.state;
      cursor = screenNdcToWorld(
        screenToNdc(px, size),
        system.canvasSize,
        size,
        state.pan,
        state.zoom,
      );
    }

    let action: BrushAction | null = null;
    if ((buttons & 1) !== 0) action = BRUSH_SPAWN;
    else if ((buttons & 2) !== 0) action = BRUSH_ERASE;

    orch.runFrame(
      { cursor, action, windowSize: size, dt, shift: shiftHeld },
      // `live`, not the startup `prefs`: brightness and bloom apply as the
      // sliders move rather than on the next reload.
      live,
      surface.context.getCurrentTexture().createView(),
    );

    // Rebuilds the Config tab only when the selection or a square's contents
    // actually changed -- see `syncConfig`.
    prefsWindow.syncConfig();
    ui.refresh(orch.brush.sizeSlot);
    ui.setStatus(
      `${orch.paused ? 'PAUSED — arrange, then SPACE' : 'running'}  ·  ` +
        `~${orch.liveEstimate.toLocaleString()} particles  ·  ` +
        `${orch.hasInitialConditions ? 'R restores' : 'no initial conditions yet'}`,
    );

    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}

void main().catch((e: unknown) => {
  console.error(e);
  showUnavailableOverlay('Could not start Fluoddity Sand', String(e));
});
