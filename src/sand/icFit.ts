/**
 * Fitting a saved scene into a world shaped like THIS screen.
 *
 * ## The unit is the canvas pixel
 *
 * A world's physics is invariant in canvas pixels: particle size, sensor reach
 * and every force are divided by sqrt(world size) in world units, and the
 * canvas is 1024 * sqrt(world size) pixels across, so the two cancel. World
 * size is therefore "how much room", not "how big things are". That is what
 * makes a scene placeable PIXEL FOR PIXEL into a differently sized world, and
 * why nothing here ever rescales particles or trails.
 *
 * ## The procedure
 *
 *   1. ACTIVE REGION. The bounding box of the particles and the walls, plus
 *      `TRAIL_CUSHION_PX` for the trails around them. Trails elsewhere are
 *      dropped: they are residue and are never exactly zero.
 *   2. FIT, in `planFit`, trying in order:
 *        a. the target world size, at the screen's shape;
 *        b. a larger world size, up to `GROWTH_MAX` times the target;
 *        c. that largest world size, at a shape up to `MIN_FILL` away from
 *           the screen's -- the canvas letterboxes;
 *        d. crop.
 *   3. PLACE, in `placeScene`: on each axis the empty space either side keeps
 *      its RATIO, so a scene touching the floor stays on the floor. A crop
 *      takes from the open sides first, for the same reason.
 *
 * The result is a stamp already in the destination world's units, with its
 * box snapped to whole canvas pixels, so the GPU paste is an exact copy.
 *
 * ## A scene and its FRAME
 *
 * A saved scene is TRIMMED to its active region (`trimScene`), so its own box
 * is only part of the world it came from. The FRAME is that whole world's box,
 * stored beside it (`WorldDocument.sceneFrame`), and it is what the gaps are
 * measured against when placing -- without it a trimmed scene would touch every
 * edge. Every function here takes the frame, and treats a missing one as "the
 * scene's own box", which is what an untrimmed scene is.
 *
 * A LEAF: data in, data out, testable under `node --test`.
 */

import { type CanvasSize, worldHalfExtent } from '../particleSystem/coords.ts';
import { canvasDimensions, sizingFor } from '../particleSystem/sizing.ts';
import type { StampBox } from '../stamp/stampBox.ts';
import {
  STAMP_PARTICLE_STRIDE,
  STAMP_TEXEL_CHANNELS,
  type StampData,
  type StampLayer,
  emptyLayer,
  layerIsEmpty,
} from '../stamp/stampData.ts';

/** How far the world may grow past the target to fit a scene, in world size. */
export const GROWTH_MAX = 2.5;
/**
 * The least share of the canvas a letterboxed world may cover. Below this the
 * scene is cropped instead.
 */
export const MIN_FILL = 0.8;
/** Trails this close to a particle or wall are kept, in canvas pixels. */
export const TRAIL_CUSHION_PX = 9;
/** A field texel counts as wall above this magnitude. */
const WALL_EPSILON = 1e-4;

/**
 * A rect in a scene's canvas pixels, half-open. Rows count up from the
 * world's BOTTOM (minimum y), as the textures store them -- see `pixelRectFor`.
 */
export interface PixelRegion {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

// Entity lanes, in float32s: pos.xy vel.zw, then misc.x = size.
const POS_X = 0;
const POS_Y = 1;
const VEL_X = 2;
const VEL_Y = 3;
const SIZE = 4;

/**
 * Where a scene sits in its frame, in the frame's canvas pixels.
 *
 * `ppu` is canvas pixels per world unit in the world the scene came from, read
 * off its trail layer; `ox`/`oy` is where the scene's own box starts within the
 * frame. All three are exact for a scene `trimScene` produced, since it cuts on
 * whole pixels.
 */
interface Geometry {
  readonly frame: StampBox;
  readonly ppu: number;
  /** The frame's canvas, in pixels. */
  readonly width: number;
  readonly height: number;
  /** The scene's box within the frame, in pixels. */
  readonly ox: number;
  readonly oy: number;
}

function geometryOf(stamp: StampData, frame: StampBox | null): Geometry | null {
  if (layerIsEmpty(stamp.canvas)) return null;
  const bw = stamp.box.max[0] - stamp.box.min[0];
  if (!(bw > 0)) return null;
  const ppu = stamp.canvas.width / bw;
  const f = frame ?? stamp.box;
  const width = Math.round((f.max[0] - f.min[0]) * ppu);
  const height = Math.round((f.max[1] - f.min[1]) * ppu);
  if (!(width > 0 && height > 0)) return null;
  return {
    frame: f,
    ppu,
    width,
    height,
    ox: Math.round((stamp.box.min[0] - f.min[0]) * ppu),
    oy: Math.round((stamp.box.min[1] - f.min[1]) * ppu),
  };
}

/**
 * Step 1: the particles' and walls' bounding box plus the trail cushion, in
 * the FRAME's canvas pixels. Null for a scene with neither.
 */
export function activeRegion(
  stamp: StampData,
  frame: StampBox | null = null,
): PixelRegion | null {
  const g = geometryOf(stamp, frame);
  if (g === null) return null;
  const { ppu, width: cw, height: ch } = g;

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const take = (ax: number, ay: number, bx: number, by: number): void => {
    x0 = Math.min(x0, ax);
    y0 = Math.min(y0, ay);
    x1 = Math.max(x1, bx);
    y1 = Math.max(y1, by);
  };

  const view = new DataView(stamp.particles);
  const count = Math.floor(stamp.particles.byteLength / STAMP_PARTICLE_STRIDE);
  for (let i = 0; i < count; i++) {
    const at = i * STAMP_PARTICLE_STRIDE;
    const px = (view.getFloat32(at + POS_X * 4, true) - g.frame.min[0]) * ppu;
    const py = (view.getFloat32(at + POS_Y * 4, true) - g.frame.min[1]) * ppu;
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
    take(Math.floor(px), Math.floor(py), Math.floor(px) + 1, Math.floor(py) + 1);
  }

  const field = stamp.field;
  if (!layerIsEmpty(field)) {
    // Field texels to frame pixels: the field covers the scene's own box.
    const sx = stamp.canvas.width / field.width;
    const sy = stamp.canvas.height / field.height;
    for (let row = 0; row < field.height; row++) {
      for (let col = 0; col < field.width; col++) {
        const at = (row * field.width + col) * STAMP_TEXEL_CHANNELS;
        let wall = false;
        for (let c = 0; c < STAMP_TEXEL_CHANNELS; c++) {
          if (Math.abs(field.data[at + c] ?? 0) > WALL_EPSILON) wall = true;
        }
        if (wall) {
          take(
            g.ox + Math.floor(col * sx),
            g.oy + Math.floor(row * sy),
            g.ox + Math.ceil((col + 1) * sx),
            g.oy + Math.ceil((row + 1) * sy),
          );
        }
      }
    }
  }

  if (!(x1 > x0 && y1 > y0)) return null;
  return {
    x0: Math.max(0, x0 - TRAIL_CUSHION_PX),
    y0: Math.max(0, y0 - TRAIL_CUSHION_PX),
    x1: Math.min(cw, x1 + TRAIL_CUSHION_PX),
    y1: Math.min(ch, y1 + TRAIL_CUSHION_PX),
  };
}

export interface FitPlan {
  /** The world size to build at. */
  readonly worldSize: number;
  /** The world's shape (w/h). Differs from the screen's only when letterboxed. */
  readonly aspect: number;
  /** The canvas that world has, in pixels. */
  readonly canvas: CanvasSize;
  /** Which step answered, for reporting. */
  readonly step: 'fits' | 'grown' | 'letterboxed' | 'cropped';
}

function canvasFor(worldSize: number, aspect: number): CanvasSize {
  return canvasDimensions(aspect, sizingFor(worldSize)[1]);
}

/**
 * Step 2: the world a `width` x `height` pixel region needs on a screen of
 * `screenAspect`, given the target world size.
 */
export function planFit(
  width: number,
  height: number,
  screenAspect: number,
  target: number,
  growthMax = GROWTH_MAX,
  minFill = MIN_FILL,
): FitPlan {
  const fits = (c: CanvasSize): boolean => c[0] >= width && c[1] >= height;

  // a. The target, at the screen's shape.
  const base = canvasFor(target, screenAspect);
  if (fits(base)) {
    return { worldSize: target, aspect: screenAspect, canvas: base, step: 'fits' };
  }

  // b. Grow. Dimensions go as sqrt(world size), so the ratio squared is the
  // estimate; the loop absorbs sizingFor's truncation.
  const most = target * growthMax;
  const ratio = Math.max(width / base[0], height / base[1]);
  let size = target * ratio * ratio;
  for (let k = 0; k < 40 && size <= most && !fits(canvasFor(size, screenAspect)); k++) {
    size *= 1.002;
  }
  if (size <= most && fits(canvasFor(size, screenAspect))) {
    return {
      worldSize: size,
      aspect: screenAspect,
      canvas: canvasFor(size, screenAspect),
      step: 'grown',
    };
  }

  // c. The largest world, reshaped within the fill limit. A shape of `a` on a
  // screen of A covers min(a/A, A/a) of the canvas, so a stays within
  // [A*minFill, A/minFill]. Width needs a >= (w/d)^2 and height a <= (d/h)^2.
  const lo = screenAspect * minFill;
  const hi = screenAspect / minFill;
  const d = sizingFor(most)[1];
  const needLo = Math.max(lo, (width / d) ** 2);
  const needHi = Math.min(hi, (d / height) ** 2);
  if (needLo <= needHi) {
    const nearest = Math.min(needHi, Math.max(needLo, screenAspect));
    // Nudged inward if rounding at an edge of the range misses by a pixel.
    for (const aspect of [nearest, needLo * 1.002, needHi / 1.002, (needLo + needHi) / 2]) {
      if (aspect < needLo || aspect > needHi) continue;
      const canvas = canvasFor(most, aspect);
      if (fits(canvas)) return { worldSize: most, aspect, canvas, step: 'letterboxed' };
    }
  }

  // d. Crop, at the shape nearest the region's own the fill limit allows.
  const aspect = Math.min(hi, Math.max(lo, width / height));
  return { worldSize: most, aspect, canvas: canvasFor(most, aspect), step: 'cropped' };
}

/** Where along one axis a kept span starts, inside a region of `span`. */
function cropStart(span: number, kept: number, before: number, after: number): number {
  if (kept >= span) return 0;
  // Keep the side that touches the world's edge, if only one does.
  if (before === 0 && after > 0) return 0;
  if (after === 0 && before > 0) return span - kept;
  return Math.floor((span - kept) / 2);
}

/** Where along one axis the region goes, keeping the ratio of the gaps. */
function placeStart(free: number, before: number, after: number): number {
  if (free <= 0) return 0;
  const gaps = before + after;
  return gaps > 0 ? Math.round((free * before) / gaps) : Math.floor(free / 2);
}

export interface Placement {
  /** The scene, in the destination world's units, ready to paste at its box. */
  readonly stamp: StampData;
  /** True when some of the region did not fit and was cut away. */
  readonly cropped: boolean;
}


/**
 * Step 3: move `region` of `stamp` into a world whose canvas is `canvas`.
 *
 * `region` is in the frame's pixels (`activeRegion`'s answer for the same
 * frame). Particles keep their pixel position relative to the region, and their
 * velocity and size are converted to the destination's world units, so they
 * behave as they did. Trails are copied pixel for pixel; walls are resampled
 * nearest onto the same pixels (the wall field has its own, coarser grid).
 */
export function placeScene(
  stamp: StampData,
  region: PixelRegion,
  canvas: CanvasSize,
  frame: StampBox | null = null,
): Placement {
  const g = geometryOf(stamp, frame);
  const [dw, dh] = canvas;
  const rw = region.x1 - region.x0;
  const rh = region.y1 - region.y0;
  const kw = Math.min(rw, dw);
  const kh = Math.min(rh, dh);
  if (g === null || kw <= 0 || kh <= 0) {
    return { stamp: { ...stamp, particles: new ArrayBuffer(0) }, cropped: false };
  }
  const { width: sw, height: sh, ppu } = g;

  const left = region.x0;
  const right = sw - region.x1;
  // Rows count up from the world's bottom.
  const below = region.y0;
  const above = sh - region.y1;

  // The kept part of the region, in frame pixels.
  const sx0 = region.x0 + cropStart(rw, kw, left, right);
  const sy0 = region.y0 + cropStart(rh, kh, below, above);
  // And where it lands, in destination pixels.
  const dx0 = placeStart(dw - kw, left, right);
  const dy0 = placeStart(dh - kh, below, above);

  // --- the destination box, snapped to whole pixels -------------------------
  const [ex, ey] = worldHalfExtent(canvas);
  const worldX = (px: number): number => (px / dw - 0.5) * 2 * ex;
  const worldY = (row: number): number => (row / dh - 0.5) * 2 * ey;
  // Inset by a thousandth of a pixel so `pixelRectFor`'s outward rounding
  // lands exactly on the intended pixels rather than one beyond.
  const insetX = (1e-3 * 2 * ex) / dw;
  const insetY = (1e-3 * 2 * ey) / dh;
  const box: StampBox = {
    min: [worldX(dx0) + insetX, worldY(dy0) + insetY],
    max: [worldX(dx0 + kw) - insetX, worldY(dy0 + kh) - insetY],
  };

  // --- particles ------------------------------------------------------------
  // World units per pixel in each world; a length converts by their ratio.
  const scale = ((2 * ex) / dw) * ppu;
  const particles = filterParticles(stamp, g, sx0, sy0, kw, kh, (px, py, to, view, at, src) => {
    view.setFloat32(to + POS_X * 4, worldX(px - sx0 + dx0), true);
    view.setFloat32(to + POS_Y * 4, worldY(py - sy0 + dy0), true);
    view.setFloat32(to + VEL_X * 4, src.getFloat32(at + VEL_X * 4, true) * scale, true);
    view.setFloat32(to + VEL_Y * 4, src.getFloat32(at + VEL_Y * 4, true) * scale, true);
    view.setFloat32(to + SIZE * 4, src.getFloat32(at + SIZE * 4, true) * scale, true);
  });

  return {
    stamp: {
      box,
      particles,
      canvas: cropLayer(stamp.canvas, sx0 - g.ox, sy0 - g.oy, kw, kh),
      field: resampleField(stamp, sx0 - g.ox, sy0 - g.oy, kw, kh),
      palette: stamp.palette,
    },
    cropped: kw < rw || kh < rh,
  };
}

/**
 * A whole-world scene cut down to its active region, for SAVING, with the
 * frame it came from. Nothing moves or rescales: the particles keep their
 * world positions and the layers keep their pixels, so the trimmed scene
 * placed with its frame is exactly the untrimmed one. Null for an empty scene.
 */
export function trimScene(
  stamp: StampData,
): { stamp: StampData; frame: StampBox } | null {
  const g = geometryOf(stamp, null);
  const region = activeRegion(stamp, null);
  if (g === null || region === null) return null;
  const { x0, y0, x1, y1 } = region;
  const w = x1 - x0;
  const h = y1 - y0;
  const box: StampBox = {
    min: [g.frame.min[0] + x0 / g.ppu, g.frame.min[1] + y0 / g.ppu],
    max: [g.frame.min[0] + x1 / g.ppu, g.frame.min[1] + y1 / g.ppu],
  };
  return {
    stamp: {
      box,
      particles: filterParticles(stamp, g, x0, y0, w, h, () => {}),
      canvas: cropLayer(stamp.canvas, x0, y0, w, h),
      field: resampleField(stamp, x0, y0, w, h),
      palette: stamp.palette,
    },
    frame: g.frame,
  };
}

/**
 * The particles inside a rect of frame pixels, each copied verbatim and then
 * handed to `rewrite` to change what it needs.
 */
function filterParticles(
  stamp: StampData,
  g: Geometry,
  x0: number,
  y0: number,
  w: number,
  h: number,
  rewrite: (
    px: number,
    py: number,
    to: number,
    view: DataView,
    at: number,
    source: DataView,
  ) => void,
): ArrayBuffer {
  const source = new DataView(stamp.particles);
  const bytes = new Uint8Array(stamp.particles);
  const count = Math.floor(stamp.particles.byteLength / STAMP_PARTICLE_STRIDE);
  const out = new Uint8Array(count * STAMP_PARTICLE_STRIDE);
  const view = new DataView(out.buffer);
  let kept = 0;
  for (let i = 0; i < count; i++) {
    const at = i * STAMP_PARTICLE_STRIDE;
    const px = (source.getFloat32(at + POS_X * 4, true) - g.frame.min[0]) * g.ppu;
    const py = (source.getFloat32(at + POS_Y * 4, true) - g.frame.min[1]) * g.ppu;
    if (!(px >= x0 && px < x0 + w && py >= y0 && py < y0 + h)) continue;
    const to = kept * STAMP_PARTICLE_STRIDE;
    // Every lane verbatim first -- the config index is an int in float bits,
    // which must not pass through a float conversion.
    out.set(bytes.subarray(at, at + STAMP_PARTICLE_STRIDE), to);
    rewrite(px, py, to, view, at, source);
    kept++;
  }
  return out.buffer.slice(0, kept * STAMP_PARTICLE_STRIDE);
}

/**
 * A pixel-exact sub-rect of a layer, zero where it runs past the layer's edge
 * (a region's cushion may reach past a trimmed scene's own box).
 */
function cropLayer(layer: StampLayer, x0: number, y0: number, w: number, h: number): StampLayer {
  if (layerIsEmpty(layer) || w <= 0 || h <= 0) return emptyLayer();
  const data = new Float32Array(w * h * STAMP_TEXEL_CHANNELS);
  const colFrom = Math.max(0, -x0);
  const colTo = Math.min(w, layer.width - x0);
  if (colTo <= colFrom) return { width: w, height: h, data };
  for (let row = 0; row < h; row++) {
    const srcRow = y0 + row;
    if (srcRow < 0 || srcRow >= layer.height) continue;
    const from = (srcRow * layer.width + x0 + colFrom) * STAMP_TEXEL_CHANNELS;
    const count = (colTo - colFrom) * STAMP_TEXEL_CHANNELS;
    data.set(layer.data.subarray(from, from + count), (row * w + colFrom) * STAMP_TEXEL_CHANNELS);
  }
  return { width: w, height: h, data };
}

/**
 * The wall field over a rect of the scene's canvas pixels (relative to its own
 * box), at the field's own resolution, nearest-sampled; zero past its edge.
 */
function resampleField(
  stamp: StampData,
  x0: number,
  y0: number,
  w: number,
  h: number,
): StampLayer {
  const field = stamp.field;
  if (layerIsEmpty(field) || w <= 0 || h <= 0) return emptyLayer();
  const fx = field.width / stamp.canvas.width;
  const fy = field.height / stamp.canvas.height;
  const width = Math.max(1, Math.round(w * fx));
  const height = Math.max(1, Math.round(h * fy));
  const data = new Float32Array(width * height * STAMP_TEXEL_CHANNELS);
  for (let row = 0; row < height; row++) {
    const srcRow = Math.floor((y0 + ((row + 0.5) * h) / height) * fy);
    if (srcRow < 0 || srcRow >= field.height) continue;
    for (let col = 0; col < width; col++) {
      const srcCol = Math.floor((x0 + ((col + 0.5) * w) / width) * fx);
      if (srcCol < 0 || srcCol >= field.width) continue;
      const from = (srcRow * field.width + srcCol) * STAMP_TEXEL_CHANNELS;
      const to = (row * width + col) * STAMP_TEXEL_CHANNELS;
      for (let c = 0; c < STAMP_TEXEL_CHANNELS; c++) data[to + c] = field.data[from + c] ?? 0;
    }
  }
  return { width, height, data };
}
