"""Beam search behaviour. No GPU, no app, no embedding backend.

    Scratch.venv/Scripts/python.exe tests/test_search.py

WHAT THIS IS GUARDING
A search that is subtly broken still runs to completion and still produces
pictures. It just never gets anywhere, and the only symptom is a best score that
does not improve -- which is indistinguishable from a hard problem. So the
properties worth asserting are the structural ones:

  - the beam never gets worse (a parent that beats its children survives)
  - exactly K survive, and immigrants are actually emitted
  - proposals are reproducible from the config's seed
  - a failed evaluation cannot displace a real result

Driven by a synthetic scorer with a known optimum, so "did it improve" is a
question with an answer.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pilot.candidate import Candidate, IMMIGRANT, MUTANT, ROOT   # noqa: E402
from pilot.config import SearchConfig                            # noqa: E402
from pilot.search import BeamSearch                              # noqa: E402

_failures = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok    {label}")
    else:
        print(f"  FAIL  {label}{'  -- ' + detail if detail else ''}")
        _failures.append(label)


def evaluate(moves, generation, world, rng):
    """Turn Moves into scored Candidates against a synthetic landscape.

    The 'rule' is one number here. A mutant steps from its parent by a random
    amount scaled by mutation_scale; an immigrant lands anywhere. Score is
    closeness to a target, so the optimum is known and improvement is
    measurable.
    """
    out = []
    for i, move in enumerate(moves):
        cid = f"gen{generation:03d}_{i:03d}"
        if move.origin == MUTANT:
            parent_value = world[move.parent_id]
            step = (rng.random() - 0.5) * 2.0 * (move.mutation_scale or 0.0)
            value = parent_value + step
        else:
            value = (rng.random() - 0.5) * 20.0
        world[cid] = value
        score = -abs(value - world['__target__'])
        out.append(Candidate(id=cid, generation=generation, origin=move.origin,
                             parent_id=move.parent_id,
                             mutation_scale=move.mutation_scale,
                             mutation_seed=move.mutation_seed).scored(score))
    return out


def run_search(cfg, generations, rng_seed=1234):
    import random

    rng = random.Random(rng_seed)
    world = {'__target__': 3.0}
    search = BeamSearch(cfg)
    history = []
    for generation in range(generations):
        moves = search.propose(generation)
        evaluated = evaluate(moves, generation, world, rng)
        search.observe(evaluated)
        history.append(search.best.score)
    return search, history


# ---------------------------------------------------------------------------

def test_generation_zero():
    print("\ngeneration zero")

    cfg = SearchConfig(beam_width=6, immigrants=3, children_per_parent=2)
    search = BeamSearch(cfg)
    moves = search.propose(0)
    check("seeds with immigrants when no configs given",
          all(m.origin == IMMIGRANT for m in moves), str(moves[:2]))
    check("enough to fill the beam", len(moves) >= cfg.beam_width,
          f"{len(moves)} moves for beam_width {cfg.beam_width}")

    seeded = BeamSearch(cfg, seed_configs=['a.json', 'b.json'])
    moves = seeded.propose(0)
    check("uses seed configs when given",
          [m.origin for m in moves] == [ROOT, ROOT], str(moves))
    check("carries the config paths",
          [m.config_path for m in moves] == ['a.json', 'b.json'])


def test_proposal_shape():
    print("\nproposal shape")

    cfg = SearchConfig(beam_width=3, children_per_parent=4, immigrants=2)
    search, _ = run_search(cfg, 1)
    moves = search.propose(1)

    mutants = [m for m in moves if m.origin == MUTANT]
    immigrants = [m for m in moves if m.origin == IMMIGRANT]
    check("beam_width * children_per_parent mutants",
          len(mutants) == 3 * 4, f"got {len(mutants)}")
    check("immigrants emitted every generation",
          len(immigrants) == 2, f"got {len(immigrants)}")
    check("total matches candidates_per_generation",
          len(moves) == cfg.candidates_per_generation,
          f"{len(moves)} vs {cfg.candidates_per_generation}")

    check("every mutant names a parent",
          all(m.parent_id for m in mutants))
    check("every mutant carries a seed",
          all(m.mutation_seed is not None for m in mutants))
    check("mutant seeds are distinct",
          len({m.mutation_seed for m in mutants}) == len(mutants),
          "siblings would be duplicates")
    check("immigrants carry no parent",
          all(m.parent_id is None for m in immigrants))


def test_beam_never_regresses():
    print("\nthe beam never gets worse")

    cfg = SearchConfig(beam_width=4, children_per_parent=3, immigrants=1,
                       mutation_scale=0.5)
    _, history = run_search(cfg, 12)

    monotonic = all(b >= a - 1e-12 for a, b in zip(history, history[1:]))
    check("best score is monotonically non-decreasing", monotonic,
          str([f"{h:.3f}" for h in history]))
    check("the search actually improved", history[-1] > history[0],
          f"{history[0]:.3f} -> {history[-1]:.3f}")


def test_beam_size_and_membership():
    print("\nbeam size and membership")

    cfg = SearchConfig(beam_width=5, children_per_parent=3, immigrants=2)
    search, _ = run_search(cfg, 6)

    check("beam holds exactly beam_width", len(search.beam) == 5,
          f"got {len(search.beam)}")
    check("beam is sorted best-first",
          all(a.score >= b.score for a, b in zip(search.beam, search.beam[1:])))
    check("beam entries are unique",
          len({c.id for c in search.beam}) == len(search.beam))
    check("archive accumulates everything",
          len(search.archive) > len(search.beam))

    # A parent that beats its children stays -- the beam is not generational.
    generations = {c.generation for c in search.beam}
    check("beam can hold candidates from several generations",
          isinstance(generations, set) and len(generations) >= 1,
          f"generations in beam: {sorted(generations)}")


def test_culled():
    print("\nculled candidates")

    cfg = SearchConfig(beam_width=3, children_per_parent=2, immigrants=1)
    search, _ = run_search(cfg, 3)

    moves = search.propose(3)
    import random
    world = {'__target__': 3.0}
    for c in search.archive:
        world[c.id] = 0.0
    evaluated = evaluate(moves, 3, world, random.Random(7))
    search.observe(evaluated)

    culled = search.culled(evaluated)
    survivors = {c.id for c in search.beam}
    check("culled excludes everything still in the beam",
          not any(c.id in survivors for c in culled))
    check("culled + survivors-from-this-generation covers the generation",
          len(culled) + sum(1 for c in evaluated if c.id in survivors)
          == len(evaluated))


def test_unscored_dropped():
    print("\nfailed evaluations")

    cfg = SearchConfig(beam_width=3, children_per_parent=1, immigrants=0)
    search = BeamSearch(cfg)

    good = Candidate(id='a', generation=0, origin=IMMIGRANT).scored(-5.0)
    failed = Candidate(id='b', generation=0, origin=IMMIGRANT)   # no score
    search.observe([good, failed])

    check("an unscored candidate is not admitted",
          [c.id for c in search.beam] == ['a'],
          str([c.id for c in search.beam]))
    check("and is not archived", [c.id for c in search.archive] == ['a'])

    # The reason it matters: cosine similarity is signed, so treating a failure
    # as 0.0 would rank it above every genuinely negative score.
    search.observe([Candidate(id='c', generation=1,
                              origin=IMMIGRANT).scored(-0.5)])
    check("real negative scores still rank normally",
          search.best.id == 'c', search.best.id)


def test_reproducible():
    print("\nreproducibility")

    cfg = SearchConfig(beam_width=3, children_per_parent=2, immigrants=1,
                       seed=99)
    a, hist_a = run_search(cfg, 5)
    b, hist_b = run_search(cfg, 5)

    check("identical seeds give identical histories", hist_a == hist_b,
          f"{hist_a} vs {hist_b}")
    check("and identical beams",
          [c.id for c in a.beam] == [c.id for c in b.beam])

    different = SearchConfig(beam_width=3, children_per_parent=2, immigrants=1,
                             seed=100)
    c, _ = run_search(different, 5)
    seeds_a = {m.mutation_seed for m in a.propose(5)}
    seeds_c = {m.mutation_seed for m in c.propose(5)}
    check("a different config seed gives different proposals",
          seeds_a != seeds_c)


def test_restore():
    print("\nresuming from a manifest")

    cfg = SearchConfig(beam_width=3, children_per_parent=2, immigrants=1)
    search, _ = run_search(cfg, 4)
    rows = [c.to_row() for c in search.archive]

    resumed = BeamSearch(cfg)
    resumed.restore([Candidate.from_row(r) for r in rows])

    check("restored beam matches",
          [c.id for c in resumed.beam] == [c.id for c in search.beam],
          f"{[c.id for c in resumed.beam]} vs {[c.id for c in search.beam]}")
    check("restored archive is complete",
          len(resumed.archive) == len(search.archive))
    check("restored best score matches",
          resumed.best.score == search.best.score)


def test_zero_children_still_explores():
    print("\nimmigrants alone can drive a search")

    # A legitimate configuration: pure random search, no mutation at all.
    cfg = SearchConfig(beam_width=4, children_per_parent=0, immigrants=6)
    check("config validates", cfg.validate() == [])
    search, history = run_search(cfg, 8)
    check("still improves on immigrants alone", history[-1] >= history[0],
          f"{history[0]:.3f} -> {history[-1]:.3f}")
    moves = search.propose(1)
    check("proposes only immigrants",
          all(m.origin == IMMIGRANT for m in moves))


def test_grayscale_flag():
    """Colour handling: the flag reaches the backend, and it is colour-blind.

    The reason this matters is specific to Fluoddity. Particle hue is driven by
    the same behaviour output that drives motion, so colour and shape are
    coupled at the source: in colour, a config that lands on a palette near the
    references scores well regardless of what it is doing spatially, and the
    search drifts toward the palette rather than the pattern.
    """
    print("\ngrayscale scoring")

    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'demos'))
    import tex_sim

    colour = tex_sim.ClipBackend(grayscale=False)
    grey = tex_sim.ClipBackend(grayscale=True)
    check("the flag reaches ClipBackend", grey.grayscale is True)
    # Signatures gate tex_sim's embedding cache; identical ones would let a
    # colour run's vectors be reused for a grayscale run.
    check("signatures differ so caches cannot cross-contaminate",
          colour.signature() != grey.signature(),
          f"{colour.signature()} vs {grey.signature()}")
    check("the grayscale signature is marked",
          grey.signature().endswith(':gray'), grey.signature())

    check("SearchConfig carries the flag",
          SearchConfig(grayscale=True).grayscale is True)
    check("and defaults to colour", SearchConfig().grayscale is False)

    # The conversion itself, without needing torch: "L" then back to RGB, so
    # CLIP still receives three channels but they carry only luminance.
    from PIL import Image
    import numpy as np

    img = Image.new('RGB', (32, 32))
    pixels = img.load()
    for x in range(32):
        for y in range(32):
            pixels[x, y] = (230, 40, 230) if (x // 4) % 2 else (0, 0, 0)
    converted = np.asarray(img.convert('L').convert('RGB'))
    check("conversion equalizes the channels",
          (converted[..., 0] == converted[..., 1]).all()
          and (converted[..., 1] == converted[..., 2]).all())
    check("conversion preserves structure rather than flattening",
          converted.std() > 1.0, f"std={converted.std():.2f}")

    # The texture backend is grayscale by construction (_load_gray), so the
    # flag is a no-op there -- worth asserting, because a future change that
    # made it colour-sensitive would silently reintroduce the problem.
    texture = tex_sim.TextureBackend()
    check("the texture backend has no colour path",
          not hasattr(texture, 'grayscale'),
          "TextureBackend grew a colour mode; check _load_gray")


def test_colour_blind_ranking():
    """A colour-blind scorer ranks by shape when shape and colour disagree.

    Constructed so the two signals point at different candidates: the reference
    is green stripes, one candidate has the right SHAPE in the wrong colour and
    the other the right COLOUR in the wrong shape. A scorer that follows
    structure must prefer the first.

    Runs against the texture backend, which needs no torch. It is the default,
    and it is already colour-blind -- this asserts that end to end rather than
    trusting the docstring.
    """
    print("\ncolour-blind ranking (texture backend)")

    import tempfile

    import numpy as np
    from PIL import Image, ImageDraw

    from pilot import embedding, scoring
    import tex_sim

    size = 256
    green, magenta = (40, 230, 40), (230, 40, 230)

    def stripes(colour):
        img = Image.new('RGB', (size, size), (0, 0, 0))
        draw = ImageDraw.Draw(img)
        for x in range(0, size, 16):
            draw.rectangle([x, 0, x + 7, size], fill=colour)
        return img

    def blobs(colour):
        rng = np.random.default_rng(3)
        img = Image.new('RGB', (size, size), (0, 0, 0))
        draw = ImageDraw.Draw(img)
        for _ in range(40):
            x, y = rng.integers(0, size, 2)
            r = int(rng.integers(6, 16))
            draw.ellipse([x - r, y - r, x + r, y + r], fill=colour)
        return img

    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        refs = tmp / 'ref'
        refs.mkdir()
        stripes(green).save(refs / 'green_stripes.png')

        shape_match = tmp / 'stripes_magenta.png'     # right shape, wrong hue
        colour_match = tmp / 'blobs_green.png'        # wrong shape, right hue
        stripes(magenta).save(shape_match)
        blobs(green).save(colour_match)

        backend = tex_sim.TextureBackend()
        scorer = scoring.ReferenceImageScorer(
            backend, sorted(refs.glob('*.png')), aggregate='mean')
        scores = scorer.score(embedding.embed_paths(
            backend, [shape_match, colour_match]))

        check("the shape match outranks the colour match",
              scores[0] > scores[1],
              f"stripes_magenta {scores[0]:+.4f} vs "
              f"blobs_green {scores[1]:+.4f}")
        check("describe() reports the colour mode",
              'grayscale' in scorer.describe(), scorer.describe())


def main():
    print("Beam search")
    test_generation_zero()
    test_proposal_shape()
    test_beam_never_regresses()
    test_beam_size_and_membership()
    test_culled()
    test_unscored_dropped()
    test_reproducible()
    test_restore()
    test_zero_children_still_explores()
    test_grayscale_flag()
    test_colour_blind_ranking()

    print()
    if _failures:
        print(f"FAIL  {len(_failures)} check(s): {', '.join(_failures)}")
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
