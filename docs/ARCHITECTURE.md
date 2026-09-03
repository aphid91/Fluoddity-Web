# Fluoddity2 Architecture

This document is the design contract for the project. It exists so a future agent
(or human) can get up to speed on *how the pieces fit together* without reverse-
engineering it from the code. Read this before adding a new feature or module.

> **How to read this document.** It was written for the Python/moderngl desktop
> app that this codebase began as. That app has been removed and its TypeScript
> port is now the whole project — but the *design* it describes is the design
> the port implements, which is why this is still the contract rather than a
> historical note.
>
> Read it for the **reasoning**, not the paths. Where it names a Python file,
> the port has a direct counterpart:
>
> | Here | In the code |
> |---|---|
> | `particle_system/` | `src/particleSystem/` |
> | `camera/`, `assembler/`, `orchestrator/`, `project/`, `ui/` | `src/camera/`, `src/assembler/`, … |
> | `preferences/` | `src/prefs/` |
> | `strafe_field/` | `src/strafeField/` |
> | `shared/` | `src/gpu/` (utilities) and `src/shaders/` (shared shaders) |
> | `*.glsl` | `*.wgsl`, under each module's `shaders/` |
> | `shared/shaders/common.glsl` | `src/shaders/common.wgsl` |
>
> Names go from `snake_case` to `camelCase`. `README.md` has the current file
> layout and the notes on what genuinely differs (there is no `app_window/` —
> the browser owns the window — and no `tooltip_graphic/`).
>
> Two sections below are **about the retired implementation specifically** and
> no longer describe live code: the module table's `__init__.py` convention, and
> the `imgui` notes (the port uses Tweakpane). The `layout.py` row is likewise
> historical — see README's "Committed data files".

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
| `camera/`         | The viewpoint: pan/zoom/mode state, both ways of drawing the world (TRAIL present pass, PARTICLES instanced sprites), and the **temporal supersampler** behind motion blur. Owns `camera.frag`, `cam_brush.vert/frag`, `accumulate.frag`, and `CameraState`. Emits linear HDR. Holds no simulation state. |
| `assembler/`      | Everything between the finished camera frame and the screen: bloom, the asinh tone curve, and the two drawing overlays (strafe field, brush reticle). Owns `frame_assembly.frag`, `bloom_downsample.frag`, `bloom_upsample.frag`. Holds no simulation state and no preferences. |
| `particle_system/`| All simulation state and stepping (`advance`/`reset`/`reload`), the canvas double-buffer, the entity SSBO, and the typed `SimulationConfig` preset. Owns `entity_update.glsl`, `brush.vert/frag`, `canvas.frag`. |
| `strafe_field/`   | The user-drawn field: one texture at capped canvas resolution, the airbrush shader that writes it (`strafe_draw.frag`), and clear/erase. **RGBA16F in the port, holding TWO layers** — walls in `rg`, trails in `ba` — kept independent by per-pipeline colour write masks (`fieldLayer.ts`). Live-only: never saved, never in history. |
| `tooltip_graphic/`| The shader-drawn sensor diagram: an offscreen RGBA8 target and `tooltip_graphic.frag`. Built by the Orchestrator with the shared `ctx` and handed to the UI as a texture id — which is why it is a module of its own rather than a file in `ui/`, the package that must not own GL. |
| `ui/`             | imgui (docking) + **all** GLFW input. Owns every callback, resolves imgui-vs-canvas capture, freezes input into a per-frame `InputState`, draws the interface, and reports *named commands*. Owns no simulation state and **no GPU resources**. One file per window (`config_menu`, `settings_window`, `preferences_window`, `toolbar`, `drawing_window`), composed onto `UI` as mixins; `settings_spec.py` is the control registry, and `hover_preview.py`, `gated_controls.py`, `sensor_diagram.py` and `curved_slider.py` hold the pieces of behaviour extracted out of those windows. |
| `orchestrator/`   | Owns one of each module above. Drives the main loop and holds the state. Sole broker of inter-module commands and data. Feature handlers live in command mixins beside it (`project_commands`, `clipboard_commands`, `settings_commands`, `selection_commands`, `drawing_commands`, `shove_commands`). |
| `project/`        | The `Project` value type (ConfigBuffer + world settings + name + selection, immutable) and `History`, the undo/redo timeline over those values. |
| `preferences/`    | Editor state that is **not** saved with a config (brightness, physics rate, world size, canvas aspect, and the whole display pipeline: tone curve, motion blur, bloom, overlays). Persisted to `preferences.json`. |
| `shared/`         | The sanctioned exception: stateless GL utilities (`read_shader` incl. `#include` resolution, `tryset`, `quad_vbo`/`quad_vao`, and `reload_program`/`reload_compute` — the one implementation of shader compilation) and cross-module shaders (`fullscreen_quad.vert`, **`common.glsl`**). No domain state. |
| `configs/`        | Physics preset JSONs (`Starcrossedv8.json`, `9leafv8.json`, `hatmanv8.json`). |

### Key files in `particle_system/`

| File | Role |
|------|------|
| `layout.py`  | Parses `common.glsl` struct declarations into numpy dtypes. The host packing can never drift from the shader's view of memory. Strict: raises `LayoutError` on any non-vec4 member. |
| `coords.py`  | The Python mirror of the coordinate math in `common.glsl`. One of only two places allowed to write aspect-ratio or camera math. |
| `config.py`  | `SimulationConfig` (-> `ConfigData`, per-population), `WorldSettings` (saved world state) and `WorldConfig` (-> `WorldData`, settings + runtime sizing). |
| `sizing.py`  | Entity count and canvas resolution for a world size (`sizing_for`, `canvas_dimensions`), and the two constants they derive from. A leaf: imports only `math`, so `strafe_field` can shape its texture without importing the simulation. |
| `picker.py`  | `EntityPicker`: nearest-entity-to-a-world-point, reduced on the GPU. Lives here because it reads the entity buffer. |
| `persistence.py` | Reading/writing config files (v8), the legacy v7 reader, and categorized discovery of `configs/`. |

## Design rules

These are the load-bearing constraints. Follow them when extending the project.

1. **Every file belongs to a module folder.** The only exception is `shared/`,
   which holds genuinely stateless utilities and the one shader used by more than
   one module. Diagnostic-only globals (e.g. `MUTED_TRYSET_WARNINGS`) are fine in
   `shared/` because they don't interface with domain state.

2. **Modules expose public *data* via typed values (dataclasses); public *GPU
   resources* via narrow accessors; simple *scalar state* via read-only
   attributes.** `SimulationConfig` is a frozen dataclass. Live GPU handles
   (textures, buffers, programs, VAOs) are *not* wrapped in dataclasses —
   they're opaque handles, not data. They're handed out per-frame via accessors
   like `ParticleSystem.current_canvas_texture()`, because their *identity*
   changes underfoot (the canvas double-buffer swaps every step).

   A count or a size has no such problem, so it is read as a plain attribute or
   property: `entity_count`, `frame_count`, `canvas_size`. `entity_count` used
   to be a method while its two neighbours were bare attributes, which made the
   convention look like an accident rather than a rule.

   **Writes are the asymmetry.** A module's state is read across the boundary
   but never *assigned* across it. `ParticleSystem.config_path` was the one
   exception — the Orchestrator did `system.config_path = ...` from four places
   — and is now a read-only property with a `set_config_path()` setter. The
   setter stayed separate from `apply_project()` rather than being folded in,
   even though the two usually fire together: `apply_project` is also the
   hover-preview and slider-edit path, where the project changes but its origin
   on disk does not, so bundling them would make *auditioning* a config in the
   load menu rewrite the window title.

3. **The Orchestrator is the sole broker.** Modules do not reference each other.
   All inter-module communication is a method call or data hand-off routed through
   the Orchestrator. Example (data): each frame the Orchestrator pulls the current
   canvas texture from ParticleSystem and passes it to Camera — Camera never holds
   a persistent reference to it, so the double-buffer swap stays invisible to it.
   Example (commands): the UI reports `'next_preset'`; the Orchestrator loads the
   file, builds a new `Project`, and hands it to `ParticleSystem.apply_project()`.

   More precisely, the rule is that modules never reference each other's
   ***stateful* classes**. `particle_system`'s **leaf modules** — `coords`,
   `config`, `sizing`, and the `layout` that `config` is built on — are
   sanctioned pure/value imports: no state, no GPU resources, nothing to get out
   of sync. `camera_state` imports `coords` for the view math, `strafe_field`
   imports `sizing` to shape its texture, and `project` imports `config`'s value
   types. Reimplementing that arithmetic per module is exactly the drift rule 9
   exists to prevent, and routing pure functions through the Orchestrator would
   buy nothing.

   What this rule *does* forbid is reaching past a leaf into the implementation
   module — importing from `particle_system.particle_system` pulls in
   ParticleSystem, moderngl, persistence, and `layout.py`'s parse of
   common.glsl. `particle_system/__init__.py` is deliberately free of
   re-exports for that reason: hoisting the class to the package root made every
   leaf import drag the whole simulation in behind it. Only the Orchestrator
   imports the implementation module.

4. **The moderngl `ctx` is the one sanctioned shared substrate.** It is created by
   AppWindow and injected once into each module at construction. You *cannot* pass
   a GL context per frame, so this is a deliberate, documented exception to
   "avoid persistent coupling" — which otherwise applies to *domain* state only.

5. **Shader setup is isolated and compile failure is non-fatal.**
   - Shader/buffer setup lives in `reload()` / `_reload_*` helpers, called from
     each module's constructor. **These helpers ARE the startup compilation
     path** — `assembler/bloom.py` compiles its programs nowhere else — so they
     are not optional scaffolding around some other init.
   - Failed compilation must **not** crash: log the error and leave the program
     as it was, which at startup means `None`. Callers guard on `None`. The one
     deliberate exception is `TooltipGraphic`, which raises in its constructor;
     its own comment explains why startup is the place that should.
   - Use `tryset()` for all uniforms — a uniform the compiler optimized out is
     absent from the program, and ModernGL raises on assigning a missing one.

   **The reload TRIGGERS are gone** (the `U` key, the Simulation ▸ Reload
   Shaders item, the Debug panel's Reload button, `Orchestrator._cmd_reload`).
   Reloading a shader edited on disk has no meaning in a browser, so the port
   should not carry the affordance. What survives is the *shape*: setup isolated
   in a re-runnable helper, failure logged rather than fatal. That shape is
   worth keeping on its own merits — it costs nothing and it is what makes the
   `shared/gl_utils.py` helpers callable at all — but nothing in the app calls
   it a second time, and the port need not make it re-runnable.

   The names still say "reload" for that reason. Read them as "compile".

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

   *Texture formats follow the same principle.* A format is chosen to work in
   **base** WebGPU, not to be maximally precise: the canvas is RG16F because base
   WebGPU can neither filter nor blend `rg32float` without optional device
   features, while `rg16float` filters, renders, and blends with none. Where that
   costs precision, the fix lives in the shaders (`CANVAS_VALUE_SCALE` and the
   saturation clamp in `common.glsl`) rather than in a format upgrade that would
   narrow the device matrix.

   The user-drawn field was RG16F for the same reason and is now **RGBA16F**,
   which clears the same bar — base WebGPU filters, renders and blends it with no
   optional features, so this is a widening rather than a narrowing of the device
   matrix. It has its own `FIELD_FORMAT` rather than sharing `CANVAS_FORMAT`:
   widening the canvas would double the largest texture in the app for two
   channels it never writes, while the field is capped at `MAX_FIELD_DIM` and pays
   the cost once, flat.

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

When adding something in this category, give it its own file or its own commit
up front. Retrofitting the isolation later is the expensive path.

**Already removed this way**, as evidence the isolation pays off: multi-config
editing (`ui/config_manager.py` + `orchestrator/config_manager_commands.py`, one
file deletion each plus a mixin unhook, taking the save dialog's ConfigBuffer
radio pair and `Project`'s slot mutators with them) and the hot-reload triggers
(see invariant 5). The ConfigBuffer *system* stayed; only its editing UI went.

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

**The fifth vec4 is now full too, and was renamed `misc2` as a result.** Its
last two spare lanes went to the sensor jitters — the *other* half of rule 7,
claiming reserved lanes rather than adding a vec4, so `ConfigData` stayed 400
bytes through that addition.

**Radial Gravity** then found `misc2` full and took a sixth vec4, `misc3` (400
to 416 bytes), leaving three spare lanes. It is a single bool riding an int lane
(`floatBitsToInt(...) != 0`, as `color_by_cohort` does), and it redirects both
gravity channels at once: the shader takes the pull direction *once* — the fixed
`vec2(0,1)` or `normalize(pos)` — and multiplies both `_force` and `_strafe` by
it, so the two channels cannot disagree about which way is down. `pos` is
centred on the origin, so the normalized position vector points outwards and the
existing negation makes a positive slider fall *inwards*. A particle exactly at
the origin gets no pull, because `normalize()` there is NaN and one NaN
permanently destroys that particle's position.

It was called `appearance` while it held only `color_sensitivity` and
`color_by_cohort`. The jitters are physics, so that name became a lie about half
its contents. **Overflow lanes are named for being overflow lanes** — `misc`,
`force2`, `misc2` — because a vec4 is a place four floats fit, not a category,
and a thematic name makes the next addition agonize over whether it belongs.
Read the per-lane comment, not the name.

### Sensor jitter

Two 0..1 controls that add a random wobble to where a particle looks, applied in
`entity_update.glsl` just before the sensor offsets are built:

```glsl
angle    += angle_jitter * (2*hash(...) - 1);
distance += SENSOR_DISTANCE_SPAN * distance_jitter * (2*hash(...) - 1);
```

**Each is scaled so 1.0 spans the whole range of the slider it perturbs.** Angle
is already a -1..1 half-turn control and needs no scaling; distance is
0..5, so it carries that span as `SENSOR_DISTANCE_SPAN` in `common.glsl`. That
constant **mirrors the `hi` of the `sensor_distance` entry in
`settings_spec.py`** — the shader cannot read the registry's bounds, so widening
one means widening the other. Both call sites carry a note saying so.

Fitting the scale to each parameter individually is the point: it is why these
are two purpose-built controls rather than the reference's one generic
`jitter` lane on every `PhysicsSetting`, which was proportional to the result
(`result += jitter * result * random`) and therefore did nothing at all when a
setting sat at zero.

**Resampled every physics step, not fixed per particle** — seeded on
`(index, frame_count)`, so it is a *shimmer* that softens structure rather than
a population of individuals with permanently different eyes. At the default
Physics Rate that is ~1800 redraws a second.

**Both sensors get the same draw**, applied to the pair together, so they stay
symmetric about the heading. Jittering them independently would introduce
exactly the left/right bias that the `y_reflect` mirror term exists to cancel.

**Distance is deliberately unclamped.** Because the jitter is offset either way
around the base value, high settings push it negative for some steps, which puts
both sensors *behind* the particle with left and right swapped. That is a look
no other slider reaches, so it is kept rather than clamped at zero.

They live in the `misc2` vec4 and therefore in the save file's `misc2` block —
because that is the lane they fit in, not because they share a theme with the
two colour settings beside them. They are physics, and they are in the Sensors
tab.

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

`CameraMode.PARTICLES` (**the default**) draws one instanced sprite per entity,
transformed to screen ndc **in the vertex shader** — so the camera is baked into
the vertices and the present pass must not apply it again. Particles are
world-sized (they grow as you zoom in), matching the original's feel. It is the
default because it is the more direct view of what the simulation is doing, and
the only one that carries the per-particle colour signal.

Both modes consume the same transform, so they agree pixel-for-pixel about where
a world point lands and toggling between them does not shift the image.

## Saving & loading

**Format v8** writes what this codebase actually has: a `world` block, a
`configs` list, and optionally a `camera`. Fields the project cut —
`slider_ranges`, `sweeps`, `parameter_sweeps_enabled`, the reference's generic
per-setting `jitter`, and most of v7's `appearance` — are **not written**. A
save format that carries dead features teaches the next reader those features
exist. (The two *sensor* jitters are a different, purpose-built feature and are
written; see "Sensor jitter" above.)

**A config's blocks are named after the GLSL struct's vec4s**, so a file can be
read side by side with `common.glsl`. The cost is that renaming a lane renames a
block: `misc2` was `appearance` until the sensor jitters landed in it, and
`_config_from_dict` reads **both** names so nothing written before the rename
stops loading. A rename is therefore cheap but not free — prefer getting the
lane name right when the vec4 is added.

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

Two submenus browse config collections by hovering — **File > Load** (files on
disk) and **Edit > Load Checkpoint...** (in-session checkpoints). Both use the
same state machine, implemented once in `ui/hover_preview.py` as
`PreviewSession`:

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
independent hover surfaces that breaks — one surface's preview overwrites the
other's snapshot, and unhovering restores the wrong state. `snapshot_configs`
therefore *returns* the snapshot rather than storing it, and `restore_configs`
takes one back. Keep this even though both surfaces are now submenus that
cannot be open simultaneously: the sessions are what make that safe, not the
menus, and a future panel-hosted browser would reintroduce the overlap.

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

**A slider's travel can be bent, via `curve`.** `value = lo + (hi-lo) *
pos**curve`, so an exponent above 1 spends most of the handle's travel near
`lo`. Hazard Rate is the case that needs it (`curve=3.0`): it is a *per-step*
probability applied ~1800 times a second, so everything usable is crammed into
the bottom tenth of its range and a linear slider is unusable — 46% of the
travel now covers what used to be 10%.

**Only the POSITION curves; the value never does.** What is dispatched, stored,
saved and shown in the readout is the real number, so adding or retuning a curve
cannot change what any config means. The readout is spelled out explicitly for
these, because a bent handle no longer suggests the magnitude, and imgui's
default `%.3f` would render a whole useful range as "0.000".

**Slider bounds are fixed and generous.** User-adjustable ranges were cut; a
config needing a value outside a bound is handled by ctrl+clicking the slider
to type an exact value, which imgui supports natively.

**Disruptive settings are typed inputs, not sliders.** World size and canvas
aspect reallocate GPU buffers and reset the simulation, so they commit on
Enter — a slider would rebuild the system on every frame of a drag.
`Preferences.requires_restart` decides this, and `_rebuild_system` carries the
live configs across so a resize never discards unsaved edits.

**Undo is the config clipboard.** Set a checkpoint (Ctrl+C), experiment, then
hover Edit > Load Checkpoint... to A/B and click to revert. A second, weaker
undo next to it would be redundant.

## Config management

**The ConfigBuffer system ships; no UI exposes it.** `Project.configs` is a
tuple of arbitrary length, `Project.selected` indexes it, the GPU carries a real
`ConfigBuffer` SSBO, and the save format is a JSON *list* of configs. All of
that is intact and load-bearing. What is gone is the editing UI: nothing in the
app can add, duplicate, remove or re-select a slot, so in practice the buffer
holds exactly what was loaded from disk — one config for every file that ships.

This is deliberate for the port. Re-exposing slot management means adding
mutators back to `project/project.py` (see the comment where they used to be)
and a window to drive them; it does **not** mean reworking the value type, the
buffer upload, or the file format. Two consequences worth knowing:

- **A save writes the whole buffer**, always. The dialog once offered "Config 0
  only" beside it, which could silently drop slots; with no way to create a
  second slot the choice was between two identical outcomes anyway.
- **`selected` is still read** (`Project.config`, `edit_selected`, the status
  key) and still clamped in `__post_init__`, so a file with several configs
  loads and renders correctly — it just cannot be navigated.

**The config clipboard** holds in-session checkpoints of the **entire**
ConfigBuffer — a scratch space for experimenting without committing to disk.
Checkpoints are named `<preset><NN>` (`Starcrossed00`, `Starcrossed01`, …),
numbered per preset, and numbering *reuses freed gaps* so heavy churn does not
drift into high numbers. Newest is on top. Deleting has no confirmation: unlike
a saved file, a checkpoint is a cheap scratch copy.

Session-only by design — they vanish on quit. File > Save is the route for
anything worth keeping.

**It is entirely in the Edit menu** — `Set Checkpoint` (Ctrl+C), `Load Latest
Checkpoint` (Ctrl+V), and the `Load Checkpoint...` submenu that browses them by
hover. It *was* a standalone window, which had to carry its own open/close
lifecycle, its own child-window scrolling, and its own "Set Checkpoint" button
duplicating the menu item beside it — all so it could show a list that is
usually empty and never long. The submenu is the same browse-by-hover contract
as File > Load, which is what the act already was; making it look like one is
what removed the duplication. The commands in
`orchestrator/clipboard_commands.py` did not change, which is the sign the
window was UI and nothing else.

**There is no slot cap.** A `MAX_CONFIGS = 64` used to sit in
`particle_system.py`, justified purely as keeping the manager UI bounded and
making a failed append reportable ("Added 2 of 3"). With no append path it had
no reader, and nothing on the GPU side ever enforced it — `_upload_configs`
sizes the SSBO to `len(configs)`. The real bound is the entity count, since
`config_index` lives per entity. **A port that re-exposes slot management should
reintroduce an explicit cap** rather than inherit that as a guarantee.

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
- **Uniforms constant for a program's lifetime are set at compile time.**
  Texture units and `canvas_resolution` go in `_set_constant_uniforms()`, called
  from `reload()` because a freshly compiled program starts with its uniforms
  unset. Anything that recompiles a program must call it again.

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

**Randomize Behavior** (`B`) is the opposite move: throw the rule away and grow
a new one. It works through a sentinel — **an all-zero rule is not a rule**.
`entity_update` tests two lanes (`centers[0].frequency` and
`centers[5].amplitude`) for exactly zero and reads that as "no target given",
generating random centers from the mutation seed instead. Zeroing is therefore
how the host asks for a new behaviour without reproducing the shader's
generator in Python.

**The seed has to move with it.** That fallback is seeded by `mutation_seed`,
so zeroing the rule alone regenerates the *same* behaviour every time — the
command would appear to work (the config visibly changes to zeros) while the
simulation looked identical on every press. Both fields change together as one
undoable step, because together they are one act.

**A generated rule is never mutated.** It is already random, and the seed that
produced it rerolls it wholesale, so Mutation Scale has nothing to add — and
letting it apply would mean that slider silently reshaping a rule the user
never authored. `entity_update` therefore branches: generate *or* mutate, never
both.

That also makes selection work. `mutate_rule` derives its own seed by **hashing
the rule's coefficients**, and `hash()` is chaotic by design; the GPU fuses a
multiply-add in the generator that numpy cannot, so the host's copy of a
generated rule differs by one ULP. Mutating on top amplified that ULP into a
completely different rule (measured: internal seed 0.3088 vs 0.2605, final
coefficients off by 1.65). Without the mutation the difference stays at that
one ULP — invisible — and `mutation.entity_rule()` reproduces what a particle
is actually obeying. Selecting such a particle then writes the generated rule
into the config as a real one, so the sentinel stops firing from that point on.

That numerical argument is **about the host mirror, so it does not apply to the
web port**, which has none. The *design* reason above does, unchanged and
sufficient on its own: Mutation Scale must not silently reshape a rule the user
never authored. The branch itself is identical on both sides.

The host mirror must follow **both** branches. It once skipped the sentinel
entirely, which was defensible only while nothing produced zero rules;
Randomize Behavior does, and the mismatch showed up as selection adopting
near-zero coefficients and the simulation appearing to die. On the web there is
no host mirror to keep in step -- `derive_entity_rule()` in
`web/src/particleSystem/shaders/rule.wgsl` *is* both branches, and
`entity_update` calls that same function.

**The desktop recomputes the rule host-side; the web port reads it back.** These
genuinely differ, and both are deliberate.

On the desktop the particle's rule comes from `particle_system/mutation.py`, not
the GPU. The mutation is deterministic in `(rule, scale, seed, cohort)`, so
Python can reproduce it -- avoiding the extra buffer and readback the original
needed. The price is that the mirror must stay bit-exact with the shader; a
probe test runs the simulation's own `mutate_rule` and compares. **Edit one
side, edit both, and re-run that test.**

**The web port deliberately has no mirror.** In JavaScript the float32
discipline would have to be manual (`Math.fround` on every intermediate,
`Math.imul` for the hash), and `np.power(h0, 2.0)` at `mutation.py:149` -- where
`pow(h,2)` and `h*h` differ by one ULP that the chaotic hash amplifies into a
completely different rule -- has no reliable JS equivalent. A wrong adopted rule
*looks like a legitimate result*, which makes it the worst failure mode
available. So `web/` derives the rule **on the GPU**: a second one-invocation
dispatch reads the settled pick key and writes the winner's rule, and
`retrievePick()` reads back 336 bytes (key, position, 320-byte `Rule`) instead
of 4. The generate-or-mutate branch lives once, in `rule.wgsl`, included by both
`entityUpdate.wgsl` and `entityPick.wgsl` -- so the two cannot drift, and
`mutation.py`'s float32 discipline, the `pow` trap and the GPU-vs-host probe
test all cease to exist on that side.

One signature differs as a result: `get_cohort` takes the entity count as a
parameter on the web. `rule.wgsl` is included by two shaders that bind the
entity array with different access qualifiers (`read_write` in the update,
`read` in the picker), and a shared function may not name either binding.

**Tools** (`MouseMode`) exist because several behaviours all want the left
button -- without one, every click would select on the way down and paint on
the way across. `SELECT` (default) clicks to adopt and right-clicks to undo;
`SHOVE` drags to push particles away from the cursor and right-drags to pull
them in; `WALLS` and `TRAILS` each paint one layer of the user-drawn field and
right-drag to erase it. Selected directly with `1`/`2`/`3`/`4`, from the Tools
menu, or from the toolbar -- not cycled, because there is no sensible "next"
tool.

**`WALLS` and `TRAILS` differ only in which channels they write.** Every
mechanic -- brush size, power, mode, the eraser, the line tool -- is shared, and
`layerForMouseMode` is the whole difference. What differs is what the simulation
does with the result: walls are added to a particle's POSITION, trails to the
CANVAS SAMPLE its sensors read, so painted trails steer where painted walls
shove. `DRAW` was this pair's single ancestor and was renamed when "draw" stopped
naming one thing; the value is runtime-only, so nothing stored carries the old
name (see `commands.ts`).

**Holding Shift turns either painting tool into a line tool**: the cursor's
position becomes an anchor, a half-opacity capsule previews the stroke, and a
press commits it -- left to draw, right to erase, endpoints chaining into a
polyline. A drag already in progress suppresses arming, so the modifier cannot
seize a gesture mid-stroke.

**There is no Pan tool.** Navigation is `WASD` to pan, `Q`/`E` to zoom, and the
scroll wheel, all of which work in every mode. A tool that only moved the view
was spending a mouse button on something the keyboard does better, and while
held it blocked every other tool -- you could not adjust the view mid-stroke.
Select is the default now because it is the only tool whose effect is a single
undoable step, so a stray click on startup cannot smear the simulation.

### What history records

Every deliberate act: slider edits, particle selection, seed randomization,
committed loads, preset cycling, checkpoint restores, and config
add/duplicate/remove.

**Two exclusions, neither an oversight:**

*Hover-preview and its restore.* Both browse submenus apply a config as the
cursor crosses each row, then put it back. These are transient
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
`COALESCE_WINDOW` (1.5s on the web; the Python's 0.5s) collapse into one � the
entry's *end* state updates in place while its start stays put, so undo jumps
the whole gesture. The window is measured from the last edit rather than the
start of the drag, so it bounds how long a PAUSE may be, not how long a gesture
may run. The web port widened it because nothing on its slider path calls
`breakCoalescing` � a timeout is the only way a gesture ends there, and at 0.5s
hesitating mid-drag to look at the result split one adjustment into several
undo steps.

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

Picking is **two-phase**: `ParticleSystem.request_pick(world_pos, radius)`
dispatches the reduction, and `retrieve_pick()` reads the answer on a *later*
frame. Three design points are load-bearing:

**On-demand, never per frame.** A pick dispatches over every entity, which
measured in the tens of milliseconds per frame at large world sizes — far too
much for an answer only wanted when the user acts. A SELECT-mode click requests
one; nothing else does. There is deliberately **no hover-picking** and no
`hovered` readout: that would mean a full dispatch every frame, which is the
cost this design exists to avoid.

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

**The result is one frame old, and selection is built around that.** Reading a
buffer the same frame you wrote it forces a GPU sync, and WebGPU has no
synchronous readback at all — so the deferred shape is both faster now and the
one that ports. The ~16ms of latency is imperceptible on a click.

A SELECT-mode click therefore does not select. It calls `request_pick()` and
stores a **pending selection**: the `Project` as it stood *at click time*. The
next frame's `_resolve_pending_selection()` retrieves the winner, adopts its
rule, and records history against that stored state — not against the project as
it stands when the result lands, which may have moved in between. A miss is
dropped silently.

Two ordering constraints hold this together:

- The resolve runs at the **top of the frame, before `_apply_canvas_input()`**
  can dispatch a new pick. Read-before-write; the other order would be reading a
  pick issued microseconds earlier, which is the stall again.
- It runs in the **frame loop, not inside `advance()`**, because `advance()` is
  skipped while paused and clicking to select must still work when it is.

A second click while one is pending **replaces** it, carrying its own
click-time state (last click wins). The picker has a single result slot, so the
older dispatch's answer is gone regardless; honouring it would mean adopting a
rule from a pick aimed somewhere else.

`pick_blocking()` remains for host-side tooling and tests — notably the
comparison in `tests/test_async_pick.py`, which asserts the async path chooses
the same entity. It stalls and does not port, and is no longer on any live path.

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
       _apply_canvas_input(state)        # ACTIVE TOOL decides: pan / select /
                                         #   paint. Painting happens here, above
                                         #   the render, because it binds its own
                                         #   FBO. Scroll always zooms.
       blur_schedule(prefs)              # -> (samples, stride)
       Camera.begin_frame(size, samples) # size + clear the accumulator
  30x  ParticleSystem.advance(field)     # GPU sim sub-steps; field hoisted out
                                         #   of the loop, it cannot change here
   Nx    Camera.render(...)              # EVERY `stride` STEPS, inside the loop:
                                         #   draw a sample, add it to the
                                         #   accumulator weighted 1/N. Canvas
                                         #   texture pulled per sample -- it
                                         #   double-buffers inside advance().
       AppWindow.begin_frame()           # bind + clear default framebuffer.
                                         #   AFTER the loop: the camera binds its
                                         #   own FBOs for every sample above.
       Assembler.present(                # bloom -> brightness -> tone curve ->
           camera.result(), ...)         #   field overlay -> reticle -> screen
       Orchestrator._report_status()     # push display-only values to UI
       UI.end_frame()                    # build panels, imgui.render(), draw
       AppWindow.end_frame()             # swap buffers

UI -> named command -> Orchestrator handler
     Ctrl+Z / Ctrl+Shift+Z = undo / redo
     Ctrl+C / Ctrl+V = set checkpoint / load newest checkpoint
     Ctrl+R = revert to the project's saved file (same as File > Load > it)
     SPACE = pause/resume | R = reset
     B = randomize behavior | F = randomize mutation seed
     X = show/hide the GUI
     LEFT/RIGHT = prev/next preset
     TAB = toggle camera mode | HOME = reset view
     1/2/3/4 = select / shove / walls / trails tool
     (commands also exposed as buttons in the Debug panel)

NAVIGATION -- continuous, read from keys_held in the Orchestrator
     WASD = pan | Q/E = zoom out/in | scroll = zoom (anchored at the cursor)
     Works in every tool: navigation is not a tool.

MOUSE, per tool
     left-drag  = select (Select) | push (Shove) | paint (Walls, Trails)
     right-drag = undo (Select)   | pull (Shove) | erase (Walls, Trails)
     SHIFT      = line tool, in the two painting tools only. Anchor on
                  press-free movement, commit on click: left draws, right
                  erases, and the endpoint becomes the next anchor.
```

**Why input is polled at the top.** Events are gathered before the physics and
rendering that consume them, so a frame acts on its own input rather than the
previous frame's. Polling used to sit next to the buffer swap at the bottom,
which cost a frame of latency — invisible for keyboard shortcuts, but plainly
visible when dragging. `AppWindow` therefore no longer pumps the event queue;
it only swaps.

**One-shot keys and continuous keys are handled in different places**, and the
split is deliberate:

- **One-shots** (`SPACE`, `R`, `U`, `G`, `X`, tool numbers) read
  `keys_pressed` in `UI._dispatch_hotkeys` and fire a named command. They
  happen once per press.
- **Continuous** navigation (`WASD`, `Q`/`E`) reads `keys_held` against `dt`
  in `Orchestrator._apply_camera_keys`. Routing it through the hotkey table
  would make it one step per key-*repeat*, whose rate is an OS setting — the
  camera would stutter, then accelerate, at a speed the app does not control.

Both scale correctly by construction: the pan step is a fraction of the visible
height per *second*, so a keypress covers the same distance at 30fps and 144fps
(verified exact), and it is divided by zoom so it covers the same fraction of
the *screen* at any magnification. Zoom is exponential per second, because zoom
is multiplicative — a fixed additive step would crawl when zoomed out and lurch
when zoomed in.

`X` is the one key the UI handles itself rather than dispatching. Hiding the
panels changes no simulation state, so there is nothing for the Orchestrator to
broker — rule 10 cuts both ways.

**Pause** (`SPACE`) freezes the physics *and* the Shove tool, so a paused frame
is genuinely untouchable. The camera, the overlays and the whole UI stay live,
so a frozen state can still be navigated and inspected. Two details worth
knowing: the frame loop still runs one iteration while paused (the camera has
to draw the frozen state, or the screen goes black — it is `advance()` that is
skipped, not the render), and motion blur collapses to a single sample, because
N samples of an unchanging scene is the same picture at N times the cost. The
guard that stops shoving lives inside `shove_state()` rather than at the call
site, so a second caller cannot silently defeat it.

**The pause is QUEUED, and the frame it freezes on is deliberately blurred.**
An ordinary pause stops on whatever sub-step the loop reached — a hard, aliased
still, and the one frame a user is most likely to sit and stare at or
screenshot. Instead, the frame following a pause request runs
`PAUSE_SETTLE_FRAMES` (4) render frames' worth of extra physics and averages
every 4th sub-step into a single image. That is `physics_rate * 4` extra
sub-steps producing `physics_rate` samples — one render frame's worth of
samples spread over four frames of motion — so the freeze lands on a properly
motion-blurred still **regardless of the motion blur preference**, including
with blur switched off, which is the case the feature exists for.

`PAUSE_SETTLE_FRAMES` in `blurSchedule.ts` is the only place that 4 appears. It
sets the extra physics, the sample count and the stride together, and the tests
derive every expectation from it rather than from a literal — retuning it is
expected and does not turn the suite red.

**The still is then HELD, not re-rendered.** This is the part that is easy to
get wrong: an ordinary paused frame clears the accumulator and draws one sample
into it, which would overwrite the blurred still one frame after it appeared —
the blur would be computed correctly and then immediately thrown away. So while
a still is being held the frame loop records *no camera work at all*: no
`beginFrame`, no `clearAccumulator`, no `render`. The accumulation texture from
the settle frame simply stays on screen. `beginFrame` in particular must be
skipped because its `samplesTaken = 0` would make `result()` report an empty
accumulator and blank the display.

**And the hold is abandoned the moment it stops being true.** The still is an
average of samples from a simulation state the settle already advanced past —
the texture is the only copy, and it cannot be re-rendered from a new angle. So
it is only valid from the exact viewpoint it was taken at. Any of these drops it
and falls back to rendering the frozen entities live (sharp, not blurred, which
is the honest trade — a correct image of where you are looking beats a blurred
one of where you were):

- **pan, zoom or a camera-mode flip** — compared exactly, with no epsilon: a
  tolerance would let a slow drag creep the view while a stale still stayed
  frozen on screen;
- **painting or clearing the strafe field**, both of which stay live while
  paused, and would otherwise be invisible until the next resume;
- **a target resize**, which replaces the accumulation texture outright —
  `invalidateTargets()` zeroes the sample count so `canHold()` reports honestly;
- **resuming**, which drops it so the next frame shows live motion.

The drop is permanent rather than a one-frame suspension: nothing can rebuild
those samples, so every later paused frame re-renders live until the next pause
earns a fresh still.

Two ordering details carry the design:

- **`paused` flips immediately; only the *rendering* is deferred.** Half the app
  pauses by reading `status().paused` and toggling only on disagreement (the
  splash, export start and finish, rate calibration). A flag that lagged the
  request by a frame would make those callers fire a second `togglePause` and
  cancel the first — a pause that silently does nothing.
- **It all happens in one frame-loop iteration.** The settle frame is 4× the
  usual physics work in a single `runFrame`, which keeps the control flow free
  of a multi-frame state machine at the cost of one potentially long frame.
  `ensureUniformCapacity` grows the per-sub-step uniform buffers to match and
  does not shrink after, so the cost is paid once per session.

## The frame assembly pipeline

Everything from "the simulation has advanced" to "pixels are on screen". The
stages are split across two modules and the order is load-bearing:

```
Camera                                    Assembler
------                                    ---------
colorize   RG canvas -> RGB               bloom       threshold, 5 mips down,
           (linear HDR, no tone curve)                tent up, add (LINEAR)
accumulate acc += sample * 1/N            brightness  linear exposure
           (RGBA16F, ONE/ONE blend)       tone curve  asinh, linear -> display
                                          overlays    field, reticle
```

**Everything before the tone curve is linear.** Bloom and brightness are
physical operations — adding light, then exposing it — and both are only
meaningful on energy. The curve runs exactly once, at the end. The reference
tonemaps *before* blooming and pays for it by inverse-tonemapping in two
separate shaders to get back to a space where addition means anything;
assembling in this order deletes both round-trips and the precision they cost.

**The overlays go after the curve**, which is the one place the ordering
inverts. They are annotations, not part of the image: running the reticle's
white through a compressive curve would dim it and make its apparent thickness
depend on how bright the scene behind it happens to be.

### The tone curve

`rgb *= asinh(L * softness) / (L * softness)`, where `L = length(rgb)`.

Applied to the **length** of the colour rather than per channel, so the
direction of the vector — hue and saturation — survives untouched. Dividing by
softness keeps the curve tangent to the identity at the origin for every
setting, so dim regions stay put as the slider moves and only highlights
compress. It is unbounded: it never asymptotes to 1, so a bright enough region
still clips at the 8-bit present. That is accepted, not overlooked.

This replaced an ad-hoc `rgb / pow(L, 0.575)` that lived inline in
`camera.frag`, and which PARTICLES mode never had at all — that mode folded
brightness into per-sprite alpha instead, so the two modes answered to the same
slider differently. Both now feed the same accumulator and the same assembler.

### Motion blur is a temporal supersample

A displayed frame is the average of N renders taken at different points in the
simulation's advance, which is why fast movement smears instead of stepping.
`blur_schedule()` in `orchestrator/orchestrator.py` derives the cadence:

```python
stride  = max(1, physics_steps // motion_blur_samples)
samples = ceil(physics_steps / stride)
```

**THE SAMPLE COUNT IS A TARGET, NOT A PROMISE.** Samples must fall a whole
number of physics steps apart, so what the user asks for is only achievable
when it divides `physics_steps`. At 120 steps, X=10 lands exactly (stride 12);
at 100 steps, X=8 gives stride 12 and therefore **9** samples.

The weight must be `1/samples`, never `1/X`. Weighting by the requested count
would darken the image by the ratio between them — but only at slider positions
where the two disagree, which is a miserable bug to find by eye. The invariant
worth protecting is that **toggling blur, or changing the sample count, must
not change overall brightness.**

What makes that safe is an identity: the count of steps satisfying
`step % stride == 0` over `range(n)` is *exactly* `ceil(n / stride)`. Not an
approximation — so the accumulator always receives precisely the number of
samples it divided by. It depends on the loop starting at zero and the test
being `== 0`; the un-blurred path deliberately uses `== stride - 1` instead, so
a still image shows the newest state rather than a stale one, and it does not
share (or need) the guarantee.

### Read-write hazards, and why blending is used instead

Two passes here would naively want to read a texture they are writing. Both
are done with additive blending instead:

- **The accumulator** weights each sample by `1/N` in the shader and lets the
  blend unit sum them. Clearing once per cycle *is* the reset, which removes
  the reference's `is_first_frame` branch entirely.
- **Bloom's upsample** adds the tent-filtered mip into the destination the same
  way, rather than sampling the destination.

The reference does both by binding the target as a sampler while it is attached
to the bound framebuffer. That is undefined behaviour; it survives there only
because sampling is 1:1 at the fragment's own uv. Letting the blend unit do the
addition is correct *and* cheaper, and it does not need a ping-pong pair.

### Particle colour

In PARTICLES mode (TAB) each particle is coloured by its **own brain**, not by
where it is heading. `entity_update` stores a raw two-lane signal in
`Entity.misc.zw` (`col_params`), and the particle camera turns `.x` into a hue:

```glsl
// cam_brush.frag
float hue = color_sensitivity * col_params.x;
vec3 rgb = hsv2rgb(vec3(hue, 0.8, 1.0));
```

The signal is `baseterm.xy + mirrorterm.xy` — the black box's force terms,
**not** `y_reflect`'d the way `force` is. Cancelling the mirror bias is what
keeps *motion* free of a clockwise preference, but colour wants that asymmetry:
it is what makes the signal something other than a recoloured copy of the
velocity. The values are arbitrary and tuned by eye; nothing should read
meaning into their scale.

**Every colour decision happens in the renderer.** `entity_update` transmits
both signals and chooses neither: `col_params.x` is the brain's output,
`col_params.y` the particle's cohort index. The reference bakes its choices
into the compute shader (`e.hue = hue_sensitivity * col_params.x`, with a
branch for cohort colouring above it); keeping the raw signals means both
Color Sensitivity and Color By Cohort re-colour the frame without re-running
any physics.

**That is not just tidiness — it is what makes the controls work while
paused.** A display decision made in `entity_update` only takes effect on the
next physics step, so the checkbox appears broken exactly when you most want
to flip between the two and compare a frozen frame. Verified: toggling it
changes the image with `frame_count` unchanged.

**Color By Cohort** therefore lives in `cam_brush.frag`, selecting `.y` instead
of `.x` and scaling it by `COHORT_COLOR_CONSTANT` (0.75). A fixed step per
cohort rather than the reference's `hash(floor(cohort))`: adjacent populations
land three quarters of the way around the wheel from each other, separated
without the arbitrary jumble a hash gives, and hue's periodicity means it needs
no normalizing by the cohort count. Sensitivity scales both signals, so it
stays meaningful in either mode — by cohort it sets how far apart the
populations sit on the wheel.

Note the practical consequence of the scale: `col_params.x` typically has a
spread of ~3, so hue wraps more than once above roughly 0.15 and the population
starts to read as static rather than structure. Low sensitivities are where the
structure is.

Both settings are CONFIG (saved, undoable), in the **Appearance** tab. They are
rendering settings that happen to live per-config, because a config's colours
are part of how it looks. `color_sensitivity` reaches the Camera as a plain
uniform brokered by the Orchestrator, taken from the SELECTED config — Camera
does not read the config buffer, which belongs to `ParticleSystem` (rule 3), so
with several configs loaded the selected one sets the palette for all.

TRAIL mode is unaffected: the canvas is RG16F and stores a 2D vector with no
room for a hue channel, so trails still colour by the angle of that vector.

### The overlays

Both walk the same inverse view transform the camera does
(`screen_ndc_to_canvas_uv` in `common.glsl`), so they pan and zoom with the
world instead of sitting on the glass. Per rule 9, they compose that transform
rather than writing a fresh one.

**Field overlay.** `1 - exp(-magnitude * GAIN)` as grayscale — saturating
rather than clamped, so a faint field and a heavily overpainted one both stay
readable and repainting a spot approaches white instead of flattening into a
solid blob. Canvas uv indexes the field directly: the field is the same *shape*
as the canvas, only capped in resolution. **Opacity exactly zero is the off
switch** — the shader does not sample the texture at all below it.

**Brush reticle.** A thin white ring at `2 * draw_size`, which is the gaussian's
visible extent and also exactly the eraser's hard radius — so the ring reads as
"what the eraser will take". Its radius is measured in the **same
`aspect_correct_uv` metric `strafe_draw.frag` paints in**, which is what keeps
it circular on a non-square canvas. The reference drew this in its frame
assembly pass and never got it right, carrying an unexplained `4/3` fudge
factor; reusing the brush's own metric is what removes the need for one.
`fwidth` sets the line width, so thickness stays constant in screen pixels at
any zoom.

**Dashed means Shove, solid means Draw.** One brush serves both tools and the
circle is genuinely the same size in each, so the ring's *shape* cannot say
which is armed — its *line style* does. Drawing a different radius would be a
lie about the reach; changing only the line leaves the geometry honest.

The dash count is **fixed per revolution** (16), not a fixed dash length: the
ring changes size with the brush and with zoom, and a fixed length would
degenerate into a dotted blur on a small brush and near-solid arcs on a large
one. A fixed count keeps the pattern recognisable at every size, which is the
whole job.

Antialiasing the dash ends needs the **angular** footprint, and the obvious
`fwidth(angle)` is wrong: `atan` wraps once per revolution, so at that seam the
derivative explodes and smears one cell into a solid blob. The arc width is
derived from the radial `fwidth` and the radius instead, which is continuous
everywhere.

Whether either overlay is visible is decided by the **Orchestrator**, not the
UI and not the assembler: it depends on the active tool, and only the
Orchestrator knows that (rule 10). The field can optionally persist outside the
Draw tool; the reticle never does. `reticle_dashed` follows the same rule — the
assembler renders the style it is handed and decides nothing.

## The Shove tool

Pushes particles away from the cursor while the left button is held, pulls them
in on the right. It shares the Draw tool's brush — `draw_size` is its gaussian
sigma, `draw_power` its strength, and the same reticle shows its reach — but it
is doing something categorically different, and the two are easy to confuse:

|        | acts on          | persists?                        |
|--------|------------------|----------------------------------|
| Shove  | the **particles** | no — only while the button is down |
| Draw   | the **field**     | yes — until erased                 |

Draw paints a force that keeps pushing whatever crosses it. Shove *is* the
push. That difference drives everything below.

**It runs inside the physics loop**, unlike painting. The field is a texture
that persists between sub-steps, so it can be written once per frame and read
many times (`strafe_draw.frag` says so at the top: painting per sub-step would
make the brush `physics_steps`× stronger). A shove has nothing to persist in —
it must be applied *as* particles move, or it would be one jump at an arbitrary
point in the frame's advance.

That makes it inherently per-sub-step, so the strength is divided by that count
before it reaches the GPU (`shove_commands.shove_state`) — otherwise the raw
value would be applied `physics_steps` times per frame.

**But by `steps ** 0.75`, not `steps`** — a partial division, and the exponent
is the tuning knob. Dividing the rate out *entirely* (exponent 1) is correct in
principle: a held shove would move a particle the same distance per rendered
frame at any rate. It overshoots in practice, because it makes the brush 30×
stronger at rate 1 than at the default, which is unmanageable at the bottom of
the slider. The exponent keeps the direction and moderates that to 12.8× (21.6×
rather than 60× across the whole 1..60 range).

The direction is the point. Lowering the rate slows the whole simulation
against the wall clock; a shove that does not slow with it gets more purchase
on a scene that has been deliberately slowed down — which is exactly when a
user is working carefully and wants the tool to bite.

**Anchored at `SHOVE_REFERENCE_STEPS`**, so strength at the default rate is
`gain * power / 30` for any exponent. Without the anchor a bare `steps ** 0.75`
would land at ~12.8 at the default and quietly make the standard brush 2.3×
stronger — retuning the curve would silently retune the default too.

This has flip-flopped, so the losing argument is worth keeping. An early
version multiplied back up by `steps / 30`, making strength *proportional* to
the rate, on the theory that a shove should keep its weight relative to
everything else moving on screen. The theory is defensible and the feel is not:
it makes the brush go limp precisely at the low rates people select in order to
place things accurately, and it quietly turns the Physics Rate slider into a
strength slider. `shoveCommands.test.ts` pins the *direction* and the anchor
rather than just numbers, because the numbers are expected to be retuned and
the direction is not.

**Strafe channel, not force.** `pos += get_shove(pos)`, next to the painted
field and for the same reasons: drag cannot damp it, no rule can resist it, and
particles stop dead on release rather than coasting. Applied before the fence
and the boundary, so containment still gets the last word — you can shove a
particle against a wall, not through it.

**Measured in world space**, where the shader needs no aspect correction at all:
world space is already area-preserving, so a circle in it is a circle on screen.
The brush's sigma arrives pre-converted by `coords.uv_radius_to_world()`, which
is a bare factor of 2 — the aspect terms in the two metrics are identical and
cancel. That cancellation is *why* one radius can describe the same circle for a
tool working in uv (Draw) and one working in world space (Shove).

**Attract is stable at the centre** without a special case. The kernel peaks at
the cursor but the direction vector is undefined there, so `get_shove` returns
zero — the same guard `strafe_draw.frag` uses. Particles still pile into a dense
knot, which is what an attract tool is for; there is simply no NaN.

The cursor is resolved **once per frame** and held for every sub-step, hoisted
out of the loop exactly like the field texture: it cannot move mid-frame, so
asking again per sub-step would be the same answer at 120× the cost. A fast drag
therefore leaves a slightly scalloped wake rather than a smooth trench.

## The Strafe Field, and drawing

One RG16F texture at canvas resolution, painted with the mouse and read by every
particle on every physics step. Each texel holds a world-space vector that is
added **straight to position**:

```glsl
pos += STRAFE_FIELD_GAIN * get_strafe_field(pos, bc);
```

That makes it **advection, not a force**. It bypasses velocity entirely, so drag
never damps it and no rule can resist it — paint a swirl and everything caught
in it goes around, whatever it would rather be doing. Contrast the force
channel, where a rule can and does swim upstream. It is applied after gravity
and **before** the cohort fence and the boundary conditions, so containment
still gets the last word: you can paint a particle against a wall, not through
it.

It is deliberately **not** scaled by `1/sqrt_world_size`, unlike every force
around it. Those are tuned in world units and must shrink as the world grows;
this is painted in uv space and read in uv space, so it already tracks canvas
size. Scaling again would make an identical stroke weaker in a bigger world for
no reason the user could see.

**`STRAFE_FIELD_GAIN` is fixed, and that is a design decision.** The reference
had both a draw-power slider and a per-field strength multiplier, which interact
multiplicatively and give two ways to say the same thing. Here Draw Power alone
sets stroke strength; retuning the feel of the whole feature is the one constant
in `common.glsl`.

### Why no ping-pong

The canvas double-buffers because it diffuses: each texel reads its neighbours,
so reading and writing the same texture would race. The strafe field has no such
hazard — the brush shader never samples the field, and each fragment writes only
its own texel — so it renders in place, through hardware blending, into its own
FBO. One texture, no swap, and `current_texture()` is still a per-frame accessor
so that adding a swap later would stay invisible to callers.

### The brush

A fullscreen quad over the field's FBO, run **once per rendered frame — never
per physics sub-step**. Painting inside the `advance()` loop would make the
brush 30x stronger at the default `physics_steps` and would couple stroke weight
to the simulation rate, so that moving the Physics Steps slider silently changed
how hard you were drawing.

Two passes share `strafe_draw.frag`:

| | blending | writes |
|---|---|---|
| draw (left-drag) | `ONE, ONE` additive | `dir * 0.01 * (power/5) * gaussian(d) / draw_size` |
| erase (right-drag) | **off** | literal zero inside `d < 2*draw_size`, `discard` outside |

`dir` is the **Out-Repel** vector: a unit vector pointing away from the stroke,
in the aspect-corrected metric. Dividing the deposit by `draw_size` keeps a small
brush from feeling useless — per-texel intensity rises as the footprint shrinks,
so total painted impulse stays in the same range across the size slider.

**Strokes are segments, not points.** Each frame paints the whole segment from
last frame's cursor position to this one, using distance-to-segment rather than
distance-to-point. The reference splats a single gaussian per frame, which
visibly breaks into dots on a fast drag because nothing connects one frame to
the next. `_stroke_prev_uv` in `drawing_commands.py` is that memory; clearing it
on release is what makes the next press start a fresh stroke instead of drawing
a line from wherever the last one ended.

Erasing writes `fragColor` unconditionally. The reference conditionally assigns
from `fragColor` itself there, which reads an uninitialized `out` variable —
undefined behaviour that happens to be unreachable in its case. Do not port that.

### Why it is not saved

The texture is megabytes of binary belonging to no `Project`. It is **live-only**:
not serialized with a config, not in the undo timeline, and Clear Field is the
only reset. This matches the existing decision to leave canvas trails out of the
save format, and keeps `History` a timeline of `Project` values rather than of
mixed state it was never designed to hold. If a future format gains a
`sim_state` key, this is a candidate to live under it.

Its **controls**, by contrast, are ordinary `PREFS` — brush size and draw power
are how *your* editor is set up, so loading someone else's config must not
resize your brush.

### Resolution: capped, not canvas-matched

The field takes the canvas's **shape** but not its **size**. `field_dimensions()`
clamps it to `MAX_FIELD_DIM**2` texels (512² today — one constant in
`strafe_field.py`, read as a square-equivalent edge, so a wide canvas spends the
same budget on a wider, shorter texture).

It can afford to, because the field holds soft blobby pushes rather than
structure: it is filtered `LINEAR` and consumed as a smooth displacement, so
detail past this point is invisible while the VRAM is not. The canvas has to
track world size because trails *are* the fine detail; the field does not.

At RG16F (4 bytes/texel) that is 1 MB flat instead of following the canvas —
4 MB at world size 1, 16 MB at world size 4. Below the cap the field matches the
canvas texel-for-texel, so the common small case stays trivial to reason about.

**Aspect is preserved, so nothing downstream skews.** Brush circularity and
cursor mapping are both computed from the field's *own* resolution — the shader
via `textureSize`, the host via `strafe_field.field_size` — never from the
canvas. (That attribute was called `canvas_size`, which named the one thing it
must never be confused with; `ParticleSystem.canvas_size` genuinely *is* the
canvas, so the two sat one typo apart.) `_mouse_field_uv()` deliberately mixes the two: screen→world is the
canvas's transform (that is the space the camera shows), world→uv is the
field's.

### What has to stay in step

- Sized *from* the canvas, so `_rebuild_system()` rebuilds it too. A World Size
  or Canvas Aspect change reallocates both; the field's contents are lost, which
  is consistent with it never surviving a restart either.
- Sampled like the canvas, so its wrap mode follows the boundary condition. Set
  in `_set_project()` — the single place project state changes — because
  anywhere else a load or an undo could leave the two disagreeing.
- Bound to texture unit **1** (the canvas owns 0), passed into `advance()` per
  call rather than held by `ParticleSystem`, which must not reference another
  module.

## Toolbar and the planned side-panel

**Read this before building the side-panel.** The toolbar currently does exactly
one job: it sets `Orchestrator.mouse_mode`, which `_apply_canvas_input` reads to
decide what a click means.

The intended endpoint is that the active tool **also selects which controls are
visible** — physics sliders while selecting, drawing controls while drawing —
all hosted in one docked side-panel rather than in separate floating windows.

Everything is kept in independent window mixins for now *on purpose*. The
expected migration is: keep each `_*_window()` body as a panel-*section*
function, and have the panel call the sections the current tool asks for.
Nothing in the current design should assume a window owns its own
`imgui.begin`/`end` forever — which is why the tool is a plain string in the
status dict and why no window stores a mode of its own. `TOOLS` in
`ui/toolbar.py` mirrors `MouseMode` by value for the same reason: the UI must
not import a simulation module (rule 10), so the strings are the contract.

Adding a tool today means a `MouseMode` member, a `TOOLS` row, a key in the
hotkey zip in `ui/ui.py`, and a branch in `_apply_canvas_input`. Member order in
`MouseMode` is the toolbar's left-to-right order and the `1`/`2`/`3`/`4` key
order, and the enum and `TOOLS` must stay in lockstep -- they are coupled by
string value only, deliberately, so the UI never imports a simulation module.

*On the web the list is shorter than this, and deliberately so.* `MOUSE_MODES`
drives the hotkey table, the toolbar `<select>` and the Tools submenu by
iteration, so the Trails tool needed **one array member** and no edit to any of
them. What is not derived is the per-tool behaviour: a branch in
`applyCanvasInput`, and a row in `TOOL_HELP` (which is keyed by mode, so a
missing entry is a compile error rather than a silently absent tooltip).

**A tool whose effect is continuous rather than an event needs one more thing.**
`_apply_canvas_input` runs once per frame, which is right for a click or a
stroke but wrong for something that must act *while* the simulation advances.
Shove is the worked example: its branch there does nothing but claim the left
button, and the actual work is a value read once per frame and handed to every
`advance()` call. If a new tool influences the physics rather than issuing a
command, expect it to follow that shape -- and to need dividing by
`physics_steps`, for the reasons in the Shove section.

## Deferred / known follow-ups

- Sizing constants (`ENTITIES_PER_WORLD_UNIT`, `BASE_CANVAS_DIM`, and the
  `ENTITY_COUNT`/`CANVAS_DIM` derived from them) are module-level globals in
  `particle_system/sizing.py`. Folding them into config is an optional future
  step; they're sizing constants, not per-preset physics, so they were left out
  of `SimulationConfig`. (`WORLD_SIZE`/`SQRT_WORLD_SIZE` are gone — they were
  dead.)
- `CANVAS_ASPECT` is a module-level constant, now in `sizing.py`. Non-square
  canvases are implemented and verified, but there is no UI to change the aspect
  at runtime — doing so requires reallocating the canvas textures and resetting
  the sim, which wants a deliberate command rather than a slider.
- ~~The Draw tool has **no on-screen reticle**~~ — **done.** The ring is drawn
  in `assembler/shaders/frame_assembly.frag`, with its radius derived from the
  same `aspect_correct_uv` metric the brush shader uses. It measures circular on
  non-square canvases with no fudge factor, which is what the reference could
  never manage. See "The frame assembly pipeline" above.
- Drawing is **not undoable**, by design (the field is live-only). If strokes
  ever need undo, it wants its own bounded stroke-level timeline, not `History`
  — that one is a timeline of `Project` values and would have to become
  something else to hold megabytes of texture.
- `config_index` is treated as **mutable entity state** written by
  `assign_config_index()` at reset. A future "paint particles into config N"
  tool would change it at runtime, so the host must not assume it knows the
  entity->config mapping without a readback.
- ~~**`col_params.y` is written but nothing reads it.**~~ — **in use.** It now
  carries the particle's cohort index, which `cam_brush.frag` reads when Color
  By Cohort is on. The lane is no longer free, so the *other* uses once
  imagined for it need somewhere else to live. They are still wanted, and they
  are all **highlighting** rather than colouring:
  - marking individual particles (the picker's selected entity, which the
    Entity struct has reserved lanes for but no render-side channel yet);
  - indicating which **config** a particle belongs to, so a multi-config buffer
    is legible at a glance;
  - **box-select over a region**, where moving a slider then spawns a new
    config containing only the selected particles — so edits apply to a group
    you drew rather than to the whole population.

  All three need a per-particle "am I highlighted" signal that survives into
  rendering. `Entity.misc` is now full (`x` size, `y` config_index, `zw`
  col_params), so this wants either a widened Entity or a lane reclaimed from
  something else — worth deciding deliberately rather than by whichever
  feature lands first. Note the brain's colour values are arbitrary — an
  unreflected reuse of the black box's force terms, tuned by eye — so nothing
  should infer meaning from their scale.
- PARTICLES mode draws every entity with no culling. Off-screen sprites still
  cost a vertex-shader invocation; at 150k entities that is fine, but a visible
  cost if the entity count grows a lot.
- The pick key encodes the entity index in 24 bits, capping picking at ~16.7M
  entities — about 7x the 2.4M that World Size's maximum of 4.0 produces. This
  was 20 bits (~1.05M), which World Size 2.0 already exceeded: entities past
  the mask failed the encodability guard in `entity_pick.glsl` and silently
  stopped being pickable. Because cohort is `floor(cohorts * index / count)`,
  the unpickable tail is a contiguous block of the highest-numbered cohorts, so
  it presented as "the last ~12% of cohorts ignore clicks" rather than as an
  error. The remaining 8 bits give 256 distance buckets, which is deliberately
  coarse: it only decides which of two near-equidistant particles wins, and
  particles travel in dense clumps where clicking one specific member is not
  something the user can do. Ties break to the lowest index, so the result
  stays deterministic. `tests/test_async_pick.py` parses the `.glsl` and checks
  both constants against `picker.py` and against the largest world the settings
  spec allows.
- The picked entity is reported in the debug panel but not yet drawn
  differently. Highlighting it on the canvas needs a render-side channel (the
  Entity struct has reserved lanes for exactly this).
- **Nothing renumbers entities' `config_index`**, and no code path shrinks the
  ConfigBuffer today, so this cannot currently bite. It is recorded because a
  port that re-exposes slot management inherits the problem: an entity pointing
  past the end is clamped in the shader (so shrinking degrades gracefully rather
  than corrupting), but entities pointing at a removed slot silently inherit
  whatever config took its place. Reassigning them belongs with the feature that
  lets a user paint config assignments.
- `Project.selected` has no visual effect. With no UI to change it, it is always
  0 in practice; highlighting the selected config's entities is the natural
  companion to the picker's highlight work, if slot selection returns.
- `rule_seed` remains a uniform rather than a `ConfigData` lane, because it is
  consumed only by the cohort-mutation path that rule-9's deprecation note
  covers. If cohorts go, it goes with them.
- `coords.screen_to_world()` currently assumes the present pass stretches the
  canvas across the whole window, because that is what `Camera` does today. When
  pan/zoom and letterboxing land, **their inverse belongs inside that function**
  — not in its callers. The reference's six drifting copies of this transform
  are what rule 9 exists to prevent.

Raised by the 2026-07-28 pre-port cleanup, and deliberately left open:

- **`_preview_origin` is one shared slot for two browsing surfaces.** Safe only
  because File > Load and Load Checkpoint are submenus of the same menu bar and
  imgui cannot open two at once, so no second browse can begin before the first
  clears it. If either ever becomes a free-floating window, it must become
  per-surface — the natural home is the `PreviewSession` that already owns each
  surface's snapshot.
- **The trail-persistence clamp floor is now `1e-2`, not `1e-4`.** Raised
  because the canvas is fp16 and the splat premultiply `(1-P)/P` would overflow
  below it. It sits far below the slider (0.5–0.999) and below every observed
  config (min 0.312), so nothing real is cut off — but a config typed with a
  smaller value will now be clamped where it previously would not have been.
- **~25% steady-state trail dimming at the very top of the persistence slider**,
  from fp16 mantissa granularity rather than subnormals — so the value scale
  does not fix it, and only returning to fp32 would. Negligible at the default;
  measured and accepted (PORT_AUDIT §1a).
- **`ndc_to_screen()` has no callers.** Kept deliberately as `screen_to_ndc`'s
  inverse: a conversion table missing one direction invites the next caller to
  write it inline, which is the drift rule 9 exists to prevent.
- **The two untyped string interfaces remain**: the command dict and the status
  dict. `STATUS_KEYS` now enumerates the latter and the UI indexes rather than
  defaulting, so a missing key is loud — but typing them properly is the port's
  job, where they become the TS API. **Done in the port** (`web/`, Step 7):
  `src/orchestrator/commands.ts` has both as a discriminated `Command` union and
  a total `Status` interface, which buys two things this dict cannot have — a
  `never` default arm making an unhandled command a build error, and no optional
  members, so the compiler enforces the every-key-every-frame guarantee that is
  a convention here. This entry still describes the desktop accurately.
- The UI is one debug panel and the input layer. Physics sliders, GUI detail
  tiers, tooltips, the menu bar and the config editor are each their own design
  conversation; the input plumbing they need is already in place.
