/**
 * Dispatch arithmetic for the stamp passes.
 *
 * ## A LEAF, for the reason `compactPlan.ts` and `sandDispatch.ts` are leaves
 *
 * Imports nothing and touches no GPU resource, so the numbers that size every
 * dispatch are testable under `node --test`. A wrong workgroup count here does
 * not crash -- it silently covers part of a buffer, which for a stamp means a
 * capture that loses its tail.
 *
 * ## The scan is NOT reimplemented here
 *
 * The copy path is count -> scan -> scatter, and the scan is the SAME problem
 * the compactor already solved: an exclusive prefix sum over per-workgroup
 * partials, multi-level once the partial count exceeds what one workgroup can
 * cover. `compactPlan.ts` states that arithmetic, `compactScan.wgsl` implements
 * it, and both are already proven against the failure they exist for -- a
 * single-level scan silently summing only the first 512 workgroups.
 *
 * So the stamp copier reuses both, and this module only states what is genuinely
 * its own: the workgroup sizes its three shaders declare. Re-deriving the scan
 * here would be a second copy of the subtlest arithmetic in the program, which
 * is exactly how the two drift.
 */

/**
 * MUST match `@workgroup_size(256)` in `stampCount.wgsl` and
 * `stampScatter.wgsl`.
 *
 * THE SAME 256 THE COMPACTION USES, and that is a requirement rather than a
 * coincidence: the scan consuming these partials is `compactScan.wgsl`, sized
 * by `compactPlan.partialCount`, which assumes `ENTITIES_PER_PARTIAL` entities
 * per partial. A different size here would make the host allocate a partials
 * buffer of one length while the count pass wrote another.
 *
 * `stampDispatch.test.ts` asserts this against `COMPACT_WORKGROUP_SIZE`, and
 * `stampShaders.test.ts` asserts it against the shader text.
 */
export const STAMP_WORKGROUP_SIZE = 256;

/**
 * MUST match `@workgroup_size(256)` in `stampClear.wgsl`.
 *
 * Sweeps the whole entity buffer like `kill.wgsl` does, so it takes the same
 * size for the same reason -- unlike the paste, which is sized to the stamp.
 */
export const STAMP_CLEAR_WORKGROUP_SIZE = 256;

/**
 * MUST match `@workgroup_size(256)` in `stampPaste.wgsl`.
 *
 * ## Why this is 256 where `spawn.wgsl` is 64
 *
 * The spawn brush dispatches over a handful of particles -- a few hundred on a
 * big brush -- so 64 wastes less on the small dispatches that are its common
 * case. A paste is the opposite: a whole-scene restore places every particle in
 * the world at once, hundreds of thousands of them, and at that scale the larger
 * group is the better shape.
 *
 * Both are "one invocation per particle to create" and both take from the free
 * list; only the expected COUNT differs, which is what the group size is tuned
 * against.
 */
export const STAMP_PASTE_WORKGROUP_SIZE = 256;

/**
 * Workgroups covering `n` items at a given group size.
 *
 * ROUNDS UP, so the last group runs partly out of range -- every stamp shader
 * bounds-checks its invocation for exactly that reason. Returns 0 for n <= 0,
 * which is a legal dispatch and the right answer for an empty stamp: recording
 * a pass that covers nothing is cheaper than branching around it at the call
 * site, and WebGPU accepts a zero-workgroup dispatch.
 */
export function stampGroups(n: number, size: number = STAMP_WORKGROUP_SIZE): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (!Number.isFinite(size) || size <= 0) return 0;
  return Math.ceil(n / size);
}

/**
 * Bytes a stamp's particle block needs for `count` particles at `stride` bytes.
 *
 * FLOORED AT ONE PARTICLE, never zero. A zero-sized storage buffer fails
 * WebGPU's minimum binding size, and the error rejects every submit for the
 * whole frame -- the canvas then holds its last good frame forever, which reads
 * as the app freezing rather than as a buffer being the wrong size.
 * `freeListSize` documents the identical trap; this is the same fix.
 *
 * An empty stamp is an ordinary outcome: a box dragged over bare canvas holds
 * no particles and must still produce a valid, pasteable stamp.
 */
export function particleBlockBytes(count: number, stride: number): number {
  const n = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  return Math.max(1, n) * stride;
}

/**
 * Bytes to allocate for reading back `texels` texels of a 4-channel layer.
 *
 * ## THE 256-BYTE ROW ALIGNMENT IS NOT OPTIONAL
 *
 * `copyTextureToBuffer` requires `bytesPerRow` to be a multiple of 256. A layer
 * whose natural row length is not -- which is most of them, since a row is
 * `width * channels * 2 bytes` of half-float, 4 or 8 bytes a texel --
 * must be copied with a PADDED row stride and unpacked afterwards.
 *
 * Getting this wrong does not produce a small error: the copy is rejected
 * outright, or worse, succeeds with every row offset from the last by a few
 * bytes, which reads back as an image sheared diagonally. `unpackRows` below is
 * the other half.
 */
export const COPY_ROW_ALIGNMENT = 256;

/** The padded row stride `copyTextureToBuffer` requires for a layer row. */
export function alignedBytesPerRow(width: number, bytesPerTexel: number): number {
  const natural = Math.max(0, Math.trunc(width)) * bytesPerTexel;
  return Math.ceil(natural / COPY_ROW_ALIGNMENT) * COPY_ROW_ALIGNMENT;
}

/**
 * Drop the row padding a `copyTextureToBuffer` readback carries.
 *
 * Takes the padded bytes and returns a tight `Float32Array` of
 * `width * height * channels`. Pure, so the unpacking -- where an off-by-one
 * shears the image -- is testable without a GPU.
 *
 * Returns an empty array for a degenerate layer rather than throwing: an empty
 * stamp is ordinary, and `stampProblem` is what rejects a malformed one.
 */
export function unpackRows(
  padded: Float32Array,
  width: number,
  height: number,
  channels: number,
  paddedBytesPerRow: number,
): Float32Array<ArrayBuffer> {
  const w = Math.max(0, Math.trunc(width));
  const h = Math.max(0, Math.trunc(height));
  if (w === 0 || h === 0) return new Float32Array(new ArrayBuffer(0));

  const floatsPerRow = w * channels;
  const paddedFloatsPerRow = paddedBytesPerRow / 4;
  const out = new Float32Array(new ArrayBuffer(floatsPerRow * h * 4));
  for (let row = 0; row < h; row++) {
    const from = row * paddedFloatsPerRow;
    // `subarray` rather than a copy loop: one bulk set per row, and the bounds
    // are clamped by `set` refusing to write past the destination.
    out.set(padded.subarray(from, from + floatsPerRow), row * floatsPerRow);
  }
  return out;
}

/**
 * Re-introduce row padding, for uploading a layer back to a texture.
 *
 * `writeTexture` accepts an unpadded `bytesPerRow`, so this is NOT needed for
 * the upload path -- it exists as the exact inverse of `unpackRows` so the pair
 * can be round-trip tested. A round trip that does not return the original is
 * the cheapest possible detection of a stride bug, and stride bugs here are
 * invisible by nature.
 */
export function packRows(
  tight: Float32Array,
  width: number,
  height: number,
  channels: number,
  paddedBytesPerRow: number,
): Float32Array<ArrayBuffer> {
  const w = Math.max(0, Math.trunc(width));
  const h = Math.max(0, Math.trunc(height));
  const paddedFloatsPerRow = paddedBytesPerRow / 4;
  const out = new Float32Array(new ArrayBuffer(paddedFloatsPerRow * h * 4));
  if (w === 0 || h === 0) return out;

  const floatsPerRow = w * channels;
  for (let row = 0; row < h; row++) {
    out.set(
      tight.subarray(row * floatsPerRow, (row + 1) * floatsPerRow),
      row * paddedFloatsPerRow,
    );
  }
  return out;
}
