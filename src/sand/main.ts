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
 *   1-9, 0   select one of the first ten swatches
 *   SPACE    pause / resume. The world starts PAUSED, arranging.
 *   R        restore the initial conditions (does nothing while authoring them)
 *   Shift+V  load a config from the clipboard into the first empty swatch
 *   left     apply the armed tool
 *   right    apply its inverse
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
import { DEFAULT_PREFERENCES, loadPreferences } from '../prefs/preferences.ts';
import { screenNdcToWorld, screenToNdc } from '../particleSystem/coords.ts';
import { SandOrchestrator } from './sandOrchestrator.ts';
import { SandUi } from './sandUi.ts';
import { BRUSH_ERASE, BRUSH_SPAWN, type BrushAction } from './brushInput.ts';
import { slotForDigit } from './palette.ts';
import { TOOL_CONFIG } from './tool.ts';
import {
  type SandSession,
  loadSession,
  readSlotDocument,
  saveSession,
  slotDocument,
} from './session.ts';
import { SandPrefs } from './sandPrefs.ts';
import { themeById } from './theme.ts';
import { readText } from '../ui/clipboard.ts';
import { decodeShareText } from '../config/shareLink.ts';
import { fromDocument } from '../config/persistence.ts';

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

  // `let`: the sand modality overrides `canvasAspect` for a fresh install, just
  // below, once the saved value has been read.
  let prefs = loadPreferences();
  // BEFORE sizing: a saved Max Particles has to size the buffer from the start,
  // rather than being applied afterwards as a resize the user did not ask for.
  const session = loadSession();

  // ---------------------------------------------------------------------
  // THE SAND WORLD IS 4:3.
  //
  // The studio defaults to a square canvas; this modality does not. The UI is a
  // tool rail down the left and a swatch tray along the bottom, so the space the
  // canvas is fitted into is landscape -- and a square world inside a landscape
  // hole wastes the width on either side of it.
  //
  // It is applied to the PREFERENCE rather than to the element, because
  // `canvasAspect` defines the shape of the SIMULATED WORLD (`sizing.ts`: "world
  // space is area-preserving, so the canvas keeps roughly the same pixel count
  // and the same particle density; it just gets wider and shorter"). Cropping
  // the element alone would letterbox a square world rather than give us a wide
  // one, which is not what "crop to the space the trail map fills" asks for.
  //
  // A saved `canvasAspect` still wins: this is a DEFAULT for a fresh install,
  // not an override of a value the user set in the Prefs tab.
  //
  // 5:3 rather than 4:3, which is what this first shipped as. The rail and the
  // tray take a fixed bite out of a landscape window, so the hole the canvas is
  // fitted into is wider than 4:3 and a 4:3 world left a visible margin either
  // side of it. 5:3 is a closer fit without going so wide that the world starts
  // reading as a strip.
  const SAND_CANVAS_ASPECT = 5 / 3;
  if (prefs.canvasAspect === DEFAULT_PREFERENCES.canvasAspect) {
    prefs = { ...prefs, canvasAspect: SAND_CANVAS_ASPECT };
  }

  const [derivedCount, canvasDim] = sizingFor(prefs.worldSize);
  const canvasSize = canvasDimensions(prefs.canvasAspect, canvasDim);
  const entityCount = session.maxParticles ?? derivedCount;

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

  // ---------------------------------------------------------------------
  // Restore the previous session, or open a fresh one.
  //
  // The palette is stored BY VALUE, so a square edited on the Config tab comes
  // back edited rather than reverting to the file it was loaded from. See
  // `session.ts`.
  // ---------------------------------------------------------------------
  let restoredAny = false;
  session.slots.forEach((stored, slot) => {
    const saved = readSlotDocument(stored.document);
    if (saved === null || saved.configs[0] === undefined) return;
    orch.palette.set(slot, {
      tool: TOOL_CONFIG,
      config: saved.configs[0],
      world: saved.world,
      name: stored.name,
    });
    restoredAny = true;
  });

  // The master square opens holding the default preset, so the world has a
  // trail persistence from the first frame and the compatibility test has
  // something to compare against. Only when nothing was restored -- otherwise
  // this would overwrite the square the user left there.
  if (!restoredAny && orch.palette.at(0).config === null) {
    orch.palette.set(0, {
      tool: TOOL_CONFIG,
      config: fallbackConfig,
      world: seed.world,
      name: seedEntry?.name ?? DEFAULT_PRESET_NAME,
    });
  }
  orch.palette.setVisibleCount(session.visibleCount);
  orch.palette.select(session.selected);
  orch.brush.setSize(session.brushSize);
  orch.brush.tool = session.tool;
  orch.brush.restoreStrengths(session.strengths);
  // So a later World Size change rebuilds at the capped count rather than
  // silently reverting to the derived one.
  orch.setMaxParticlesSetting(session.maxParticles);
  orch.applyPalette(fallbackConfig, defaultWorld);
  // From frame one, so a strength the user set in an earlier session applies
  // immediately rather than from whenever they next touch a control.
  orch.applyPreferences(prefs);

  // Which comp is up. Mutable: the Dev tab's dropdown swaps it, and `snapshot`
  // reads it so the choice survives a reload.
  let theme = themeById(session.theme);

  /** The current palette and brush state, as stored. */
  const snapshot = (): SandSession => ({
    slots: orch.palette.all().map((slot) => ({
      name: slot.name,
      // BY VALUE, so a swatch edited on the Config tab restores as edited
      // rather than reverting to the file it came from.
      document: slotDocument(slot.config, slot.world),
    })),
    selected: orch.palette.selected,
    brushSize: orch.brush.sizeSlot,
    tool: orch.brush.tool,
    strengths: orch.brush.allStrengths(),
    visibleCount: orch.palette.visibleCount,
    maxParticles: orch.maxParticlesSetting,
    theme: theme.id,
  });

  /**
   * Write the session to storage, debounced.
   *
   * The callers include a Config-tab slider that fires per frame of a drag, so
   * serializing twenty configs on each would be thousands of JSON writes for one
   * gesture. A short delay collapses a gesture into one write.
   */
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const persist = (): void => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveSession(snapshot());
    }, 400);
  };

  // A tab closing mid-debounce would otherwise lose the pending write.
  // `pagehide` rather than `beforeunload`: it fires on mobile backgrounding too.
  window.addEventListener('pagehide', () => {
    if (saveTimer === null) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    saveSession(snapshot());
  });

  const ui = new SandUi(orch.palette, store, {
    onSelect: (slot) => {
      orch.palette.select(slot);
      persist();
    },
    onBrushSize: (index) => {
      orch.brush.setSize(index);
      persist();
    },
    onTool: (tool) => {
      orch.brush.tool = tool;
      persist();
    },
    // "None". The palette refuses this for the master, so the menu hiding the
    // option and the model rejecting it agree -- see `Palette.clear`.
    onClearSlot: (slot) => {
      orch.palette.clear(slot);
      orch.applyPalette(fallbackConfig, defaultWorld);
      persist();
    },
    onStrength: (tool, value) => {
      orch.brush.setStrength(tool, value);
      persist();
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
          persist();
        } catch (e) {
          console.error(`Could not load ${entry.name}: ${String(e)}`);
        }
      })();
    },
  });

  // The comp the session left us on, and the shape the canvas is cropped to.
  // Both before the first frame, so nothing renders in the wrong skin or at the
  // wrong aspect and then jumps.
  ui.applyTheme(theme);
  ui.setCanvasAspect(system.canvasSize[0] / system.canvasSize[1]);

  // Preferences: world size, canvas aspect, physics rate, brightness, bloom.
  // Driven by the shared settings registry, so this window is a filter over
  // data the studio already declares rather than a second list of controls.
  //
  // `live` is what the frame loop reads. A preference change swaps the whole
  // object rather than mutating one, so a frame always renders one coherent set.
  let live = prefs;

  // -------------------------------------------------------------------------
  // THE STATUS LINE HAS TWO WRITERS, AND THE FRAME LOOP WAS WINNING EVERY TIME.
  //
  // The loop rewrites the status every frame with the standing "paused / N
  // particles / R restores" line. Every transient message -- saved, resized,
  // loaded, compacted, and every failure -- was therefore visible for at most
  // one frame before being overwritten, which is to say never.
  //
  // This was found because the Compact Now button "did nothing": it worked,
  // said so, and was erased ~16ms later. The messages below had been invisible
  // since they were written; nobody noticed because none of them was the only
  // evidence that a button had fired.
  //
  // `notify` parks a message with an expiry and the frame loop defers to it
  // until it lapses -- what the user just DID matters more than the standing
  // state for the few seconds after they did it.
  // -------------------------------------------------------------------------
  const NOTICE_MS = 4000;
  let notice: { text: string; until: number } | null = null;
  const notify = (text: string): void => {
    notice = { text, until: performance.now() + NOTICE_MS };
    ui.setStatus(text);
  };

  /**
   * The mark when a sweep started, held so its result can be reported.
   *
   * A SWEEP FINISHES ON A LATER FRAME than the button that began it, so the
   * outcome cannot be announced from the click handler -- that is the shape of
   * the thing. Non-null means "a sweep is in flight and its result is still to
   * be reported"; the frame loop watches for it to end.
   */
  let markBefore: number | null = null;
  /** True on the previous frame, to catch the edge where a sweep ends. */
  let wasSweeping = false;

  const prefsWindow = new SandPrefs(
    prefs,
    orch.palette,
    entityCount,
    { theme: theme.id, visibleCount: orch.palette.visibleCount },
    {
    onTheme: (next) => {
      theme = next;
      ui.applyTheme(next);
      persist();
    },
    // Display only -- capacity is fixed. See `palette.ts`.
    onVisibleCount: (count) => {
      orch.palette.setVisibleCount(count);
      persist();
    },
    onChange: (next) => {
      live = next;
      // Through the orchestrator, NOT by assigning to a captured `system`: a Max
      // Particles resize replaces that object, and a closure over the old one
      // wrote to a discarded system -- which is why these sliders appeared to
      // need a page refresh.
      orch.applyPreferences(next);
    },
    onRestartRequired: (next) => {
      live = next;
      void (async () => {
        try {
          notify('Rebuilding world…');
          await orch.applyWorldSize(next, fallbackConfig, defaultWorld);
          // A Canvas Aspect change reshapes the world, so the crop follows it.
          ui.setCanvasAspect(orch.system.canvasSize[0] / orch.system.canvasSize[1]);
          notify('World rebuilt — the scene was cleared');
        } catch (e) {
          console.error(`Could not rebuild the world: ${String(e)}`);
          notify(`World rebuild failed: ${String(e)}`);
        }
      })();
    },
    // A live edit rewrites that ConfigData slot, so every particle already
    // painted from the square obeys the new settings on the next step -- which
    // is what makes tweaking gravity to watch its effect useful at all.
    onConfigEdit: (slot, config, world) => {
      orch.palette.edit(slot, config, world);
      orch.applyPalette(fallbackConfig, defaultWorld);
      // Debounced, so a slider drag is one write rather than one per frame.
      persist();
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
          persist();
          notify(`Saved "${name}" to ${CUSTOM_CATEGORY}`);
        } catch (e) {
          console.error(`Could not save ${name}: ${String(e)}`);
          notify(`Save failed: ${String(e)}`);
        }
      })();
    },
    // MAX PARTICLES: rebuild the entity buffer at a new size, carrying the live
    // particles across. Heavy and deliberate, which is why it only fires on a
    // committed value -- see the field's note in sandPrefs.
    onMaxParticles: (count) => {
      void (async () => {
        try {
          notify(`Resizing to ${count.toLocaleString()} particles…`);
          await orch.resizeEntities(count, fallbackConfig, defaultWorld);
          persist();
          notify(`Max particles: ${count.toLocaleString()}`);
        } catch (e) {
          console.error(`Could not resize to ${count}: ${String(e)}`);
          notify(`Resize failed: ${String(e)}`);
        }
      })();
    },
    // COMPACTION. Not persisted, unlike the settings above: both of these are
    // diagnostics for the session in front of you, and a pause that survived a
    // reload would be a compaction silently off weeks later with no sign why.
    onCompactionPaused: (paused) => {
      orch.setCompactionPaused(paused);
      notify(paused ? 'Compaction paused' : 'Compaction resumed');
    },
    onCompactNow: () => {
      void (async () => {
        try {
          // Said BEFORE the await: this stalls the pipeline, so the message has
          // to land before the hitch rather than after it, or the user sees a
          // freeze with nothing explaining it.
          notify('Ordering the pool…');
          markBefore = orch.compactionStats.mark;
          const { started, reason } = await orch.compactNow();
          // The sweep is NOT awaited -- it runs in budgeted chunks over the
          // next second or two, and blocking on it would be the stutter this
          // whole design exists to avoid. The frame loop announces the result
          // when it lands; see `sweepWatch`.
          if (!started) {
            markBefore = null;
            notify(`Pool ordered — no sweep needed (${reason})`);
          } else {
            notify('Sweeping — relocating particles…');
          }
        } catch (e) {
          console.error(`Could not compact: ${String(e)}`);
          notify(`Compaction failed: ${String(e)}`);
        }
      })();
    },
    },
  );

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

    // Shift+V: adopt a config from the clipboard. Before the digit check, since
    // `V` is not a digit but the modifier makes the ordering worth being
    // explicit about.
    if (e.shiftKey && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault();
      void pasteIntoEmptySwatch();
      return;
    }

    const digit = slotForDigit(e.key);
    if (digit !== null) {
      orch.palette.select(digit);
      persist();
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      orch.togglePause();
    } else if (e.key === 'r' || e.key === 'R') {
      // Refused while the initial conditions are being authored -- the scene on
      // screen IS the arrangement, and restoring would discard it in favour of
      // an older one. Saying so beats a key that silently does nothing.
      if (!orch.reset()) {
        notify('Already editing the initial conditions — nothing to reset to');
      }
    }
  });

  /**
   * Shift+V -- decode a config from the clipboard into the first empty swatch.
   *
   * ## The decode is the studio's, exactly
   *
   * `decodeShareText` then `fromDocument`, which is the same two-step
   * `Panel.applyShareText` uses: the codec decides what the bytes ARE and
   * `persistence.ts` remains the only thing that decides what they MEAN. Doing
   * anything else here would make this a second reader of the format.
   *
   * The clipboard read falls back to a prompt for the reason `ui/clipboard.ts`
   * gives: Firefox does not implement `readText()` for page script at all, and
   * Chrome gates it behind a permission prompt, so `null` is an ordinary outcome
   * rather than an error.
   */
  async function pasteIntoEmptySwatch(): Promise<void> {
    const slot = orch.palette.firstEmpty();
    if (slot === null) {
      notify('No empty swatch — right-click one to load into it');
      return;
    }

    const clip = await readText();
    const text =
      clip !== null && clip.trim() !== ''
        ? clip
        : (window.prompt('Paste a Fluoddity share link or config:') ?? '');
    if (text.trim() === '') return;

    let saved;
    try {
      const doc = decodeShareText(text);
      if (doc === null) {
        notify('That does not look like a Fluoddity config');
        return;
      }
      saved = fromDocument(doc, 'clipboard');
    } catch (err: unknown) {
      notify('That config could not be read — it may have been truncated');
      console.warn(`Rejected a pasted config: ${String(err)}`);
      return;
    }

    const config = saved.configs[0];
    if (config === undefined) {
      notify('That config held no elements');
      return;
    }

    orch.palette.set(slot, {
      tool: TOOL_CONFIG,
      config,
      world: saved.world,
      name: 'Pasted',
    });
    // Selected as well as filled: the user pasted it to use it, and leaving the
    // selection on whatever was armed before would make the paste look like it
    // had gone somewhere else.
    orch.palette.select(slot);
    orch.applyPalette(fallbackConfig, defaultWorld);
    persist();
    notify(`Loaded into swatch ${slot + 1}`);
  }

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
    // The pool readouts. Self-guarding: it only touches Tweakpane when a
    // displayed value actually moved, so a static world costs the formatting.
    const poolStats = orch.compactionStats;
    prefsWindow.setCompactionStats(poolStats);

    // A SWEEP ENDS ON ITS OWN FRAME, so its result is reported here rather than
    // from the button that started it. The edge -- was sweeping, now is not --
    // is what marks the end, whether the sweep completed or was aborted by the
    // user picking up the brush.
    if (wasSweeping && !poolStats.sweeping && markBefore !== null) {
      const before = markBefore;
      markBefore = null;
      notify(
        poolStats.mark < before
          ? `Compacted — mark ${before.toLocaleString()} → ` +
              `${poolStats.mark.toLocaleString()}`
          : `Sweep ended with the mark unchanged at ${poolStats.mark.toLocaleString()}` +
              ' — aborted, or nothing could be moved',
      );
    }
    wasSweeping = poolStats.sweeping;
    ui.refresh({
      tool: orch.brush.tool,
      brushSize: orch.brush.sizeSlot,
      strength: orch.brush.weight,
      editingInitialConditions: orch.editingInitialConditions,
    });
    // A live notice outranks the standing line until it lapses -- see `notify`.
    // Without this the loop overwrote every transient message within a frame.
    if (notice !== null && performance.now() < notice.until) {
      ui.setStatus(notice.text);
    } else {
      notice = null;
      ui.setStatus(
        `${orch.paused ? 'PAUSED — arrange, then SPACE' : 'running'}  ·  ` +
          `~${orch.liveEstimate.toLocaleString()} particles  ·  ` +
          `${orch.hasInitialConditions ? 'R restores' : 'no initial conditions yet'}`,
      );
    }

    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}

void main().catch((e: unknown) => {
  console.error(e);
  showUnavailableOverlay('Could not start Fluoddity Sand', String(e));
});
