/**
 * Picking: the key packing, the result layout, and the screen-to-world radius.
 *
 * The port of `particle_system/picker.py`'s ARITHMETIC. The GPU objects live in
 * `particleSystem.ts`; everything here is pure, so it is testable under
 * `node --test` -- the same split as `dispatch.ts`, `blurSchedule.ts` and the
 * uniform packers, and for the same reason (a module importing a `.wgsl` file
 * cannot be imported by a test, because include resolution is a Vite plugin).
 *
 * ## The two-phase design is not a web workaround
 *
 * `request()` dispatches and `retrieve()` reads on a LATER frame. The desktop
 * already works this way (`picker.py:9-19`) because reading the same frame
 * stalls the pipeline; WebGPU makes it mandatory rather than merely wise, since
 * there is no synchronous readback at all. The call-site contract was therefore
 * already async before the port started.
 *
 * ## What Step 6 adds that the desktop does not have
 *
 * The desktop reads back 4 bytes -- the key -- and recomputes the picked
 * particle's rule host-side in float32 (`particle_system/mutation.py`, 236
 * lines). That file is deliberately NOT ported: JavaScript has no float32
 * arithmetic, and `mutation.py:149`'s `pow(h, 2.0)` (where `pow(h,2)` and `h*h`
 * differ by 1 ULP, which the chaotic hash amplifies into a completely different
 * rule) has no reliable JS equivalent. A wrong adopted rule LOOKS LIKE A
 * LEGITIMATE RESULT, which makes it the worst failure mode available.
 *
 * So the GPU derives the rule and this reads back 336 bytes instead of 4.
 */

import { screenToWorld, type Vec2, type CanvasSize, type WindowSize } from './coords.ts';
import { layoutOf } from './layout.ts';

// ---------------------------------------------------------------------------
// The packed key
// ---------------------------------------------------------------------------

/**
 * WHERE THE 32 BITS GO. 24 bits of entity index in the low bits, 8 bits of
 * quantized distance in the high bits -- so `atomicMin` over the key minimizes
 * DISTANCE FIRST and breaks ties by LOWEST INDEX. Both halves of that are
 * deliberate: the ordering is what makes a single atomic do the whole
 * reduction, and the tie-break is what makes the result deterministic frame to
 * frame rather than depending on which workgroup happened to finish first.
 *
 * 24 bits covers 16.7M entities. That is not decorative: the field was once 20
 * bits, and world size 2.0 creates 1.2M entities, so everything past 2^20
 * silently stopped being pickable -- which reads as "the last cohorts ignore
 * clicks", not as an error. `pick.test.ts` asserts the bound against
 * `sizingFor` for exactly that reason.
 */
export const INDEX_BITS = 24;
export const INDEX_MASK = (1 << INDEX_BITS) - 1;
export const DIST_BITS = 8;
export const DIST_MAX = (1 << DIST_BITS) - 1;

/**
 * Written to the key before EVERY dispatch, and the sentinel that survives when
 * nothing is in range.
 *
 * The write is MANDATORY, not defensive: `atomicMin` only ever lowers, so a
 * stale winner from a previous pick would beat every candidate of the current
 * one, forever. `picker.py:107` does the same write first thing.
 */
export const NO_HIT = 0xffffffff;

/**
 * Default search radius in SCREEN PIXELS.
 *
 * Screen-space so the tolerance feels identical at any zoom -- a world-space
 * radius would shrink on screen as you zoom out, making distant particles
 * progressively harder to hit.
 */
export const DEFAULT_PICK_RADIUS_PX = 40.0;

// ---------------------------------------------------------------------------
// The result buffer layout
// ---------------------------------------------------------------------------

/**
 * `PickResultBuffer` -- 336 bytes.
 *
 *   key   : atomic<u32>  (4)    offset 0
 *   pos   : vec2f        (8)    offset 4
 *   _pad  : u32          (4)    offset 12
 *   rule  : Rule         (320)  offset 16
 *
 * `Rule` is 16-byte aligned (it is built from `vec4f`), so `rule` cannot start
 * at offset 4 -- WGSL inserts 12 bytes of padding after the key whether or not
 * anything is written there. **THE POSITION RIDES IN THAT PADDING AND IS
 * THEREFORE FREE.** That is why the scalars come BEFORE the rule: appended
 * after it, `pos` would claim a whole new 16-byte lane and the buffer would be
 * 352 bytes for the same content.
 *
 * (docs/WEB_PORT_PLAN.md Step 6 says 324 = 4 + 320. That predates the padding
 * and the position; 336 is the real number.)
 */
export const PICK_KEY_OFFSET = 0;
export const PICK_POS_OFFSET = 4;
export const PICK_RULE_OFFSET = 16;

/** Floats in a `Rule`: 10 FourierCenters x (4 frequency + 4 amplitude). */
export const RULE_FLOATS = 80;

export const PICK_RESULT_SIZE = PICK_RULE_OFFSET + layoutOf('Rule').size;

// The offsets above are hand-written, and `Rule`'s size is not. If someone adds
// a vec4 to Rule in common.glsl and regenerates the descriptor, the readback
// would keep slicing 80 floats out of a 336-byte window that no longer holds
// them -- silently, and the wrong rule would be adopted. Same argument, and the
// same shape, as layout.ts:112-129.
{
  const ruleSize = layoutOf('Rule').size;
  if (ruleSize !== RULE_FLOATS * 4) {
    throw new Error(
      `Rule is ${ruleSize} bytes in layout.generated.json but pick.ts reads ` +
        `${RULE_FLOATS} floats (${RULE_FLOATS * 4} bytes) out of the pick result.`,
    );
  }
  if (PICK_RULE_OFFSET % 16 !== 0) {
    throw new Error(
      `PICK_RULE_OFFSET is ${PICK_RULE_OFFSET}, not 16-byte aligned. Rule is ` +
        `built from vec4f, so WGSL will place it elsewhere than this says.`,
    );
  }
  if (PICK_RESULT_SIZE % 16 !== 0) {
    throw new Error(`PickResultBuffer is ${PICK_RESULT_SIZE} bytes, not a multiple of 16.`);
  }
}

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

/** Outcome of a pick. `index < 0` means nothing was in range. */
export interface PickResult {
  readonly index: number;
  /** The winner's WORLD position, written by the derive dispatch. */
  readonly pos: Vec2;
  readonly distance: number;
  /**
   * The 80-float rule the winner is obeying, derived on the GPU.
   *
   * `null` on a miss -- there is no entity whose rule it could be. This is what
   * selection adopts, and the whole reason the result buffer is 336 bytes.
   */
  readonly rule: readonly number[] | null;
}

/** Returned when nothing was in range. */
export const MISS: PickResult = {
  index: -1,
  pos: [0.0, 0.0],
  distance: Infinity,
  rule: null,
};

export function isHit(result: PickResult): boolean {
  return result.index >= 0;
}

/**
 * Decode the 336 bytes the GPU wrote. The port of `picker.py:131-147`.
 *
 * `radiusWorld` must be the radius of the DISPATCH THIS RESULT CAME FROM, not
 * the current one: the distance is quantized as a fraction of that radius, so
 * decoding with a radius from a later click would scale it wrongly. That is why
 * the caller carries it alongside the in-flight pick (`picker.py:90-92` keeps
 * `_pending_radius` for the same reason).
 */
export function decodePickResult(bytes: ArrayBuffer, radiusWorld: number): PickResult {
  if (bytes.byteLength < PICK_RESULT_SIZE) {
    throw new Error(
      `pick result is ${bytes.byteLength} bytes, expected at least ${PICK_RESULT_SIZE}`,
    );
  }

  const key = new Uint32Array(bytes, PICK_KEY_OFFSET, 1)[0]!;
  if (key === NO_HIT) return MISS;

  // `>>>` not `>>`: the key's top bit is set for any quantized distance >= 128,
  // and a signed shift would make the index negative.
  const index = key & INDEX_MASK;
  const distQ = key >>> INDEX_BITS;
  const distance = (distQ / DIST_MAX) * radiusWorld;

  const pos = new Float32Array(bytes, PICK_POS_OFFSET, 2);
  const rule = new Float32Array(bytes, PICK_RULE_OFFSET, RULE_FLOATS);

  return {
    index,
    pos: [pos[0]!, pos[1]!],
    distance,
    // A plain array, not the Float32Array view: the view aliases a buffer the
    // caller is about to unmap, and reading a detached ArrayBuffer throws.
    rule: Array.from(rule),
  };
}

// ---------------------------------------------------------------------------
// Screen radius -> world radius
// ---------------------------------------------------------------------------

/**
 * Convert a screen-pixel radius to world units at the current view.
 * The port of `picker.py:150-162`.
 *
 * Goes THROUGH the transform rather than scaling by a fudge factor, so the
 * tolerance is exactly `radiusPx` on screen at any zoom, aspect or window
 * shape. Because the transform is isotropic (invariant 9), one radius serves
 * both axes and one of them suffices to measure it.
 */
export function radiusPxToWorld(
  radiusPx: number,
  windowSize: WindowSize,
  canvasSize: CanvasSize,
  pan: Vec2,
  zoom: number,
): number {
  const center: Vec2 = [windowSize[0] / 2.0, windowSize[1] / 2.0];
  const a = screenToWorld(center, windowSize, canvasSize, pan, zoom);
  const b = screenToWorld([center[0] + radiusPx, center[1]], windowSize, canvasSize, pan, zoom);
  return Math.abs(b[0] - a[0]);
}

// ---------------------------------------------------------------------------
// Uniforms
// ---------------------------------------------------------------------------

/**
 * `PickUniforms` -- 48 bytes. world (32) + params (16).
 *
 *   world  : WorldData  (32)  offset 0
 *   params : vec4f      (16)  offset 32   xy: target (world)  z: max_dist  w: reserved
 *
 * `world` is here because the DERIVE pass must select the winner's config the
 * same way `entityUpdate.wgsl` does -- `configs[clamp(i, 0, world_config_count
 * (world) - 1)]`. Clamping to a different bound could read a different
 * `ConfigData` than the physics did, and derive a rule the entity is not
 * obeying.
 *
 * The desktop passes `target` and `max_dist` as loose uniforms
 * (`entity_pick.glsl:52-53`) and needs no world at all, because GL's uniform
 * model lets the shader ignore what it does not use.
 */
export const PICK_UNIFORM_SIZE = 48;
