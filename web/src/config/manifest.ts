/**
 * The shipped-preset index: what `persistence.discover()` cannot be.
 *
 * `discover()` (`persistence.py:339-367`) globs `configs/` for the "Core"
 * category and iterates subfolders into their own. NO BROWSER CAN ENUMERATE A
 * DIRECTORY, so the enumeration happens at build time instead:
 * `web/tools/generate_web_data.py` runs the desktop's own `discover()`, copies
 * each file into `web/public/configs/`, and writes the index this module reads.
 *
 * Two consequences worth stating, because they are the point of doing it this
 * way rather than baking the presets into the bundle as Step 4 did:
 *
 *  - THE PRESETS ARE NO LONGER CODE. Adding one is a file copy and a regenerate,
 *    not a rebuild of `defaultConfig.ts`.
 *  - THE FILES ARE THE DESKTOP'S OWN BYTES, copied verbatim. So the reader in
 *    `persistence.ts` is exercised against exactly what the desktop writes,
 *    rather than against a pre-digested shape that would hide a format mismatch.
 *
 * ## Why the categories are an ARRAY
 *
 * Ordering is load-bearing: Core first, then alphabetical, and the flat
 * concatenation of that is the LEFT/RIGHT preset cycle. JSON object key order is
 * insertion-ordered in every engine but is not *specified* to be, so the order
 * lives in the data structure rather than in an assumption about it.
 */

/** One shipped preset: its name, and where its bytes are. */
export interface ManifestEntry {
  readonly name: string;
  /** Relative to the manifest's own directory. Read only by `configStore`. */
  readonly path: string;
}

export interface ManifestCategory {
  readonly name: string;
  readonly entries: readonly ManifestEntry[];
}

export interface Manifest {
  readonly categories: readonly ManifestCategory[];
}

/** Where the generator writes, and where the app fetches from. */
export const MANIFEST_URL = 'configs/manifest.json';

/** Thrown when the manifest is missing or unreadable. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

function parseManifest(data: unknown, url: string): Manifest {
  if (typeof data !== 'object' || data === null) {
    throw new ManifestError(`${url}: not a JSON object`);
  }
  const categoriesRaw = (data as Record<string, unknown>)['categories'];
  if (!Array.isArray(categoriesRaw)) {
    throw new ManifestError(`${url}: missing "categories" array`);
  }

  const categories = categoriesRaw.map((c, i): ManifestCategory => {
    const raw = c as Record<string, unknown>;
    const name = raw['name'];
    const entriesRaw = raw['entries'];
    if (typeof name !== 'string' || !Array.isArray(entriesRaw)) {
      throw new ManifestError(`${url}: categories[${i}] is malformed`);
    }
    return {
      name,
      entries: entriesRaw.map((e, j): ManifestEntry => {
        const entry = e as Record<string, unknown>;
        if (typeof entry['name'] !== 'string' || typeof entry['path'] !== 'string') {
          throw new ManifestError(`${url}: categories[${i}].entries[${j}] is malformed`);
        }
        return { name: entry['name'], path: entry['path'] };
      }),
    };
  });

  return { categories };
}

/**
 * Fetch and validate the manifest.
 *
 * THROWS RATHER THAN DEGRADING, and the caller surfaces it through the same
 * banner a missing GPU adapter uses. An app with no presets is not a usable
 * app -- and the most likely cause of a 404 here is a production build that did
 * not copy `public/`, which would otherwise present as a mysteriously empty
 * menu rather than as a build error.
 *
 * Contrast IndexedDB, which is allowed to be unavailable: losing user saves is
 * bad, losing the app because saves are unavailable is worse. See `idb.ts`.
 */
export async function loadManifest(baseUrl = MANIFEST_URL): Promise<Manifest> {
  let response: Response;
  try {
    response = await fetch(baseUrl, { cache: 'no-cache' });
  } catch (e) {
    throw new ManifestError(`Could not fetch ${baseUrl}: ${String(e)}`);
  }
  if (!response.ok) {
    throw new ManifestError(`Could not fetch ${baseUrl}: HTTP ${response.status}`);
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch (e) {
    throw new ManifestError(`${baseUrl} is not valid JSON: ${String(e)}`);
  }
  return parseManifest(data, baseUrl);
}

/** Fetch one preset document, by the manifest-relative path in its entry. */
export async function fetchPreset(path: string, baseUrl = MANIFEST_URL): Promise<unknown> {
  // Resolved against the manifest's own location, so moving the whole directory
  // needs one constant changed rather than a second path convention.
  const dir = baseUrl.slice(0, baseUrl.lastIndexOf('/') + 1);
  const url = `${dir}${path}`;
  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-cache' });
  } catch (e) {
    throw new ManifestError(`Could not fetch ${url}: ${String(e)}`);
  }
  if (!response.ok) {
    throw new ManifestError(`Could not fetch ${url}: HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch (e) {
    throw new ManifestError(`${url} is not valid JSON: ${String(e)}`);
  }
}
