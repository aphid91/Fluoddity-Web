/**
 * Which world a button loads: a BUILT-IN one shipped with the app, or one from
 * the author's own library.
 *
 * ## Stored as a string
 *
 * `builtin:<id>` for a shipped world, and the bare name for a library save.
 * A bare name is what every assignment was before built-in worlds existed, so
 * a stored session reads back unchanged. The cost is that a library world may
 * not be NAMED with the prefix -- `isReservedWorldName` is what the save prompt
 * asks.
 *
 * Built-in worlds are READ-ONLY. They are files the app fetches (see
 * `worldPack.ts`); editing one and saving it makes a library world of the
 * author's own, and the built-in one is untouched.
 *
 * A LEAF, testable under `node --test`.
 */

export const BUILTIN_PREFIX = 'builtin:';

export type WorldRef =
  | { readonly kind: 'builtin'; readonly id: string }
  | { readonly kind: 'library'; readonly name: string };

/** A stored reference, or null for an empty one (an unassigned button). */
export function parseWorldRef(raw: string): WorldRef | null {
  if (raw === '') return null;
  if (raw.startsWith(BUILTIN_PREFIX)) {
    const id = raw.slice(BUILTIN_PREFIX.length);
    return id === '' ? null : { kind: 'builtin', id };
  }
  return { kind: 'library', name: raw };
}

export function formatWorldRef(ref: WorldRef): string {
  return ref.kind === 'builtin' ? `${BUILTIN_PREFIX}${ref.id}` : ref.name;
}

export function builtinRef(id: string): string {
  return id === '' ? '' : `${BUILTIN_PREFIX}${id}`;
}

/** Whether a library world may not take this name -- it would read as built-in. */
export function isReservedWorldName(name: string): boolean {
  return name.startsWith(BUILTIN_PREFIX);
}
