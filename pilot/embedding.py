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

from . import clip_models

_DEMOS = Path(__file__).resolve().parent.parent / 'demos'
if str(_DEMOS) not in sys.path:
    sys.path.insert(0, str(_DEMOS))

import tex_sim                                                      # noqa: E402


def prefer_cached_models():
    """Load CLIP weights from the local cache without phoning home.

    WHY. open_clip resolves its checkpoints through huggingface_hub, which on
    every load makes an unauthenticated HEAD request to see whether the cached
    file is stale -- and prints

        WARNING ... You are sending unauthenticated requests to the HF Hub.
        Please set a HF_TOKEN to enable higher rate limits ...

    every time. Nothing is downloading; the weights have been cached since the
    first run. But the check is a real network round trip on a path that does
    not need one: these checkpoints are immutable release artifacts, so a
    revalidation can only ever confirm what is already on disk. It also makes
    a cold start slower than it needs to be and fails outright with no network.

    HF_HUB_OFFLINE tells the hub to serve from cache and skip the request. The
    tradeoff is that a model NOT yet cached can no longer be fetched, which is
    why this is not set blindly -- build_backend clears it for a first download
    and restores it afterwards.

    NEVER OVERRIDES AN EXISTING SETTING. If the environment already says
    something about offline mode, that is a deliberate choice and this defers
    to it. Returns whether it changed anything, so the caller can put it back.

    SETS THE ENV VAR *AND* THE LIBRARY CONSTANT. huggingface_hub evaluates
    HF_HUB_OFFLINE once, at import, into huggingface_hub.constants -- so the
    environment variable alone only works when it is set before the first
    import, and unsetting it later does nothing at all. Measured: a fallback
    that only popped the env var still failed offline. Both are written here,
    and set_offline() below is the matching undo.
    """
    import os

    if os.environ.get('HF_HUB_OFFLINE') is not None:
        return False
    os.environ['HF_HUB_OFFLINE'] = '1'
    _set_hub_offline(True)
    return True


def _set_hub_offline(offline):
    """Tell huggingface_hub to work from cache, or not.

    Best-effort: the constant is an implementation detail of a third-party
    library and could move. If it does, the env var still covers the common
    case (set before import) and the worst outcome is the warning coming back
    -- so a missing attribute is not worth failing a run over.
    """
    import os

    if offline:
        os.environ['HF_HUB_OFFLINE'] = '1'
    else:
        os.environ.pop('HF_HUB_OFFLINE', None)
    try:
        import huggingface_hub.constants as constants
        constants.HF_HUB_OFFLINE = bool(offline)
    except (ImportError, AttributeError):
        pass


def check_dependencies(backend_name, clip_model=None):
    """What is missing for `backend_name`, as install advice. Empty if ready.

    Checked BEFORE a run touches the app, because the alternative is finding
    out inside the first embedding call -- after a generation of simulation has
    already been paid for, and with a traceback pointing into tex_sim rather
    than at the thing to install.

    `clip_model` is optional so existing callers that only care about the
    backend keep working; pass it to also check what that particular model
    needs on top of torch and open_clip.
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
            problems.append(
                "the clip backend needs torch. Install it from the CUDA index, "
                "not PyPI, or you will get the CPU-only wheel:\n"
                "    pip install torch torchvision --index-url "
                "https://download.pytorch.org/whl/cu128")
        try:
            import open_clip                                    # noqa: F401
        except ImportError:
            try:
                import transformers                             # noqa: F401
            except ImportError:
                problems.append(
                    "the clip backend needs open_clip_torch (or transformers "
                    "as a fallback): pip install open_clip_torch")
        # Per-MODEL requirements on top of the backend's. SigLIP needs a
        # tokenizer open_clip loads through transformers, and finding that out
        # after the download is the failure this prevents.
        if clip_model is not None:
            problems.extend(clip_models.missing_requirements(clip_model))
    return problems


def _load_preferring_cache(backend):
    """Load the model offline if possible, falling back to a download.

    OFFLINE FIRST, ONLINE ON FAILURE, rather than deciding up front whether the
    weights are cached. Working that out honestly would mean reproducing
    huggingface_hub's cache layout and its notion of which files a given
    checkpoint needs -- a copy of someone else's internals that would rot, and
    would be wrong in exactly the case that matters (a half-finished download).
    Asking the hub to serve from cache and catching the refusal delegates the
    question to the code that owns the answer.

    The retry is not a silent fallback: a first download of SO400M is 3.5GB and
    several minutes, so it says so rather than appearing to hang.
    """
    changed = prefer_cached_models()
    try:
        backend._load()
        return
    except Exception:                                           # noqa: BLE001
        if not changed:
            # The offline setting was the caller's, not ours. Respect it and
            # let the real failure surface.
            raise
        _set_hub_offline(False)
        print("  not in the local cache -- downloading (this is a one-time "
              "cost; later runs load from cache and stay offline)")
    try:
        backend._load()
    finally:
        # Back to cache-first for any later load in this process. The download
        # has populated the cache, so the next model does not need the network
        # and should not go looking for it.
        _set_hub_offline(True)


def build_backend(cfg):
    """The backend a run's config asks for.

    'texture' is the default and needs nothing installed: it is a hand-built
    descriptor (radial and angular FFT power, an Euler-characteristic curve,
    an intensity histogram) that is interpretable and, for Turing-like
    patterns, arguably a better match than a semantic model. 'clip' needs torch
    and a model download but understands text.
    """
    if cfg.backend == 'clip':
        # Resolved from the config's short name ('L14') to the architecture and
        # checkpoint pair open_clip wants. get() raises on an unknown name,
        # which validate() will normally have caught first -- this is the
        # backstop for a SearchConfig built in code rather than loaded.
        model = clip_models.get(cfg.clip_model)
        # BEFORE the download, and as a clear error rather than tex_sim's.
        # open_clip builds a SigLIP model happily and only then reaches its
        # tokenizer, so the natural failure is minutes and gigabytes late and
        # says "install open_clip_torch" -- which is already installed.
        missing = clip_models.missing_requirements(model.key)
        if missing:
            raise SystemExit(missing[0])
        backend = tex_sim.ClipBackend(model_name=model.architecture,
                                      pretrained=model.pretrained,
                                      crops=cfg.crops, crop_frac=cfg.crop_frac,
                                      seed=cfg.seed, grayscale=cfg.grayscale)
        # Load now and report the device. A CPU-only torch install is the
        # commonest way to end up with a search that works but is ~30x slower
        # than it should be, and nothing else about the run would say so --
        # `pip install torch` gives the CPU wheel unless the CUDA index URL is
        # passed. Loading here also means a broken install fails before the
        # app is driven rather than after the first generation.
        #
        # It is also where a first-time model download happens, which for
        # SO400M is 3.5GB -- so say which model is being loaded BEFORE the
        # call, or a several-minute silence looks like a hang.
        print(f"  CLIP model {clip_models.describe(cfg.clip_model)}")
        _load_preferring_cache(backend)
        if backend._device == 'cpu':
            print("  WARNING: CLIP is running on the CPU. For GPU, see "
                  "requirements.txt -- torch must come from the CUDA index.")
        else:
            print(f"  CLIP on {backend._device}")
        return backend
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
