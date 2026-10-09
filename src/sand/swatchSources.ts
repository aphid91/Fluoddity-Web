/**
 * Swatches from other palettes: what the load menu's Worlds section offers.
 *
 * A saved world, a built-in world, Custom's palette and the palette that is
 * open right now all hold the same thing per slot -- a config document, a
 * name, a colour and maybe an icon -- in two slightly different shapes
 * (`WorldSlot` in a world document, `StoredSlot` in the session and the live
 * palette). This reduces both to one `SourceSwatch`, which is what the menu
 * lists and what loading copies into a swatch.
 *
 * ## The whole swatch travels
 *
 * Loading a CONFIG into a swatch changes its material and leaves its colour
 * alone, because there the colour belongs to the slot. Loading a SWATCH copies
 * everything that made it that swatch: the config (with its world settings),
 * the name, the icon AND the colour. The point is to carry a hand-made palette
 * element into another world intact, and one that arrived without its colour
 * would render as a different material under Color By Swatch.
 *
 * A leaf: no DOM, no storage, no GPU.
 */

import type { WorldDocument } from '../worlds/worldFormat.ts';
import type { StoredSlot } from './session.ts';
import type { SwatchColor } from './swatchColor.ts';

/** One swatch another palette holds, ready to copy. */
export interface SourceSwatch {
  /** Where it sits in its own palette -- for the menu's `#n`, nothing else. */
  readonly slot: number;
  readonly name: string;
  /** A v8 config document. Parsed only when chosen (or marked compatible). */
  readonly document: unknown;
  readonly color?: SwatchColor;
  readonly icon?: string;
}

/**
 * A palette the menu can list.
 *
 * `key` is opaque to the menu: the host hands it back to read the swatches.
 */
export interface SwatchSource {
  readonly key: string;
  readonly label: string;
}

/** The keys for the two sources that are not saved worlds. */
export const OPEN_SOURCE = 'open';
export const CUSTOM_SOURCE = 'custom';

/**
 * The swatches in a session-shaped palette -- the live one, or Custom's set
 * aside. Indexed by slot already, so the index IS the slot. Empty slots (no
 * document) are dropped.
 */
export function swatchesFromStored(slots: readonly (StoredSlot | null | undefined)[]): SourceSwatch[] {
  const out: SourceSwatch[] = [];
  slots.forEach((s, slot) => {
    if (s === null || s === undefined || s.document === null || s.document === undefined) return;
    out.push({
      slot,
      name: s.name,
      document: s.document,
      ...(s.color === undefined ? {} : { color: s.color }),
      ...(s.icon === undefined ? {} : { icon: s.icon }),
    });
  });
  return out;
}

/** The swatches in a saved world. Its slots are sparse and carry their index. */
export function swatchesFromWorld(world: WorldDocument): SourceSwatch[] {
  return [...world.slots]
    .sort((a, b) => a.slot - b.slot)
    .map((s) => ({
      slot: s.slot,
      name: s.name,
      document: s.document,
      ...(s.color === undefined ? {} : { color: s.color }),
      ...(s.icon === undefined ? {} : { icon: s.icon }),
    }));
}

/** The key for a saved world, from its world reference (`worldRef.ts`). */
export function worldSourceKey(ref: string): string {
  return `world:${ref}`;
}

/** The world reference back out of a key, or null for the two special keys. */
export function worldRefOfKey(key: string): string | null {
  return key.startsWith('world:') ? key.slice('world:'.length) : null;
}

/**
 * The sources, in menu order: the open palette first (duplicating within the
 * world you are in is the commonest case), then Custom's when it is NOT the
 * open one, then the saved worlds -- built-ins before the library, as given.
 *
 * KEYS ARE PREFIXED, so a library world named "open" or "custom" cannot
 * collide with the two special sources.
 *
 * The open world's STORED copy is left out. It is offered live, as the first
 * row, with the user's unsaved edits; listing the stored one too would put two
 * rows of the same name side by side that differ in ways the menu cannot show.
 */
export function listSwatchSources(opts: {
  /** The open world's label, e.g. "Custom" or the world's name. */
  readonly openLabel: string;
  readonly customIsOpen: boolean;
  /** Whether Custom's palette has anything set aside to offer. */
  readonly customAvailable: boolean;
  /** Saved worlds, built-ins first: their reference and display name. */
  readonly worlds: readonly { readonly ref: string; readonly label: string }[];
  /** The open world's reference, or null when Custom is open. */
  readonly openRef: string | null;
}): SwatchSource[] {
  const out: SwatchSource[] = [{ key: OPEN_SOURCE, label: `${opts.openLabel} (open)` }];
  if (!opts.customIsOpen && opts.customAvailable) {
    out.push({ key: CUSTOM_SOURCE, label: 'Custom' });
  }
  for (const { ref, label } of opts.worlds) {
    if (ref === opts.openRef) continue;
    out.push({ key: worldSourceKey(ref), label });
  }
  return out;
}
