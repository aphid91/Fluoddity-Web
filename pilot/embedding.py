"""Turning captures into vectors, in batches.

REUSES demos/tex_sim.py RATHER THAN REIMPLEMENTING IT. That module is a working,
debugged implementation of both backends, and its hard-won details -- the crop
sampling that makes CLIP describe texture instead of composition, the
Euler-characteristic curve that separates spots from labyrinths, the float32
discipline -- are exactly the things a "clean rewrite" would quietly get wrong.
This module imports it and adds only what a search needs that a CLI did not.

BATCHED ON PURPOSE. At world_size 0.1 a candidate is ~0.3s of simulation, so the
embedding is the expensive half of a generation. Embedding thirty-six captures
in one call amortizes model load and lets the backend batch its forward pass;
embedding them one at a time as they are produced does neither.

tex_sim.py's own disk cache is deliberately NOT used. It keys on
(path, size, mtime) to avoid re-embedding a stable corpus, which is the right
call for a CLI pointed at a photo library and the wrong one here: every capture
is written once, embedded once, and never seen again, so the cache would grow
without ever hitting.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

_DEMOS = Path(__file__).resolve().parent.parent / 'demos'
if str(_DEMOS) not in sys.path:
    sys.path.insert(0, str(_DEMOS))

import tex_sim                                                      # noqa: E402


def check_dependencies(backend_name):
    """What is missing for `backend_name`, as install advice. Empty if ready.

    Checked BEFORE a run touches the app, because the alternative is finding
    out inside the first embedding call -- after a generation of simulation has
    already been paid for, and with a traceback pointing into tex_sim rather
    than at the thing to install.
    """
    problems = []
    if backend_name == 'texture':
        try:
            import scipy.ndimage                                # noqa: F401
        except ImportError:
            problems.append(
                "the texture backend needs scipy (for the Euler-characteristic "
                "curve): pip install scipy")
    elif backend_name == 'clip':
        try:
            import torch                                        # noqa: F401
        except ImportError:
            problems.append("the clip backend needs torch: pip install torch")
        try:
            import open_clip                                    # noqa: F401
        except ImportError:
            try:
                import transformers                             # noqa: F401
            except ImportError:
                problems.append(
                    "the clip backend needs open_clip_torch (or transformers "
                    "as a fallback): pip install open_clip_torch")
    return problems


def build_backend(cfg):
    """The backend a run's config asks for.

    'texture' is the default and needs nothing installed: it is a hand-built
    descriptor (radial and angular FFT power, an Euler-characteristic curve,
    an intensity histogram) that is interpretable and, for Turing-like
    patterns, arguably a better match than a semantic model. 'clip' needs torch
    and a model download but understands text.
    """
    if cfg.backend == 'clip':
        return tex_sim.ClipBackend(crops=cfg.crops, crop_frac=cfg.crop_frac,
                                   seed=cfg.seed, grayscale=cfg.grayscale)
    if cfg.backend == 'texture':
        # Always grayscale: TextureBackend works from luminance alone
        # (_load_gray converts to "L"), so cfg.grayscale is already satisfied
        # here and there is nothing to pass.
        return tex_sim.TextureBackend()
    raise ValueError(f"unknown backend {cfg.backend!r}")


def embed_paths(backend, paths):
    """Embed image files. Returns (N, C, D), L2-normalized rows.

    C is the number of views per image -- 1 for the texture backend, `crops`
    for CLIP. Kept rather than collapsed here because the aggregation is a
    scoring decision (mean, max or top-k over crops), and flattening early
    would take that choice away.
    """
    paths = [Path(p) for p in paths]
    if not paths:
        return np.zeros((0, 1, 1), dtype=np.float32)
    missing = [p for p in paths if not p.is_file()]
    if missing:
        raise FileNotFoundError(
            f"{len(missing)} capture(s) missing, first: {missing[0]}")
    return backend.embed_images(paths)


def embed_texts(backend, texts):
    """Embed text. CLIP only -- the texture backend has no text side."""
    if not getattr(backend, 'supports_text', False):
        raise ValueError(
            f"the {backend.name} backend cannot embed text; use backend='clip'")
    return backend.embed_texts(texts)


def aggregate(embeddings, mode='mean'):
    """(N, C, D) -> (N, D), L2-normalized. Collapses the crop axis."""
    if embeddings.shape[0] == 0:
        return embeddings.reshape(0, embeddings.shape[-1])
    return tex_sim.aggregate(embeddings, mode)


def similarity(embeddings, query, mode='mean'):
    """Cosine similarity of each image against one query vector.

    `embeddings` is (N, C, D) and `query` is (D,). The crop aggregation happens
    HERE rather than before, so 'max' can mean "the single best-matching crop"
    -- a genuinely different question from "the average crop", and the more
    useful one when a pattern only occupies part of the frame.
    """
    if embeddings.shape[0] == 0:
        return np.zeros(0, dtype=np.float32)
    return tex_sim.score_against(embeddings, query, mode)
