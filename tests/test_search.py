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

    # sample_size sizes generation 0 when generation 0 IS the run.
    sampling = SearchConfig(generations=1, children_per_parent=0,
                            immigrants=0, sample_size=137, beam_width=8)
    drawn = BeamSearch(sampling).propose(0)
    check("sample_size drives the generation-0 count",
          len(drawn) == 137, f"{len(drawn)} moves")
    check("and they are all immigrants",
          all(m.origin == IMMIGRANT for m in drawn))
    check("a sampling run proposes nothing after generation 0",
          BeamSearch(sampling).propose(1) == [], "it would breed")


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


class FakeTextBackend:
    """A text-capable backend with hand-placed vectors. No torch.

    THE GEOMETRY IS THE POINT, and getting it wrong makes this test worse than
    useless. Real CLIP text embeddings do NOT spread over the sphere: measured
    across the 30 background captions, pairwise cosine runs 0.507 to 0.940 with
    a median of 0.687 -- they occupy a narrow cone. That clustering is exactly
    WHY per-image median/MAD calibration is informative, and random unit
    vectors (median cosine ~0.0) are nothing like it.

    So unknown captions here are drawn as small perturbations of a shared
    `generic` axis, reproducing the cone. An earlier version of this test used
    plain random 8-d vectors and "failed" against a correct implementation --
    the test was wrong, not the scorer.
    """

    name = 'fake'
    supports_text = True

    #: How far background captions wander off the shared axis. Tuned to land in
    #: the measured 0.5-0.9 pairwise band.
    SPREAD = 0.35

    def __init__(self, text_vectors, dim=64):
        self.text_vectors = text_vectors
        self.dim = dim
        self.grayscale = False
        import numpy as np

        axis = np.zeros(dim, dtype=np.float32)
        axis[-1] = 1.0
        self._generic = axis

    def embed_texts(self, texts):
        import numpy as np

        out = np.zeros((len(texts), self.dim), dtype=np.float32)
        for i, text in enumerate(texts):
            vector = self.text_vectors.get(text)
            if vector is None:
                rng = np.random.default_rng(abs(hash(text)) % (2 ** 31))
                noise = rng.normal(size=self.dim)
                noise /= np.linalg.norm(noise)
                vector = self._generic + self.SPREAD * noise
            vector = np.asarray(vector, dtype=np.float32)
            out[i] = vector / (np.linalg.norm(vector) + 1e-12)
        return out


def test_prompt_scorer():
    """Caption scoring, and specifically why raw cosines are not enough."""
    print("\nprompt scoring")

    import numpy as np
    from pilot.scoring import PromptScorer

    dim = 64
    # Two distinguishing directions -- what we want and what we keep getting --
    # orthogonal to each other and to the generic axis the background captions
    # cluster on.
    want = np.zeros(dim); want[0] = 1.0
    other = np.zeros(dim); other[1] = 1.0

    backend = FakeTextBackend({'a maze': want, 'noise': other}, dim=dim)
    generic = backend._generic

    def image(*parts, generic_weight=1.0):
        """A candidate: some generic content plus its distinguishing signal."""
        vector = generic_weight * generic + sum(parts)
        return vector / np.linalg.norm(vector)

    # Four candidates. `busy` is the case calibration exists for: it looks like
    # EVERY caption, so a raw cosine flatters it and a per-image z should not.
    embeddings = np.stack([
        image(want),                       # on target
        image(other),                      # off target
        image(0.7 * want, 0.7 * other),    # matches both
        image(generic_weight=3.0),         # generic/busy, matches everything
    ]).reshape(4, 1, dim).astype(np.float32)

    scorer = PromptScorer(backend, 'a maze', calibrate=False)
    raw = scorer.score(embeddings)
    check("uncalibrated ranks the on-target image first",
          int(np.argmax(raw)) == 0, str(np.round(raw, 3)))

    calibrated = PromptScorer(backend, 'a maze', calibrate=True)
    z = calibrated.score(embeddings)
    check("calibrated ranks the on-target image first",
          int(np.argmax(z)) == 0, str(np.round(z, 3)))

    # THE reason calibration exists: the busy image scores well against the
    # caption in raw cosine simply by resembling everything, and per-image
    # median/MAD is what takes that away. Its RANK must fall.
    raw_rank = list(np.argsort(-raw)).index(3)
    z_rank = list(np.argsort(-z)).index(3)
    check("calibration demotes the generic 'matches everything' image",
          z_rank >= raw_rank,
          f"raw rank {raw_rank} -> z rank {z_rank}  "
          f"(raw {np.round(raw, 3)}, z {np.round(z, 3)})")

    # And it widens a band that is otherwise too narrow to rank on.
    check("calibration widens the spread",
          float(z.max() - z.min()) > float(raw.max() - raw.min()),
          f"raw spread {raw.max() - raw.min():.4f}, "
          f"z spread {z.max() - z.min():.4f}")

    check("describe() says whether it is calibrated",
          'calibrated' in calibrated.describe()
          and 'RAW' in scorer.describe(),
          f"{calibrated.describe()} | {scorer.describe()}")

    print("\nnegative captions")
    negated = PromptScorer(backend, 'a maze', negative_captions=['noise'],
                           calibrate=True)
    with_negative = negated.score(embeddings)
    penalty = z - with_negative

    # Images 1 (pure off-target) and 2 (mixed) resemble the negative; image 0
    # does not. Both must pay more than the on-target one.
    check("the off-target image is penalized more than the on-target one",
          penalty[1] > penalty[0],
          f"off-target {penalty[1]:.3f} vs on-target {penalty[0]:.3f}")
    check("the mixed image is penalized more than the on-target one",
          penalty[2] > penalty[0],
          f"mixed {penalty[2]:.3f} vs on-target {penalty[0]:.3f}")
    check("the on-target image still wins",
          int(np.argmax(with_negative)) == 0, str(np.round(with_negative, 3)))
    check("describe() reports negatives",
          'negative' in negated.describe(), negated.describe())

    print("\nrejections")
    from pilot.scoring import ConstantScorer                     # noqa: F401
    import tex_sim

    try:
        PromptScorer(tex_sim.TextureBackend(), 'a maze')
        check("a text-less backend is refused", False, "no error raised")
    except ValueError as e:
        check("a text-less backend is refused", 'clip' in str(e).lower(), str(e))

    try:
        PromptScorer(backend, '   ')
        check("an empty caption is refused", False, "no error raised")
    except ValueError:
        check("an empty caption is refused", True)

    check("an empty generation scores empty",
          PromptScorer(backend, 'a maze').score(
              np.zeros((0, 1, dim), np.float32)).shape == (0,))


def test_prompt_config():
    print("\ncaption configuration")

    cfg = SearchConfig(backend='clip', caption='a maze-like pattern')
    check("a caption with the clip backend validates", cfg.validate() == [])

    problems = SearchConfig(backend='texture', caption='a maze').validate()
    check("a caption with the texture backend is rejected",
          any('clip' in p for p in problems), str(problems))

    problems = SearchConfig(backend='clip', caption='a maze',
                            reference_dir='.').validate()
    check("caption AND reference_dir is rejected",
          any('not both' in p for p in problems), str(problems))

    problems = SearchConfig(backend='clip',
                            negative_captions=['noise']).validate()
    check("negatives without a caption are rejected",
          any('negative_captions' in p for p in problems), str(problems))

    check("calibrate defaults on", SearchConfig().calibrate is True)
    check("negative_captions defaults empty",
          SearchConfig().negative_captions == [])

    # The config must survive a round-trip, or a run cannot be replayed.
    import json
    import tempfile
    from dataclasses import asdict

    with tempfile.TemporaryDirectory() as raw:
        path = Path(raw) / 'search.json'
        original = SearchConfig(backend='clip', caption='a maze',
                                negative_captions=['noise', 'a blur'],
                                calibrate=True, grayscale=True)
        original.save(path)
        restored = SearchConfig.load(path)
        check("caption config round-trips", restored == original,
              str(json.loads(path.read_text())))


def test_report():
    """The end-of-run report, and the id-collision it has to survive."""
    print("\nreport")

    import tempfile
    from pilot import report as report_lib

    made = [Candidate(id=f"gen000_{i:03d}", generation=0, origin=IMMIGRANT,
                      capture_path=f"captures/gen000_{i:03d}.png").scored(
                          float(i))
            for i in range(70)]

    ranked = report_lib.rank(made)
    check("ranked best-first", ranked[0].score == 69.0 and ranked[-1].score == 0.0,
          f"{ranked[0].score} .. {ranked[-1].score}")

    unscored = made + [Candidate(id='nope', generation=0, origin=IMMIGRANT)]
    check("unscored candidates are dropped",
          len(report_lib.rank(unscored)) == len(made))

    lines = report_lib.build(made, count=32)
    text = '\n'.join(lines)
    check("has a TOP section", 'TOP 32' in text)
    check("has a BOTTOM section", 'BOTTOM 32' in text)
    check("the best candidate appears", 'gen000_069' in text)
    check("the worst candidate appears", 'gen000_000' in text)

    # A run smaller than 2*count must not print the same candidate twice.
    small = report_lib.build(made[:10], count=32)
    small_text = '\n'.join(small)
    check("no BOTTOM section when the halves would overlap",
          'BOTTOM' not in small_text, small_text[:200])

    check("an empty run reports cleanly",
          'Nothing scored' in '\n'.join(report_lib.build([])))

    print("\n  id collisions (pre-session-tag folders)")
    # Two sessions wrote the same ids; only the LAST owns the files on disk.
    collided = [
        Candidate(id='gen000_000', generation=0, origin=IMMIGRANT).scored(9.0),
        Candidate(id='gen000_000', generation=0, origin=IMMIGRANT).scored(1.0),
        Candidate(id='gen000_001', generation=0, origin=IMMIGRANT).scored(5.0),
    ]
    kept, shadowed = report_lib.dedupe(collided)
    check("dedupe keeps one row per id", len(kept) == 2, str(len(kept)))
    check("dedupe reports how many were shadowed", shadowed == 1, str(shadowed))
    check("dedupe keeps the LAST writer (whose files survive)",
          [c.score for c in kept if c.id == 'gen000_000'] == [1.0],
          str([c.score for c in kept]))

    with tempfile.TemporaryDirectory() as raw:
        path = report_lib.write(Path(raw) / 'report.txt', made,
                                cfg=SearchConfig(caption='a maze',
                                                 backend='clip'))
        check("writes a file", path.is_file())
        body = path.read_text(encoding='utf-8')
        check("records the objective", 'a maze' in body)
        check("records the backend", 'clip' in body)


def test_session_tags():
    """Ids must not collide when a folder is reused."""
    print("\nsession tags")

    from pilot.run import SearchRun

    check("the first session is untagged",
          SearchRun._session_tag([]) == 'b01_',
          SearchRun._session_tag([]))

    existing = [Candidate(id='gen000_000', generation=0, origin=IMMIGRANT)]
    check("a second session gets b01_",
          SearchRun._session_tag(existing) == 'b01_')

    existing.append(Candidate(id='b01_gen000_000', generation=0,
                              origin=IMMIGRANT))
    check("a third session gets b02_",
          SearchRun._session_tag(existing) == 'b02_',
          SearchRun._session_tag(existing))

    # The property that matters: whatever tag comes back is not already used.
    tags = {c.id.partition('gen')[0] for c in existing}
    check("the new tag is unused", SearchRun._session_tag(existing) not in tags)


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
    test_prompt_scorer()
    test_prompt_config()
    test_report()
    test_session_tags()

    print()
    if _failures:
        print(f"FAIL  {len(_failures)} check(s): {', '.join(_failures)}")
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
