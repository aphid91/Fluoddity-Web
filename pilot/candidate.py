"""What the search passes around: a candidate, and its result.

Small and picklable by design. A Candidate is ~80 floats plus metadata -- a
couple of kilobytes -- so an archive of tens of thousands costs nothing, and a
strategy that wants to keep everything it has ever seen may.

LINEAGE IS PART OF THE VALUE, not bookkeeping bolted on. When a search turns up
something surprising the first question is always "where did that come from",
and the answer has to survive into the manifest: which parent, which seed, which
mutation scale. Given those three, the app reproduces the candidate exactly --
the move is deterministic.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace

#: How a candidate came to exist. `root` is a config loaded from disk or a
#: generation-zero seed; `mutant` is a step from a parent; `immigrant` is a
#: fresh random behaviour injected to escape a stalled beam.
ROOT = 'root'
MUTANT = 'mutant'
IMMIGRANT = 'immigrant'


@dataclass(frozen=True)
class Candidate:
    """One point in mutation space, and how it was reached."""

    #: Unique within a run: "gen003_007". Also the capture and config filename,
    #: so a picture on disk can be traced back to its manifest line by name
    #: alone.
    id: str
    generation: int
    origin: str

    #: The 80-float Fourier rule this candidate obeys. The candidate IS this,
    #: really; everything else is provenance.
    rule: tuple = ()

    #: Whose mutation produced it, and with what. None for roots and immigrants.
    parent_id: str | None = None
    mutation_scale: float | None = None
    mutation_seed: float | None = None

    #: Set once evaluated. Kept on the same object so a strategy holds one
    #: thing per candidate rather than two collections it has to keep aligned.
    score: float | None = None
    capture_path: str | None = None
    config_path: str | None = None

    #: Anything a scorer or strategy wants to carry along -- raw similarity
    #: before calibration, cluster id, novelty distance. Deliberately untyped:
    #: this is the seam where a future strategy stores what only it cares
    #: about, without every other component learning about it.
    extra: dict = field(default_factory=dict)

    def scored(self, score, **extra):
        """A copy carrying its score. Frozen, so evaluation returns rather
        than mutates -- which keeps an archive of past generations honest."""
        merged = dict(self.extra)
        merged.update(extra)
        return replace(self, score=score, extra=merged)

    def to_row(self):
        """One manifest line. JSON-safe, and flat enough to load into a
        spreadsheet without unpacking anything."""
        return {
            'id': self.id,
            'generation': self.generation,
            'origin': self.origin,
            'parent_id': self.parent_id,
            'score': self.score,
            'mutation_scale': self.mutation_scale,
            'mutation_seed': self.mutation_seed,
            'capture_path': self.capture_path,
            'config_path': self.config_path,
            # Last, because it is 80 numbers and everything above is what a
            # human reads. Present because it makes a manifest self-contained:
            # the run can be re-scored, or a candidate re-created, from this
            # file alone.
            'rule': list(self.rule),
            'extra': self.extra,
        }

    @classmethod
    def from_row(cls, row):
        """Rebuild from a manifest line, for resuming a run."""
        return cls(
            id=row['id'],
            generation=row['generation'],
            origin=row['origin'],
            rule=tuple(row.get('rule') or ()),
            parent_id=row.get('parent_id'),
            mutation_scale=row.get('mutation_scale'),
            mutation_seed=row.get('mutation_seed'),
            score=row.get('score'),
            capture_path=row.get('capture_path'),
            config_path=row.get('config_path'),
            extra=row.get('extra') or {},
        )


@dataclass(frozen=True)
class Move:
    """An instruction to produce one candidate. What a strategy emits.

    Deliberately a request rather than a result: the strategy decides WHAT to
    try, the runner knows HOW to make the app do it. That split is what lets a
    novelty search or a quality-diversity search drop in later without either
    of them learning the move recipe.

    `parent_id` None with origin=IMMIGRANT means "make something new". With
    origin=MUTANT it names the checkpoint to restore before mutating.
    """

    origin: str
    parent_id: str | None = None
    mutation_scale: float | None = None
    mutation_seed: float | None = None
    #: For ROOT moves: a config file to load.
    config_path: str | None = None
