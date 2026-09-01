/**
 * State identity for the archive: a content hash over what the GPU actually sees.
 *
 * ## Why a hash at all
 *
 * `Project` is compared by REFERENCE everywhere else in the app --
 * `recordHistory`'s guard is `before !== this.project`, and `project.ts` is built
 * to keep that meaningful. Reference identity is exactly the wrong instrument
 * here: the archive spans sessions, and reloading the same preset tomorrow
 * produces a different object for the same state. "Have I been here before" is a
 * question about CONTENT, so the archive keys every node on one.
 *
 * ## What is hashed, and what is deliberately not
 *
 * The hash covers `{configs, world}` -- precisely the physics-bearing halves of
 * a `SavedConfig` (`persistence.ts`). Three things are excluded and each for its
 * own reason:
 *
 *   name      no physics kernel impact. Two projects differing only in name are
 *             the same state, so a rename produces no node and no edge. That is
 *             the intended reading of "we only care about project changes".
 *   selected  EDITOR state, not project state: it says which config the panel is
 *             pointing at, not what the particles do. `project.ts` keeps it on
 *             `Project` because the two must travel together through save/load,
 *             not because it is part of the simulation.
 *   notes     never reaches the GPU.
 *
 * **Excluding `selected` has one consequence the delta layer must pay for**: an
 * edit is applied to `project.selected`, so a delta that does not name its config
 * index cannot be replayed. See `delta.ts`, which records the index explicitly.
 *
 * ## Why the PACKED bytes and not the JavaScript numbers
 *
 * A `SimulationConfig` holds float64s; the simulation runs on float32. Two states
 * that differ in the 40th bit of a mantissa are the SAME state as far as every
 * particle on screen is concerned, and hashing the doubles would file them as
 * two nodes -- inventing exploration that never happened, in a dataset whose
 * entire purpose is to measure exploration.
 *
 * So the canonical form is the bytes `pack.ts` uploads: `writeConfigRecord`
 * rounds to nearest-even into a `Float32Array`, which is the same rounding
 * `np.float32` assignment does and is checked against a desktop-produced golden
 * in `pack.test.ts`. Reusing it rather than re-deriving a canonical form means
 * the archive cannot disagree with the GPU about what a state IS -- and it
 * cannot drift, because there is no second copy of the packing rules.
 *
 * The int lanes come along for free: `writeConfigRecord` writes `cohorts`,
 * `initialConditions` and the three booleans through an `Int32Array` view over
 * the same buffer, so they are bit-exact rather than float-approximated.
 *
 * ## The world record is packed by hand here, and that is not duplication
 *
 * `packWorldConfig` takes a `WorldConfig` -- `WorldSettings` PLUS `sqrtWorldSize`
 * and `configCount`, which are properties of the running system rather than of
 * the project (`config.ts` says so explicitly). Feeding it those would make the
 * hash depend on the user's world-size preference, so the same project would
 * hash differently on two machines and a `worldSize` change would forge a new
 * node for a project that did not change. The three `WorldSettings` fields are
 * therefore written directly, in lane order, with the runtime pair omitted.
 *
 * ## The algorithm
 *
 * FNV-1a over the bytes, 128 bits as four interleaved 32-bit lanes. Not a
 * cryptographic hash: this guards against accidental collision in a personal
 * dataset, not against an adversary, and `crypto.subtle.digest` is async -- which
 * would put an `await` on the record path, where the whole point is to add
 * nothing to a frame. 128 bits puts the collision probability for a million
 * states around 10^-27.
 *
 * Pure and synchronous, so it is testable under `node --test` with no DOM.
 */

import type { SimulationConfig, WorldSettings } from '../particleSystem/config.ts';
import { CONFIG_DATA_STRIDE, writeConfigRecord } from '../particleSystem/pack.ts';
import { WORLD_LANE } from '../particleSystem/config.ts';

/** The physics-bearing halves of a project. What identity is computed over. */
export interface HashableState {
  readonly configs: readonly SimulationConfig[];
  readonly world: WorldSettings;
}

/**
 * Bytes for the world half: the three saved settings, in lane order.
 *
 * Deliberately NOT `packWorldConfig` -- see the header. 32 bytes, matching
 * `WORLD_DATA_SIZE`, with the runtime lanes left at the zero an `ArrayBuffer` is
 * born with.
 */
function packWorldSettings(world: WorldSettings): ArrayBuffer {
  const buffer = new ArrayBuffer(32);
  const f32 = new Float32Array(buffer);
  const i32 = new Int32Array(buffer);
  f32[WORLD_LANE.trail + 0] = world.trailPersistence;
  f32[WORLD_LANE.trail + 1] = world.trailDiffusion;
  // trail.z (sqrtWorldSize) and trail.w (configCount) are RUNTIME sizing and are
  // left zero on purpose. See the header.
  i32[WORLD_LANE.bounds + 0] = world.boundaryConditions;
  return buffer;
}

/** FNV-1a 32-bit offset basis, four lanes seeded to stay independent. */
const FNV_OFFSETS = [0x811c9dc5, 0x01000193, 0x811c9dc5 ^ 0x5bf03635, 0x9e3779b9] as const;
const FNV_PRIME = 0x01000193;

/**
 * 128-bit FNV-1a over `bytes`, as 32 lowercase hex characters.
 *
 * Four lanes advanced in step, each consuming the stream at a different offset
 * so they cannot degenerate into four copies of one hash. `Math.imul` is what
 * makes the multiply wrap as a u32 rather than losing precision at 2^53.
 */
function fnv1a128(chunks: readonly ArrayBuffer[]): string {
  const lanes = new Int32Array(FNV_OFFSETS);

  for (const chunk of chunks) {
    const bytes = new Uint8Array(chunk);
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i]!;
      for (let lane = 0; lane < 4; lane++) {
        // Rotating which lane sees which byte first keeps the four independent.
        lanes[lane] = Math.imul(lanes[lane]! ^ (byte + lane), FNV_PRIME);
      }
    }
    // Length-terminate each chunk, so [A, B] and [AB] cannot hash alike -- the
    // configs are variable in number and a boundary must be part of the message.
    for (let lane = 0; lane < 4; lane++) {
      lanes[lane] = Math.imul(lanes[lane]! ^ bytes.length, FNV_PRIME);
    }
  }

  let out = '';
  for (let lane = 0; lane < 4; lane++) {
    out += (lanes[lane]! >>> 0).toString(16).padStart(8, '0');
  }
  return out;
}

/**
 * The archive's identity for a project state.
 *
 * Two states share a hash exactly when the bytes the GPU would receive for their
 * configs and world settings are identical. Throws only if a config's rule is not
 * 80 floats, which `writeConfigRecord` rejects and which is a bug upstream rather
 * than a state worth filing.
 */
export function hashState(state: HashableState): string {
  const configBytes = new ArrayBuffer(state.configs.length * CONFIG_DATA_STRIDE);
  for (let i = 0; i < state.configs.length; i++) {
    writeConfigRecord(state.configs[i]!, configBytes, i * CONFIG_DATA_STRIDE);
  }
  return fnv1a128([configBytes, packWorldSettings(state.world)]);
}
