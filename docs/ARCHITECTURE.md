# Fluoddity2 Architecture

This document is the design contract for the project. It exists so a future agent
(or human) can get up to speed on *how the pieces fit together* without reverse-
engineering it from the code. Read this before adding a new feature or module.

## The one-paragraph summary

Fluoddity2 is a GPU particle simulation. It is organized as **modular components
with minimal coupling and narrow interfaces**. Each component lives in its own
top-level folder. Components never hold references to each other — instead an
**Orchestrator** owns them all and brokers every interaction, passing *commands*
(public method calls) and *data* (state, textures) between them. New features
should preserve this shape.

## Modules

Every file belongs to a module folder. Each folder is a Python package
(`__init__.py` re-exports the module's public class).

| Module            | Owns                                                                 |
|-------------------|----------------------------------------------------------------------|
| `app_window/`     | GLFW init, the window, and the moderngl **context** (`ctx`). Per-frame windowing (should_close / begin_frame / end_frame). |
| `camera/`         | The display/present pass: blits a texture to the screen. (Despite the name, this is a *presentation* module, not a movable viewpoint — `camera.frag` is a passthrough colorizer.) Owns `camera.frag`. |
| `particle_system/`| All simulation state and stepping (`advance`/`reset`/`reload`), the canvas double-buffer, the entity SSBO, and the typed `SimulationConfig` preset. Owns `entity_update.glsl`, `brush.vert/frag`, `canvas.frag`. |
| `input/`          | GLFW keyboard handling. Translates raw key events into *named commands*; does not know what the commands do. |
| `orchestrator/`   | Owns one of each module above. Drives the main loop. Sole broker of inter-module commands and data. |
| `shared/`         | The sanctioned exception: stateless GL utilities (`read_shader` incl. `#include` resolution, `tryset`) and cross-module shaders (`fullscreen_quad.vert`, **`common.glsl`**). No domain state. |
| `configs/`        | Physics preset JSONs (`Starcrossed.json`, `9LeafClovers.json`, `Angles.json`). |

### Key files in `particle_system/`

| File | Role |
|------|------|
| `layout.py`  | Parses `common.glsl` struct declarations into numpy dtypes. The host packing can never drift from the shader's view of memory. Strict: raises `LayoutError` on any non-vec4 member. |
| `coords.py`  | The Python mirror of the coordinate math in `common.glsl`. One of only two places allowed to write aspect-ratio math. |
| `config.py`  | `SimulationConfig` (-> `ConfigData`, per-population) and `WorldConfig` (-> `WorldData`, per-world). |

## Design rules

These are the load-bearing constraints. Follow them when extending the project.

1. **Every file belongs to a module folder.** The only exception is `shared/`,
   which holds genuinely stateless utilities and the one shader used by more than
   one module. Diagnostic-only globals (e.g. `MUTED_TRYSET_WARNINGS`) are fine in
   `shared/` because they don't interface with domain state.

2. **Modules expose public *data* via typed values (dataclasses); public *GPU
   resources* via narrow accessors.** `SimulationConfig` is a frozen dataclass.
   Live GPU handles (textures, buffers, programs, VAOs) are *not* wrapped in
   dataclasses — they're opaque handles, not data. They're handed out per-frame
   via accessors like `ParticleSystem.current_canvas_texture()`.

3. **The Orchestrator is the sole broker.** Modules do not reference each other.
   All inter-module communication is a method call or data hand-off routed through
   the Orchestrator. Example (data): each frame the Orchestrator pulls the current
   canvas texture from ParticleSystem and passes it to Camera — Camera never holds
   a persistent reference to it, so the double-buffer swap stays invisible to it.
   Example (commands): Input reports `'next_preset'`; the Orchestrator turns that
   into `ParticleSystem.load_config(...)`.

4. **The moderngl `ctx` is the one sanctioned shared substrate.** It is created by
   AppWindow and injected once into each module at construction. You *cannot* pass
   a GL context per frame, so this is a deliberate, documented exception to
   "avoid persistent coupling" — which otherwise applies to *domain* state only.

5. **Hot-reload contract (from `CLAUDE_README.md`) is preserved.** This is a
   teaching tool where users tinker with shaders live:
   - Shader/buffer setup lives in isolated `reload()` / `_reload_*` helpers so it
     can be re-run mid-execution.
   - Failed shader compilation must **not** crash — log the error and keep the
     last working program.
   - Use `tryset()` for all uniforms (uniforms get optimized out when a shader is
     edited, and ModernGL raises on missing ones).

6. **Shader paths are module-relative.** Modules resolve their shaders via
   `Path(__file__).parent / "shaders"` (and `shared/shaders` for the cross-module
   vertex shader), so the app does not depend on the launch directory.

7. **vec4-only GPU structs.** Every struct crossing the host/GPU boundary is
   built exclusively from 16-byte-aligned members: a `vec4`, a fixed-size array
   of `vec4`, or another struct obeying this rule. Scalars ride in vec4 lanes;
   ints ride in float lanes via `intBitsToFloat`/`floatBitsToInt`, with named
   accessors in `common.glsl` keeping call sites readable.

   *Why:* std430 (GLSL) and WGSL (WebGPU) do **not** agree on the layout of
   structs with mixed scalar types. An all-vec4 struct is unambiguous in both,
   so this codebase translates to WebGPU without a layout audit. This is the
   single most important rule for the planned port. `layout.py` enforces it.

8. **`common.glsl` is the single source of truth for struct layout.** All
   host/GPU structs (`Entity`, `ConfigData`, `WorldData`, `Rule`) are declared
   there once; `layout.py` parses them into the numpy dtypes used for packing.
   Never re-declare a shared struct in an individual shader — `#include
   "common.glsl"` instead. (The reference implementation duplicated its structs
   with a "SYNCHRONIZED" comment; they drifted anyway.)

   Because users hand-edit shaders live, `common.glsl` is authored by hand and
   *parsed* by the host — never machine-generated. The parser is deliberately
   strict and fails loudly at startup, since a layout mismatch does not crash:
   it silently reinterprets memory and the simulation just behaves subtly wrong.

9. **One coordinate convention, one implementation.** World space is
   area-preserving: with `ca = canvas_res.x / canvas_res.y`, entities live in
   `[-sqrt(ca), sqrt(ca)] x [-1/sqrt(ca), 1/sqrt(ca)]`, so world area is always
   4 and a circle stays a circle. On a square canvas this reduces exactly to
   `[-1,1]^2`.

   **Only `common.glsl` and `particle_system/coords.py` may write aspect-ratio
   math.** Everything else calls `world_to_uv` / `uv_to_world` / `world_to_ndc`
   / `world_wrap`. The reference had six divergent copies of this math, at least
   one contradicting the others, and the resulting drift between overlays and
   the simulation was never fully fixed.

10. **Simulation truth lives in the ConfigBuffer, not in the UI.** When a UI
    module lands, it reads config state and issues commands; it does not own a
    parallel copy. Where UI state and sim state diverge, the WebGPU port stops
    being a translation and becomes a rewrite.

## Why mediator, not an event bus

The purest "narrow interface / zero coupling" design would be an event/command
bus that modules publish to and subscribe from. We **deliberately chose a direct
mediator (the Orchestrator) instead**, because it keeps the render hot-path
explicit and easy to read/profile, and matches the project ethos ("as simple as
possible, but no simpler"). If the module count grows large enough that the
Orchestrator's wiring becomes unwieldy, revisit this — but not before.

## Config & world data

Two structs carry all tunable settings, split by a single question: *would it
make sense for two particles sharing a canvas to disagree about this?*

**`ConfigData` — yes, it can vary per particle.** Lives in the **ConfigBuffer**
SSBO (binding 1), one slot per particle population. Contains the Fourier `Rule`
(behavior) *and* the physics parameters, unified — they are the same kind of
thing, and the original's decision to handle them with two separate mechanisms
is what made its parameter code sprawl.

Each `Entity` carries a `config_index` and reads
`configs[e_config_index(e)]`, so different particles can obey entirely
different configs. Today the buffer holds one slot and every entity points at
it (behavior-identical to a plain uniform), but the infrastructure is sized as a
variable and is verified to work with multiple slots.

To split the population, change `assign_config_index()` in `entity_update.glsl`
— that one function is the designated seam, and the host resizes the buffer by
assigning `self.configs` and calling `_upload_configs()`.

This also subsumes the original's *parameter sweeps*: "different entities get
different parameters" is exactly what `config_index` provides, without bolting
six extra floats onto every parameter. Sweeps should not be reintroduced.

**`WorldData` — no, it is a property of the world.** Set as a uniform, never
per-entity: `trail_persistence`, `trail_diffusion`, `sqrt_world_size`,
`config_count`. `sqrt_world_size` is passed from the host constant of the same
name; it used to be a `#define` in the shader *and* a Python global, two
sources of truth that would silently disagree if either moved.

### Deprecation candidate: cohorts

`cohorts` + `rule_seed` + `mutation_scale` produce per-cohort rule variation via
seeded in-shader mutation. That is now redundant with `config_index`, which does
the same job more generally. They are kept because existing presets depend on
them, but they should not be extended. Migration when the time comes: *N cohorts
-> N config slots pre-populated with the mutated rules, computed host-side.*

## Control & data flow (per frame)

```
Orchestrator.run() loop:
  30x  ParticleSystem.advance()          # GPU sim sub-steps
       AppWindow.begin_frame()           # bind + clear default framebuffer
       Camera.render_texture(
           ParticleSystem.current_canvas_texture(),   # data pulled...
           AppWindow.ctx.screen)                       # ...and handed to Camera
       AppWindow.end_frame()             # poll events + swap buffers

Input (async, via GLFW key callback) -> named command -> Orchestrator handler
     R = reload | SPACE = reset | LEFT/RIGHT = prev/next preset
```

## Deferred / known follow-ups

- `ParticleSystem` sizing constants (`ENTITY_COUNT`, `CANVAS_DIM`, `WORLD_SIZE`)
  are still module-level globals. Folding them into config is an optional future
  step; they're sizing constants, not per-preset physics, so they were left out
  of `SimulationConfig`.
- `Camera` is really "present/display" — see the note in the module table. Rename
  is possible but was left to avoid churn. Expect this to be resolved when real
  pan/zoom camera work lands.
- The canvas is square today, so the area-preserving world convention (rule 9)
  reduces to `[-1,1]^2` and its non-square behavior is **not yet exercised**.
  The convention is implemented and unit-checked on both sides; making
  non-square canvases work end to end (window aspect, present pass, picking) is
  its own piece of work.
- `config_index` is treated as **mutable entity state** written by
  `assign_config_index()` at reset. A future "paint particles into config N"
  tool would change it at runtime, so the host must not assume it knows the
  entity->config mapping without a readback.
- `rule_seed` remains a uniform rather than a `ConfigData` lane, because it is
  consumed only by the cohort-mutation path that rule-9's deprecation note
  covers. If cohorts go, it goes with them.
