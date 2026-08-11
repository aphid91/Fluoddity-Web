# Fluoddity2 — Orientation Memorandum & Phase 1 Spec

**Status:** Part I is orientation and is current — read it. **Part II is
historical**: it is the Phase 1 spec, agreed 2026-07-24 and long since shipped;
it is kept as the record of what was built and why, not as instructions. Part
III's roadmap is likewise largely overtaken — see the note at its head.

For what the code looks like *now*, [ARCHITECTURE.md](ARCHITECTURE.md) is the
authority, and it is kept current.

**Where this branch is going.** The chassis was originally a spec target for a
WebGPU/web port. **That port is finished and lives on another branch.** This
branch takes the Python app in a different direction: turning it into a
*pilotable research instrument*, driven programmatically by an external
controller conducting a CLIP-guided search over mutation space. See
[API.md](API.md) for what exists and [CLIP_INTEGRATION.md](CLIP_INTEGRATION.md)
for where it is heading.

Several design rules were originally justified by the port. They survive on
their own merits — unambiguous struct layout and a single coordinate
implementation are worth having regardless of who reads the buffer — and
ARCHITECTURE.md now states the reasons that still apply. Nothing in the code
changed when the premise did.

---

# Part I — Orientation

## Context: what this project is and why it exists

Fluoddity2 is a from-scratch rebuild of Fluoddity, a GPU particle simulation
where entities steer by sensing a velocity flow-field they themselves deposit.
The original ("the Reference") works but has accreted: ~11,500 lines of Python,
a `Camera.render()` taking ~22 positional parameters, six duplicated copies of
the same letterbox aspect-ratio block, and a physics-parameter system whose
sweep machinery is welded into every individual parameter.

Fluoddity2 exists to build a **tight chassis**: the core systems wired up
correctly and simply, deliberately *not* populated with bells and whistles.

*(Originally, the chassis was a spec target for a WebGPU/web port, and that fact
drove several of the design rules below. The port has since been completed on
another branch. The rules stayed — see the status note at the top of this file
— but where a rule's stated reason was "because WebGPU", ARCHITECTURE.md now
gives the reason that still holds.)*

**Ethos:** "as simple as possible, but no simpler." When in doubt, build less.

## The Reference folder — access policy

`Reference/` contains the previous implementation. **Do not read it without
explicit permission from the user.**

This is not about secrecy. It is vast and hairy, and reading it pollutes an
agent's context with details we are deliberately smoothing out and structures we
are deliberately redesigning. An agent who has read the reference's aspect-ratio
handling will produce a worse design than one who has not.

**When it is OK:** the user will sometimes direct you at a specific module —
"see how the reference handles entity selection with the EntityPicker." Then
explore *that* narrowly. Prefer dispatching an Explore subagent with a tight
question and asking for a structural summary rather than code, so the bulk of it
never enters the main context.

**Known-good facts already extracted** (so nobody needs to re-read for these):

- Rule buffer: one 320-byte `Rule` per entity, `reserve`-only, indexed flat by
  `gl_GlobalInvocationID.x`. In normal mode it is *never read* by
  `entity_update` — rules derive from a uniform `target_rule` plus a seeded
  per-cohort mutation. This is what Fluoddity2 does today.
- Physics params reach the shader as *uniforms*, one `PhysicsSetting` struct per
  parameter carrying `{value, min, max, x_sweep, y_sweep, cohort_sweep, jitter}`.
  Sweeps are evaluated per-entity in-shader. This struct is copy-pasted into
  `canvas.frag` with a "SYNCHRONIZED" comment — i.e. manual sync did not work.
- Reference Entity: `vec2 pos; vec2 vel; float hue; float size; float pad[2];`
  = 32 bytes. Init/reset is entirely GPU-side, signalled by `frame_count == 0`.
- Reference world space: `[-√ca, √ca] × [-1/√ca, 1/√ca]`, area-preserving. This
  core idea is sound and we adopt it; its *implementation* is duplicated across
  ≥6 sites with at least one conflicting convention.
- Entity picker: CPU-side full SSBO readback (~19 MB) per click, brute-force
  argmin, distance measured in texture-uv space so it is anisotropic. Do not
  copy this.
- UI: `imgui-bundle` with docking, using its own Python GLFW backend
  (`imgui_bundle.python_backends.glfw_backend.GlfwRenderer`). imgui runs after
  all GL draws, before `swap_buffers`.

## Current state (as of this memo)

The whole non-Reference codebase is ~600 lines. Modules: `app_window/`,
`camera/`, `particle_system/`, `input/`, `orchestrator/`, `shared/`, `configs/`.
`docs/ARCHITECTURE.md` describes the module/mediator structure and remains
accurate — read it. This memo supersedes it only where explicitly noted.

Today `SimulationConfig` pushes ~14 scalars as a `ConfigData` uniform and 80
floats as a `config_rule` uniform, separately, to three different programs.

## Design rules (in force; additions to ARCHITECTURE.md)

1. **The Orchestrator is the sole broker.** Modules never reference each other.
   (Existing rule, still load-bearing.)

2. **Hot-reload is sacred.** This is a teaching tool where users edit shaders
   live. Shader setup stays in isolated `reload()` helpers; failed compiles log
   and keep the last working program; all uniforms go through `tryset()`.
   *Corollary that decided a design choice below: shaders must remain
   hand-authorable. We do not machine-generate GLSL that users are expected to
   edit.*

3. **vec4-only GPU structs.** Every struct crossing the host/GPU boundary is
   built exclusively from 16-byte-aligned members. Scalars ride in vec4 lanes;
   ints ride in float lanes via `intBitsToFloat`/`floatBitsToInt`. See §II.1 for
   the rationale — this is the single most important rule for the WebGPU port.

4. **One canonical coordinate convention, one implementation.** World space is
   area-preserving (§II.3). Every world↔uv↔ndc↔screen conversion lives in
   exactly one GLSL function and one Python function. **No other file is
   permitted to write `aspect` math.** This rule exists specifically to prevent
   the reference's six-copy divergence.

5. **The UI owns no simulation truth.** All config state lives in the
   ConfigBuffer and its host mirror; the UI reads it and issues commands. The
   reference's `ui_state`/`sim_state`/`preferences_state` triad is the
   anti-pattern — where UI state and sim state diverge, the WebGPU port stops
   being a translation and becomes a rewrite.

6. **Struct changes must be cheap.** `ConfigData` and `Entity` *will* gain and
   lose fields continuously as features land. Adding a field must never require
   hand-auditing padding across three shaders and a numpy dtype.

## WebGPU port constraints (why several rules above exist)

- **std430 and WGSL disagree on mixed-scalar struct layout.** WGSL requires
  explicit alignment and does not replicate std430's array-stride rounding
  identically. A struct of `int` + 13 `float` is a landmine. An all-vec4 struct
  is unambiguous in both. This is why rule 3 exists.
- **Compute shaders exist in WebGPU** (WGSL compute + storage buffers), so the
  SSBO-driven architecture ports directly. Good.
- **No `#include` in either GLSL or WGSL** — both need a host-side resolution
  step. Building ours now means the port inherits the mechanism.
- **Readbacks are async in WebGPU.** Any design that does a synchronous
  GPU→CPU read in the middle of a frame (like the reference's entity picker)
  will not translate. Prefer GPU-side reduction into a small result buffer.
- **imgui-bundle is the least portable module.** That is accepted. It is
  contained by rule 5.

---

# Part II — Phase 1: the ConfigBuffer refactor (committed spec)

**Goal:** unify Rule + physics parameters into one per-entity-selectable
`ConfigData`, split out a `WorldData` uniform, and establish the shared-struct
and coordinate machinery everything later depends on.

**Phase 1 is headless.** No UI. Verified by console output and buffer readback.
This deliberately keeps the risky layout work separate from the risky imgui work.

## 1. The vec4-only layout rule

`Entity` today is `vec2 pos; vec2 vel; float size; float padding;` = 24 bytes,
duplicated in `entity_update.glsl` and `brush.vert`. Adding `int config_index`
makes it 28 and mixes int/float/vec2 — precisely the WGSL-divergent shape.

**Entity becomes:**

```glsl
struct Entity {
    vec4 pos_vel;   // xy = pos, zw = vel
    vec4 misc;      // x = size, y = config_index (int bits), zw = reserved (color/hue)
};  // 32 bytes, 16-byte aligned
```

Accessors in `common.glsl` keep call sites readable and give us one place to
change if lanes are reshuffled:

```glsl
vec2 e_pos(Entity e);   int  e_config_index(Entity e);
vec2 e_vel(Entity e);   float e_size(Entity e);
```

**ConfigData becomes** (a `Rule` is 320 B of pure vec4, so it is already
conformant):

```glsl
struct ConfigData {
    Rule rule;      // 320 B
    vec4 sensor;    // gain, angle, distance, mutation_scale
    vec4 force;     // global_force_mult, drag, strafe_power, axial_force
    vec4 misc;      // lateral_force, hazard_rate, cohorts(int bits), reserved
};  // 368 B
```

Named accessors (`cfg_sensor_gain(c)` etc.) so shader code does not read as
lane arithmetic. **Adding a field = claiming a reserved lane**, not re-auditing
padding.

Note this *replaces* sweeps rather than dropping a feature: "different entities
get different parameters" is exactly what `config_index` provides, without
bolting six extra floats onto every parameter.

## 2. common.glsl and the include mechanism

GLSL has no `#include` and moderngl has no preprocessor. Build one first — if
you write `common.glsl` before the resolver exists, you get the reference's
copy-paste-and-hope-it-stays-synchronized failure.

- Extend `read_shader()` in `shared/gl_utils.py` to resolve a
  `#include "common.glsl"` directive by text substitution, resolved relative to
  `shared/shaders/`. Guard against double-inclusion and recurse for nesting.
- `shared/shaders/common.glsl` holds `Rule`, `FourierCenter`, `Entity`,
  `ConfigData`, `WorldData`, the accessors, and the coordinate functions (§3).
- It must carry no `#version` line (the includer owns that) and declare no
  uniforms or buffer bindings — types and pure functions only.

**`common.glsl` is the single source of truth for layout, and the host parses
it.** A strict parser in `particle_system/` reads the struct declarations and
emits the numpy dtype used to pack the buffers.

Rationale for parsing rather than generating (this went against the initial
recommendation, deliberately): rule 2 says users hand-edit shaders live, so
`common.glsl` must stay hand-authorable — machine-emitted GLSL would break the
tinkering loop the project exists for. The parser-fragility risk is contained
because rule 3 restricts the input to a tiny vec4-only subset.

**The parser must be strict and loud.** Accept only `vec4`, nested named
structs, and fixed-size arrays of those. On *anything* it does not recognize —
a bare `float`, an `int`, an unknown type — raise immediately with the offending
line. A parser that guesses produces silent memory corruption: a wrong offset
does not error, it just makes the simulation behave subtly oddly, which is
brutal to debug. Failing loudly at startup is the whole point.

## 3. WorldData and the coordinate convention

```glsl
struct WorldData {
    vec4 trail;   // persistence, diffusion, sqrt_world_size, config_count
};
```

Uniform only, never per-entity. `trail_persistence` and `trail_diffusion` move
out of `ConfigData` (they are properties of the shared canvas, not of a
particle). `sqrt_world_size` comes from the host `SQRT_WORLD_SIZE` global,
fixing a real latent bug: it is currently `#define SQRT_WORLD_SIZE .5` in
`entity_update.glsl:39` *and* `SQRT_WORLD_SIZE = 0.5` in
`particle_system.py:11` — two sources of truth that silently disagree if either
moves. `config_count` is needed so the in-shader `reset()` can assign
`config_index` safely.

**Canonical world space is area-preserving:**

```
ca = canvas_res.x / canvas_res.y
world = [-√ca, +√ca] × [-1/√ca, +1/√ca]      (area always 4)
```

`common.glsl` provides `world_to_uv`, `uv_to_world`, `world_to_ndc`, and the
wrap function; `particle_system/` provides the Python mirror. Rule 4: nothing
else writes aspect math. This retires the ad-hoc `canvas_resolution.x/y`
multiply in `brush.vert:43` and the `aspect` fudge in `get_can()`
(`entity_update.glsl:153-158`).

**Phase 1 is provably behavior-conserving.** The canvas is square today
(`CANVAS_DIM × CANVAS_DIM`), so `ca = 1`, `√ca = 1`, and the new convention
reduces exactly to the current one — `world_to_uv(p) = p*0.5 + 0.5`, and the
existing `fract` wrap over `[-1,1]` is unchanged. The three existing presets
must look identical after Phase 1; any visible change is a bug. Non-square
behavior is not exercised until the aspect-ratio feature lands (§III).

## 4. The Config Buffer

- New SSBO, `config_count` slots of `ConfigData`, **allocated at size 1 for
  Phase 1** and written from `SimulationConfig`. Sized as a variable from the
  start; resizable up to the entity count.
- Bind to a fixed binding index (entity buffer holds 0; use 1). Record binding
  assignments in `common.glsl` comments.
- Every entity gains `config_index`; `reset()` sets it to `0` in Phase 1.
- `entity_update.glsl` reads `config_buffer[e_config_index(e)]` for **both** its
  Rule and its physics parameters — replacing the `config_rule` and `config`
  uniforms entirely.
- `brush.frag` / `canvas.frag` currently read `config.trail_persistence` and
  `config.trail_diffusion`; they switch to the `WorldData` uniform. This removes
  their `ConfigData` struct duplication — a direct win from `common.glsl`.
- `SimulationConfig` keeps loading the same preset JSON (no format change in
  Phase 1) but packs into the buffer via the parsed dtype instead of ~16
  `tryset` calls.

## 5. Cohorts: keep, but marked for deprecation

`cohorts` + `rule_seed` + `mutation_scale` exist solely to give different
entities different rules — the job `config_index` now does generally.

**Keep them in Phase 1** so the existing presets stay behavior-identical. But
they are formally a **deprecation candidate**: seeded in-shader mutation is
harder to save/load, harder to show in a UI, and does not generalize to physics
parameters. Migration path when the time comes: *N cohorts → N config slots
pre-populated with the mutated rules, computed host-side.*

Recorded here so no future agent deepens the redundancy by wiring cohorts
further into the ConfigBuffer.

## 6. Files touched in Phase 1

| File | Change |
|---|---|
| `shared/shaders/common.glsl` | **new** — all shared structs, accessors, coordinate fns |
| `shared/gl_utils.py` | `#include` resolution in `read_shader()` |
| `particle_system/layout.py` | **new** — strict `common.glsl` parser → numpy dtype |
| `particle_system/config.py` | pack `ConfigData` into the buffer; expose `WorldData` |
| `particle_system/particle_system.py` | allocate/upload config buffer; `SQRT_WORLD_SIZE`→`WorldData`; 32-byte entities |
| `particle_system/shaders/entity_update.glsl` | include common; read config from buffer; new coord fns; write `config_index` in `reset()` |
| `particle_system/shaders/brush.vert` | include common; drop the local `Entity` copy and the aspect fudge |
| `particle_system/shaders/brush.frag`, `canvas.frag` | include common; drop `ConfigData` copy; read `WorldData` |
| `docs/ARCHITECTURE.md` | fold in rules 3–6 |

## 7. Verification

1. **Visual regression is the primary test.** Run each of the three presets
   (`Starcrossed`, `9LeafClovers`, `Angles`) before and after. Square canvas ⇒
   output must be indistinguishable. Any visible change is a layout or
   coordinate bug, not an improvement.
2. **Parser round-trip:** assert the parsed dtype's `itemsize` matches the
   hand-computed std430 size (Entity 32, ConfigData 368) and that field offsets
   land on 16-byte boundaries.
3. **Parser strictness:** feed it a struct containing a bare `float` and confirm
   it raises with the offending line rather than silently accepting.
4. **Buffer round-trip:** upload a `SimulationConfig`, read the buffer back,
   assert the floats match the source JSON.
5. **Hot-reload still works:** with the app running, edit `common.glsl`, press
   R, confirm all dependent programs recompile and a deliberate syntax error
   logs without crashing.
6. **`config_count` > 1 smoke test:** allocate 2 slots with differing configs,
   assign `config_index` by index parity in `reset()`, confirm two visibly
   distinct particle populations. Then revert to 1 slot. This proves the
   infrastructure before any UI depends on it.

---

# Part III — Roadmap

> **Mostly overtaken.** Nearly everything below has shipped: the UI module, the
> camera, aspect ratio, the entity picker, save/load, drawing tools, GUI detail
> tiers, tooltips, the config clipboard and multi-config editor, and the extra
> ConfigData/WorldData settings. It is kept as the record of what was planned
> and in what order, not as a to-do list. ARCHITECTURE.md describes what
> actually got built; its "Deferred / known follow-ups" section is the live list.
>
> The one item still genuinely open is **alive/dead particles**, at the bottom.
> The current direction of this branch is the piloting API and CLIP-guided
> search — see [API.md](API.md) and [CLIP_INTEGRATION.md](CLIP_INTEGRATION.md).

Each item needed a dedicated agent and a design conversation with the user
first; they were **underspecified on purpose**. Listed roughly in dependency
order.

**Phase 2 — UI module.** ✅ DONE. Replace/absorb `input/` with a `ui/` module between
Input and Orchestrator. `imgui-bundle` with docking; interface rebuilt from
scratch. Must handle: mouse click/drag/position+previous/scroll, key
press+release, currently-held keys and buttons. Critically it must distinguish
clicks imgui captures (`io.want_capture_mouse`) from clicks that pass through to
the canvas. Rule 5 applies: UI owns no simulation truth.

**Camera.** ✅ DONE. Pan/zoom controls; a Mode toggle including an
instanced-render particle cam like the original. Note today's `camera/` is
really a present/display pass, not a viewpoint — expect a rename or a split.
*(It became a real viewpoint: `CameraState` plus the motion-blur supersampler.)*

**Aspect ratio support.** ✅ DONE. The convention is fixed (§II.3); this is about
making non-square canvases actually work end to end, and it is where §II.3
finally gets exercised. The reference is ground truth for *behavior*, never for
structure.

**Entity picker.** ✅ DONE. Nearest entity to mouse, accounting for camera and
aspect. Prefer GPU-side reduction into a small result buffer over the
reference's 19 MB-per-click readback, and keep the readback off the frame it was
dispatched on. *(Built as a two-phase request/retrieve; `pick_blocking` survives
for tests only. See ARCHITECTURE.md "Entity picking".)*

**Save/Load + menu bar.** ✅ DONE. Format v8 (writes only live fields), legacy
v7 reader, `Core`/subfolder categories with user saves in `configs/custom/`,
delete with confirmation, and the hover-preview load menu. See ARCHITECTURE.md
"Saving & loading" for the preview state machine.

*Scope change from this memo:* the "save current simulation state" checkbox was
**cut and relocated** to OUT FOR NOW (below). Saving the entity buffer is
multiple megabytes of binary and a clean retrofit later — nothing in the v8
format precludes adding it. The save dialog therefore offers filename +
"Config 0 vs entire ConfigBuffer" only.

**Trail drawing and field drawing.** ✅ DONE. Shipped as the Draw and Shove
tools over the Strafe Field; see ARCHITECTURE.md "The Strafe Field, and
drawing".

**GUI detail levels.** ✅ DONE. Basic/Advanced tiers driven by the
`ui/settings_spec.py` registry; the animated sensor diagram is the tooltip
system.

**Help text and control tooltips.** ✅ DONE. Help text lives on each registry
entry.

**Config clipboard + multi-config editor.** ✅ DONE, in two parts: in-session
checkpoints (`clipboard_commands.py`) and the config manager window. The
entity-highlighting-on-hover half was not built.

**Extra ConfigData/WorldData settings.** ✅ DONE. Boundary conditions, initial
conditions, cohort fences, hazard rate, gravity and the rest.

**Stretch: alive/dead particles.** Track liveness so the mouse can erase or
place particles. Until then, Fluoddity's "every particle always alive" model
holds, with grid/ring/random initialization.

## Explicitly OUT — not carried over in any recognizable form

Parameter sweeps (subsumed by `config_index`), jitter, slider ranges, multiload,
watercolor mode.

## Explicitly OUT FOR NOW

Only revisited if the chassis translation completes and we still want to grow
the Python version: parameter locks, video recording service, plotting service,
generics, shader-driven field, lottery system.

**Saving simulation state** (the entity buffer / canvas trails) joined this list
during the save/load work. It is megabytes of binary per save, awkward in the
browser, and unnecessary for the chassis — the v8 format can gain a `sim_state`
key later without breaking existing files.
