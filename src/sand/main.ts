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
 *   1-9, 0   select one of the first ten swatches the bar shows
 *   SPACE    pause / resume. The world starts PAUSED, arranging.
 *   R        restore the initial conditions (does nothing while authoring them)
 *   Shift+V  load a config from the clipboard into the first empty swatch
 *            (the load menu's "Paste from link…" does the same for any swatch)
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
import type { Preferences } from '../prefs/preferences.ts';
import {
  loadSandPreferences as loadPreferences,
  saveSandPreferences as savePreferences,
} from './sandPreferences.ts';
import { decodeStamp, encodeStamp } from '../stamp/stampCodec.ts';
import type { StampData } from '../stamp/stampData.ts';
import type { StampBox } from '../stamp/stampBox.ts';
import { activeRegion, placeScene, planFit, trimScene } from './icFit.ts';
import { readSandDefaults, writeSandDefaults } from './sandDefaults.ts';
// BUNDLED, not fetched: the defaults are part of the build, so a new visitor
// has them on the first frame with no request that could fail. Replace this
// file with one from the Dev tab's "Export settings" to change them.
import sandDefaultsFile from './sandDefaults.json';

/** What a new visitor starts with. See `sandDefaults.ts`. */
const SAND_DEFAULTS = readSandDefaults(sandDefaultsFile);
import { screenNdcToWorld, screenToNdc } from '../particleSystem/coords.ts';
import { SandOrchestrator } from './sandOrchestrator.ts';
import { SandUi } from './sandUi.ts';
import { BRUSH_ERASE, BRUSH_SPAWN, type BrushAction } from './brushInput.ts';
import {
  ASSIGNABLE_WORLDS,
  MASTER_SLOT,
  SLOT_COUNT,
  cycleSlot,
  slotForDigit,
} from './palette.ts';
import { WorldStore } from '../worlds/worldStore.ts';
import { BuiltinWorlds, type WorldRecord } from '../worlds/builtinWorlds.ts';
import { type ExportButton, buildPackZip } from '../worlds/packExport.ts';
import { builtinRef, parseWorldRef } from '../worlds/worldRef.ts';
import { WorldLoaderUi } from '../worlds/worldLoaderUi.ts';
import {
  applyWorldPreferences,
  makeWorldDocument,
  mapWorldIcons,
  readWorld,
} from '../worlds/worldFormat.ts';
import { TOOL_CONFIG, cycleTool } from './tool.ts';
import {
  type SourceSwatch,
  CUSTOM_SOURCE,
  OPEN_SOURCE,
  listSwatchSources,
  swatchesFromStored,
  swatchesFromWorld,
  worldRefOfKey,
} from './swatchSources.ts';
import { defaultSwatchColor } from './swatchColor.ts';
import { SWATCH_ICON_PX, WORLD_ICON_PX, readSwatchIcon } from './swatchIcon.ts';
import { captureCircleIcon, inlineIcon } from './iconCapture.ts';
import {
  CUSTOM_WORLD,
  type SandSession,
  type StoredSlot,
  hasStoredSession,
  loadSession,
  readSlotDocument,
  saveSession,
  slotDocument,
} from './session.ts';
import { SandPrefs } from './sandPrefs.ts';
import { Webcam } from '../webcam/webcam.ts';
import { SAND_CAMERA_STORAGE_KEY } from '../webcam/webcamSettings.ts';
import { themeById } from './theme.ts';
import { readText } from '../ui/clipboard.ts';
import { decodeShareText } from '../config/shareLink.ts';
import { fromDocument } from '../config/persistence.ts';
import { formatAudit, summarizeAudit } from '../particleSystem/poolAudit.ts';

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

  // THE DEFAULT WORLD PACK, fetched alongside the device rather than after it.
  // Null when there is none -- see `builtinWorlds.ts`.
  const builtinsLoading = BuiltinWorlds.load();

  const { device } = await acquireDevice((info) => {
    showUnavailableOverlay('GPU device lost', info.message || String(info.reason), true);
  });
  const surface = createSurface(canvas, device);

  // `let`: a loaded world replaces it.
  //
  // SAND'S OWN RECORD, not the studio's -- see `sandPreferences.ts`. Its
  // `worldSize` is the TARGET world size; its `canvasAspect` is never used,
  // because the world's shape follows the canvas (see `rebuildWorld`).
  let prefs = loadPreferences(SAND_DEFAULTS.preferences);
  // BEFORE sizing: a saved Max Particles has to size the buffer from the start,
  // rather than being applied afterwards as a resize the user did not ask for.
  // A new visitor's session starts from the shipped defaults too.
  const stored = loadSession(undefined, SAND_DEFAULTS.session);
  // A NEW VISITOR starts where the world pack says: on its start world, with
  // its Custom palette. A returning one keeps their own -- their buttons still
  // follow the pack (`SandSession.worldRefs`), which is how new default worlds
  // reach them.
  const builtins = await builtinsLoading;
  const session: SandSession =
    builtins !== null && !hasStoredSession()
      ? {
          ...stored,
          slots: builtins.pack.customSlots,
          selectedWorld: builtins.pack.selectedWorld,
          worldIcon: builtins.pack.customIcon,
        }
      : stored;

  const store = await ConfigStore.open();

  // ---------------------------------------------------------------------
  // THE UI FIRST, BEFORE THE WORLD.
  //
  // The world is built to the CANVAS'S SHAPE, and the canvas is whatever the
  // sidebar and the swatch bar leave -- so the shell has to be laid out before
  // there is a shape to build to. The callbacks name things created further
  // down (`orch`, `persist`, `notify`...); none of them can fire until startup
  // has finished and the user presses something.
  // ---------------------------------------------------------------------
  const ui = new SandUi(store, {
    onSelect: (slot) => {
      selectSwatch(slot);
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
    onPasteLink: (slot) => {
      void pasteIntoSwatch(slot);
    },
    onClearSlot: (slot) => {
      orch.palette.clear(slot);
      orch.applyPalette(fallbackConfig, defaultWorld);
      persist();
    },
    onCaptureSlotIcon: (slot) => {
      void captureIcon(
        SWATCH_ICON_PX,
        `Drag a circle to picture swatch ${slot + 1}. Esc or a tap clears its icon.`,
        (icon) => {
          orch.palette.setIcon(slot, icon);
          return icon === null
            ? `Swatch ${slot + 1} is back to its colour`
            : `Captured an icon for swatch ${slot + 1}`;
        },
      );
    },
    // A display name only: the settings, colour and icon stay as they are.
    // `set` with a spread, the same move Save Config makes when it renames the
    // square to what it just saved -- so the icon survives (see `PaletteSlot`).
    onRenameSlot: (slot) => {
      const entry = orch.palette.at(slot);
      if (entry.config === null) return;
      const typed = window.prompt(`Rename swatch ${slot + 1}:`, entry.name);
      if (typed === null) return;
      const name = typed.trim();
      if (name === '' || name === entry.name) return;
      orch.palette.set(slot, { ...entry, name });
      persist();
      notify(`Renamed swatch ${slot + 1} to "${name}"`);
    },
    // THE LOAD MENU'S WORLDS SECTION. See `swatchSources.ts`.
    swatchSources: () => {
      const openRef = selectedWorld === CUSTOM_WORLD ? null : effectiveRef(selectedWorld);
      return listSwatchSources({
        openLabel: openRef === null ? 'Custom' : worldLabel(openRef),
        customIsOpen: openRef === null,
        customAvailable: (customSlots ?? []).some((s) => s.document !== null),
        worlds: [
          ...(builtins?.pack.worlds ?? []).map((w) => ({
            ref: builtinRef(w.id),
            label: w.name,
          })),
          ...worldStore.names().map((name) => ({ ref: name, label: name })),
        ],
        openRef,
      });
    },
    readSwatchSource: async (key) => {
      // The two live palettes are read fresh every time -- they change under
      // the menu, and are cheap. Only saved worlds are cached.
      if (key === OPEN_SOURCE) return swatchesFromStored(paletteSlots());
      if (key === CUSTOM_SOURCE) return swatchesFromStored(customSlots ?? []);
      const cached = swatchSourceCache.get(key);
      if (cached !== undefined) return cached;
      const ref = parseWorldRef(worldRefOfKey(key) ?? '');
      if (ref === null) return null;
      let swatches: readonly SourceSwatch[] | null = null;
      try {
        // A built-in's document alone; a library record brings its scene with
        // it, which is the cost the cache is for.
        const document =
          ref.kind === 'builtin'
            ? await (builtins?.readDocument(ref.id) ?? null)
            : (await worldStore.read(ref.name))?.document;
        if (document !== null && document !== undefined) {
          swatches = swatchesFromWorld(readWorld(document, `world "${key}"`));
        }
      } catch (e) {
        console.error(`Could not read the swatches of ${key}: ${String(e)}`);
      }
      swatchSourceCache.set(key, swatches);
      return swatches;
    },
    // THE WHOLE SWATCH: material, name, icon and colour. Loading a config
    // leaves the slot's colour alone; this deliberately does not -- see
    // `swatchSources.ts`. Otherwise the same steps as `onLoad`.
    onLoadSwatch: (slot, swatch) => {
      const saved = readSlotDocument(swatch.document);
      if (saved === null || saved.configs[0] === undefined) {
        notify(`Could not read "${swatch.name}"`);
        return;
      }
      orch.palette.set(slot, {
        tool: TOOL_CONFIG,
        config: saved.configs[0],
        world: saved.world,
        name: swatch.name,
        ...(swatch.icon === undefined ? {} : { icon: swatch.icon }),
      });
      if (swatch.color !== undefined) orch.palette.setColor(slot, swatch.color);
      orch.applyPalette(fallbackConfig, defaultWorld);
      selectSwatch(slot);
      notify(`Loaded "${swatch.name}" into swatch ${slot + 1}`);
    },
    onSelectWorld: (index) => {
      void selectWorld(index);
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
          // Selected, with the brush armed: an element is loaded to be painted
          // with, so the next stroke should lay it down without another click.
          selectSwatch(slot);
        } catch (e) {
          console.error(`Could not load ${entry.name}: ${String(e)}`);
        }
      })();
    },
    onPlay: () => startRunning(),
    onPause: () => stopRunning(),
    onReset: () => {
      if (!orch.reset()) {
        notify('Already editing the initial conditions — nothing to reset to');
      }
    },
    onClearParticles: () => {
      arrangementTouched = true;
      orch.clearParticles();
      notify('Cleared all particles');
    },
    onClearWalls: () => {
      arrangementTouched = true;
      orch.clearField('walls');
      notify('Cleared all walls');
    },
    onRestoreWalls: () => {
      arrangementTouched = true;
      notify(
        orch.restoreWalls()
          ? 'Restored the initial walls'
          : 'No initial conditions yet — they are set when you first press Play',
      );
    },
    onShoveDirection: (pull) => {
      orch.shovePull = pull;
    },
    onEraseMode: (mode) => {
      orch.eraseMode = mode;
      persist();
    },
    onSetInitialConditions: () => setInitialConditions(),
    onNotBuilt: (what) => notify(`${what} is not built yet`),
  });

  // ---------------------------------------------------------------------
  // THE WORLD'S SHAPE IS THE CANVAS'S.
  //
  // `canvasAspect` defines the shape of the SIMULATED WORLD (`sizing.ts`: world
  // space is area-preserving, so a different aspect keeps the pixel count and
  // the particle density and makes the world wider or taller). It is the
  // canvas's own, so the world fills the canvas exactly -- except when a
  // loaded scene needs a letterboxed shape (`icFit.ts`).
  //
  // Applied to a COPY of the preferences at every build, never stored -- see
  // `prefs` above and `rebuildWorld` below.
  // ---------------------------------------------------------------------
  const [derivedCount, canvasDim] = sizingFor(prefs.worldSize);
  const canvasSize = canvasDimensions(ui.canvasAspect(), canvasDim);
  const entityCount = session.maxParticles ?? derivedCount;

  // The world a sand scene runs under until a master config is loaded.
  //
  // BC_KILL is the point: a particle leaving the world is destroyed rather than
  // wrapped or respawned, which is requirement 7 and the worked example of the
  // sinks system.
  const defaultWorld = makeWorldSettings({ boundaryConditions: BC.KILL });
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

  // THE CAMERA, one for the session and bound into every world the orchestrator
  // builds -- see `Webcam`'s header. Sand keeps its own saved setup, apart from
  // the studio's, as it keeps its own Preferences. The camera opens only when
  // the Camera tab's Start is pressed.
  const webcam = await Webcam.create(device, SAND_CAMERA_STORAGE_KEY);
  system.setCameraField(webcam.fieldView);

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
    webcam,
  });
  orch.fallbackWorld = defaultWorld;
  ui.attach(orch.palette);

  // ---------------------------------------------------------------------
  // Restore the previous session, or open a fresh one.
  //
  // The palette is stored BY VALUE, so a square edited on the Config tab comes
  // back edited rather than reverting to the file it was loaded from. See
  // `session.ts`.
  // ---------------------------------------------------------------------
  let restoredAny = false;
  session.slots.forEach((stored, slot) => {
    // THE COLOUR FIRST, and outside the document guard: a swatch may have been
    // coloured while still empty, and that is work the author did. An absent
    // colour leaves the spaced default in place rather than overwriting it.
    if (stored.color !== undefined) orch.palette.setColor(slot, stored.color);

    const saved = readSlotDocument(stored.document);
    if (saved === null || saved.configs[0] === undefined) return;
    orch.palette.set(slot, {
      tool: TOOL_CONFIG,
      config: saved.configs[0],
      world: saved.world,
      name: stored.name,
      ...(stored.icon === undefined ? {} : { icon: stored.icon }),
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
  orch.brush.restoreSizes(session.brushSizes);
  orch.brush.tool = session.tool;
  orch.brush.restoreStrengths(session.strengths);
  orch.eraseMode = session.eraseMode;
  // So a later World Size change rebuilds at the capped count rather than
  // silently reverting to the derived one.
  orch.setMaxParticlesSetting(session.maxParticles);
  // THE DEV TAB'S COMPACTION SWITCHES, restored before the first frame so the
  // pool behaves as the panel will claim it does from frame one rather than
  // from whenever the user next touches a control. See `SandSession`.
  orch.setAutoCompact(session.autoCompact);
  orch.setCompactionPaused(session.compactionPaused);
  // A display choice, read by the next rendered frame -- so setting it here is
  // enough and nothing has to be rebuilt.
  orch.colorMode = session.colorMode;
  orch.applyPalette(fallbackConfig, defaultWorld);
  // From frame one, so a strength the user set in an earlier session applies
  // immediately rather than from whenever they next touch a control.
  orch.applyPreferences(prefs);

  // Which comp is up. Mutable: the Dev tab's dropdown swaps it, and `snapshot`
  // reads it so the choice survives a reload.
  let theme = themeById(session.theme);

  // ---------------------------------------------------------------------
  // WORLDS. What each button loads, and which button is lit.
  //
  // Mutable for the same reason `theme` is: the Dev tab writes them and
  // `snapshot` reads them back, so an author's layout survives a reload.
  //
  // `worldRefs` is padded to every button here rather than wherever it is
  // read, so every consumer can index it without a bounds check. NULL FOLLOWS
  // THE PACK -- `effectiveRef` is what a button actually loads.
  // ---------------------------------------------------------------------
  const worldRefs: (string | null)[] = Array.from(
    { length: ASSIGNABLE_WORLDS },
    (_, i) => session.worldRefs[i] ?? null,
  );
  /** What button `index` loads: its own reference, or the pack's. '' for nothing. */
  const effectiveRef = (index: number): string =>
    worldRefs[index] ?? builtinRef(builtins?.pack.assignments[index] ?? '');
  let selectedWorld = session.selectedWorld;

  /**
   * CUSTOM'S OWN SWATCH COUNT, held apart from the live one.
   *
   * ## The leak this closes
   *
   * A world overrides the visible count -- that is the requirement, and the dev
   * slider governs Custom alone from here on. But the session stores whatever
   * the palette happens to be showing, so loading a world would write the
   * WORLD'S count into Custom's saved state, and switching back would leave
   * Custom permanently displaying a number its author never chose.
   *
   * Tracking Custom's count separately is what makes the override temporary
   * rather than contagious. The dev slider writes here as well as to the
   * palette, so adjusting it while on Custom is what it always was, and the
   * session stores THIS rather than the live value.
   */
  let customVisibleCount = session.visibleCount;

  /**
   * CUSTOM'S PALETTE, held while a preset world is loaded.
   *
   * ## Without this, visiting a world destroys Custom
   *
   * `snapshot()` stores whatever the palette currently holds, so loading a
   * world and then reloading the page would bring the WORLD'S materials back as
   * Custom's -- silently replacing whatever the user had built there, with no
   * way to get it back.
   *
   * Custom is the one world whose edits are meant to persist between sessions;
   * a preset's are not, which is the whole point of being able to reset one by
   * pressing it again. So Custom's palette is set aside when leaving it and put
   * back on return, and `snapshot` stores THIS while a preset is loaded.
   *
   * Null only while Custom itself is active, when the live palette is the
   * authority and there is nothing to hold.
   */
  // SEEDED FROM THE SESSION when it was left on a preset. The stored slots ARE
  // Custom's -- `snapshot` wrote them there rather than the preset's -- so a
  // session that closed on World 2 still has Custom's materials waiting, and
  // the first press of Custom restores them rather than finding nothing.
  let customSlots: readonly StoredSlot[] | null =
    session.selectedWorld === CUSTOM_WORLD ? null : session.slots;

  /**
   * THE CURRENT WORLD'S ICON, for its World menu swatch, or null for the
   * stand-in artwork. Set by a world load and by "Capture world swatch icon";
   * saved with the world. Like a palette edit, a capture on a preset lasts
   * until that world is loaded again.
   */
  let worldIcon: string | null = null;
  /**
   * CUSTOM'S icon. The live one while Custom is active, and held here, like
   * `customSlots`, while a preset is loaded -- but always current, so
   * `snapshot` and the Custom button can read it either way.
   */
  let customWorldIcon: string | null = session.worldIcon;
  if (session.selectedWorld === CUSTOM_WORLD) worldIcon = customWorldIcon;
  /** Set the open world's icon -- Custom's too, when Custom is the world. */
  const setWorldIcon = (icon: string | null): void => {
    worldIcon = icon;
    if (selectedWorld === CUSTOM_WORLD) customWorldIcon = icon;
  };

  /** The live palette, in the session's stored shape. */
  const paletteSlots = (): StoredSlot[] =>
    orch.palette.all().map((slot, index) => ({
      name: slot.name,
      // BY VALUE, so a swatch edited on the Config tab restores as edited
      // rather than reverting to the file it came from.
      document: slotDocument(slot.config, slot.world),
      // EVEN WHEN THE SWATCH IS EMPTY -- a half-coloured palette is work in
      // progress and must survive a reload. See `StoredSlot.color`.
      color: orch.palette.colorOf(index),
      ...(slot.icon === undefined ? {} : { icon: slot.icon }),
    }));

  const worldStore = await WorldStore.open();
  /**
   * Saved worlds' swatches, as the load menu's Worlds section read them, by
   * source key. Null records a world that could not be read, so a broken one
   * is not re-fetched on every expand. Cleared on any world save or delete --
   * coarse, but those are rare and a re-read is one world.
   */
  const swatchSourceCache = new Map<string, readonly SourceSwatch[] | null>();

  /** A world's display name: the pack's for a built-in one, the save's otherwise. */
  const worldLabel = (ref: string): string => {
    const r = parseWorldRef(ref);
    if (r === null) return '';
    return r.kind === 'builtin' ? (builtins?.find(r.id)?.name ?? r.id) : r.name;
  };
  /** Whether a reference still names a world that exists. */
  const worldPresent = (ref: string): boolean => {
    const r = parseWorldRef(ref);
    if (r === null) return false;
    return r.kind === 'builtin'
      ? (builtins?.find(r.id) ?? null) !== null
      : worldStore.names().includes(r.name);
  };
  /**
   * Library worlds' icons, for the World menu. Read once per world and cached:
   * a library read brings the whole scene with it, so the menu must not do one
   * per frame. Kept current by `saveWorld` and the library's delete.
   */
  const libraryIcons = new Map<string, string | null>();
  const iconOfDocument = (document: unknown): string | null =>
    typeof document === 'object' && document !== null
      ? readSwatchIcon((document as Record<string, unknown>)['icon'])
      : null;
  /** What a world button shows when it is not the world that is open. */
  const savedWorldIcon = (ref: string): string | null => {
    const r = parseWorldRef(ref);
    if (r === null) return null;
    if (r.kind === 'builtin') return builtins?.iconUrl(r.id) ?? null;
    if (libraryIcons.has(r.name)) return libraryIcons.get(r.name) ?? null;
    // Null while the read is in flight, so it starts only once.
    libraryIcons.set(r.name, null);
    void worldStore
      .read(r.name)
      .then((record) => libraryIcons.set(r.name, iconOfDocument(record?.document)))
      .catch(() => undefined);
    return null;
  };
  /** A world's document and scene, from the pack or the library. */
  const readWorldRecord = async (ref: string): Promise<WorldRecord | null> => {
    const r = parseWorldRef(ref);
    if (r === null) return null;
    if (r.kind === 'builtin') return builtins === null ? null : builtins.read(r.id);
    return worldStore.read(r.name);
  };
  /** What the Dev tab's world dropdowns offer. */
  const worldChoices = () => ({
    builtins: (builtins?.pack.worlds ?? []).map((w) => ({ ref: builtinRef(w.id), label: w.name })),
    library: worldStore.names(),
    packDefaults: Array.from({ length: ASSIGNABLE_WORLDS }, (_, i) =>
      worldLabel(builtinRef(builtins?.pack.assignments[i] ?? '')),
    ),
  });

  /** The current palette and brush state, as stored. */
  const snapshot = (): SandSession => ({
    // CUSTOM'S PALETTE, which is the live one only while Custom is active. A
    // preset's materials are the world's and must not be written back as the
    // user's own -- see `customSlots`.
    slots: customSlots ?? paletteSlots(),
    selected: orch.palette.selected,
    brushSizes: orch.brush.allSizes(),
    tool: orch.brush.tool,
    strengths: orch.brush.allStrengths(),
    eraseMode: orch.eraseMode,
    // CUSTOM'S COUNT, not the live one -- see `customVisibleCount`. Storing
    // the live value would let a loaded world's override leak into Custom.
    visibleCount: customVisibleCount,
    maxParticles: orch.maxParticlesSetting,
    theme: theme.id,
    worldRefs: [...worldRefs],
    selectedWorld,
    // The Dev tab's compaction switches. Read from the orchestrator rather than
    // from a mirror here, so the stored value is what is actually in force.
    autoCompact: orch.compactionStats.autoCompact,
    compactionPaused: orch.compactionStats.paused,
    auditAfterSweep,
    colorMode: orch.colorMode,
    worldIcon: customWorldIcon,
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

  /**
   * Select a swatch AND arm the Brush.
   *
   * ## Why picking a material chooses the tool that uses it
   *
   * Only Brush reads the swatch (`usesSwatch`), so with any other tool armed the
   * tray is dimmed and a selection is inert -- the user picks a material and
   * nothing about the next stroke changes. Reaching for a swatch is therefore
   * already a statement of intent to paint it, and making that arm the Brush is
   * what turns the tray back into something that answers.
   *
   * THE COST, stated because it is real: a scroll can no longer preview swatches
   * without leaving the tool you were on. Erase + scroll now lands you in Brush.
   * That is the trade the requirement asks for, and it is the right way round --
   * silently selecting into a dimmed tray was the worse of the two.
   *
   * Every selection path routes through here -- click, digit key and scroll --
   * so none of them can drift from the others about this.
   */
  const selectSwatch = (slot: number): void => {
    orch.palette.select(slot);
    orch.brush.tool = 'brush';
    persist();
  };

  // The look the session left us on, before the first frame so nothing renders
  // in the wrong skin and then jumps.
  ui.applyTheme(theme);

  // Preferences: world size, canvas aspect, physics rate, brightness, bloom.
  // Driven by the shared settings registry, so this window is a filter over
  // data the studio already declares rather than a second list of controls.
  //
  // `live` is what the frame loop reads. A preference change swaps the whole
  // object rather than mutating one, so a frame always renders one coherent set.
  let live = prefs;

  // ---------------------------------------------------------------------
  // REBUILDING THE WORLD: for World Size, for a loaded world, and when the
  // canvas changes shape.
  //
  // SERIALIZED. A resize can land while a World Size rebuild is still being
  // awaited; running two `applyWorldSize` calls at once would have both swap
  // systems under each other. Each request waits for the one before it.
  //
  // A RESHAPE PUTS THE INITIAL CONDITIONS BACK, placed to fit the new shape
  // (`refitWorld`), or empties the world when there are none.
  // ---------------------------------------------------------------------
  /**
   * What the current world was built at: its world size and shape, and the
   * SCREEN's shape at the time. A letterboxed world's shape differs from the
   * screen's, so a resize is judged against the screen, not the world.
   */
  let built = {
    worldSize: prefs.worldSize,
    worldAspect: canvasSize[0] / canvasSize[1],
    screenAspect: ui.canvasAspect(),
  };
  let rebuildChain: Promise<void> = Promise.resolve();
  /** Run `work` after every rebuild already queued. See SERIALIZED above. */
  const queued = (work: () => Promise<void>): Promise<void> => {
    rebuildChain = rebuildChain.then(async () => {
      try {
        await work();
      } catch (e) {
        console.error(`Could not rebuild the world: ${String(e)}`);
        notify(`World rebuild failed: ${String(e)}`);
      }
    });
    return rebuildChain;
  };
  /**
   * The rebuild itself, unqueued -- callers go through `queued`. At `shape`,
   * or by default at the TARGET world size and the screen's shape.
   */
  const rebuildNow = async (shape?: { worldSize: number; aspect: number }): Promise<void> => {
    const screenAspect = ui.canvasAspect();
    const worldSize = shape?.worldSize ?? live.worldSize;
    const worldAspect = shape?.aspect ?? screenAspect;
    const next: Preferences = { ...live, worldSize, canvasAspect: worldAspect };
    await orch.applyWorldSize(next, fallbackConfig, defaultWorld);
    built = { worldSize, worldAspect, screenAspect };
  };
  const rebuildWorld = (
    message: string | null,
    shape?: { worldSize: number; aspect: number },
  ): Promise<void> =>
    queued(async () => {
      await rebuildNow(shape);
      if (message !== null) notify(message);
    });

  // ---------------------------------------------------------------------
  // THE INITIAL CONDITIONS, ON THE HOST, so a reshape can place them again.
  //
  // The orchestrator's snapshot lives on the GPU, sized to the world it was
  // taken in; a rebuild destroys it. This is the same scene as a stamp in host
  // memory, in the world it came from, with the frame that says where in that
  // world it sat (null when the stamp IS the whole world). Set when a world is
  // loaded, and when the user presses go on an arrangement (`startRunning`).
  //
  // It describes the orchestrator's snapshot only while there IS one, which is
  // why every use checks `orch.hasInitialConditions` first.
  // ---------------------------------------------------------------------
  let icSource: { stamp: StampData; frame: StampBox | null } | null = null;

  /** Two animation frames: long enough for a queued restore to have run. */
  const nextFrames = (): Promise<void> =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

  /**
   * The initial conditions as a host stamp, for placing into a rebuilt world,
   * or null when there are none.
   *
   *   - MID-ARRANGEMENT, the scene on screen IS the initial conditions being
   *     authored: read it back, unless it is a loaded world nobody has touched,
   *     whose saved scene is better (it has not been cropped to this screen).
   *   - OTHERWISE the saved scene if there is one, else the snapshot -- which
   *     lives on the GPU, so it is restored first (R) and read back. The
   *     rebuild resets to the initial conditions anyway, so the restore costs
   *     nothing that was going to survive.
   */
  const currentInitialConditions = async (): Promise<{
    stamp: StampData;
    frame: StampBox | null;
  } | null> => {
    const fresh = async (): Promise<{ stamp: StampData; frame: null } | null> => {
      const bytes = await exportSceneQueued();
      return bytes === null ? null : { stamp: decodeStamp(bytes, 'scene'), frame: null };
    };
    if (orch.editingInitialConditions) {
      return icSource !== null && !arrangementTouched ? icSource : fresh();
    }
    if (!orch.hasInitialConditions) return null;
    if (icSource !== null) return icSource;
    orch.reset();
    await nextFrames();
    return fresh();
  };

  /**
   * Rebuild to fit the screen and the target world size, putting the initial
   * conditions back if there are any -- placed to fit, exactly as a world load
   * places them (`icFit.ts`). Without them the world is rebuilt empty.
   *
   * The scene is reset to its initial conditions either way: like pressing R,
   * which is the honest answer to a world whose shape just changed under it.
   */
  const refitWorld = (why: 'reshaped' | 'rebuilt'): Promise<void> =>
    queued(async () => {
      const source = await currentInitialConditions();
      const region = source === null ? null : activeRegion(source.stamp, source.frame);
      if (source === null || region === null) {
        await rebuildNow();
        notify(`World ${why} — the scene was cleared`);
        return;
      }
      const plan = planFit(
        region.x1 - region.x0,
        region.y1 - region.y0,
        ui.canvasAspect(),
        live.worldSize,
      );
      await rebuildNow({ worldSize: plan.worldSize, aspect: plan.aspect });
      const placed = placeScene(source.stamp, region, orch.system.canvasSize, source.frame);
      orch.importScene(placed.stamp);
      // Placed from `source`, so the arrangement now IS `source` again.
      icSource = source;
      arrangementTouched = false;
      notify(
        placed.cropped
          ? `World ${why} — initial conditions cropped to fit`
          : `World ${why} — initial conditions put back`,
      );
    });

  /**
   * Read the scene back to the host, one at a time.
   *
   * SERIALIZED, and never alongside a capture: the export and the capture
   * share the stamp copier's staging buffers, and a frame that copies into one
   * while an export has it mapped is rejected whole by WebGPU -- the capture on
   * it silently lost. So exports queue behind each other, and `startRunning`
   * holds the go (the frame that captures) until its export has landed.
   */
  let exportChain: Promise<unknown> = Promise.resolve();
  let exportsInFlight = 0;
  const exportSceneQueued = (): Promise<ArrayBuffer | null> => {
    exportsInFlight++;
    const next = exportChain
      .then(() => orch.exportScene())
      .finally(() => {
        exportsInFlight--;
      });
    exportChain = next.catch(() => null);
    return next;
  };

  /**
   * Whether the arrangement on screen has been changed since `icSource` was
   * set -- painted, erased, cleared. A loaded world that has not been touched
   * is placed afresh from its saved scene on a reshape; one that has is
   * placed from what is on screen, so the edits survive.
   */
  let arrangementTouched = false;

  /**
   * Play. Instant, unless a scene is being read back (a save, or a reshape
   * reading the arrangement): the go is the frame that captures, and a capture
   * alongside a read is rejected -- see `exportSceneQueued`. Then it waits
   * for the read, a few frames.
   */
  let starting = false;
  const startRunning = (): void => {
    if (starting) return;
    // Going from an arrangement the user has changed captures THAT, so the
    // saved scene no longer describes the initial conditions.
    if (orch.editingInitialConditions && arrangementTouched) icSource = null;
    if (exportsInFlight === 0) {
      orch.setPaused(false);
      return;
    }
    starting = true;
    void exportChain.finally(() => {
      // Unless Pause was pressed meanwhile -- see `stopRunning`.
      if (!starting) return;
      starting = false;
      orch.setPaused(false);
    });
  };
  /**
   * "Set as initial conditions": the paused scene becomes the one R restores,
   * and the user is left editing it. Held behind an export in flight for the
   * reason the go is -- the capture shares its staging buffers.
   */
  const setInitialConditions = (): void => {
    const commit = (): void => {
      if (!orch.setInitialConditions()) return;
      // The scene on screen is now the initial conditions, and no saved scene
      // describes it -- a reshape must read it back rather than re-place one.
      icSource = null;
      arrangementTouched = false;
      notify('Set as initial conditions');
    };
    if (exportsInFlight === 0) commit();
    else void exportChain.finally(commit);
  };
  /** Pause, cancelling a go that is still waiting on its copy. */
  const stopRunning = (): void => {
    starting = false;
    orch.setPaused(true);
  };

  // A drag-resize fires continuously, so the rebuild waits for the canvas to
  // settle; until then the renderer letterboxes the old world into the new
  // shape. A change under 1% is ignored -- it is a rounding pixel, not a
  // reshape worth rebuilding for.
  const RESHAPE_SETTLE_MS = 300;
  const RESHAPE_TOLERANCE = 0.01;
  let reshapeTimer: ReturnType<typeof setTimeout> | null = null;
  new ResizeObserver(() => {
    if (reshapeTimer !== null) clearTimeout(reshapeTimer);
    reshapeTimer = setTimeout(() => {
      reshapeTimer = null;
      if (Math.abs(ui.canvasAspect() / built.screenAspect - 1) < RESHAPE_TOLERANCE) return;
      void refitWorld('reshaped');
    }, RESHAPE_SETTLE_MS);
  }).observe(canvas);

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
  /** Dev tab switch: audit the pool every time a sweep ends. Persisted. */
  let auditAfterSweep = session.auditAfterSweep;

  const prefsWindow = new SandPrefs(
    prefs,
    orch.palette,
    entityCount,
    {
      theme: theme.id,
      visibleCount: orch.palette.visibleCount,
      worlds: worldRefs,
      worldChoices: worldChoices(),
      // The restored compaction switches, so the panel opens agreeing with the
      // orchestrator rather than showing three unticked boxes over a world that
      // is already auto-compacting.
      autoCompact: session.autoCompact,
      compactionPaused: session.compactionPaused,
      auditAfterSweep,
      colorMode: orch.colorMode,
      strengths: orch.brush.allStrengths(),
      webcam,
    },
    {
    // The UI leftovers tab. Each tool keeps its own; see `ToolStrengths`.
    onStrength: (tool, value) => {
      orch.brush.setStrength(tool, value);
      persist();
    },
    // --- worlds: the level editor half of the Dev tab --------------------
    onSaveWorld: (name) => {
      void saveWorld(name);
    },
    onOpenWorldLibrary: () => {
      worldLoader.show();
    },
    onAssignWorld: (index, ref) => {
      worldRefs[index] = ref;
      persist();
      const label = worldLabel(effectiveRef(index));
      notify(
        ref === null
          ? `World ${index + 1} follows the world pack${label === '' ? '' : ` → "${label}"`}`
          : ref === ''
            ? `World ${index + 1} unassigned`
            : `World ${index + 1} → "${label}"`,
      );
    },
    onExportWorldSetup: () => {
      void exportWorldSetup();
    },
    onCaptureWorldIcon: () => {
      void captureIcon(
        WORLD_ICON_PX,
        'Drag a circle to picture this world. Esc or a tap clears its icon.',
        (icon) => {
          setWorldIcon(icon);
          if (icon === null) return 'World icon cleared — back to the stand-in';
          return selectedWorld === CUSTOM_WORLD
            ? 'Captured Custom’s icon — saving it as a world carries it along'
            : 'Captured the world icon — save the world to keep it';
        },
      );
    },
    onTheme: (next) => {
      theme = next;
      ui.applyTheme(next);
      persist();
    },
    // A DISPLAY CHOICE. Nothing is rebuilt and no physics step is needed: the
    // next rendered frame reads it on its way to the uniform, so it applies
    // immediately even while paused -- which is when comparing modes is most
    // useful. See `camBrush.wgsl`.
    onColorMode: (mode) => {
      orch.colorMode = mode;
      persist();
    },
    // Likewise immediate. The tray tints itself from the same value on its next
    // refresh, so the button and the particles cannot disagree.
    onSwatchColor: (slot, color) => {
      orch.palette.setColor(slot, color);
      persist();
    },
    // Display only -- capacity is fixed. See `palette.ts`.
    onVisibleCount: (count) => {
      orch.palette.setVisibleCount(count);
      // THE SLIDER IS CUSTOM'S, per the requirement -- a world states its own
      // count and overrides this one while it is loaded. Recording it here is
      // what makes the override temporary: switching back to Custom restores
      // the number the author actually chose.
      customVisibleCount = count;
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
      void refitWorld('rebuilt');
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
    // COMPACTION. Persisted like everything else on this tab -- the Dev tab is
    // a workbench and re-ticking Auto compact every visit was the cost of the
    // old stance. See `SandSession` for the argument and its mitigation.
    onAutoCompact: (enabled) => {
      orch.setAutoCompact(enabled);
      persist();
      notify(
        enabled
          ? 'Auto compact on — below 70% occupancy, at most once every 2s'
          : 'Auto compact off',
      );
    },
    onCompactionPaused: (paused) => {
      orch.setCompactionPaused(paused);
      persist();
      notify(paused ? 'Compaction paused' : 'Compaction resumed');
    },
    // THE AUDIT. Full report to the console, headline to the status line -- the
    // report is several lines with example indices and is worth a scrollback,
    // while the status line only has room for the verdict.
    onAuditAfterSweep: (enabled) => {
      auditAfterSweep = enabled;
      persist();
      notify(enabled ? 'Auditing after every sweep' : 'Sweep auditing off');
    },
    onToggleView: () => {
      const mode = orch.toggleCameraMode();
      notify(mode === 'trail' ? 'Showing the trail map' : 'Showing particles');
      return mode;
    },
    // The shipped-defaults workflow: tinker, export, drop the file over
    // `src/sand/sandDefaults.json`. See `sandDefaults.ts` for what it holds.
    // `live` rather than `prefs`, and the session as it would be saved, so the
    // file is exactly what this tab is showing.
    onExportSettings: () => {
      const text = writeSandDefaults(live, snapshot());
      downloadBlob(new Blob([text], { type: 'application/json' }), 'sandDefaults.json');
      notify('Exported sandDefaults.json — put it at src/sand/sandDefaults.json');
    },
    onAuditPool: () => {
      void (async () => {
        try {
          const audit = await orch.auditPool();
          const report = formatAudit(audit);
          if (audit.ok) console.log(report);
          // `console.error` on a violation, so it stands out in a log and
          // carries a stack showing which operation preceded it.
          else console.error(report);
          notify(summarizeAudit(audit));
        } catch (e) {
          console.error(`Pool audit failed: ${String(e)}`);
          notify(`Pool audit failed: ${String(e)}`);
        }
      })();
    },
    // NOT ASYNC ANY MORE. The compaction is queued for the next frame and runs
    // entirely on the GPU; there is no readback to await and nothing to block
    // on. The frame loop reports the outcome once the mark comes back.
    onCompactNow: () => {
      markBefore = orch.compactionStats.mark;
      const { queued, reason } = orch.requestCompaction();
      if (!queued) {
        markBefore = null;
        notify(`Not compacting — ${reason}`);
      } else {
        notify('Compacting…');
      }
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
  /** An icon capture is up -- see `captureIcon`. */
  let capturing = false;

  canvas.addEventListener('pointermove', (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    buttons = e.buttons;
  });
  canvas.addEventListener('pointerdown', (e) => {
    // Any stroke may change the arrangement -- see `arrangementTouched`.
    arrangementTouched = true;
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

  // -------------------------------------------------------------------------
  // THE WHEEL: swatches, or tools with Shift.
  //
  // Both cycles WRAP -- a scroll gesture has no end stop, so clamping at either
  // limit reads as the wheel having broken rather than as a boundary. The pure
  // cycling lives in `palette.ts` and `tool.ts` so the wrap arithmetic is
  // testable without a DOM.
  //
  // `deltaY` alone, and only its SIGN. Magnitude varies wildly between a mouse
  // wheel (~100 per detent), a trackpad (a few pixels per frame) and a browser
  // in line-scroll mode, so acting on it would make one detent move one swatch
  // on a mouse and thirty on a trackpad. One step per event is the only
  // behaviour that is the same on all three.
  //
  // NOT PASSIVE, because it calls `preventDefault`: the page must not scroll
  // under the canvas while the wheel is being used to pick a material. Chrome
  // treats a wheel listener on an element as passive by default only for the
  // document-level ones, but stating it is what makes the intent explicit.
  // -------------------------------------------------------------------------
  canvas.addEventListener(
    'wheel',
    (e) => {
      // Either browser is modal and owns the wheel -- a long config list is
      // scrollable, and cycling the palette behind it would be invisible.
      if (ui.loaderOpen || worldLoader.isOpen) return;
      if (e.deltaY === 0) return;
      e.preventDefault();

      const steps = e.deltaY > 0 ? 1 : -1;
      if (e.shiftKey) {
        // SHIFT CYCLES THE RAIL, including Stamp -- see `cycleTool`.
        orch.brush.tool = cycleTool(orch.brush.tool, steps);
        persist();
        return;
      }
      // Over the swatches the BAR shows -- in a world, its empty slots are not
      // there to land on. Arms the Brush as well, like every other selection
      // path.
      const shown = ui.displayedSlots();
      if (shown.length === 0) return;
      const at = Math.max(0, shown.indexOf(orch.palette.selected));
      const next = shown[cycleSlot(at, steps, shown.length)];
      if (next !== undefined) selectSwatch(next);
    },
    { passive: false },
  );

  window.addEventListener('keyup', (e) => {
    shiftHeld = e.shiftKey;
  });
  // Releasing focus mid-gesture would otherwise leave Shift stuck on.
  window.addEventListener('blur', () => {
    shiftHeld = false;
  });

  window.addEventListener('keydown', (e) => {
    shiftHeld = e.shiftKey;
    // A capture is modal: its overlay takes Escape, and nothing else should run.
    if (capturing) return;
    // A typed field owns its own keys -- the Weight input in particular, where
    // `1`-`0` must enter digits rather than switch palette squares.
    if (e.target instanceof HTMLInputElement) return;

    if (e.key === 'Escape') {
      ui.closeLoader();
      ui.setWorldMenu(false);
      worldLoader.close();
      return;
    }
    // Either browser is modal: it would be confusing for the world to keep
    // responding to keys aimed at a list of configs -- or of worlds, where a
    // stray digit would also switch the palette selection behind the dialog.
    if (ui.loaderOpen || worldLoader.isOpen) return;

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
      // The Nth swatch THE BAR SHOWS, which in a world skips its empty slots.
      // Arms the Brush as well -- see `selectSwatch`.
      const slot = ui.displayedSlots()[digit];
      if (slot !== undefined) selectSwatch(slot);
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      // Through `startRunning`, like the Play button, so a go that captures
      // the initial conditions also keeps them on the host.
      if (orch.paused && !starting) startRunning();
      else stopRunning();
    } else if (e.key === 'r' || e.key === 'R') {
      // Refused while the initial conditions are being authored -- the scene on
      // screen IS the arrangement, and restoring would discard it in favour of
      // an older one. Saying so beats a key that silently does nothing.
      if (!orch.reset()) {
        notify('Already editing the initial conditions — nothing to reset to');
      }
    }
  });

  // -------------------------------------------------------------------------
  // WORLDS
  // -------------------------------------------------------------------------

  /**
   * Save the palette, the preferences and the initial conditions as a world.
   *
   * The scene is the CAPTURED initial conditions rather than the live scene --
   * see `SandOrchestrator.exportScene` on why a world should not open
   * mid-simulation.
   */
  async function saveWorld(name: string): Promise<void> {
    try {
      notify(`Saving "${name}"…`);
      const whole = await exportSceneQueued();
      // TRIMMED to the active region, with the frame it came from -- smaller
      // on disk, and the frame is what lets another screen place it where it
      // sat (`icFit.trimScene`). An arrangement with nothing in it saves as no
      // scene at all.
      const trimmed = whole === null ? null : trimScene(decodeStamp(whole, 'scene'));
      const scene = trimmed === null ? null : encodeStamp(trimmed.stamp);
      const made = makeWorldDocument({
        sceneFrame: trimmed?.frame ?? null,
        slots: orch.palette.all().map((slot, index) => ({
          name: slot.name,
          document: slotDocument(slot.config, slot.world),
          color: orch.palette.colorOf(index),
          ...(slot.icon === undefined ? {} : { icon: slot.icon }),
        })),
        icon: worldIcon,
        preferences: live,
        visibleCount: orch.palette.visibleCount,
        // The world's own look, saved with it -- a world built to be read by
        // material is not the same world under Behavior. See `WorldDocument`.
        colorMode: orch.colorMode,
      });
      // Icons INLINE, so a world built from a pack world keeps its pictures
      // when the pack changes -- see `inlineIcon`.
      const document = await mapWorldIcons(made, inlineIcon);
      await worldStore.save(name, document, scene);
      libraryIcons.set(name, iconOfDocument(document));
      // Its swatches as the load menu last read them are now stale.
      swatchSourceCache.clear();
      prefsWindow.refreshWorlds(worldChoices(), worldRefs);
      notify(
        scene === null
          ? `Saved "${name}" — no initial conditions yet`
          : `Saved "${name}"`,
      );
    } catch (e) {
      console.error(`Could not save the world "${name}": ${String(e)}`);
      notify(`Save failed: ${String(e)}`);
    }
  }

  /**
   * Load a world: its palette, its preferences, and its scene.
   *
   * ## The order is load-bearing
   *
   * Preferences FIRST, because `worldSize` and `canvasAspect` reallocate the
   * entity buffer and both textures -- and a scene pasted before that rebuild
   * would be pasted into buffers about to be destroyed. `applyWorldSize` also
   * invalidates the initial conditions, which is exactly why the scene has to
   * come after it rather than before.
   *
   * Then the palette, so the materials exist before any particle points at
   * them. Then the scene.
   */
  async function loadWorld(ref: string): Promise<boolean> {
    // `name` is for messages: the save's own, or a built-in world's.
    const name = worldLabel(ref);
    const record = await readWorldRecord(ref);
    if (record === null) {
      notify(`"${name}" is missing — it may have been deleted`);
      return false;
    }

    let world;
    try {
      world = readWorld(record.document, name);
    } catch (e) {
      console.error(`Could not read the world "${name}": ${String(e)}`);
      notify(`"${name}" could not be read`);
      return false;
    }

    // --- preferences --------------------------------------------------------
    // THE WORLD'S SAVED SIZE AND SHAPE ARE NOT ADOPTED. The target world size
    // is the player's (Prefs tab) and the shape is the screen's; the SCENE
    // decides whether the world grows past the target, below.
    const next = {
      ...applyWorldPreferences(live, world.preferences),
      worldSize: live.worldSize,
      canvasAspect: live.canvasAspect,
    };
    live = next;
    prefs = next;
    savePreferences(next);
    prefsWindow.adoptPreferences(next);
    orch.applyPreferences(next);

    // --- the scene decides the world ----------------------------------------
    // Its active region -- particles and walls, plus a cushion of trails -- is
    // placed pixel for pixel, so the world must have room for it: the target
    // if that fits, else grown, else letterboxed, else cropped. See `icFit.ts`.
    let scene: StampData | null = null;
    let unreadable = false;
    if (record.scene !== null) {
      try {
        scene = decodeStamp(record.scene, 'world');
      } catch (e) {
        console.error(`Could not read the scene of "${name}": ${String(e)}`);
        unreadable = true;
      }
    }
    // The frame the scene was trimmed from; null for a world saved untrimmed.
    const frame = world.sceneFrame;
    const region = scene === null ? null : activeRegion(scene, frame);
    const screenAspect = ui.canvasAspect();
    const plan =
      region === null
        ? null
        : planFit(region.x1 - region.x0, region.y1 - region.y0, screenAspect, live.worldSize);
    const shape = {
      worldSize: plan?.worldSize ?? live.worldSize,
      aspect: plan?.aspect ?? screenAspect,
    };
    if (
      shape.worldSize !== built.worldSize ||
      Math.abs(shape.aspect / built.worldAspect - 1) > 1e-6
    ) {
      notify(`Loading "${name}" — rebuilding the world…`);
      await rebuildWorld(null, shape);
    }

    // --- the palette, at its stored slots ---------------------------------
    // CLEARED FIRST, so a world with fewer materials does not inherit the
    // previous one's leftovers in the slots it does not mention.
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      if (slot !== MASTER_SLOT) orch.palette.clear(slot);
      // THE COLOURS ARE RESET TOO, for the same reason the slots are: a world
      // that says nothing about slot 7's colour should show the default there,
      // not whatever the previously loaded world happened to paint it. Without
      // this, colours would accumulate across loads and a world would render
      // differently depending on what was open before it.
      orch.palette.setColor(slot, defaultSwatchColor(slot));
    }
    for (const stored of world.slots) {
      const saved = readSlotDocument(stored.document);
      if (saved === null || saved.configs[0] === undefined) continue;
      orch.palette.set(stored.slot, {
        tool: TOOL_CONFIG,
        config: saved.configs[0],
        world: saved.world,
        name: stored.name,
        ...(stored.icon === undefined ? {} : { icon: stored.icon }),
      });
      // An older world states no colour and keeps the default set just above.
      if (stored.color !== undefined) orch.palette.setColor(stored.slot, stored.color);
    }
    // THE WORLD'S COUNT OVERRIDES THE DEV SLIDER, per the requirement: that
    // slider governs Custom alone from here on.
    if (world.visibleCount > 0) orch.palette.setVisibleCount(world.visibleCount);
    // EVERY WORLD OPENS ON THE MASTER SWATCH -- the one that grounds its trail
    // persistence and boundary. A world does not remember a selection.
    orch.palette.select(MASTER_SLOT);
    // ...and so does its colour mode, for the same reason: how the world looks
    // is the author's statement, not the reader's setting.
    orch.colorMode = world.colorMode;
    prefsWindow.adoptColorMode(world.colorMode);
    // The world's icon is the open world's -- Custom's as well when a library
    // world is loaded into Custom to be edited, like its palette.
    setWorldIcon(world.icon);
    orch.applyPalette(fallbackConfig, defaultWorld);

    // --- the scene, placed ---------------------------------------------------
    // Into the world as it NOW is, which the rebuild above made room for.
    if (scene !== null && region !== null) {
      const placed = placeScene(scene, region, orch.system.canvasSize, frame);
      // Kept as saved, so a later reshape places it afresh from the original
      // rather than from this placement -- see `icSource`.
      icSource = { stamp: scene, frame };
      arrangementTouched = false;
      if (!orch.importScene(placed.stamp)) {
        notify(`"${name}" loaded, but its scene could not be placed`);
      } else if (placed.cropped) {
        notify(`Loaded "${name}" — cropped to fit this screen`);
      } else {
        notify(`Loaded "${name}"`);
      }
    } else {
      // No scene: empty the world rather than leaving the previous one's
      // particles and walls standing in a world that did not ask for them --
      // and its initial conditions, which R would otherwise bring back.
      icSource = null;
      orch.invalidateInitialConditions();
      orch.clearParticles();
      orch.clearField('walls');
      notify(
        unreadable
          ? `"${name}" loaded, but its scene could not be read`
          : `Loaded "${name}" — no initial conditions`,
      );
    }
    persist();
    return true;
  }

  /**
   * A world button was pressed.
   *
   * ## PRESSING THE ACTIVE WORLD RELOADS IT, and that is the feature
   *
   * The requirement: "the user can edit the initial conditions, but clicking
   * the world again resets them to the world default". So this does not check
   * whether the world is already selected -- reloading is exactly what the
   * second press is for, and short-circuiting it would remove the only way back
   * to a world's default once it has been edited.
   *
   * ## Custom is RESTORED, not merely switched to
   *
   * There is no saved document behind Custom -- it is the user's own state --
   * but that state has to be put BACK, because a preset world overwrote the
   * live palette on the way in. `customSlots` holds it for exactly that, and
   * this is where it is returned.
   *
   * Pressing Custom while already on Custom does nothing, unlike a preset:
   * there is no default to reset to, because Custom IS the default.
   */
  async function selectWorld(index: number): Promise<void> {
    if (index === CUSTOM_WORLD) {
      if (selectedWorld === CUSTOM_WORLD) return;
      selectedWorld = CUSTOM_WORLD;
      restoreCustomPalette();
      persist();
      notify('Custom — your own palette and scene');
      return;
    }

    const ref = effectiveRef(index);
    if (ref === '') return;
    if (!worldPresent(ref)) {
      notify(`"${worldLabel(ref)}" is missing — reassign World ${index + 1} on the Dev tab`);
      return;
    }

    // SET ASIDE BEFORE THE LOAD OVERWRITES IT, and only when leaving Custom --
    // going from one preset to another must not capture the first preset's
    // materials as though they were the user's.
    if (selectedWorld === CUSTOM_WORLD) customSlots = paletteSlots();

    // SET BEFORE THE LOAD, so the button lights immediately rather than after
    // a rebuild that may take a visible moment. A failed load reports itself in
    // the status line; leaving the old world lit through a slow rebuild would
    // look like the click had been ignored.
    selectedWorld = index;
    await loadWorld(ref);
  }

  /**
   * Put Custom's palette and swatch count back.
   *
   * The inverse of what a world load does. The scene is NOT restored: a preset
   * left its own initial conditions in place, and Custom has none by
   * definition -- so the world is emptied rather than handed someone else's
   * arrangement to keep editing.
   */
  function restoreCustomPalette(): void {
    const stored = customSlots;
    customSlots = null;
    if (stored === null) return;

    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      if (slot !== MASTER_SLOT) orch.palette.clear(slot);
      // Custom's colours come back with its materials. Without this the last
      // preset's colours stayed, and were then saved as Custom's own.
      orch.palette.setColor(slot, stored[slot]?.color ?? defaultSwatchColor(slot));
    }
    stored.forEach((entry, slot) => {
      const saved = readSlotDocument(entry.document);
      if (saved === null || saved.configs[0] === undefined) return;
      orch.palette.set(slot, {
        tool: TOOL_CONFIG,
        config: saved.configs[0],
        world: saved.world,
        name: entry.name,
        ...(entry.icon === undefined ? {} : { icon: entry.icon }),
      });
    });
    worldIcon = customWorldIcon;
    // The world's override ends here -- see `customVisibleCount`.
    orch.palette.setVisibleCount(customVisibleCount);
    // Like every world, Custom opens on the master swatch.
    orch.palette.select(MASTER_SLOT);
    orch.applyPalette(fallbackConfig, defaultWorld);
    // Custom has no initial conditions, so it opens empty rather than
    // inheriting the preset's particles, walls or snapshot -- R, or a reshape,
    // would otherwise bring the preset's scene back into Custom.
    icSource = null;
    orch.invalidateInitialConditions();
    orch.clearParticles();
    orch.clearField('walls');
  }

  /**
   * "Export world setup": the buttons, the worlds they load and Custom's
   * palette, as a world pack (`worldPack.ts`).
   *
   * THE WORLDS AS SAVED, not as currently edited: a button's world is its
   * library save or built-in file. Unsaved edits to the open world are not
   * exported -- save it first.
   */
  async function exportWorldSetup(): Promise<void> {
    try {
      notify('Exporting world setup…');
      const buttons: (ExportButton | null)[] = [];
      for (let i = 0; i < ASSIGNABLE_WORLDS; i++) {
        const ref = effectiveRef(i);
        if (ref === '') {
          buttons.push(null);
          continue;
        }
        const record = await readWorldRecord(ref);
        if (record === null) {
          notify(`World ${i + 1}: "${worldLabel(ref)}" could not be read — nothing exported`);
          return;
        }
        buttons.push({ key: ref, name: worldLabel(ref), record });
      }
      const zip = await buildPackZip({
        buttons,
        selectedWorld,
        // Custom's palette, which is the live one only while Custom is active.
        customSlots: customSlots ?? paletteSlots(),
        customIcon: customWorldIcon,
      });
      downloadBlob(zip, 'default-worlds.zip');
      notify('Exported default-worlds.zip — empty public/worlds/default/ and unzip it there');
    } catch (e) {
      console.error(`Could not export the world setup: ${String(e)}`);
      notify(`Export failed: ${String(e)}`);
    }
  }

  const worldLoader = new WorldLoaderUi(worldStore, {
    onLoad: (name) => {
      void loadWorld(name);
    },
    onDelete: (name) => {
      void (async () => {
        try {
          await worldStore.remove(name);
          swatchSourceCache.clear();
          libraryIcons.delete(name);
          // A deleted world may still be assigned to a button. The assignment
          // is LEFT IN PLACE rather than cleared: the panel marks it missing,
          // which says what happened, where a silent reset to None would look
          // like the assignment had never been made.
          prefsWindow.refreshWorlds(worldChoices(), worldRefs);
          notify(`Deleted "${name}"`);
        } catch (e) {
          console.error(`Could not delete "${name}": ${String(e)}`);
          notify(`Delete failed: ${String(e)}`);
        }
      })();
    },
  });

  /**
   * Run one icon capture and hand the result to `apply`, which returns the
   * status line to show. NULL IS A RESULT, not a failure: a cancelled capture
   * clears the icon -- that is the requirement, and how an icon is removed.
   *
   * The Dev panel is hidden for the gesture, since it floats over the canvas.
   * A capture that throws leaves the icon as it was.
   */
  async function captureIcon(
    size: number,
    instruction: string,
    apply: (icon: string | null) => string,
  ): Promise<void> {
    if (capturing) return;
    capturing = true;
    prefsWindow.setHidden(true);
    try {
      const icon = await captureCircleIcon(canvas as HTMLCanvasElement, size, instruction);
      notify(apply(icon));
      persist();
    } catch (e) {
      console.error(`Icon capture failed: ${String(e)}`);
      notify(`Icon capture failed: ${String(e)}`);
    } finally {
      prefsWindow.setHidden(false);
      capturing = false;
    }
  }

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
    await pasteIntoSwatch(slot);
  }

  /**
   * Decode a share link or config from the clipboard into `slot`.
   *
   * The body of Shift+V, and the load menu's "Paste from link…" row, which is
   * the same thing aimed at a chosen swatch -- and the only way to do it on a
   * phone, which has no Shift+V.
   */
  async function pasteIntoSwatch(slot: number): Promise<void> {
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
    orch.applyPalette(fallbackConfig, defaultWorld);
    // Selected as well as filled, with the brush armed: the user pasted it to
    // use it, and leaving the selection on whatever was armed before would make
    // the paste look like it had gone somewhere else.
    selectSwatch(slot);
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
    // The Camera tab's button label, status line and preview shape.
    prefsWindow.syncCamera();
    // The pool readouts. Self-guarding: it only touches Tweakpane when a
    // displayed value actually moved, so a static world costs the formatting.
    const poolStats = orch.compactionStats;
    prefsWindow.setCompactionStats(poolStats);

    // THE COMPACTION RAN ON A KNOWN FRAME, so no edge detection is needed --
    // `justCompacted` is true on exactly that frame. The MARK, though, arrives
    // a frame or two later through the readback, so the report waits for it to
    // actually move rather than announcing on the frame the passes ran.
    // ONLY FOR COMPACTIONS THE USER ASKED FOR. `markBefore` is set by the
    // button and stays null for automatic ones, which is what keeps a
    // background tidy from interrupting the status line every time it fires.
    // An auto compaction is still visible in the Dev panel's readouts.
    if (markBefore !== null && poolStats.mark < markBefore) {
      const before = markBefore;
      markBefore = null;
      notify(
        `Compacted — mark ${before.toLocaleString()} → ` +
          `${poolStats.mark.toLocaleString()}`,
      );
    }

    // AUDIT IMMEDIATELY AFTER THE COMPACTION FRAME, when the operation that
    // may have broken the pool is the most recent thing that happened.
    //
    // The compaction is recorded into the frame's encoder, which has been
    // submitted by now, so the audit's own copies are ordered behind it.
    if (orch.justCompacted && auditAfterSweep) {
      void (async () => {
        const audit = await orch.auditPool();
        const label = `[after compaction] ${formatAudit(audit)}`;
        if (audit.ok) console.log(label);
        else console.error(label);
      })().catch((e: unknown) => console.error(`Audit failed: ${String(e)}`));
    }
    ui.refresh({
      tool: orch.brush.tool,
      brushSize: orch.brush.sizeSlot,
      paused: orch.paused,
      editingInitialConditions: orch.editingInitialConditions,
      // Rebuilt each frame from the store's cached name list, which is
      // refreshed by every save and delete -- so a world deleted while the
      // menu is on screen is marked within a frame rather than at the next
      // reload. The list is four short strings; the cost is a lookup each.
      worlds: Array.from({ length: ASSIGNABLE_WORLDS }, (_, i) => {
        const ref = effectiveRef(i);
        return {
          name: worldLabel(ref),
          present: worldPresent(ref),
          // The OPEN world shows its live icon, so a capture shows at once.
          icon: i === selectedWorld ? worldIcon : savedWorldIcon(ref),
        };
      }),
      selectedWorld,
      customIcon: customWorldIcon,
      shovePull: orch.shovePull,
      eraseMode: orch.eraseMode,
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

  // THE WORLD THE SESSION IS ON, loaded. The palette restored above is
  // Custom's; a session on a world button -- or a new visitor starting on the
  // pack's world -- has to load that world, or the button would be lit over
  // Custom's materials. A world that has gone, or fails, falls back to Custom.
  if (selectedWorld !== CUSTOM_WORLD) {
    const ref = effectiveRef(selectedWorld);
    if (ref === '' || !worldPresent(ref) || !(await loadWorld(ref))) {
      selectedWorld = CUSTOM_WORLD;
      restoreCustomPalette();
      persist();
    }
  }
}

/** Hand the user a file. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

void main().catch((e: unknown) => {
  console.error(e);
  showUnavailableOverlay('Could not start Fluoddity Sand', String(e));
});
