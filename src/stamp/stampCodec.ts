/**
 * The `.fwld` container: reader, writer, and the half-float conversion.
 *
 * ## THE ONLY INTERPRETER OF THESE BYTES
 *
 * The same rule `persistence.ts` states for v8 configs, for the same reason:
 * there is exactly one place that decides what a stamp's bytes MEAN, whether
 * they came out of IndexedDB, off the network as a shipped world, or out of a
 * file the user exported. Storage layers above this hold no knowledge of the
 * format at all.
 *
 * ## Why binary rather than JSON
 *
 * A whole-scene stamp is two float textures and a packed entity block -- at the
 * default world size, on the order of megabytes. Base64 in JSON inflates that by
 * a third and forces a string decode over every byte. The container is therefore
 * a JSON HEADER plus raw typed-array blocks: the header stays inspectable (open
 * the file, read the first line, see the box and the dimensions) while the bulk
 * stays cheap.
 *
 * ## Layout
 *
 *     magic        8 bytes   "FWLDSTMP"
 *     version      u32       FORMAT_VERSION
 *     headerBytes  u32       length of the JSON header
 *     header       utf-8     JSON: box, layer dims, block offsets, palette
 *     blocks       raw       particles, then canvas, then field
 *
 * Blocks are 4-BYTE ALIGNED and the header records each one's offset and length
 * explicitly rather than implying them by order. Implicit offsets are how a
 * format acquires a silent off-by-one the first time a block is added in the
 * middle -- stating them costs twenty bytes of header and makes a misread
 * impossible to express.
 *
 * ## The textures narrow to float16 on the way out
 *
 * They are float16 on the GPU and float32 in memory (see `StampLayer` on why the
 * in-memory form is wide). Writing 32-bit would DOUBLE a world file to store
 * precision the source texture never had. The conversion is lossless in that
 * direction -- every value came from a float16 originally -- so a round trip
 * through the file is exact.
 */

import {
  type StampData,
  type StampLayer,
  type StampPaletteRef,
  STAMP_TEXEL_CHANNELS,
  emptyLayer,
  stampProblem,
} from './stampData.ts';
import type { StampBox } from './stampBox.ts';

/** The only version this reads or writes. */
export const FORMAT_VERSION = 1;

/** Leading bytes identifying the container. */
export const MAGIC = 'FWLDSTMP';
const MAGIC_BYTES = 8;
/** magic + version + headerBytes. */
const PREAMBLE_BYTES = MAGIC_BYTES + 4 + 4;

/** Thrown for anything this reader will not accept. */
export class StampFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StampFormatError';
  }
}

/** One block's position in the file. Explicit -- see the header. */
interface BlockRef {
  readonly offset: number;
  readonly bytes: number;
}

interface StampHeader {
  readonly box: { readonly min: readonly [number, number]; readonly max: readonly [number, number] };
  readonly particles: BlockRef;
  readonly canvas: { readonly width: number; readonly height: number; readonly block: BlockRef };
  readonly field: { readonly width: number; readonly height: number; readonly block: BlockRef };
  readonly palette: readonly StampPaletteRef[];
}

// ---------------------------------------------------------------------------
// Half-float conversion
//
// Hand-rolled because `Float16Array` is not available across every engine this
// has to run in. Both directions are exercised by `stampCodec.test.ts` across
// the ranges that actually bite: denormals, the max finite value, and the
// infinities a blown-up trail field can genuinely produce.
// ---------------------------------------------------------------------------

/**
 * f32 -> f16 bits.
 *
 * ## The cases that matter, and why each is written out
 *
 * NaN and Infinity are REAL INPUTS here, not theoretical ones: a trail field
 * that has been fed an extreme physics rate can hold them, and a stamp of such a
 * world must round-trip rather than throw. They map to the f16 encodings of the
 * same values.
 *
 * Denormals are handled explicitly because the naive exponent shift produces
 * zero for every value below 2^-14, which would silently erase the faintest
 * trails -- precisely the detail a stamp of a decayed field is mostly made of.
 *
 * Rounding is ROUND-TO-NEAREST-EVEN, matching what the GPU did when it wrote
 * the texture, so a value that survived one conversion survives this one
 * unchanged.
 */
export function f32ToF16Bits(value: number): number {
  if (Number.isNaN(value)) return 0x7e00;
  if (value === Infinity) return 0x7c00;
  if (value === -Infinity) return 0xfc00;
  if (value === 0) return Object.is(value, -0) ? 0x8000 : 0x0000;

  const sign = value < 0 ? 0x8000 : 0;
  const abs = Math.abs(value);

  // Above the largest finite f16 (65504): saturate to infinity rather than
  // wrapping to a nonsense exponent.
  if (abs >= 65520) return sign | 0x7c00;
  // Below the smallest denormal: flush to zero, keeping the sign.
  if (abs < 2 ** -24) return sign;

  if (abs < 2 ** -14) {
    // DENORMAL. The exponent field is 0 and the mantissa carries the whole
    // value scaled by 2^24.
    const scaled = abs / 2 ** -24;
    const mantissa = roundToEven(scaled);
    // Rounding can carry into the smallest normal, which is the correct result
    // and needs no special case: mantissa 1024 IS exponent 1, mantissa 0.
    return sign | mantissa;
  }

  const exponent = Math.floor(Math.log2(abs));
  const mantissaFloat = abs / 2 ** exponent - 1;
  let mantissa = roundToEven(mantissaFloat * 1024);
  let exp = exponent;
  // Rounding the mantissa up to 1024 means it carried into the exponent.
  if (mantissa === 1024) {
    mantissa = 0;
    exp += 1;
  }
  if (exp > 15) return sign | 0x7c00;
  return sign | ((exp + 15) << 10) | mantissa;
}

/** Round half to even, which is what the GPU's own conversion does. */
function roundToEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** f16 bits -> f32. The exact inverse of the above for every finite value. */
export function f16BitsToF32(bits: number): number {
  const sign = (bits & 0x8000) !== 0 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;

  if (exponent === 0) {
    // Zero or denormal. `sign * 0` preserves negative zero.
    return mantissa === 0 ? sign * 0 : sign * mantissa * 2 ** -24;
  }
  if (exponent === 0x1f) {
    return mantissa === 0 ? sign * Infinity : NaN;
  }
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

/** A float32 array narrowed to f16 bits. */
export function toHalfBits(data: Float32Array): Uint16Array<ArrayBuffer> {
  const out = new Uint16Array(new ArrayBuffer(data.length * 2));
  for (let i = 0; i < data.length; i++) out[i] = f32ToF16Bits(data[i] ?? 0);
  return out;
}

/** f16 bits widened back to float32. */
export function fromHalfBits(bits: Uint16Array): Float32Array<ArrayBuffer> {
  const out = new Float32Array(new ArrayBuffer(bits.length * 4));
  for (let i = 0; i < bits.length; i++) out[i] = f16BitsToF32(bits[i] ?? 0);
  return out;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Round a length up to a 4-byte boundary. See the header on alignment. */
function align4(n: number): number {
  return (n + 3) & ~3;
}

/**
 * Encode a stamp into a `.fwld` buffer.
 *
 * REFUSES A MALFORMED STAMP rather than writing it. A stamp whose layer
 * dimensions disagree with its data length would produce a file that decodes
 * into NaN, and the failure would surface as a world that renders black with no
 * error -- days away from the write that caused it. `stampProblem` is the same
 * check the decoder runs, so a file this writes is one this reads.
 */
export function encodeStamp(stamp: StampData): ArrayBuffer {
  const problem = stampProblem(stamp);
  if (problem !== null) {
    throw new StampFormatError(`refusing to encode a malformed stamp: ${problem}`);
  }

  const canvasBits = toHalfBits(stamp.canvas.data);
  const fieldBits = toHalfBits(stamp.field.data);

  // Offsets are assigned here and STATED in the header, rather than being
  // implied by order -- see the module header.
  let at = 0;
  const particlesRef: BlockRef = { offset: at, bytes: stamp.particles.byteLength };
  at = align4(at + particlesRef.bytes);
  const canvasRef: BlockRef = { offset: at, bytes: canvasBits.byteLength };
  at = align4(at + canvasRef.bytes);
  const fieldRef: BlockRef = { offset: at, bytes: fieldBits.byteLength };
  at = align4(at + fieldRef.bytes);
  const blocksBytes = at;

  const header: StampHeader = {
    box: { min: [stamp.box.min[0], stamp.box.min[1]], max: [stamp.box.max[0], stamp.box.max[1]] },
    particles: particlesRef,
    canvas: { width: stamp.canvas.width, height: stamp.canvas.height, block: canvasRef },
    field: { width: stamp.field.width, height: stamp.field.height, block: fieldRef },
    palette: stamp.palette.map((p) => ({ slot: p.slot, name: p.name })),
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const headerPadded = align4(headerBytes.length);

  const total = PREAMBLE_BYTES + headerPadded + blocksBytes;
  const buffer = new ArrayBuffer(total);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  for (let i = 0; i < MAGIC_BYTES; i++) bytes[i] = MAGIC.charCodeAt(i);
  // LITTLE-ENDIAN throughout, stated explicitly at every call rather than left
  // to the platform default -- which DataView does not have, but a reader
  // skimming for endianness should find the answer at the read, not in a note.
  view.setUint32(MAGIC_BYTES, FORMAT_VERSION, true);
  view.setUint32(MAGIC_BYTES + 4, headerBytes.length, true);
  bytes.set(headerBytes, PREAMBLE_BYTES);

  const blocksAt = PREAMBLE_BYTES + headerPadded;
  bytes.set(new Uint8Array(stamp.particles), blocksAt + particlesRef.offset);
  bytes.set(new Uint8Array(canvasBits.buffer), blocksAt + canvasRef.offset);
  bytes.set(new Uint8Array(fieldBits.buffer), blocksAt + fieldRef.offset);

  return buffer;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function readBlockRef(raw: unknown, where: string, label: string): BlockRef {
  if (typeof raw !== 'object' || raw === null) {
    throw new StampFormatError(`${where}: "${label}" block reference is missing`);
  }
  const o = raw as Record<string, unknown>;
  const offset = o['offset'];
  const bytes = o['bytes'];
  if (
    typeof offset !== 'number' ||
    typeof bytes !== 'number' ||
    !Number.isInteger(offset) ||
    !Number.isInteger(bytes) ||
    offset < 0 ||
    bytes < 0
  ) {
    throw new StampFormatError(
      `${where}: "${label}" block reference is not a pair of non-negative integers`,
    );
  }
  return { offset, bytes };
}

function readVec2(raw: unknown, where: string, label: string): readonly [number, number] {
  if (
    !Array.isArray(raw) ||
    raw.length !== 2 ||
    typeof raw[0] !== 'number' ||
    typeof raw[1] !== 'number' ||
    !Number.isFinite(raw[0]) ||
    !Number.isFinite(raw[1])
  ) {
    throw new StampFormatError(`${where}: "${label}" is not a pair of finite numbers`);
  }
  return [raw[0], raw[1]];
}

/**
 * Decode a `.fwld` buffer.
 *
 * EVERY BLOCK IS BOUNDS-CHECKED against the file's actual length before it is
 * read. A truncated download is an ordinary outcome -- these are megabytes over
 * a network -- and a typed array constructed past the end of its buffer throws
 * a `RangeError` whose message names neither the file nor the block. Checking
 * here turns that into a message that says which stamp and which layer.
 *
 * `where` names the source, the way `fromDocument`'s does: a filename for a
 * fetched world, a save name for an IndexedDB record.
 */
export function decodeStamp(buffer: ArrayBuffer, where = 'stamp'): StampData {
  if (buffer.byteLength < PREAMBLE_BYTES) {
    throw new StampFormatError(`${where}: too short to be a stamp (${buffer.byteLength} bytes)`);
  }
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  for (let i = 0; i < MAGIC_BYTES; i++) {
    if (bytes[i] !== MAGIC.charCodeAt(i)) {
      throw new StampFormatError(`${where}: not a ${MAGIC} file`);
    }
  }

  const version = view.getUint32(MAGIC_BYTES, true);
  if (version !== FORMAT_VERSION) {
    throw new StampFormatError(
      `${where}: unrecognized stamp version ${version}; expected ${FORMAT_VERSION}`,
    );
  }

  const headerLength = view.getUint32(MAGIC_BYTES + 4, true);
  const headerEnd = PREAMBLE_BYTES + headerLength;
  if (headerEnd > buffer.byteLength) {
    throw new StampFormatError(
      `${where}: header claims ${headerLength} bytes but the file holds ` +
        `${buffer.byteLength - PREAMBLE_BYTES} after the preamble`,
    );
  }

  let header: Record<string, unknown>;
  try {
    const text = new TextDecoder().decode(bytes.subarray(PREAMBLE_BYTES, headerEnd));
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not a JSON object');
    }
    header = parsed as Record<string, unknown>;
  } catch (e) {
    throw new StampFormatError(`${where}: header is not readable JSON (${String(e)})`);
  }

  const boxRaw = header['box'];
  if (typeof boxRaw !== 'object' || boxRaw === null) {
    throw new StampFormatError(`${where}: missing "box"`);
  }
  const boxObj = boxRaw as Record<string, unknown>;
  const box: StampBox = {
    min: readVec2(boxObj['min'], where, 'box.min'),
    max: readVec2(boxObj['max'], where, 'box.max'),
  };

  const blocksAt = PREAMBLE_BYTES + align4(headerLength);
  const slice = (ref: BlockRef, label: string): ArrayBuffer => {
    const start = blocksAt + ref.offset;
    const end = start + ref.bytes;
    if (end > buffer.byteLength) {
      throw new StampFormatError(
        `${where}: ${label} block runs to byte ${end} but the file is ` +
          `${buffer.byteLength} bytes — it is truncated`,
      );
    }
    // COPIED, not viewed. A view would keep the whole multi-megabyte file alive
    // for as long as any layer is referenced, which for a world held in memory
    // is the entire session.
    return buffer.slice(start, end);
  };

  const particlesRef = readBlockRef(header['particles'], where, 'particles');
  const particles = slice(particlesRef, 'particle');

  const readLayer = (key: 'canvas' | 'field'): StampLayer => {
    const raw = header[key];
    if (typeof raw !== 'object' || raw === null) {
      throw new StampFormatError(`${where}: missing "${key}" layer`);
    }
    const o = raw as Record<string, unknown>;
    const width = o['width'];
    const height = o['height'];
    if (
      typeof width !== 'number' ||
      typeof height !== 'number' ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 0 ||
      height < 0
    ) {
      throw new StampFormatError(`${where}: "${key}" has non-integer dimensions`);
    }
    const ref = readBlockRef(o['block'], where, `${key}.block`);
    if (width === 0 || height === 0) return emptyLayer();
    const block = slice(ref, key);
    const expected = width * height * STAMP_TEXEL_CHANNELS * 2;
    if (block.byteLength !== expected) {
      throw new StampFormatError(
        `${where}: "${key}" is ${width}x${height} and should hold ${expected} ` +
          `bytes of half-float, but its block is ${block.byteLength}`,
      );
    }
    return { width, height, data: fromHalfBits(new Uint16Array(block)) };
  };

  const paletteRaw = header['palette'];
  const palette: StampPaletteRef[] = [];
  if (Array.isArray(paletteRaw)) {
    for (const item of paletteRaw) {
      if (typeof item !== 'object' || item === null) continue;
      const o = item as Record<string, unknown>;
      const slot = o['slot'];
      if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0) continue;
      palette.push({ slot, name: typeof o['name'] === 'string' ? o['name'] : '' });
    }
  }

  const stamp: StampData = {
    box,
    particles,
    canvas: readLayer('canvas'),
    field: readLayer('field'),
    palette,
  };

  // The same check the encoder runs. A file that passes the structural reads
  // above can still be internally inconsistent -- a hand-edited header, or a
  // particle block whose length is not a whole number of entities.
  const problem = stampProblem(stamp);
  if (problem !== null) {
    throw new StampFormatError(`${where}: ${problem}`);
  }
  return stamp;
}
