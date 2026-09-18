/**
 * Host-side sizing and seeding for the dead-index pool.
 *
 * The GPU-side protocol -- how a slot is taken and returned, and why creation
 * and deletion must be separate passes -- lives in `src/shaders/freeList.wgsl`.
 * This module is only the arithmetic and the initial contents, and is a LEAF: it
 * imports nothing and touches no GPU resource, so it can be unit-tested under
 * `node --test` without a browser. That is the same reason `dispatch.ts` and
 * `sizing.ts` are their own modules.
 */

/**
 * Bytes before `slots` begins: the `atomic<u32> head`.
 *
 * WGSL lays `FreeList { head: atomic<u32>, slots: array<u32> }` out with the
 * array at offset 4 -- both members are 4-byte aligned, so there is no padding.
 * Stated here because the host writes this buffer directly and a wrong offset
 * would shift every index by one slot, which does not crash: it hands out
 * off-by-one particles and looks like a brush that paints slightly wrong.
 */
export const FREE_LIST_HEADER_BYTES = 4;

/** Bytes per slot -- one `u32` index. */
export const FREE_LIST_SLOT_BYTES = 4;

/**
 * Buffer size in bytes for a pool that can hold `entityCount` indices.
 *
 * `entityCount` of 0 is the STUDIO'S DUMMY and is deliberately legal, but it is
 * NOT a bare header: `FreeList` ends in a runtime-sized `array<u32>`, and
 * WebGPU's minimum binding size for such a struct is the header PLUS ONE
 * ELEMENT. A 4-byte buffer satisfies "non-zero" and still fails validation:
 *
 *     Buffer "FreeList (dummy)" bound with size 4 at group 0, binding 3 is too
 *     small. The pipeline requires a buffer binding which is at least 8 bytes.
 *
 * That error rejects every submit() for the whole frame, so the canvas holds its
 * last good frame forever -- a black screen in the STUDIO, caused entirely by a
 * buffer the studio never reads. Hence the floor of one slot below.
 *
 * The dummy still refuses every operation, which is what the studio wants:
 * `arrayLength(&slots)` is 1 but the head starts at 0, so `free_list_take`
 * underflows and puts the reservation back, and nothing in the studio ever
 * selects BC_KILL to call it in the first place.
 */
export function freeListSize(entityCount: number): number {
  // At least one slot -- see above. `max(1, ...)` is the whole fix.
  const slots = Math.max(1, Math.max(0, entityCount));
  return FREE_LIST_HEADER_BYTES + slots * FREE_LIST_SLOT_BYTES;
}

/**
 * The pool as it stands in a world where EVERY particle is dead -- which is the
 * state a fresh sand world starts in, and the state a reset returns it to.
 *
 * `head` is the count of available slots, so it starts at `entityCount`.
 *
 * ## THE ORDER IS LOAD-BEARING, and it is DESCENDING
 *
 * The stack pops from the top (`slots[head - 1]`), so filling descending means
 * the first particle created takes index 0, the second index 1, and so on --
 * allocation runs UPWARD from the bottom of the buffer.
 *
 * That is what makes a high-water mark possible, and the high-water mark is what
 * makes a large particle cap affordable. Every pass over the entities -- the
 * physics dispatch, the trail splat, the sprite draw -- can stop at the highest
 * index ever allocated instead of sweeping the whole buffer.
 *
 * This file originally filled ASCENDING, which handed out the highest index
 * first. Live particles then clustered at the END of the buffer, so any bound
 * computed from "how far up have we allocated" was the whole buffer from the
 * first particle painted, and a 3M cap cost 3M invocations per pass with one
 * particle on screen. The fill order was the entire difference.
 */
export function initialFreeList(entityCount: number): Uint32Array<ArrayBuffer> {
  const count = Math.max(0, entityCount);
  // Backed by an explicit ArrayBuffer, not the default ArrayBufferLike: WebGPU's
  // `writeBuffer` rejects a possibly-shared buffer, and `new Uint32Array(n)` is
  // typed loosely enough to include SharedArrayBuffer.
  const data = new Uint32Array(new ArrayBuffer((1 + count) * 4));
  data[0] = count;
  // Descending, so slots[count-1] is 0 and pops first.
  for (let i = 0; i < count; i++) data[i + 1] = count - 1 - i;
  return data;
}

/**
 * `DEAD_CONFIG` in `common.wgsl`. Mirrored here BY VALUE, like the `BC_*` modes
 * in `config.ts`: the shader is the definition, and the host needs to write it.
 */
export const DEAD_CONFIG = -1;

/**
 * An entity buffer in which every particle is dead.
 *
 * ONLY ONE LANE IS NON-ZERO. A dead Entity is 32 zero bytes except for
 * `config_index`, and that exception is the whole point: zero is a perfectly
 * valid config index meaning "alive, obeying config 0", so a naively zeroed
 * buffer is a buffer full of LIVE particles stacked at the origin. The
 * distinction costs one write per particle and is the difference between an
 * empty world and a solid dot of every species at once.
 *
 * `Int32Array` over the same memory is how the `i32` is written into a `f32`
 * lane -- the host-side spelling of the shader's `bitcast<f32>(config_index)`.
 *
 * Offsets come from the layout fixture via `ENTITY_STRIDE` and the lane index
 * below, so this cannot drift from `common.wgsl` without `layout.ts` noticing.
 */
export function deadEntityBytes(entityCount: number): ArrayBuffer {
  const count = Math.max(0, entityCount);
  // Entity is { pos_vel: vec4, misc: vec4 }; config_index is misc.y, so float
  // lane 5 of 8. Asserted against the fixture by `freeList.test.ts`.
  const FLOATS_PER_ENTITY = 8;
  const CONFIG_INDEX_LANE = 5;
  const buffer = new ArrayBuffer(count * FLOATS_PER_ENTITY * 4);
  const ints = new Int32Array(buffer);
  for (let i = 0; i < count; i++) {
    ints[i * FLOATS_PER_ENTITY + CONFIG_INDEX_LANE] = DEAD_CONFIG;
  }
  return buffer;
}

/**
 * The pool after a migration that packed `liveCount` particles into the front of
 * a buffer of `entityCount` slots.
 *
 * Every slot from `liveCount` upward is dead and available, so the head is the
 * difference and the slots list is that range. Written as a descending fill so
 * the LOWEST free index sits on top of the stack and is handed out first --
 * which keeps a freshly-migrated world allocating contiguously upward from the
 * live block, rather than scattering new particles across the tail.
 *
 * (`initialFreeList` fills ascending for the opposite reason: with every slot
 * free, filling from the back is arbitrary either way, and ascending is the
 * simpler statement of "all of them".)
 */
export function freeListAfterMigration(
  entityCount: number,
  liveCount: number,
): Uint32Array<ArrayBuffer> {
  const total = Math.max(0, entityCount);
  const live = Math.max(0, Math.min(liveCount, total));
  const free = total - live;
  const data = new Uint32Array(new ArrayBuffer((1 + total) * 4));
  data[0] = free;
  for (let i = 0; i < free; i++) {
    // Descending: slots[free-1] is `live`, the lowest free index, so it pops
    // first.
    data[i + 1] = total - 1 - i;
  }
  return data;
}

/**
 * How many particles a brush should create this frame, given its radius and a
 * spawn rate measured per unit of world area per second.
 *
 * PROPORTIONAL TO AREA, not radius: a brush twice as wide covers four times the
 * canvas and must deposit four times as much to feel like the same density of
 * material. Requirement 5 says as much, and it is the difference between a big
 * brush feeling like a wide nozzle and feeling like a thin one.
 *
 * Clamped to `available` so a brush cannot ask for more particles than the pool
 * holds. The shader guards this too (the reservation refuses to underflow), but
 * clamping here keeps the dispatch from launching invocations that can only
 * fail, and keeps the count honest for anything that reports it.
 *
 * `dt` is seconds, so the rate is frame-rate independent -- a drag deposits the
 * same material whether the machine renders at 30fps or 144.
 */
export function spawnCountFor(
  radius: number,
  rate: number,
  dt: number,
  available: number,
): number {
  if (radius <= 0 || rate <= 0 || dt <= 0) return 0;
  const area = Math.PI * radius * radius;
  return Math.max(0, Math.min(Math.round(area * rate * dt), Math.max(0, available)));
}
