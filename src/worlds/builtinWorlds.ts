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
 */

import { type PackWorld, type WorldPack, DEFAULT_PACK_URL, isGzip, readPack } from './worldPack.ts';

/** A world's two halves, from whichever source holds it. */
export interface WorldRecord {
  readonly document: unknown;
  readonly scene: ArrayBuffer | null;
}

export class BuiltinWorlds {
  readonly pack: WorldPack;
  private readonly base: string;

  private constructor(pack: WorldPack, base: string) {
    this.pack = pack;
    this.base = base;
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

  /** A world's document and scene, or null if the pack lacks it or a fetch fails. */
  async read(id: string): Promise<WorldRecord | null> {
    const world = this.find(id);
    if (world === null) return null;
    try {
      const docRes = await fetch(this.base + world.document);
      if (!docRes.ok) throw new Error(`${world.document}: HTTP ${docRes.status}`);
      const document: unknown = await docRes.json();

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
