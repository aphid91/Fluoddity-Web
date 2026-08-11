# Fluoddity-Core

A rebuilt, deliberately structured version of:
https://github.com/aphid91/Fluoddity

Fluoddity-Core began as a stripped-down companion to the full Fluoddity repo —
just enough machinery to load and run a config, for anyone who wanted to
understand the algorithm without digging through vibe-coded bells and whistles.
It has since grown into the working environment: an editor with tiered settings,
drawing and shove tools, entity selection, undo/redo, in-session checkpoints,
hover-preview loading, motion blur and bloom. What it deliberately does *not*
have is jitter or parameter sweeps; `config_index` subsumes the latter.

The design is documented, and the documentation is kept current:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — module boundaries, the numbered
  design rules the code cites, and why each one exists. **Read this before
  changing anything.**
- [docs/API.md](docs/API.md) — the piloting API: drive the app from another
  program over HTTP.
- [docs/SEARCH.md](docs/SEARCH.md) — the automated search: let a program hunt
  through mutation space for patterns you like, while you watch.
- [docs/CLIP_INTEGRATION.md](docs/CLIP_INTEGRATION.md) — how the two processes
  relate, what was measured, and what is still open.

## Running it

```
Scratch.venv/Scripts/python.exe main.py                  # the app
Scratch.venv/Scripts/python.exe main.py --api-port 8765  # plus the API
```

With the API up, a search can drive it from another terminal:

```
Scratch.venv/Scripts/python.exe -m pilot.run --write-example search.json
Scratch.venv/Scripts/python.exe -m pilot.run --config search.json
```

Tests are standalone scripts, each returning an exit code:

```
Scratch.venv/Scripts/python.exe tests/test_schedule_parse.py     # no GPU
Scratch.venv/Scripts/python.exe tests/test_pending_selection.py  # no GPU
Scratch.venv/Scripts/python.exe tests/test_moves.py              # no GPU
Scratch.venv/Scripts/python.exe tests/test_search.py             # no GPU
Scratch.venv/Scripts/python.exe tests/test_async_pick.py         # GPU, no window
Scratch.venv/Scripts/python.exe tests/test_hot_reload.py         # GPU, no window
Scratch.venv/Scripts/python.exe tests/test_api_capture.py        # GPU, no window
Scratch.venv/Scripts/python.exe tests/test_api_loopback.py       # needs a display
Scratch.venv/Scripts/python.exe tests/test_pilot_loopback.py     # needs a display
```

## Algorithm Structure
System state consists of a particle buffer called "entities" and a texture that stores particle trails called "canvas". 
physics steps work like this:

### Entity Update
- Each particle in entities reads the canvas at a pair of sensor locations.
- The particle extracts the flow/current vector from each sensor reading
- "calculate_entity_behavior()" takes this information and processes it with constants taken from the .json config file (see entity_update.glsl comments for details on this process)
- calculate_entity_behavior outputs a vec2 force and vec2 strafe.
- we update particle state with: velocity =velocity*drag + force; and position += velocity + strafe;
### Brush Update
- In order to write new trails to the canvas, we must splat all the particles to their locations.
- A "brush" texture with the same dimensions as canvas acts as a staging area for these newly created trails.
- We use instanced rendering with one instance per entity and additive blending.
- Each particle draws a small gaussian kernel with color == (velocity_x, velocity_y, 0.01, 1) * kernel. (only the velocity terms are used currently, the 0.01 is mostly placeholder)
### Canvas Update
- The canvas update is a simple frag shader. Each frame, the trails diffuse and fade away, while we mix in the newly laid trails from brush.
- diffusion is handled by a simple 4 neighbor weighted average of the canvas
- trail fade is performed by mixing old trails (pre diffused) and new trails (from brush) with canvas_out = trail_persistence*canvas_in + (1-trail_persistence)*brush_in.
- This mix() style trail persistence ensures that the equilibrium trail intensity is independent of the specific trail-persistence value
