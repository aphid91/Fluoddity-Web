/**
 * CameraState: where the viewer is looking, and in which mode.
 * A direct port of `camera/camera_state.py`.
 *
 * Deliberately tiny and free of GPU code: pan, zoom, mode. All the transform
 * math lives in `particleSystem/coords.ts` (ARCHITECTURE.md rule 9) -- this
 * module only decides *what* pan and zoom are, never how to apply them.
 *
 * CONVENTIONS (both differ from the original Fluoddity, on purpose):
 *   zoom  bigger = zoomed IN, a magnification factor. zoom=1 fits the world.
 *   pan   world units; the world point sitting at the center of the view.
 *
 * The original stored zoom inverted (smaller = closer) and pan in "ndc x zoom"
 * units with a negated y, which made pan values meaningless without also
 * knowing the zoom. These conventions make both directly readable.
 */

import {
  type CanvasSize,
  type Vec2,
  type WindowSize,
  screenToWorld,
  vec2Equals,
  worldHalfExtent,
} from '../particleSystem/coords.ts';

/**
 * Zoom limits. Below the minimum the world is a speck; above the maximum
 * floating-point precision in the canvas uv lookup starts to show.
 */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 100.0;

/** Multiplier per scroll notch. */
export const ZOOM_PER_NOTCH = 1.1;

/**
 * Keyboard pan speed, as a fraction of the visible height per second. Held
 * keys, so this is a RATE rather than a step -- a per-frame step would move
 * twice as fast at 120fps as at 60.
 *
 * Nothing in this module reads it: the code that samples held keys against a
 * frame delta and calls `panByFraction` is a later step's job. Exported here
 * because the constant belongs with the camera, not with the input handler.
 */
export const PAN_PER_SECOND = 0.9;

/**
 * Keyboard zoom rate, as a multiplier per second. Exponential because zoom is
 * multiplicative: a fixed additive step would crawl when zoomed out and lurch
 * when zoomed in. Consumed by the same later step as `PAN_PER_SECOND`.
 */
export const ZOOM_PER_SECOND = 2.2;

/**
 * What the camera draws.
 *
 * TRAIL     the accumulated velocity flow-field the particles write into.
 *           Smooth and continuous -- the trails ARE the simulation state.
 * PARTICLES each entity drawn as an instanced sprite, coloured by its own
 *           output. Shows where the particles actually are, which the trail
 *           view only implies. The DEFAULT: it is the more direct view of
 *           what the simulation is doing, and the only one that carries the
 *           per-particle colour signal.
 *
 * An ORDERED ARRAY rather than an object, because the order *is* the
 * semantics: `nextCameraMode` cycles through it, mirroring the Python enum's
 * declaration-order `next()`. Reordering this changes what the toggle does.
 */
export const CAMERA_MODES = ['trail', 'particles'] as const;

export type CameraMode = (typeof CAMERA_MODES)[number];

/** The next mode in declaration order, wrapping. */
export function nextCameraMode(mode: CameraMode): CameraMode {
  const index = CAMERA_MODES.indexOf(mode);
  // The modulo makes this always in range; the fallback exists because
  // `noUncheckedIndexedAccess` cannot prove that, and naming 'particles' here
  // documents the default mode rather than hiding behind a non-null assertion.
  return CAMERA_MODES[(index + 1) % CAMERA_MODES.length] ?? 'particles';
}

/**
 * Mutable camera state. Small enough to copy, cheap to save/load later.
 *
 * A class, unlike the config value types, because the Python dataclass is
 * deliberately NOT frozen and its methods mutate for effect. `zoomAtPixel` in
 * particular reads pan and zoom twice *around* a mutation, which is natural
 * with mutation and awkward threaded immutably.
 */
export class CameraState {
  pan: Vec2 = [0.0, 0.0];
  zoom = 1.0;
  mode: CameraMode = 'particles';

  constructor(init?: { pan?: Vec2; zoom?: number; mode?: CameraMode }) {
    if (init?.pan !== undefined) this.pan = init.pan;
    if (init?.zoom !== undefined) this.zoom = init.zoom;
    if (init?.mode !== undefined) this.mode = init.mode;
  }

  /**
   * Reset the view.
   *
   * Deliberately does NOT reset `mode`: which view you are looking through is
   * a display preference, not part of "where am I looking". Preserved from the
   * Python; do not "fix" it into resetting all three fields.
   */
  reset(): void {
    this.pan = [0.0, 0.0];
    this.zoom = 1.0;
  }

  /**
   * Zoom by `notches`, keeping the world point under `pixel` fixed.
   *
   * The anchor is what makes scroll-zoom feel controlled instead of lurching:
   * find the world point under the cursor, apply the zoom, then pan so that
   * same point lands back under the cursor.
   *
   * Note the ordering: `setZoom` clamps BEFORE `after` is computed, so at a
   * zoom limit `before` and `after` agree and the pan correction correctly
   * becomes a no-op. Computing `after` from an unclamped zoom would drift the
   * view every time the user kept scrolling at the limit.
   */
  zoomAtPixel(
    notches: number,
    pixel: Vec2,
    windowSize: WindowSize,
    canvasSize: CanvasSize,
  ): void {
    if (!notches) return;
    // NOTE screenToWorld's argument order: pixel, WINDOW, CANVAS.
    const before = screenToWorld(pixel, windowSize, canvasSize, this.pan, this.zoom);
    this.setZoom(this.zoom * ZOOM_PER_NOTCH ** notches);
    const after = screenToWorld(pixel, windowSize, canvasSize, this.pan, this.zoom);
    this.pan = [
      this.pan[0] + (before[0] - after[0]),
      this.pan[1] + (before[1] - after[1]),
    ];
  }

  /**
   * Pan by a fraction of the VISIBLE height, per axis.
   *
   * Keyboard navigation, so the step is time-based rather than pixel-based
   * (see `PAN_PER_SECOND`). Scaled by 1/zoom so a keypress covers the same
   * proportion of the screen at any magnification -- zoomed in, the same key
   * travels a smaller world distance, which is what makes it feel like moving
   * at a constant speed rather than lurching.
   *
   * HEIGHT, NOT WIDTH, ON BOTH AXES: using each axis's own extent would make
   * diagonal movement faster on a wide canvas. This looks like a bug and is
   * not; it is the one line of this method most likely to be "corrected".
   */
  panByFraction(fraction: Vec2, canvasSize: CanvasSize): void {
    // Element-wise, because JavaScript arrays compare by reference: the direct
    // transcription of Python's `fraction == (0.0, 0.0)` would always be false.
    if (vec2Equals(fraction, [0.0, 0.0])) return;
    const [, extentY] = worldHalfExtent(canvasSize);
    const step = (2.0 * extentY) / this.zoom;
    this.pan = [this.pan[0] + fraction[0] * step, this.pan[1] + fraction[1] * step];
  }

  /**
   * Zoom about the CENTER of the view, leaving pan untouched.
   *
   * Distinct from `zoomAtPixel`, which anchors on the cursor: a keyboard zoom
   * has no cursor to anchor to, and pulling the view toward wherever the mouse
   * happened to rest would be surprising.
   */
  zoomByFactor(factor: number): void {
    if (factor === 1.0) return;
    this.setZoom(this.zoom * factor);
  }

  /**
   * Clamp and store a zoom.
   *
   * ## A deliberate divergence from the Python
   *
   * `max(MIN_ZOOM, min(MAX_ZOOM, zoom))` absorbs NaN by accident in Python:
   * `nan < 100.0` is False, so `min` returns 100.0 and the NaN vanishes.
   * JavaScript's `Math.max`/`Math.min` propagate NaN instead, which would be
   * catastrophic and silent -- every later `screenToWorld` returns NaN and the
   * camera is permanently broken with no error anywhere.
   *
   * So a non-finite zoom is REJECTED here, leaving the current zoom in place.
   * That is a third behaviour, chosen over both: Python's clamp-to-max would
   * teleport the user to maximum magnification, where refusing the update is
   * the least surprising recovery. This is intentional, not an oversight.
   */
  setZoom(zoom: number): void {
    if (!Number.isFinite(zoom)) return;
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
  }

  toggleMode(): void {
    this.mode = nextCameraMode(this.mode);
  }
}
