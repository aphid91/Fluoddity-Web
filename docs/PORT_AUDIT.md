# Pre-Port Audit — Structure & WebGPU Portability

**Date:** 2026-07-28 · **Branch:** `reorg-modular-structure` (50 commits ahead of `master`)

This document records two deep audits run before treating this codebase as the
ground-truth spec for the WebGPU port. Part I audits the code against
`docs/ARCHITECTURE.md` (structure, drift, dead code, coupling). Part II catalogs
everything that will be hard, inconvenient, or impossible to reproduce in
WebGPU/WGSL/browser. The actionable items derived from both live in
`docs/CLEANUP_PLAN.md` — read that for *what to do*; read this for *what is true*.

**Verdict up front:** the codebase was clearly written with the port in mind and it
shows. There are only two hard GPU blockers, both small and localized (`rg32float`
filter/blend, and `pick_blocking`'s `ctx.finish()` on the live click path). The single
biggest port cost is not GPU at all — it is the imgui layer, which must be rewritten,
not ported. The one genuine GPU landmine the design docs do *not* call out is
**rg32float blending**, which the canvas ping-pong depends on and which base WebGPU
cannot do.

---

# Part I — Structural audit

## 1. File sizes (line counts)

**Python — 8,127 lines total across 45 files.**

| Module | Files | Lines | Largest file |
|---|---|---|---|
| `ui/` | 12 | 2,732 | `settings_window.py` **681** |
| `orchestrator/` | 8 | 1,519 | `orchestrator.py` **599** |
| `particle_system/` | 8 | 1,594 | `particle_system.py` **449** |
| `camera/` | 3 | 449 | `camera.py` 315 |
| `assembler/` | 3 | 343 | `bloom.py` 189 |
| `project/` | 3 | 382 | `history.py` 201 |
| `strafe_field/` | 2 | 218 | `strafe_field.py` 215 |
| `preferences/` | 2 | 134 | `preferences.py` 131 |
| `shared/` | 2 | 121 | `gl_utils.py` 120 |
| `app_window/` | 2 | 72 | `app_window.py` 71 |
| `main.py` | 1 | 4 | — |

Top 6 files: `ui/settings_window.py` 681 · `orchestrator/orchestrator.py` 599 ·
`ui/ui.py` 496 · `ui/config_menu.py` 474 · `particle_system/particle_system.py` 449 ·
`ui/settings_spec.py` 446.

**GLSL — 1,840 lines / 16 files.** `entity_update.glsl` **574**, `common.glsl` 378,
`frame_assembly.frag` 161. Everything else ≤ 109.

Nothing is bloated by absolute size. The two files worth watching are
`settings_window.py` (681, doing four distinct jobs — see §8) and
`entity_update.glsl` (574, the only large shader).

## 2. Doc/code drift

### CONFIRMED — "modules never reference each other" is false in three places

The doc (`orchestrator/orchestrator.py:3-5`, ARCHITECTURE "Modules") states modules hold
no references to one another. Three real cross-module imports exist outside
`orchestrator/` and outside `shared/`:

1. **`camera/camera_state.py:21`** — `from particle_system import coords`
2. **`strafe_field/strafe_field.py:32`** — `from particle_system.particle_system import canvas_dimensions`
3. **`project/project.py:43`** — `from particle_system.config import SimulationConfig, WorldSettings`

Each is individually defensible, and the code says so in place — `strafe_field.py:66-68`
explicitly argues "two copies of it would be one too many". But the doc's blanket claim
is inaccurate, and #2 is the worst of the three: `strafe_field` imports from the
*implementation* module `particle_system.particle_system`, not a leaf utility, so it
drags `layout.py` → `common.glsl` parsing into `strafe_field`'s import graph.

The structural fact underneath: **`particle_system` is not a peer module, it is a
de-facto shared library.** `coords`, `config`, and `canvas_dimensions` are all
leaf-level pure code that three other modules need.

### CONFIRMED — coordinate chain does *not* live only in `coords.py` + `common.glsl` (rule 9)

`aspect_correct_uv()` is written out **verbatim, twice**, in shaders:

- `strafe_field/shaders/strafe_draw.frag:29-32`
- `assembler/shaders/frame_assembly.frag:74-77`

```glsl
vec2 aspect_correct_uv(vec2 d) {
    float ca = canvas_resolution.x / canvas_resolution.y;
    return d * vec2(sqrt(ca), 1.0 / sqrt(ca));
}
```

Character-for-character the same function, and exactly the "six divergent copies"
failure mode rule 9 exists to prevent. `frame_assembly.frag:70-73` even comments *"This
is the SAME correction strafe_draw.frag applies"* — the drift risk is known and
documented, but not fixed. `frame_assembly.frag` already includes `common.glsl`, so it
has no excuse; `strafe_draw.frag` does not include it at all. Mathematically,
`aspect_correct_uv` is `world_half_extent(ca)` applied as a scale — it belongs in
`common.glsl` next to `world_half_extent`.

### CONFIRMED — `common.glsl:229` is stale

```
// .y is written but not yet consumed -- see the deferred notes in ARCHITECTURE.
```

`.y` **is** consumed, at `camera/shaders/cam_brush.frag:63`
(`col_params.y * COHORT_COLOR_CONSTANT`). The Color-By-Cohort feature landed and this
comment was not updated.

### CONFIRMED — `orchestrator.py:18` states its own stale metrics

The docstring says "24 handlers in 574 lines"; the file is now 599 lines with 29
handlers. A snapshot presented as fact, already drifted.

### FINE AS IS — "UI owns all GLFW callbacks"

Verified true. `ui/ui.py:76-80` registers key/char/cursor/mouse/scroll. The only other
GLFW callback anywhere is `app_window.py:38` `set_framebuffer_size_callback`, which is
window geometry, not input — and `app_window.py:9-12` documents that split. Clean.

### FINE AS IS — `settings_spec.py` as single registry (with two declared exceptions)

Controls drawn outside the registry, both deliberately documented:
`ui/drawing_window.py` (5 widgets, rationale at lines 3-8) and
`ui/preferences_window.py:56-79` (the tier radio and the diagram checkbox, rationale at
lines 54-55 and 65-67). The `_debug_panel` in `ui.py:285-372` also draws raw widgets,
but it is diagnostic, not settings.

## 3. Coupling violations

### CONFIRMED — `ui/config_manager.py:37` sets state it never reads

`self._manager_message = ""` is written once at init and never read again; the window
reads the Orchestrator's copy via `self._status.get('manager_message', '')`
(`config_manager.py:97`). Dead state that looks like state ownership — a rule-10 smell
in the file most in need of not having one.

### SMELL — `_save_error` genuinely lives in two places

`ui/config_menu.py:50,420,438,453,462,467` maintains a UI-local `_save_error`, *and*
the Orchestrator has its own (`orchestrator.py:194`, `project_commands.py:96-113`,
pushed via status at `orchestrator.py:535`). The handshake at `config_menu.py:467`
reads the Orchestrator's value *synchronously right after dispatch* — which works only
because `_dispatch` is a direct call. That is a real coupling to call-stack synchrony
that will not survive an async command bus (which the port will have). The UI-local
copy also holds messages the Orchestrator never sees ("Enter a filename." at line 462),
so the two are not mirrors — they are two overlapping error channels.

### FINE AS IS — no persistent cross-module texture references

Verified. Every texture crossing a boundary is pulled per-frame through a narrow
accessor: `particle_system.current_canvas_texture()` (pulled *per sample* inside the
blur loop, `orchestrator.py:311`, with a correct comment on why hoisting would go
stale); `strafe_field.current_texture()` (correctly hoisted out of the sub-step loop,
`orchestrator.py:264-266`); `camera.result()` → `assembler.present()` by value.
`Camera` and `Assembler` hold no sim state. Intact.

### SMELL — `tooltip_graphic` is a UI concern living in the Orchestrator

`orchestrator.py:131` constructs `TooltipGraphic(ctx)` and hands it to the UI at line
239. The reasoning is sound and documented (UI owns no GPU resources) — but the *file*
lives at `ui/tooltip_graphic.py`, so `ui/` contains a moderngl-importing module the UI
package must not use, and `orchestrator.py:54` reaches past the `ui` package `__init__`
into a submodule.

### FINE AS IS — orchestrator does not leak internals to UI

`_report_status()` (`orchestrator.py:508-550`) pushes only plain values, strings, dicts
and immutable snapshots. `ui.py:374-381` `_describe_pick` duck-types specifically to
avoid importing `PickResult`. One exception: `checkpoints=self.checkpoints`
(`orchestrator.py:540`) passes the live mutable list — benign because `Checkpoint` is
frozen, but the UI holds a reference to a list the Orchestrator mutates in place.

## 4. Dead code / vestigial machinery

### CONFIRMED — `coords.py` is ~55% unused

Of 15 public functions + 2 constants, only 4 are called from outside:
`screen_to_world` (10 sites), `world_half_extent` (`camera_state.py:110`),
`world_to_uv` (`drawing_commands.py:53`), `uv_radius_to_world`
(`shove_commands.py:102`). Six others are internal composition steps of
`screen_to_world` and are load-bearing. But **`world_wrap`, `world_to_screen`, and
`visible_world_bounds` are fully dead** — no callers, internal or external.
`visible_world_bounds` has no GLSL counterpart at all, so it is not even mirroring.

### CONFIRMED — other unused symbols

- **`particle_system/particle_system.py:12-15`** — `WORLD_SIZE`, `SQRT_WORLD_SIZE`,
  `ENTITY_COUNT`, `CANVAS_DIM` are a vestigial constant chain. `sizing_for()`
  (lines 36-43) supersedes them and **hardcodes the same literals independently**:
  `600000` and `1024` are each written twice. Duplicated magic numbers, not just dead
  code.
- **`project/project.py:81` `world_for_upload`** — defined, never called
  (`ParticleSystem.current_world_config()` does the job from the other side).
- **`ui/input_state.py:85-89`** — `key_held()` / `key_pressed()` helpers, zero callers.
- **`ui/hover_preview.py:48-54`** — `is_open` / `previewing` properties, zero callers.
- **`project/history.py:199-201` `clear()`** — zero callers.
- **`shared/__init__.py:1`** — the `MUTED_TRYSET_WARNINGS` re-export is unused; every
  consumer imports from `shared.gl_utils` directly.
- **`particle_system/persistence.py:35`** — `replace` imported, never used.

### CONFIRMED — `ParticleSystem.reset()` docstring hides the mechanism

`reset()` sets one integer (`frame_count = 0`) — and that *is* the reset, because
`frame_count == 0` is the GPU-side reset sentinel (`entity_update.glsl:384-385`,
`canvas.frag:39`, `brush.frag:24`). Clever design, but the one-line docstring gives no
hint, and `_cmd_reset` reads as if it does far more.

### FINE AS IS — LEGACY v7 block

Well-contained, exactly as its header promises (`persistence.py:213-242`). Call-site
count: **2**, both marked (`persistence.py:262`, `persistence.py:189-190`). Deleting it
is genuinely the documented three-step operation. Caveat: `persistence.py:128` has a
*second*, unrelated "LEGACY" comment (a v8-internal `rule_seed`→`mutation_seed` rename)
which is **not** part of the v7 block — do not confuse the two markers.

### FINE AS IS — no `implemented=False` entries; no TODO/FIXME/HACK/XXX

All 30 `Setting(...)` entries in `settings_spec.py` are implemented; the
`implemented` field and its greyed-render path are ~8 lines of intentional scaffolding
(`settings_spec.py:50-52`). Zero TODO-family comments anywhere. Genuinely clean.

### SMELL — `print()` as the only diagnostic channel

~25 `print()` calls across the GPU modules. Shader reload success messages fire on
every `U` press. `gl_utils.py:104-120` `MUTED_TRYSET_WARNINGS` is a hand-rolled
log-rate-limiter that exists purely because there is no logging framework. Fine for a
live-coding tool; a deliberate decision, recorded here.

## 5. Duplication

- **`aspect_correct_uv` ×2** — see §2. The single most important duplication finding.
- **Sizing magic numbers ×2** — `600000`/`1024` in `particle_system.py:14-15` and
  `:42-43`. See §4.
- **Pick-at-pixel logic ×2, and half of it is dead.** `orchestrator.py:485-506`
  `_update_pick` and `selection_commands.py:76-91` `_pick_at` are the same six lines
  (build screen→world target + pixel radius), differing only in `pick()` vs
  `pick_blocking()`. **`_update_pick` has zero callers** — `orchestrator.py:254-262` is
  a comment saying "call `_update_pick()` from those paths", but nothing does, so
  `self.hovered` is permanently `MISS` and the debug panel's `hovered` readout always
  shows `-`.
- **The `_reload_*` methods are the same shape eight times.** `camera.py:108-151` (×3),
  `assembler.py:58-78`, `strafe_field.py:104-132`, `bloom.py:66-97` (×2),
  `particle_system.py:240-259`: try / compile / keep-old-on-failure / print. ~70 lines
  of near-identical code; `shared/gl_utils.py` is the sanctioned home for a helper.
- **`_load_entry` and `_checkpoint_entry` are the same widget.**
  `config_menu.py:229-279` vs `:346-377`; the second's docstring even says "Same layout
  discipline as `_load_entry`". They diverge only in delete semantics.
- **`_cmd_snapshot_configs` / `_cmd_clipboard_snapshot` are byte-identical.**
  `project_commands.py:165-175` vs `clipboard_commands.py:79-87`. Both write the
  **same** `self._preview_origin` slot, so the "two surfaces cannot clobber each other"
  guarantee that motivated the split does **not** hold at the Orchestrator level — it
  holds only because both surfaces are submenus that cannot be open simultaneously.

## 6. Inconsistencies

### CONFIRMED BUG — `TooltipGraphic.reload()` can crash the app; every other `reload()` cannot

Seven `reload()` methods. Six wrap compilation in try/except and keep the old program
on failure. `ui/tooltip_graphic.py:81-87` does not: its docstring claims "a typo
mid-edit costs the tooltip's appearance rather than the session", but
`_build_program()` raises through `reload()` into `_cmd_reload`
(`orchestrator.py:576-584`), which has no guard — verified this session. **A typo in
`tooltip_graphic.frag` plus pressing `U` terminates the app.** The docstring documents
behaviour the code does not have. The one outright bug found by this audit.

### CONFIRMED — shader-loading is inconsistent across modules

Three distinct patterns for the same job: per-shader `_reload_x()` methods
(`camera.py`, `particle_system.py`, `bloom.py`); single inline `reload()`
(`assembler.py`, `strafe_field.py`, `picker.py`); `_build_program()` + thin `reload()`
(`tooltip_graphic.py`, the only one without error handling). Also:
`strafe_field.py:128` sets a constant uniform *inside* `reload()`, while
`particle_system.py:142` uses a separate `_set_constant_uniforms()` — same problem, two
solutions.

### CONFIRMED — wrong tool numbers in help text

`ui/drawing_window.py:82,87` say "Shove tool [3]" and "Draw tool [4]"; Shove is **[2]**
and Draw is **[3]** (`toolbar.py:28-32`). Leftover from when Pan was tool 1.
User-visible wrong help text. (Related, harmless: `ui.py:456-457` zips four keys
against a 3-element `TOOLS` — deliberate headroom, `KEY_4` is inert.)

### CONFIRMED — `ui.py:55` docstring lists 4 commands; 29 are wired

The command dict at `orchestrator.py:196-235` has 29 entries.

### SMELL — `tryset` hides typos after 9 warnings

Every module uses `shared.gl_utils.tryset` uniformly (good), but it silently swallows a
missing uniform after printing at most 9 warnings. A renamed uniform produces brief
console noise, then silence, while the value never reaches the GPU. "Which uniforms are
actually live" is not statically answerable.

### SMELL — `canvas_size` means two different things

`StrafeField.canvas_size` (`strafe_field.py:82`) is the **field's** resolution, not the
canvas's — they differ once `MAX_FIELD_DIM` bites. The code knows (lines 78-81) and the
one call site is correct, but the attribute is named for the thing it is *not*, while
`ParticleSystem.canvas_size` genuinely is the canvas.

### SMELL — three access conventions on ParticleSystem

`entity_count()` is a method; `frame_count` and `canvas_size` are read as bare
attributes; `entity_buffer` is handed out raw (`orchestrator.py:312,314,549`).

### SMELL — `config_path` is written from outside

`project_commands.py:59,116,134,210` assign `self.system.config_path = ...` directly —
the only place the Orchestrator mutates another module's state by assignment rather
than through a method.

## 7. Orchestrator health

**Size:** `orchestrator.py` 599 lines + 7 mixins 920 lines = 1,519 lines across 8
files. The mixins genuinely own no state. **Direct state fields on `Orchestrator`: 26**
(7 owned modules + 19 state fields). **Command handlers: 29.**

Assessment — **the wiring is at the threshold the ARCHITECTURE doc named**, and the
pressure is not size but the **two untyped string-keyed interfaces**:

- The 29-entry command dict (`orchestrator.py:196-235`) is hand-maintained; an unknown
  name silently no-ops (`ui.py:484-487`, by design), so a typo'd command is a silent
  dead button.
- `_report_status()` pushes **27 keyword arguments** per frame — the widest interface
  in the codebase, read back via ~60 string-keyed `self._status.get(...)` sites, each
  with a hand-written default. A renamed key is silently `None`.
- The mixins are not independent: `ShoveCommands` imports `MouseMode` from
  `SelectionCommands`; `ConfigManagerCommands`/`ClipboardCommands` call
  `_record_history` from `SelectionCommands`; `SettingsCommands` calls
  `_rebuild_system` from `ProjectCommands`; `ProjectCommands` calls `_end_stroke` from
  `DrawingCommands`. They are seven views of one class, and the MRO
  (`orchestrator.py:106-108`) is load-bearing and undocumented.

These two string interfaces are also what will hurt most in a TypeScript port — they
are, in effect, the API the port must type.

## 8. The `ui/` layer

**Composition:** `UI` inherits 6 window mixins (`ui.py:48-49`); each provides
`_init_x()` and `_x_window()`. Consistent and legible.

### CONFIRMED — `show_advanced` is owned by one mixin, written by another

`settings_window.py:72` declares it; `preferences_window.py:58-62` writes it; both
read it. Works only because mixins share one flat attribute namespace — the
initialization order at `ui.py:115-116` is silently required, and nothing structural
prevents two windows colliding on an attribute name.

### FINE AS IS — no simulation state in `ui/` (rule 10 holds)

Verified with care: `ui/` imports no simulation module. The discipline is actively
maintained (`_describe_pick` duck-typing; `toolbar.py` string-valued tools;
`drawing_window.py:32-35` reading brush values from status). The UI owns only view
state.

### SMELL — `settings_window.py` (681 lines) is doing four jobs

(1) the registry-driven control renderer (lines 240-392); (2) a bespoke curved-slider
widget (394-449); (3) the Revert button + tooltip (154-224); (4) the sensor diagram
panel and its drag state machine (531-659, three interacting fields cleared at four
exit paths). Items 2 and 4 are self-contained; `gated_controls.py` is the extraction
precedent.

### SMELL — status-dict defaults duplicated on the UI side

`config_manager.py:51` defaults `max_configs` to a literal `64` (duplicating
`MAX_CONFIGS`); `drawing_window.py:38-68` re-declares the brush/overlay defaults from
`preferences.py:65-79`. Two independent copies of every default.

## 9. Git state

- Branch `reorg-modular-structure`, 50 commits ahead of `master`, no remote configured
  — **nothing is pushed anywhere**.
- Working tree clean except `imgui.ini` — which is **tracked and not gitignored**, so
  it shows as modified after every session that moves a panel (`preferences.json` *is*
  ignored; the inconsistency looks unintentional).
- Recent history is coherent; no half-landed features found.
- Vestigial: `input/` at repo root contains only `__pycache__/` (the module it held was
  replaced by `ui/`); there is also a stale root `__pycache__/`.

## Part I summary — confirmed problems

| # | Finding | Location |
|---|---|---|
| 1 | `TooltipGraphic.reload()` re-raises and kills the app on shader typo; docstring claims otherwise | `ui/tooltip_graphic.py:81-87` |
| 2 | `aspect_correct_uv` duplicated verbatim in 2 shaders — the exact rule-9 failure mode | `strafe_draw.frag:29`, `frame_assembly.frag:74` |
| 3 | `_update_pick` has zero callers; `self.hovered` is permanently `MISS` | `orchestrator.py:485-506` |
| 4 | Tool numbers wrong in help text ([3]/[4] should be [2]/[3]) | `ui/drawing_window.py:82,87` |
| 5 | 3 cross-module imports contradict the "modules never reference each other" claim | `camera_state.py:21`, `strafe_field.py:32`, `project.py:43` |
| 6 | `common.glsl` says `col_params.y` is unconsumed; it is consumed | `common.glsl:229` vs `cam_brush.frag:63` |
| 7 | `600000`/`1024` each written twice; the 4 constants they feed are dead | `particle_system.py:12-15` vs `36-43` |
| 8 | `show_advanced` declared in one mixin, written by another, ordering-dependent | `settings_window.py:72` / `preferences_window.py:58` |
| 9 | Dead UI-local `_manager_message` shadowing the real one | `ui/config_manager.py:37` |
| 10 | Dead code: `world_wrap`, `world_to_screen`, `visible_world_bounds`, `world_for_upload`, `key_held`/`key_pressed`, `is_open`/`previewing`, `History.clear`, unused `replace` import | 8 sites |
| 11 | Stale docstrings: "574 lines / 24 handlers" (now 599/29); "Recognized: 4 commands" (now 29) | `orchestrator.py:18`, `ui.py:55` |
| 12 | Vestigial `input/` directory (bytecode only) after the module was deleted | repo root |

---

# Part II — WebGPU / browser portability audit

## 1. Texture formats — inventory

| Site | moderngl | WebGPU format | LINEAR? | Blend target? | REPEAT? | Class |
|---|---|---|---|---|---|---|
| `particle_system/particle_system.py:95,100` canvas + back | `texture(size, 2, dtype='f4')` = **RG32F** | `rg32float` | **YES** (`:96,101`) | **YES** ONE/ONE (`:414-415`) | **YES**, mode-dependent (`:210-213`) | **BLOCKER** |
| `strafe_field/strafe_field.py:87` field | **RG32F** | `rg32float` | **YES** (`:88`) | **YES** ONE/ONE (`:194-195`) | **YES** (`:156-157`) | **BLOCKER** |
| `camera/camera.py:281` HDR sample | `texture(size, 4, 'f2')` = **RGBA16F** | `rgba16float` | YES (`:282`) | no (cleared+overwritten) | default | FINE |
| `camera/camera.py:285` accumulator | **RGBA16F** | `rgba16float` | YES (`:286`) | **YES** ONE/ONE (`:258-259`) | clamp (`:289-290`) | FINE |
| `assembler/bloom.py:169` mip chain ×5 | **RGBA16F** | `rgba16float` | YES (`:170`) | **YES** ONE/ONE (`:137-138`) | clamp (`:173-174`) | FINE |
| `ui/tooltip_graphic.py:61` | RGBA8 | `rgba8unorm` | YES (`:64`) | no | default | FINE |

### 1a. `rg32float` — the headline finding — [BLOCKER]

Two textures, three independent base-spec facts:

1. **Filtering.** `rg32float` is not filterable in base WebGPU — requires the optional
   **`float32-filterable`** feature. Consumers depending on LINEAR:
   `entity_update.glsl:152,161` (sensor taps + strafe reads), `canvas.frag:21,36,49`
   (diffusion stencil), `camera.frag:54` (present), `frame_assembly.frag:116` (field
   overlay). Falling back to `nearest` would visibly quantize the sensor reads and
   change the simulation.
2. **Blending.** `rg32float` is **not blendable at all** in base WebGPU — the newer
   optional feature **`float32-blendable`** is required, and adapter support for it is
   thinner than for `float32-filterable`. Blend sites: `particle_system.py:414-415`
   (particle splat, ONE/ONE), `strafe_field.py:194-195` (brush accumulate, ONE/ONE).
3. `rg32float` *is* renderable in base WebGPU (write, no blend) — only the blend and
   the filter are fatal.

**Resolution (decided 2026-07-28): switch the desktop chassis to `f2` (RG16F) now.**
`rg16float` is filterable, renderable, AND blendable in base WebGPU with no optional
features, and it keeps the 2-channel shape — so no shader `out vec2` widening, no
wasted channels, and bandwidth halves. (The audit originally suggested `rgba16float`,
which is equally capable but needlessly widens every canvas/field write.) The risk to
verify is dynamic range: `brush.frag:33` multiplies velocity by
`premult = (1-P)/P`, spanning ~1e-3 to ~1e4 across the trail-persistence range. fp16
max is 65504, min normal ~6.1e-5, subnormals to ~6e-8. The A/B verification protocol is
in CLEANUP_PLAN.md item D1; record the verdict here once run. Fallback if fp16 visibly
degrades: a fixed per-channel scale factor, or keep RG32F and require both optional
features (narrower device matrix).

### 1b. REPEAT wrap — [FINE, with a structural note]

`repeat` address mode exists in WebGPU for all formats. But `particle_system.py:210-213`
and `strafe_field.py:156-157` mutate wrap mode on the *texture object* at runtime when
the boundary condition changes. WebGPU samplers are immutable — pre-create a repeat
sampler and a clamp sampler and swap **bind groups**. Cheap, but a structural change at
every site that binds these textures.

## 2. Blending — full inventory

Every blend in the live codebase is **additive ONE/ONE**. No SRC_ALPHA, no separate
alpha blend, no non-default blend equation.

| Site | Target | Mode |
|---|---|---|
| `particle_system/particle_system.py:414-415` | canvas | ONE/ONE |
| `camera/camera.py:238-239` | HDR RGBA16F | ONE/ONE |
| `camera/camera.py:258-259` | accum RGBA16F | ONE/ONE |
| `assembler/bloom.py:137-138` | mip RGBA16F | ONE/ONE |
| `strafe_field/strafe_field.py:194-195` | field | ONE/ONE |
| `strafe_field/strafe_field.py:193,199` | field | **blend disabled for erase** |

Porting notes:

- **`app_window.py:32` enables BLEND globally at startup**; passes toggle around
  themselves. WebGPU has no global blend state — blending is baked into the render
  pipeline. Each pass needs its own pipeline; `strafe_field` specifically needs **two
  pipelines** for one shader: draw (blend on) and erase (blend off, writing literal
  zeros — `strafe_draw.frag:57-71`). [FRICTION]
- The enable/disable pairs are not balanced against the global enable
  (`particle_system.py:430`, `camera.py:242,261` leave blending disabled). Harmless
  today, but there is no single "current blend state" to translate — enumerate
  pipelines per pass. [FRICTION]

## 3. Compute shaders — both clean

**`entity_update.glsl`:** workgroup 256 (`:3`) — within WebGPU's limit. Dispatch
`ceil(entity_count/256)` (`particle_system.py:397-398`) — 2344 workgroups at 600k
entities, far under 65535 (a world_size of ~28+ would exceed it; worth a guard, not a
port issue). SSBOs: binding 0 `EntityBuffer`, binding 1 `ConfigBuffer`. **No atomics,
no `barrier()`, no shared memory** — each invocation touches only `entities[index]`.
Ideal shape for WebGPU. Note: its samplers (`:19,25`) use implicit-LOD `texture()`,
which WGSL compute forbids — becomes `textureSampleLevel(..., 0.0)`, semantically
identical here (no mips). [FRICTION, mechanical]

**`entity_pick.glsl`:** workgroup 256. `atomicMin` on a `uint` SSBO (`:38-40,:74`) —
WGSL has `atomicMin` on `atomic<u32>` in storage; direct translation. The packed-key
trick (`:44-50,:73`) is pure integer math, ports verbatim. `entities.length()` (`:54`)
→ `arrayLength(&entities)`. [FINE]

**`ctx.memory_barrier()` at `particle_system.py:283,285,287`** — WebGPU inserts
barriers automatically between passes. Delete; do not translate. [FINE]

## 4. GL features with no WebGPU equivalent

### 4a. Synchronous readback — [BLOCKER], but tiny

Exactly **two readback sites in live code**, both in `picker.py`, both on-demand
(click / explicit inspect only): `picker.py:131` (`result_buffer.read()`, 4 bytes) and
`picker.py:143` (one 32-byte Entity record). No texture readback anywhere, no
per-frame readback of any kind.

The deferred design (`picker.py:9-19`, `particle_system.py:299-312`) already has the
right shape: `retrieve()` returns the *previous* frame's result before `request()`
dispatches a new one. In WebGPU: copy to a `MAP_READ` staging buffer, `mapAsync()`,
read on resolution a frame later. The existing one-frame latency budget absorbs it.

**The actual blocker is `pick_blocking()`** (`particle_system.py:314-325`, using
`ctx.finish()` at `:324` — WebGPU has no `finish()`). Its docstring claims it is for
"tests, tooling" and "must not be used in the render loop" — **but
`selection_commands.py:76-91` `_pick_at()` calls it, and that is wired to every
left-click in SELECT mode** (`orchestrator.py:394-397`). So the blocking path is on the
primary interaction path. Resolution (decided 2026-07-28): restructure selection to the
async two-phase shape — CLEANUP_PLAN.md item D2. History recording needs
`before = self.project` captured at click time, not at resolution time
(`selection_commands.py:115-117`).

### 4b. Everything else in this category — mostly absent

| Feature | Status |
|---|---|
| Geometry shaders | **None.** |
| `glBlitFramebuffer` / blits | **None** (`bloom.py:120-122` explicitly avoided the reference's blit). |
| Query objects | **None.** |
| `build_mipmaps` | **None** — bloom uses an explicit FBO chain (`bloom.py:163-178`), exactly what WebGPU wants. |
| MSAA / `samples=` | **None.** |
| `alpha_to_coverage` | **None.** |
| Wide lines / point sprites | **None** — reticle is SDF-drawn (`frame_assembly.frag:126-157`); particles are quads. |
| Scissor, cull, depth, stencil | **None set anywhere.** No depth buffer exists. |
| Texture image units | Max **3** simultaneous (`assembler.py:38-41`). WebGPU guarantees 16. |

### 4c. `gl_VertexID` / `gl_InstanceID` and instanced rendering — [FINE, one catch]

Both instanced draws use **zero vertex buffers** — geometry synthesized from IDs
against an SSBO (`particle_system.py:235` + `brush.vert:17-36`; `camera.py:132` +
`cam_brush.vert:41-66`). WGSL: `@builtin(vertex_index)` / `@builtin(instance_index)`.
Direct. **The catch: `TRIANGLE_FAN` does not exist in WebGPU** (draw calls at
`particle_system.py:426-427`, `camera.py:240-241`). A 4-vertex fan (BL, BR, TR, TL)
must become a triangle-strip with corners reordered (BL, BR, TL, TR) or a 6-vertex
list — two small const-array reorderings in `brush.vert:25-36` and
`cam_brush.vert:46-54`. [FRICTION] The fullscreen quad (`gl_utils.py:76-79`) is
already a triangle list. [FINE]

## 5. GLSL → WGSL construct-by-construct

| Construct | Sites | Class |
|---|---|---|
| `intBitsToFloat`/`floatBitsToInt`/`floatBitsToUint` | `common.glsl:130,143,156,173,197,202,218,235`; `entity_update.glsl:60` | [FINE] — `bitcast<f32>()` etc. |
| `#include` | `gl_utils.py:22-70`, host-side substitution | [FINE] — same trick for WGSL, or a bundler |
| Unsized arrays in SSBO | `entity_update.glsl:13,46`; `entity_pick.glsl:29`; `brush.vert:10`; `cam_brush.vert:11` | [FINE] — runtime-sized array as last member; `.length()` → `arrayLength()` |
| Double precision | None | [FINE] |
| `texture()` implicit LOD **in compute** | `entity_update.glsl:152,161` | [FRICTION] — `textureSampleLevel(t, s, uv, 0.0)`; identical here (no mips) |
| `textureSize` | `entity_update.glsl:151,160,225,377`; `canvas.frag:25` | [FINE] — `textureDimensions()`. Called 4×/invocation at 600k×30 substeps; consider hoisting to a uniform |
| `fwidth` / derivatives | `frame_assembly.frag:129,146` ONLY (reticle AA) | [FINE] — fragment-only, which is where it is |
| `discard` | `brush.frag:25`; `cam_brush.frag:51`; `strafe_draw.frag:69,75` | [FINE] |
| `gl_FragCoord` | **Never used** — all passes derive position from interpolated `uv` | [FINE] |
| Matrices in interface blocks | **None anywhere** — the view transform is closed-form scalar math (`common.glsl:348-378`) | [FINE] |
| Combined `sampler2D` | 8 declarations (`entity_update.glsl:19,25`; `canvas.frag:10`; `camera.frag:12`; `accumulate.frag:18`; `bloom_downsample.frag:13`; `bloom_upsample.frag:18`; `frame_assembly.frag:19-21`) | [FRICTION] — splits into `texture_2d<f32>` + `sampler`, doubling binding count. **Awkward spot: `canvas.frag:18,24` passes `sampler2D` as a function parameter** — WGSL cannot; needs inlining or a global |
| `inout` / `out` params | `common.glsl:322`; `entity_update.glsl:142,274,329`; `strafe_draw.frag:42`; `tooltip_graphic.frag:46` | [FINE] — `ptr<function,T>` or return-struct |
| Array-of-struct return / struct constructors | `entity_update.glsl:104-126` returns `FourierCenter[10]`; `:445` `Rule(...)` | [FRICTION] — restructure `generate_random_centers` to fill a `var<function>` by pointer |
| Function overloading | `common.glsl:232,241` — two `make_entity()` | [FRICTION] — WGSL has no overloading; rename one |
| Implicit int→float arithmetic | `entity_update.glsl:85,266,280,382` etc. | [FRICTION] — WGSL is strict; every mixed expression needs `f32()`. Mechanical, but each edit is a chance to silently change the math (see §11) |
| `mod()` | `common.glsl:306,314`; `entity_update.glsl:239` | [FRICTION] — WGSL `%` on floats is truncated, GLSL `mod` is floored. All three current sites have non-negative args so `%` is safe — but verify each, don't assume |
| `asinh` | `frame_assembly.frag:98` | [FRICTION] — confirm WGSL support; fallback `log(x+sqrt(x*x+1))` |
| `atan(y,x)` | `camera.frag:55`; `frame_assembly.frag:137`; `tooltip_graphic.frag:60` | [FINE] — `atan2` |
| `any`/`all` + `lessThan` etc. | `entity_update.glsl:566`; `camera.frag:40`; `frame_assembly.frag:110-111` | [FINE] — comparison operators on vectors, then `any()`/`all()` |
| `flat` interpolation | `cam_brush.vert:28`; `cam_brush.frag:22` | [FINE] — `@interpolate(flat)` |
| `out vec2 fragColor` on a 2-channel target | `strafe_draw.frag:17` | [FINE] — legal in WGSL for `rg*` formats; **stays vec2 under the RG16F decision** |
| Uniforms as loose globals | ~40 across all shaders (`frame_assembly.frag:19-44` densest) | [FRICTION] — must pack into `var<uniform>` structs. `tryset()`'s "uniform optimized out" tolerance has **no WebGPU equivalent** — a UBO field is in the struct or not |
| `uniform WorldData world` (struct uniform) | `entity_update.glsl:17`; `brush.frag:8`; `canvas.frag:8` | [FRICTION→simpler] — set member-at-a-time today (`particle_system.py:195-197`, `config.py:197-206`); becomes one 32-byte UBO write |

## 6. std430 layout — [FINE], genuinely verified

The vec4-only rule (`common.glsl:9-20`) is enforced at startup, not merely documented:
`layout.py:107-122` rejects any non-vec4 member with a `LayoutError`; `:125-142`
re-checks itemsize and 16-byte field alignment; `:153` runs at import time.

Byte layouts hand-verified against the declarations:

| Struct | Members | Size | vec4-aligned? |
|---|---|---|---|
| `FourierCenter` | 2×`vec4` | 32 B | ✓ |
| `Rule` | `FourierCenter centers[10]` | 320 B, stride 32 | ✓ |
| `ConfigData` | `Rule` + 6×`vec4` | 416 B | ✓ — matches `// 416 bytes` comment |
| `WorldData` | 2×`vec4` | 32 B | ✓ |
| `Entity` | 2×`vec4` | 32 B | ✓ |

**Arrays specifically:** `Rule.centers[10]` is the only array; std430 stride 32 equals
the WGSL `array<FourierCenter,10>` stride (alignment 16, size 32 — already a
multiple). **No stride divergence.** This is the case that usually bites and it is
clean here. Host packing (`config.py:99-140,:190-195`) writes through the parsed
dtype, so it cannot drift. The `<4f4` little-endian assumption (`layout.py:32`) is
fine — WebGPU is little-endian everywhere.

**One flagged exception:** `entity_pick.glsl:39` declares
`PickResultBuffer { uint best_key; }` — a bare scalar SSBO violating the vec4-only
rule, outside `common.glsl` so `layout.py` never sees it. Harmless (a single u32 at
offset 0 lays out identically everywhere), but it is an unaudited exception to the
project's own invariant.

## 7. Render-loop structure

- **Read-after-write within a frame — [FINE].** `accumulate.frag:12-16` and
  `bloom_upsample.frag:10-13` explicitly avoid sampling the destination while attached
  and use the blend unit instead — precisely the WebGPU-legal pattern.
- **FBO ping-pong — [FINE].** `particle_system.py:432-449` is a clean double-buffer →
  two textures, two bind groups, alternate per frame. The field needs no ping-pong
  (`strafe_field.py:12-17` explains why). **Subtlety:** `camera.render()` runs *inside*
  the physics loop and the canvas texture must be re-fetched per sample
  (`orchestrator.py:307-309`) — in WebGPU the **bind group must be re-selected per
  sample**, not hoisted. The comment already says so; don't lose it in translation.
- **Texture unit binding model — [FRICTION].** `tex.use(location=N)` at ~11 sites is
  the GL bind-to-unit model; WebGPU replaces it wholesale with bind groups created up
  front. `_set_constant_uniforms()` (`particle_system.py:144-156`) — which exists to
  avoid re-setting unit numbers per substep — becomes unnecessary.
- **Pass count — [FRICTION, performance].** At default `physics_steps=30`, each frame
  runs 30× `advance()` × 3 GPU passes (`particle_system.py:283-288`) = **90
  passes/frame**, plus per-sample camera renders, 9 bloom passes, and assembly.
  WebGPU's per-pass encoder overhead is meaningfully higher than GL's and is JS-side.
  **The most likely place the port becomes slower than desktop.** Plan: batch
  substeps or reduce the default.
- **`ctx.screen` — [FINE after restructure].** WebGPU has no persistent default
  framebuffer; `context.getCurrentTexture()` is acquired per frame. The
  `tooltip_graphic.py:106-109` "hand the screen back" idiom disappears (each pass
  names its own target).

## 8. Filesystem

| Concern | Sites | Class |
|---|---|---|
| Config discovery / directory scan | `persistence.py:339-367` (`glob`, `iterdir`, per-subfolder categories), driven from `orchestrator.py:66`, `project_commands.py:75-81` | **[BLOCKER-ish]** — no directory enumeration in a browser. Needs a build-time **manifest JSON** for shipped configs + IndexedDB/OPFS for user configs |
| Config read | `persistence.py:298-307` | [FINE] — `fetch()` / IndexedDB |
| Config write / delete | `persistence.py:289-295`; `project_commands.py:107-111,179` | [FRICTION] — IndexedDB/OPFS, File System Access API (Chromium-only), or download-blob |
| `preferences.json` | `preferences.py:30,102-120`, written on every edit (already debounced by the unchanged-value guard, `drawing_commands.py:113-114`) | [FINE] — `localStorage` |
| Shader hot-reload from disk | `gl_utils.py:22-70` + reload paths in all 7 GPU modules, fanned in from `orchestrator.py:576-584` | [FRICTION] — the *feature* ports (fetch + `createShaderModule` + rebuild pipelines) but reading the user's filesystem does not. Becomes an in-page editor or a dev-server watch. **A product decision, not just technical** |
| `#include` resolution | `gl_utils.py:62-70` | [FRICTION] — fetch-based resolver or build-time bundler |
| File dialogs | **None** — save uses an in-app text field + `sanitize_filename()` (`persistence.py:310-318`) | [FINE] |
| Path handling | All `Path(__file__).parent`-relative (12 sites) | [FINE] — becomes URL-relative |

## 9. GLFW / windowing / input

| Concern | Sites | Class |
|---|---|---|
| Window + context creation | `app_window.py:22-31` | [FRICTION] — `<canvas>` + `requestAdapter/requestDevice` |
| Framebuffer vs window size (HiDPI) | `app_window.py:37,65-68`, resize `:38-50` | [FRICTION] — `devicePixelRatio` + `ResizeObserver`; the distinction the code keeps is real on the web too |
| `swap_buffers` / `poll_events` / `get_time` | `app_window.py:61`; `ui.py:187,99,190` | [FINE] — rAF / event loop / `performance.now()` |
| Input callbacks | `ui.py:76-80,126-175` | [FRICTION] — DOM events; keydown auto-repeat semantics differ (`event.repeat`) |
| Key constants (~30 uses) | `ui.py:420-482`, `orchestrator.py:434-443` | [FRICTION] — remap to `KeyboardEvent.code`. Mechanical |
| `glfw.get_key_name` | `ui.py:389` (debug panel only) | [FRICTION] — layout-dependent on web; low stakes |
| Modifiers | `ui.py:416-417` | [FINE] |
| Clipboard | **Not used** — Ctrl+C/V are the app's *internal* config clipboard | [FINE] — but the browser will intercept real Ctrl+C/V; `preventDefault()` needed |
| Cursor modes, window title updates, monitor queries, fullscreen | **None** | [FINE] |

## 10. imgui — [BLOCKER for the layer; largest single cost by volume]

`imgui_bundle` + `GlfwRenderer` (`ui/ui.py:33-34,69`) has no browser equivalent to
translate to. The whole `ui/` package (11 files, ~2,700 lines) needs a web-native
**reimplementation** (React/Svelte/Lit or a canvas immediate-mode lib), not a port.

Specific imgui features in use:

- **Docking** (`ui.py:63`) — imgui-specific; rebuild as a panel layout. `imgui.ini`
  shows an active DockNode (Project + Drawing tabbed). [BLOCKER]
- **ini persistence** (`imgui.ini`, auto-written, currently *tracked in git*) — web
  port needs its own layout persistence (localStorage). [FRICTION]
- **`imgui.ImTextureRef(self._texture.glo)`** (`ui/tooltip_graphic.py:69`) — hands a
  raw GL texture name to imgui for `imgui.image()`. The tightest GL↔UI coupling in the
  codebase; on the web the diagram becomes a small `<canvas>` or a composited
  WebGPU texture. [BLOCKER]
- **Modal dialogs** (`ui.py:267-268`). [FRICTION]
- **Input capture arbitration** (`io.want_capture_mouse/keyboard`,
  `ui.py:129,156,174,222-223`) — load-bearing; the DOM's model (hit-testing before
  your handler, `stopPropagation`) is *different*, and `InputState`'s
  `any_left_pressed` vs `left_pressed` distinction (`ui.py:209,224`) will need
  rethinking. [FRICTION]

**Mitigating factor:** rule 10 is enforced — the UI owns no simulation state, so the
rewrite boundary is clean: reimplement `ui/`, keep the command-dict interface at
`orchestrator.py:196-235` intact. That command dict is, in effect, already an API.

## 11. Threads / subprocess / video / audio / per-frame numpy

**Absent from live code entirely** (present only in `Reference/`): threads,
subprocess/ffmpeg/video recording, audio, Pillow (in `requirements.txt` but unused by
live code). [FINE]

**Per-frame host compute — [FINE], verified.** `_settings_dicts()` is guarded behind
"a settings window is open" (`orchestrator.py:554-561`); `_refresh_world_uniform()` is
rebuilt only on project change (`particle_system.py:185-193`).

### `mutation.py` bit-exactness — [FRICTION], the subtlest item in this audit

`particle_system/mutation.py` is a line-for-line host mirror of shader math
(`entity_update.glsl:53-72,104-126,274-282`), existing so selection can reproduce what
a particle obeys without a GPU readback — a design choice made *for* the port.

| Op | Site | Port concern |
|---|---|---|
| `np.uint32` mul/add with wraparound | `:67-70` | JS: `Math.imul()` + `>>> 0`; plain JS numbers silently lose precision above 2^53 and give wrong hashes |
| Variable right-shift | `:68` | mask the shift amount to 0–31 |
| `.view(np.uint32)` float bit-reinterpret | `:80` | `Float32Array`/`Uint32Array` over one `ArrayBuffer` |
| `np.float32(...)` everywhere (~40 casts) | throughout | **JS has no float32 arithmetic** — every intermediate needs `Math.fround()`; missing one gives float64 divergence |
| **`np.power(h0, 2.0)` — `pow`, not `h*h`** | `:149` (comment at `:145-148`) | **The trap.** The code notes `pow(h,2.0)` and `h*h` differ by 1 ULP, and the chaotic hash amplifies 1 ULP into a completely different rule (measured: seed 0.3088 vs 0.2605). JS `Math.pow` is not guaranteed bit-identical to GLSL `pow`. **The highest-risk port line in the file** |
| `np.errstate(over='ignore')` | `:79` | JS wraps silently; no equivalent needed |

**Does float32 determinism matter?** Yes, but the blast radius is contained by design:
a generated rule is never also mutated (`mutation.py:26-32`,
`entity_update.glsl:436-444`), which is what makes ~1-ULP agreement sufficient instead
of bit-exactness. **WGSL-side risk:** WGSL permits the same FMA contraction GLSL does,
so the GPU may fuse differently than the JS mirror. The GPU-vs-host probe test
(`mutation.py:21-23`, `selection_commands.py:10-11`) **must be ported alongside**, or
this breaks silently and presents as "the simulation jumped."

## 12. Python-specific runtime behaviors

### `layout.py` parsing `common.glsl` at import — decision needed for the port

`layout.py:153` regex-parses `common.glsl` into numpy dtypes at import; a bad file
fails before the first buffer upload. Rationale (`layout.py:8-12`): users hand-edit
shaders live, so the `.glsl` must stay authoritative and hand-authorable. Options:

1. **Re-implement the parser in JS** (~150 lines; WGSL struct syntax differs, so a new
   parser, not a translation — the strictness checks at `:107-122,:125-142` are the
   valuable part and port directly). Preserves hot-reload of struct layout.
2. **Pre-generate at build time** — emit a JSON layout descriptor from the Python
   parser; ship it. Zero runtime cost; **breaks live struct editing**.
3. **Hybrid** — pre-generate for production, JS parser in dev mode.

If hot-reload survives the port (§8), option 1 or 3; if not, option 2 is strictly
better.

### Other Python-isms

| Behavior | Sites | Class |
|---|---|---|
| `dataclasses.asdict`/`replace`/`fields` as the settings-edit mechanism; `_coerce` reads declared field types at runtime | `preferences.py:112-126`; `orchestrator.py:567-569`; `drawing_commands.py:119-131` | [FRICTION] — TS has no runtime types; needs an explicit schema (`ui/settings_spec.py` is already half of one) |
| Frozen dataclasses as immutable values | `Preferences`, `SimulationConfig`, `WorldSettings`, `Project`, `PickResult` | [FINE] — maps cleanly to immutable JS updates |
| Identity comparison `before is not self.project` | `selection_commands.py:163` | [FINE] — `!==` is reference identity; load-bearing, easy to break with a spread-copy |
| Mixin multiple inheritance | `orchestrator.py:106-108` (7); `ui/ui.py:48-49` (6) | [FRICTION] — JS/TS has no MI; composition. Mechanical but reshapes the classes |
| Enum-by-string-value round-trips | `selection_commands.py:60-70`; `CameraMode` | [FINE] — string union types |
| Shader-compile catch-and-keep-old | `assembler.py:65-67` etc. | [FINE] — works in WebGPU, but compile errors surface **asynchronously** via `compilationInfo()`, so the try/except shape becomes a promise chain |
| `tryset` tolerating absent uniforms | `gl_utils.py:107-120`, ~50 uses | [FRICTION] — no WebGPU equivalent; UBO layout is fixed. The tolerance (a shader edit dropping a uniform without crashing the host) **is lost**, which interacts badly with hot-reload |

---

# Ranked summary

**BLOCKERS (need redesign):**
1. **`rg32float` LINEAR + blending** — canvas (`particle_system.py:95,100`) and strafe
   field (`strafe_field.py:87`). Base WebGPU can neither filter nor blend the format.
   **Decision: switch desktop to RG16F now** (CLEANUP_PLAN.md D1); verify fp16 range
   against `brush.frag:30-33`.
2. **`pick_blocking` / `ctx.finish()`** — on the live click path via
   `selection_commands.py:76-91`. **Decision: restructure to async now**
   (CLEANUP_PLAN.md D2).
3. **The entire imgui layer** — 11 files, docking, ini persistence, raw-GL-texture
   handoff at `tooltip_graphic.py:69`. Largest work item; rewrite boundary
   (`orchestrator.py:196-235`) is clean.
4. **Config directory scanning** — `persistence.py:339-367`. Needs a manifest +
   IndexedDB/OPFS.

**FRICTION (portable, needs rework):**
5. `TRIANGLE_FAN` → triangle-strip + quad reordering (`brush.vert:25-36`,
   `cam_brush.vert:46-54`).
6. Combined `sampler2D` → split texture/sampler; `canvas.frag:18,24` passing a sampler
   as a function parameter needs restructuring.
7. Runtime wrap-mode mutation → pre-built sampler pairs + bind-group swap.
8. Global blend state → per-pass pipelines; strafe_field needs a blend/no-blend pair.
9. `textureSample` → `textureSampleLevel` in the compute shader
   (`entity_update.glsl:152,161`).
10. `mutation.py` float32 mirror → `Math.fround` everywhere, `Math.imul` for the hash;
    `np.power` at `:149` is the highest-risk line. Port the probe test alongside.
11. `layout.py` GLSL parser — reimplement vs pre-generate (§12).
12. GLSL laxity (implicit int→float, `mod`, overloaded `make_entity`, array-returning
    functions) → WGSL strictness.
13. 90 GPU passes/frame at default settings — the likely perf cliff.

**FINE (direct equivalents, verified):** no geometry shaders, blits, queries, MSAA,
mipmap generation, depth/stencil/cull/scissor, `gl_FragCoord`, interface matrices,
doubles, threads, subprocess, ffmpeg, audio, system clipboard, file dialogs, cursor
modes, or monitor queries. Atomics and derivatives appear only where WGSL allows them.
std430 layout is vec4-only, startup-enforced, hand-verified for all five structs
including the `FourierCenter[10]` stride. The accumulator and bloom deliberately blend
rather than sample-the-destination — the WebGPU-legal pattern.
