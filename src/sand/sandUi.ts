/**
 * The MacPaint-style shell: a tool rail, a swatch tray and the load menu.
 *
 * Plain DOM rather than Tweakpane, for the reason it always was: the studio's
 * panel is a registry-driven wall of sliders and Tweakpane is exactly right for
 * that, while this is a dozen buttons that want to look like a paint program.
 * The PREFERENCES window is the opposite case and does use the shared registry
 * -- see `sandPrefs.ts`.
 *
 * ## What this file owns, and what the stylesheet owns
 *
 * Every comp is one block of custom properties in `sand.html`; this file sets
 * `data-theme` and `data-layout` on `<html>` and otherwise knows nothing about
 * how any of them look. The single exception is `applyLayout`, which RE-PARENTS
 * the tool and size groups for the dock comp -- that is a structural difference
 * CSS cannot express, since the two arrangements need the groups inside
 * different containers.
 *
 * ## The canvas is fitted here
 *
 * `fitCanvas` sizes `#app` to the largest box of the simulation's aspect that
 * fits the stage cell. In pixels, by script, rather than with `aspect-ratio`:
 * the surface's `ResizeObserver` drives the WebGPU backing store off the
 * element's real box, so the element has to settle at an exact size rather than
 * at whatever a percentage resolves to part-way through layout.
 */

import type { ConfigEntry, ConfigStore } from '../config/configStore.ts';
import type { WorldSettings } from '../particleSystem/config.ts';
import { BRUSH_SIZES } from './brushInput.ts';
import { isCompatible } from './compatibility.ts';
import { ASSIGNABLE_WORLDS, MASTER_SLOT, type Palette, keyLabel } from './palette.ts';
import { CUSTOM_WORLD } from './session.ts';
import {
  type SandTool,
  TOOLS,
  TOOL_LABELS,
  clearTargetFor,
  isImplemented,
  usesStrength,
  usesSwatch,
} from './tool.ts';
import { LAYOUT_DOCK, type SandTheme, themeById } from './theme.ts';
// The studio's own tool descriptions, so the two apps cannot describe the same
// tool differently.
import { TOOL_HELP } from '../ui/menuHelp.ts';

/**
 * What the tray's Clear button wipes for each target, and what it says.
 *
 * The wall/trail wording matches the studio's `CLEAR_FIELD_LABELS` -- these are
 * the same acts on the same textures, so they should read identically in both
 * apps.
 */
const CLEAR_LABELS: Readonly<Record<string, string>> = {
  walls: "Clear barriers (Can't undo)",
  trails: "Clear trails (Can't undo)",
  particles: "Clear particles (Can't undo)",
};

/**
 * One line per tool, for the hint.
 *
 * The three field tools defer to the studio's `TOOL_HELP` so the two apps cannot
 * disagree. Brush, Erase and Stamp have no studio counterpart and are described
 * here.
 */
function hintFor(tool: SandTool, swatchName: string, loaded: boolean): string {
  switch (tool) {
    case 'brush':
      return loaded
        ? `Paint [${swatchName}]  ·  right-drag erases`
        : 'This swatch is empty — right-click a swatch to load a config into it';
    case 'erase':
      return 'Rub out particles and barriers  ·  right-drag also pulls them in  ·  Shift for line tool';
    case 'stamp':
      return 'Stamp is not built yet';
    case 'shove':
      return `${TOOL_HELP.shove}  ·  right-drag pulls`;
    default:
      return `${TOOL_HELP[tool]}  ·  right to erase  ·  Shift for line tool`;
  }
}

/**
 * Tool glyphs, as inline SVG paths on a 24-box.
 *
 * Drawn rather than lettered because the rail is the one place in either app
 * where a shape is faster to read than a word -- and `currentColor` throughout
 * so a comp that inverts the selected button inverts the icon with it.
 */
const TOOL_ICONS: Readonly<Record<SandTool, string>> = {
  // A brush: ferrule and bristles, angled the way a held brush sits.
  brush: '<path d="M17 3l4 4-9 9-4-4z"/><path d="M8 12l4 4-2 3a4 4 0 01-5 1 4 4 0 001-5z"/>',
  // An eraser block on its edge.
  erase: '<path d="M4 16l8-8a2 2 0 013 0l4 4a2 2 0 010 3l-5 5H7z"/><path d="M9 21h12"/>',
  // Two arrows pushing outward -- the displacement the tool actually does.
  shove: '<path d="M12 4v16"/><path d="M8 8l4-4 4 4"/><path d="M8 16l4 4 4-4"/><path d="M3 12h4"/><path d="M17 12h4"/>',
  // A brick course.
  walls: '<path d="M3 6h18v12H3z"/><path d="M3 12h18"/><path d="M9 6v6"/><path d="M15 12v6"/>',
  // A trail: the smear a particle leaves.
  trails: '<path d="M3 17c4-8 14 2 18-6"/>',
  // A stamp block with its handle.
  stamp: '<path d="M8 3h8v5l2 4H6l2-4z"/><path d="M5 16h14v5H5z"/>',
};

export interface SandUiCallbacks {
  /** A swatch was left-clicked or selected by key. */
  onSelect(slot: number): void;
  /** A tool was chosen in the rail. */
  onTool(tool: SandTool): void;
  /** A config was chosen for a swatch in the load menu. */
  onLoad(slot: number, entry: ConfigEntry): void;
  /** "None" was chosen: empty this swatch. */
  onClearSlot(slot: number): void;
  /** A brush-size button was pressed. */
  onBrushSize(index: number): void;
  /** The Strength number-drag moved, for the tool it belongs to. */
  onStrength(tool: SandTool, value: number): void;
  /** The tray's Clear button, for whatever the armed tool clears. */
  onClear(what: 'walls' | 'trails' | 'particles'): void;
  /**
   * A world button was pressed.
   *
   * `index` is `CUSTOM_WORLD` for the editable world, or 0..4 for an assigned
   * one. PRESSING THE ACTIVE WORLD IS NOT A NO-OP -- it is how the scene is
   * reset to that world's default, which is the requirement -- so this fires
   * even when the button is already selected.
   */
  onSelectWorld(index: number): void;
}

/** What the panel needs to draw one world button. */
export interface WorldButtonState {
  /** The save this button loads, or empty when unassigned. */
  readonly name: string;
  /** Whether that save still exists. False marks it as deleted. */
  readonly present: boolean;
}

export class SandUi {
  private readonly palette: Palette;
  private readonly store: ConfigStore;
  private readonly callbacks: SandUiCallbacks;

  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly stageEl: HTMLElement;
  private readonly toolsEl: HTMLElement;
  private readonly worldsEl: HTMLElement;
  private readonly sizesEl: HTMLElement;
  private readonly swatchesEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly bannerEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly clearButton: HTMLButtonElement;
  private readonly strengthEl: HTMLElement;
  private readonly strengthLabel: HTMLElement;
  private readonly strengthInput: HTMLInputElement;
  private readonly loaderEl: HTMLElement;
  private readonly loaderSlotEl: HTMLElement;
  private readonly loaderListEl: HTMLElement;

  /** The rail blocks, kept so the dock comp can re-parent them. */
  private readonly toolsBlock: HTMLElement;
  private readonly sizesBlock: HTMLElement;
  private readonly railEl: HTMLElement;
  private readonly dockToolsEl: HTMLElement;

  /** What the tray's Clear button wipes, or null when it is hidden. */
  private clearTarget: 'walls' | 'trails' | 'particles' | null = null;

  /** Which swatch the open menu is filling, or null when it is closed. */
  private loadingInto: number | null = null;

  /** The armed tool. Mirrored from the brush so the rail can render it. */
  private tool: SandTool = 'brush';

  /** The simulation's aspect (w/h), for fitting the canvas. */
  private canvasAspect = 1;

  /** How many swatch buttons exist right now, so `refresh` can notice a change. */
  private builtCount = -1;

  constructor(palette: Palette, store: ConfigStore, callbacks: SandUiCallbacks) {
    this.palette = palette;
    this.store = store;
    this.callbacks = callbacks;

    const byId = <T extends HTMLElement>(id: string): T => {
      const el = document.getElementById(id);
      if (el === null) throw new Error(`sand.html is missing #${id}`);
      return el as T;
    };

    this.root = document.documentElement;
    this.canvas = byId<HTMLCanvasElement>('app');
    this.stageEl = byId('stage');
    this.toolsEl = byId('tools');
    this.worldsEl = byId('worlds');
    this.sizesEl = byId('sizes');
    this.swatchesEl = byId('swatches');
    this.statusEl = byId('sand-status');
    this.bannerEl = byId('ic-banner');
    this.hintEl = byId('hint');
    this.clearButton = byId<HTMLButtonElement>('clear');
    this.strengthEl = byId('strength');
    this.strengthLabel = byId('strength-label');
    this.strengthInput = byId<HTMLInputElement>('strength-input');
    this.loaderEl = byId('loader');
    this.loaderSlotEl = byId('loader-slot');
    this.loaderListEl = byId('loader-list');
    this.toolsBlock = byId('rail-tools');
    this.sizesBlock = byId('rail-sizes');
    this.railEl = byId('rail');
    this.dockToolsEl = byId('dock-tools');

    this.buildTools();
    this.buildWorlds();
    this.buildSizes();
    this.buildStrength();

    this.clearButton.addEventListener('click', () => {
      if (this.clearTarget !== null) this.callbacks.onClear(this.clearTarget);
    });

    // Clicking the backdrop closes. Scoped to the backdrop itself so a click
    // inside the panel does not.
    this.loaderEl.addEventListener('click', (e) => {
      if (e.target === this.loaderEl) this.closeLoader();
    });

    // The stage's size is what the canvas is fitted into, and it changes on
    // window resize AND whenever the tray wraps to a different height.
    new ResizeObserver(() => this.fitCanvas()).observe(this.stageEl);
  }

  get loaderOpen(): boolean {
    return this.loadingInto !== null;
  }

  // -------------------------------------------------------------------------
  // Layout and comps
  // -------------------------------------------------------------------------

  /**
   * Fit the canvas to the stage at the simulation's aspect.
   *
   * THE CROP THE BRIEF ASKS FOR. The element ends up exactly the size of the
   * trail texture's shape, so nothing of the canvas extends under the rail or
   * the tray -- the grid already reserves those, and this fills what is left
   * without overflowing it.
   *
   * `border-box` sizing means the 1-2px frame is inside these numbers, so the
   * element never exceeds the cell and the grid never scrolls.
   */
  fitCanvas(): void {
    const availW = this.stageEl.clientWidth;
    const availH = this.stageEl.clientHeight;
    if (availW <= 0 || availH <= 0) return;

    const byWidth = availW / this.canvasAspect <= availH;
    const w = byWidth ? availW : availH * this.canvasAspect;
    const h = byWidth ? availW / this.canvasAspect : availH;

    this.canvas.style.width = `${Math.max(1, Math.floor(w))}px`;
    this.canvas.style.height = `${Math.max(1, Math.floor(h))}px`;
  }

  /** Tell the shell what shape the simulation is, and refit. */
  setCanvasAspect(aspect: number): void {
    if (!Number.isFinite(aspect) || aspect <= 0) return;
    this.canvasAspect = aspect;
    this.fitCanvas();
  }

  /**
   * Switch comps.
   *
   * Three of the four are a pure attribute swap. The dock comp additionally
   * needs the tool and size groups INSIDE the tray rather than in the rail,
   * which is a parent change no stylesheet can make -- so it is done here, and
   * the blocks move back when a rail comp is chosen.
   */
  applyTheme(theme: SandTheme): void {
    this.root.dataset['theme'] = theme.id;
    this.root.dataset['layout'] = theme.layout;
    this.applyLayout(theme);
    // The tray's height changes with the arrangement, so the stage does too.
    this.fitCanvas();
  }

  private applyLayout(theme: SandTheme): void {
    if (theme.layout === LAYOUT_DOCK) {
      this.dockToolsEl.append(this.toolsBlock, this.sizesBlock);
    } else {
      this.railEl.prepend(this.toolsBlock, this.sizesBlock);
    }
  }

  // -------------------------------------------------------------------------
  // Building
  // -------------------------------------------------------------------------

  private buildTools(): void {
    this.toolsEl.replaceChildren();

    for (const tool of TOOLS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tool';
      button.dataset['tool'] = tool;
      button.title = hintFor(tool, '', true);
      if (!isImplemented(tool)) button.dataset['todo'] = 'true';

      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('fill', 'none');
      icon.setAttribute('stroke', 'currentColor');
      icon.setAttribute('stroke-width', '1.6');
      icon.setAttribute('stroke-linecap', 'round');
      icon.setAttribute('stroke-linejoin', 'round');
      icon.setAttribute('aria-hidden', 'true');
      icon.classList.add('tool-icon');
      icon.innerHTML = TOOL_ICONS[tool];

      const name = document.createElement('span');
      name.className = 'tool-name';
      name.textContent = TOOL_LABELS[tool];

      button.append(icon, name);
      button.addEventListener('click', () => this.callbacks.onTool(tool));
      this.toolsEl.append(button);
    }
  }

  /**
   * The six world buttons: five presets and Custom.
   *
   * ## Built once, relabelled per frame
   *
   * The buttons themselves never change -- there are always six, in the same
   * places. What changes is which save each points at, whether that save still
   * exists, and which is lit, all of which `refresh` writes. Rebuilding the
   * elements instead would drop a click mid-press whenever an assignment
   * changed, which is the bug `buildSwatches` guards against by rebuilding only
   * on a count change.
   *
   * ## Custom is LAST, and that placement is the requirement's
   *
   * It is the sixth button. Reading order puts the presets first, which is the
   * right emphasis for the shipping app -- a visitor picks a world, and Custom
   * is the escape hatch into the editor rather than the front door.
   */
  private buildWorlds(): void {
    this.worldsEl.replaceChildren();

    for (let i = 0; i < ASSIGNABLE_WORLDS; i++) {
      this.worldsEl.append(this.buildWorldButton(i));
    }
    this.worldsEl.append(this.buildWorldButton(CUSTOM_WORLD));
  }

  private buildWorldButton(index: number): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'world';
    button.dataset['world'] = String(index);
    if (index === CUSTOM_WORLD) button.dataset['custom'] = 'true';
    // FIRES EVEN WHEN ALREADY SELECTED. Pressing the active world is how its
    // initial conditions are reset to the world's default -- see the callback.
    button.addEventListener('click', () => {
      if (button.disabled) return;
      this.callbacks.onSelectWorld(index);
    });
    return button;
  }

  /**
   * Relabel the world buttons. Called from `refresh`.
   *
   * An UNASSIGNED button is disabled rather than hidden, so the panel keeps its
   * three-by-two shape and an author can see which slots are free. A button
   * whose save has been DELETED is marked instead of cleared, because saying
   * what happened beats silently reading as though it was never assigned.
   */
  private refreshWorlds(state: {
    worlds: readonly WorldButtonState[];
    selected: number;
  }): void {
    for (const el of this.worldsEl.children) {
      if (!(el instanceof HTMLButtonElement)) continue;
      const index = Number(el.dataset['world']);
      el.dataset['selected'] = String(index === state.selected);

      if (index === CUSTOM_WORLD) {
        el.textContent = 'Custom';
        el.disabled = false;
        el.title =
          'The editable world: no initial conditions, and a palette you build ' +
          'yourself. The Dev tab’s swatch count governs this one.';
        continue;
      }

      const entry = state.worlds[index];
      const name = entry?.name ?? '';
      const present = entry?.present ?? false;

      if (name === '') {
        el.textContent = `World ${index + 1}`;
        el.disabled = true;
        delete el.dataset['missing'];
        el.title = `World ${index + 1} is unassigned — point it at a save on the Dev tab.`;
        continue;
      }

      el.disabled = false;
      el.textContent = name;
      if (present) {
        delete el.dataset['missing'];
        el.title =
          `Load ${name}. Pressing it again resets the scene to this ` +
          'world’s initial conditions.';
      } else {
        el.dataset['missing'] = 'true';
        el.title = `"${name}" was deleted. Reassign this button on the Dev tab.`;
      }
    }
  }

  /**
   * The five size buttons.
   *
   * ## The dots span a much wider range than they used to
   *
   * They were `6 + 16 * sqrt(r / largest)` -- 6.5px to 22px, a ramp so gentle
   * that the top three were hard to tell apart at a glance. The brief asked for
   * more variance, so the floor drops to 3px and the ceiling rises to 26px.
   *
   * Still sqrt rather than linear: the radii span a factor of twenty, so a
   * linear map would put the smallest at a single pixel against the largest.
   * What changed is the RANGE the curve is fitted into, not the curve.
   */
  private buildSizes(): void {
    this.sizesEl.replaceChildren();
    const largest = BRUSH_SIZES[BRUSH_SIZES.length - 1] ?? 1;

    BRUSH_SIZES.forEach((radius, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'size';
      button.dataset['size'] = String(index);
      button.title = `Brush size ${index + 1}`;

      const dot = document.createElement('span');
      const px = 3 + 23 * Math.sqrt(radius / largest);
      dot.style.width = `${px.toFixed(1)}px`;
      dot.style.height = `${px.toFixed(1)}px`;
      button.append(dot);

      button.addEventListener('click', () => this.callbacks.onBrushSize(index));
      this.sizesEl.append(button);
    });
  }

  /**
   * The Strength number-drag.
   *
   * A horizontal drag on the label scrubs the value, and the field can still be
   * typed into -- the same affordance Tweakpane's number inputs offer, built by
   * hand because this control lives in the rail rather than in a pane.
   *
   * MULTIPLICATIVE, not additive: Strength is a gain, so a fixed step per pixel
   * would crawl at 8 and overshoot at 0.1. Scaling keeps the feel even across
   * the range, which matters more here because the value is unclamped.
   *
   * IT WRITES TO WHICHEVER TOOL IS ARMED. That is the whole point of the split
   * -- see `brushInput.ToolStrengths`.
   */
  private buildStrength(): void {
    const input = this.strengthInput;

    const commit = (value: number): void => {
      if (!Number.isFinite(value) || value <= 0) return;
      if (!usesStrength(this.tool)) return;
      // Trailing zeros removed, so a scrub reads as a number rather than as
      // fifteen decimal places of float noise.
      input.value = String(Number(value.toFixed(3)));
      this.callbacks.onStrength(this.tool, value);
    };

    input.addEventListener('change', () => commit(Number(input.value)));

    let dragging = false;
    let startX = 0;
    let startValue = 1;

    const label = this.strengthEl;
    label.addEventListener('pointerdown', (e) => {
      // Let a click INTO the field place the caret rather than starting a drag.
      if (e.target === input) return;
      if (!usesStrength(this.tool)) return;
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startValue = Number(input.value) || 1;
      label.setPointerCapture(e.pointerId);
    });
    label.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      // 1% per pixel, so a 100px drag roughly e-folds the value.
      commit(startValue * Math.exp((e.clientX - startX) * 0.01));
    });
    const end = (): void => {
      dragging = false;
    };
    label.addEventListener('pointerup', end);
    label.addEventListener('pointercancel', end);
  }

  /**
   * Rebuild the swatch buttons.
   *
   * Only when the count actually changed -- the dev slider is the one thing that
   * moves it, and rebuilding per frame would drop the right-click menu mid-open.
   */
  private buildSwatches(count: number): void {
    this.swatchesEl.replaceChildren();
    this.builtCount = count;

    for (let slot = 0; slot < count; slot++) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'swatch';
      button.dataset['slot'] = String(slot);

      const key = document.createElement('span');
      key.className = 'swatch-key';
      key.textContent = keyLabel(slot);
      const name = document.createElement('span');
      name.className = 'swatch-name';
      button.append(key, name);

      button.addEventListener('click', () => this.callbacks.onSelect(slot));
      // Right-click opens the menu for THIS swatch -- the Factorio-style "set
      // what this button paints", minus the tools, which moved to the rail.
      button.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.openLoader(slot);
      });

      this.swatchesEl.append(button);
    }
  }

  // -------------------------------------------------------------------------
  // Per-frame refresh
  // -------------------------------------------------------------------------

  /** Repaint selection, names, the hint and the banner. Cheap; called per frame. */
  refresh(state: {
    tool: SandTool;
    brushSize: number;
    strength: number;
    editingInitialConditions: boolean;
    /** The five assignments, for the world panel. */
    worlds: readonly WorldButtonState[];
    /** Which world is active, or `CUSTOM_WORLD`. */
    selectedWorld: number;
  }): void {
    this.tool = state.tool;
    this.refreshWorlds({ worlds: state.worlds, selected: state.selectedWorld });

    if (this.palette.visibleCount !== this.builtCount) {
      this.buildSwatches(this.palette.visibleCount);
    }

    const selected = this.palette.at(this.palette.selected);
    const loaded = selected.config !== null;

    // --- the rail ---------------------------------------------------------
    for (const el of this.toolsEl.children) {
      if (!(el instanceof HTMLElement)) continue;
      el.dataset['selected'] = String(el.dataset['tool'] === state.tool);
    }

    for (const el of this.sizesEl.children) {
      if (!(el instanceof HTMLElement)) continue;
      el.dataset['selected'] = String(Number(el.dataset['size']) === state.brushSize);
    }

    // --- Strength, which belongs to the armed tool ------------------------
    const enabled = usesStrength(state.tool);
    this.strengthEl.dataset['disabled'] = String(!enabled);
    this.strengthInput.disabled = !enabled;
    this.strengthLabel.textContent = enabled
      ? `${TOOL_LABELS[state.tool]} strength`
      : 'Strength (n/a)';
    this.strengthEl.title = enabled
      ? `Drag to scrub ${TOOL_LABELS[state.tool]}'s strength. Each tool keeps its own.`
      : 'Erase is a hard-radius kill — there is no strength to set.';
    // Not while the field has focus: rewriting it mid-edit would fight the
    // caret and discard a half-typed number.
    if (document.activeElement !== this.strengthInput) {
      this.strengthInput.value = String(Number(state.strength.toFixed(3)));
    }

    // --- the hint and its Clear button ------------------------------------
    this.hintEl.textContent = hintFor(state.tool, selected.name, loaded);
    this.clearTarget = clearTargetFor(state.tool);
    if (this.clearTarget === null) {
      this.clearButton.style.display = 'none';
    } else {
      this.clearButton.style.display = '';
      this.clearButton.textContent = CLEAR_LABELS[this.clearTarget] ?? 'Clear';
    }

    // --- the swatches -----------------------------------------------------
    for (const el of this.swatchesEl.children) {
      if (!(el instanceof HTMLElement)) continue;
      const slot = Number(el.dataset['slot']);
      const entry = this.palette.at(slot);
      el.dataset['selected'] = String(slot === this.palette.selected);
      el.dataset['master'] = String(slot === MASTER_SLOT);
      el.dataset['empty'] = String(entry.config === null);
      const name = el.querySelector('.swatch-name');
      if (name !== null) name.textContent = entry.name === '' ? 'empty' : entry.name;
      el.title =
        entry.name === ''
          ? 'Empty — right-click to load a config'
          : `${entry.name}${slot === MASTER_SLOT ? ' (master — grounds the world settings)' : ''}`;
    }

    // --- editing the initial conditions ------------------------------------
    this.canvas.dataset['editing'] = String(state.editingInitialConditions);
    this.bannerEl.dataset['visible'] = String(state.editingInitialConditions);

    // Only Brush reads the swatch, so dim the tray for the tools that do not --
    // it is the cheapest way to say "this selection is not in play right now".
    this.swatchesEl.style.opacity = usesSwatch(state.tool) ? '1' : '0.55';
  }

  setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  // -------------------------------------------------------------------------
  // The load menu
  // -------------------------------------------------------------------------

  /**
   * Open the config menu for a swatch.
   *
   * Entries compatible with the MASTER element's world settings are marked
   * green. Reading every config to test it would mean fetching the whole
   * catalog on open, so the test runs lazily per entry as each row is built and
   * an unreadable config is simply left unmarked.
   */
  openLoader(slot: number): void {
    this.loadingInto = slot;
    const label = keyLabel(slot);
    this.loaderSlotEl.textContent =
      (label === '' ? `#${slot + 1}` : label) + (slot === MASTER_SLOT ? ' (master)' : '');
    this.loaderEl.dataset['open'] = 'true';
    void this.fillLoader(slot);
  }

  closeLoader(): void {
    this.loadingInto = null;
    this.loaderEl.dataset['open'] = 'false';
  }

  private async fillLoader(slot: number): Promise<void> {
    this.loaderListEl.replaceChildren();

    // "NONE", ABOVE EVERYTHING ELSE -- it empties the swatch.
    //
    // ABSENT ON THE MASTER, which is the rule: the engine has one `WorldData`
    // and one trail field, and the master is where the scene's answer about
    // trail persistence and boundary comes from. An empty master would leave
    // the world running on a fallback nobody chose, so the option is not
    // offered rather than offered and refused.
    if (slot !== MASTER_SLOT) {
      const none = document.createElement('button');
      none.type = 'button';
      none.className = 'entry';
      none.dataset['none'] = 'true';
      none.textContent = 'None — clear this swatch';
      none.addEventListener('click', () => {
        this.closeLoader();
        this.callbacks.onClearSlot(slot);
      });
      this.loaderListEl.append(none);
    }

    const catalog = this.store.catalog();
    const master = this.palette.master.world;

    for (const [category, names] of Object.entries(catalog.categories)) {
      if (names.length === 0) continue;

      const heading = document.createElement('h3');
      heading.textContent = category;
      this.loaderListEl.append(heading);

      for (const name of names) {
        const entry = this.store.entry(category, name);
        if (entry === null) continue;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'entry';
        button.textContent = name;
        button.addEventListener('click', () => {
          this.closeLoader();
          this.callbacks.onLoad(slot, entry);
        });
        this.loaderListEl.append(button);

        // The compatibility mark. Asynchronous and best-effort: the row is
        // already clickable, and a config that fails to read just stays unmarked
        // rather than blocking the list.
        if (master !== null) {
          void this.markCompatible(button, entry, master);
        }
      }
    }
  }

  private async markCompatible(
    button: HTMLElement,
    entry: ConfigEntry,
    master: WorldSettings,
  ): Promise<void> {
    try {
      const saved = await this.store.read(entry);
      button.dataset['compatible'] = String(isCompatible(saved.world, master));
    } catch {
      // Unreadable: leave it unmarked rather than claiming either answer.
    }
  }
}

export { themeById };
