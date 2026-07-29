"""How big the simulation is: entity count and canvas resolution.

WHY THIS IS ITS OWN MODULE
It is a leaf. It imports nothing but `math`, holds no state, and touches no GPU
resource -- so anything may import it without dragging the simulation in behind
it. `strafe_field` is the reason it exists: it needs `canvas_dimensions` to
shape its own texture, and importing that from `particle_system.particle_system`
pulled ParticleSystem, moderngl, persistence, and `layout.py`'s parse of
common.glsl into the import graph of a module that wanted one function of
arithmetic.

See ARCHITECTURE.md rule 1: modules never reference each other's *stateful*
classes, but `particle_system`'s leaf modules (`coords`, `config`, `sizing`) are
sanctioned pure/value imports.

WHY IT IS NOT IN shared/
`shared/` is for infrastructure with no domain meaning. This is domain code --
it encodes how big this particular simulation is and how it scales -- so it
belongs to `particle_system` even though it is safe for others to read.
"""

from __future__ import annotations

import math

#: The two numbers that define the simulation's scale, named once. Everything
#: else about sizing is derived from them by sizing_for().
#:
#: Density: entities per world unit of area. Resolution: the canvas edge at
#: world size 1. They are a matched pair -- 600k particles over a 1024x1024
#: canvas is the density the defaults are tuned around, so moving one without
#: the other changes how the whole simulation reads.
ENTITIES_PER_WORLD_UNIT = 600_000
BASE_CANVAS_DIM = 1024

#: Canvas aspect (width:height). 1.0 is square. Changing this changes the SHAPE
#: of the simulated world -- world space is area-preserving, so the canvas keeps
#: roughly the same pixel count and the same particle density; it just gets
#: wider and shorter. This is independent of the window: resizing the window
#: letterboxes, it does not reshape the world.
CANVAS_ASPECT = 1.


def sizing_for(world_size):
    """(entity_count, canvas_dim) for a world size.

    World size scales particle count and canvas resolution together, so
    density stays constant as the world grows -- the same simulation, larger.
    Canvas dim goes as the square root because world size is an AREA and dim is
    an edge.
    """
    return (max(1, int(ENTITIES_PER_WORLD_UNIT * world_size)),
            max(16, int(BASE_CANVAS_DIM * math.sqrt(world_size))))


#: Sizing for a world size of 1 -- what a ParticleSystem built without explicit
#: sizing gets. Derived through sizing_for so the default and the scaled case
#: can never disagree.
ENTITY_COUNT, CANVAS_DIM = sizing_for(1.0)


def canvas_dimensions(aspect=CANVAS_ASPECT, dim=None):
    """Canvas (width, height) for an aspect, preserving total pixel count.

    Area-preserving to match world space: dim*dim pixels regardless of shape,
    so changing aspect does not silently change simulation cost or the
    effective resolution of the trails.

    `dim` defaults to CANVAS_DIM (world size 1); it is resolved at call time
    rather than bound as a default argument so the two stay in step.
    """
    if dim is None:
        dim = CANVAS_DIM
    s = math.sqrt(aspect)
    return (max(1, int(round(dim * s))), max(1, int(round(dim / s))))
