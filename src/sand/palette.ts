/**
 * The swatch palette: forty config slots, of which a settable number are shown.
 *
 * ## The model
 *
 * A FLAT ARRAY OF FORTY. Slot 0 is the master. Nothing moves, ever.
 *
 * It was twenty in two rows of ten with an `X` key that swapped which row the
 * number keys addressed. Both the second row and the swap are gone: the swatch
 * bar is now a free-flowing strip along the bottom whose length is a dev slider,
 * and a "which row is active" flag has no visible referent in a strip that wraps
 * wherever the window happens to end. `1`-`0` now address the first ten slots
 * and nothing else, which is a smaller promise that stays true at every count.
 *
 * ## CAPACITY IS FIXED; ONLY THE DISPLAY VARIES
 *
 * `SLOT_COUNT` is a compile-time forty and the upload is always forty configs
 * long, because **a slot's index in `configsForUpload` IS its `config_index` on
 * the GPU** and every painted particle stores that index. A slider that actually
 * resized the array would renumber live slots on every change and silently
 * repoint every particle above the edit -- and shrinking it below a slot that
 * particles point at would leave them indexing past the end of `ConfigData`.
 *
 * So `visibleCount` draws fewer buttons and nothing else. A config parked in
 * slot 35 while the slider sits at 30 keeps its particles alive and correct; it
 * is merely not on screen. That is the whole reason the slider is safe to expose
 * as a dev control.
 *
 * ## The master slot
 *
 * Slot 0 owns the world settings -- trail persistence, diffusion, boundary --
 * because the engine has exactly one `WorldData` and one trail field. Every
 * other slot contributes its `ConfigData` (rule and physics) and its world
 * settings are discarded, read only by `isCompatible` to warn in the load menu.
 * It is also the one slot the load menu refuses to offer "None" for: an empty
 * master would leave the scene with no authored answer about trail persistence.
 */

import type { SimulationConfig, WorldSettings } from '../particleSystem/config.ts';
import { TOOL_CONFIG, type SandTool } from './tool.ts';

/**
 * How many slots exist, and therefore how long the GPU's `ConfigData` array is.
 *
 * FIXED, and larger than any sane visible count -- see the header on why this
 * cannot follow the slider. Forty is the ceiling the dev slider is clamped to,
 * so every reachable display count fits inside the allocation with no slack
 * logic anywhere.
 */
export const SLOT_COUNT = 40;

/** How many swatches a fresh session shows. */
export const DEFAULT_VISIBLE_COUNT = 30;

/** The fewest swatches the slider may show. Below this the bar is unusable. */
export const MIN_VISIBLE_COUNT = 5;

/**
 * How many swatches the number keys reach: `1`-`9` then `0`.
 *
 * Ten regardless of how many are shown. With the row swap gone this addresses
 * the first ten slots and nothing else -- see the header.
 */
export const KEYED_SLOTS = 10;

/**
 * How many worlds the Select World panel offers besides Custom.
 *
 * FIVE, so the panel is six buttons in three rows of two -- the tool rail's
 * shape, which is what the requirement asked for.
 *
 * ## Why it lives here rather than beside the panel that draws it
 *
 * Three modules need it and they cannot all reach the same place: `sandPrefs.ts`
 * builds five dropdowns from it, `sandUi.ts` draws the buttons, and
 * `session.ts` clamps a stored selection against it. The first two import
 * Tweakpane and the DOM, so `session.ts` -- which is the storage format and must
 * stay testable under `node --test` -- cannot import either.
 *
 * `palette.ts` is the leaf all three already depend on. Putting the count here
 * is what stops it being written out three times and drifting, which is exactly
 * what a hand-kept `5` in the session parser was on its way to doing.
 */
export const ASSIGNABLE_WORLDS = 5;

/**
 * The slot whose world settings govern the whole scene.
 *
 * Zero, and fixed. The load menu offers no "None" for it and the UI marks it,
 * so the scene always has an authored world to run under.
 */
export const MASTER_SLOT = 0;

/**
 * One swatch.
 *
 * ALWAYS A CONFIG SWATCH now. `tool` is retained as a field so stored sessions
 * keep their shape and so a slot carries its own discriminator, but the field
 * tools moved to the left rail and nothing writes anything but `TOOL_CONFIG`
 * here. An empty swatch is one whose `config` is null.
 */
export interface PaletteSlot {
  readonly tool: SandTool | typeof TOOL_CONFIG;
  readonly config: SimulationConfig | null;
  /** The config's own world settings, kept for the compatibility test. */
  readonly world: WorldSettings | null;
  /** Display name: the config file's, or empty. */
  readonly name: string;
}

export const EMPTY_SLOT: PaletteSlot = {
  tool: TOOL_CONFIG,
  config: null,
  world: null,
  name: '',
};

/** Whether this swatch holds something the Brush could paint. */
export function isLoaded(slot: PaletteSlot): boolean {
  return slot.config !== null;
}

/**
 * Clamp a requested display count into what the palette can show.
 *
 * Exposed so the dev slider and the session parser clamp identically rather
 * than each picking their own bounds.
 */
export function clampVisibleCount(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VISIBLE_COUNT;
  return Math.max(MIN_VISIBLE_COUNT, Math.min(SLOT_COUNT, Math.trunc(value)));
}

/**
 * Map a keyboard digit to a slot.
 *
 * `1`-`9` are slots 0-8 and `0` is slot 9 -- the Factorio convention, where the
 * key's printed digit is one-based and `0` means "the tenth". Returns null for
 * anything else.
 */
export function slotForDigit(key: string): number | null {
  if (key === '0') return KEYED_SLOTS - 1;
  if (key >= '1' && key <= '9') return Number(key) - 1;
  return null;
}

/** The digit printed on a swatch, or empty past the tenth. */
export function keyLabel(slot: number): string {
  if (slot < 0 || slot >= KEYED_SLOTS) return '';
  return slot === KEYED_SLOTS - 1 ? '0' : String(slot + 1);
}

export class Palette {
  private readonly slots: PaletteSlot[] = Array.from({ length: SLOT_COUNT }, () => EMPTY_SLOT);
  /** Replacement counter per swatch. See `set` and `generationOf`. */
  private readonly generations: number[] = Array.from({ length: SLOT_COUNT }, () => 0);

  /** The flat index of the selected swatch. */
  private _selected = 0;

  /** How many swatches the bar draws. Capacity is unaffected -- see the header. */
  private _visibleCount = DEFAULT_VISIBLE_COUNT;

  get selected(): number {
    return this._selected;
  }

  get visibleCount(): number {
    return this._visibleCount;
  }

  /**
   * Set how many swatches are DRAWN.
   *
   * Does not touch storage, the upload, or any particle. If the selection falls
   * off the end of the shortened bar it moves to the last visible swatch --
   * otherwise the selected swatch would be one nobody can see or click back to.
   */
  setVisibleCount(value: number): void {
    this._visibleCount = clampVisibleCount(value);
    if (this._selected >= this._visibleCount) this._selected = this._visibleCount - 1;
  }

  /** The master slot's config, which governs the world. Null if unset. */
  get master(): PaletteSlot {
    return this.slots[MASTER_SLOT] ?? EMPTY_SLOT;
  }

  at(slot: number): PaletteSlot {
    return this.slots[slot] ?? EMPTY_SLOT;
  }

  /** Every slot, in storage order. The UI decides how many to lay out. */
  all(): readonly PaletteSlot[] {
    return this.slots;
  }

  /**
   * The first swatch holding no config, or null when every one is full.
   *
   * SEARCHES THE VISIBLE RANGE ONLY. Filling a slot the user cannot see would
   * look exactly like the paste having failed. The master is skipped as well:
   * it is seeded at startup and is never empty in practice, but if it ever were,
   * quietly making a pasted config govern the world's trail settings is not what
   * "put this somewhere free" asked for.
   *
   * Drives Shift+V -- see `main.ts`.
   */
  firstEmpty(): number | null {
    for (let slot = 0; slot < this._visibleCount; slot++) {
      if (slot === MASTER_SLOT) continue;
      if (this.slots[slot]?.config == null) return slot;
    }
    return null;
  }

  /**
   * Replace a swatch's contents. Bumps its generation.
   *
   * ## What the generation is for
   *
   * The Config tab binds sliders to a COPY of a swatch's settings. Loading a
   * file into that swatch must throw those sliders away and show the file's
   * values -- "right-click load always overrides these settings and sets things
   * back to the saved config's". Comparing configs by identity would not do it
   * (an edit also produces a new object), and comparing by value would be both
   * expensive and wrong once an edit happens to restore a saved value.
   *
   * A counter is unambiguous: it moves on every replacement and on nothing else.
   */
  set(slot: number, entry: PaletteSlot): void {
    if (slot < 0 || slot >= SLOT_COUNT) return;
    this.slots[slot] = entry;
    this.generations[slot] = (this.generations[slot] ?? 0) + 1;
  }

  /**
   * Update a swatch's settings WITHOUT bumping its generation.
   *
   * The Config tab's own edits come back through here. Bumping would make the
   * tab rebuild itself on every slider frame, which resets the drag.
   */
  edit(slot: number, config: SimulationConfig, world: WorldSettings): void {
    if (slot < 0 || slot >= SLOT_COUNT) return;
    const current = this.slots[slot];
    if (current === undefined || current.config === null) return;
    this.slots[slot] = { ...current, config, world };
  }

  /** How many times this swatch's contents have been REPLACED. See `set`. */
  generationOf(slot: number): number {
    return this.generations[slot] ?? 0;
  }

  /**
   * Empty a swatch. The load menu's "None".
   *
   * REFUSES THE MASTER, which is the rule the menu enforces by hiding the
   * option: the scene needs one authored answer about trail persistence and
   * boundary, and the master is where it comes from. Guarded here as well so
   * the invariant does not depend on the menu being the only caller.
   */
  clear(slot: number): void {
    if (slot === MASTER_SLOT) return;
    this.set(slot, EMPTY_SLOT);
  }

  /** Select a flat slot index -- what clicking a swatch does. */
  select(slot: number): void {
    if (slot < 0 || slot >= SLOT_COUNT) return;
    this._selected = slot;
  }

  /**
   * The configs to upload, as a dense array indexed by slot.
   *
   * EVERY SLOT GETS AN ENTRY, empty ones and invisible ones included, so that a
   * slot's index in this array is its `config_index` on the GPU. Compacting --
   * or shortening this to the visible count -- would renumber the live slots and
   * silently repoint every particle already painted from a slot above the cut.
   *
   * Empty slots are filled with the master's config as a harmless stand-in --
   * nothing points at them, since a particle can only be painted from a slot the
   * user has loaded. A zeroed config would be worse: an all-zero rule is the
   * "generate a random rule" sentinel, so an empty slot would become a real
   * species the moment anything did point at it.
   */
  configsForUpload(fallback: SimulationConfig): readonly SimulationConfig[] {
    return this.slots.map((s) => s.config ?? fallback);
  }

  /** Whether any swatch holds a config. */
  get isEmpty(): boolean {
    return this.slots.every((s) => s.config === null);
  }
}
