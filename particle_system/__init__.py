"""The simulation: entity buffer, config buffer, canvas, and the passes.

DELIBERATELY EMPTY OF RE-EXPORTS. This package used to hoist ParticleSystem and
SimulationConfig to the package root, which meant that importing ANY module
under `particle_system.` -- including the leaf modules that exist precisely so
other modules can import them cheaply -- ran `particle_system.py` and dragged
moderngl, persistence, and `layout.py`'s parse of common.glsl along with it.
Nothing imported them from here; every caller already uses the submodule path.

So: import the submodule you want.
    from particle_system.particle_system import ParticleSystem   # the class
    from particle_system.sizing import canvas_dimensions          # leaf
    from particle_system import coords                            # leaf

The leaf modules (`coords`, `config`, `sizing`) are the ones other top-level
modules are sanctioned to import -- see ARCHITECTURE.md rule 1.
"""
