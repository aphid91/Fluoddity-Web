/**
 * First-run GPU calibration: walk `PROGRESSION` until the machine says no.
 *
 * A new visitor otherwise lands on `worldSize: 1.0, physicsSteps: 30` -- 600k
 * particles and 90 GPU passes per frame -- whatever their hardware is. On a
 * discrete GPU that is fine; on an integrated laptop GPU it is a slideshow, and
 * their first impression of the app is that it is broken.
 *
 * ## The shape of the thing
 *
 * Probe each rung in ascending order, stop at the first one that misses the
 * frame budget, keep the last one that made it. No cost model, no extrapolation,
 * no arithmetic that can be subtly wrong: whatever passed IS the answer, because
 * it was measured on this machine running this simulation.
 *
 * That also makes it self-limiting in the direction that matters. A slow GPU
 * fails an early, cheap rung and never runs the expensive ones -- which is the
 * whole reason the ladder ascends. Probing at full size first to "see what it
 * can do" would hand the weakest machines the heaviest workload in the app
 * before anything was on screen.
 *
 * ## Everything here is best-effort
 *
 * Calibration is a convenience, and it runs on the startup path. Nothing in it
 * may take the app down, and nothing in it may hang the app either. Hence the
 * try/catch around the whole walk, the wall-clock ceiling, and the cancellation
 * check between rungs. If any of those fire, whatever passed so far is
 * committed and the app carries on -- the same fail-soft posture `main.ts`
 * takes with a bad share link.
 */

import { PROGRESSION, budgetMs, type Rung } from './progression.ts';

/**
 * The Orchestrator surface calibration uses. Three methods, named structurally
 * rather than by importing the class: this module has no business reaching any
 * further into it, and a narrow interface is what lets the ladder be tested
 * against a fake with no GPU in sight.
 */
export interface CalibrationTarget {
  calibrateTo(worldSize: number, physicsSteps: number): Promise<void>;
  probeFrame(): Promise<void>;
  commitCalibration(worldSize: number, physicsSteps: number): void;
}

export interface CalibrationOptions {
  /** Progress, as `(rungIndex, total)`, before each rung is probed. */
  readonly onProgress?: (done: number, total: number) => void;
  /**
   * Asked between rungs; true abandons the walk and commits what passed.
   *
   * The splash dismissing is what this is for. Someone who clicks through after
   * two rungs has told us they want to use the app, and continuing to rebuild
   * the simulation underneath them for another five rungs is worse than
   * stopping early with a conservative answer.
   */
  readonly cancelled?: () => boolean;
  /** Injected for tests. Defaults to `performance.now`. */
  readonly now?: () => number;
}

/**
 * Probes per rung. Three, reduced by a median, because one scheduling hiccup --
 * a GC pause, another tab waking up -- should not be able to fail a rung the
 * machine can comfortably hold. Three is the smallest count that has a middle.
 */
const SAMPLES = 3;

/**
 * Discarded frames after each settings change.
 *
 * The first frame at a new size pays for things that happen exactly once:
 * pipeline warm-up, first-touch allocation of the freshly built entity buffer,
 * and `ensureUniformCapacity` growing the uniform buffers when the physics rate
 * rises (`particleSystem.ts:1159-1175`). Timing those would charge a rung for
 * work the steady state never repeats, and would fail rungs that are actually
 * affordable.
 */
const WARMUP = 2;

/**
 * Wall-clock ceiling for the whole walk.
 *
 * The budget bounds a single frame, not the sum of them, and on a very slow
 * machine even passing rungs are slow -- 21 probes plus rebuilds could stretch
 * well past what anyone should wait behind a splash. This bounds the total.
 * Checked between rungs rather than mid-rung so a rung is never half-measured.
 */
const CEILING_MS = 3000;

/**
 * Walk the progression and commit the heaviest rung that held the budget.
 *
 * Returns the chosen rung, for logging and tests. Never throws.
 */
export async function calibrate(
  target: CalibrationTarget,
  opts: CalibrationOptions = {},
): Promise<Rung> {
  const now = opts.now ?? ((): number => performance.now());
  const started = now();
  const total = PROGRESSION.length;

  // The floor, accepted without being probed: there is nothing lighter to fall
  // back to, so measuring it could only tell us something we cannot act on.
  let best: Rung = PROGRESSION[0]!;

  try {
    for (let i = 1; i < total; i++) {
      if (opts.cancelled?.() === true) break;
      if (now() - started > CEILING_MS) break;

      const rung = PROGRESSION[i]!;
      opts.onProgress?.(i, total - 1);

      await target.calibrateTo(rung.worldSize, rung.physicsSteps);
      for (let w = 0; w < WARMUP; w++) await target.probeFrame();

      const samples: number[] = [];
      for (let s = 0; s < SAMPLES; s++) {
        const t0 = now();
        await target.probeFrame();
        samples.push(now() - t0);
      }

      if (median(samples) > budgetMs()) break;
      best = rung;
    }
  } catch (err: unknown) {
    // A probe that threw tells us nothing about the rung, so the last rung that
    // actually passed stands. Warn rather than surface it: there is nothing
    // here a user could act on, and the app is fine.
    console.warn(`Calibration stopped early: ${String(err)}`);
  }

  // ALWAYS commits, including on the catch path and including when the walk was
  // cancelled. The alternative is leaving `calibrated` false, which re-runs the
  // whole thing on the next load -- so a machine that cannot finish calibration
  // would pay for it on every single visit, forever.
  target.commitCalibration(best.worldSize, best.physicsSteps);
  return best;
}

/** Middle value of a copy. `samples` is 3 long, so sorting cost is irrelevant. */
function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
