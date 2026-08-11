"""Deciding what to try next.

TWO METHODS, DELIBERATELY.

    propose(generation) -> [Move]      what to evaluate
    observe(evaluated)  -> None        what came back

That split is what keeps the interface honest for strategies that do not exist
yet. Novelty search, quality-diversity and plain hill-climbing all produce
candidates the same way -- mutate something, or make something new -- and differ
entirely in what they KEEP. Keeping is `observe`. A strategy that wanted to
change how candidates are produced would emit different Moves; it still would
not need to know what a move does to the app, because it emits a request and the
runner performs it.

BeamSearch ships. It is the simplest thing that can escape a local optimum,
which plain hill-climbing cannot.
"""

from __future__ import annotations

import random
from typing import Protocol

from .candidate import IMMIGRANT, MUTANT, ROOT, Move


class SearchStrategy(Protocol):
    def propose(self, generation: int) -> list:
        """Moves to evaluate this generation."""
        ...

    def observe(self, evaluated: list) -> None:
        """Scored candidates from the generation just run."""
        ...


class BeamSearch:
    """Keep the best K, breed M children from each, add a few immigrants.

    WHY IMMIGRANTS ARE NOT OPTIONAL. Every mutant is a small step from
    something already in the beam, so once the beam converges the entire
    population is confined to one neighbourhood and no sequence of steps
    leaves it. Immigrants are the only source of rules that are not descended
    from what is already there. They will usually score badly -- a random
    behaviour rarely beats one that survived several rounds of selection --
    and that is fine: they are lottery tickets, not competitors, and one that
    does win is a genuinely new region worth having found.

    The beam holds candidates from ANY generation, not just the last. A parent
    that outscores all of its children stays, so a generation cannot make the
    search worse -- which also means progress is monotonic and a stalled run is
    visible as a flat best-score rather than a wandering one.
    """

    def __init__(self, cfg, seed_configs=(), rng=None):
        self.cfg = cfg
        self.rng = rng or random.Random(cfg.seed)
        self.seed_configs = list(seed_configs)

        #: The survivors, best first. Candidates, already scored.
        self.beam = []
        #: Everything ever evaluated, in order. Cheap to keep -- a Candidate is
        #: a couple of kilobytes -- and it is what a later novelty or
        #: quality-diversity strategy would need, so it is kept from the start.
        self.archive = []

    # ------------------------------------------------------------------

    def propose(self, generation):
        """What to evaluate. Generation 0 seeds; after that, breed and import."""
        if generation == 0:
            return self._seed_moves()

        moves = []
        for parent in self.beam:
            for _ in range(self.cfg.children_per_parent):
                moves.append(Move(
                    origin=MUTANT,
                    parent_id=parent.id,
                    mutation_scale=self.cfg.mutation_scale,
                    # Drawn HERE, from the strategy's seeded RNG, so a whole
                    # run replays from search.json. Leaving it to the app would
                    # make the search depend on the app's RNG state, which the
                    # manifest does not capture.
                    mutation_seed=self.rng.random(),
                ))
        moves.extend(Move(origin=IMMIGRANT)
                     for _ in range(self.cfg.immigrants))
        return moves

    def _seed_moves(self):
        """Generation zero.

        Configs the user named, if any; otherwise a population of immigrants.
        Starting from nothing is a legitimate way to run this -- it is a search
        of the whole space rather than a refinement of somewhere in it.
        """
        if self.seed_configs:
            return [Move(origin=ROOT, config_path=str(path))
                    for path in self.seed_configs]
        count = max(self.cfg.beam_width, self.cfg.immigrants)
        return [Move(origin=IMMIGRANT) for _ in range(count)]

    def observe(self, evaluated):
        """Fold a generation's results into the beam.

        Candidates with no score are dropped rather than treated as zero: an
        unscored candidate is one whose evaluation failed, and admitting it at
        zero would let a failure displace a real result whenever scores can go
        negative -- which cosine similarity can.
        """
        scored = [c for c in evaluated if c.score is not None]
        self.archive.extend(scored)

        pool = self.beam + scored
        pool.sort(key=lambda c: c.score, reverse=True)
        self.beam = pool[:self.cfg.beam_width]

    # ------------------------------------------------------------------

    def culled(self, evaluated):
        """Candidates from `evaluated` that did NOT make the beam.

        The runner uses this to release their checkpoints. Called after
        observe(); a candidate still in the beam must keep its checkpoint,
        because next generation's children are grown from it.
        """
        survivors = {c.id for c in self.beam}
        return [c for c in evaluated if c.id not in survivors]

    @property
    def best(self):
        return self.beam[0] if self.beam else None

    def summary(self):
        if not self.beam:
            return "beam empty"
        scores = [c.score for c in self.beam]
        return (f"beam {len(self.beam)}  "
                f"best {max(scores):+.4f}  worst {min(scores):+.4f}  "
                f"archive {len(self.archive)}")

    def restore(self, candidates):
        """Rebuild state from a resumed run's manifest.

        A resumed run cannot inherit the app-side checkpoints -- those died
        with the previous process -- so the beam is rebuilt from scores and the
        runner re-establishes checkpoints by re-evaluating survivors. See
        run.py.
        """
        scored = [c for c in candidates if c.score is not None]
        self.archive = list(scored)
        pool = sorted(scored, key=lambda c: c.score, reverse=True)
        self.beam = pool[:self.cfg.beam_width]
        return self.beam
