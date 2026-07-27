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
| `camera/`         | The viewpoint: pan/zoom/mode state, and both ways of drawing the world (TRAIL present pass, PARTICLES instanced sprites). Owns `camera.frag`, `cam_brush.vert/frag`, and `CameraState`. Holds no simulation state. |
| `particle_system/`| All simulation state and stepping (`advance`/`reset`/`reload`), the canvas double-buffer, the entity SSBO, and the typed `SimulationConfig` preset. Owns `entity_update.glsl`, `brush.vert/frag`, `canvas.frag`. |
| `ui/`             | imgui (docking) + **all** GLFW input. Owns every callback, resolves imgui-vs-canvas capture, freezes input into a per-frame `InputState`, draws the interface, and reports *named commands*. Owns no simulation state. One file per window (`config_menu`, `settings_window`, `preferences_window`, `config_manager`, `config_clipboard`), composed onto `UI` as mixins; `settings_spec.py` is the control registry and `hover_preview.py` the shared preview state machine. |
| `orchestrator/`   | Owns one of each module above. Drives the main loop and holds the state. Sole broker of inter-module commands and data. Feature handlers live in command mixins beside it (`project_commands`, `clipboard_commands`, `settings_commands`, `config_manager_commands`). |
| `project/`        | The `Project` value type (ConfigBuffer + world settings + name + selection, immutable) and `History`, the undo/redo timeline over those values. |
| `preferences/`    | Editor state that is **not** saved with a config (brightness, physics rate, world size, canvas aspect). Persisted to `preferences.json`. |
| `shared/`         | The sanctioned exception: stateless GL utilities (`read_shader` incl. `#include` resolution, `tryset`) and cross-module shaders (`fullscreen_quad.vert`, **`common.glsl`**). No domain state. |
| `configs/`        | Physics preset JSONs (`Starcrossed.json`, `9LeafClovers.json`, `Angles.json`). |

### Key files in `particle_system/`

| File | Role |
|------|------|
| `layout.py`  | Parses `common.glsl` struct declarations into numpy dtypes. The host packing can never drift from the shader's view of memory. Strict: raises `LayoutError` on any non-vec4 member. |
| `coords.py`  | The Python mirror of the coordinate math in `common.glsl`. One of only two places allowed to write aspect-ratio or camera math. |
| `config.py`  | `SimulationConfig` (-> `ConfigData`, per-population), `WorldSettings` (saved world state) and `WorldConfig` (-> `WorldData`, settings + runtime sizing). |
| `picker.py`  | `EntityPicker`: nearest-entity-to-a-world-point, reduced on the GPU. Lives here because it reads the entity buffer. |
| `persistence.py` | Reading/writing config files (v8), the legacy v7 reader, and categorized discovery of `configs/`. |

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
   Example (commands): the UI reports `'next_preset'`; the Orchestrator loads the
   file, builds a new `Project`, and hands it to `ParticleSystem.apply_project()`.

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
   or camera math.** Everything else composes the functions they provide. The
   reference had six divergent copies of this math, at least one contradicting
   the others, and the resulting drift between overlays and the simulation was
   never fully fixed. See "The view transform" below.

   **The world's topology is a setting, not a constant.** It is a torus only in
   `BC_WRAP`; Bounce reflects and Reset respawns. Four things follow the mode
   and must agree, or the boundary only half exists: the entity update
   (`world_wrap` / `world_bounce`), the canvas samplers' repeat flags
   (`_apply_boundary_sampling`), the trail diffusion stencil in `canvas.frag`,
   and every sensor read (`world_to_uv_bc`). Because the trail field obeys the
   same boundary as the particles and there is only one trail field, the mode
   lives in `WorldData` — it cannot vary per config.

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

### Features scoped for removal before the web port

Some machinery earns its place while building the chassis but should not reach
the port. Each is kept **isolated enough that removing it is a revert or a file
deletion**, not surgery:

| Feature | Lives in | Why it goes |
|---------|----------|-------------|
| Legacy v7 config reading | marked block in `persistence.py`, own commit | The port's spec is the v8 format alone. |
| Multi-config editing | `orchestrator/config_manager_commands.py`, `ui/config_manager.py`, the save dialog's "entire ConfigBuffer" radio | The initial port exposes only the primary config. The ConfigBuffer *system* stays; only its editing UI goes. |

When adding something in this category, give it its own file or its own commit
up front. Retrofitting the isolation later is the expensive path.

### Legacy config support

`persistence.py` contains a clearly marked `LEGACY COMPATIBILITY` block that
lets the original Fluoddity's v7 files load. **It is not part of the design**
and must not reach the WebGPU port, whose spec is the v8 format alone. It lives
in its own commit (`LEGACY: read the mutation seed from pre-rename config
files`) so reverting that commit is the entire removal — the block plus two
call sites tagged `# LEGACY`.

### Gravity, and growing ConfigData

`ConfigData` filled up: all twelve lanes across `sensor`, `force` and `misc`
were taken once `mutation_seed` claimed `misc.w`. Adding **Gravity (Force)** and
**Gravity (Strafe)** therefore took a fifth `vec4` (`force2`, 368 to 384 bytes)
with two spare lanes — the "add a whole new vec4" half of rule 7, rather than
reclaiming one. `layout.py` parses the struct, so the size and alignment are
verified automatically.

Both are **linear -1..1 controls expanded logarithmically** in the shader
(`gravity_expand()`): a small knob covers four decades, and a linear dead-zone
below `|c| = 0.05` lets the control reach exactly zero. Never apply the raw
value. The two channels mirror the motion split the rest of the physics uses —
`_force` feeds velocity, `_strafe` displaces position — and both scale by
`1/sqrt_world_size` like every neighbouring force, so the feel survives a World
Size change.

Additive to the save format: files written before `force2` existed have no such
block and default to zero, which is what they meant.

### Deprecation candidate: cohorts

`cohorts` + `rule_seed` + `mutation_scale` produce per-cohort rule variation via
seeded in-shader mutation. That is now redundant with `config_index`, which does
the same job more generally. They are kept because existing presets depend on
them, but they should not be extended. Migration when the time comes: *N cohorts
-> N config slots pre-populated with the mutated rules, computed host-side.*

## The view transform

### Three independent aspect quantities

Conflating these is the biggest source of confusion in this domain, and doing so
is what made the reference's aspect handling unfixable. They are named
distinctly everywhere:

| Name | What it is |
|------|------------|
| `canvas_size` | The simulation texture's dimensions. **Defines world space.** Changing it changes the shape of the simulated world. |
| `window_size` | The framebuffer's dimensions in pixels. Changes on resize. **Must never move a particle.** |
| letterbox | How the canvas fits into the window when their aspects disagree. *Derived* from the two above — never stored. |

### The chain

```
world                                   entity coordinates
  |  / world_half_extent                normalize to the canvas box
canvas ndc
  |  - pan, * zoom                      camera
view ndc
  |  * letterbox_scale                  fit canvas into window
screen ndc  [-1,1]
  |  * 0.5 + 0.5, flip y, * window_size
screen pixels                           GLFW convention, origin top-left
```

Every step is invertible; `screen_to_world` walks it backwards. **Compose new
conversions from these — never write a fresh one.** The chain exists in exactly
two places, `coords.py` and the bottom of `common.glsl`, and they are verified
against each other by running the GLSL on the GPU and comparing outputs.

### Conventions

- **zoom: bigger = zoomed IN**, a magnification factor. `zoom=1` fits the
  world. The original inverted this (its "zoom" was really a view size), which
  made the math read backwards as `scale /= zoom`.
- **pan: world units** — the world point at the center of the view. The
  original stored pan in "ndc x zoom" units with a negated y, so a pan value was
  meaningless without also knowing the zoom.
- **Letterbox is fit, not fill.** The whole canvas is always visible; the slack
  becomes black bars. Nothing is ever cropped, and a circle stays a circle.

### Camera modes

`CameraMode.TRAIL` samples the canvas texture through the **inverse** transform:
the quad is always fullscreen, and each screen pixel asks "what world point do I
show?". That inverse is what places the letterbox bars correctly.

`CameraMode.PARTICLES` draws one instanced sprite per entity, transformed to
screen ndc **in the vertex shader** — so the camera is baked into the vertices
and the present pass must not apply it again. Particles are world-sized (they
grow as you zoom in), matching the original's feel.

Both modes consume the same transform, so they agree pixel-for-pixel about where
a world point lands and toggling between them does not shift the image.

## Saving & loading

**Format v8** writes what this codebase actually has: a `world` block, a
`configs` list, and optionally a `camera`. Fields the project cut —
`slider_ranges`, `sweeps`, `jitters`, `parameter_sweeps_enabled`, most of
`appearance` — are **not written**. A save format that carries dead features
teaches the next reader those features exist.

Multiple configs are supported from the start, because the ConfigBuffer is a
list. "Save Config 0" writes a one-element list and loads through the identical
path as a many-config file.

**Legacy v7 files still load** — the three shipped presets are v7. The reader
takes what survived and ignores the rest. Writing v7 is not supported;
migration is one-way on purpose.

**Layout.** `configs/*.json` is the "Core" category; every subfolder becomes its
own collapsible category; user saves go to `configs/custom/`. Categories are
ordered Core-first then alphabetically, so shipped presets stay predictable as
user folders accumulate.

### The hover-preview contract

Two surfaces browse config collections by hovering — the **File > Load** menu
and the **Config Clipboard**. Both use the same state machine, implemented once
in `ui/hover_preview.py` as `PreviewSession`:

| Event | Effect |
|-------|--------|
| menu opens | snapshot the current ConfigBuffer |
| hover an entry | apply that config (previewing) |
| hover elsewhere | restore the snapshot |
| close without clicking | restore the snapshot |
| **click an entry** | **commit** — drop the snapshot, so the close does *not* undo it |

That last row is the one that is easy to get wrong: a naive implementation
restores on close and silently discards the user's selection.

**Each surface owns its own `PreviewSession`, and therefore its own snapshot.**
An earlier version kept a single snapshot slot on the Orchestrator; with two
independent hover surfaces that breaks — hovering a clipboard entry while the
Load menu is open overwrites the menu's snapshot, and unhovering restores the
wrong state. `snapshot_configs` therefore *returns* the snapshot rather than
storing it, and `restore_configs` takes one back.

Preview applies **configs and world settings only**. The camera and the
particles are untouched, so unhovering is a single buffer upload — instant, and
never jumps the view. On a committed load the camera *is* applied, but only if
the file recorded one (v7 files did not, and snapping to a default would be
worse than staying put).

## Settings, and the three kinds of state

Every tunable belongs to exactly one of three homes, and the difference is
about **what happens when you load someone else's config**:

| Source | Lives in | Saved? | Why |
|--------|----------|--------|-----|
| `CONFIG` | ConfigBuffer, per-particle | yes | It *is* the config — loading one should change these. |
| `WORLD` | `WorldData` uniform, global | yes | Defines how the piece looks (trail decay). |
| `PREFS` | `preferences/`, `preferences.json` | **no** | How *your* editor is set up. Loading a downloaded config must not dim your screen or resize your canvas. |

`preferences.json` is gitignored and loaded at startup; a corrupt or partial
file falls back to defaults rather than stopping the app, and unknown keys are
ignored so a downgrade does not break on a field a newer build wrote.

### The settings registry

`ui/settings_spec.py` declares every control once — tier, bounds, source, kind,
help text. **Adding a control is a one-line registry entry, not a UI edit.**

The registry drives two windows, split on `source`:

| Window | Renders | Edits |
|--------|---------|-------|
| **Project** | `CONFIG` + `WORLD` | the ConfigBuffer and world settings — exactly what a save file contains |
| **Preferences** | `PREFS` | editor state — never written to a save |

The split is exhaustive and disjoint: every setting appears in exactly one
window.

Controls are grouped into **collapsible tabs** by their `group`, in declaration
order. A tab whose members are all hidden by the current tier is not rendered
at all — so in Basic mode the Forces and Trails tabs vanish rather than showing
empty headers.

### The project

The **project** is the state the save/load system stores and restores: the
ConfigBuffer contents, the world settings, the project name, and which config
is selected for editing. It is a single immutable value
(`project/project.py`).

**Three kinds of settings, three homes.** `SimulationConfig` is per-particle
and there are many; `WorldSettings` is shared by every particle and there is
exactly one; `Preferences` is editor state and is not saved at all. Trail decay
used to be carried on *every* `SimulationConfig` because the preset format put
it beside the physics parameters � which made config 0 secretly authoritative,
made `edit_world()` a disguised `edit_config(0)`, and left slots 1+ holding
values that were silently ignored. `WorldSettings` is now its own type on the
project.

`WorldSettings` holds only what a file saves. Runtime sizing
(`sqrt_world_size`, `config_count`) joins at upload time in `WorldConfig`,
because no save file should dictate how big the running simulation is.

**Why a type rather than three attributes.** Those three always move together.
Before, every operation touching the buffer had to remember all three by hand —
apply the configs, fix the name, re-clamp the selection — at seventeen separate
sites. Forgetting the clamp indexes past the end of the buffer; forgetting the
rename leaves the window titled after a project that is no longer loaded.
Exactly that bug shipped once, in the clipboard. `Project` enforces both
invariants in `__post_init__`, so they hold by construction and the seventeen
sites collapsed to twelve calls to `Orchestrator._set_project()`.

**Immutability is load-bearing**, not stylistic. A hover-preview snapshot is
just a reference to a `Project` — nothing to copy, and no risk the captured
state mutates underneath. The same property is what lets the history/undo
system keep a stack of them.

`ParticleSystem.apply_project()` is the one place project state reaches the
GPU. Deciding *what* the configs should be belongs to `Project`; the system
only ships them to the device.

The title updates on load, on save, **and on hover-preview** — it says what is
actually applied, so browsing the Load menu renames as you go. The imgui window
ID is pinned with `###project_window` so the changing title does not make the
window forget its position and docking.

Two tiers: **Basic** is deliberately short (the knobs that most change the
result, mutation scale first); **Advanced** reveals the rest. The original's
undifferentiated wall of sliders is what this exists to avoid.

The tier toggle lives in **Preferences** and governs *both* windows — it is
itself an editor preference. It is not persisted: it is a view mode, and
starting simple each session is the useful default.

Entries with `implemented=False` are registered but rendered greyed. This
records the tier layout for controls whose underlying feature does not exist
yet, without pretending the knob works.

**Slider bounds are fixed and generous.** User-adjustable ranges were cut; a
config needing a value outside a bound is handled by ctrl+clicking the slider
to type an exact value, which imgui supports natively.

**Disruptive settings are typed inputs, not sliders.** World size and canvas
aspect reallocate GPU buffers and reset the simulation, so they commit on
Enter — a slider would rebuild the system on every frame of a drag.
`Preferences.requires_restart` decides this, and `_rebuild_system` carries the
live configs across so a resize never discards unsaved edits.

**Undo is the Config Clipboard.** Set a checkpoint, experiment, hover to A/B,
click to revert. A second, weaker undo next to it would be redundant.

## The config windows

Two windows in `ui/`, both toggled from the **View** menu.

**Config Manager** (`config_manager.py`) selects which `ConfigData` subsequent
controls will edit — Config 0 by default, so a single-config buffer needs no
interaction. Selection is *state only* today; per-config sliders will consume it
when they land. It grows the buffer three ways: **Duplicate Selected**,
**Load...** (appends every config in a saved file), and **Remove**.

Its Load... browser is deliberately plain — no hover-preview, no delete. Those
belong to File > Load, whose job is *replacing* the buffer. This one *appends*,
so previewing would mean repeatedly growing and shrinking the buffer under the
cursor.

**Config Clipboard** (`config_clipboard.py`) holds in-session checkpoints of the
**entire** ConfigBuffer — a scratch space for experimenting without committing
to disk. Checkpoints are named `<preset><NN>` (`Starcrossed00`, `Starcrossed01`,
…), numbered per preset, and numbering *reuses freed gaps* so heavy churn does
not drift into high numbers. Newest is on top. Deleting has no confirmation:
unlike a saved file, a checkpoint is a cheap scratch copy.

Session-only by design — they vanish on quit. File > Save is the route for
anything worth keeping.

`MAX_CONFIGS` (64) caps the buffer. The GPU would take far more, but a hard cap
keeps the manager UI bounded and makes overflow a reportable condition rather
than silent growth — appending a 3-config file with 2 slots free reports
"Added 2 of 3".

### imgui gotcha: `end_child()` is unconditional

`begin_child()` must **always** be paired with `end_child()`, even when it
returns false (clipped or collapsed) — unlike `begin_menu`/`tree_node`, where
the close call is conditional. Getting this wrong corrupts imgui's window stack
and asserts on a later frame, far from the cause.

## The per-sub-step budget

`advance()` runs `physics_steps` times per frame — 30 by default, so **~1800 Hz
at 60fps**. Anything done there is done nearly two thousand times a second, and
work that belongs to a slower cadence must not leak in.

Two rules keep it honest:

- **Uniforms that only change when the user acts are cached, not rebuilt.**
  `WorldData` is derived from config 0 via a dataclass, a numpy record and a
  tuple. Building it per sub-step across three programs was ~32k allocations a
  second for a value that changes when a slider moves. It is now computed in
  `_refresh_world_uniform()`, called from `apply_configs()` — the one place
  configs change.
- **Uniforms constant for a program's lifetime are set at reload.** Texture
  units and `canvas_resolution` go in `_set_constant_uniforms()`, re-run after
  every shader reload because a freshly compiled program starts with its
  uniforms unset.

Only `frame_count` genuinely varies per sub-step. Together these halved the
Python cost of `advance()` (52,201 → 30,601 calls per 300 sub-steps).

The same reasoning applies one level up: `_report_status()` runs per *frame*,
and `asdict` on a config deep-copies its 80-float rule tuple, so the settings
payloads are built only when a window that reads them is open.

## Particle selection and history

**Selection** adopts a clicked particle's rule as the config's base rule --
"that variant, do more of that" -- and the population then re-mutates around
it. `mutation_scale` is deliberately untouched, so exactly one field changes
and undo stays unambiguous.

The particle's rule is **recomputed host-side** (`particle_system/mutation.py`),
not read back from the GPU. The mutation is deterministic in
`(rule, scale, seed, cohort)`, so Python can reproduce it -- avoiding the extra
buffer and readback the original needed, and avoiding async readback in the
port. The price is that the mirror must stay bit-exact with the shader; a probe
test runs the simulation's own `mutate_rule` and compares. **Edit one side,
edit both, and re-run that test.**

**Mouse modes** exist because left-drag pans and left-click selects -- without a
mode, every attempt to pan would select on the way down. `CAMERA` (default)
drags to pan; `SELECT` clicks to adopt and right-clicks to undo. `S` toggles.

### What history records

Every deliberate act: slider edits, particle selection, seed randomization,
committed loads, preset cycling, checkpoint restores, and config
add/duplicate/remove.

**Two exclusions, neither an oversight:**

*Hover-preview and its restore.* The Load menu and Config Clipboard apply a
config as the cursor crosses each row, then put it back. These are transient
states the user never chose � browsing forty configs would leave forty entries
and evict real work. Only the **committed** load records. Coalescing cannot help
here: previews are not rapid edits to merge, they revert themselves.

*Undo and redo.* They call the same `_set_project()` as everything else, so
recording them would make undo push an entry � history about history.

Because recording happens at each command rather than at `_set_project()`, the
exclusions are the default: a new command records only if it asks to.

### Coalescing

A slider drag fires an edit per frame; without merging, two seconds of dragging
would be a hundred entries. Records sharing a `coalesce_key` within
`COALESCE_WINDOW` (0.5s) collapse into one � the entry's *end* state updates in
place while its start stays put, so undo jumps the whole gesture.

Keying on `(source, field)` means moving to a different slider starts a new
entry, and so does pausing. One-shot acts pass no key and never merge:
randomizing the seed three times is three undo steps, which is what a button
press should be.

`undo`/`redo` call `break_coalescing()` � without it, resuming a drag after
undoing would rewrite the entry just stepped back to.

### Recording against the right state

`History.record(before, after, label, coalesce_key)` takes **both** states,
because the live project can drift from the timeline: previews move it without
recording. Re-seating the current entry on `before` means undo returns you to
the moment before you acted.

A committed load needs more care still: by click time the preview has *already*
moved the project, so `before` would equal the live state and the entry would be
skipped. `_preview_origin` captures where browsing started, and commits record
against that.

Entries hold references to immutable `Project`s, so a snapshot costs a pointer.
Bounded at 100, session-only.

## Entity picking

`ParticleSystem.pick(world_pos, radius)` returns the nearest entity, or a miss.
Three design points are load-bearing:

**On-demand, never per frame.** A pick dispatches over every entity, which
measured in the tens of milliseconds per frame at large world sizes — far too
much for an answer only wanted when the user acts. `_update_pick()` is called
from user actions (a click, an explicit inspect request), not from the frame
loop.

**Reduced on the GPU, not read back.** A compute shader dispatches over every
entity and reduces to a single 4-byte result. The reference instead copied the
whole entity buffer to the host (~19 MB) and ran argmin in numpy, stalling the
pipeline on every click.

The reduction uses `atomicMin` over a packed key, because GLSL has no atomic
float min:

```
key = (quantized_distance << 20) | entity_index
```

Minimizing that key minimizes distance first and breaks ties by lowest index —
so the same click always selects the same particle. The winner's *position* is
deliberately not written to the result buffer: a thread that loses the atomic
could still write afterwards. The index in the key is authoritative, and the
host looks the position up from it.

**The result is one frame old.** `pick()` dispatches for the current cursor and
returns the *previous* frame's answer. Reading a buffer the same frame you wrote
it forces a GPU sync, and WebGPU has no synchronous readback at all — so the
deferred shape is both faster now and the one that ports. The ~16ms of latency
is invisible for hovering and clicking. `pick_blocking()` exists for host-side
tooling and tests; it stalls and does not port, so it must not be used in the
render loop.

**Distance is straight-line, in every boundary mode.** The obvious objection is
that the world wraps, so a particle just past one edge is adjacent to a cursor
near the opposite edge — and that is true, but only in `BC_WRAP`, and only for a
click within a particle radius of the seam. Threading the boundary mode down
into the pick shader to fix a case that narrow was not worth it, and the
toroidal helpers it would have needed asserted a topology that two of the three
boundary modes do not have. They were removed rather than left uncalled.

The pick radius is specified in **screen pixels** and converted through the view
transform, so the tolerance feels identical at any zoom — a world-space radius
would shrink on screen as you zoom out.

Picking happens **before** `advance()` in the frame, so the cursor is tested
against the entity positions the user can actually see rather than positions 30
sub-steps in the future.

## Input & the UI layer

`ui/` owns **every** GLFW callback. A second module installing callbacks on the
same window would mean chaining between our own modules and ambiguity about who
sees a click first — the exact fragility the reference suffered from.

**Capture is resolved once, at the callback.** Every handler forwards to imgui
first, then consults `io.want_capture_mouse` / `want_capture_keyboard` to decide
whether the event also belongs to the canvas. By the time input reaches
`InputState`, the plain fields (`left_pressed`, `scroll`, `keys_pressed`, …)
already mean *"meant for the canvas"*. **No consumer downstream should ever
check a capture flag** — if you find yourself doing that, the filtering belongs
in `ui.py` instead. Unfiltered variants (`any_left_pressed`) exist for the rare
case that genuinely wants every click.

Two deliberate asymmetries, both learned from how drags actually behave:

- **Releases are never capture-filtered.** A button that went down on the canvas
  must be able to come up even if the cursor is over a panel — otherwise the
  drag never ends and the canvas stays grabbed forever.
- **A drag belongs to whoever received the press.** `left_dragging` stays true
  while the cursor wanders over imgui windows, so dragging does not break when
  the pointer crosses a panel.

`InputState` is frozen and rebuilt once per frame, so every consumer in a frame
sees identical input — the physics step and the UI can never disagree about
where the mouse is.

## Control & data flow (per frame)

```
Orchestrator.run() loop:
       UI.begin_frame()                  # poll events, snapshot InputState,
                                         #   imgui.new_frame(), fire hotkeys
       _apply_camera_input(state)        # drag -> pan, scroll -> zoom
  30x  ParticleSystem.advance()          # GPU sim sub-steps
       AppWindow.begin_frame()           # bind + clear default framebuffer
       Camera.render(                    # data pulled from modules...
           canvas_texture, entity_buffer,#   ...and handed to Camera, which
           canvas_size, window_size)     #   holds no persistent reference
       Orchestrator._report_status()     # push display-only values to UI
       UI.end_frame()                    # build panels, imgui.render(), draw
       AppWindow.end_frame()             # swap buffers

UI -> named command -> Orchestrator handler
     R = reload | SPACE = reset | LEFT/RIGHT = prev/next preset
     TAB = toggle camera mode | HOME = reset view
     drag = pan | scroll = zoom (anchored at the cursor)
     (commands also exposed as buttons in the Debug panel)
```

**Why input is polled at the top.** Events are gathered before the physics and
rendering that consume them, so a frame acts on its own input rather than the
previous frame's. Polling used to sit next to the buffer swap at the bottom,
which cost a frame of latency — invisible for keyboard shortcuts, but plainly
visible when dragging. `AppWindow` therefore no longer pumps the event queue;
it only swaps.

## Deferred / known follow-ups

- `ParticleSystem` sizing constants (`ENTITY_COUNT`, `CANVAS_DIM`, `WORLD_SIZE`)
  are still module-level globals. Folding them into config is an optional future
  step; they're sizing constants, not per-preset physics, so they were left out
  of `SimulationConfig`.
- `CANVAS_ASPECT` is a module-level constant in `particle_system.py`. Non-square
  canvases are implemented and verified, but there is no UI to change the aspect
  at runtime — doing so requires reallocating the canvas textures and resetting
  the sim, which wants a deliberate command rather than a slider.
- `config_index` is treated as **mutable entity state** written by
  `assign_config_index()` at reset. A future "paint particles into config N"
  tool would change it at runtime, so the host must not assume it knows the
  entity->config mapping without a readback.
- PARTICLES mode draws every entity with no culling. Off-screen sprites still
  cost a vertex-shader invocation; at 150k entities that is fine, but a visible
  cost if the entity count grows a lot.
- The pick key encodes the entity index in 20 bits, capping picking at ~1.05M
  entities. Well above the current 150k, but it is a hard limit, not a soft
  one — raising it means trading bits against distance precision.
- The picked entity is reported in the debug panel but not yet drawn
  differently. Highlighting it on the canvas needs a render-side channel (the
  Entity struct has reserved lanes for exactly this).
- `remove_config` does **not** renumber entities' `config_index`. An entity
  pointing past the end is clamped in the shader, so removal degrades
  gracefully rather than corrupting — but entities pointing at the removed slot
  silently inherit whatever config took its place. Reassigning them belongs
  with the feature that lets a user paint config assignments.
- The Config Manager's selection has no visual effect yet. Highlighting the
  selected config's entities is the natural companion to the picker's
  highlight work.
- `rule_seed` remains a uniform rather than a `ConfigData` lane, because it is
  consumed only by the cohort-mutation path that rule-9's deprecation note
  covers. If cohorts go, it goes with them.
- `coords.screen_to_world()` currently assumes the present pass stretches the
  canvas across the whole window, because that is what `Camera` does today. When
  pan/zoom and letterboxing land, **their inverse belongs inside that function**
  — not in its callers. The reference's six drifting copies of this transform
  are what rule 9 exists to prevent.
- The UI is one debug panel and the input layer. Physics sliders, GUI detail
  tiers, tooltips, the menu bar and the config editor are each their own design
  conversation; the input plumbing they need is already in place.
