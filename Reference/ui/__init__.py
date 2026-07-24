"""UI package - ImGui user interface for Fluoddity.

The UI class uses a mixin architecture: each module defines a mixin class,
and the UI class in core.py inherits all of them. This keeps files short
while preserving simple self.* access to shared state.
"""
from .core import UI

__all__ = ['UI']
