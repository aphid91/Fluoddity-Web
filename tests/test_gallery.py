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
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from pilot import gallery as gallery_lib                          # noqa: E402
from pilot import projection as projection_lib                    # noqa: E402

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

    def __init__(self, vectors, dim=32):
        self.vectors = vectors
        self.dim = dim
        self.grayscale = False
        axis = np.zeros(dim, dtype=np.float32)
        axis[-1] = 1.0
        self._generic = axis

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

    gallery = gallery_lib.Gallery(
        items=[gallery_lib.Item(path=Path(f"{i}.png"), index=i)
               for i in range(3)],
        embeddings=images, root=Path('.'))

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
    check("the texture backend reports it cannot embed text",
          plain_view.caption_scores is None and 'clip' in plain_view.status,
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


def main():
    print("Gallery and projection")
    test_find_images()
    test_embedding_cache()
    test_percentile_mask()
    test_manifest_enrichment()
    test_normalize()
    test_projection_edges()
    test_score_colour()
    test_view_transform()
    test_caption_colouring()
    test_disabled_pairing()
    test_default_paths()

    print()
    if _failures:
        print(f"FAIL  {len(_failures)} check(s): {', '.join(_failures)}")
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
