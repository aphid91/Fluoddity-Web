/**
 * The brush palette: twenty config slots in two rows of ten, Factorio-style.
 *
 * ## The model
 *
 * A FLAT ARRAY OF TWENTY, plus a flag for which row the number keys currently
 * address. Slots 0-9 are the first row, 10-19 the second, and they never move --
 * `X` changes which row `1`-`0` select from, not where anything lives.
 *
 * That distinction is the whole design. The obvious alternative -- two arrays
 * that get swapped -- makes `X` a mutation of the data, which means the master
 * slot's identity has to be chased through the swap. Here nothing moves, so the
 * master is permanently slot 0 and the green highlight follows it for free,
 * appearing on the top row or the bottom depending only on which row is active.
 * Requirement 4 asks for exactly that behaviour and it falls out of the model
 * rather than being implemented.
 *
 * ## The master slot
 *
 * Slot 0 owns the world settings -- trail persistence, diffusion, boundary --
 * because the engine has exactly one `WorldData` and one trail field. Every
 * other slot contributes its `ConfigData` (rule and physics) and its world
 * settings are discarded, read only by `isCompatible` to warn in the load menu.
 */

import type { SimulationConfig, WorldSettings } from '../particleSystem/config.ts';

/** Slots per row. Ten, addressed by `1`-`9` then `0`. */
export const ROW_SIZE = 10;
/** Two rows. */
export const ROW_COUNT = 2;
/** Total slots. */
export const SLOT_COUNT = ROW_SIZE * ROW_COUNT;

/**
 * The slot whose world settings govern the whole scene.
 *
 * Zero, and fixed. It is an index into the flat array, so it is unaffected by
 * which row is active -- which is what makes the green highlight follow the
 * element through a row swap rather than staying on the top-left square.
 */
export const MASTER_SLOT = 0;

/** One palette square. `config` of null is an empty square. */
export interface PaletteSlot {
  readonly config: SimulationConfig | null;
  /** The config's own world settings, kept for the compatibility test. */
  readonly world: WorldSettings | null;
  /** Display name, from the config file. */
  readonly name: string;
}

export const EMPTY_SLOT: PaletteSlot = { config: null, world: null, name: '' };

/**
 * Which flat index the number keys address.
 *
 * `position` is 0-9 within the active row. `topRowActive` false addresses the
 * second row, which is what `X` toggles.
 */
export function slotForKey(position: number, topRowActive: boolean): number {
  const clamped = Math.max(0, Math.min(ROW_SIZE - 1, Math.trunc(position)));
  return topRowActive ? clamped : clamped + ROW_SIZE;
}

/**
 * Which row a flat slot index belongs to. 0 is the first row.
 *
 * Used by the UI to decide which squares to draw on top when the rows are
 * swapped -- the DISPLAY order changes, the storage order never does.
 */
export function rowOf(slot: number): number {
  return Math.floor(slot / ROW_SIZE);
}

/** Position within its row, 0-9. */
export function positionOf(slot: number): number {
  return slot % ROW_SIZE;
}

/**
 * Map a keyboard digit to a row position.
 *
 * `1`-`9` are positions 0-8 and `0` is position 9 -- the Factorio convention,
 * where the key's printed digit is one-based and `0` means "the tenth". Returns
 * null for anything else.
 */
export function positionForDigit(key: string): number | null {
  if (key === '0') return ROW_SIZE - 1;
  if (key >= '1' && key <= '9') return Number(key) - 1;
  return null;
}

export class Palette {
  private readonly slots: PaletteSlot[] = Array.from({ length: SLOT_COUNT }, () => EMPTY_SLOT);
  /** Replacement counter per square. See `set` and `generationOf`. */
  private readonly generations: number[] = Array.from({ length: SLOT_COUNT }, () => 0);

  /** Which row the number keys address. `X` toggles it. */
  private _topRowActive = true;
  /** The flat index of the selected square. */
  private _selected = 0;

  get topRowActive(): boolean {
    return this._topRowActive;
  }

  get selected(): number {
    return this._selected;
  }

  /** The master slot's config, which governs the world. Null if unset. */
  get master(): PaletteSlot {
    return this.slots[MASTER_SLOT] ?? EMPTY_SLOT;
  }

  at(slot: number): PaletteSlot {
    return this.slots[slot] ?? EMPTY_SLOT;
  }

  /** Every slot, in storage order. The UI decides how to lay them out. */
  all(): readonly PaletteSlot[] {
    return this.slots;
  }

  /**
   * Replace a square's contents. Bumps its generation.
   *
   * ## What the generation is for
   *
   * The Config tab binds sliders to a COPY of a square's settings. Loading a
   * file into that square must throw those sliders away and show the file's
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
   * Update a square's settings WITHOUT bumping its generation.
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

  /** How many times this square's contents have been REPLACED. See `set`. */
  generationOf(slot: number): number {
    return this.generations[slot] ?? 0;
  }

  clear(slot: number): void {
    this.set(slot, EMPTY_SLOT);
  }

  /** Select a flat slot index directly -- what clicking a square does. */
  select(slot: number): void {
    if (slot < 0 || slot >= SLOT_COUNT) return;
    this._selected = slot;
    // Selecting a square on the other row makes THAT row active, so the number
    // keys keep addressing what the user is looking at. Without this, clicking a
    // bottom-row square would leave `1` selecting a top-row one.
    this._topRowActive = rowOf(slot) === 0;
  }

  /** Select by number key within the active row. */
  selectPosition(position: number): void {
    this._selected = slotForKey(position, this._topRowActive);
  }

  /**
   * Swap which row the number keys address, keeping the SAME SQUARE selected.
   *
   * The selection moves to the corresponding position in the newly active row,
   * which is what makes `X` feel like flipping a toolbar rather than jumping to
   * an arbitrary square.
   */
  swapRows(): void {
    this._topRowActive = !this._topRowActive;
    this._selected = slotForKey(positionOf(this._selected), this._topRowActive);
  }

  /**
   * The configs to upload, as a dense array indexed by slot.
   *
   * EVERY SLOT GETS AN ENTRY, empty ones included, so that a slot's index in
   * this array is its `config_index` on the GPU. Compacting would renumber the
   * live slots and silently repoint every particle already painted from a slot
   * above a gap.
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

  /** Whether any square holds a config. */
  get isEmpty(): boolean {
    return this.slots.every((s) => s.config === null);
  }
}
