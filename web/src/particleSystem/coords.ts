/**
 * The TypeScript mirror of the coordinate math in `common.wgsl`.
 * A direct port of `particle_system/coords.py`.
 *
 * THIS MODULE AND `common.wgsl` ARE THE ONLY TWO PLACES ALLOWED TO WRITE
 * ASPECT-RATIO OR CAMERA MATH (ARCHITECTURE.md invariant 9). Everything else
 * calls these functions. The reference implementation had six divergent copies
 * of this transform, at least one contradicting the others, and the resulting
 * drift between overlays and the simulation was never fully fixed. That is the
 * failure this rule prevents.
 *
 * Keep these functions in lockstep with the ones at the bottom of
 * `common.wgsl`. (Step 3 of the port writes that file; until then the Python's
 * `common.glsl` is the other half of the pair.)
 *
 * ===========================================================================
 * THREE INDEPENDENT ASPECT QUANTITIES
 * ===========================================================================
 * Conflating these is the single biggest source of confusion in this domain, so
 * they are named distinctly everywhere:
 *
 *   canvas_size   The simulation texture's dimensions. Defines WORLD SPACE.
 *                 Changing it changes the shape of the simulated world.
 *                 NOT the HTML <canvas> element.
 *
 *   window_size   The framebuffer's dimensions in pixels. Changes when the user
 *                 resizes the window. Must NOT move a particle.
 *                 On the web this is `canvas.width/height` -- the backing store
 *                 in device pixels, not `clientWidth/clientHeight` and not the
 *                 browser window. See `app/surface.ts`.
 *
 *   letterbox     How the canvas is fitted into the window when their aspects
 *                 disagree. Derived from the two above; never stored.
 *
 * ===========================================================================
 * WORLD SPACE (area-preserving)
 * ===========================================================================
 * With ca = canvas_size.x / canvas_size.y:
 *
 *     world = [-sqrt(ca), +sqrt(ca)]  x  [-1/sqrt(ca), +1/sqrt(ca)]
 *
 * so world area is always 4 and a circle stays a circle. On a square canvas
 * ca == 1 and this reduces to the familiar [-1,1] x [-1,1].
 *
 * ===========================================================================
 * THE VIEW TRANSFORM  (world -> screen)
 * ===========================================================================
 *     world                                     entity coordinates
 *       |  / world_half_extent                  normalize to [-1,1] canvas box
 *     canvas ndc
 *       |  - pan, * zoom                        camera
 *     view ndc
 *       |  * letterbox_scale                    fit canvas into window
 *     screen ndc  [-1,1]
 *       |  * 0.5 + 0.5, flip y, * window_size
 *     screen pixels                             origin top-left
 *
 * Every step is invertible and `screenToWorld` walks it backwards. If you ever
 * need a new conversion, compose it from these -- do not write a fresh one.
 *
 * ZOOM CONVENTION: bigger zoom = zoomed IN (a magnification factor).
 * zoom=1 fits the world in the window; zoom=2 shows half of it. This is the
 * opposite of the original Fluoddity, whose "zoom" was really a view size and
 * made the math read backwards (`scale /= zoom`).
 *
 * PAN UNITS: world units. pan is the world point at the center of the view, so
 * `pan = [0.5, 0]` puts world x=0.5 in the middle of the screen. The original
 * stored pan in "ndc x zoom" units with a negated y, which meant pan values were
 * meaningless without also knowing the zoom.
 *
 * This module imports nothing. It is the leaf everything else composes.
 */

/** A 2-component value: a world point, a uv, an ndc pair, a pixel. */
export type Vec2 = readonly [number, number];

/** The simulation texture's dimensions. Defines world space. */
export type CanvasSize = readonly [number, number];

/**
 * The framebuffer's dimensions in device pixels.
 *
 * `app/surface.ts` declares a structurally identical `WindowSize`. The two are
 * interchangeable at every call site (TypeScript is structural), and they stay
 * separate because this module must import nothing. Consolidating them is a
 * later cleanup, not a Step 2 concern.
 */
export type WindowSize = readonly [number, number];

/**
 * Camera state that produces an untransformed view. Handy as a default and for
 * the trail-view present pass, which bakes no camera in.
 */
export const IDENTITY_PAN: Vec2 = [0.0, 0.0];
export const IDENTITY_ZOOM = 1.0;

/**
 * Element-wise equality for a `Vec2`.
 *
 * Python compares tuples by value (`fraction == (0.0, 0.0)`); JavaScript arrays
 * compare by reference, so the direct transcription `fraction === [0, 0]`
 * compiles cleanly and is ALWAYS false -- silently deleting whatever early-out
 * it guards. Naming the comparison once keeps that trap in one place.
 *
 * Note `-0 === 0` in JavaScript and `-0.0 == 0.0` in Python, so the two agree
 * on signed zero.
 */
export function vec2Equals(a: Vec2, b: Vec2): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

// ---------------------------------------------------------------------------
// World space
// ---------------------------------------------------------------------------

/** Half-extent of world space on each axis, from canvas (width, height). */
export function worldHalfExtent(canvasSize: CanvasSize): Vec2 {
  const ca = canvasSize[0] / canvasSize[1];
  const s = Math.sqrt(ca);
  return [s, 1.0 / s];
}

/** World position -> texture uv [0,1]. */
export function worldToUv(p: Vec2, canvasSize: CanvasSize): Vec2 {
  const [ex, ey] = worldHalfExtent(canvasSize);
  return [p[0] / (2.0 * ex) + 0.5, p[1] / (2.0 * ey) + 0.5];
}

/** Texture uv [0,1] -> world position. */
export function uvToWorld(uv: Vec2, canvasSize: CanvasSize): Vec2 {
  const [ex, ey] = worldHalfExtent(canvasSize);
  return [(uv[0] - 0.5) * 2.0 * ex, (uv[1] - 0.5) * 2.0 * ey];
}

/**
 * A radius measured in the brush's ASPECT-CORRECTED uv metric is exactly twice
 * as large in world units, on both axes.
 *
 * The brush corrects a uv delta by (sqrt(ca), 1/sqrt(ca)) -- see
 * `aspect_correct_uv` in `strafe_draw.frag` -- and world space scales uv by
 * 2*(sqrt(ca), 1/sqrt(ca)). The aspect factors are identical, so they cancel
 * and only the factor of 2 survives. That cancellation is WHY a single radius
 * can describe the same circle for a tool that works in uv (Draw) and one that
 * works in world space (Shove): both metrics are area-preserving, so neither
 * turns a circle into an oval, and they differ only in scale.
 */
const UV_TO_WORLD_RADIUS = 2.0;

/**
 * Brush radius (aspect-corrected uv) -> world units.
 *
 * Independent of canvas size, which is the point -- see above.
 */
export function uvRadiusToWorld(radius: number): number {
  return radius * UV_TO_WORLD_RADIUS;
}

/**
 * World position -> canvas-normalized device coords [-1,1].
 *
 * This is the *canvas* box, before any camera or letterboxing. It is what a
 * shader rasterizing into the canvas texture wants.
 */
export function worldToNdc(p: Vec2, canvasSize: CanvasSize): Vec2 {
  const [ex, ey] = worldHalfExtent(canvasSize);
  return [p[0] / ex, p[1] / ey];
}

/** Canvas ndc [-1,1] -> world position. */
export function ndcToWorld(ndc: Vec2, canvasSize: CanvasSize): Vec2 {
  const [ex, ey] = worldHalfExtent(canvasSize);
  return [ndc[0] * ex, ndc[1] * ey];
}

// There is deliberately no host-side worldWrap here, and no toroidal distance.
// Wrapping is the shader's job (`world_wrap` in common.wgsl): nothing on the
// host ever needs to move a particle. Picking -- the only thing that ever
// wanted a toroidal distance -- uses straight-line distance in every boundary
// mode; see entity_pick.

// ---------------------------------------------------------------------------
// Letterboxing
// ---------------------------------------------------------------------------

/**
 * Scale factors fitting the canvas box into the window, preserving shape.
 *
 * Returns multipliers applied to canvas-ndc to reach screen-ndc. The axis
 * that would overflow is shrunk; the other stays 1.0. The unused margin is
 * the letterbox bar.
 *
 * Fit (not fill): the whole canvas is always visible. A circle stays a
 * circle in any window shape.
 */
export function letterboxScale(canvasSize: CanvasSize, windowSize: WindowSize): Vec2 {
  if (windowSize[0] <= 0 || windowSize[1] <= 0) {
    return [1.0, 1.0];
  }
  const canvasAspect = canvasSize[0] / canvasSize[1];
  const windowAspect = windowSize[0] / windowSize[1];
  if (windowAspect > canvasAspect) {
    // Window is wider than the canvas: bars on the left and right.
    return [canvasAspect / windowAspect, 1.0];
  }
  // Window is taller: bars on top and bottom. Equal aspects land here and
  // yield [1, 1], which is correct -- there are no bars.
  return [1.0, windowAspect / canvasAspect];
}

// ---------------------------------------------------------------------------
// The view transform
// ---------------------------------------------------------------------------

/** World position -> screen ndc [-1,1], through camera and letterbox. */
export function worldToScreenNdc(
  p: Vec2,
  canvasSize: CanvasSize,
  windowSize: WindowSize,
  pan: Vec2 = IDENTITY_PAN,
  zoom: number = IDENTITY_ZOOM,
): Vec2 {
  // Camera acts in world units, so pan is subtracted before normalizing.
  const [cx0, cy0] = worldToNdc([p[0] - pan[0], p[1] - pan[1]], canvasSize);
  const cx = cx0 * zoom;
  const cy = cy0 * zoom;
  const [sx, sy] = letterboxScale(canvasSize, windowSize);
  return [cx * sx, cy * sy];
}

/**
 * Screen ndc [-1,1] -> world position. Exact inverse of the above.
 *
 * THE TWO GUARDS BELOW ARE DELIBERATELY ASYMMETRIC, ported exactly from
 * `coords.py:183-188`:
 *
 *   - A zero letterbox scale ZEROES that component (`sx ? ndc[0] / sx : 0`).
 *   - A zero zoom leaves BOTH components UNDIVIDED -- one condition covering
 *     both axes, not two per-axis guards.
 *
 * A tidier-looking rewrite that unifies them (`cx = zoom ? cx / zoom : 0`)
 * changes behaviour: it would zero the components where the original passes
 * them through. Preserved as-is and covered by a named test.
 */
export function screenNdcToWorld(
  ndc: Vec2,
  canvasSize: CanvasSize,
  windowSize: WindowSize,
  pan: Vec2 = IDENTITY_PAN,
  zoom: number = IDENTITY_ZOOM,
): Vec2 {
  const [sx, sy] = letterboxScale(canvasSize, windowSize);
  let cx = sx ? ndc[0] / sx : 0.0;
  let cy = sy ? ndc[1] / sy : 0.0;
  if (zoom) {
    cx /= zoom;
    cy /= zoom;
  }
  const [wx, wy] = ndcToWorld([cx, cy], canvasSize);
  return [wx + pan[0], wy + pan[1]];
}

/**
 * Screen pixel (origin top-left, y down) -> screen ndc [-1,1].
 *
 * The desktop's convention is GLFW's; the browser's `clientX/clientY` and
 * `offsetX/offsetY` share it, so the y flip is the same on both platforms.
 */
export function screenToNdc(pixel: Vec2, windowSize: WindowSize): Vec2 {
  if (windowSize[0] <= 0 || windowSize[1] <= 0) {
    return [0.0, 0.0];
  }
  return [
    (2.0 * pixel[0]) / windowSize[0] - 1.0,
    1.0 - (2.0 * pixel[1]) / windowSize[1],
  ];
}

/**
 * Screen ndc [-1,1] -> screen pixel.
 *
 * KEPT although nothing calls it: this is `screenToNdc`'s exact inverse, and a
 * conversion table missing one direction invites the next caller to write it
 * inline -- which is what invariant 9 exists to stop. Four lines, no cost.
 *
 * Note it has NO degenerate-window guard where `screenToNdc` does. That
 * asymmetry is in the Python too; a zero window here yields [0, 0] naturally
 * rather than by special case.
 */
export function ndcToScreen(ndc: Vec2, windowSize: WindowSize): Vec2 {
  return [
    (ndc[0] + 1.0) * 0.5 * windowSize[0],
    (1.0 - ndc[1]) * 0.5 * windowSize[1],
  ];
}

/**
 * Screen pixel -> world position. The full inverse chain.
 *
 * This is what picking, drawing and cursor readouts want.
 *
 * ARGUMENT ORDER: `windowSize` comes BEFORE `canvasSize` here, the opposite of
 * every other function in this module. That is how `coords.py:213` orders them,
 * and it is preserved so the two files stay diff-comparable. It has exactly two
 * callers (both in `cameraState.zoomAtPixel`), so the ergonomic cost is nil --
 * but it is a live footgun, hence this note.
 */
export function screenToWorld(
  pixel: Vec2,
  windowSize: WindowSize,
  canvasSize: CanvasSize,
  pan: Vec2 = IDENTITY_PAN,
  zoom: number = IDENTITY_ZOOM,
): Vec2 {
  const ndc = screenToNdc(pixel, windowSize);
  return screenNdcToWorld(ndc, canvasSize, windowSize, pan, zoom);
}

// The forward chain stops at worldToScreenNdc (above), which the camera and
// the overlays use. A worldToScreen composing it with ndcToScreen, and a
// visibleWorldBounds built on screenToWorld, both existed in the Python unused
// and were deleted -- the app only ever converts the other way, from the cursor
// into the world. Both are two lines to rebuild from the steps above if
// something ever wants them. Do not resurrect them speculatively.
