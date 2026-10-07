/**
 * Write the author's world setup as a world pack, zipped.
 *
 * The Dev tab's "Export world setup". The zip holds exactly what belongs in
 * `public/worlds/default/` -- empty that folder, unzip into it, commit. See
 * `worldPack.ts` for the format.
 *
 * `fflate` is imported on demand: exporting is a dev act, and a visitor should
 * not download a zip writer they will never run.
 */

import type { StoredSlot } from '../sand/session.ts';
import type { WorldRecord } from './builtinWorlds.ts';
import { type PackWorld, packFileName, packId, writePack } from './worldPack.ts';

/** One button's world, with a key that is the same for the same world. */
export interface ExportButton {
  /** Its reference string -- two buttons on one world share a pack entry. */
  readonly key: string;
  readonly name: string;
  readonly record: WorldRecord;
}

export async function buildPackZip(args: {
  /** Per button, or null for an empty one. */
  readonly buttons: readonly (ExportButton | null)[];
  readonly selectedWorld: number;
  readonly customSlots: readonly StoredSlot[];
}): Promise<Blob> {
  const files: Record<string, Uint8Array<ArrayBuffer>> = {};
  const worlds: PackWorld[] = [];
  const idForKey = new Map<string, string>();
  const taken = new Set<string>();

  const assignments: string[] = [];
  for (const button of args.buttons) {
    if (button === null) {
      assignments.push('');
      continue;
    }
    let id = idForKey.get(button.key);
    if (id === undefined) {
      id = packId(button.name, taken);
      taken.add(id);
      idForKey.set(button.key, id);

      const docBytes = new TextEncoder().encode(JSON.stringify(button.record.document));
      const document = packFileName(id, await shortHash(docBytes), 'json');
      files[document] = docBytes;

      let scene: string | null = null;
      if (button.record.scene !== null) {
        const gz = await gzip(new Uint8Array(button.record.scene));
        scene = packFileName(id, await shortHash(gz), 'fwldz');
        files[scene] = gz;
      }
      worlds.push({ id, name: button.name, document, scene });
    }
    assignments.push(id);
  }

  // Custom, or a button whose world is gone, opens nothing -- start on Custom.
  const selectedWorld =
    args.selectedWorld >= 0 && (assignments[args.selectedWorld] ?? '') !== ''
      ? args.selectedWorld
      : -1;

  files['manifest.json'] = new TextEncoder().encode(
    writePack({ worlds, assignments, selectedWorld, customSlots: args.customSlots }),
  );

  const { zipSync } = await import('fflate');
  // Level 0: the scenes are gzipped already and the rest is small.
  const zip = zipSync(files, { level: 0 });
  return new Blob([zip as Uint8Array<ArrayBuffer>], { type: 'application/zip' });
}

/** The first 8 hex digits of the content's SHA-256: enough to tell versions apart. */
async function shortHash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest.slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function gzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
