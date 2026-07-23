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
| `shared/`         | The sanctioned exception: stateless GL utilities (`read_shader`, `tryset`) and the one cross-module shader (`fullscreen_quad.vert`). No domain state. |
| `configs/`        | Physics preset JSONs (`Starcrossed.json`, `9LeafClovers.json`, `Angles.json`). |

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

## Why mediator, not an event bus

The purest "narrow interface / zero coupling" design would be an event/command
bus that modules publish to and subscribe from. We **deliberately chose a direct
mediator (the Orchestrator) instead**, because it keeps the render hot-path
explicit and easy to read/profile, and matches the project ethos ("as simple as
possible, but no simpler"). If the module count grows large enough that the
Orchestrator's wiring becomes unwieldy, revisit this — but not before.

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
  is possible but was left to avoid churn.
