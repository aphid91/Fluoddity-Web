/**
 * The sand shell: sidebar, swatch bar, World menu and the load menu.
 *
 * The layout is the layout bench's (`docs/comps/sandLayout.html`), with the
 * choices recorded in `docs/comps/ui_controls.txt`. Plain DOM rather than
 * Tweakpane: this is a few dozen buttons that want to look like a paint
 * program. The settings window is the opposite case and does use the shared
 * registry -- see `sandPrefs.ts`.
 *
 * ## What this file owns, and what the stylesheet owns
 *
 * `sand.html` holds the containers, the look tokens and every size (as unitless
 * layout tokens). This file builds the buttons into the containers and makes
 * the decisions CSS cannot, all in `relayout`:
 *
 *   - the PLAN: sidebar on a landscape window, band on a portrait one;
 *   - the UI SCALE: raised on big screens until the canvas takes at most
 *     `CANVAS_MAX_SHARE` of the window;
 *   - the TOOL BOX: Erase/Shove/Walls buttons under Simulation, when the
 *     sidebar has room for it;
 *   - the SWATCHES: as many as fit, with their spacing widened when they fill
 *     too little of the bar.
 *
 * ## The canvas fills its cell
 *
 * No fitting and no letterbox: `#app` fills the stage, and `main.ts` builds the
 * world to the stage's shape, rebuilding it when the shape changes.
 */

import type { ConfigEntry, ConfigStore } from '../config/configStore.ts';
import type { WorldSettings } from '../particleSystem/config.ts';
import { BRUSH_SIZES } from './brushInput.ts';
import { isCompatible } from './compatibility.ts';
import { ASSIGNABLE_WORLDS, MASTER_SLOT, type Palette, keyLabel } from './palette.ts';
import { CUSTOM_WORLD } from './session.ts';
import {
  type EraseMode,
  type SandTool,
  ERASE_MODE_LABELS,
  TOOLS,
  TOOL_LABELS,
  nextEraseMode,
} from './tool.ts';
import type { SandTheme } from './theme.ts';
import { swatchColorToCss } from './swatchColor.ts';
// The studio's own tool descriptions, so the two apps cannot describe the same
// tool differently.
import { TOOL_HELP } from '../ui/menuHelp.ts';

/** The canvas may take at most this share of the window; see `relayout`. */
const CANVAS_MAX_SHARE = 0.75;
/** Swatches filling less than this share of the bar get wider spacing... */
const SWATCH_FILL = 0.5;
/** ...but never more than this, in the same units as `--sw-gap`. */
const SWATCH_GAP_MAX = 35;
/** How long a touch must hold still on a swatch to open its menu. */
const LONG_PRESS_MS = 500;
/** How far a touch may wander and still count as holding still, in px. */
const LONG_PRESS_SLOP = 10;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** One line per tool, for its tooltip. */
function hintFor(tool: SandTool): string {
  switch (tool) {
    case 'brush':
      return 'Paint the selected swatch  ·  right-drag erases';
    case 'erase':
      return 'Rub out particles and walls  ·  right-drag also pulls them in  ·  Shift for line tool';
    case 'stamp':
      return 'Stamp is not built yet';
    case 'shove':
      return `${TOOL_HELP.shove}  ·  right-drag does the opposite of Push/Pull`;
    default:
      return `${TOOL_HELP[tool]}  ·  right to erase  ·  Shift for line tool`;
  }
}

/**
 * Tool glyphs, as inline SVG paths on a 24-box, stroked in `currentColor` so a
 * selected button inverts its icon with it.
 */
const TOOL_ICONS: Readonly<Record<SandTool, string>> = {
  brush: '<path d="M17 3l4 4-9 9-4-4z"/><path d="M8 12l4 4-2 3a4 4 0 01-5 1 4 4 0 001-5z"/>',
  erase: '<path d="M4 16l8-8a2 2 0 013 0l4 4a2 2 0 010 3l-5 5H7z"/><path d="M9 21h12"/>',
  shove: '<path d="M12 4v16"/><path d="M8 8l4-4 4 4"/><path d="M8 16l4 4 4-4"/><path d="M3 12h4"/><path d="M17 12h4"/>',
  walls: '<path d="M3 6h18v12H3z"/><path d="M3 12h18"/><path d="M9 6v6"/><path d="M15 12v6"/>',
  trails: '<path d="M3 17c4-8 14 2 18-6"/>',
  stamp: '<path d="M8 3h8v5l2 4H6l2-4z"/><path d="M5 16h14v5H5z"/>',
};

const PLAY_ICON = '<path class="fill" d="M8 5.5v13l10.5-6.5z"/>';
const PAUSE_ICON = '<path class="fill" d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z"/>';
const RESET_ICON = '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4 4v4.5h4.5"/>';

/**
 * Stand-in artwork for the World menu's swatches, by world index; Custom has
 * its own. Placeholders until worlds carry a thumbnail.
 */
const WORLD_ART = [
  'radial-gradient(circle at 35% 35%, #b7e07a, #3f8a4a 55%, #173a22)',
  'conic-gradient(from 0deg, #5fb0e8, #1b2f5c, #b78be0, #1b2f5c, #5fb0e8)',
  'linear-gradient(160deg, #f0c078, #a5601a 50%, #3a2210)',
  'radial-gradient(circle at 60% 40%, #f08a7a, #4fc3b8 55%, #103a44)',
];
const CUSTOM_ART = 'conic-gradient(from 45deg, #3a3f4a, #6b7280, #3a3f4a, #6b7280, #3a3f4a)';

/** Stand-ins for stored stamps, until Stamp is built. */
const STAMP_ART = [
  'radial-gradient(circle at 30% 35%, #e8a33d 0 18%, transparent 19%), radial-gradient(circle at 65% 60%, #5fb0e8 0 22%, transparent 23%), #1d2027',
  'repeating-linear-gradient(45deg, #7cc27a 0 5px, #1d2027 5px 11px)',
];

/** The tools whose buttons live in the bar, or in the tool box. */
type ActionTool = 'erase' | 'shove' | 'walls';
type ActionId =
  | 'clear-particles'
  | 'erase-mode'
  | 'clear-walls'
  | 'restore-walls'
  | 'push'
  | 'pull';

interface ActionSpec {
  readonly id: ActionId;
  readonly label: string;
  readonly tint: 'red' | 'yellow' | 'white';
  /** Not built yet: pressing it says so. */
  readonly todo?: boolean;
}

const ACTIONS: Readonly<Record<ActionTool, readonly ActionSpec[]>> = {
  erase: [
    { id: 'clear-particles', label: 'Clear all particles', tint: 'red' },
    // Its label is the current mode, written by `refresh`.
    { id: 'erase-mode', label: 'Mode', tint: 'yellow' },
    { id: 'clear-walls', label: 'Clear all walls', tint: 'white' },
  ],
  shove: [
    { id: 'push', label: 'Push', tint: 'red' },
    { id: 'pull', label: 'Pull', tint: 'white' },
  ],
  walls: [
    { id: 'clear-walls', label: 'Clear all walls', tint: 'red' },
    { id: 'restore-walls', label: 'Restore initial walls', tint: 'white' },
  ],
};

function isActionTool(tool: SandTool): tool is ActionTool {
  return tool === 'erase' || tool === 'shove' || tool === 'walls';
}

export interface SandUiCallbacks {
  /** A swatch was clicked. */
  onSelect(slot: number): void;
  /** A tool was chosen. */
  onTool(tool: SandTool): void;
  /** A config was chosen for a swatch in the load menu. */
  onLoad(slot: number, entry: ConfigEntry): void;
  /** "Paste from link…" was chosen: decode the clipboard into this swatch. */
  onPasteLink(slot: number): void;
  /** "None" was chosen: empty this swatch. */
  onClearSlot(slot: number): void;
  /** A brush-size button was pressed. */
  onBrushSize(index: number): void;
  /**
   * A world was picked from the World menu.
   *
   * `index` is `CUSTOM_WORLD` for the editable world, or 0..3 for an assigned
   * one. PICKING THE ACTIVE WORLD IS NOT A NO-OP -- it is how the scene is reset
   * to that world's default.
   */
  onSelectWorld(index: number): void;
  onPlay(): void;
  onPause(): void;
  onReset(): void;
  onClearParticles(): void;
  onClearWalls(): void;
  onRestoreWalls(): void;
  /** Shove's Push (false) or Pull (true). */
  onShoveDirection(pull: boolean): void;
  /** Erase's Mode button: what the eraser takes from now on. */
  onEraseMode(mode: EraseMode): void;
  /** "Set as initial conditions": the paused scene becomes the one R restores. */
  onSetInitialConditions(): void;
  /** A button for something not built yet. `what` names it for the status line. */
  onNotBuilt(what: string): void;
}

/** What the World menu needs to draw one assigned world. */
export interface WorldButtonState {
  /** The save this button loads, or empty when unassigned. */
  readonly name: string;
  /** Whether that save still exists. False marks it as deleted. */
  readonly present: boolean;
}

export interface SandUiState {
  tool: SandTool;
  brushSize: number;
  paused: boolean;
  editingInitialConditions: boolean;
  /** The four assignments. */
  worlds: readonly WorldButtonState[];
  /** Which world is active, or `CUSTOM_WORLD`. */
  selectedWorld: number;
  shovePull: boolean;
  eraseMode: EraseMode;
}

export class SandUi {
  private readonly store: ConfigStore;
  private readonly callbacks: SandUiCallbacks;
  private palette: Palette | null = null;

  private readonly root = document.documentElement;
  private readonly shell: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly side: HTMLElement;
  private readonly simSection: HTMLElement;
  private readonly toolbox: HTMLElement;
  private readonly toolboxLabel: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly swatchesEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly bannerEl: HTMLElement;
  private readonly setIcButton: HTMLElement;
  private readonly worldPick: HTMLElement;
  private readonly worldGrid: HTMLElement;
  private readonly loaderEl: HTMLElement;
  private readonly loaderSlotEl: HTMLElement;
  private readonly loaderListEl: HTMLElement;

  private readonly toolButtons: HTMLButtonElement[] = [];
  private readonly sizeButtons: HTMLButtonElement[] = [];
  private readonly pushPull: HTMLButtonElement[] = [];
  /** Erase's Mode button, in the bar and in the tool box. */
  private readonly eraseModeButtons: HTMLButtonElement[] = [];
  /** The mode those buttons were last told, for `runAction` to step from. */
  private eraseMode: EraseMode | null = null;
  private playButton!: HTMLButtonElement;
  private pauseButton!: HTMLButtonElement;

  /** Which swatch the open menu is filling, or null when it is closed. */
  private loadingInto: number | null = null;
  private worldMenuOpen = false;

  /** The slots the bar shows, in order, before trimming to what fits. */
  private displayed: number[] = [];
  /** `displayed` as built, so `refresh` rebuilds only on a change. */
  private builtSignature = '';
  /** How many of `displayed` fit on screen; set by `layoutSwatches`. */
  private fitting = 0;
  /** The UI scale `relayout` settled on. */
  private uiScale = 1;

  /** A long-press opened a menu; swallow the click its release produces. */
  private suppressClickUntil = 0;

  /** Which worlds the World menu was built with, so it rebuilds on a change. */
  private worldSignature: string | null = null;

  constructor(store: ConfigStore, callbacks: SandUiCallbacks) {
    this.store = store;
    this.callbacks = callbacks;

    const byId = <T extends HTMLElement>(id: string): T => {
      const el = document.getElementById(id);
      if (el === null) throw new Error(`sand.html is missing #${id}`);
      return el as T;
    };

    this.shell = byId('shell');
    this.canvas = byId<HTMLCanvasElement>('app');
    this.side = byId('side');
    this.simSection = byId('simsec');
    this.toolbox = byId('toolbox');
    this.toolboxLabel = byId('toolbox-label');
    this.bar = byId('bar');
    this.swatchesEl = byId('swatches');
    this.statusEl = byId('sand-status');
    this.bannerEl = byId('ic-banner');
    this.setIcButton = byId('ic-set');
    this.setIcButton.addEventListener('click', () => this.callbacks.onSetInitialConditions());
    this.worldPick = byId('wpick');
    this.worldGrid = byId('wgrid');
    this.loaderEl = byId('loader');
    this.loaderSlotEl = byId('loader-slot');
    this.loaderListEl = byId('loader-list');

    this.buildTools(byId('tools'));
    this.buildSizes(byId('sizes'));
    this.buildSizes(byId('sizes-band'));
    this.buildSim(byId('simrow'), byId('reset-slot'));
    this.buildActions();
    this.buildStamps();
    this.buildWorlds([]);

    byId('wtrig').addEventListener('click', () => this.setWorldMenu(!this.worldMenuOpen));

    // A PRESS OUTSIDE THE WORLD MENU CLOSES IT. Capture phase, so it is seen
    // before anything else handles the press. A press on another control
    // still does what it does; a press on the CANVAS is used up by the close
    // -- the whole stroke, down to the release, since `main.ts` paints from
    // moves with a button held -- so dismissing the menu does not also paint.
    let swallowing: number | null = null;
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.worldMenuOpen) return;
        if (e.target instanceof Node && this.worldPick.contains(e.target)) return;
        this.setWorldMenu(false);
        if (e.target === this.canvas) {
          swallowing = e.pointerId;
          e.stopPropagation();
          e.preventDefault();
        }
      },
      { capture: true },
    );
    document.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerId === swallowing) e.stopPropagation();
      },
      { capture: true },
    );
    const endSwallow = (e: PointerEvent): void => {
      if (e.pointerId !== swallowing) return;
      swallowing = null;
      e.stopPropagation();
    };
    document.addEventListener('pointerup', endSwallow, { capture: true });
    document.addEventListener('pointercancel', endSwallow, { capture: true });

    // Clicking the backdrop closes. Scoped to the backdrop itself so a click
    // inside the panel does not.
    this.loaderEl.addEventListener('click', (e) => {
      if (e.target === this.loaderEl) this.closeLoader();
    });

    // A PLACEHOLDER SWATCH until a palette is attached, so the bar has its
    // real height from the first layout -- `main.ts` builds the world to the
    // canvas's shape before the palette exists.
    this.renderSwatches([0]);

    // The window's shape decides the plan, the scale and what fits.
    new ResizeObserver(() => this.relayout()).observe(this.shell);
    this.relayout();
  }

  /** Hand over the palette, once the orchestrator exists. */
  attach(palette: Palette): void {
    this.palette = palette;
    this.builtSignature = '';
  }

  get loaderOpen(): boolean {
    return this.loadingInto !== null;
  }

  /** The canvas's shape (w/h), which the world is built to. */
  canvasAspect(): number {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    return w > 0 && h > 0 ? w / h : 1;
  }

  /**
   * The swatches in bar order -- what the number keys and the wheel step
   * through. Includes any that do not fit on screen.
   */
  displayedSlots(): readonly number[] {
    return this.displayed;
  }

  applyTheme(theme: SandTheme): void {
    this.root.dataset['theme'] = theme.id;
    this.relayout();
  }

  setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  /** A unitless layout token from `sand.html`. */
  private token(name: string, fallback: number): number {
    const value = parseFloat(getComputedStyle(this.root).getPropertyValue(name));
    return Number.isFinite(value) ? value : fallback;
  }

  /**
   * Plan, scale, tool box and swatches -- everything that depends on the
   * window's size. Runs on every resize; cheap enough that it need not be
   * throttled beyond the observer's own once-per-frame delivery.
   */
  relayout(): void {
    const width = this.shell.clientWidth;
    const height = this.shell.clientHeight;
    if (width <= 0 || height <= 0) return;

    // --- the plan -------------------------------------------------------------
    const plan = height > width ? 'band' : 'sidebar';
    this.shell.dataset['plan'] = plan;

    // Measured with the tool box down; `boxFits` decides whether it goes up.
    this.shell.dataset['box'] = 'off';
    const setScale = (ui: number): void => {
      this.root.style.setProperty('--ui', String(ui));
    };
    const shareAt = (ui: number): number => {
      setScale(ui);
      return (this.canvas.clientWidth * this.canvas.clientHeight) / (width * height);
    };
    // Whether the tool box fits under Simulation. The free space is the
    // sidebar's height minus where Simulation ends -- offsetTop differences,
    // since both share an offset parent.
    const boxFits = (ui: number): boolean => {
      setScale(ui);
      const contentBottom =
        this.simSection.offsetTop + this.simSection.offsetHeight - this.side.offsetTop;
      const free = this.side.clientHeight - contentBottom;
      return free >= (this.token('--box-h', 170) + this.token('--pad', 5)) * ui;
    };
    const scrolls = (ui: number): boolean => {
      setScale(ui);
      return this.side.scrollHeight > this.side.clientHeight + 1;
    };
    /** Bisection for where `below(ui)` stops being true, between lo and hi. */
    const edge = (lo: number, hi: number, below: (ui: number) => boolean): [number, number] => {
      for (let k = 0; k < 12; k++) {
        const mid = (lo + hi) / 2;
        if (below(mid)) lo = mid;
        else hi = mid;
      }
      return [lo, hi];
    };

    // --- the UI scale ----------------------------------------------------------
    // On a big screen the tuned sizes leave the canvas nearly the whole window
    // and the controls tiny. So the scale rises until the canvas is down to
    // the target share. The share only falls as the scale rises, so bisection
    // finds the smallest scale that meets it. Capped at 4x.
    //
    // THE SCALE-UP MAY NOT COST THE SIDEBAR ANYTHING. If the tool box fitted
    // at the base scale it must still fit, and if the sidebar did not scroll
    // it must still not scroll -- a bigger UI that pushes the tool box back
    // into the bar, or hides Reset below a scrollbar, is worse than a canvas
    // over the target share. Both only get worse as the scale rises, so the
    // largest scale that keeps them is found by bisection too, and caps the
    // first. The box condition implies the scroll one (the box is the last
    // thing in the sidebar), so only one of them is checked.
    const base = this.token('--ui-base', 1.25);
    let ui = base;
    if (shareAt(base) > CANVAS_MAX_SHARE) {
      ui = edge(base, base * 4, (u) => shareAt(u) > CANVAS_MAX_SHARE)[1];
      if (plan === 'sidebar') {
        let keeps: ((u: number) => boolean) | null = null;
        if (boxFits(base)) keeps = boxFits;
        else if (!scrolls(base)) keeps = (u) => !scrolls(u);
        if (keeps !== null && !keeps(ui)) ui = edge(base, ui, keeps)[0];
      }
    }
    setScale(ui);
    this.uiScale = ui;

    // --- the tool box -----------------------------------------------------------
    // Only in the sidebar, and only if it fits under Simulation at this scale.
    if (plan === 'sidebar' && boxFits(ui)) this.shell.dataset['box'] = 'on';

    this.layoutSwatches();
  }

  /**
   * Show as many swatches as fit, and widen their spacing when they fill less
   * than `SWATCH_FILL` of the bar. Stamps share the spacing (`--sw-gap` is set
   * on the bar).
   */
  private layoutSwatches(): void {
    const ui = this.uiScale;
    const diameter = this.token('--sw-d', 44);
    const baseGap = this.token('--sw-gap', 5);
    const avail = this.swatchesEl.clientWidth;
    if (avail <= 0) return;

    const items = [...this.swatchesEl.children] as HTMLElement[];
    const fits = Math.max(1, Math.floor((avail + 0.5) / ((diameter + baseGap) * ui)));
    this.fitting = Math.min(items.length, fits);
    items.forEach((el, i) => {
      el.hidden = i >= this.fitting;
    });

    // Only ever widens, so it cannot change how many fit.
    let gap = baseGap;
    const target = avail * SWATCH_FILL;
    const shown = Math.max(1, this.fitting);
    if (shown * (diameter + gap) * ui < target && SWATCH_GAP_MAX > gap) {
      gap = Math.min(SWATCH_GAP_MAX, Math.max(gap, target / (shown * ui) - diameter));
    }
    this.bar.style.setProperty('--sw-gap', String(gap));
  }

  // -------------------------------------------------------------------------
  // Building
  // -------------------------------------------------------------------------

  private icon(paths: string, viewBox = '0 0 24 24'): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = paths;
    return svg;
  }

  private button(className: string, title: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.title = title;
    button.addEventListener('click', onClick);
    return button;
  }

  private buildTools(container: HTMLElement): void {
    for (const tool of TOOLS) {
      const button = this.button('b tool', hintFor(tool), () => this.callbacks.onTool(tool));
      button.dataset['tool'] = tool;
      const name = document.createElement('span');
      name.textContent = TOOL_LABELS[tool];
      button.append(this.icon(TOOL_ICONS[tool]), name);
      container.append(button);
      this.toolButtons.push(button);
    }
  }

  /**
   * The four size buttons. Built twice -- once under the tools for the
   * sidebar, once as the band's own section -- and both stay in step.
   *
   * The dots are sqrt-scaled: the radii span a factor of ten, so a linear map
   * would put the smallest at a single pixel against the largest.
   */
  private buildSizes(container: HTMLElement): void {
    const largest = BRUSH_SIZES[BRUSH_SIZES.length - 1] ?? 1;
    BRUSH_SIZES.forEach((radius, index) => {
      const button = this.button('b size', `Brush size ${index + 1}`, () =>
        this.callbacks.onBrushSize(index),
      );
      button.dataset['size'] = String(index);
      const dot = document.createElement('span');
      dot.style.setProperty('--dot', (4 + 12 * Math.sqrt(radius / largest)).toFixed(2));
      button.append(dot);
      container.append(button);
      this.sizeButtons.push(button);
    });
  }

  private buildSim(row: HTMLElement, resetSlot: HTMLElement): void {
    this.playButton = this.button('b round', 'Play  ·  Space', () => this.callbacks.onPlay());
    this.playButton.setAttribute('aria-label', 'Play');
    this.playButton.append(this.icon(PLAY_ICON));

    this.pauseButton = this.button('b round', 'Pause  ·  Space', () => this.callbacks.onPause());
    this.pauseButton.setAttribute('aria-label', 'Pause');
    this.pauseButton.append(this.icon(PAUSE_ICON));
    row.append(this.playButton, this.pauseButton);

    const reset = this.button(
      'b reset',
      'Restore the initial conditions  ·  R',
      () => this.callbacks.onReset(),
    );
    const label = document.createElement('span');
    label.textContent = 'Reset';
    reset.append(this.icon(RESET_ICON), label);
    resetSlot.replaceWith(reset);
  }

  private actionButton(spec: ActionSpec): HTMLButtonElement {
    const button = this.button(`b act ${spec.tint}`, spec.label, () => this.runAction(spec));
    button.textContent = spec.label;
    button.dataset['action'] = spec.id;
    if (spec.todo === true) {
      button.dataset['todo'] = 'true';
      button.title = `${spec.label} — not built yet`;
    }
    if (spec.id === 'push' || spec.id === 'pull') {
      button.classList.add('pp');
      this.pushPull.push(button);
    }
    if (spec.id === 'erase-mode') {
      button.title = 'What the eraser takes — click to change';
      this.eraseModeButtons.push(button);
    }
    return button;
  }

  private runAction(spec: ActionSpec): void {
    switch (spec.id) {
      case 'clear-particles':
        this.callbacks.onClearParticles();
        break;
      case 'clear-walls':
        this.callbacks.onClearWalls();
        break;
      case 'restore-walls':
        this.callbacks.onRestoreWalls();
        break;
      case 'push':
        this.callbacks.onShoveDirection(false);
        break;
      case 'pull':
        this.callbacks.onShoveDirection(true);
        break;
      case 'erase-mode':
        if (this.eraseMode !== null) this.callbacks.onEraseMode(nextEraseMode(this.eraseMode));
        break;
    }
  }

  /** Each action tool's buttons, once in the bar and once in the tool box. */
  private buildActions(): void {
    for (const tool of ['erase', 'shove', 'walls'] as const) {
      const inBar = document.createElement('div');
      inBar.className = 'acts';
      inBar.dataset['for'] = tool;
      const inBox = document.createElement('div');
      inBox.className = 'boxacts';
      inBox.dataset['for'] = tool;
      for (const spec of ACTIONS[tool]) {
        inBar.append(this.actionButton(spec));
        inBox.append(this.actionButton(spec));
      }
      this.bar.append(inBar);
      this.toolbox.append(inBox);
    }
  }

  /** Stamp's bar: New stamp, then the stored stamps. Placeholders. */
  private buildStamps(): void {
    const acts = document.createElement('div');
    acts.className = 'acts';
    acts.dataset['for'] = 'stamp';
    const stamps = document.createElement('div');
    stamps.className = 'stamps';
    const group = document.createElement('div');
    group.className = 'sgroup';

    const create = this.button('b act newstamp', 'New stamp — not built yet', () =>
      this.callbacks.onNotBuilt('New stamp'),
    );
    create.textContent = 'New stamp';
    create.dataset['todo'] = 'true';
    group.append(create);

    STAMP_ART.forEach((art, i) => {
      const item = document.createElement('div');
      item.className = 'sw st';
      const name = document.createElement('span');
      name.className = 'sw-name';
      name.textContent = ' ';
      const circle = this.button('swb', `Stamp ${i + 1} — not built yet`, () =>
        this.callbacks.onNotBuilt('Stamps'),
      );
      circle.style.setProperty('--p', art);
      item.append(name, circle);
      group.append(item);
    });

    stamps.append(group);
    acts.append(stamps);
    this.bar.append(acts);
  }

  /**
   * The World menu's grid: two columns, filled row by row with the ASSIGNED
   * worlds in order, and Custom… always last. Unassigned worlds take no
   * space, so with none assigned Custom… sits alone in the top-left.
   *
   * Rebuilt only when which worlds are assigned changes; `refreshWorlds`
   * relabels and marks selection per frame.
   */
  private buildWorlds(assigned: readonly number[]): void {
    this.worldGrid.replaceChildren();
    for (const index of [...assigned, CUSTOM_WORLD]) {
      const cell = document.createElement('div');
      cell.className = 'wsw';
      cell.dataset['world'] = String(index);
      const name = document.createElement('span');
      name.className = 'wl';
      const circle = this.button('wswb', '', () => {
        this.setWorldMenu(false);
        // FIRES EVEN WHEN ALREADY SELECTED -- see the callback.
        this.callbacks.onSelectWorld(index);
      });
      circle.style.setProperty(
        '--g',
        index === CUSTOM_WORLD ? CUSTOM_ART : (WORLD_ART[index] ?? CUSTOM_ART),
      );
      if (index === CUSTOM_WORLD) {
        name.textContent = 'Custom…';
        circle.title =
          'The editable world: no initial conditions, and a palette you build ' +
          'yourself. The Dev tab’s swatch count governs this one.';
      }
      cell.append(name, circle);
      this.worldGrid.append(cell);
    }
  }

  setWorldMenu(open: boolean): void {
    this.worldMenuOpen = open;
    this.worldPick.dataset['open'] = String(open);
  }

  private refreshWorlds(worlds: readonly WorldButtonState[], selected: number): void {
    const assigned: number[] = [];
    for (let i = 0; i < ASSIGNABLE_WORLDS; i++) {
      if ((worlds[i]?.name ?? '') !== '') assigned.push(i);
    }
    const signature = assigned.join(',');
    if (signature !== this.worldSignature) {
      this.worldSignature = signature;
      this.buildWorlds(assigned);
    }

    for (const cell of this.worldGrid.children) {
      if (!(cell instanceof HTMLElement)) continue;
      const index = Number(cell.dataset['world']);
      cell.dataset['selected'] = String(index === selected);
      if (index === CUSTOM_WORLD) continue;

      const entry = worlds[index];
      const name = entry?.name ?? '';
      const circle = cell.querySelector('button');
      const label = cell.querySelector('.wl');
      if (circle === null || label === null) continue;
      if (label.textContent !== name) label.textContent = name;
      if (entry?.present === true) {
        delete cell.dataset['missing'];
        circle.title = `Load ${name}. Picking it again resets the scene to this world’s initial conditions.`;
      } else {
        cell.dataset['missing'] = 'true';
        circle.title = `"${name}" was deleted. Reassign it on the Dev tab.`;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Swatches
  // -------------------------------------------------------------------------

  /**
   * Which slots the bar shows. In Custom, every slot up to the visible count,
   * empty ones as outlines to load into. In a world, only the filled ones --
   * an empty slot there is not something the visitor can use.
   */
  private computeDisplayed(palette: Palette, custom: boolean): number[] {
    const slots: number[] = [];
    for (let slot = 0; slot < palette.visibleCount; slot++) {
      if (custom || palette.at(slot).config !== null) slots.push(slot);
    }
    return slots;
  }

  private renderSwatches(slots: readonly number[]): void {
    this.swatchesEl.replaceChildren();
    for (const slot of slots) {
      const item = document.createElement('div');
      item.className = 'sw';
      item.dataset['slot'] = String(slot);
      const name = document.createElement('span');
      name.className = 'sw-name';
      name.textContent = ' ';
      const circle = document.createElement('button');
      circle.type = 'button';
      circle.className = 'swb';
      item.append(name, circle);
      this.wireSwatch(circle, slot);
      this.swatchesEl.append(item);
    }
  }

  /**
   * Click selects; right-click, or a long press on touch, opens the load menu.
   *
   * THE LONG PRESS IS THE SWATCH'S ONLY. It is armed on the swatch button
   * alone, so holding a finger still on the canvas is still an ordinary stroke
   * -- nothing on the canvas reads a long press.
   */
  private wireSwatch(circle: HTMLButtonElement, slot: number): void {
    circle.addEventListener('click', () => {
      if (performance.now() < this.suppressClickUntil) return;
      this.callbacks.onSelect(slot);
    });
    circle.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.openLoader(slot);
    });

    let timer: ReturnType<typeof setTimeout> | null = null;
    let startX = 0;
    let startY = 0;
    const cancel = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    circle.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      startX = e.clientX;
      startY = e.clientY;
      cancel();
      timer = setTimeout(() => {
        timer = null;
        this.suppressClickUntil = performance.now() + 800;
        this.openLoader(slot);
      }, LONG_PRESS_MS);
    });
    circle.addEventListener('pointermove', (e) => {
      if (timer === null) return;
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > LONG_PRESS_SLOP) cancel();
    });
    circle.addEventListener('pointerup', cancel);
    circle.addEventListener('pointercancel', cancel);
    circle.addEventListener('pointerleave', cancel);
  }

  // -------------------------------------------------------------------------
  // Per-frame refresh
  // -------------------------------------------------------------------------

  /** Repaint selection, names and which bar is up. Cheap; called per frame. */
  refresh(state: SandUiState): void {
    const palette = this.palette;
    if (palette === null) return;
    const custom = state.selectedWorld === CUSTOM_WORLD;

    // --- the swatch set: rebuilt only when it changes -----------------------
    this.displayed = this.computeDisplayed(palette, custom);
    const signature = `${custom}|${this.displayed.join(',')}`;
    if (signature !== this.builtSignature) {
      this.builtSignature = signature;
      this.renderSwatches(this.displayed);
      this.layoutSwatches();
    }

    for (const el of this.swatchesEl.children) {
      if (!(el instanceof HTMLElement)) continue;
      const slot = Number(el.dataset['slot']);
      const entry = palette.at(slot);
      const empty = entry.config === null;
      el.dataset['selected'] = String(slot === palette.selected);
      el.dataset['empty'] = String(empty);
      const name = el.firstElementChild;
      const label = empty ? 'empty' : entry.name;
      if (name !== null && name.textContent !== label) name.textContent = label;
      const circle = el.lastElementChild;
      if (circle instanceof HTMLElement) {
        const key = keyLabel(this.displayed.indexOf(slot));
        circle.title = empty
          ? 'Empty — right-click or long-press to load a config'
          : `${entry.name}${key === '' ? '' : `  ·  ${key}`}` +
            `${slot === MASTER_SLOT ? '  (master — grounds the world settings)' : ''}`;
        // A CUSTOM PROPERTY so the stylesheet decides how the colour is used.
        circle.style.setProperty('--swatch-color', swatchColorToCss(palette.colorOf(slot)));
      }
    }

    // --- sidebar ---------------------------------------------------------------
    for (const el of this.toolButtons) {
      el.dataset['selected'] = String(el.dataset['tool'] === state.tool);
    }
    for (const el of this.sizeButtons) {
      el.dataset['selected'] = String(Number(el.dataset['size']) === state.brushSize);
    }
    this.playButton.dataset['selected'] = String(!state.paused);
    this.pauseButton.dataset['selected'] = String(state.paused);
    for (const el of this.pushPull) {
      const pull = el.dataset['action'] === 'pull';
      el.dataset['selected'] = String(pull === state.shovePull);
    }
    if (this.eraseMode !== state.eraseMode) {
      this.eraseMode = state.eraseMode;
      for (const el of this.eraseModeButtons) {
        el.textContent = `Mode: ${ERASE_MODE_LABELS[state.eraseMode]}`;
      }
    }

    // --- which bar is up ------------------------------------------------------
    // Brush: the swatches. Stamp: its own bar, always. Erase/Shove/Walls: their
    // buttons, in the tool box when it is up (the bar then keeps the swatches)
    // or else over the bar.
    const boxOn = this.shell.dataset['box'] === 'on';
    let show = 'none';
    if (state.tool === 'stamp') show = 'stamp';
    else if (isActionTool(state.tool) && !boxOn) show = state.tool;
    if (this.bar.dataset['show'] !== show) this.bar.dataset['show'] = show;

    // The tool box shows the armed tool's buttons, or Erase's under Brush and
    // Stamp, which have none of their own there.
    const boxTool: ActionTool = isActionTool(state.tool) ? state.tool : 'erase';
    if (this.toolbox.dataset['for'] !== boxTool) {
      this.toolbox.dataset['for'] = boxTool;
      this.toolboxLabel.textContent = TOOL_LABELS[boxTool];
    }

    this.refreshWorlds(state.worlds, state.selectedWorld);

    // --- editing the initial conditions ------------------------------------------
    this.canvas.dataset['editing'] = String(state.editingInitialConditions);
    this.bannerEl.dataset['visible'] = String(state.editingInitialConditions);
    // The banner's other face: paused on a scene that is NOT being authored,
    // which is exactly when committing it as the initial conditions means
    // something. Pressing it re-arms, so the banner takes its place.
    this.setIcButton.dataset['visible'] = String(
      state.paused && !state.editingInitialConditions,
    );
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
    // Idempotent: on Android a long press also raises `contextmenu`.
    if (this.loadingInto === slot) return;
    this.loadingInto = slot;
    this.loaderSlotEl.textContent =
      `#${slot + 1}` + (slot === MASTER_SLOT ? ' (master)' : '');
    this.loaderEl.dataset['open'] = 'true';
    void this.fillLoader(slot);
  }

  closeLoader(): void {
    this.loadingInto = null;
    this.loaderEl.dataset['open'] = 'false';
  }

  private async fillLoader(slot: number): Promise<void> {
    this.loaderListEl.replaceChildren();
    const palette = this.palette;
    if (palette === null) return;

    // "PASTE FROM LINK", AT THE VERY TOP -- Shift+V aimed at this swatch, and
    // the only way to load a shared config on a phone. The clipboard is read
    // inside this click, which is the gesture browsers require for it.
    const paste = document.createElement('button');
    paste.type = 'button';
    paste.className = 'entry';
    paste.dataset['paste'] = 'true';
    paste.textContent = 'Paste from link…';
    paste.title = 'Load a Fluoddity share link or config from the clipboard';
    paste.addEventListener('click', () => {
      this.closeLoader();
      this.callbacks.onPasteLink(slot);
    });
    this.loaderListEl.append(paste);

    // "NONE", NEXT -- it empties the swatch. Absent on the
    // master: the master is where the scene's trail persistence and boundary
    // come from, so it may not be empty.
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
    const master = palette.master.world;

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
