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
from .embedding_cache import EmbeddingCache, embed_cached

#: What counts as an image worth plotting.
IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.bmp', '.webp'}


@dataclass
class Item:
    """One point in the gallery: an image, a config, or both.

    A run's candidate has a capture AND a config. A config folder browsed on
    its own has only the second -- there is no picture to embed or hover, and
    `path` is the .json itself. Everything downstream reads `has_image` rather
    than assuming.
    """

    path: Path
    #: Index into the embedding matrix.
    index: int
    score: float | None = None
    generation: int | None = None
    origin: str = ''
    parent_id: str = ''
    config_path: str = ''
    #: False for a config with no capture beside it.
    has_image: bool = True

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


    def relabel(self, score):
        """A copy carrying a different score. For re-scoring."""
        from dataclasses import replace as _replace

        return _replace(self, score=score)


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

    @property
    def has_images(self):
        """False for a config-only gallery: nothing to embed, nothing to hover.

        Read rather than assumed by everything that wants a picture -- the
        CLIP source, the caption box, the thumbnail preview.
        """
        return any(i.has_image for i in self.items)

    def apply_scores(self, by_name):
        """Replace item scores from a {name: score} mapping. Returns the count.

        THE LIVE VIEW, not the manifest. A re-score answers "what would this
        run look like under a different objective", and the manifest is the
        record of what the run ACTUALLY did -- its scores are the ones that
        drove selection, and overwriting them would destroy the only account
        of why the beam kept what it kept.

        So the plot and the cutoff follow the new scores, `report.txt` records
        them, and manifest.jsonl is left alone.
        """
        changed = 0
        for index, item in enumerate(self.items):
            if item.name in by_name:
                self.items[index] = item.relabel(float(by_name[item.name]))
                changed += 1
        return changed


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

    # THE SAME cache the search fills. A folder a search has just finished
    # writing is already embedded, so opening it is instant rather than a
    # second ninety-second pass over the same images with the same model.
    cache = EmbeddingCache(root)
    if refresh:
        cache.clear(signature)
    progress(f"  {len(paths)} images [{signature}]")
    vectors = embed_cached(paths, backend, cache, aggregate=cfg.aggregate,
                           progress=progress)

    items = [Item(path=p, index=i, has_image=True)
             for i, p in enumerate(paths)]
    _enrich(items, root, progress)
    return Gallery(items=items, embeddings=vectors, signature=signature,
                   root=root)


def find_configs(folder, recursive=True):
    """Config JSONs in `folder`, sorted."""
    root = Path(folder)
    if not root.is_dir():
        raise NotADirectoryError(f"not a folder: {root}")
    walk = root.rglob('*.json') if recursive else root.glob('*.json')
    # A run folder keeps its search.json beside the configs; including it
    # would put one unreadable point on every map.
    return sorted(p for p in walk if p.name not in ('search.json',
                                                    'manifest.jsonl'))


def build_configs(folder, recursive=True, progress=print):
    """A gallery from a folder of Fluoddity save files. No images, no CLIP.

    For browsing a config collection by what the configs ARE. Nothing is
    rendered and nothing is embedded, so this is instant even on a folder of
    thousands -- the whole cost is reading small JSONs.

    Only the Rule sources can map such a gallery, since there is no picture to
    embed. `embeddings` is left empty rather than zeroed so a caller reaching
    for the CLIP source gets an obvious shape mismatch rather than a plausible
    map of nothing.
    """
    root = Path(folder)
    paths = find_configs(root, recursive=recursive)
    if not paths:
        raise FileNotFoundError(f"no config .json files in {root}")

    items, unreadable = [], 0
    for index, path in enumerate(paths):
        if config_features(path, include_sliders=False) is None:
            unreadable += 1
            continue
        items.append(Item(path=path, index=len(items),
                          config_path=str(path), has_image=False))

    if not items:
        raise FileNotFoundError(
            f"{len(paths)} .json file(s) in {root}, none readable as configs")
    if unreadable:
        progress(f"  skipped {unreadable} file(s) that are not readable "
                 f"Fluoddity configs")
    progress(f"  {len(items)} config(s)")

    return Gallery(items=items,
                   embeddings=np.zeros((len(items), 0), dtype=np.float32),
                   signature='configs', root=root)


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


#: Floats in a rule: 10 Fourier centers x (frequency[4] + amplitude[4]).
RULE_FLOATS = 80

#: What the UMAP is built from.
SOURCE_CLIP = 'clip'
SOURCE_RULE = 'rule'
SOURCE_RULE_SLIDERS = 'rule+sliders'
SOURCES = (SOURCE_CLIP, SOURCE_RULE, SOURCE_RULE_SLIDERS)

#: The physics fields that join the rule under 'rule+sliders', named by their
#: position in the v8 save format: (block, key). Read straight from the JSON
#: rather than through particle_system.persistence, because pilot/ does not
#: import the app -- the HTTP API is the whole of the contact between them,
#: and a viewer that could not open a config folder without the app installed
#: would be a worse tool.
#:
#: DELIBERATELY EXCLUDES three things. `color_sensitivity` and
#: `color_by_cohort` are appearance, and letting palette shape the layout is
#: the same confound grayscale exists to remove from CLIP scoring.
#: `mutation_seed` is an opaque hash input -- 0.30 and 0.31 are no more
#: similar than 0.30 and 0.90 -- so including it would add a dimension of pure
#: noise to every distance.
SLIDER_FIELDS = (
    ('sensor', 'gain'), ('sensor', 'angle'), ('sensor', 'distance'),
    ('force', 'global_mult'), ('force', 'drag'), ('force', 'strafe'),
    ('force', 'axial'),
    ('misc', 'lateral'), ('misc', 'hazard_rate'), ('misc', 'cohorts'),
    ('force2', 'gravity_force'), ('force2', 'gravity_strafe'),
    ('force2', 'initial_conditions'), ('force2', 'cohort_fences'),
    ('misc2', 'sensor_angle_jitter'), ('misc2', 'sensor_distance_jitter'),
    ('misc3', 'radial_gravity'),
)
#: World settings, which are per-save rather than per-config.
WORLD_FIELDS = ('trail_persistence', 'trail_diffusion', 'boundary_conditions')


def _standardize(matrix):
    """Z-score each column, then L2-normalize each row.

    WITHOUT THIS THE LAYOUT IS DECIDED BY UNITS. Rule coefficients range about
    +-3 while drag sits near 0.5 and hazard_rate near 0, so raw distances would
    be dominated by whichever field happens to have the widest spread rather
    than by anything meaningful. Columns with no variation across the dataset
    contribute nothing and are left at zero rather than dividing by ~0.
    """
    matrix = np.asarray(matrix, dtype=np.float32)
    if matrix.size == 0:
        return matrix
    mean = matrix.mean(axis=0, keepdims=True)
    spread = matrix.std(axis=0, keepdims=True)
    quiet = spread < 1e-8
    centred = (matrix - mean) / np.where(quiet, 1.0, spread)
    centred[:, quiet[0]] = 0.0
    # A row that is exactly average in every dimension centres to the zero
    # vector and cannot be given a direction. It stays at the origin rather
    # than being pushed somewhere arbitrary -- which is honest, and is where
    # UMAP will treat it as equidistant from everything.
    norms = np.linalg.norm(centred, axis=1, keepdims=True)
    return (centred / np.maximum(norms, 1e-12)).astype(np.float32)


#: Field names on the app's SimulationConfig, in the same order as
#: SLIDER_FIELDS. Used only on the persistence path below.
_SLIDER_ATTRS = (
    'sensor_gain', 'sensor_angle', 'sensor_distance',
    'global_force_mult', 'drag', 'strafe_power', 'axial_force',
    'lateral_force', 'hazard_rate', 'cohorts',
    'gravity_force', 'gravity_strafe', 'initial_conditions', 'cohort_fences',
    'sensor_angle_jitter', 'sensor_distance_jitter', 'radial_gravity',
)


def _features_via_persistence(path, include_sliders):
    """Read a config through the app's own loader, if it is importable.

    MOST REAL CONFIGS ARE v7. Measured on a live library: 188 of 192 files in
    configs/custom are the original Fluoddity format, whose layout is entirely
    different -- physics and rule at the top level, no `configs` array at all.
    particle_system.persistence already reads both and is the one place that
    knows how; reimplementing its v7 branch here would be a second copy to
    drift.

    Returns None when the app is not importable, so the direct v8 reader below
    still covers a pilot running on its own.
    """
    try:
        from particle_system import persistence
    except ImportError:
        return None
    try:
        saved = persistence.load(path)
        config = saved.configs[0]
        values = [float(v) for v in config.rule]
    except Exception:                                           # noqa: BLE001
        return None
    if len(values) != RULE_FLOATS:
        return None
    if include_sliders:
        values.extend(float(getattr(config, name, 0.0) or 0.0)
                      for name in _SLIDER_ATTRS)
        values.extend(float(getattr(saved.world, name, 0.0) or 0.0)
                      for name in WORLD_FIELDS)
    return values


def config_features(path, include_sliders):
    """The feature row for one saved config, or None if it cannot be read.

    Prefers the app's loader, which understands both v8 and the legacy v7
    format the bulk of a real library is in. Falls back to reading v8 JSON
    directly so `pilot/` still works without the app importable -- the HTTP
    API is meant to be the only hard dependency between them.

    A malformed file returns None rather than raising: a folder assembled by
    hand may contain anything, and one bad config should not stop a map of
    four thousand.
    """
    values = _features_via_persistence(path, include_sliders)
    if values is not None:
        return values

    try:
        data = json.loads(Path(path).read_text(encoding='utf-8'))
        config = data['configs'][0]
        values = [float(v) for v in config['rule']]
    except (OSError, ValueError, KeyError, IndexError, TypeError):
        return None
    if len(values) != RULE_FLOATS:
        return None

    if include_sliders:
        for block, key in SLIDER_FIELDS:
            values.append(float(config.get(block, {}).get(key, 0.0) or 0.0))
        world = data.get('world', {})
        for name in WORLD_FIELDS:
            values.append(float(world.get(name, 0.0) or 0.0))
    return values


def rule_embeddings(items, include_sliders, progress=None):
    """(N, D) features read from each item's saved config.

    Items whose config is missing or unreadable get a zero row, which
    standardization leaves at the origin -- they cluster together in the middle
    rather than vanishing, which is honest: they are the ones with no data.
    """
    rows, missing = [], 0
    width = RULE_FLOATS + (len(SLIDER_FIELDS) + len(WORLD_FIELDS)
                           if include_sliders else 0)
    for item in items:
        row = (config_features(item.config_path, include_sliders)
               if item.config_path else None)
        if row is None or len(row) != width:
            missing += 1
            row = [0.0] * width
        rows.append(row)
    if missing and progress:
        progress(f"  {missing}/{len(items)} items have no readable config")
    return _standardize(np.asarray(rows, dtype=np.float32))


def source_embeddings(gallery, source, progress=None):
    """The matrix a UMAP should be built from, for the chosen source."""
    if source == SOURCE_CLIP:
        if not gallery.has_images:
            raise ValueError(
                "this folder holds configs, not captures -- there is no image "
                "to embed. Pick the Rule or Rule + sliders source.")
        return gallery.embeddings
    return rule_embeddings(gallery.items,
                           include_sliders=(source == SOURCE_RULE_SLIDERS),
                           progress=progress)


def percentile_mask(values, percentile, bottom=False):
    """Which points survive a percentile cutoff. Returns a boolean (N,).

    `percentile` is the fraction HIDDEN, so 0 shows everything and 90 keeps
    only the top tenth. With `bottom`, the same slider keeps the worst tenth
    instead -- isolating failures is as useful as isolating successes, and
    naming the bad cluster is how negative captions get chosen.

    Computed over the whole dataset every time rather than over what is
    currently visible. Filtering the filtered would let the cutoff creep as it
    is dragged, so a sweep would depend on the path taken to get there.

    Points with no score (NaN) are always hidden when a cutoff is active: they
    cannot be ranked, and showing them among the survivors would imply they
    passed.
    """
    values = np.asarray(values, dtype=np.float64)
    finite = np.isfinite(values)
    if percentile <= 0:
        return np.ones(len(values), dtype=bool)
    if not finite.any():
        return np.zeros(len(values), dtype=bool)

    # `percentile` is the fraction HIDDEN, so the surviving fraction is its
    # complement. Both branches cut at the same place; they differ only in
    # which side of it they keep.
    hidden = float(np.clip(percentile, 0.0, 100.0))
    scored = values[finite]
    if bottom:
        threshold = np.percentile(scored, 100.0 - hidden)
        return finite & (values <= threshold)
    threshold = np.percentile(scored, hidden)
    return finite & (values >= threshold)


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
