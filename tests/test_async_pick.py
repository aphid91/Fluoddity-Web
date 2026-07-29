"""The async pick agrees with the blocking one.

WHY THIS TEST EXISTS
D2 moved click-selection off pick_blocking() -- which stalls the GPU and has no
WebGPU equivalent -- onto the two-phase request/retrieve path. The two must
choose the SAME entity for the same target, or selection silently changes
meaning. pick_blocking() survives precisely so this comparison is possible.

Runs headless (moderngl standalone context), so it needs a GPU but no window.

    Scratch.venv/Scripts/python.exe tests/test_async_pick.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import moderngl

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from particle_system.particle_system import ParticleSystem  # noqa: E402
from particle_system.picker import DEFAULT_PICK_RADIUS_PX  # noqa: E402

#: Small world: this tests agreement between two code paths, not scale.
ENTITY_COUNT = 20_000
CANVAS = (256, 256)

#: World-space radius, matching what a click uses at a default view: the
#: on-screen DEFAULT_PICK_RADIUS_PX converted through the transform. Hardcoded
#: rather than computed so this test needs no camera.
RADIUS = 0.08

#: Sampled from where the particles actually ARE (see _sample_targets), plus
#: two fixed extremes: dead centre, and a point far outside the world so the
#: MISS path is covered too. Aiming at fixed pretty coordinates instead made
#: six of seven targets miss, which proved almost nothing.
FIXED_TARGETS = [(0.0, 0.0), (50.0, 50.0)]


def _sample_targets(system, count=10):
    """Positions of `count` real entities, spread through the buffer.

    Aiming AT particles is what makes the comparison meaningful: a target that
    hits nothing has both paths agreeing on MISS, which would pass even if the
    reduction were broken.
    """
    import numpy as np

    from particle_system.layout import ENTITY_DTYPE

    stride = max(1, system.entity_count // count)
    targets = []
    for i in range(0, system.entity_count, stride):
        raw = system.entity_buffer.read(size=ENTITY_DTYPE.itemsize,
                                        offset=i * ENTITY_DTYPE.itemsize)
        rec = np.frombuffer(raw, dtype=ENTITY_DTYPE)[0]
        targets.append((float(rec['pos_vel'][0]), float(rec['pos_vel'][1])))
        if len(targets) == count:
            break
    return targets


def main() -> int:
    ctx = moderngl.create_standalone_context(require=430)
    repo = Path(__file__).resolve().parent.parent
    config = sorted((repo / 'configs').glob('*.json'))[0]
    system = ParticleSystem(ctx, canvas_size=CANVAS, config_path=config,
                            entity_count=ENTITY_COUNT)

    # Let the simulation run a little, so entities are at non-initial positions
    # and the buffer holds something a pick has to actually search.
    for _ in range(30):
        system.advance(None, None)

    targets = _sample_targets(system) + FIXED_TARGETS

    failures = 0
    for target in targets:
        blocking = system.pick_blocking(target, RADIUS)

        # The async path, as the frame loop drives it: request on one frame,
        # retrieve on the next. ctx.finish() here stands in for the frame
        # boundary -- the app gets the same guarantee from a whole frame of
        # other work happening in between.
        system.request_pick(target, RADIUS)
        ctx.finish()
        deferred = system.retrieve_pick()

        same = (blocking.index == deferred.index
                and blocking.hit == deferred.hit)
        if not same:
            failures += 1
        print(f"  target=({target[0]:+.3f},{target[1]:+.3f})  "
              f"blocking=#{blocking.index:<8} async=#{deferred.index:<8} "
              f"{'OK' if same else 'MISMATCH'}")

    # A run where every target missed would pass vacuously.
    hits = sum(1 for t in targets if system.pick_blocking(t, RADIUS).hit)
    print(f"\n{hits}/{len(targets)} targets hit a particle")
    if hits < len(targets) // 2:
        print("FAIL: too few targets hit -- the comparison proved little")
        return 1

    if failures:
        print(f"FAIL: {failures} target(s) disagreed")
        return 1
    print("PASS: async and blocking picks agree on every target")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
