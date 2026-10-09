/**
 * The built-in worlds: the default world pack, fetched.
 *
 * The browser half of `worldPack.ts`. The manifest is fetched once at startup;
 * a world's document and scene only when that world is opened, which is what
 * keeps a new visitor from downloading every scene the app ships.
 *
 * A MISSING PACK IS NOT AN ERROR. Until one is exported and committed there is
 * nothing at `DEFAULT_PACK_URL`, and the app runs as it did before packs: no
 * built-in worlds, Custom for a new visitor.
 *
 * ## ICONS COME OUT AS FULL URLS
 *
 * A pack names its icons by file (`worldPack.ts`). Everything handed out of
 * here -- the documents, Custom's swatches, `iconUrl` -- has them resolved
 * against the pack's absolute address, so the rest of the app treats a pack
 * icon like any other image URL and never needs to know the pack's base.
 */

import { type PackWorld, type WorldPack, DEFAULT_PACK_URL, isGzip, readPack } from './worldPack.ts';
import { mapWorldIcons } from './worldFormat.ts';
import { resolveIcon } from '../sand/swatchIcon.ts';

/** A world's two halves, from whichever source holds it. */
export interface WorldRecord {
  readonly document: unknown;
  readonly scene: ArrayBuffer | null;
}

export class BuiltinWorlds {
  readonly pack: WorldPack;
  private readonly base: string;
  /** `base` made absolute, for resolving icon file names. */
  private readonly absoluteBase: string;

  private constructor(pack: WorldPack, base: string) {
    this.base = base;
    this.absoluteBase = new URL(base, document.baseURI).href;
    // Custom's swatches and icon resolved once, here, so a new visitor's
    // session stores URLs that work from anywhere.
    this.pack = {
      ...pack,
      customSlots: pack.customSlots.map((slot) =>
        slot.icon === undefined
          ? slot
          : { ...slot, icon: resolveIcon(slot.icon, this.absoluteBase) },
      ),
      customIcon:
        pack.customIcon === null ? null : resolveIcon(pack.customIcon, this.absoluteBase),
    };
  }

  /** The pack at `base`, or null if there is none or it cannot be read. */
  static async load(base = DEFAULT_PACK_URL): Promise<BuiltinWorlds | null> {
    try {
      // `no-cache`: revalidated every visit, so a new pack is picked up at
      // once. The assets it names are content-hashed and may cache forever.
      const res = await fetch(`${base}manifest.json`, { cache: 'no-cache' });
      if (!res.ok) return null;
      // A dev server answers a missing file with index.html; that fails here
      // as JSON and means "no pack", like a 404.
      return new BuiltinWorlds(readPack(await res.json(), `${base}manifest.json`), base);
    } catch (e) {
      console.info(`No default world pack: ${String(e)}`);
      return null;
    }
  }

  find(id: string): PackWorld | null {
    return this.pack.worlds.find((w) => w.id === id) ?? null;
  }

  /** A world's icon as a URL, or null when it has none or is not in the pack. */
  iconUrl(id: string): string | null {
    const icon = this.find(id)?.icon ?? null;
    return icon === null ? null : resolveIcon(icon, this.absoluteBase);
  }

  /**
   * A world's document ALONE, icons resolved, or null if the pack lacks it or
   * the fetch fails. For the load menu, which lists a world's swatches and has
   * no use for its scene -- `read` would fetch and gunzip megabytes of
   * particles just to show twenty names.
   */
  async readDocument(id: string): Promise<unknown> {
    const world = this.find(id);
    if (world === null) return null;
    try {
      const res = await fetch(this.base + world.document);
      if (!res.ok) throw new Error(`${world.document}: HTTP ${res.status}`);
      return await mapWorldIcons(await res.json(), (icon) =>
        resolveIcon(icon, this.absoluteBase),
      );
    } catch (e) {
      console.error(`Could not fetch the built-in world "${id}": ${String(e)}`);
      return null;
    }
  }

  /** A world's document and scene, or null if the pack lacks it or a fetch fails. */
  async read(id: string): Promise<WorldRecord | null> {
    const world = this.find(id);
    if (world === null) return null;
    try {
      const docRes = await fetch(this.base + world.document);
      if (!docRes.ok) throw new Error(`${world.document}: HTTP ${docRes.status}`);
      const document = await mapWorldIcons(await docRes.json(), (icon) =>
        resolveIcon(icon, this.absoluteBase),
      );

      let scene: ArrayBuffer | null = null;
      if (world.scene !== null) {
        const sceneRes = await fetch(this.base + world.scene);
        if (!sceneRes.ok) throw new Error(`${world.scene}: HTTP ${sceneRes.status}`);
        scene = await maybeGunzip(await sceneRes.arrayBuffer());
      }
      return { document, scene };
    } catch (e) {
      console.error(`Could not fetch the built-in world "${id}": ${String(e)}`);
      return null;
    }
  }
}

/**
 * Decompress if gzipped, else pass through. TESTED BY MAGIC NUMBER rather than
 * trusted to the extension, so a host that serves the file with its own
 * `Content-Encoding` -- which the browser undoes before this sees it -- works
 * as well as one that serves it verbatim.
 */
async function maybeGunzip(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  if (!isGzip(new Uint8Array(bytes))) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}
