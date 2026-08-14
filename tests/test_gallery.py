"""Gallery loading and UMAP projection. No window, no GPU, no CLIP.

    Scratch.venv/Scripts/python.exe tests/test_gallery.py

WHAT THIS IS GUARDING
Both halves fail quietly. A cache keyed too loosely serves vectors that mean
something else -- same shape, same count, silently wrong neighbourhoods. A
per-axis normalization stretches the layout to fill the canvas, which looks
better and misrepresents every distance UMAP just computed. Neither raises.

The embedding itself is not exercised here (that needs torch and a GPU); what
is exercised is everything around it.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from dataclasses import replace
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'demos'))

from pilot import gallery as gallery_lib                          # noqa: E402
from pilot import projection as projection_lib                    # noqa: E402
from pilot import embedding as embedding_lib                      # noqa: E402
from pilot import embedding_cache as cache_lib                    # noqa: E402
import tex_sim                                                    # noqa: E402

_failures = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok    {label}")
    else:
        print(f"  FAIL  {label}{'  -- ' + detail if detail else ''}")
        _failures.append(label)


def make_images(folder, names, size=32):
    folder.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(0)
    for name in names:
        colour = tuple(int(v) for v in rng.integers(0, 255, 3))
        Image.new('RGB', (size, size), colour).save(folder / f"{name}.png")


# ---------------------------------------------------------------------------

def test_find_images():
    print("\nfinding images")

    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        make_images(root, ['b', 'a', 'c'])
        (root / 'notes.txt').write_text('ignore me')
        (root / 'sub').mkdir()
        make_images(root / 'sub', ['d'])

        found = gallery_lib.find_images(root)
        names = [p.stem for p in found]
        check("finds images recursively", len(found) == 4, str(names))
        check("ignores non-images", 'notes' not in names, str(names))
        # Sorted, because the cache is POSITIONAL: an unsorted listing would
        # permute embeddings against items without changing the count.
        check("returns them sorted", names == sorted(names), str(names))

        shallow = gallery_lib.find_images(root, recursive=False)
        check("can stay shallow", len(shallow) == 3, str(len(shallow)))

        try:
            gallery_lib.find_images(root / 'nope')
            check("a missing folder raises", False, "no error")
        except NotADirectoryError:
            check("a missing folder raises", True)


class CountingBackend:
    """A backend that records how many images it was asked to embed."""

    name = 'counting'
    supports_text = False

    def __init__(self, signature='fake:v1', crops=3, dim=8):
        self._signature = signature
        self.crops = crops
        self.dim = dim
        self.calls = 0

    def signature(self):
        return self._signature

    def embed_images(self, paths):
        self.calls += len(paths)
        out = np.ones((len(paths), self.crops, self.dim), np.float32)
        return out / np.sqrt(self.dim)


def test_embedding_cache():
    """The shared cache. Its whole value is what it does NOT re-embed."""
    print("\nshared embedding cache")

    from pilot.embedding_cache import EmbeddingCache, embed_cached

    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        make_images(root, [f"{i:02d}" for i in range(5)])
        paths = gallery_lib.find_images(root)

        backend = CountingBackend()
        cache = EmbeddingCache(root)

        first = embed_cached(paths, backend, cache)
        check("embeds everything on a cold cache", backend.calls == 5,
              str(backend.calls))
        check("keeps the per-crop shape", first.shape == (5, 3, 8),
              str(first.shape))

        backend.calls = 0
        embed_cached(paths, backend, cache)
        check("a warm cache embeds nothing", backend.calls == 0,
              str(backend.calls))

        # THE property the whole design exists for: a search appends captures
        # generation by generation, and re-embedding the earlier ones each
        # time would make caching worse than useless.
        make_images(root, ['05', '06', '07'])
        grown = gallery_lib.find_images(root)
        backend.calls = 0
        out = embed_cached(grown, backend, cache)
        check("appending re-embeds ONLY the new files", backend.calls == 3,
              f"embedded {backend.calls}, expected 3")
        check("and returns the full set in order", out.shape == (8, 3, 8),
              str(out.shape))

        # A replaced file must not be served its predecessor's vectors.
        Image.new('RGB', (96, 96), (7, 7, 7)).save(root / '00.png')
        backend.calls = 0
        embed_cached(gallery_lib.find_images(root), backend, cache)
        check("a rewritten file is re-embedded", backend.calls == 1,
              str(backend.calls))

        print("\n  signatures")
        other = CountingBackend(signature='fake:v2')
        embed_cached(paths, other, cache)
        check("a new signature embeds afresh", other.calls == 5,
              str(other.calls))
        check("both signatures coexist in one file",
              len(cache.signatures()) == 2, str(cache.signatures()))
        backend.calls = 0
        embed_cached(paths, backend, cache)
        check("and the original is still cached", backend.calls == 0,
              "flipping grayscale would discard the other set")

        print("\n  near-miss reporting")
        # One changed setting makes every stored vector unreachable, and the
        # only symptom is a long progress bar on a folder embedded yesterday.
        # Measured on a real 25,100-capture folder: a complete SO400M set sat
        # under ':gray' while the config asked without it, and nothing on
        # screen connected the two.
        rivals = cache.rival_signatures('fake:v1')
        check("another signature is reported as a rival",
              [s for s, _ in rivals] == ['fake:v2'], str(rivals))
        check("and counted", rivals[0][1] == 5, str(rivals))
        check("a signature is not its own rival",
              'fake:v1' not in [s for s, _ in rivals])

        from pilot.embedding_cache import describe_difference

        # The advice must name the key that actually needs changing. Model and
        # backend take precedence over grayscale: flipping grayscale does not
        # make another model's vectors usable, and saying so would send the
        # reader to the wrong setting.
        check("grayscale is named, with the value that reuses the cache",
              'grayscale: true' in describe_difference(
                  'clip:ViT-B-32:l2b:c4:f0.4:s0:gray',
                  'clip:ViT-B-32:l2b:c4:f0.4:s0'))
        check("and the other direction",
              'grayscale: false' in describe_difference(
                  'clip:ViT-B-32:l2b:c4:f0.4:s0',
                  'clip:ViT-B-32:l2b:c4:f0.4:s0:gray'))
        check("a model difference outranks a grayscale one",
              'clip_model' in describe_difference(
                  'clip:ViT-B-32:l2b:c4:f0.4:s0:gray',
                  'clip:ViT-SO400M:webli:c4:f0.4:s0'))
        check("crops and crop_frac are named",
              describe_difference('clip:a:b:c4:f0.4:s0',
                                  'clip:a:b:c10:f0.3:s0')
              == 'differs by crops: 4 vs 10, crop_frac: 0.4 vs 0.3',
              describe_difference('clip:a:b:c4:f0.4:s0',
                                  'clip:a:b:c10:f0.3:s0'))
        check("a backend difference is named",
              'backend' in describe_difference('texture:256:r32:a16:e16:h16',
                                               'clip:a:b:c4:f0.4:s0'))
        check("identical signatures say nothing",
              describe_difference('clip:a:b:c4:f0.4:s0',
                                  'clip:a:b:c4:f0.4:s0') == '')

        print("\n  atomic flush")
        # The archive reaches 865MB on a real run. np.savez over the live file
        # leaves it a truncated zip for seconds; interrupt that and hours of
        # embedding are gone, with _load treating the wreckage as empty.
        cache.flush()
        leftovers = list(root.glob('*.tmp')) + list(root.glob('*.tmp.npz'))
        check("no temporary file is left behind", not leftovers,
              str(leftovers))
        check("and the archive is readable after a rewrite",
              len(EmbeddingCache(root)) == len(cache),
              f"{len(EmbeddingCache(root))} vs {len(cache)}")

        print("\n  persistence")
        cache.flush()
        reopened = EmbeddingCache(root)
        check("survives a reopen", len(reopened) == len(cache), str(len(reopened)))
        backend.calls = 0
        embed_cached(paths, backend, reopened)
        check("a reopened cache still hits", backend.calls == 0)

        collapsed = embed_cached(paths, backend, reopened, aggregate='mean')
        check("aggregate collapses the crop axis on read",
              collapsed.shape == (5, 8), str(collapsed.shape))

        (root / '.embeddings.npz').write_bytes(b'not an npz')
        check("a corrupt cache is a miss, not a crash",
              len(EmbeddingCache(root)) == 0)


def test_percentile_mask():
    """The cutoff. A lens on the plot, computed over the whole dataset."""
    print("\npercentile cutoff")

    values = np.arange(100, dtype=np.float32)      # 0..99

    check("0% hides nothing",
          gallery_lib.percentile_mask(values, 0).all())

    top10 = gallery_lib.percentile_mask(values, 90)
    check("90% keeps about the top tenth",
          9 <= top10.sum() <= 12, str(int(top10.sum())))
    check("and it is the HIGH end",
          values[top10].min() >= 89, str(values[top10].min()))

    bottom10 = gallery_lib.percentile_mask(values, 90, bottom=True)
    check("bottom keeps about the worst tenth",
          9 <= bottom10.sum() <= 12, str(int(bottom10.sum())))
    check("and it is the LOW end",
          values[bottom10].max() <= 10, str(values[bottom10].max()))
    check("the two ends do not overlap",
          not (top10 & bottom10).any())

    # Computed over the full dataset every time, so dragging the slider is
    # reversible: 90 then 0 must return exactly what 0 alone gives.
    check("the cutoff is not cumulative",
          gallery_lib.percentile_mask(values, 0).sum() == 100)

    with_nan = np.array([1.0, np.nan, 3.0, np.nan, 5.0], np.float32)
    masked = gallery_lib.percentile_mask(with_nan, 50)
    check("unscored points are hidden when a cutoff is active",
          not masked[1] and not masked[3], str(masked))
    check("unscored points are shown when it is not",
          gallery_lib.percentile_mask(with_nan, 0).all())
    check("all-NaN hides everything rather than dividing by zero",
          not gallery_lib.percentile_mask(
              np.full(4, np.nan, np.float32), 50).any())


def test_manifest_enrichment():
    print("\nmanifest enrichment")

    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        captures = root / 'captures'
        make_images(captures, ['gen000_000', 'gen000_001', 'stranger'])

        rows = [
            {'id': 'gen000_000', 'generation': 0, 'origin': 'immigrant',
             'score': 1.5, 'config_path': 'configs/gen000_000.json'},
            {'id': 'gen000_001', 'generation': 1, 'origin': 'mutant',
             'score': -0.5, 'parent_id': 'gen000_000'},
        ]
        (root / 'manifest.jsonl').write_text(
            '\n'.join(json.dumps(r) for r in rows) + '\n', encoding='utf-8')

        # The manifest sits one level UP from captures/, which is the layout a
        # run actually produces.
        found = gallery_lib.find_manifest(captures)
        check("finds a manifest beside the parent", found is not None,
              str(found))

        items = [gallery_lib.Item(path=p, index=i)
                 for i, p in enumerate(gallery_lib.find_images(captures))]
        gallery_lib._enrich(items, captures, progress=lambda *a: None)

        by_name = {i.name: i for i in items}
        check("scores attach", by_name['gen000_000'].score == 1.5)
        check("lineage attaches",
              by_name['gen000_001'].parent_id == 'gen000_000')
        check("config paths attach",
              by_name['gen000_000'].config_path.endswith('.json'))
        # An image with no manifest row is still plottable, just quieter.
        check("unmatched images survive unenriched",
              by_name['stranger'].score is None)

        check("tooltip shows what is known",
              'score' in ' '.join(by_name['gen000_000'].tooltip_lines()))
        check("tooltip omits what is not",
              all('score' not in line
                  for line in by_name['stranger'].tooltip_lines()))

    # Last row wins, matching the report's dedupe: in pre-session-tag folders
    # only the final writer's files survive.
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        (root / 'manifest.jsonl').write_text(
            json.dumps({'id': 'a', 'score': 1.0}) + '\n'
            + json.dumps({'id': 'a', 'score': 2.0}) + '\n', encoding='utf-8')
        rows = gallery_lib.read_manifest(root / 'manifest.jsonl')
        check("duplicate ids keep the last row", rows['a']['score'] == 2.0)

        (root / 'torn.jsonl').write_text(
            json.dumps({'id': 'a', 'score': 1.0}) + '\n{"id": "b", "sc',
            encoding='utf-8')
        check("a torn line is skipped",
              len(gallery_lib.read_manifest(root / 'torn.jsonl')) == 1)


def test_normalize():
    print("\nnormalization")

    points = np.array([[0.0, 0.0], [10.0, 5.0], [5.0, 2.5]], np.float32)
    out = projection_lib.normalize(points)

    check("lands inside the unit square",
          out.min() >= -1e-6 and out.max() <= 1 + 1e-6, str(out))

    # THE property that matters: a uniform scale, not per-axis. Stretching each
    # axis to fill would distort every distance UMAP just computed.
    wide = out[:, 0].max() - out[:, 0].min()
    tall = out[:, 1].max() - out[:, 1].min()
    check("aspect is preserved (uniform scale, not per-axis)",
          abs(wide / tall - 2.0) < 1e-4,
          f"x span {wide:.4f}, y span {tall:.4f} -- want a 2:1 ratio")

    check("the narrow axis is centred",
          abs((out[:, 1].max() + out[:, 1].min()) / 2 - 0.5) < 1e-5,
          str(out[:, 1]))

    same = projection_lib.normalize(np.full((4, 2), 3.0, np.float32))
    check("identical points do not divide by zero",
          np.allclose(same, 0.5), str(same))

    check("an empty input is handled",
          projection_lib.normalize(np.zeros((0, 2), np.float32)).shape == (0, 2))


def test_projection_edges():
    print("\nprojection edge cases")

    check("zero points",
          len(projection_lib.project(np.zeros((0, 4), np.float32)).points) == 0)

    one = projection_lib.project(np.ones((1, 4), np.float32))
    check("one point does not crash UMAP", len(one.points) == 1)

    two = projection_lib.project(np.random.default_rng(0).normal(size=(2, 4)))
    check("two points do not crash UMAP", len(two.points) == 2)

    # n_neighbours must stay below the sample count, and the slider must not be
    # able to produce an unrunnable state.
    rng = np.random.default_rng(2)
    vectors = rng.normal(size=(12, 6)).astype(np.float32)
    vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)
    projected = projection_lib.project(vectors, n_neighbours=500)
    check("n_neighbours is clamped below the sample count",
          projected.n_neighbours < 12, str(projected.n_neighbours))
    check("and the layout still comes out normalized",
          projected.points.min() >= -1e-6 and projected.points.max() <= 1 + 1e-6)

    # Reproducible: an unseeded layout would make "did that slider do
    # anything" unanswerable.
    again = projection_lib.project(vectors, n_neighbours=500)
    check("the same seed gives the same layout",
          np.allclose(projected.points, again.points))

    check("describe() names the settings",
          'n_neighbors' in projected.describe(), projected.describe())


def test_score_colour():
    print("\nscore colouring")

    from pilot.umap_view import score_colour

    low, high = score_colour(0.0, 0.0, 1.0), score_colour(1.0, 0.0, 1.0)
    check("the extremes differ", low != high)
    check("NaN gets a neutral colour",
          score_colour(float('nan'), 0.0, 1.0)
          == score_colour(float('nan'), 0.0, 1.0))
    # A run where every candidate scored identically must not divide by zero.
    check("a degenerate range does not crash",
          score_colour(1.0, 1.0, 1.0) is not None)


def test_view_transform():
    """Pan and zoom: round-trip, drag direction, and the zoom anchor.

    All three fail QUIETLY. An inverted axis still draws a plot and still
    hovers correctly (hover compares screen positions, so it is immune); it
    just makes dragging feel wrong. A to_screen/_from_screen pair that
    disagree still renders, and only shows up as the view creeping while you
    zoom. Cheap to assert, invisible to notice.
    """
    print("\nview transform")

    from types import SimpleNamespace

    from pilot.projection import Projection
    from pilot.umap_view import Viewer

    points = np.array([[0.5, 0.5], [0.2, 0.8], [0.9, 0.1]], np.float32)
    gallery = gallery_lib.Gallery(
        items=[gallery_lib.Item(path=Path(f"{i}.png"), index=i)
               for i in range(3)],
        embeddings=np.zeros((3, 4), np.float32), root=Path('.'))
    view = Viewer()
    view.gallery = gallery
    view.projection = Projection(points, 15, 0.1, 42)

    origin = SimpleNamespace(x=100.0, y=50.0)
    size = SimpleNamespace(x=800.0, y=600.0)

    def worst_roundtrip():
        worst = 0.0
        for point in points:
            sx, sy = view.to_screen(point, origin, size)
            back = view._from_screen(SimpleNamespace(x=sx, y=sy), origin, size)
            worst = max(worst, abs(back[0] - point[0]),
                        abs(back[1] - point[1]))
        return worst

    check("round-trips at rest", worst_roundtrip() < 1e-5)
    view.pan, view.zoom = [0.13, -0.27], 3.4
    check("round-trips panned and zoomed in", worst_roundtrip() < 1e-5)
    view.pan, view.zoom = [-0.4, 0.6], 0.7
    check("round-trips panned and zoomed out", worst_roundtrip() < 1e-5)

    # Dragging must move the plot WITH the cursor, in both axes. The y flip
    # applies to the point, not to the pan; applying it to both inverted the
    # drag while leaving hover correct, which is exactly how it shipped.
    view.pan, view.zoom = [0.0, 0.0], 1.0
    x0, y0 = view.to_screen(points[0], origin, size)
    view.pan[0] += 60.0 / size.x
    view.pan[1] += 60.0 / size.y
    x1, y1 = view.to_screen(points[0], origin, size)
    check("dragging right moves points right", x1 > x0, f"dx={x1 - x0:+.1f}")
    check("dragging down moves points down", y1 > y0, f"dy={y1 - y0:+.1f}")
    check("and it tracks the cursor 1:1",
          abs((x1 - x0) - 60.0) < 0.01 and abs((y1 - y0) - 60.0) < 0.01,
          f"dx={x1 - x0:.2f} dy={y1 - y0:.2f}")

    # Cursor-anchored zoom: whatever was under the mouse stays under it.
    for direction, label in ((1, 'in'), (-1, 'out')):
        view.pan, view.zoom = [0.05, -0.1], 2.0
        mouse = SimpleNamespace(x=origin.x + 620.0, y=origin.y + 140.0)
        before = view._from_screen(mouse, origin, size)
        was = view.to_screen(before, origin, size)
        view.zoom = float(np.clip(view.zoom * (1.1 ** direction), 0.5, 40.0))
        after = view._from_screen(mouse, origin, size)
        view.pan[0] += (after[0] - before[0]) * view.zoom
        view.pan[1] -= (after[1] - before[1]) * view.zoom
        now = view.to_screen(before, origin, size)
        drift = max(abs(now[0] - was[0]), abs(now[1] - was[1]))
        check(f"zooming {label} holds the point under the cursor", drift < 0.5,
              f"drifted {drift:.3f}px")


class FakeTextBackend:
    """Text-capable backend with placed vectors. Same idea as test_search's.

    Unknown captions cluster near a shared axis, reproducing the narrow cone
    real CLIP text embeddings occupy (measured pairwise cosine 0.51-0.94).
    Random directions would make the calibration look broken when it is not.
    """

    name = 'fake'
    supports_text = True

    def __init__(self, vectors, dim=32, signature='fake:v1'):
        self.vectors = vectors
        self.dim = dim
        self.grayscale = False
        #: apply_caption refuses when this disagrees with the gallery's, so a
        #: caption is never scored against vectors from another model.
        self._signature = signature
        axis = np.zeros(dim, dtype=np.float32)
        axis[-1] = 1.0
        self._generic = axis

    def signature(self):
        return self._signature

    def embed_texts(self, texts):
        out = np.zeros((len(texts), self.dim), dtype=np.float32)
        for i, text in enumerate(texts):
            vector = self.vectors.get(text)
            if vector is None:
                rng = np.random.default_rng(abs(hash(text)) % (2 ** 31))
                noise = rng.normal(size=self.dim)
                vector = self._generic + 0.35 * (noise / np.linalg.norm(noise))
            vector = np.asarray(vector, dtype=np.float32)
            out[i] = vector / (np.linalg.norm(vector) + 1e-12)
        return out


def test_caption_colouring():
    """Scoring a gallery against a typed caption.

    The feature that makes the viewer worth opening: colour the map by a
    phrase, see which cluster lights up, and you have both tested the wording
    and identified a negative caption worth subtracting in a search.
    """
    print("\ncaption colouring")

    dim = 32
    want = np.zeros(dim, np.float32); want[0] = 1.0
    other = np.zeros(dim, np.float32); other[1] = 1.0
    backend = FakeTextBackend({'a maze': want, 'noise': other}, dim=dim)

    generic = backend._generic
    images = np.stack([
        (generic + want) / np.linalg.norm(generic + want),      # on caption
        (generic + other) / np.linalg.norm(generic + other),    # off caption
        generic,                                                # generic
    ]).astype(np.float32)

    # The signature must match the backend's: apply_caption refuses to score a
    # caption against vectors from another model, and an unset signature is a
    # mismatch like any other.
    gallery = gallery_lib.Gallery(
        items=[gallery_lib.Item(path=Path(f"{i}.png"), index=i)
               for i in range(3)],
        embeddings=images, root=Path('.'), signature=backend.signature())

    scores = gallery_lib.score_caption(gallery, 'a maze', backend)
    check("returns one score per image", scores.shape == (3,), str(scores.shape))
    check("the on-caption image scores highest",
          int(np.argmax(scores)) == 0, str(np.round(scores, 3)))

    # Calibration is what makes the numbers comparable to a search's.
    raw = gallery_lib.score_caption(gallery, 'a maze', backend,
                                    calibrate=False)
    check("uncalibrated also ranks it first", int(np.argmax(raw)) == 0,
          str(np.round(raw, 3)))
    check("calibration widens the spread",
          float(scores.max() - scores.min()) > float(raw.max() - raw.min()),
          f"raw {raw.max() - raw.min():.4f} vs z {scores.max() - scores.min():.4f}")

    # A different caption must light up a different image -- the whole point
    # of trying several against one map.
    negative = gallery_lib.score_caption(gallery, 'noise', backend)
    check("a different caption favours a different image",
          int(np.argmax(negative)) == 1, str(np.round(negative, 3)))

    print("\n  viewer wiring")
    from pilot.umap_view import COLOUR_CAPTION, COLOUR_PLAIN, Viewer

    def loaded_viewer(with_backend):
        """A Viewer with a folder already 'loaded'. The GUI starts empty, so
        tests have to put it in the state a load would."""
        view = Viewer()
        view.gallery = gallery
        view.backend = with_backend
        return view

    empty = Viewer()
    check("starts with nothing loaded", empty.gallery is None)
    check("and nothing projected", empty.projection is None)

    # Every action must survive being pressed before anything is open --
    # the GUI now starts empty, so that is the state it is first seen in.
    empty.caption = 'a maze'
    empty.apply_caption()
    check("a caption before loading is refused, not crashed",
          empty.caption_scores is None and 'folder' in empty.status,
          empty.status)
    empty.compute_projection()
    check("projecting before loading is refused",
          empty.projection is None and 'folder' in empty.status, empty.status)

    view = loaded_viewer(backend)
    check("plain when the gallery has no manifest scores",
          view.colour_mode == COLOUR_PLAIN, str(view.colour_mode))
    check("nothing to shade before a caption", view.active_scores() is None)
    check("and no cutoff mask without something to rank",
          view.visible_mask() is None)

    view.caption = 'a maze'
    view.apply_caption()
    check("applying a caption switches the colour mode",
          view.colour_mode == COLOUR_CAPTION)
    check("and records what is displayed",
          view.caption_applied == 'a maze', view.caption_applied)
    shading = view.active_scores()
    check("shading is available", shading is not None)
    check("shading bounds come from the caption scores",
          shading is not None and shading[1] < shading[2],
          str(shading[1:] if shading else None))

    # The cutoff filters on whatever the current colour is.
    view.cutoff = 50.0
    mask = view.visible_mask()
    check("the cutoff hides part of the set",
          mask is not None and 0 < mask.sum() < len(gallery),
          str(mask.sum() if mask is not None else None))
    view.cutoff_bottom = True
    inverted = view.visible_mask()
    check("bottom percentile keeps a different subset",
          inverted is not None and not np.array_equal(mask, inverted))
    view.cutoff = 0.0
    check("a zero cutoff shows everything again",
          view.visible_mask() is None)

    view.caption = '   '
    view.apply_caption()
    check("an empty caption is refused, leaving the old colours",
          view.caption_applied == 'a maze' and 'caption' in view.status.lower(),
          view.status)

    # A text-less backend must say so rather than raising into the frame loop.
    import tex_sim
    plain_view = loaded_viewer(tex_sim.TextureBackend())
    plain_view.caption = 'a maze'
    plain_view.apply_caption()
    # Names the BUTTON that fixes it, not the internal that failed: "needs the
    # clip backend" told the reader nothing they could act on.
    check("the texture backend reports it cannot embed text",
          plain_view.caption_scores is None
          and 'Recompute' in plain_view.status,
          plain_view.status)


def test_disabled_pairing():
    """begin_disabled/end_disabled must pair even when the state flips.

    THE BUG THIS CAUGHT, which only appeared at runtime: the hand-rolled form
    reads the same expression twice --

        if self.busy: begin_disabled()
        if button(...): self.start_something()
        if self.busy: end_disabled()

    -- and pressing the button starts a task, so `busy` is False on the way in
    and True on the way out. end_disabled() then fires unpaired and imgui
    asserts, killing the window. Latching the condition once makes it
    impossible; this asserts the latch actually holds.
    """
    print("\ndisabled-block pairing")

    from pilot.umap_view import _disabled_if

    calls = []

    class FakeImgui:
        def begin_disabled(self, *a):
            calls.append('begin')

        def end_disabled(self):
            calls.append('end')

    import pilot.umap_view as view_mod

    # _disabled_if imports imgui itself, so patch where it looks.
    import sys as _sys
    fake_bundle = type(_sys)('imgui_bundle')
    fake_bundle.imgui = FakeImgui()
    saved = _sys.modules.get('imgui_bundle')
    _sys.modules['imgui_bundle'] = fake_bundle
    try:
        with _disabled_if(True):
            calls.append('body')
        check("disabled: begin, body, end", calls == ['begin', 'body', 'end'],
              str(calls))

        calls.clear()
        with _disabled_if(False):
            calls.append('body')
        check("enabled: no begin/end at all", calls == ['body'], str(calls))

        # The actual failure mode: the condition changing inside the block
        # must not affect how many times end_disabled is called.
        calls.clear()
        flipping = [True]
        with _disabled_if(flipping[0]):
            flipping[0] = False        # a task started mid-block
            calls.append('body')
        check("a condition that flips inside still pairs",
              calls == ['begin', 'body', 'end'], str(calls))

        # And an exception must not leave a block open, or every later frame
        # inherits a greyed-out UI.
        calls.clear()
        try:
            with _disabled_if(True):
                raise RuntimeError("boom")
        except RuntimeError:
            pass
        check("an exception inside still closes the block",
              calls == ['begin', 'end'], str(calls))
    finally:
        if saved is not None:
            _sys.modules['imgui_bundle'] = saved
        else:
            del _sys.modules['imgui_bundle']


def test_progress_reporting():
    """Background work reports a fraction, not just log lines.

    A bar needs a number and a status line needs a sentence; deriving either
    from the other means parsing text. The Reporter carries both, and is
    CALLABLE so anything written against `progress=print` keeps working.
    """
    print("\nprogress reporting")

    import time as _time

    from pilot.task import Reporter, Task, null_reporter

    seen = []
    steps = []
    reporter = Reporter(seen.append,
                        lambda d, t, n, label: steps.append((d, t, n, label)))
    reporter("hello")
    reporter.step(3, 10, 'images')
    check("a reporter logs", seen == ['hello'], str(seen))
    check("and counts", steps == [(3, 10, 'images', None)], str(steps))

    check("null_reporter accepts both without doing anything",
          null_reporter("x") is None and null_reporter.step(1, 2) is None)

    # A worker that only logs must not need to know about bars.
    task = Task.start('quiet', lambda report: (report("working"), 'ok')[1])
    task.join(5)
    progress = task.progress
    check("a task that never steps has no fraction",
          progress.fraction is None, str(progress.fraction))
    check("and still logs", 'working' in progress.lines, str(progress.lines))
    check("and returns its result", progress.result == 'ok')

    def counting(report):
        for i in range(4):
            report.step(i + 1, 4, 'widgets')
            report(f"did {i + 1}")
        return 'done'

    task = Task.start('counting', counting)
    task.join(5)
    progress = task.progress
    check("a counting task reports a fraction",
          progress.fraction == 1.0, str(progress.fraction))
    check("and what it counted", progress.detail == '4/4 widgets',
          progress.detail)

    # A zero total means "cannot say" -- the bar must vanish rather than sit
    # at zero, which would read as stalled.
    def indeterminate(report):
        report.step(1, 4, 'x')
        report.step(0, 0)
        return 'done'

    task = Task.start('indeterminate', indeterminate)
    task.join(5)
    check("a zero total clears the fraction",
          task.progress.fraction is None, str(task.progress.fraction))

    # The fraction is clamped: an off-by-one in a caller must not produce a
    # bar longer than the widget.
    def overshoot(report):
        report.step(12, 10, 'x')
        return None

    task = Task.start('overshoot', overshoot)
    task.join(5)
    check("the fraction is clamped to 1.0",
          task.progress.fraction == 1.0, str(task.progress.fraction))

    # Failures still surface rather than hanging the GUI on a task that
    # never completes.
    task = Task.start('boom', lambda report: 1 / 0)
    task.join(5)
    check("a failing task completes and reports",
          task.progress.done and task.progress.failed
          and 'ZeroDivisionError' in task.progress.error,
          task.progress.error)


def test_embed_progress():
    """embed_cached drives a bar without needing one."""
    print("\nembedding progress")

    from pilot.embedding_cache import EmbeddingCache, embed_cached
    from pilot.task import Reporter

    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        make_images(root, [f"{i:03d}" for i in range(9)])
        paths = gallery_lib.find_images(root)

        steps = []
        reporter = Reporter(lambda m: None,
                            lambda d, t, n, label: steps.append((d, t)))
        embed_cached(paths, CountingBackend(), EmbeddingCache(root),
                     progress=reporter, chunk=4)

        check("progress is reported during the embed", bool(steps), str(steps))
        check("it ends at the total",
              steps[-1] == (9, 9), str(steps[-1]))
        check("and never exceeds it",
              all(d <= t for d, t in steps), str(steps))

        # A plain function (no .step) must still work -- that is the whole
        # reason the reporter is callable rather than a pair of arguments.
        lines = []
        embed_cached(paths, CountingBackend(signature='v2'),
                     EmbeddingCache(root), progress=lines.append, chunk=4)
        check("a bare callable progress still works", bool(lines), str(lines))


def test_rescore_updates_the_view():
    """Re-scoring must change what is ON SCREEN, not just report.txt.

    THE BUG THIS CAUGHT: _rescore computed new scores, wrote them to
    report.txt, and dropped them. The gallery's scores still came from the
    manifest, so the plot colours and the percentile cutoff kept showing the
    old ranking -- pressing the button appeared to do nothing at all, which is
    exactly how it was reported.
    """
    print("\nre-score updates the live view")

    items = [gallery_lib.Item(path=Path(f"gen000_{i:03d}.png"), index=i,
                              score=float(i))
             for i in range(5)]
    gallery = gallery_lib.Gallery(
        items=items, embeddings=np.zeros((5, 4), np.float32), root=Path('.'))

    before = [i.score for i in gallery.items]
    check("starts with the manifest's scores", before == [0., 1., 2., 3., 4.],
          str(before))

    # A re-score returns {candidate id: new score}; ids are capture stems.
    applied = gallery.apply_scores({'gen000_000': 9.0, 'gen000_002': -3.0})
    check("reports how many landed", applied == 2, str(applied))
    after = [i.score for i in gallery.items]
    check("the named items take the new scores",
          after[0] == 9.0 and after[2] == -3.0, str(after))
    check("the others are left alone",
          after[1] == 1.0 and after[3] == 3.0 and after[4] == 4.0, str(after))

    # The cutoff reads Gallery.scores, so it must follow -- that is the half
    # the user actually noticed was broken.
    ranked = gallery_lib.percentile_mask(gallery.scores, 60)
    kept = {gallery.items[i].name for i, keep in enumerate(ranked) if keep}
    check("the percentile cutoff follows the new scores",
          'gen000_000' in kept and 'gen000_002' not in kept, str(sorted(kept)))

    check("an unknown id is ignored rather than raising",
          gallery.apply_scores({'not_here': 1.0}) == 0)

    # relabel returns a COPY rather than mutating, so a caller holding an item
    # cannot have it change underneath them.
    sample = gallery_lib.Item(path=Path('x.png'), index=0, score=1.0)
    copy = sample.relabel(7.0)
    check("relabel returns a copy, leaving the original alone",
          sample.score == 1.0 and copy.score == 7.0,
          f"{sample.score} / {copy.score}")
    check("and carries everything else across",
          copy.path == sample.path and copy.index == sample.index)

    print("\n  viewer wiring")
    from pilot.umap_view import COLOUR_CAPTION, COLOUR_SCORE, Viewer

    view = Viewer()
    view.gallery = gallery
    view.colour_mode = COLOUR_CAPTION
    view.caption_scores = np.zeros(5, np.float32)
    view.task_kind = 'rescore'

    from pilot.task import Progress

    class DoneTask:
        """A finished task, as _collect() sees one."""

        running = False
        progress = Progress(
            label='rescore', done=True,
            result={'scores': {'gen000_001': 42.0},
                    'path': 'report.txt', 'count': 1})

    view.task = DoneTask()
    view._collect()
    check("collecting a re-score applies the scores",
          view.gallery.items[1].score == 42.0,
          str(view.gallery.items[1].score))
    # Switching to run-score colouring is the point: leaving the map on a
    # caption would hide the thing the button was pressed to see.
    check("and switches the map to show them",
          view.colour_mode == COLOUR_SCORE, str(view.colour_mode))
    check("and says what happened", 're-scored' in view.status, view.status)


def test_live_recolor():
    """Debounced recolouring: fire once, after the typing stops."""
    print("\nlive recolor")

    from pilot.umap_view import LIVE_RECOLOR_DELAY, Viewer

    view = Viewer()
    applied = []
    view.apply_caption = lambda: applied.append(view.caption.strip())

    def type_text(text, at):
        """Simulate a keystroke: the box changed, nothing applied yet."""
        view.caption = text
        view._tick_live_recolor(pending=True, now=at)

    # Off by default, and off means never.
    view.live_recolor = False
    type_text('a river', 0.0)
    type_text('a river', 10.0)
    check("does nothing while unchecked", applied == [], str(applied))

    view.live_recolor = True
    applied.clear()

    # Typing: each keystroke restarts the wait, so nothing fires mid-word.
    for i, partial in enumerate(['a', 'a r', 'a riv', 'a river']):
        type_text(partial, i * 0.05)
    check("does not fire while still typing", applied == [], str(applied))

    # The pause. Polled just past the deadline rather than exactly on it:
    # the last keystroke was at 0.15, and asking at precisely 0.15 + delay
    # depends on float addition associating the same way twice.
    view._tick_live_recolor(pending=True, now=0.15 + LIVE_RECOLOR_DELAY + 1e-6)
    check("fires once typing stops", applied == ['a river'], str(applied))

    # And only once -- the caller sets pending=False after applying.
    applied.clear()
    view._tick_live_recolor(pending=False, now=10.0)
    check("does not fire again for the same caption", applied == [],
          str(applied))

    # A slow typist: gaps shorter than the delay must not trigger.
    applied.clear()
    for i, partial in enumerate(['b', 'bl', 'blu', 'blue']):
        type_text(partial, 20.0 + i * (LIVE_RECOLOR_DELAY * 0.6))
    check("a slow typist is not interrupted mid-word", applied == [],
          str(applied))
    view._tick_live_recolor(
        pending=True, now=20.0 + 4 * LIVE_RECOLOR_DELAY)
    check("and gets one recolour at the end", applied == ['blue'],
          str(applied))

    # An empty box has nothing to score.
    applied.clear()
    view.caption = '   '
    view._tick_live_recolor(pending=True, now=30.0)
    view._tick_live_recolor(pending=True, now=40.0)
    check("an empty caption never fires", applied == [], str(applied))

    # Unchecking mid-wait cancels rather than firing later.
    applied.clear()
    type_text('green', 50.0)
    view.live_recolor = False
    view._tick_live_recolor(pending=True, now=50.0 + LIVE_RECOLOR_DELAY * 2)
    check("unchecking cancels a pending recolour", applied == [], str(applied))
    check("and clears the timer", view._caption_touched is None)


def test_config_auto_reload():
    """Actions re-read the config file, so Reload is not a required step.

    The workflow was: edit the JSON, press Reload, press Re-score. Forgetting
    the middle step silently scored against the OLD objective, which looks
    exactly like the button not working -- and that is how it was reported.
    """
    print("\nconfig auto-reload")

    import json

    from pilot.umap_view import Viewer

    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        config = root / 'search.json'
        config.write_text(json.dumps(
            {'backend': 'clip', 'captions': ['a river']}), encoding='utf-8')

        view = Viewer()
        view.config_path = str(config)
        check("loads on request",
              view._load_config(config) and view.cfg.captions == ['a river'],
              str(view.cfg.captions))

        # Edit the file WITHOUT pressing Reload.
        config.write_text(json.dumps(
            {'backend': 'clip', 'captions': ['a delta', 'a fan']}),
            encoding='utf-8')
        check("the in-memory config is still the old one",
              view.cfg.captions == ['a river'], str(view.cfg.captions))

        check("_refresh_config picks up the edit", view._refresh_config())
        check("and the new captions are live",
              view.cfg.captions == ['a delta', 'a fan'], str(view.cfg.captions))

        # A broken file must not discard a working config: a run in progress
        # is worth more than punishing a half-saved edit.
        config.write_text('{ not json', encoding='utf-8')
        check("a malformed config is reported", view._refresh_config() is False)
        check("and the previous one is kept",
              view.cfg.captions == ['a delta', 'a fan'], str(view.cfg.captions))
        check("with the reason in the status",
              'could not read' in view.status, view.status)

        # No config path at all is fine -- the viewer works without one.
        blank = Viewer()
        blank.config_path = ''
        check("no config path is not an error", blank._refresh_config())


def _write_config(path, rule=None, **blocks):
    """A minimal v8 save file, as the app writes them."""
    import json

    config = {'rule': list(rule if rule is not None
                           else [0.1 * i for i in range(80)])}
    config.setdefault('sensor', {'gain': 1.0, 'angle': 0.2, 'distance': 1.0})
    config.setdefault('force', {'global_mult': 0.4, 'drag': 0.5,
                                'strafe': 0.2, 'axial': 0.37})
    config.setdefault('misc', {'lateral': -0.7, 'hazard_rate': 0.0,
                               'cohorts': 1, 'mutation_seed': 0.5})
    config.setdefault('force2', {'gravity_force': 0.0, 'gravity_strafe': 0.0,
                                 'initial_conditions': 2,
                                 'cohort_fences': 0.0})
    config.setdefault('misc2', {'color_sensitivity': 0.5,
                                'color_by_cohort': False,
                                'sensor_angle_jitter': 0.0,
                                'sensor_distance_jitter': 0.0})
    config.setdefault('misc3', {'radial_gravity': False})
    config.update(blocks)
    path.write_text(json.dumps({
        'version': 8,
        'world': {'trail_persistence': 0.94, 'trail_diffusion': 1.0,
                  'boundary_conditions': 1},
        'configs': [config]}), encoding='utf-8')


def test_umap_sources():
    """The map can be built from the picture or from the config's numbers."""
    print("\nUMAP sources")

    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        good = root / 'a.json'
        _write_config(good)

        rule_only = gallery_lib.config_features(good, include_sliders=False)
        with_sliders = gallery_lib.config_features(good, include_sliders=True)
        check("the rule alone is 80 dims", len(rule_only) == 80,
              str(len(rule_only)))
        expected = 80 + len(gallery_lib.SLIDER_FIELDS) \
            + len(gallery_lib.WORLD_FIELDS)
        check("rule+sliders adds the physics fields",
              len(with_sliders) == expected,
              f"{len(with_sliders)}, expected {expected}")
        check("and starts with the same rule",
              with_sliders[:80] == rule_only, "the blocks are misaligned")

        # Appearance and the seed must NOT be in there: palette is the same
        # confound grayscale removes from CLIP, and mutation_seed is a hash
        # input where nearby values mean nothing.
        blocks = {b for b, _ in gallery_lib.SLIDER_FIELDS}
        keys = {k for _, k in gallery_lib.SLIDER_FIELDS}
        check("colour is excluded",
              'color_sensitivity' not in keys and 'color_by_cohort' not in keys,
              str(sorted(keys)))
        check("mutation_seed is excluded", 'mutation_seed' not in keys)
        check("world settings are included",
              'trail_persistence' in gallery_lib.WORLD_FIELDS)

        # A folder assembled by hand may hold anything; one bad file must not
        # stop a map of thousands.
        bad = root / 'bad.json'
        bad.write_text('{ not json', encoding='utf-8')
        check("a malformed config returns None",
              gallery_lib.config_features(bad, False) is None)
        check("a missing file returns None",
              gallery_lib.config_features(root / 'nope.json', False) is None)

        short = root / 'short.json'
        _write_config(short, rule=[0.0] * 40)
        check("a wrong-length rule returns None",
              gallery_lib.config_features(short, False) is None)

    print("\n  standardization")
    # Rule floats span about +-3 while drag sits near 0.5; without z-scoring
    # the widest-ranging column decides the layout regardless of meaning.
    raw_matrix = np.array([[100.0, 0.50, 5.0],
                           [200.0, 0.51, 5.0],
                           [300.0, 0.52, 5.0]], np.float32)
    out = gallery_lib._standardize(raw_matrix)
    norms = np.linalg.norm(out, axis=1)
    # Rows 0 and 2 are off-centre and come out unit length. Row 1 is exactly
    # the mean of every column, so it centres to the zero vector and has no
    # direction to normalize -- it stays at the origin rather than being
    # pushed somewhere arbitrary.
    check("off-centre rows come out unit length",
          np.allclose(norms[[0, 2]], 1.0), str(norms))
    check("a perfectly average row stays at the origin",
          norms[1] < 1e-6, str(norms[1]))
    # The two varying columns had wildly different scales but identical
    # SHAPE, so after standardizing they must contribute equally.
    check("columns are put on equal footing",
          abs(abs(out[0, 0]) - abs(out[0, 1])) < 1e-5,
          f"{out[0, 0]:.4f} vs {out[0, 1]:.4f}")
    check("a constant column contributes nothing",
          np.allclose(out[:, 2], 0.0), str(out[:, 2]))
    check("an empty matrix is handled",
          gallery_lib._standardize(np.zeros((0, 3), np.float32)).size == 0)

    print("\n  source selection")
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        items = []
        for i in range(4):
            config = root / f"{i}.json"
            _write_config(config, rule=[float(i)] * 80)
            items.append(gallery_lib.Item(path=root / f"{i}.png", index=i,
                                          config_path=str(config)))
        gallery = gallery_lib.Gallery(
            items=items, embeddings=np.eye(4, 6, dtype=np.float32),
            root=root)

        clip = gallery_lib.source_embeddings(gallery, gallery_lib.SOURCE_CLIP)
        check("the clip source returns the embeddings untouched",
              clip.shape == (4, 6), str(clip.shape))

        rule = gallery_lib.source_embeddings(gallery, gallery_lib.SOURCE_RULE)
        check("the rule source reads the configs", rule.shape == (4, 80),
              str(rule.shape))
        both = gallery_lib.source_embeddings(
            gallery, gallery_lib.SOURCE_RULE_SLIDERS)
        check("rule+sliders is wider", both.shape[1] > rule.shape[1],
              f"{both.shape} vs {rule.shape}")

        # An item with no config still gets a row rather than shifting every
        # later item's index -- it lands at the origin, which is honest.
        items.append(gallery_lib.Item(path=root / 'x.png', index=4))
        gallery.embeddings = np.eye(5, 6, dtype=np.float32)
        rows = gallery_lib.source_embeddings(gallery, gallery_lib.SOURCE_RULE)
        check("an item with no config still gets a row",
              rows.shape == (5, 80), str(rows.shape))
        # Row count and ordering are what matter: a missing config must not
        # shift every later item's index, which would mis-label the whole map.
        check("and the rows stay aligned with the items",
              len(rows) == len(gallery.items), str(len(rows)))
        check("rows carry real values rather than being all-zero",
              float(np.abs(rows).max()) > 0.0, str(np.abs(rows).max()))


def test_config_gallery():
    """A gallery from a folder of save files: no images, no embedding."""
    print("\nconfig-folder gallery")

    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        for i in range(4):
            _write_config(root / f"cfg{i}.json", rule=[float(i)] * 80)
        # Things a real folder contains that are not configs.
        (root / 'notes.txt').write_text('ignore me')
        (root / 'search.json').write_text('{"generations": 3}')
        (root / 'broken.json').write_text('{ not json')

        found = gallery_lib.find_configs(root)
        check("finds the json files", len(found) == 5, str(len(found)))
        # search.json lives beside the configs in a run folder; including it
        # would put one unreadable point on every map.
        check("skips search.json",
              not any(p.name == 'search.json' for p in found),
              str([p.name for p in found]))

        gallery = gallery_lib.build_configs(root, progress=lambda m: None)
        check("builds a gallery of the readable ones", len(gallery) == 4,
              str(len(gallery)))
        check("marked as having no images", not gallery.has_images)
        check("items know it too",
              all(not i.has_image for i in gallery.items))
        check("every item carries its config path",
              all(i.config_path for i in gallery.items))
        check("indices are contiguous after skipping the bad one",
              [i.index for i in gallery.items] == [0, 1, 2, 3],
              str([i.index for i in gallery.items]))
        check("the tooltip is just the filename",
              gallery.items[0].tooltip_lines() == ['cfg0'],
              str(gallery.items[0].tooltip_lines()))

        # CLIP cannot map a folder with no pictures; refusing beats producing
        # a plausible map of nothing.
        try:
            gallery_lib.source_embeddings(gallery, gallery_lib.SOURCE_CLIP)
            check("the clip source is refused", False, "no error raised")
        except ValueError as e:
            check("the clip source is refused", 'Rule' in str(e), str(e))

        rule = gallery_lib.source_embeddings(gallery, gallery_lib.SOURCE_RULE)
        check("the rule source works", rule.shape == (4, 80), str(rule.shape))
        both = gallery_lib.source_embeddings(
            gallery, gallery_lib.SOURCE_RULE_SLIDERS)
        check("rule+sliders works too", both.shape[1] > 80, str(both.shape))

        empty = root / 'empty'
        empty.mkdir()
        try:
            gallery_lib.build_configs(empty, progress=lambda m: None)
            check("an empty folder raises", False, "no error")
        except FileNotFoundError:
            check("an empty folder raises", True)

    print("\n  viewer wiring")
    from pilot.umap_view import COLOUR_PLAIN, Viewer

    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        for i in range(3):
            _write_config(root / f"c{i}.json", rule=[float(i)] * 80)

        view = Viewer()
        view.source = gallery_lib.SOURCE_CLIP
        view.load_config_folder(root)
        check("loads without a background task", view.gallery is not None)
        # Leaving the dropdown on CLIP would mean the only thing the user can
        # press next produces an error.
        check("switches away from the clip source",
              view.source == gallery_lib.SOURCE_RULE, view.source)
        check("clears any previous projection", view.projection is None)
        check("has no backend to caption with", view.backend is None)
        check("colours plainly", view.colour_mode == COLOUR_PLAIN)
        check("says what to do next",
              'Compute UMAP' in view.status, view.status)

        view.load_config_folder(root / 'nowhere')
        check("a missing folder is reported, not raised",
              'not a folder' in view.status, view.status)


def test_legacy_configs():
    """v7 files must map too -- they are most of a real library.

    Measured on the live configs/custom: 188 of 192 files are the original
    Fluoddity format, whose layout shares nothing with v8 (physics and rule at
    the top level, no `configs` array at all). A reader that only understood
    v8 mapped four of them and silently dropped the rest.
    """
    print("\nlegacy v7 configs")

    custom = ROOT / 'configs' / 'custom'
    if not custom.is_dir():
        print("  (configs/custom missing; skipped)")
        return

    files = sorted(custom.glob('*.json'))
    if not files:
        print("  (no configs to read; skipped)")
        return

    readable = [p for p in files
                if gallery_lib.config_features(p, include_sliders=False)
                is not None]
    ratio = len(readable) / len(files)
    check(f"reads most of the library ({len(readable)}/{len(files)})",
          ratio > 0.9, f"only {ratio:.0%} readable -- v7 support regressed?")

    # The two readers must agree exactly, or which one ran would move points
    # on the map.
    import json as _json

    v8 = [p for p in readable
          if _json.loads(p.read_text(encoding='utf-8')).get('version') == 8]
    if not v8:
        print("  (no v8 files to cross-check)")
        return

    mismatched = []
    for path in v8:
        via_app = gallery_lib._features_via_persistence(path, True)
        if via_app is None:
            continue
        direct = gallery_lib.config_features(path, True)
        if direct is None or len(direct) != len(via_app):
            mismatched.append(path.name)
            continue
        if float(np.abs(np.asarray(via_app) - np.asarray(direct)).max()) > 1e-6:
            mismatched.append(path.name)
    check("both reader paths agree on v8 files", not mismatched,
          str(mismatched[:3]))


def test_seed_folders():
    """seed_configs entries may be folders."""
    print("\nseed config folders")

    from pilot.config import SearchConfig

    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        folder = root / 'favourites'
        folder.mkdir()
        for name in ('c', 'a', 'b'):
            _write_config(folder / f"{name}.json")
        (folder / 'notes.txt').write_text('ignore me')
        loose = root / 'one.json'
        _write_config(loose)

        expand = SearchConfig.expand_seed_configs

        got = expand([str(folder)])
        check("a folder expands to its configs", len(got) == 3, str(len(got)))
        check("ignoring non-json", all(p.suffix == '.json' for p in got))
        check("sorted, so ids are stable between runs",
              [p.stem for p in got] == ['a', 'b', 'c'],
              str([p.stem for p in got]))

        check("a plain file still works", len(expand([str(loose)])) == 1)
        check("and the two can be mixed",
              len(expand([str(folder), str(loose)])) == 4)
        check("an empty list is empty", expand([]) == [])
        check("an empty folder is not an error", expand([str(root / 'gone')]))

        cfg = SearchConfig(seed_configs=[str(folder)])
        check("generation_zero_size counts the expansion",
              cfg.generation_zero_size == 3, str(cfg.generation_zero_size))
        # A folder reported as "1 seed config" understates a run by however
        # many files are in it.
        check("describe_plan counts them too",
              '3 seed config' in cfg.describe_plan(), cfg.describe_plan())


def test_default_paths():
    """The GUI opens pre-filled with the paths a session usually wants."""
    print("\ndefault paths")

    from pilot.umap_view import (DEFAULT_CONFIG, DEFAULT_FOLDER,
                                 KNOWN_CONFIGS, Viewer)

    view = Viewer()
    check("the folder field is pre-filled",
          view.folder == DEFAULT_FOLDER, view.folder)
    check("the config field is pre-filled",
          view.config_path == DEFAULT_CONFIG, view.config_path)
    check("the shipped presets are offered",
          'search.json' in KNOWN_CONFIGS and 'fan_search.json' in KNOWN_CONFIGS,
          str(KNOWN_CONFIGS))

    # Defaults only: nothing is loaded until Load is pressed.
    check("nothing is loaded on construction", view.gallery is None)

    # A bad config path reports rather than raising into the frame loop.
    check("a missing config is reported, not raised",
          view._load_config('definitely/not/here.json') is False
          and 'could not read' in view.status, view.status)


def test_lazy_reconnect():
    """A viewer opened before the app must still find it later.

    THE BUG: the client was probed once, in main(), and never again. Opening
    the pilot before Fluoddity -- or during its shader compile, which is most
    of a cold start -- left client=None for the whole session, so every click
    said "no app connected" however long the app had been up by then. Only
    restarting the pilot fixed it.

    Faked rather than run against a live app: the test suite must pass with
    nothing listening, which is exactly the state the bug was invisible in.
    """
    print("\nlazy reconnect")

    from pilot import client as client_lib
    from pilot.umap_view import Viewer

    calls = {'built': 0, 'health': 0, 'loaded': []}

    class FakeClient:
        """Stands in for a running app, or a missing one."""

        up = True

        def __init__(self, port=8765, **kw):
            calls['built'] += 1
            self.port = port

        def health(self):
            calls['health'] += 1
            if not FakeClient.up:
                raise OSError("nothing listening")
            return {'ok': True}

        def load_config(self, path):
            if not FakeClient.up:
                raise OSError("gone away")
            calls['loaded'].append(str(path))
            return {'ok': True}

    original = client_lib.FluoddityClient
    client_lib.FluoddityClient = FakeClient
    try:
        # The broken state: constructed with no client, app already running.
        FakeClient.up = True
        view = Viewer(client=None, port=8765)
        check("starts with no client", view.client is None)
        check("re-probes and finds the app", view._connected() is not None)
        check("the probe is a health call", calls['health'] == 1)

        # Cached: a click should cost one request, not two.
        before = calls['built']
        view._connected()
        check("a live client is reused, not rebuilt", calls['built'] == before)

        # A missing app must stay None and must not raise into the frame loop.
        FakeClient.up = False
        absent = Viewer(client=None, port=8765)
        check("an absent app returns None", absent._connected() is None)
        check("and caches nothing, so it retries next click",
              absent.client is None)

        # ...and is picked up as soon as it appears, with no restart.
        FakeClient.up = True
        check("the same viewer connects once the app starts",
              absent._connected() is not None)

        # The real click path, through _send_config rather than _activate: the
        # latter's fallback calls imgui.set_clipboard_text, which segfaults the
        # interpreter outright when no imgui context exists (measured: exit
        # 0xC0000005), and would take this whole suite down with it.
        FakeClient.up = True
        live = Viewer(client=None, port=8765)
        check("a click reaches a running app",
              live._send_config('configs/x.json') is True)
        check("and sends the config", calls['loaded'] == ['configs/x.json'],
              str(calls['loaded']))
        check("the status says so", 'loaded' in live.status, live.status)

        # A client that dies mid-session is dropped rather than kept dead, so
        # the next click re-probes instead of failing against a corpse forever.
        FakeClient.up = False
        check("a failed send reports failure",
              live._send_config('configs/y.json') is False)
        check("and drops the dead client", live.client is None)
        FakeClient.up = True
        check("so the next click reconnects",
              live._send_config('configs/z.json') is True)

        # With nothing listening at all, the message must name the port rather
        # than claim the app is missing forever.
        FakeClient.up = False
        cold = Viewer(client=None, port=8765)
        check("no app is a status line, not an exception",
              cold._send_config('configs/x.json') is False)
        check("and it names the port", '8765' in cold.status, cold.status)
    finally:
        client_lib.FluoddityClient = original


def test_signature_decode():
    print("\nsignature decoding")

    # The four signatures found in a real 1.07GB archive.
    real = [
        'clip:ViT-B-32:laion2b_s34b_b79k:c4:f0.4:s0:gray',
        'clip:ViT-SO400M-14-SigLIP-384:webli:c4:f0.4:s0:gray',
        'clip:ViT-SO400M-14-SigLIP-384:webli:c4:f0.4:s0',
        'clip:ViT-B-32:laion2b_s34b_b79k:c10:f0.3:s0:gray',
    ]
    for signature in real:
        settings = cache_lib.parse_signature(signature)
        check(f"decodes {signature[:38]}", settings is not None)
        # The property that makes "adopt this set's settings" safe: a decoded
        # set re-emits its own key byte for byte, so adopting it cannot
        # silently point at a different set.
        check("and round-trips exactly",
              cache_lib.signature_for(settings) == signature,
              cache_lib.signature_for(settings))

    so400m = cache_lib.parse_signature(real[1])
    check("architecture resolves to the short key",
          so400m.clip_model == 'SO400M', so400m.clip_model)
    check("grayscale is read off the flag", so400m.grayscale is True)
    check("and its absence is read too",
          cache_lib.parse_signature(real[2]).grayscale is False)
    colour = cache_lib.parse_signature(real[3])
    check("crops and crop_frac decode",
          (colour.crops, colour.crop_frac) == (10, 0.3),
          f"{colour.crops} {colour.crop_frac}")

    # signature_for must agree with ClipBackend.signature(), which is the
    # encoder. Two functions spelling one string drift unless something says
    # so. ClipBackend's __init__ only stores fields, so this needs no torch.
    for signature in real:
        settings = cache_lib.parse_signature(signature)
        backend = tex_sim.ClipBackend(
            model_name=settings.architecture, pretrained=settings.pretrained,
            crops=settings.crops, crop_frac=settings.crop_frac,
            seed=settings.seed, grayscale=settings.grayscale)
        check("agrees with ClipBackend.signature()",
              backend.signature() == signature, backend.signature())

    check("a label names the model and the settings",
          cache_lib.label_signature(real[1])
          == 'SO400M, 4 crops @0.40, seed 0, grayscale',
          cache_lib.label_signature(real[1]))
    for bad in ['texture:512:r8:a8:e8:h8', 'garbage', '', 'clip:X',
                'clip:A:B:cZZ']:
        check(f"not ours -> None ({bad[:20] or 'empty'})",
              cache_lib.parse_signature(bad) is None)

    fields = cache_lib.parse_signature(real[1]).as_config_fields()
    check("adoptable fields are the cache-key ones only",
          set(fields) == {'backend', 'clip_model', 'crops', 'crop_frac',
                          'seed', 'grayscale'}, str(sorted(fields)))


def test_cache_inventory():
    print("\ncache inventory")

    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        make_images(root, ['a', 'b', 'c'])
        paths = gallery_lib.find_images(root)
        cache = cache_lib.EmbeddingCache(root)

        grey = CountingBackend(signature='clip:ViT-B-32:x:c4:f0.4:s0:gray')
        colour = CountingBackend(signature='clip:ViT-B-32:x:c4:f0.4:s0')
        cache_lib.embed_cached(paths, grey, cache)
        cache_lib.embed_cached(paths[:1], colour, cache)

        found = {i.signature: i for i in cache.inventory(paths)}
        check("both sets are listed", len(found) == 2, str(list(found)))
        full = found[grey.signature()]
        part = found[colour.signature()]
        check("a full set reads complete", full.complete and not full.partial,
              f"{full.covered}/{full.total}")
        check("a partial set reads partial", part.partial and not part.complete,
              f"{part.covered}/{part.total}")
        check("and reports what is missing", part.missing == 2,
              str(part.missing))
        check("most-covered comes first",
              cache.inventory(paths)[0].signature == grey.signature())

        # THE REAL BUG. A file rewritten well after its first embedding gets
        # an mtime outside the copy slack, so the old row becomes unreachable
        # and the set holds more rows than the folder has images. `entries`
        # must show that while `covered` stays honest. Backdating the ORIGINAL
        # rather than sleeping keeps the test instant and the gap unambiguous.
        for path in gallery_lib.find_images(root):
            old = (path.stat().st_mtime_ns // 1_000_000_000 - 600) * 10**9
            os.utime(path, ns=(old, old))
        aged = cache_lib.EmbeddingCache(root)
        cache_lib.embed_cached(gallery_lib.find_images(root), grey, aged)
        cache = aged
        after = {i.signature: i for i in cache.inventory(
            gallery_lib.find_images(root))}[grey.signature()]
        check("an out-of-slack rewrite leaves stale rows",
              after.entries > after.covered,
              f"entries={after.entries} covered={after.covered}")
        check("but coverage is still right", after.covered == 3,
              str(after.covered))
        check("and the set still reads complete", after.complete)

        # Four: three orphaned grey rows, plus the one colour row, which was
        # embedded before the backdating and is now unreachable too.
        dropped = cache.prune(gallery_lib.find_images(root))
        check("prune drops the stale rows", dropped == 4, str(dropped))

        # A DUPLICATE IS NOT AN ORPHAN. Shift the mtimes by one second -- a
        # copy, not a rewrite -- and re-embed: the new rows match within the
        # slack, so both are reachable and prune correctly leaves them. Only
        # the first is ever read, so compact() is what reclaims the rest.
        # Measured on a real archive: 12,583 such pairs that prune could not
        # touch, and a third of a gigabyte.
        for path in gallery_lib.find_images(root):
            shifted = ((path.stat().st_mtime_ns // 1_000_000_000) + 1) * 10**9
            os.utime(path, ns=(shifted, shifted))
        doubled = cache_lib.EmbeddingCache(root)
        for key in list(doubled._entries):
            name, size, mtime, signature = cache_lib._parse_key(key)
            doubled._entries[f"{name}|{size}|{mtime + 1}|{signature}"] = \
                doubled._entries[key]
        doubled._by_identity = None
        live = gallery_lib.find_images(root)
        check("both copies are reachable",
              doubled.prune(live) == 0, "prune dropped reachable rows")
        collapsed = doubled.compact()
        check("compact drops the duplicates", collapsed == 3, str(collapsed))
        after_compact = doubled.inventory(live)[0]
        check("and leaves one row per image",
              after_compact.entries == after_compact.covered,
              f"{after_compact.entries} rows for {after_compact.covered}")
        hits, misses = doubled.lookup(live, grey.signature())
        check("the images still load", len(hits) == 3 and not misses,
              f"{len(hits)} hits")
        pruned = {i.signature: i for i in cache.inventory(
            gallery_lib.find_images(root))}[grey.signature()]
        check("and the live ones survive", pruned.covered == 3,
              str(pruned.covered))
        check("with no rows to spare", pruned.entries == pruned.cached,
              f"{pruned.entries} {pruned.cached}")


def test_copied_folder_still_hits():
    print("\na copied folder still hits the cache")

    # WHY. A copy, sync or unzip rewrites mtimes: sub-second precision is
    # lost, and FAT/SMB rounds to a 2-second boundary besides. Measured on a
    # real folder, all 25,100 captures came back with a whole-second mtime and
    # half of those a further second off -- which orphaned all 84,261 cached
    # vectors at once and re-embedded a folder embedded the day before.
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        make_images(root, ['a', 'b'])
        paths = gallery_lib.find_images(root)
        cache = cache_lib.EmbeddingCache(root)
        backend = CountingBackend()
        cache_lib.embed_cached(paths, backend, cache)
        check("embedded once", backend.calls == 2, str(backend.calls))

        for path in paths:                      # as a copy would
            stat = path.stat()
            shifted = ((stat.st_mtime_ns // 1_000_000_000) + 1) * 1_000_000_000
            os.utime(path, ns=(shifted, shifted))

        reopened = cache_lib.EmbeddingCache(root)
        hits, misses = reopened.lookup(paths, backend.signature())
        check("a shifted mtime still hits", len(hits) == 2 and not misses,
              f"{len(hits)} hits, {len(misses)} misses")

        cache_lib.embed_cached(paths, backend, reopened)
        check("so nothing is re-embedded", backend.calls == 2,
              str(backend.calls))

        # The slack must not swallow a genuine rewrite: that is what the size
        # and mtime were for in the first place.
        time.sleep(1.1)
        make_images(root, ['a'], size=64)
        fresh = CountingBackend()
        cache_lib.embed_cached(gallery_lib.find_images(root), fresh,
                               cache_lib.EmbeddingCache(root))
        check("but a real rewrite is re-embedded", fresh.calls == 1,
              str(fresh.calls))


def test_build_cached_loads_no_model():
    print("\nloading cached vectors builds no backend")

    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        make_images(root, ['a', 'b', 'c'])
        paths = gallery_lib.find_images(root)
        backend = CountingBackend()
        cache_lib.embed_cached(paths, backend,
                               cache_lib.EmbeddingCache(root))

        # THE GUARANTEE THE PICKER RESTS ON. build() loads the model on its
        # first line; for SO400M that is 3.5GB before it looks at anything.
        # If anyone reintroduces a backend build on the load path, this fails
        # loudly rather than costing the user ten minutes.
        original = embedding_lib.build_backend
        embedding_lib.build_backend = lambda cfg: (_ for _ in ()).throw(
            AssertionError("build_backend was called"))
        try:
            gallery, missing = gallery_lib.build_cached(
                root, backend.signature(), progress=lambda m: None)
        finally:
            embedding_lib.build_backend = original

        check("a gallery loads with no backend", len(gallery) == 3,
              str(len(gallery)))
        check("nothing is missing", not missing, str(missing))
        check("the crop axis is collapsed", gallery.embeddings.ndim == 2,
              str(gallery.embeddings.shape))
        check("and it records which set it is",
              gallery.signature == backend.signature())

        partial, left = gallery_lib.build_cached(
            root, backend.signature(), progress=lambda m: None)
        check("a second load is identical", len(partial) == 3)

        try:
            gallery_lib.build_cached(root, 'clip:nothing:here:c1:f0.3:s0',
                                     progress=lambda m: None)
            check("an absent set raises", False, "no error")
        except LookupError:
            check("an absent set raises", True)


def test_configs_pair_by_name():
    print("\npairing captures with configs by name")

    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        captures = root / 'captures'
        configs = root / 'configs'
        make_images(captures, ['gen000_000', 'gen000_001', 'gen000_002'])
        configs.mkdir()
        for name in ['gen000_000', 'gen000_001']:
            (configs / f"{name}.json").write_text('{}', encoding='utf-8')

        # A manifest describing only the FIRST capture, which is the real
        # case: 25,100 captures and a manifest holding one stale row, with
        # every config sitting on disk unreferenced.
        (root / 'manifest.jsonl').write_text(json.dumps({
            'id': 'gen000_000', 'score': 0.5, 'generation': 0,
            'config_path': str(configs / 'gen000_000.json')}) + '\n',
            encoding='utf-8')

        items = [gallery_lib.Item(path=p, index=i, has_image=True)
                 for i, p in enumerate(gallery_lib.find_images(captures))]
        gallery_lib._enrich(items, captures, progress=lambda m: None)
        by_name = {item.name: item for item in items}

        check("the manifest row still wins",
              by_name['gen000_000'].score == 0.5,
              str(by_name['gen000_000'].score))
        check("a capture with no row finds its config anyway",
              by_name['gen000_001'].config_path.endswith('gen000_001.json'),
              by_name['gen000_001'].config_path)
        check("but no config on disk stays empty",
              by_name['gen000_002'].config_path == '',
              by_name['gen000_002'].config_path)
        # Only the manifest carries these, so a paired item must not pretend.
        check("pairing invents no score",
              by_name['gen000_001'].score is None,
              str(by_name['gen000_001'].score))

        check("configs/ is found beside the captures folder",
              gallery_lib.find_configs_dir(captures) == configs)
        check("and inside it when that is what was opened",
              gallery_lib.find_configs_dir(root) == configs)
        # A folder with no configs/ beside it AND none within. Note the sibling
        # lookup means any path under the run root finds the run's configs/,
        # which is the intended reach -- so this has to be somewhere else.
        with tempfile.TemporaryDirectory() as elsewhere:
            check("absent when there is none",
                  gallery_lib.find_configs_dir(
                      Path(elsewhere) / 'sub') is None)

        # No manifest at all is the other half of the same case.
        (root / 'manifest.jsonl').unlink()
        fresh = [gallery_lib.Item(path=p, index=i, has_image=True)
                 for i, p in enumerate(gallery_lib.find_images(captures))]
        gallery_lib._enrich(fresh, captures, progress=lambda m: None)
        check("pairing works with no manifest at all",
              sum(1 for i in fresh if i.config_path) == 2,
              str(sum(1 for i in fresh if i.config_path)))


def test_caption_loads_the_model_on_demand():
    print("\na caption loads the model, typing does not")

    from pilot.umap_view import Viewer

    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        make_images(root, ['a', 'b'])
        signature = 'clip:ViT-B-32:laion2b_s34b_b79k:c1:f0.3:s0'
        cache_lib.embed_cached(gallery_lib.find_images(root),
                               CountingBackend(signature=signature),
                               cache_lib.EmbeddingCache(root))

        view = Viewer()
        view.folder = str(root)
        view.gallery, _ = gallery_lib.build_cached(
            root, signature, progress=lambda m: None)
        view.backend = None
        view.caption = 'a maze'

        # A PAUSE IN TYPING IS NOT A REQUEST TO LOAD 3.5GB. Live recolour
        # calls this on the frame thread every time typing stops, so the
        # default has to stay passive.
        view.apply_caption()
        check("typing alone does not load a model", view.task is None)
        check("and says which button would",
              'Recompute' in view.status, view.status)

        # The button may. Assert the model it asks for comes from the loaded
        # VECTORS, not the config -- the config can say anything by now, and
        # a caption scored against another model's text is a meaningless
        # cosine that looks entirely plausible.
        asked = {}

        def fake_build(cfg):
            asked['clip_model'] = cfg.clip_model
            asked['crops'] = cfg.crops
            # dim must match the cached vectors (CountingBackend's 8), or the
            # cosine is a shape error the caller reports as a status line.
            return FakeTextBackend({'a maze': np.ones(8, np.float32)},
                                   dim=8, signature=signature)

        original = embedding_lib.build_backend
        embedding_lib.build_backend = fake_build
        try:
            view.cfg = replace(view.cfg, clip_model='SO400M', crops=9)
            view.apply_caption(may_load=True)
            check("the button starts a load", view.task_kind == 'textmodel',
                  view.task_kind)
            while view.busy:
                time.sleep(0.01)
            view._collect()
        finally:
            embedding_lib.build_backend = original

        check("it loads the model that made these vectors",
              asked.get('clip_model') == 'B32', str(asked))
        check("with their crops, not the config's",
              asked.get('crops') == 1, str(asked))
        # The point is that the load flows straight back into the caption --
        # the reader waited once and got their colours, rather than being
        # returned to a loaded model and an unchanged map. (Every cached
        # vector here is identical, so the SCORES are uniform; that is the
        # fixture, not the feature.)
        check("and the caption is applied without pressing twice",
              view.caption_applied == 'a maze', view.caption_applied)
        check("so the map is coloured",
              view.caption_scores is not None
              and len(view.caption_scores) == 2,
              str(view.caption_scores))
        from pilot.umap_view import COLOUR_CAPTION
        check("and the colour mode switched to it",
              view.colour_mode == COLOUR_CAPTION, view.colour_mode)


def test_picker_adopts_settings():
    print("\nselecting a set adopts its settings")

    from pilot.umap_view import Viewer

    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        make_images(root, ['a', 'b'])
        paths = gallery_lib.find_images(root)
        cache = cache_lib.EmbeddingCache(root)
        so400m = 'clip:ViT-SO400M-14-SigLIP-384:webli:c4:f0.4:s0:gray'
        cache_lib.embed_cached(paths, CountingBackend(signature=so400m), cache)

        # A config that disagrees with the archive on every vision field --
        # the situation that used to mean "re-embed everything".
        config = root / 'search.json'
        config.write_text(json.dumps({
            'backend': 'clip', 'clip_model': 'B32', 'crops': 1,
            'crop_frac': 0.3, 'grayscale': False, 'seed': 7,
            'captions': ['a maze']}), encoding='utf-8')

        view = Viewer()
        view.folder = str(root)
        view.config_path = str(config)
        view._load_config(str(config))
        check("the file's model is in force at first",
              view.cfg.clip_model == 'B32', view.cfg.clip_model)

        view.inventory = view._scan_folder(root)
        check("the scan finds the set", len(view.inventory) == 1,
              str(len(view.inventory)))

        info = view.inventory[0]
        view.selected_signature = info.signature
        view._apply_model_choice()
        check("selecting adopts the model", view.cfg.clip_model == 'SO400M',
              view.cfg.clip_model)
        check("and the crops", view.cfg.crops == 4, str(view.cfg.crops))
        check("and grayscale", view.cfg.grayscale is True)
        check("and the seed", view.cfg.seed == 0, str(view.cfg.seed))

        # THE BUG THIS GUARDS. Every action re-reads the config file first, so
        # without the selection winning, Re-score would silently act on the
        # file's settings and re-embed the whole folder.
        view._refresh_config()
        check("a re-read does not revert the selection",
              view.cfg.clip_model == 'SO400M' and view.cfg.crops == 4,
              f"{view.cfg.clip_model} c{view.cfg.crops}")
        check("scoring fields still come from the file",
              view.cfg.captions == ['a maze'], str(view.cfg.captions))

        view.selected_signature = ''
        view._refresh_config()
        check("with nothing selected the file is the truth again",
              view.cfg.clip_model == 'B32', view.cfg.clip_model)


def test_create_is_a_noop_when_complete():
    print("\ncreating a set that already exists")

    from pilot.umap_view import Viewer

    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        make_images(root, ['a', 'b'])
        paths = gallery_lib.find_images(root)
        cache = cache_lib.EmbeddingCache(root)
        signature = 'clip:ViT-B-32:laion2b_s34b_b79k:c1:f0.3:s0'
        cache_lib.embed_cached(paths, CountingBackend(signature=signature),
                               cache)

        config = root / 'search.json'
        config.write_text(json.dumps({
            'backend': 'clip', 'clip_model': 'B32', 'crops': 1,
            'crop_frac': 0.3, 'grayscale': False, 'seed': 0}),
            encoding='utf-8')

        view = Viewer()
        view.folder = str(root)
        view.config_path = str(config)
        view._load_config(str(config))
        view.inventory = view._scan_folder(root)

        check("the config's own settings decode to the stored key",
              cache_lib.signature_for(view._config_settings()) == signature,
              cache_lib.signature_for(view._config_settings()))

        original = embedding_lib.build_backend
        embedding_lib.build_backend = lambda cfg: (_ for _ in ()).throw(
            AssertionError("build_backend was called"))
        try:
            view._create_embeddings()
        finally:
            embedding_lib.build_backend = original

        check("it says so rather than re-embedding",
              'already' in view.status.lower(), view.status)
        check("and names the count", '2' in view.status, view.status)
        check("and selects the set instead",
              view.selected_signature == signature, view.selected_signature)


def main():
    print("Gallery and projection")
    test_find_images()
    test_embedding_cache()
    test_signature_decode()
    test_configs_pair_by_name()
    test_caption_loads_the_model_on_demand()
    test_picker_adopts_settings()
    test_create_is_a_noop_when_complete()
    test_cache_inventory()
    test_copied_folder_still_hits()
    test_build_cached_loads_no_model()
    test_percentile_mask()
    test_manifest_enrichment()
    test_normalize()
    test_projection_edges()
    test_score_colour()
    test_view_transform()
    test_caption_colouring()
    test_disabled_pairing()
    test_progress_reporting()
    test_embed_progress()
    test_rescore_updates_the_view()
    test_live_recolor()
    test_config_auto_reload()
    test_umap_sources()
    test_config_gallery()
    test_legacy_configs()
    test_seed_folders()
    test_default_paths()
    test_lazy_reconnect()

    print()
    if _failures:
        print(f"FAIL  {len(_failures)} check(s): {', '.join(_failures)}")
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
