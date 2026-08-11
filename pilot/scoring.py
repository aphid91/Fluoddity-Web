"""What the search is trying to maximize.

ONE INTERFACE, ONE SHIPPING IMPLEMENTATION. `Scorer.score()` takes a
generation's embeddings and returns one number per candidate, higher is better.
That is the entire contract, and it is small on purpose: the objective is the
part of a search most likely to be replaced, and everything downstream should
be indifferent to which one is installed.

ReferenceImageScorer ships. It answers "how much does this look like the images
I already like", which needs no prompt engineering, works with the torch-free
texture backend, and gives an objective that can be inspected by looking at the
reference folder.

PromptScorer and NoveltyScorer are stubs with their design recorded. They are
not built because building an objective before knowing whether the simple one
tracks taste is the wrong order -- see the milestone in docs/SEARCH.md.
"""

from __future__ import annotations

from pathlib import Path
from typing import Protocol

import numpy as np

from . import embedding

#: Extensions find_references will pick up.
IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.bmp', '.webp'}


class Scorer(Protocol):
    """Turns a generation's embeddings into one number per candidate."""

    def score(self, embeddings: np.ndarray) -> np.ndarray:
        """(N, C, D) -> (N,), higher is better."""
        ...


def find_references(folder):
    """Reference images, sorted so a run is reproducible.

    Sorted because the query is their mean: floating-point addition is not
    associative, so an unsorted directory listing would give a subtly different
    query vector on a different filesystem.
    """
    root = Path(folder)
    if not root.is_dir():
        raise FileNotFoundError(f"reference folder not found: {root}")
    paths = sorted(p for p in root.rglob('*')
                   if p.suffix.lower() in IMAGE_EXTS)
    if not paths:
        raise FileNotFoundError(f"no images in {root}")
    return paths


class ReferenceImageScorer:
    """Score by similarity to a folder of images the user likes.

    The query is the MEAN of the reference embeddings, renormalized -- the
    centroid of "things I want". A single reference works too; with several,
    the centroid describes what they have in common, which is usually the
    property worth searching for rather than any one image.

    A caveat worth stating: the centroid of a diverse reference set can land
    somewhere resembling none of them. If a run's results look like nothing in
    the folder, the folder is probably describing two different things and
    wants splitting into two runs.
    """

    def __init__(self, backend, reference_paths, aggregate='mean'):
        self.backend = backend
        self.reference_paths = list(reference_paths)
        self.aggregate = aggregate

        references = embedding.embed_paths(backend, self.reference_paths)
        # Collapse crops first, then average across images: every reference
        # gets one vote regardless of how many crops it contributed.
        per_image = embedding.aggregate(references, 'mean')
        query = per_image.mean(0)
        norm = np.linalg.norm(query)
        if norm < 1e-8:
            raise ValueError(
                "reference embeddings cancelled out to a zero vector; the "
                "folder probably contains opposing content")
        self.query = query / norm

    def score(self, embeddings):
        return embedding.similarity(embeddings, self.query, self.aggregate)

    def describe(self):
        # Colour handling is reported because it is invisible in the output and
        # changes what the run optimizes for -- see SearchConfig.grayscale.
        if getattr(self.backend, 'name', '') == 'texture':
            colour = 'grayscale (texture backend is always luminance)'
        else:
            colour = ('grayscale' if getattr(self.backend, 'grayscale', False)
                      else 'colour')
        return (f"reference-image ({len(self.reference_paths)} images, "
                f"agg={self.aggregate}, {colour})")


class ConstantScorer:
    """Every candidate scores the same. For tests and for smoke runs.

    Useful precisely because it removes the objective from the picture: a run
    with this installed exercises the whole loop -- moves, captures, manifest,
    resumability -- without depending on an embedding backend being present or
    a reference folder being any good.
    """

    def __init__(self, value=0.0):
        self.value = float(value)

    def score(self, embeddings):
        return np.full(embeddings.shape[0], self.value, dtype=np.float32)

    def describe(self):
        return f"constant ({self.value})"


def build_scorer(cfg, backend):
    """The scorer a run's config asks for."""
    if cfg.reference_dir:
        return ReferenceImageScorer(backend, find_references(cfg.reference_dir),
                                    aggregate=cfg.aggregate)
    return ConstantScorer()


# ---------------------------------------------------------------------------
# Designed, not built. Each records what it would take, so the next
# conversation starts from a decision rather than a blank page.
# ---------------------------------------------------------------------------

class PromptScorer:
    """Score against a text prompt. CLIP only. NOT IMPLEMENTED.

    The work is not `embed_texts` -- that is one line. It is calibration.
    Raw CLIP cosines live in a narrow band and are dominated by properties of
    the caption rather than of the image, so ranking by them mostly ranks the
    prompt against itself. demos/tex_sim.py's cmd_rank already solves this: it
    scores against 30 BACKGROUND_CAPTIONS and reports a robust z,

        med = median(bgs); mad = median(|bgs - med|) * 1.4826
        z = (s - med) / max(mad, 0.01)

    printing "rank by z, not raw cosine". Any implementation here must do the
    same, reusing tex_sim.BACKGROUND_CAPTIONS rather than inventing a second
    calibration set.

    Also unresolved: whether CLIP's semantic space says anything useful about
    abstract texture. Worth measuring against ReferenceImageScorer on the same
    captures before trusting a search to it.
    """

    def __init__(self, *args, **kwargs):
        raise NotImplementedError(
            "PromptScorer is designed but not built -- see its docstring, and "
            "use reference_dir with backend='clip' for a semantic objective")


class NoveltyScorer:
    """Score by distance from what has already been seen. NOT IMPLEMENTED.

    Would keep an archive of past embeddings and score each candidate by its
    mean distance to its k nearest archived neighbours -- the standard novelty
    search formulation. Maps the space instead of climbing toward a target,
    which is what you want when building a library rather than hunting.

    Fits the existing interfaces without changing them: the archive lives in
    the scorer, and BeamSearch's `observe` already sees every evaluated
    candidate. The one real design question is whether the archive holds every
    candidate or only the survivors -- the first grows without bound over a
    long run, the second biases novelty toward what the beam already liked.

    Quality-diversity (keep the best candidate in each region of a behaviour
    space, rather than the best overall) would be a SearchStrategy rather than
    a Scorer -- it changes what survives, not how a candidate is valued.
    """

    def __init__(self, *args, **kwargs):
        raise NotImplementedError(
            "NoveltyScorer is designed but not built -- see its docstring")
