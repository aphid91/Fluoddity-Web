"""The pilot: an automated search that drives Fluoddity from outside.

    pilot/client.py     typed wrapper over the HTTP API
    pilot/candidate.py  Candidate and Move -- what the search passes around
    pilot/config.py     SearchConfig: every knob a run can vary
    pilot/moves.py      THE move recipe, in one place
    pilot/embedding.py  batched image embedding
    pilot/scoring.py    Scorer interface; reference-image implementation
    pilot/search.py     SearchStrategy interface; beam search
    pilot/run.py        the driver: config in, run folder out

IMPORTS NOTHING FROM THE APP. The two live in one repository and in two
processes, and the HTTP API is the whole of the contact between them. That is
not tidiness: torch beside moderngl in one process invites driver conflicts,
and a pilot that can be restarted without losing a warmed-up simulation is worth
more than the convenience of a direct call.

Run one with:

    Scratch.venv/Scripts/python.exe -m pilot.run --config search.json

See docs/SEARCH.md.
"""

from .candidate import Candidate, Move, IMMIGRANT, MUTANT, ROOT
from .client import ApiError, FluoddityClient
from .config import SearchConfig

__all__ = ['Candidate', 'Move', 'IMMIGRANT', 'MUTANT', 'ROOT',
           'ApiError', 'FluoddityClient', 'SearchConfig']
