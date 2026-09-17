/**
 * The palette bar, the brush-size buttons and the config browser.
 *
 * Plain DOM rather than Tweakpane. The studio's panel is a registry-driven wall
 * of sliders and Tweakpane is exactly right for that; this is twenty squares and
 * five buttons that want to look like a game's hotbar, which is a job for a few
 * divs and a stylesheet. The PREFERENCES window is the opposite case and does
 * use the shared registry -- see `sandPrefs.ts`.
 *
 * ## The row swap
 *
 * `X` changes which row the number keys address. Nothing moves in storage (see
 * `palette.ts`), so rendering is a straight map over the flat array and the
 * green master highlight lands on whichever square holds slot 0 -- which is what
 * makes it follow the element rather than the position.
 */

import type { ConfigEntry, ConfigStore } from '../config/configStore.ts';
import type { WorldSettings } from '../particleSystem/config.ts';
import { BRUSH_SIZES } from './brushInput.ts';
import { isCompatible } from './compatibility.ts';
import { MASTER_SLOT, ROW_SIZE, type Palette, positionOf, rowOf } from './palette.ts';
import { FIELD_TOOLS, type SandTool, TOOL_CONFIG, TOOL_LABELS } from './tool.ts';
// The studio's own tool descriptions, so the two apps cannot describe the same
// tool differently.
import { TOOL_HELP } from '../ui/menuHelp.ts';

/** The digit printed on a square, Factorio-style: 1-9 then 0. */
function keyLabel(slot: number): string {
  const pos = positionOf(slot);
  return pos === ROW_SIZE - 1 ? '0' : String(pos + 1);
}

export interface SandUiCallbacks {
  /** A square was left-clicked or selected by key. */
  onSelect(slot: number): void;
  /** A config was chosen for a slot in the browser. */
  onLoad(slot: number, entry: ConfigEntry): void;
  /** A field tool was chosen for a slot in the browser. */
  onLoadTool(slot: number, tool: SandTool): void;
  /** A brush-size button was pressed. */
  onBrushSize(index: number): void;
  /** The Weight number-drag moved. */
  onWeight(weight: number): void;
  /** The hint bar's Clear button, for whatever the armed tool clears. */
  onClear(what: 'walls' | 'trails' | 'particles'): void;
}

/**
 * What the hint bar's Clear button wipes for each tool, and what it says.
 *
 * The wall/trail wording matches the studio's `CLEAR_FIELD_LABELS` -- these are
 * the same acts on the same textures, so they should read identically in both
 * apps. Shove clears nothing: it leaves nothing behind, which is the whole
 * difference between it and the painting tools.
 */
const CLEAR_LABELS: Readonly<Record<string, string>> = {
  walls: "Clear all barriers (Can't undo)",
  trails: "Clear all trails (Can't undo)",
  particles: "Clear all particles (Can't undo)",
};

export class SandUi {
  private readonly palette: Palette;
  private readonly store: ConfigStore;
  private readonly callbacks: SandUiCallbacks;

  private readonly rows: readonly HTMLElement[];
  private readonly sizesEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly loaderEl: HTMLElement;
  private readonly loaderSlotEl: HTMLElement;
  private readonly loaderListEl: HTMLElement;
  private readonly hintText: HTMLElement;
  private readonly clearButton: HTMLButtonElement;
  private readonly weightInput: HTMLInputElement;

  /** What the hint bar's Clear button wipes, or null when it is hidden. */
  private clearTarget: 'walls' | 'trails' | 'particles' | null = null;

  /** Which slot the open browser is filling, or null when it is closed. */
  private loadingInto: number | null = null;

  constructor(palette: Palette, store: ConfigStore, callbacks: SandUiCallbacks) {
    this.palette = palette;
    this.store = store;
    this.callbacks = callbacks;

    const byId = (id: string): HTMLElement => {
      const el = document.getElementById(id);
      if (el === null) throw new Error(`sand.html is missing #${id}`);
      return el;
    };

    this.rows = [byId('sand-row-0'), byId('sand-row-1')];
    this.sizesEl = byId('sand-sizes');
    this.statusEl = byId('sand-status');
    this.loaderEl = byId('sand-loader');
    this.loaderSlotEl = byId('sand-loader-slot');
    this.loaderListEl = byId('sand-loader-list');
    this.hintText = byId('sand-hint-text');
    this.clearButton = byId('sand-hint-clear') as HTMLButtonElement;
    this.weightInput = byId('sand-weight-input') as HTMLInputElement;

    this.buildSlots();
    this.buildSizes();
    this.buildWeight();

    this.clearButton.addEventListener('click', () => {
      if (this.clearTarget !== null) this.callbacks.onClear(this.clearTarget);
    });

    // Clicking the backdrop closes. Scoped to the backdrop itself so a click
    // inside the panel does not.
    this.loaderEl.addEventListener('click', (e) => {
      if (e.target === this.loaderEl) this.closeLoader();
    });
  }

  get loaderOpen(): boolean {
    return this.loadingInto !== null;
  }

  private buildSlots(): void {
    for (const row of this.rows) row.replaceChildren();

    for (let slot = 0; slot < ROW_SIZE * this.rows.length; slot++) {
      const button = document.createElement('button');
      button.className = 'sand-slot';
      button.dataset['slot'] = String(slot);

      const key = document.createElement('span');
      key.className = 'sand-key';
      key.textContent = keyLabel(slot);
      const name = document.createElement('span');
      name.className = 'sand-name';
      button.append(key, name);

      button.addEventListener('click', () => this.callbacks.onSelect(slot));
      // Right-click opens the browser for THIS square -- requirement 4's
      // Factorio-style "set what this button paints".
      button.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.openLoader(slot);
      });

      this.rows[rowOf(slot)]?.append(button);
    }
  }

  private buildSizes(): void {
    this.sizesEl.replaceChildren();
    const largest = BRUSH_SIZES[BRUSH_SIZES.length - 1] ?? 1;

    BRUSH_SIZES.forEach((radius, index) => {
      const button = document.createElement('button');
      button.className = 'sand-size';
      button.dataset['size'] = String(index);
      button.title = `Brush size ${index + 1}`;

      // The dot's diameter tracks the brush's, so the buttons read as a ramp.
      // sqrt, not linear: the smallest brush would otherwise be a single pixel
      // against the largest, since the radii span a factor of twenty.
      const dot = document.createElement('span');
      const px = 6 + 16 * Math.sqrt(radius / largest);
      dot.style.width = `${px}px`;
      dot.style.height = `${px}px`;
      button.append(dot);

      button.addEventListener('click', () => this.callbacks.onBrushSize(index));
      this.sizesEl.append(button);
    });
  }

  /**
   * The Weight number-drag.
   *
   * A horizontal drag on the label scrubs the value, and the field can still be
   * typed into -- the same affordance Tweakpane's number inputs offer, built by
   * hand because this control lives in the palette bar rather than in a pane.
   *
   * MULTIPLICATIVE, not additive: weight is a gain, so a fixed step per pixel
   * would crawl at 8 and overshoot at 0.1. Scaling keeps the feel even across
   * the range, which matters more here because the value is unclamped.
   */
  private buildWeight(): void {
    const input = this.weightInput;

    const commit = (value: number): void => {
      if (!Number.isFinite(value) || value <= 0) return;
      // Trailing zeros removed, so a scrub reads as a number rather than as
      // fifteen decimal places of float noise.
      input.value = String(Number(value.toFixed(3)));
      this.callbacks.onWeight(value);
    };

    input.addEventListener('change', () => commit(Number(input.value)));

    let dragging = false;
    let startX = 0;
    let startValue = 1;

    const label = input.parentElement;
    label?.addEventListener('pointerdown', (e) => {
      // Let a click INTO the field place the caret rather than starting a drag.
      if (e.target === input) return;
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startValue = Number(input.value) || 1;
      label.setPointerCapture(e.pointerId);
    });
    label?.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      // 1% per pixel, so a 100px drag roughly e-folds the value.
      commit(startValue * Math.exp((e.clientX - startX) * 0.01));
    });
    const end = (): void => {
      dragging = false;
    };
    label?.addEventListener('pointerup', end);
    label?.addEventListener('pointercancel', end);
  }

  /**
   * Update the hint bar for the armed tool.
   *
   * Reuses the studio's `TOOL_HELP` for the three field tools, so the two apps
   * cannot describe the same tool differently. The config case has its own line
   * because no studio tool corresponds to it.
   */
  private refreshHint(): void {
    const slot = this.palette.at(this.palette.selected);

    if (slot.tool === TOOL_CONFIG) {
      if (slot.config === null) {
        this.hintText.textContent =
          'Empty square — right-click it to load a config, or pick a tool';
        this.clearTarget = 'particles';
      } else {
        this.hintText.textContent =
          `Left click to paint [${slot.name}]  |  Right click to erase particles`;
        this.clearTarget = 'particles';
      }
    } else if (slot.tool === 'shove') {
      this.hintText.textContent = TOOL_HELP.shove;
      // Shove leaves nothing behind, so there is nothing to clear.
      this.clearTarget = null;
    } else {
      const noun = slot.tool === 'walls' ? 'barriers' : 'trails';
      this.hintText.textContent =
        `${TOOL_HELP[slot.tool]}  |  Left to draw, right to erase  |  ` +
        `Shift for line tool`;
      this.clearTarget = slot.tool;
      void noun;
    }

    if (this.clearTarget === null) {
      this.clearButton.style.display = 'none';
    } else {
      this.clearButton.style.display = '';
      this.clearButton.textContent = CLEAR_LABELS[this.clearTarget] ?? 'Clear';
    }
  }

  /** Repaint selection, names and the master highlight. Cheap; called per frame. */
  refresh(brushSize: number): void {
    this.refreshHint();
    this.rows.forEach((row, index) => {
      // Which row the NUMBER KEYS address. The squares never move.
      row.dataset['active'] = String((index === 0) === this.palette.topRowActive);
    });

    for (const el of this.rows.flatMap((r) => [...r.children])) {
      if (!(el instanceof HTMLElement)) continue;
      const slot = Number(el.dataset['slot']);
      const entry = this.palette.at(slot);
      el.dataset['selected'] = String(slot === this.palette.selected);
      el.dataset['master'] = String(slot === MASTER_SLOT);
      const name = el.querySelector('.sand-name');
      if (name !== null) name.textContent = entry.name;
      el.title = entry.name === '' ? 'Empty — right-click to load' : entry.name;
    }

    for (const el of this.sizesEl.children) {
      if (!(el instanceof HTMLElement)) continue;
      el.dataset['selected'] = String(Number(el.dataset['size']) === brushSize);
    }
  }

  setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  /**
   * Open the config browser for a slot.
   *
   * Entries compatible with the MASTER element's world settings are marked
   * green. Reading every config to test it would mean fetching the whole
   * catalog on open, so the test runs lazily per entry as each row is built and
   * an unreadable config is simply left unmarked.
   */
  openLoader(slot: number): void {
    this.loadingInto = slot;
    this.loaderSlotEl.textContent = keyLabel(slot) + (slot === MASTER_SLOT ? ' (master)' : '');
    this.loaderEl.dataset['open'] = 'true';
    void this.fillLoader(slot);
  }

  closeLoader(): void {
    this.loadingInto = null;
    this.loaderEl.dataset['open'] = 'false';
  }

  private async fillLoader(slot: number): Promise<void> {
    this.loaderListEl.replaceChildren();

    // THE FIELD TOOLS, ABOVE CORE. They are things a square can be, exactly like
    // a config is, so they belong in the same list rather than in a separate
    // selector -- see `tool.ts` on why one selection covers both.
    const toolsHeading = document.createElement('h3');
    toolsHeading.textContent = 'Tools';
    this.loaderListEl.append(toolsHeading);
    for (const tool of FIELD_TOOLS) {
      const button = document.createElement('button');
      button.className = 'sand-entry';
      button.textContent = TOOL_LABELS[tool];
      button.title = TOOL_HELP[tool];
      button.addEventListener('click', () => {
        this.closeLoader();
        this.callbacks.onLoadTool(slot, tool);
      });
      this.loaderListEl.append(button);
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
        button.className = 'sand-entry';
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
