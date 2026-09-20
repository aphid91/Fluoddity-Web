/**
 * What a stamp IS, once it is off the GPU: three layers and the box they came
 * from.
 *
 * ## The shape, and why each layer carries its own resolution
 *
 * A stamp is a region of the world lifted out whole:
 *
 *   particles   packed live entities, 32 bytes each, positions in WORLD space
 *   canvas      the trail field over the box, at the source canvas's resolution
 *   field       walls + painted trails over the box, at the field's resolution
 *
 * The two textures record the pixel dimensions they were captured at, because
 * the field is capped at MAX_FIELD_DIM^2 while the canvas follows world size --
 * so even within one session they differ, and across a World Size change they
 * differ again. A layer that did not state its own size could only be pasted
 * back into the exact world it came from, which would defeat the entire point.
 *
 * ## Particles are stored in WORLD space, not box-relative
 *
 * A particle's position lands in the format exactly as it sits in the entity
 * buffer. The alternative -- normalizing to the box on copy -- would bake a
 * division into every capture and a multiply into every paste, and would make
 * the common case (restore a whole-scene stamp into the world it came from)
 * lossy: a round trip through [0,1] and back is not the identity in f32.
 *
 * `remapPoint` in `stampBox.ts` handles the rescale when source and destination
 * boxes genuinely differ, and is the identity when they do not. Bit-exact
 * restore is the property that makes the reset key trustworthy, so it is bought
 * here rather than traded away for a marginally tidier format.
 *
 * ## The palette fingerprint
 *
 * Every particle carries a `config_index` into the 40-slot palette, and the
 * palette is NOT part of a stamp -- a stamp is geometry, not materials. Pasting
 * a stamp into a world whose slot 3 holds something else silently reassigns that
 * material, which is a legitimate thing to want (restyling a stamp) and a
 * terrible thing to do by accident.
 *
 * So a stamp records which slots it actually used and what was in them, and the
 * paste path can compare. Nothing enforces a match today -- the whole-scene case
 * always matches, because the palette travels with the world save -- but the
 * information has to be captured at COPY time or it is gone forever. Recording
 * it now is what keeps the eventual stamp UI from needing a format change.
 *
 * ## A LEAF
 *
 * Types and pure helpers only. No GPU resource, no DOM, no storage -- so the
 * invariants below are testable under `node --test`, and `stampCodec.ts` can be
 * the single interpreter of the bytes exactly as `persistence.ts` is for configs.
 */

import { ENTITY_STRIDE } from '../particleSystem/layout.ts';
import type { StampBox } from './stampBox.ts';

/**
 * Bytes per captured particle. THE ENTITY STRIDE, not a format of its own.
 *
 * A stamp stores entities verbatim, which is what makes copy and paste a memcpy
 * on both ends rather than a per-particle transcode. Taken from the layout
 * fixture so that widening `Entity` in `common.wgsl` cannot leave this behind --
 * `layout.ts` asserts the struct against the descriptor at module load, so a
 * change there fails loudly rather than silently truncating every stamp.
 */
export const STAMP_PARTICLE_STRIDE = ENTITY_STRIDE;

/**
 * Channels per texel in a captured texture layer.
 *
 * FOUR for both, though they mean different things: the canvas is rg16float
 * (a 2D trail vector, two channels unused) and the field is rgba16float (rg =
 * walls, ba = trails). Captured at four channels each so one readback path and
 * one paste path serve both -- the alternative is two of everything to save two
 * channels on a texture that is already the smaller of the pair.
 */
export const STAMP_TEXEL_CHANNELS = 4;

/**
 * One captured texture layer.
 *
 * `data` is `width * height * STAMP_TEXEL_CHANNELS` float32s, row-major from the
 * TOP row -- the same order `copyTextureToBuffer` produces, so no re-ordering
 * happens on either side of the readback.
 *
 * ## Float32, though the textures are float16
 *
 * The GPU textures are 16-bit; this stores 32. Widening on readback costs twice
 * the bytes in memory and is worth it: `Float16Array` is not available in every
 * engine this has to run in, and hand-rolling half-float decode is a fiddly
 * thing to get subtly wrong in the denormal range. The SERIALIZED form narrows
 * back to 16 bits (see `stampCodec.ts`), so the on-disk cost is the honest one
 * and only the in-memory representation is wide.
 */
export interface StampLayer {
  readonly width: number;
  readonly height: number;
  /** `width * height * 4` float32s, row-major, top row first. */
  readonly data: Float32Array;
}

/** Which palette slots a stamp's particles reference, and what was in them. */
export interface StampPaletteRef {
  /** The slot index a particle's `config_index` points at. */
  readonly slot: number;
  /** The swatch's display name when the stamp was taken. May be empty. */
  readonly name: string;
}

/**
 * A region of the world, lifted out.
 *
 * Every field is required. An absent layer is represented by a zero-sized
 * `StampLayer` rather than by null, so that paste has exactly one shape to
 * handle -- a null-vs-empty distinction here would be a branch in the GPU path,
 * which is where branches turn into bugs nobody can see.
 */
export interface StampData {
  /** The world-space box this was taken from. */
  readonly box: StampBox;
  /** Packed live entities, verbatim. `byteLength % STAMP_PARTICLE_STRIDE === 0`. */
  readonly particles: ArrayBuffer;
  /** The trail field over the box. */
  readonly canvas: StampLayer;
  /** Walls + painted trails over the box. */
  readonly field: StampLayer;
  /** Slots the particles reference. See the header. */
  readonly palette: readonly StampPaletteRef[];
}

/** How many particles a stamp holds. */
export function particleCount(stamp: StampData): number {
  return Math.floor(stamp.particles.byteLength / STAMP_PARTICLE_STRIDE);
}

/** An empty layer, for a stamp with no coverage of that resource. */
export function emptyLayer(): StampLayer {
  return { width: 0, height: 0, data: new Float32Array(0) };
}

/** Whether a layer holds any texels. */
export function layerIsEmpty(layer: StampLayer): boolean {
  return layer.width <= 0 || layer.height <= 0 || layer.data.length === 0;
}

/**
 * Check a layer's dimensions against its data length.
 *
 * Called by the decoder on everything it reads. A layer whose `data` is shorter
 * than its dimensions claim does not throw when sampled -- it reads `undefined`,
 * which becomes `NaN` in a float lane, which becomes a texture full of NaN and a
 * world that quietly stops rendering. Catching it at the boundary is the same
 * call `preferences.ts` makes about coercing stored values.
 */
export function layerIsWellFormed(layer: StampLayer): boolean {
  if (layer.width < 0 || layer.height < 0) return false;
  if (!Number.isInteger(layer.width) || !Number.isInteger(layer.height)) return false;
  return layer.data.length === layer.width * layer.height * STAMP_TEXEL_CHANNELS;
}

/**
 * Every invariant a stamp must satisfy to be safe to paste, or a reason it does
 * not.
 *
 * Returns null when the stamp is good. A STRING RATHER THAN A BOOLEAN because
 * the two callers want different things from a failure: the decoder puts it in a
 * `StampFormatError` naming the file, and the paste path logs it. Neither can
 * say anything useful about `false`.
 */
export function stampProblem(stamp: StampData): string | null {
  if (stamp.particles.byteLength % STAMP_PARTICLE_STRIDE !== 0) {
    return (
      `particle block is ${stamp.particles.byteLength} bytes, not a multiple of ` +
      `the ${STAMP_PARTICLE_STRIDE}-byte entity stride`
    );
  }
  if (!layerIsWellFormed(stamp.canvas)) {
    return (
      `canvas layer claims ${stamp.canvas.width}x${stamp.canvas.height} but holds ` +
      `${stamp.canvas.data.length} floats`
    );
  }
  if (!layerIsWellFormed(stamp.field)) {
    return (
      `field layer claims ${stamp.field.width}x${stamp.field.height} but holds ` +
      `${stamp.field.data.length} floats`
    );
  }
  const [w, h] = [
    stamp.box.max[0] - stamp.box.min[0],
    stamp.box.max[1] - stamp.box.min[1],
  ];
  if (!Number.isFinite(w) || !Number.isFinite(h)) {
    return 'box has a non-finite extent';
  }
  if (w < 0 || h < 0) {
    return `box is inverted (${w} x ${h}); min must be <= max on both axes`;
  }
  return null;
}
