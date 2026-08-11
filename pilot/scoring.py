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
from .embedding import tex_sim

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
    """The scorer a run's config asks for.

    A caption wins over a reference folder if both are set -- validate()
    refuses that combination, so reaching here with both means someone
    constructed a SearchConfig directly.
    """
    if cfg.captions:
        return PromptScorer(backend, cfg.captions,
                            negative_captions=cfg.negative_captions,
                            aggregate=cfg.aggregate,
                            calibrate=cfg.calibrate,
                            caption_aggregate=cfg.caption_aggregate)
    if cfg.reference_dir:
        return ReferenceImageScorer(backend, find_references(cfg.reference_dir),
                                    aggregate=cfg.aggregate)
    return ConstantScorer()


# ---------------------------------------------------------------------------
# Designed, not built. Each records what it would take, so the next
# conversation starts from a decision rather than a blank page.
# ---------------------------------------------------------------------------

class PromptScorer:
    """Score against a text prompt. CLIP only.

    WHY RAW COSINES WILL NOT DO. CLIP image-text similarities live in a narrow
    band -- measured on real captures, four visually distinct images scored
    0.2173 / 0.2123 / 0.1971 / 0.1962 against the same caption, a spread of two
    percent. Most of that number describes the CAPTION (its length, its
    phrasing, how typical it is) rather than the image, so ranking on it is
    largely ranking the prompt against itself.

    THE FIX, from demos/tex_sim.py's cmd_rank: score each image against a set
    of generic BACKGROUND CAPTIONS too, and report how far the real caption
    stands out from that background, per image:

        med   = median(background scores for this image)
        mad   = median(|background - med|) * 1.4826      robust sigma
        z     = (score - med) / max(mad, 0.01)

    The median and MAD are per-IMAGE, which is the part that matters: an image
    that scores highly against everything (a busy frame) has a high median and
    is not rewarded for it, while an image that matches the caption and nothing
    else scores a large z. Robust statistics rather than mean/std because a
    couple of background captions genuinely matching an image should not drag
    the reference point.

    WHAT IS DIFFERENT HERE FROM THE CLI. tex_sim ranks one fixed dataset once.
    A search scores a new generation every few seconds and must compare
    candidates ACROSS generations -- the beam holds survivors from any of them.
    So the background embeddings are computed ONCE at construction and reused,
    making z an absolute quantity rather than one renormalized per batch. A
    per-generation renormalization would make scores incomparable between
    generations and quietly break the beam.

    `negative_captions` is the other half: things to score AGAINST. The prompt
    says what you want; negatives say what you keep getting instead. Their
    similarity is subtracted, which is the most direct way to push a search out
    of a local optimum it keeps rediscovering.
    """

    def __init__(self, backend, caption, negative_captions=(),
                 aggregate='mean', calibrate=True,
                 background_captions=None, caption_aggregate='max'):
        if not getattr(backend, 'supports_text', False):
            raise ValueError(
                f"the {getattr(backend, 'name', '?')} backend cannot embed "
                "text; prompt scoring needs backend='clip'")

        # One caption or several. CLIP is sensitive to wording, so several
        # phrasings of the same idea describe it more robustly than any one.
        captions = [caption] if isinstance(caption, str) else list(caption)
        captions = [c for c in captions if c and c.strip()]
        if not captions:
            raise ValueError("prompt scoring needs a non-empty caption")

        self.backend = backend
        self.captions = captions
        self.caption = captions[0]
        self.negative_captions = list(negative_captions)
        self.aggregate = aggregate
        self.caption_aggregate = caption_aggregate
        self.calibrate = calibrate

        self.queries = embedding.embed_texts(backend, captions)
        #: Kept for callers that want "the" query vector; with several
        #: captions the scoring below uses them all rather than this one.
        self.query = self.queries[0]

        self.negatives = (embedding.embed_texts(backend, self.negative_captions)
                          if self.negative_captions else None)

        # Embedded once, deliberately -- see the class docstring. These are the
        # fixed reference frame that makes scores comparable across
        # generations.
        self.background = None
        if calibrate:
            captions = (background_captions
                        if background_captions is not None
                        else tex_sim.BACKGROUND_CAPTIONS)
            self.background = embedding.embed_texts(backend, list(captions))

    def _reference_frame(self, embeddings):
        """Per-image (median, robust sigma) over the background captions.

        Per IMAGE, not per batch -- that is what makes a busy frame scoring
        highly against everything not count as a match, and what keeps the
        result independent of which other candidates happened to share its
        generation.
        """
        bg = np.stack(
            [embedding.similarity(embeddings, b, self.aggregate)
             for b in self.background], axis=1)                  # (N, B)
        median = np.median(bg, axis=1)
        mad = np.median(np.abs(bg - median[:, None]), axis=1) * 1.4826
        # The floor stops z exploding when an image's background scores
        # collapse to near-identical values.
        return median, np.maximum(mad, 0.01)

    def _combine(self, per_caption):
        """(N, K) similarities against K captions -> (N,).

        'max' by default: a candidate matching ANY of the phrasings scores
        well, which is what a set of alternative descriptions of one thing
        means. 'mean' asks it to match all of them at once -- and the centroid
        of several captions can sit somewhere resembling none of them.
        """
        if per_caption.shape[1] == 1:
            return per_caption[:, 0]
        if self.caption_aggregate == 'mean':
            return per_caption.mean(axis=1)
        if self.caption_aggregate == 'topk':
            k = max(1, per_caption.shape[1] // 3)
            return np.sort(per_caption, axis=1)[:, -k:].mean(axis=1)
        return per_caption.max(axis=1)

    def score(self, embeddings):
        if embeddings.shape[0] == 0:
            return np.zeros(0, dtype=np.float32)

        # Calibrate EACH caption before combining. A raw cosine and a z-score
        # differ by an order of magnitude, and captions differ from each other
        # in how high they score generally -- so taking a max over raw
        # similarities would mostly pick whichever caption happens to run hot,
        # not whichever the image actually matches.
        per_caption = np.stack(
            [embedding.similarity(embeddings, q, self.aggregate)
             for q in self.queries], axis=1)                    # (N, K)

        if self.background is not None:
            median, sigma = self._reference_frame(embeddings)
            per_caption = (per_caption - median[:, None]) / sigma[:, None]
        else:
            median = sigma = None

        scores = self._combine(per_caption)

        if self.negatives is not None:
            against = np.stack(
                [embedding.similarity(embeddings, n, self.aggregate)
                 for n in self.negatives], axis=1)               # (N, K)
            if median is not None:
                # Calibrated on the SAME reference frame as the positive, so
                # the subtraction is between comparable quantities: a raw
                # cosine and a z-score differ by an order of magnitude, and
                # mixing them would make the penalty either negligible or
                # total.
                against = (against - median[:, None]) / sigma[:, None]
            # The worst offender decides. Averaging would let a candidate that
            # strongly matches one negative hide behind the others.
            scores = scores - against.max(axis=1)

        return scores.astype(np.float32)

    def describe(self):
        colour = ('grayscale' if getattr(self.backend, 'grayscale', False)
                  else 'colour')
        if len(self.captions) == 1:
            head = f'prompt "{self.caption}"'
        else:
            head = (f'{len(self.captions)} prompts '
                    f'({self.caption_aggregate}) "{self.caption}", ...')
        parts = ['calibrated' if self.calibrate else 'RAW COSINE (uncalibrated)',
                 f'agg={self.aggregate}', colour]
        if self.negative_captions:
            parts.append(f"{len(self.negative_captions)} negative(s)")
        return f"{head} ({', '.join(parts)})"


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
