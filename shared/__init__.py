"""Stateless utilities used by more than one module (ARCHITECTURE.md rule 1).

No re-exports: every caller imports `from shared.gl_utils import ...` directly,
and hoisting names here only creates a second spelling for the same thing. The
MUTED_TRYSET_WARNINGS re-export that used to live on this line had no users at
all -- the counter is read through gl_utils, where it is defined.
"""
