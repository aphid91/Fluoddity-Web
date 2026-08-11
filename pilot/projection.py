"""Embeddings -> 2D points. The UMAP half, with no GUI in it.

Kept apart from the viewer so the projection can be exercised without opening a
window, and so the viewer file stays about drawing.

WHY COSINE. The embeddings are L2-normalized, so euclidean and cosine distance
are monotonically related and UMAP would find similar structure either way --
but cosine is what the scorers use, and a layout that disagrees with the
ranking it sits beside would be quietly misleading.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

#: UMAP's own defaults, restated here so the viewer's sliders have a home and
#: so a change is visible in a diff rather than inherited silently.
DEFAULT_NEIGHBOURS = 15
DEFAULT_MIN_DIST = 0.1
#: Fixed by default: an unseeded UMAP gives a different picture every time it
#: is recomputed, which makes "did that slider do anything" unanswerable.
DEFAULT_SEED = 42


@dataclass(frozen=True)
class Projection:
    """2D coordinates, normalized to [0,1] on each axis."""

    points: np.ndarray                  # (N, 2)
    n_neighbours: int
    min_dist: float
    seed: int

    def describe(self):
        return (f"n_neighbors={self.n_neighbours}  "
                f"min_dist={self.min_dist:.3f}  seed={self.seed}")


def normalize(points):
    """Fit points into the unit square, preserving aspect.

    A PER-AXIS rescale would stretch the layout to fill the canvas and distort
    the distances UMAP just worked to produce -- two points equally far apart
    would look different distances apart depending on direction. Scaling both
    axes by the same factor keeps the shape honest and simply leaves letterbox
    space on the narrow axis.
    """
    points = np.asarray(points, dtype=np.float32)
    if len(points) == 0:
        return points.reshape(0, 2)

    low = points.min(axis=0)
    high = points.max(axis=0)
    span = float(np.max(high - low))
    if span <= 0:
        # Every point identical -- a real case with one image, or with
        # duplicates. Put them in the middle rather than dividing by zero.
        return np.full_like(points, 0.5)

    centred = points - (low + high) / 2.0
    return (centred / span + 0.5).astype(np.float32)


def project(embeddings, n_neighbours=DEFAULT_NEIGHBOURS,
            min_dist=DEFAULT_MIN_DIST, seed=DEFAULT_SEED, metric='cosine'):
    """UMAP the embeddings down to a normalized 2D layout.

    Small inputs are handled rather than crashing: UMAP needs n_neighbours
    below the sample count, and refuses to run at all on one or two points.
    Both happen when someone opens a folder to check the tool works.
    """
    vectors = np.asarray(embeddings, dtype=np.float32)
    count = len(vectors)

    if count == 0:
        return Projection(np.zeros((0, 2), np.float32), n_neighbours,
                          min_dist, seed)
    if count <= 2:
        # Nothing to project. Lay them out predictably instead of failing.
        points = np.array([[0.35, 0.5], [0.65, 0.5]][:count], np.float32)
        return Projection(points, n_neighbours, min_dist, seed)

    # UMAP requires n_neighbours < n_samples, and behaves poorly right at the
    # boundary. Clamped rather than validated because the viewer's slider
    # should not be able to produce an unrunnable state.
    effective = max(2, min(int(n_neighbours), count - 1))

    import umap                                          # noqa: PLC0415

    reducer = umap.UMAP(n_neighbors=effective, min_dist=float(min_dist),
                        metric=metric, random_state=int(seed))
    embedded = reducer.fit_transform(vectors)
    return Projection(normalize(embedded), effective, float(min_dist),
                      int(seed))


def check_dependencies():
    """What is missing to project. Empty if ready."""
    problems = []
    try:
        import umap                                      # noqa: F401,PLC0415
    except ImportError:
        problems.append("the UMAP viewer needs umap-learn: "
                        "pip install umap-learn")
    return problems
