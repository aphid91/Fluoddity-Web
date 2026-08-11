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


def main():
    print("Gallery and projection")
    test_find_images()
    test_cache_key()
    test_cache_roundtrip()
    test_manifest_enrichment()
    test_normalize()
    test_projection_edges()
    test_score_colour()

    print()
    if _failures:
        print(f"FAIL  {len(_failures)} check(s): {', '.join(_failures)}")
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
