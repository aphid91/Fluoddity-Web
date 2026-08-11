"""A folder of captures, embedded and cached: what the UMAP viewer plots.

Deliberately separate from the viewer. Everything here is pure -- walk a
folder, embed it, enrich it from a manifest if one happens to be there -- so it
can be tested without a window, and so a future tool that wants "the embeddings
for this folder" does not have to open one.

THE CACHE IS THE POINT. Embedding 4,000 captures takes over a minute even on a
GPU, and the whole appeal of the viewer is re-opening a folder to look again,
or re-projecting the same embeddings with different UMAP settings. Both would
be intolerable if they re-embedded. The cache is keyed by backend signature AND
by file identity, so changing the backend, the crop count or the grayscale flag
produces a different cache rather than silently reusing vectors that mean
something else.

A MANIFEST IS OPTIONAL. Point this at a run's captures/ folder and it will
find the scores and lineage beside it; point it at any other folder of images
and it works with less to say in the tooltip. Requiring a manifest would make
the tool useless for the reference folders and hand-assembled collections it is
just as good at.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import embedding

#: What counts as an image worth plotting.
IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.bmp', '.webp'}

#: Cache filename inside the folder. Hidden-ish, and named for what it is so a
#: user who finds it knows it is regenerable.
CACHE_NAME = '.umap_cache.npz'


@dataclass
class Item:
    """One image in the gallery, plus whatever the manifest knew about it."""

    path: Path
    #: Index into the embedding matrix.
    index: int
    score: float | None = None
    generation: int | None = None
    origin: str = ''
    parent_id: str = ''
    config_path: str = ''

    @property
    def name(self):
        return self.path.stem

    def tooltip_lines(self):
        """What to show on hover. Only what is actually known."""
        lines = [self.name]
        if self.score is not None:
            lines.append(f"score {self.score:+.4f}")
        if self.generation is not None:
            detail = f"gen {self.generation}"
            if self.origin:
                detail += f"  {self.origin}"
            lines.append(detail)
        if self.parent_id:
            lines.append(f"parent {self.parent_id}")
        return lines


@dataclass
class Gallery:
    """Images, their embeddings, and their metadata."""

    items: list = field(default_factory=list)
    #: (N, D) after crop aggregation -- one vector per image, L2-normalized.
    embeddings: np.ndarray = None
    signature: str = ''
    root: Path = None

    def __len__(self):
        return len(self.items)

    @property
    def scores(self):
        """(N,) scores, NaN where unknown. NaN rather than 0 so the viewer can
        tell "no score" from "scored zero" -- cosine scores are signed."""
        return np.array([np.nan if i.score is None else i.score
                         for i in self.items], dtype=np.float32)

    @property
    def has_scores(self):
        return any(i.score is not None for i in self.items)


def find_images(folder, recursive=True):
    """Images in `folder`, sorted.

    Sorted so an index means the same thing between runs -- the cache is
    positional, and an unsorted directory listing would silently permute it.
    """
    root = Path(folder)
    if not root.is_dir():
        raise NotADirectoryError(f"not a folder: {root}")
    walk = root.rglob('*') if recursive else root.glob('*')
    return sorted(p for p in walk if p.suffix.lower() in IMAGE_EXTS)


def find_manifest(folder):
    """A manifest describing `folder`, if one is nearby.

    Looks in the folder and one level up, because the natural thing to open is
    a run's captures/ directory while the manifest sits beside it in the run
    root.
    """
    root = Path(folder)
    for candidate in (root / 'manifest.jsonl',
                      root.parent / 'manifest.jsonl'):
        if candidate.is_file():
            return candidate
    return None


def read_manifest(path):
    """id -> row, keeping the LAST row for each id.

    Last wins for the same reason the report dedupes that way: in folders
    written before ids carried a session tag, several rows can share an id and
    only the final one describes the file actually on disk.
    """
    rows = {}
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue                    # torn final line; the report warns
        if 'id' in row:
            rows[row['id']] = row
    return rows


def _file_key(path):
    """Identity of a file for cache purposes: size and modification time.

    Content hashing would be more correct and far slower on thousands of
    images, so this trusts the filesystem's metadata.

    NANOSECOND mtime, not whole seconds. A second's resolution is enough for
    the photo library tex_sim was written for, and not enough here: a search
    rewrites a folder of captures in well under a second, so a file replaced
    by another of the same size would keep its key and be served stale vectors
    -- silently, since the count and shape would still line up.
    """
    stat = path.stat()
    return f"{stat.st_size}:{stat.st_mtime_ns}"


def _cache_key(paths, signature):
    """One string standing for "these files, embedded this way"."""
    parts = [signature, str(len(paths))]
    parts.extend(f"{p.name}|{_file_key(p)}" for p in paths)
    return '\n'.join(parts)


def load_cache(folder, key):
    """Cached embeddings for `key`, or None."""
    path = Path(folder) / CACHE_NAME
    if not path.is_file():
        return None
    try:
        with np.load(path, allow_pickle=False) as data:
            if str(data['key']) != key:
                return None
            return data['embeddings']
    except (OSError, KeyError, ValueError):
        # A corrupt or older-format cache is not worth a traceback; it is
        # regenerable by definition.
        return None


def save_cache(folder, key, embeddings):
    path = Path(folder) / CACHE_NAME
    try:
        np.savez_compressed(path, key=np.array(key), embeddings=embeddings)
    except OSError as e:
        print(f"  could not write cache ({e}); continuing without it")
    return path


def build(folder, cfg, recursive=True, refresh=False, progress=print):
    """Embed a folder, using the cache when it applies.

    `cfg` is a SearchConfig -- reused rather than inventing a second way to
    say "clip, 6 crops, grayscale", so a viewer and a search that share a
    config are looking at the same vectors.
    """
    root = Path(folder)
    paths = find_images(root, recursive=recursive)
    if not paths:
        raise FileNotFoundError(f"no images in {root}")

    backend = embedding.build_backend(cfg)
    signature = backend.signature()
    key = _cache_key(paths, signature)

    vectors = None if refresh else load_cache(root, key)
    if vectors is not None:
        progress(f"  {len(paths)} images, embeddings from cache")
    else:
        progress(f"  embedding {len(paths)} image(s) [{signature}]")
        raw = embedding.embed_paths(backend, paths)
        # Collapse crops here: the viewer wants one point per image, and
        # caching the aggregated form keeps the file small.
        vectors = embedding.aggregate(raw, cfg.aggregate)
        save_cache(root, key, vectors)
        progress(f"  cached to {root / CACHE_NAME}")

    items = [Item(path=p, index=i) for i, p in enumerate(paths)]
    _enrich(items, root, progress)
    return Gallery(items=items, embeddings=vectors, signature=signature,
                   root=root)


def score_caption(gallery, caption, backend, calibrate=True, aggregate='mean'):
    """Score every image in the gallery against one caption.

    FOR CHOOSING CAPTIONS, not for running a search. The whole point is that
    the embeddings are already computed and cached, so trying a caption costs
    a single text encode -- milliseconds -- against the minutes it would take
    to discover the same thing by running a search and looking at the results.

    Especially useful for finding NEGATIVE captions: colour the map by "a
    dense field of small dots", see which cluster lights up, and you have
    both confirmed the failure mode and named it well enough to subtract.

    Returns (N,) scores, calibrated the same way PromptScorer calibrates so
    the numbers here mean what they will mean in a run.
    """
    from .scoring import PromptScorer

    scorer = PromptScorer(backend, caption, aggregate=aggregate,
                          calibrate=calibrate)
    # PromptScorer expects (N, C, D); the gallery stores crops already
    # collapsed, so present them as a single view.
    vectors = gallery.embeddings.reshape(len(gallery), 1, -1)
    return scorer.score(vectors)


def _enrich(items, root, progress=print):
    """Attach manifest metadata to items whose name matches a candidate id."""
    manifest = find_manifest(root)
    if manifest is None:
        return
    rows = read_manifest(manifest)
    matched = 0
    for item in items:
        row = rows.get(item.name)
        if row is None:
            continue
        matched += 1
        item.score = row.get('score')
        item.generation = row.get('generation')
        item.origin = row.get('origin') or ''
        item.parent_id = row.get('parent_id') or ''
        item.config_path = row.get('config_path') or ''
    if matched:
        progress(f"  matched {matched}/{len(items)} to {manifest.name}")
