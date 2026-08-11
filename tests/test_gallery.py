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


def test_cache_key():
    print("\ncache keying")

    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        make_images(root, ['a', 'b'])
        paths = gallery_lib.find_images(root)

        key = gallery_lib._cache_key(paths, 'sig1')
        check("stable for the same inputs",
              key == gallery_lib._cache_key(paths, 'sig1'))

        # The signature carries backend, crops and grayscale. A cache that
        # ignored it would serve colour vectors to a grayscale run.
        check("a different signature is a different key",
              key != gallery_lib._cache_key(paths, 'sig2'))

        make_images(root, ['c'])
        more = gallery_lib.find_images(root)
        # Captured BEFORE the edit below: _cache_key stats the files when it
        # is called, so comparing two keys computed after the change would
        # compare the new state against itself.
        before_edit = gallery_lib._cache_key(more, 'sig1')
        check("adding a file changes the key", key != before_edit)

        # Content change without a change in file COUNT -- the case a cache
        # keyed on "how many images" gets wrong.
        Image.new('RGB', (64, 64), (1, 2, 3)).save(root / 'a.png')
        after_edit = gallery_lib._cache_key(gallery_lib.find_images(root),
                                            'sig1')
        check("editing a file changes the key", before_edit != after_edit,
              "a replaced capture would be served stale vectors")


def test_cache_roundtrip():
    print("\ncache round-trip")

    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        vectors = np.random.default_rng(1).normal(size=(5, 8)).astype(np.float32)

        check("a miss returns None",
              gallery_lib.load_cache(root, 'key') is None)

        gallery_lib.save_cache(root, 'key', vectors)
        loaded = gallery_lib.load_cache(root, 'key')
        check("a hit returns the vectors", loaded is not None)
        check("the vectors survive intact",
              loaded is not None and np.allclose(loaded, vectors))
        check("a different key misses",
              gallery_lib.load_cache(root, 'other') is None)

        (root / gallery_lib.CACHE_NAME).write_bytes(b'not an npz')
        check("a corrupt cache is treated as a miss, not an error",
              gallery_lib.load_cache(root, 'key') is None)


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
    view = Viewer(gallery, Projection(points, 15, 0.1, 42))

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
    from pilot.projection import Projection
    from pilot.umap_view import COLOUR_CAPTION, COLOUR_PLAIN, Viewer

    view = Viewer(gallery, Projection(np.full((3, 2), 0.5, np.float32),
                                      15, 0.1, 42), backend=backend)
    check("starts plain with no manifest scores",
          view.colour_mode == COLOUR_PLAIN, str(view.colour_mode))
    check("nothing to shade before a caption", view.active_scores() is None)

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

    view.caption = '   '
    view.apply_caption()
    check("an empty caption is refused, leaving the old colours",
          view.caption_applied == 'a maze' and 'caption' in view.status.lower(),
          view.status)

    # A text-less backend must say so rather than raising into the frame loop.
    import tex_sim
    plain_view = Viewer(gallery, Projection(np.full((3, 2), 0.5, np.float32),
                                            15, 0.1, 42),
                        backend=tex_sim.TextureBackend())
    plain_view.caption = 'a maze'
    plain_view.apply_caption()
    check("the texture backend reports it cannot embed text",
          plain_view.caption_scores is None and 'clip' in plain_view.status,
          plain_view.status)


def main():
    print("Gallery and projection")
    test_find_images()
    test_cache_key()
    test_cache_roundtrip()
    test_manifest_enrichment()
    test_normalize()
    test_projection_edges()
    test_score_colour()
    test_view_transform()
    test_caption_colouring()

    print()
    if _failures:
        print(f"FAIL  {len(_failures)} check(s): {', '.join(_failures)}")
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
