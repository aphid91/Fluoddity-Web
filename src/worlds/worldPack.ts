/**
 * A WORLD PACK: the set of worlds a new visitor starts with.
 *
 * The worlds counterpart of `sand/sandDefaults.json`. That file holds
 * SETTINGS and is bundled; this holds CONTENT -- palettes and multi-megabyte
 * scenes -- so it is a folder of files the app fetches:
 *
 *   public/worlds/default/
 *     manifest.json                 this module's format
 *     <id>.<hash>.json              one world's document (`worldFormat.ts`)
 *     <id>.<hash>.fwldz             its scene: a `.fwld` stamp, gzipped
 *     <id>.<hash>.jpg               its icon, and its swatches' icons
 *
 * The Dev tab's "Export world setup" writes the folder as a zip; unzip it over
 * `public/worlds/default/` (emptied first) and commit.
 *
 * ## Why a folder of files, not one bundle
 *
 * A WORLD is the unit -- a document, its scene and its icons -- and
 * the manifest is only a LINEUP that points at worlds. A future gallery serves
 * the same units from object storage, so the format written here is that one.
 * Separate files also load lazily: a visitor fetches only the scene of the
 * world they open.
 *
 * ## Icons are files too
 *
 * In the author's library an icon is a data URL inside the document
 * (`sand/swatchIcon.ts`); the exporter writes each one out as a file and puts
 * its NAME in the document instead, and `builtinWorlds.ts` resolves the names
 * against the pack's address on the way in. A world's own icon is ALSO named
 * here in the manifest, so the World menu can show it without fetching the
 * world.
 *
 * ## The hash in the name
 *
 * `public/` files are not fingerprinted by the build, so the exporter names
 * each asset by its content. A changed world gets a new name, which lets the
 * host cache every asset forever; only `manifest.json` must be revalidated.
 *
 * ## Built-in worlds are read-only
 *
 * Referenced as `builtin:<id>` (see `worldRef.ts`), never copied into the
 * visitor's library -- so improving a shipped world reaches everyone still
 * pointing at it.
 *
 * ## Not in the pack
 *
 * WHICH SWATCH IS SELECTED. Every world opens on the master swatch, so there
 * is nothing to record. Custom's swatch COUNT lives in `sandDefaults.json`
 * with the other settings.
 *
 * A LEAF, testable under `node --test`.
 */

import { type StoredSlot, asSlot } from '../sand/session.ts';
import { ASSIGNABLE_WORLDS, SLOT_COUNT } from '../sand/palette.ts';

/** Bumped only if the manifest's shape changes incompatibly. */
export const PACK_VERSION = 1;

/** Where the default pack is served from, relative to the page. */
export const DEFAULT_PACK_URL = 'worlds/default/';

/** One world the pack ships. */
export interface PackWorld {
  /** Stable id, referenced as `builtin:<id>`. Lowercase, url-safe. */
  readonly id: string;
  /** Display name. */
  readonly name: string;
  /** The world document's file, relative to the manifest. */
  readonly document: string;
  /** The scene's file (gzipped `.fwld`), or null for a world without one. */
  readonly scene: string | null;
  /** The world's icon file, or null for the stand-in artwork. */
  readonly icon: string | null;
}

export interface WorldPack {
  readonly version: number;
  readonly worlds: readonly PackWorld[];
  /** A pack world's id per world button, or '' for an empty button. */
  readonly assignments: readonly string[];
  /** Which button a new visitor starts on, or `CUSTOM_WORLD` (-1). */
  readonly selectedWorld: number;
  /** Custom's palette for a new visitor, in the session's stored shape. */
  readonly customSlots: readonly StoredSlot[];
  /** Custom's world icon file for a new visitor, or null. */
  readonly customIcon: string | null;
}

/** Thrown for a manifest this reader will not accept. */
export class WorldPackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorldPackError';
  }
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** A relative file name in the pack folder: no directories, no dot-files. */
const FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Parse a manifest.
 *
 * Strict about the VERSION and about file names -- a name with a slash would
 * fetch from outside the pack -- and tolerant elsewhere: a malformed world is
 * dropped, and so is an assignment naming a world the pack does not have.
 */
export function readPack(raw: unknown, where = 'world pack'): WorldPack {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new WorldPackError(`${where}: not a JSON object`);
  }
  const o = raw as Record<string, unknown>;
  if (o['version'] !== PACK_VERSION) {
    throw new WorldPackError(
      `${where}: unrecognized pack version ${String(o['version'])}; expected ${PACK_VERSION}`,
    );
  }

  const worlds: PackWorld[] = [];
  const seen = new Set<string>();
  if (Array.isArray(o['worlds'])) {
    for (const item of o['worlds']) {
      if (typeof item !== 'object' || item === null) continue;
      const w = item as Record<string, unknown>;
      const id = w['id'];
      const document = w['document'];
      const scene = w['scene'];
      // Optional and tolerant: a bad icon name costs the icon, not the world.
      const icon = asFile(w['icon']);
      if (typeof id !== 'string' || !ID_PATTERN.test(id) || seen.has(id)) continue;
      if (typeof document !== 'string' || !FILE_PATTERN.test(document)) continue;
      if (scene !== null && (typeof scene !== 'string' || !FILE_PATTERN.test(scene))) continue;
      seen.add(id);
      worlds.push({
        id,
        name: typeof w['name'] === 'string' && w['name'] !== '' ? w['name'] : id,
        document,
        scene,
        icon,
      });
    }
  }

  const assignmentsRaw = Array.isArray(o['assignments']) ? o['assignments'] : [];
  const assignments = Array.from({ length: ASSIGNABLE_WORLDS }, (_, i) => {
    const a = assignmentsRaw[i];
    return typeof a === 'string' && seen.has(a) ? a : '';
  });

  // A button that is out of range, or empty, cannot be the one a visitor
  // starts on -- Custom is.
  const sel = o['selectedWorld'];
  const selectedWorld =
    typeof sel === 'number' &&
    Number.isInteger(sel) &&
    sel >= 0 &&
    sel < ASSIGNABLE_WORLDS &&
    assignments[sel] !== ''
      ? sel
      : -1;

  const customRaw = Array.isArray(o['customSlots']) ? o['customSlots'] : [];
  const customSlots = customRaw.slice(0, SLOT_COUNT).map(asSlot);

  return {
    version: PACK_VERSION,
    worlds,
    assignments,
    selectedWorld,
    customSlots,
    customIcon: asFile(o['customIcon']),
  };
}

/** A pack file name, or null. */
function asFile(raw: unknown): string | null {
  return typeof raw === 'string' && FILE_PATTERN.test(raw) ? raw : null;
}

/** The manifest's text. */
export function writePack(pack: Omit<WorldPack, 'version'>): string {
  return (
    JSON.stringify(
      {
        version: PACK_VERSION,
        worlds: pack.worlds,
        assignments: pack.assignments,
        selectedWorld: pack.selectedWorld,
        customSlots: pack.customSlots,
        customIcon: pack.customIcon,
      },
      null,
      2,
    ) + '\n'
  );
}

/**
 * A pack id for a world's name: lowercase, url-safe, and not in `taken`.
 * Falls back to `world` for a name with nothing usable in it.
 */
export function packId(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'world';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** An asset's file name: the world's id, a content hash, the extension. */
export function packFileName(
  id: string,
  hash: string,
  extension: 'json' | 'fwldz' | 'jpg' | 'png' | 'webp',
): string {
  return `${id}.${hash}.${extension}`;
}

/** Whether bytes start with the gzip magic number. */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}
