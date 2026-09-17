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
  /** A brush-size button was pressed. */
  onBrushSize(index: number): void;
}

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

    this.buildSlots();
    this.buildSizes();

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

  /** Repaint selection, names and the master highlight. Cheap; called per frame. */
  refresh(brushSize: number): void {
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
