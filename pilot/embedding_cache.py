"""Per-image embedding cache, shared by the search and the viewer.

THE PROBLEM THIS SOLVES. Embedding is the expensive part of everything here:
~90 seconds for a 4,000-capture folder. A search pays it once per generation as
it goes; the viewer then paid it *again* for the whole folder, for images the
search had already embedded minutes earlier. Same files, same model, same
settings, twice.

KEYED PER FILE, not per folder. The obvious design -- one key over the sorted
file list -- is worse than useless for a running search: appending 36 captures
invalidates the whole thing, so every generation would re-embed everything
before it. Here each image is its own entry, so a generation adds 36 and reuses
the rest.

STORED LOSSLESSLY, as (crops, dim) per image. The search scores on per-crop
vectors and the viewer wants them collapsed; storing the collapsed form would
force the search to score on pre-aggregated data, which silently changes what
aggregate='max' means -- "the best matching crop" quietly becomes "the average
crop". Collapsing on read is a mean over a small axis and costs nothing.

MULTIPLE SIGNATURES COEXIST. The key includes the backend signature (model,
crops, grayscale), so flipping grayscale to compare does not discard the other
set. Two full copies is the price; re-embedding 4,000 images each way is the
alternative.
"""

from __future__ import annotations

import threading
from pathlib import Path

import numpy as np

#: One cache file per folder of images.
CACHE_NAME = '.embeddings.npz'

#: Entries added since the last write, before one is forced. A search appends
#: ~36 per generation and a viewer load adds thousands; rewriting a 4,000-entry
#: archive on every single addition would cost more than the embedding saved.
FLUSH_EVERY = 64


def file_key(path, signature):
    """Identity of an embedding: which file, which settings.

    Size and mtime rather than a content hash -- hashing thousands of images
    costs more than it saves, and captures are written once.

    NANOSECOND mtime. A search rewrites a folder in well under a second, so a
    file replaced by another of the same size would keep its key at
    whole-second resolution and be served vectors for an image that no longer
    exists.
    """
    stat = Path(path).stat()
    return f"{Path(path).name}|{stat.st_size}|{stat.st_mtime_ns}|{signature}"


class EmbeddingCache:
    """Embeddings for one folder, keyed per image.

    Thread-safe: the GUI can run a search on a background thread while the
    viewer reads on the main one, and both touch this.
    """

    def __init__(self, folder):
        self.folder = Path(folder)
        self.path = self.folder / CACHE_NAME
        self._entries = {}
        self._dirty = 0
        self._lock = threading.Lock()
        self._load()

    def _load(self):
        if not self.path.is_file():
            return
        try:
            with np.load(self.path, allow_pickle=False) as data:
                self._entries = {k: data[k] for k in data.files}
        except (OSError, ValueError, EOFError):
            # Corrupt or half-written: regenerable by definition, and a
            # traceback here would block a run for no reason.
            self._entries = {}

    def get(self, path, signature):
        """The (crops, dim) vectors for `path`, or None."""
        with self._lock:
            return self._entries.get(file_key(path, signature))

    def put(self, path, signature, vectors):
        """Store one image's vectors. Flushes periodically, not per call."""
        with self._lock:
            self._entries[file_key(path, signature)] = np.asarray(
                vectors, dtype=np.float32)
            self._dirty += 1
            should_flush = self._dirty >= FLUSH_EVERY
        if should_flush:
            self.flush()

    def lookup(self, paths, signature):
        """Split `paths` into (hits, misses).

        `hits` maps path -> vectors, so the caller can embed only the misses
        and reassemble in the original order.
        """
        hits, misses = {}, []
        with self._lock:
            for path in paths:
                found = self._entries.get(file_key(path, signature))
                if found is None:
                    misses.append(path)
                else:
                    hits[str(path)] = found
        return hits, misses

    def flush(self):
        """Write the cache out. Safe to call any time; a no-op when clean."""
        with self._lock:
            if not self._dirty:
                return self.path
            entries = dict(self._entries)
            self._dirty = 0
        try:
            self.folder.mkdir(parents=True, exist_ok=True)
            # Uncompressed: these are dense float32 blocks that compress
            # poorly, and a 4,000-entry save is noticeably slower with it on.
            np.savez(self.path, **entries)
        except (OSError, ValueError) as e:
            print(f"  could not write embedding cache ({e})")
        return self.path

    # ------------------------------------------------------------------

    def __len__(self):
        with self._lock:
            return len(self._entries)

    @property
    def size_bytes(self):
        return self.path.stat().st_size if self.path.is_file() else 0

    def signatures(self):
        """Which backend settings this folder has been embedded with."""
        with self._lock:
            return sorted({k.rsplit('|', 1)[-1] for k in self._entries})

    def clear(self, signature=None):
        """Drop everything, or just one signature's entries."""
        with self._lock:
            if signature is None:
                self._entries = {}
            else:
                self._entries = {k: v for k, v in self._entries.items()
                                 if not k.endswith('|' + signature)}
            self._dirty = 1
        return self.flush()


def embed_cached(paths, backend, cache, aggregate=None, progress=None,
                 chunk=256):
    """Embed `paths`, using and filling `cache`. Returns (N, C, D).

    THE ONE ENTRY POINT both the search and the viewer use, so neither can
    accidentally embed without contributing to the cache the other reads.

    `aggregate` collapses the crop axis on the way out when given -- the
    viewer wants (N, D). The CACHE always holds the uncollapsed form, so
    changing the aggregation costs nothing.
    """
    from . import embedding

    paths = [Path(p) for p in paths]
    if not paths:
        return np.zeros((0, 1, 1), dtype=np.float32)

    signature = backend.signature()
    hits, misses = cache.lookup(paths, signature)

    if misses and progress:
        progress(f"  embedding {len(misses)} new "
                 f"({len(hits)} from cache)")
    elif progress:
        progress(f"  {len(hits)} embeddings from cache")

    # Chunked so a folder of thousands does not hold every decoded image in
    # memory at once, and so a long embed writes cache entries as it goes
    # rather than losing them all if it is interrupted.
    for start in range(0, len(misses), chunk):
        batch = misses[start:start + chunk]
        vectors = embedding.embed_paths(backend, batch)
        for path, value in zip(batch, vectors):
            cache.put(path, signature, value)
            hits[str(path)] = value
        if progress and len(misses) > chunk:
            progress(f"    {min(start + chunk, len(misses))}/{len(misses)}")
    cache.flush()

    stacked = np.stack([hits[str(p)] for p in paths]).astype(np.float32)
    if aggregate is not None:
        return embedding.aggregate(stacked, aggregate)
    return stacked
