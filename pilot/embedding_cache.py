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
from dataclasses import dataclass
from pathlib import Path

import numpy as np

#: One cache file per folder of images.
CACHE_NAME = '.embeddings.npz'

#: Entries added since the last write, before one is forced. A search appends
#: ~36 per generation and a viewer load adds thousands; rewriting a 4,000-entry
#: archive on every single addition would cost more than the embedding saved.
FLUSH_EVERY = 64


@dataclass(frozen=True)
class SignatureInfo:
    """One embedding set in an archive: what it is, and how much of it there is.

    COVERAGE IS AN INTERSECTION, not a row count. The key carries size and
    mtime, so a rewritten image leaves its old row behind and a set can hold
    far more rows than the folder has images -- measured at exactly 2x on a
    real B32 set. `entries` is what is stored, `covered` is what is usable,
    and only the second one answers "can I load this".
    """

    signature: str
    #: Raw rows under this signature, stale ones included.
    entries: int
    #: Distinct filenames, however many rows each has.
    cached: int
    #: Filenames that are cached AND still on disk. The real number.
    covered: int
    #: Images in the folder. 0 when the inventory was taken without a scan.
    total: int
    #: Rows beyond one per covered image: unreachable rows AND redundant
    #: duplicates, which are different problems with the same symptom. A file
    #: rewritten outside the mtime slack orphans its old row; one rewritten
    #: INSIDE the slack leaves a second row that is still reachable but will
    #: never be read, since the first match wins. `prune` drops the first kind
    #: and `compact` the second.
    stale: int
    settings: 'VisionSettings | None'
    label: str

    @property
    def complete(self):
        return self.total > 0 and self.covered >= self.total

    @property
    def partial(self):
        return 0 < self.covered < self.total

    @property
    def missing(self):
        return max(0, self.total - self.covered)


#: Divisor taking st_mtime_ns down to whole seconds. See file_key.
_MTIME_SCALE = 1_000_000_000

#: How far two mtimes may differ and still mean the same file, in seconds.
#: FAT and SMB keep mtimes to 2-second granularity, so a copy can land a
#: whole second either side of the original. MEASURED: of 25,100 captures
#: moved once, 12,583 came back exactly +1s and not one moved further.
_MTIME_SLACK = 2


def file_key(path, signature):
    """Identity of an embedding: which file, which settings.

    Size and mtime rather than a content hash -- hashing thousands of images
    costs more than it saves, and captures are written once.

    THE MTIME IS IN WHOLE SECONDS, and is matched with slack rather than for
    equality -- see `entry_of`. It was nanoseconds, on the reasoning that a
    search rewrites a folder in well under a second and a same-sized
    replacement would otherwise keep its key. True, and it cost an entire
    archive: sub-second precision does not survive a copy, a sync or a zip.
    MEASURED on a real folder -- all 25,100 captures came back with
    `st_mtime_ns % 1e9 == 0`, and half of them a further second off besides,
    because FAT/SMB timestamps land on 2-second boundaries. All 84,261 cached
    vectors became unreachable at once, and the only symptom was "embedding
    25,100 new" on a folder embedded the day before.

    Written to the key so the archive stays a flat npz of arrays with no
    sidecar metadata, and read back out by `_parse_key` for the comparison.
    """
    stat = Path(path).stat()
    return (f"{Path(path).name}|{stat.st_size}"
            f"|{stat.st_mtime_ns // _MTIME_SCALE}|{signature}")


def _parse_key(key):
    """(name, size, mtime, signature) from a key. mtime is None if absent."""
    parts = key.split('|', 3)
    if len(parts) != 4:
        return None
    name, size, mtime, signature = parts
    return name, size, (int(mtime) if mtime.isdigit() else None), signature


def mtime_matches(stored, current):
    """Whether two whole-second mtimes describe the same unmodified file.

    Within _MTIME_SLACK, because a copy moves them by up to a second either
    way. The gap this leaves -- the same file rewritten to the same byte
    count inside two seconds -- is far narrower than the one it closes, and
    the size check still catches every rewrite that changes the content
    length.
    """
    if stored is None or current is None:
        return True
    return abs(stored - current) <= _MTIME_SLACK


def normalize_key(key):
    """An old nanosecond-mtime key with its mtime in whole seconds.

    Archives written before the change hold nanosecond keys, and re-embedding
    them is the exact cost this avoids -- so they are converted on read.
    A key already in seconds passes through unchanged, which makes this safe
    to apply to every key without knowing which era wrote it.
    """
    parts = key.split('|', 3)
    if len(parts) != 4:
        return key
    name, size, mtime, signature = parts
    if mtime.isdigit() and len(mtime) > 10:
        mtime = str(int(mtime) // _MTIME_SCALE)
    return f"{name}|{size}|{mtime}|{signature}"


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
        #: (name, size, signature) -> [(mtime, key)]; see _index. Dropped
        #: whenever _entries changes rather than kept in step, since a load or
        #: a bulk delete rebuilds it far more cheaply than maintaining it.
        self._by_identity = None
        self._lock = threading.Lock()
        self._load()

    def _load(self):
        if not self.path.is_file():
            return
        try:
            with np.load(self.path, allow_pickle=False) as data:
                # Normalized on the way in, so the rest of this module only
                # ever sees one key format and an archive written before the
                # whole-second change stays readable. Collisions collapse to
                # the last writer, which for two rows of one image under one
                # signature is the newer embedding either way.
                self._entries = {normalize_key(k): data[k] for k in data.files}
                self._by_identity = None
        except (OSError, ValueError, EOFError):
            # Corrupt or half-written: regenerable by definition, and a
            # traceback here would block a run for no reason.
            self._entries = {}

    def _index(self):
        """(name, size, signature) -> [(mtime, key)], built lazily.

        The exact key is the fast path and stays a plain dict hit; this is
        only consulted when that misses, which is when an mtime has drifted.
        """
        if self._by_identity is None:
            index = {}
            for key in self._entries:
                parsed = _parse_key(key)
                if parsed is None:
                    continue
                name, size, mtime, signature = parsed
                index.setdefault((name, size, signature), []).append(
                    (mtime, key))
            self._by_identity = index
        return self._by_identity

    def _entry_of(self, path, signature):
        """Vectors for `path` under `signature`, tolerating a shifted mtime.

        Exact hit first. Failing that, look for the same name, size and
        signature whose mtime is within the copy slack -- which is what makes
        a folder that has been moved between filesystems load instead of
        silently re-embedding.
        """
        found = self._entries.get(file_key(path, signature))
        if found is not None:
            return found
        stat = Path(path).stat()
        identity = (Path(path).name, str(stat.st_size), signature)
        current = stat.st_mtime_ns // _MTIME_SCALE
        for mtime, key in self._index().get(identity, ()):
            if mtime_matches(mtime, current):
                return self._entries.get(key)
        return None

    def get(self, path, signature):
        """The (crops, dim) vectors for `path`, or None."""
        with self._lock:
            return self._entry_of(path, signature)

    def put(self, path, signature, vectors):
        """Store one image's vectors. Flushes periodically, not per call."""
        with self._lock:
            self._entries[file_key(path, signature)] = np.asarray(
                vectors, dtype=np.float32)
            self._by_identity = None
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
                found = self._entry_of(path, signature)
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

    def _grouped(self):
        """signature -> {filename -> entry count}, in one pass.

        The one place a key is taken apart. Both halves matter and they are
        at opposite ends: the signature is everything after the LAST '|', the
        filename everything before the FIRST -- size and mtime sit between and
        are what make two rows for one image possible.
        """
        groups = {}
        with self._lock:
            for key in self._entries:
                parsed = _parse_key(key)
                if parsed is None:
                    continue
                name, size, mtime, signature = parsed
                rows = groups.setdefault(signature, {})
                rows.setdefault((name, size), []).append(mtime)
        return groups

    def signatures(self):
        """Which backend settings this folder has been embedded with."""
        return sorted(self._grouped())

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
        counts = {found: sum(len(mtimes) for mtimes in rows.values())
                  for found, rows in self._grouped().items()
                  if found != signature}
        return sorted(((s, n) for s, n in counts.items() if n >= minimum),
                      key=lambda pair: -pair[1])

    def inventory(self, paths=None):
        """Every signature here, as SignatureInfo, most-covered first.

        WHAT THE PICKER IS BUILT ON. Without this the only way to address a
        set is to make a config match its key exactly, and a near-miss is
        indistinguishable from a cold cache -- which is how a folder with
        25,100 usable embeddings starts a multi-hour re-embed.

        `paths` is the images actually on disk. Given, coverage is real; left
        out, only the counts are filled in, so a caller with no folder scan
        (a CLI listing, a test) still gets something useful.
        """
        # (name, size) -> mtimes on disk, so coverage uses the same tolerant
        # comparison a lookup does. Counting distinct filenames instead would
        # call a set "complete" that every actual load then misses.
        on_disk = None
        if paths is not None:
            on_disk = {}
            for path in paths:
                path = Path(path)
                if path.is_file():
                    stat = path.stat()
                    on_disk.setdefault(
                        (path.name, str(stat.st_size)), []).append(
                            stat.st_mtime_ns // _MTIME_SCALE)
        total = len(on_disk) if on_disk is not None else 0

        found = []
        for signature, rows in self._grouped().items():
            entries = sum(len(mtimes) for mtimes in rows.values())
            covered = 0
            if on_disk is not None:
                covered = sum(
                    1 for identity, mtimes in rows.items()
                    if any(mtime_matches(m, current)
                           for m in mtimes
                           for current in on_disk.get(identity, ())))
            found.append(SignatureInfo(
                signature=signature, entries=entries, cached=len(rows),
                covered=covered, total=total, stale=entries - covered,
                settings=parse_signature(signature),
                label=label_signature(signature)))
        return sorted(found, key=lambda info: (-info.covered, -info.entries))

    def prune(self, paths):
        """Drop entries for files no longer on disk under that key. Returns how many.

        WHY A SEPARATE ACTION FROM clear(). A signature can be complete and
        still carry dead rows: the key holds size and mtime, so rewriting a
        capture leaves the old row unreachable forever. Measured on a real
        folder -- a B32 set of 50,200 rows over 25,100 images, every one
        duplicated, about a third of a 1.07GB archive.

        NEVER CALLED AUTOMATICALLY. Silently deleting cached vectors is the
        failure this module exists to prevent; this is a button, not a policy.
        """
        # Compare on the identity part -- name|size|mtime -- rather than the
        # whole key, so each file is stat'd ONCE rather than once per
        # signature. On the measured archive that is 25,100 stats instead of
        # 100,400 for the same answer.
        # Keyed by (name, size) to the mtimes on disk, so each file is stat'd
        # ONCE rather than once per signature. On the measured archive that is
        # 25,100 stats instead of 100,400 for the same answer.
        live = {}
        for path in paths:
            path = Path(path)
            if path.is_file():
                stat = path.stat()
                live.setdefault((path.name, str(stat.st_size)), []).append(
                    stat.st_mtime_ns // _MTIME_SCALE)

        def reachable(key):
            parsed = _parse_key(key)
            if parsed is None:
                return True             # not ours to judge; keep it
            name, size, mtime, _signature = parsed
            return any(mtime_matches(mtime, current)
                       for current in live.get((name, size), ()))

        with self._lock:
            before = len(self._entries)
            self._entries = {k: v for k, v in self._entries.items()
                             if reachable(k)}
            dropped = before - len(self._entries)
            self._by_identity = None
            self._dirty += dropped
        if dropped:
            self.flush()
        return dropped

    def compact(self):
        """Drop rows that duplicate another row for the same image. Returns how many.

        WHY THIS IS NOT prune(). A row is unreachable when no file on disk
        matches it, and prune drops those. But a file rewritten INSIDE the
        mtime slack -- or embedded once before a copy and once after, one
        second apart -- leaves two rows that both match. Both are reachable,
        so prune keeps them; only the first is ever read, so the second is
        pure weight. Measured on a real archive: 12,583 such pairs, a third of
        a gigabyte, and prune correctly reported nothing to do.

        Keeps the row with the LATEST mtime, which is the most recent
        embedding of that image.
        """
        with self._lock:
            best = {}
            for key in self._entries:
                parsed = _parse_key(key)
                if parsed is None:
                    continue
                name, size, mtime, signature = parsed
                identity = (name, size, signature)
                current = best.get(identity)
                if current is None or (mtime or 0) > (current[0] or 0):
                    best[identity] = (mtime, key)
            keep = {key for _mtime, key in best.values()}
            # Rows this cannot parse are kept: they are not ours to judge, and
            # discarding what we do not understand is how a cache loses data.
            keep |= {k for k in self._entries if _parse_key(k) is None}
            dropped = len(self._entries) - len(keep)
            if dropped:
                self._entries = {k: v for k, v in self._entries.items()
                                 if k in keep}
                self._by_identity = None
                self._dirty += dropped
        if dropped:
            self.flush()
        return dropped

    def clear(self, signature=None):
        """Drop everything, or just one signature's entries."""
        with self._lock:
            if signature is None:
                self._entries = {}
            else:
                self._entries = {k: v for k, v in self._entries.items()
                                 if not k.endswith('|' + signature)}
            self._by_identity = None
            self._dirty = 1
        return self.flush()


#: How a signature field maps to the config key that produced it. Signatures
#: are positional -- 'clip:ARCH:TAG:cN:fN:sN[:gray]' -- so a field is named by
#: its prefix rather than its index, and ':gray' is a flag whose ABSENCE is the
#: other value.
_FIELD_NAMES = (('c', 'crops'), ('f', 'crop_frac'), ('s', 'seed'))

#: How a signature field parses back. Same order and prefixes as _FIELD_NAMES,
#: with the type each value is written as -- so decoding stays the exact
#: inverse of the encoding rather than a second, drifting spelling of it.
_FIELD_TYPES = {'c': ('crops', int), 'f': ('crop_frac', float),
                's': ('seed', int)}


@dataclass(frozen=True)
class VisionSettings:
    """The cache-key half of a config, decoded from a signature.

    WHY THIS EXISTS. A signature is the only durable record of how a set of
    embeddings was made -- the config that produced them may have been edited
    a dozen times since. Decoding it back into config fields is what lets the
    viewer say "load THAT set" and have the settings follow the choice, rather
    than making the reader retype six values until the key matches.
    """

    backend: str
    #: Short key ('B32'), or '' when the architecture is not one of ours --
    #: a set embedded by a newer version still lists, it just cannot be adopted.
    clip_model: str = ''
    crops: int = 1
    crop_frac: float = 0.3
    seed: int = 0
    grayscale: bool = False
    #: The raw open_clip pair, kept so an unrecognised model round-trips.
    architecture: str = ''
    pretrained: str = ''

    def as_config_fields(self):
        """The SearchConfig kwargs this set was embedded with.

        Only the fields that are part of the cache key: adopting a set must
        not disturb captions, or the beam, or anything else the reader has set.
        """
        fields = {'backend': self.backend, 'crops': self.crops,
                  'crop_frac': self.crop_frac, 'seed': self.seed,
                  'grayscale': self.grayscale}
        if self.clip_model:
            fields['clip_model'] = self.clip_model
        return fields


def parse_signature(signature):
    """A signature decoded into VisionSettings, or None if it is not ours.

    None rather than an exception: an archive can hold a signature written by
    a newer version, and a picker that crashes on one unfamiliar row is worse
    than one that shows it raw and refuses to adopt it.
    """
    from . import clip_models

    if not signature:
        return None
    grayscale = signature.endswith(':gray')
    parts = (signature[:-5] if grayscale else signature).split(':')
    if parts[0] != 'clip' or len(parts) < 3:
        # The texture backend has its own shape and no adoptable settings.
        return None

    architecture, pretrained = parts[1], parts[2]
    values = {}
    for field in parts[3:]:
        for prefix, (name, cast) in _FIELD_TYPES.items():
            if field.startswith(prefix):
                try:
                    values[name] = cast(field[len(prefix):])
                except ValueError:
                    return None
                break
    return VisionSettings(
        backend='clip',
        clip_model=clip_models.normalize(architecture) or '',
        grayscale=grayscale, architecture=architecture, pretrained=pretrained,
        **values)


def signature_for(settings):
    """The signature `settings` would embed under. Inverse of parse_signature.

    MUST AGREE EXACTLY with ClipBackend.signature(), which is the encoder --
    two functions spelling one string is a real drift risk, so a test asserts
    they agree rather than trusting that they look alike.

    The point is to answer "does this set already exist?" WITHOUT constructing
    a backend, since constructing one is the multi-gigabyte model load the
    whole picker exists to avoid.
    """
    return (f"clip:{settings.architecture}:{settings.pretrained}"
            f":c{settings.crops}:f{settings.crop_frac}:s{settings.seed}"
            f"{':gray' if settings.grayscale else ''}")


def label_signature(signature):
    """A signature as a menu row: 'SO400M, 4 crops @0.40, seed 0, grayscale'.

    Falls back to the raw signature when it does not decode, so an unknown set
    is still selectable-looking rather than blank.
    """
    settings = parse_signature(signature)
    if settings is None:
        return signature
    model = settings.clip_model or settings.architecture
    return (f"{model}, {settings.crops} crops @{settings.crop_frac:.2f}, "
            f"seed {settings.seed}"
            f"{', grayscale' if settings.grayscale else ''}")


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
