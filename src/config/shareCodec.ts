/**
 * The v8 document as BYTES, for the share link.
 *
 * PURE, like `persistence.ts` and `shareLink.ts` -- no DOM, no `window`, no
 * `Buffer`. Everything below is `ArrayBuffer` and `DataView`, which is what lets
 * it run unchanged in the browser and under `node --test`.
 *
 * ## A CODEC, NOT A FORMAT
 *
 * `persistence.ts` says there is "exactly one interpreter of these bytes". This
 * file does not join it. It turns a v8 document into a byte string and back, and
 * `decode` returns the SAME SHAPE `JSON.parse` would have returned for the same
 * document -- so `fromDocument` remains the only thing that decides what any of
 * it MEANS. Nothing here validates a range, applies a default, or knows why a
 * field exists.
 *
 * That is the whole reason this is a separate file from `shareLink.ts`: the link
 * chooses a transport, and this chooses a representation. Neither is a reader.
 *
 * ## WHY BINARY AT ALL
 *
 * Measured against the 176 configs in `configs/Archive/`: a one-config project
 * is ~1789 characters as JSON-then-lz-string, and ~527 as these bytes. The
 * reason is not that lz-string is bad -- it is that the payload is 80 float32s
 * per config drawn from a chaotic hash, and:
 *
 *   1. `JSON.stringify` prints a float32 with up to 17 significant digits
 *      (`0.9860000014305115` is 18 characters carrying 4 bytes), and
 *   2. those mantissas are effectively random, so there is NO REDUNDANCY for a
 *      text compressor to find. Brotli-11 over the raw rule bytes recovers 3%.
 *
 * So the win here is not compression. It is not spending 18 characters on 4
 * bytes. Adding a general-purpose compressor on top of this would buy ~3% for a
 * dependency and a decompression step; it was measured and deliberately skipped.
 *
 * ## THE TRAP THAT DICTATES THE FLOAT WIDTHS
 *
 * **NOT EVERY NUMBER IN A SAVED DOCUMENT IS FLOAT32.** This is the one thing
 * that makes a binary encoding here subtle, it was found by scanning the real
 * `configs/`, and getting it wrong fails SILENTLY:
 *
 *   - All 15,680 `rule` floats across every shipped config are exactly float32.
 *     They come off the GPU, so they can only ever have been float32.
 *   - 312 SCALARS ARE NOT. `mutation_seed` is float64 in 194 of 196 configs
 *     (`0.024925940576650873`), and `sensor_distance_jitter`, `hazard_rate`,
 *     `mutation_scale` and `sensor_angle_jitter` each hold some too. They are
 *     produced by UI sliders and arithmetic in JavaScript, which is float64.
 *
 * Storing those as float32 would round them. For `mutation_seed` that is the
 * failure `persistence.ts:204` calls the most dangerous in the file: the value
 * is fed to a chaotic hash, so a rounded seed is a DIFFERENT RULE that still
 * looks entirely legitimate. Nobody would see a bug; they would see a link that
 * opens something subtly other than what was shared.
 *
 * Hence the asymmetry below, which is the core design decision of this file:
 * **the rule array is float32 and the scalars are float64.** It costs 8 bytes
 * per scalar where 4 would do, and it is worth it -- there are 16 scalars and 80
 * rule floats per config, so the rule is what governs the size and the scalars
 * are where the precision has to be right. `roundTripsExactly` proves the claim
 * for the whole corpus rather than asserting it.
 *
 * ## WHAT IS AND IS NOT PRESERVED
 *
 * Byte-exact for every numeric value, the config count, and the notes string.
 *
 * The KEY LAYOUT is fixed rather than stored: this writes the same group
 * structure `toDocument` writes. Two consequences are deliberate and both are
 * tested:
 *
 *   - A document carrying `appearance` (the pre-rename spelling of `misc2`) or
 *     a `camera` block re-emerges WITHOUT them. `persistence.ts` already ignores
 *     both, so nothing is lost that any reader would have read -- but it means
 *     encode/decode is a NORMALIZING round trip for legacy files, not an
 *     identity one. `encodeDocument` is therefore given the document
 *     `toDocument` produced, never a file straight off disk.
 *   - `cohort_fences` is written as the BOOLEAN `toDocument` writes today. Files
 *     on disk still hold a float there, and `fencesOr` reads both.
 */

/**
 * The codec version, first byte of every payload.
 *
 * SEPARATE FROM `FORMAT_VERSION`. That one versions what the fields MEAN and is
 * owned by `persistence.ts`; this one versions how they are laid out in bytes.
 * They move independently -- a new field bumps the format, a changed float width
 * bumps this -- and conflating them would make either change require the other.
 *
 * The document's own `version` is still written into the payload, so a v9
 * document round-trips through here intact and is rejected by `fromDocument`,
 * which is the layering `shareLink.test.ts` asserts.
 */
export const CODEC_VERSION = 1;

/** Thrown for bytes this decoder will not accept. */
export class ShareCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareCodecError';
  }
}

/** 10 FourierCenters x (frequency vec4 + amplitude vec4). Mirrors `config.ts`. */
const RULE_FLOAT_COUNT = 80;

/**
 * The scalars, in write order, as `[group, key]`.
 *
 * ORDER IS THE FORMAT. Reordering this array silently changes what every
 * existing link decodes to, which is why it is one table used by BOTH
 * directions rather than two matching lists that could drift apart.
 *
 * All sixteen are float64 -- see the header on why the five that need it are not
 * separated from the eleven that do not. Uniformity here costs 44 bytes per
 * config and removes an entire class of "which one was it?" mistake.
 */
const SCALARS: readonly (readonly [string, string])[] = [
  ['sensor', 'gain'],
  ['sensor', 'angle'],
  ['sensor', 'distance'],
  ['sensor', 'mutation_scale'],
  ['force', 'global_mult'],
  ['force', 'drag'],
  ['force', 'strafe'],
  ['force', 'axial'],
  ['misc', 'lateral'],
  ['misc', 'hazard_rate'],
  ['misc', 'mutation_seed'],
  ['force2', 'gravity_force'],
  ['force2', 'gravity_strafe'],
  ['misc2', 'color_sensitivity'],
  ['misc2', 'sensor_angle_jitter'],
  ['misc2', 'sensor_distance_jitter'],
] as const;

/**
 * The booleans, in bit order within the flag byte.
 *
 * Three bits used of eight. The spare five are why a fourth boolean can be added
 * without changing a single byte offset -- and `initial_conditions` sits in its
 * own byte rather than being packed into the same one for the same reason: it is
 * an enum that has grown before (four modes now, two once), and a two-bit field
 * would have to move the moment a fifth appears.
 */
const FLAGS: readonly (readonly [string, string])[] = [
  ['force2', 'cohort_fences'],
  ['misc2', 'color_by_cohort'],
  ['misc3', 'radial_gravity'],
] as const;

// ---------------------------------------------------------------------------
// Reading the document
// ---------------------------------------------------------------------------

/** A JSON object, or `{}`. Matches `persistence.ts`'s `block`. */
function block(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * A number for the encoder, or 0.
 *
 * TOLERANT ON PURPOSE, and it is not this file's job to be otherwise: a document
 * with a missing or malformed field must reach `fromDocument` to be rejected
 * with a message naming the field. Throwing here would replace that message with
 * a bytes-level one, and refusing to encode would stop a user sharing a document
 * the app had happily loaded.
 *
 * `cohort_fences` is the case that makes this load-bearing rather than
 * defensive: it is a float in every file on disk and a boolean in everything
 * written since, so the encoder meets both.
 */
function numberOr(raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Truthy under both shapes `cohort_fences` has had: `true`, or a float > 0. */
function flagOf(raw: Record<string, unknown>, key: string): boolean {
  const value = raw[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  return false;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * Bytes per config: the rule, the scalars, cohorts, the enum, the flag byte.
 *
 * Computed rather than written as a literal so that adding a scalar cannot leave
 * a stale constant behind -- the allocation and the writer would disagree by
 * exactly the amount that makes the last config overrun.
 */
const CONFIG_BYTES =
  RULE_FLOAT_COUNT * 4 + // rule, float32 -- see the header
  SCALARS.length * 8 + //  scalars, float64 -- see the header
  4 + //                   cohorts, uint32 (up to 300000 in the shipped configs)
  1 + //                   initial_conditions
  1; //                    the flag byte

/** version + document version + config count + the three world values. */
const HEADER_BYTES = 1 + 1 + 2 + 8 + 8 + 1;

/**
 * A v8 document as bytes.
 *
 * Takes `unknown` and reads defensively for the reason `numberOr` states: this
 * sits on the WRITE path, where refusing to act is worse than emitting a
 * document that the reader will reject on arrival with a better message.
 */
export function encodeDocument(document: unknown): Uint8Array {
  const doc = block(document);
  const world = block(doc['world']);
  const configsRaw = Array.isArray(doc['configs']) ? doc['configs'] : [];

  // The count is a uint16 and 65535 configs is far beyond anything the app can
  // build, but a truncating cast would wrap silently and emit a payload that
  // decodes to the wrong number of configs. Refused instead.
  if (configsRaw.length > 0xffff) {
    throw new ShareCodecError(`too many configs to encode (${configsRaw.length})`);
  }

  const notes = typeof doc['notes'] === 'string' ? doc['notes'] : '';
  // UTF-8 BEFORE the buffer is sized, because the byte length of a string is not
  // its `.length` -- an emoji in the notes is four bytes and one to three UTF-16
  // units. Sizing off `.length` would under-allocate exactly when someone used a
  // character outside the BMP.
  const notesBytes = new TextEncoder().encode(notes);

  const total =
    HEADER_BYTES + configsRaw.length * CONFIG_BYTES + 4 + notesBytes.length;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  let at = 0;

  view.setUint8(at, CODEC_VERSION);
  at += 1;
  // The DOCUMENT's version, carried rather than assumed -- so a v9 document
  // survives this file and is rejected by `fromDocument`, not here.
  view.setUint8(at, typeof doc['version'] === 'number' ? doc['version'] : 0);
  at += 1;
  view.setUint16(at, configsRaw.length, true);
  at += 2;
  view.setFloat64(at, numberOr(world, 'trail_persistence'), true);
  at += 8;
  view.setFloat64(at, numberOr(world, 'trail_diffusion'), true);
  at += 8;
  view.setUint8(at, numberOr(world, 'boundary_conditions'));
  at += 1;

  for (const entry of configsRaw) {
    const config = block(entry);
    const groups: Record<string, Record<string, unknown>> = {
      sensor: block(config['sensor']),
      force: block(config['force']),
      misc: block(config['misc']),
      force2: block(config['force2']),
      // The pre-rename spelling, read exactly as `configFromDocument` reads it.
      misc2:
        config['misc2'] !== undefined
          ? block(config['misc2'])
          : block(config['appearance']),
      misc3: block(config['misc3']),
    };

    const rule = Array.isArray(config['rule']) ? config['rule'] : [];
    for (let i = 0; i < RULE_FLOAT_COUNT; i += 1) {
      const value = rule[i];
      // FLOAT32, and this is the one place the width is a claim about the data
      // rather than a choice: every rule float in the corpus is exactly float32
      // because it came off the GPU. `roundTripsExactly` is what keeps that
      // claim honest for documents this file has never seen.
      view.setFloat32(at, typeof value === 'number' ? value : 0, true);
      at += 4;
    }

    for (const [group, key] of SCALARS) {
      view.setFloat64(at, numberOr(groups[group]!, key), true);
      at += 8;
    }

    view.setUint32(at, Math.max(0, numberOr(groups['misc']!, 'cohorts')), true);
    at += 4;
    view.setUint8(at, numberOr(groups['force2']!, 'initial_conditions') & 0xff);
    at += 1;

    let flags = 0;
    FLAGS.forEach(([group, key], bit) => {
      if (flagOf(groups[group]!, key)) flags |= 1 << bit;
    });
    view.setUint8(at, flags);
    at += 1;
  }

  view.setUint32(at, notesBytes.length, true);
  at += 4;
  bytes.set(notesBytes, at);

  return bytes;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * The document those bytes carry.
 *
 * Returns the shape `JSON.parse` would have returned, so the caller cannot tell
 * which transport a document arrived on -- which is what keeps `fromDocument`
 * the only reader. Throws `ShareCodecError` for bytes that are the wrong length
 * or the wrong codec version; everything else is the reader's business.
 */
export function decodeDocument(bytes: Uint8Array): unknown {
  if (bytes.length < HEADER_BYTES) {
    throw new ShareCodecError('the payload is too short to be a config');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;

  const codec = view.getUint8(at);
  at += 1;
  if (codec !== CODEC_VERSION) {
    // A LINK FROM A FUTURE BUILD, and the message says so rather than calling it
    // damaged -- the user's remedy is to update, not to ask for a fresh copy.
    throw new ShareCodecError(
      `this link uses share format ${codec}, which this version cannot read ` +
        `(it reads ${CODEC_VERSION}) -- the page may need updating`,
    );
  }

  const version = view.getUint8(at);
  at += 1;
  const configCount = view.getUint16(at, true);
  at += 2;
  const trailPersistence = view.getFloat64(at, true);
  at += 8;
  const trailDiffusion = view.getFloat64(at, true);
  at += 8;
  const boundaryConditions = view.getUint8(at);
  at += 1;

  // LENGTH CHECKED BEFORE ANY OF IT IS READ. A truncated payload is the likeliest
  // real failure (`shareLink.ts` trap 2), and a `DataView` past its end throws a
  // `RangeError`, not something a caller can tell from a bug. Checked up front so
  // the error names truncation, which is what actually happened.
  const needed = HEADER_BYTES + configCount * CONFIG_BYTES + 4;
  if (bytes.length < needed) {
    throw new ShareCodecError(
      `the payload claims ${configCount} configs but is ${bytes.length} bytes, ` +
        `short of the ${needed} they need`,
    );
  }

  const configs: unknown[] = [];
  for (let c = 0; c < configCount; c += 1) {
    const rule: number[] = [];
    for (let i = 0; i < RULE_FLOAT_COUNT; i += 1) {
      rule.push(view.getFloat32(at, true));
      at += 4;
    }

    const values: number[] = [];
    for (let i = 0; i < SCALARS.length; i += 1) {
      values.push(view.getFloat64(at, true));
      at += 8;
    }

    const cohorts = view.getUint32(at, true);
    at += 4;
    const initialConditions = view.getUint8(at);
    at += 1;
    const flags = view.getUint8(at);
    at += 1;

    // Rebuilt in `toDocument`'s key order and grouping. See the header: this is
    // a normalizing round trip, so a legacy `appearance` or `camera` block does
    // not come back -- neither is read by `persistence.ts`.
    configs.push({
      rule,
      sensor: {
        gain: values[0]!,
        angle: values[1]!,
        distance: values[2]!,
        mutation_scale: values[3]!,
      },
      force: {
        global_mult: values[4]!,
        drag: values[5]!,
        strafe: values[6]!,
        axial: values[7]!,
      },
      misc: {
        lateral: values[8]!,
        hazard_rate: values[9]!,
        cohorts,
        mutation_seed: values[10]!,
      },
      force2: {
        gravity_force: values[11]!,
        gravity_strafe: values[12]!,
        initial_conditions: initialConditions,
        cohort_fences: (flags & 1) !== 0,
      },
      misc2: {
        color_sensitivity: values[13]!,
        color_by_cohort: (flags & 2) !== 0,
        sensor_angle_jitter: values[14]!,
        sensor_distance_jitter: values[15]!,
      },
      misc3: { radial_gravity: (flags & 4) !== 0 },
    });
  }

  const notesLength = view.getUint32(at, true);
  at += 4;
  if (bytes.length < at + notesLength) {
    throw new ShareCodecError('the payload ends inside its notes');
  }
  const notes = new TextDecoder().decode(
    bytes.subarray(at, at + notesLength),
  );

  const doc: Record<string, unknown> = {
    version,
    world: {
      trail_persistence: trailPersistence,
      trail_diffusion: trailDiffusion,
      boundary_conditions: boundaryConditions,
    },
    configs,
  };
  // OMITTED WHEN EMPTY, matching `toDocument` -- so a document that never had
  // notes round-trips to one that still does not, rather than gaining a `""`.
  if (notes !== '') doc['notes'] = notes;
  return doc;
}
