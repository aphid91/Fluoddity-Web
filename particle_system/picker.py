"""EntityPicker: find the entity nearest a world position, on the GPU.

WHY NOT A READBACK
The obvious implementation reads the entity buffer to the host and runs argmin
in numpy. The reference did exactly that: ~19 MB copied and a full pipeline
stall per click. This instead dispatches a compute shader that reduces to a
single 4-byte result.

WHY THE RESULT IS ONE FRAME OLD
Reading a GPU buffer the same frame you wrote it forces a sync point: the CPU
waits for the GPU to drain. Worse, WebGPU (the port target) has no synchronous
readback at all, so that shape would have to be rewritten rather than
translated. Instead the picker reads the PREVIOUS frame's result, which is
already complete -- no stall, and the structure ports unchanged.

The cost is one frame of latency. At 60fps that is 16ms, well below the ~100ms
where pointing feels laggy, and invisible for hover-highlighting or clicking.
Callers that must have an exactly-current answer should say so explicitly
(see `pick_blocking`), understanding it stalls and will not port.

DISTANCE IS STRAIGHT-LINE, in every boundary mode -- including wrap, where the
world really is a torus. The difference only shows for a click within a particle
radius of the seam, which is not worth teaching this shader about the world's
shape. See the note in entity_pick.glsl.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from shared.gl_utils import tryset, reload_compute
from . import coords

_SHADER_DIR = Path(__file__).parent / "shaders"

ENTITY_BUFFER_BINDING = 0
PICK_RESULT_BINDING = 2

# Must match entity_pick.glsl, which is checked by tests/test_async_pick.py.
# 24 bits of index covers 16.7M entities; the distance takes what is left,
# because tie-breaking precision does not matter here (see the shader's
# "WHERE THE 32 BITS GO").
INDEX_BITS = 24
INDEX_MASK = (1 << INDEX_BITS) - 1
DIST_BITS = 8
DIST_MAX = (1 << DIST_BITS) - 1

#: Sentinel written before each dispatch; survives if nothing is in range.
NO_HIT = 0xFFFFFFFF

#: Default search radius in screen pixels. Screen-space so the tolerance feels
#: identical at any zoom -- a world-space radius would shrink on screen as you
#: zoom out, making distant particles progressively harder to hit.
DEFAULT_PICK_RADIUS_PX = 40.0


@dataclass(frozen=True)
class PickResult:
    """Outcome of a pick. `index < 0` means nothing was in range."""

    index: int = -1
    pos: tuple[float, float] = (0.0, 0.0)
    distance: float = float('inf')

    @property
    def hit(self) -> bool:
        return self.index >= 0


#: Returned when no pick has ever been requested, or nothing was in range.
MISS = PickResult()


class EntityPicker:
    def __init__(self, ctx):
        self.ctx = ctx
        self.program = None

        # One uint. Tiny, so reading it back is cheap even though it is a
        # round trip -- the point of the deferred design is avoiding the STALL,
        # not avoiding the transfer.
        self.result_buffer = ctx.buffer(reserve=4)

        #: Whether a dispatch is in flight whose result has not been read yet.
        self._pending = False
        #: The radius used for the in-flight dispatch, needed to decode its
        #: quantized distance when the result comes back.
        self._pending_radius = 0.0

        self.reload()

    def reload(self):
        """Reload the pick shader from disk. Safe to call mid-execution."""
        self.program = reload_compute(
            self.ctx, "Entity pick shader",
            _SHADER_DIR / 'entity_pick.glsl', self.program)

    def request(self, entity_buffer, entity_count, target_world, radius_world):
        """Dispatch a pick. The result is available from `retrieve()` next frame."""
        if self.program is None:
            return

        self.result_buffer.write(np.array([NO_HIT], dtype='u4').tobytes())

        entity_buffer.bind_to_storage_buffer(ENTITY_BUFFER_BINDING)
        self.result_buffer.bind_to_storage_buffer(PICK_RESULT_BINDING)

        tryset(self.program, 'target', (float(target_world[0]), float(target_world[1])))
        tryset(self.program, 'max_dist', float(radius_world))

        self.program.run(math.ceil(entity_count / 256), 1, 1)
        self._pending = True
        self._pending_radius = radius_world

    def retrieve(self, entity_buffer=None, entity_dtype=None) -> PickResult:
        """Read the result of the most recent completed dispatch.

        Returns MISS if no pick is in flight or nothing was in range. If an
        entity buffer and dtype are supplied, the winner's world position is
        looked up from it -- the index in the key is authoritative, so this
        cannot disagree with what the shader chose.
        """
        if not self._pending:
            return MISS
        self._pending = False

        key = int(np.frombuffer(self.result_buffer.read(), dtype='u4')[0])
        if key == NO_HIT:
            return MISS

        index = key & INDEX_MASK
        dist_q = key >> INDEX_BITS
        distance = (dist_q / DIST_MAX) * self._pending_radius

        pos = (0.0, 0.0)
        if entity_buffer is not None and entity_dtype is not None:
            # Read only the winner's record rather than the whole buffer.
            offset = index * entity_dtype.itemsize
            raw = entity_buffer.read(size=entity_dtype.itemsize, offset=offset)
            record = np.frombuffer(raw, dtype=entity_dtype)[0]
            pos = (float(record['pos_vel'][0]), float(record['pos_vel'][1]))

        return PickResult(index=int(index), pos=pos, distance=distance)


def radius_px_to_world(radius_px, window_size, canvas_size, pan, zoom) -> float:
    """Convert a screen-pixel radius to world units at the current view.

    Goes through the transform rather than scaling by a fudge factor, so the
    tolerance is exactly `radius_px` on screen at any zoom, aspect or window
    shape. Because the transform is isotropic (rule 9), one radius suffices for
    both axes.
    """
    center = (window_size[0] / 2.0, window_size[1] / 2.0)
    a = coords.screen_to_world(center, window_size, canvas_size, pan, zoom)
    b = coords.screen_to_world((center[0] + radius_px, center[1]),
                               window_size, canvas_size, pan, zoom)
    return abs(b[0] - a[0])
