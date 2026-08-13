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

import os
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
        """Write the cache out. Safe to call any time; a no-op when clean.

        WRITTEN TO A TEMPORARY AND RENAMED, never over the live file. This
        archive reaches hundreds of megabytes on a real run -- measured at
        865MB for 25,100 captures -- and np.savez over the destination leaves
        it a truncated, unreadable zip for the several seconds it takes to
        write. Interrupt the process in that window (Ctrl-C, a crash, closing
        the GUI) and hours of embedding are gone, with the only trace being
        _load quietly treating the wreckage as an empty cache.

        os.replace is atomic on both POSIX and Windows, so a reader sees either
        the old archive or the new one, and an interrupted write costs a
        discarded temp file rather than the cache.
        """
        with self._lock:
            if not self._dirty:
                return self.path
            entries = dict(self._entries)
            self._dirty = 0
        temporary = None
        try:
            self.folder.mkdir(parents=True, exist_ok=True)
            # Beside the target, not in the system temp dir: os.replace is only
            # atomic within a filesystem, and the cache may well sit on a
            # different drive from %TEMP%.
            temporary = self.path.with_suffix(f'.npz.{os.getpid()}.tmp')
            # Written through an open HANDLE, not a path: np.savez appends
            # '.npz' to any filename that does not already end in it, so
            # passing this path directly produces '....tmp.npz' and the rename
            # below then fails on a file that does not exist. Measured, not
            # assumed -- the first version of this did exactly that.
            #
            # Uncompressed: these are dense float32 blocks that compress
            # poorly, and a 4,000-entry save is noticeably slower with it on.
            with open(temporary, 'wb') as handle:
                np.savez(handle, **entries)
            os.replace(temporary, self.path)
            temporary = None
        except (OSError, ValueError) as e:
            print(f"  could not write embedding cache ({e})")
        finally:
            if temporary is not None:
                # A failed write must not leave a partial file behind to be
                # mistaken for a cache or to fill the disk on the next attempt.
                try:
                    Path(temporary).unlink(missing_ok=True)
                except OSError:
                    pass
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

    def rival_signatures(self, signature, minimum=1):
        """Other signatures this folder holds, biggest first.

        WHY THIS EXISTS. The cache key is the whole backend signature, so one
        changed setting -- grayscale, crops, the model -- makes every stored
        vector unreachable and the only symptom is "embedding 25,100 new" on a
        folder that was embedded yesterday. Measured on a real 25,100-capture
        folder: a complete SO400M set was present under `...:s0:gray` while the
        config asked for `...:s0`, and nothing on screen connected the two.

        Returns [(signature, count)] so a caller can say what else is here and
        let the reader spot the one word that differs.
        """
        counts = {}
        with self._lock:
            for key in self._entries:
                found = key.rsplit('|', 1)[-1]
                if found != signature:
                    counts[found] = counts.get(found, 0) + 1
        return sorted(((s, n) for s, n in counts.items() if n >= minimum),
                      key=lambda pair: -pair[1])

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


#: How a signature field maps to the config key that produced it. Signatures
#: are positional -- 'clip:ARCH:TAG:cN:fN:sN[:gray]' -- so a field is named by
#: its prefix rather than its index, and ':gray' is a flag whose ABSENCE is the
#: other value.
_FIELD_NAMES = (('c', 'crops'), ('f', 'crop_frac'), ('s', 'seed'))


def describe_difference(have, want):
    """Which config key separates two signatures, in words. '' if unclear.

    The point is to name the fix. "have ...:s0:gray / want ...:s0" is already
    on screen by the time this is called, and a reader still has to diff two
    forty-character strings by eye to find the one token that moved -- which is
    exactly the step that makes a stale cache look like a broken one.
    """
    # Strip the trailing flag before comparing fields: it is a flag rather than
    # a 'key=value' field, so it would otherwise show up as a length mismatch
    # and defeat the positional diff below.
    have_grey, want_grey = have.endswith(':gray'), want.endswith(':gray')
    have_parts = have[:-5].split(':') if have_grey else have.split(':')
    want_parts = want[:-5].split(':') if want_grey else want.split(':')

    # BACKEND AND MODEL BEFORE GRAYSCALE, because they subsume it: a cached set
    # from a different model is not made reusable by flipping grayscale, and
    # advising that first sends the reader to change the wrong key. Measured on
    # a real cache, where a stray B32 entry sat beside the SO400M ones and was
    # reported as a grayscale difference.
    if have_parts[0] != want_parts[0]:
        return f"a different backend ({have_parts[0]} vs {want_parts[0]})"
    if len(have_parts) > 1 and len(want_parts) > 1 \
            and have_parts[1] != want_parts[1]:
        return (f"a different clip_model -- those are {have_parts[1]}, "
                f"this is {want_parts[1]}")

    if have_grey != want_grey:
        # Name the value that makes the CACHED set usable, since reusing them
        # is the reason this message exists.
        wanted = 'true' if have_grey else 'false'
        other = 'false' if have_grey else 'true'
        return (f"set grayscale: {wanted} to reuse them "
                f"(or leave it {other} and re-embed)")

    if len(have_parts) != len(want_parts):
        return ''

    differences = []
    for mine, theirs in zip(have_parts[2:], want_parts[2:]):
        if mine == theirs:
            continue
        for prefix, name in _FIELD_NAMES:
            if mine.startswith(prefix) and theirs.startswith(prefix):
                differences.append(
                    f"{name}: {mine[len(prefix):]} vs {theirs[len(prefix):]}")
                break
    if differences:
        return "differs by " + ", ".join(differences)
    return ''


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

    step = getattr(progress, 'step', None)
    if misses and progress:
        progress(f"  embedding {len(misses)} new "
                 f"({len(hits)} from cache)")
        # A big miss on a folder that is already embedded under some OTHER
        # setting is nearly always one changed key, not a cold cache. Say so:
        # without this the only signal is a long progress bar, and the fix
        # (put the setting back) is invisible.
        for other, count in cache.rival_signatures(signature)[:3]:
            if count > len(hits):
                progress(f"    NOTE {count} embeddings here under a different "
                         f"setting:")
                progress(f"      have {other}")
                progress(f"      want {signature}")
                difference = describe_difference(other, signature)
                if difference:
                    progress(f"      {difference}")
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
        done = min(start + chunk, len(misses))
        # Reported per chunk rather than per image: at 256 a chunk is a few
        # seconds, which is a fine granularity for a bar, and updating from
        # inside the batch loop would mean touching the lock thousands of
        # times for no visible difference.
        if step is not None:
            step(done, len(misses), 'images')
        if progress and len(misses) > chunk:
            progress(f"    {done}/{len(misses)}")
    if step is not None and misses:
        step(len(misses), len(misses), 'images')
    cache.flush()

    stacked = np.stack([hits[str(p)] for p in paths]).astype(np.float32)
    if aggregate is not None:
        return embedding.aggregate(stacked, aggregate)
    return stacked
