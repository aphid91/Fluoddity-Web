/**
 * A minimal ZIP writer. STORE ONLY -- no compression.
 *
 * ## Why hand-rolled rather than a dependency
 *
 * The same argument `idb.ts` makes for wrapping IndexedDB by hand: the surface
 * needed here is "put N small text files in one archive", and a compression
 * library to do that would be more code shipped than the thing it replaces.
 * JSZip is ~100 kB; this is under a hundred lines and imports nothing.
 *
 * ## Why STORE and not DEFLATE
 *
 * Deflate is the part that would need a library -- `CompressionStream('deflate-raw')`
 * exists but is not everywhere this app runs, and a compressed entry needs a
 * correct CRC and both sizes anyway. Stored entries are legal ZIP: every
 * extractor reads them, including Windows Explorer's built-in one. The archive is
 * bigger, and for a folder of a few dozen JSON files that is measured in
 * kilobytes -- against a fallback path that only runs on browsers with no
 * directory picker at all.
 *
 * ## This is the FALLBACK
 *
 * The primary export path writes real files into a real folder via
 * `showDirectoryPicker`, which is what was actually asked for. This exists so
 * that a browser without that API still gets the saves out in one action rather
 * than N downloads. See `saveFolder.ts`.
 */

/** One file destined for the archive. */
export interface ZipEntry {
  readonly filename: string;
  readonly text: string;
}

/**
 * CRC-32, as ZIP specifies it.
 *
 * The table is built once on first use rather than written out as a literal: it
 * is 256 entries of noise that no reader can verify by eye, and the eight-line
 * generator IS the specification of what those numbers are.
 */
let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      // The reversed CRC-32 polynomial. ZIP, PNG and gzip all use this one.
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Little-endian writers. ZIP is little-endian throughout. */
function u16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/**
 * Build a ZIP archive containing `entries`.
 *
 * NO DIRECTORY ENTRIES are written. A ZIP with no folder records extracts to a
 * flat set of files, which is what a folder of saves is. Extractors create the
 * containing folder from the archive's own name.
 *
 * TIMESTAMPS ARE ZEROED rather than set to now. A stored MS-DOS timestamp would
 * make two exports of identical data produce different bytes, and there is
 * nothing here that benefits from a mtime -- the archive is unpacked immediately
 * and the files inside it are content, not history.
 */
export function buildZipBytes(entries: readonly ZipEntry[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: number[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.filename);
    const data = encoder.encode(entry.text);
    const crc = crc32(data);

    // Local file header. Version 2.0, no flags, method 0 (stored).
    const local = [
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(0),
      ...u16(0), // time
      ...u16(0), // date
      ...u32(crc),
      ...u32(data.length),
      ...u32(data.length),
      ...u16(nameBytes.length),
      ...u16(0),
    ];
    chunks.push(new Uint8Array(local), nameBytes, data);

    central.push(
      ...u32(0x02014b50),
      ...u16(20), // made by
      ...u16(20), // needed
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(crc),
      ...u32(data.length),
      ...u32(data.length),
      ...u16(nameBytes.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(offset),
      ...nameBytes,
    );

    offset += local.length + nameBytes.length + data.length;
  }

  const centralBytes = new Uint8Array(central);
  const end = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(centralBytes.length),
    ...u32(offset),
    ...u16(0),
  ];

  return concat([...chunks, centralBytes, new Uint8Array(end)]);
}

/**
 * The archive as a `Blob`, ready to download.
 *
 * A thin wrapper over `buildZipBytes`, which is where the format actually lives.
 * The split is what lets the byte layout be asserted under `node --test`: `Blob`
 * exists there, but reading one back is an async dance that tests nothing this
 * module is responsible for.
 *
 * The bytes are concatenated rather than handed to `Blob` as a list of views.
 * `Blob` accepts a list, but only of views backed by a plain `ArrayBuffer` --
 * and `Uint8Array`'s type is `ArrayBufferLike`, which admits `SharedArrayBuffer`
 * and so does not satisfy `BlobPart`.
 */
export function buildZip(entries: readonly ZipEntry[]): Blob {
  return new Blob([buildZipBytes(entries)], { type: 'application/zip' });
}

/**
 * Join byte runs into one buffer.
 *
 * The return is annotated `Uint8Array<ArrayBuffer>` rather than plain
 * `Uint8Array`, which is what makes the result a legal `BlobPart` -- see
 * `buildZip`. `new ArrayBuffer` is explicit for the same reason: the one-argument
 * `Uint8Array(n)` constructor is typed as `ArrayBufferLike`-backed.
 */
function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
