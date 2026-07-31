# Fluoddity Web Port — 10-Step Plan

**Status:** approved 2026-07-29, not started. This is the execution plan for the
WebGPU/Tweakpane port. It is a companion to two existing docs, not a replacement:
`ARCHITECTURE.md` is the design contract and remains the spec; `PORT_AUDIT.md` is
the construct-by-construct portability survey this plan is built on.

## Context

Fluoddity2 is a GPU particle simulation (~8,600 lines Python + ~1,900 lines GLSL)
that has been deliberately prepared for this port. We now want it running in the
browser on WebGPU, with Tweakpane replacing imgui.

**Priority 1 is a faithful translation of the core physics engine.** The engine is
`entity_update.glsl` + `common.glsl` + the canvas/trail passes + the coordinate
chain. That is non-negotiable. The UI/UX (~4,500 lines across `ui/` and
`orchestrator/`) is flexible: where a desktop widget doesn't suit Tweakpane, we
substitute rather than fight it.

**Why this is realistic.** The prep work already happened, and it was the right
prep:

| Prep already done | Why it matters |
|---|---|
| vec4-only GPU structs, enforced at startup by `layout.py` | std430 and WGSL agree with **no layout audit** — normally the biggest hazard |
| RG16F/RGBA16F everywhere (not RG32F) | Every format filters, renders and blends in **base** WebGPU, no optional features |
| Picking already two-phase async (`picker.py`) | WebGPU has no synchronous readback; the live path already doesn't need one |
| Coordinate math in exactly two places (`coords.py`, `common.glsl`) | One transform to port, not the reference's six drifting copies |
| Shader hot-reload triggers already removed | No affordance to port that has no browser meaning |
| Rule 10 enforced — `ui/` imports no simulation module | The rewrite boundary is **already an API**: 26 commands + 30 `STATUS_KEYS` |
| No geometry shaders, blits, MSAA, mipmap generation, depth/stencil, `gl_FragCoord`, MRT | Whole categories of port work are simply absent |
| `docs/PORT_AUDIT.md` (818 lines) | A construct-by-construct GLSL→WGSL audit already exists |

The honest risks are three, and none is architectural: **GLSL laxity vs WGSL
strictness** (dozens of mechanical casts, each an opportunity to silently change
math), **90 GPU passes/frame** at default settings where WebGPU's JS-side encoder
overhead is higher than GL's, and **`mutation.py`'s float32 mirror** — which
Step 6 deletes rather than ports.

### Decisions taken before planning

- **Verification is visual A/B**, not numeric golden vectors. The dynamics are
  sensitive enough to judge by eye. Method: load the same preset in both apps at
  the same world size and physics rate, reset both, run free, compare emergent
  character. No lockstep, no frame-N-to-frame-N comparison.
- **`mutation.py` is not ported.** Instead the picked entity's derived rule is
  **read back from the GPU** (Step 6). This deletes the highest-risk file in the
  port outright — see that step for the cost.
- **Config storage: build-time manifest + IndexedDB.** Shipped presets are
  fetched read-only from a generated `manifest.json`; user saves go to IndexedDB
  under the same `(category, name)` key identity `ConfigEntry` already uses.
- **Milestone 1 is engine-first with a thin UI** — a flat Tweakpane dump of the
  registry, no tabs/gates/tooltips/menus — so physics parity is never blocked on
  UI design questions.
- **Hotkey collisions (Ctrl+C/V, Ctrl+R, Tab) are deferred.** Step 8 builds a
  focus-aware rebindable table; the actual bindings get chosen once the UI exists.

### Reference docs — read these first

- `docs/ARCHITECTURE.md` — the design contract. Its 10 invariants are the spec.
- `docs/PORT_AUDIT.md` — the GLSL→WGSL construct table (§5), format inventory
  (§1), and ranked blocker list. **Several file:line refs are stale** (they point
  into a pre-cleanup tree; `ui/config_manager.py` and `ui/tooltip_graphic.py` no
  longer exist). Its §3 and §8 hot-reload findings are already fixed.

---

## Step 1 — Scaffold, and the shader preprocessor

Stand up the project and solve the one piece of infrastructure every later step
depends on.

- Vite + TypeScript, `<canvas>` + `requestAdapter`/`requestDevice`, a rAF loop,
  `ResizeObserver` + `devicePixelRatio` (keep the `window_size` vs framebuffer
  distinction — it's as real on the web as on desktop).
- **A WGSL `#include` resolver.** `shared/gl_utils.py:22-70` does host-side text
  substitution with include guards; 7 of 12 shaders depend on it. Port it as a
  Vite plugin (build-time) so `common.wgsl` stays one hand-authored source of
  truth per invariant 8.
- Device-loss and adapter-absent paths: a clear "WebGPU unavailable" message, not
  a blank canvas.
- Keep invariant 5's *shape*: setup isolated in a re-runnable `reload()`-style
  helper, compile failure logged not fatal. Note WGSL compile errors surface
  **asynchronously** via `compilationInfo()`, so the try/except becomes a promise
  chain.

**Deliverable:** a black canvas with a live device and a working shader import.

---

## Step 2 — The pure-math leaves

Port the files with no GPU and no dependencies. These are small, exactly
specifiable, and everything downstream composes them.

| From | To | Notes |
|---|---|---|
| `particle_system/sizing.py` (75 lines) | `sizing.ts` | Imports only `math`. `ENTITIES_PER_WORLD_UNIT=600_000`, `BASE_CANVAS_DIM=1024`. Canvas edge goes as √(world_size) because world size is an **area** |
| `particle_system/coords.py` (228 lines) | `coords.ts` | The whole coordinate chain. Per invariant 9 this and `common.wgsl` are the **only** places allowed to write aspect/camera math |
| `camera/camera_state.py` (130 lines) | `cameraState.ts` | pan (world units) / zoom (magnification, bigger = in) / mode. `zoom_at_pixel` is the cursor-anchored scroll |
| `particle_system/config.py` (214 lines) | `config.ts` + a packing module | `SimulationConfig` → 416-byte record. `_int_lane` is the `intBitsToFloat` mirror |

**On `layout.py` (160 lines):** it regex-parses `common.glsl` at import to build
numpy dtypes. **Pre-generate instead** — emit a JSON layout descriptor from the
existing Python parser at build time and ship it. Hot-reload of struct layout is
gone (invariant 5), so PORT_AUDIT §12's option 2 is now strictly better than
reimplementing the parser. Keep the *strictness checks* (`layout.py:107-142`:
reject non-vec4, verify 16-byte alignment) as a build-time assertion — that's the
valuable part, and it's what stops the vec4 rule from silently rotting.

**Verify:** unit-test `coords.ts` round-trips (`screen_to_world` ∘
`world_to_screen_ndc` = identity) and check `sizing.ts` against the Python values
for world sizes 0.25 / 1.0 / 4.0.

---

## Step 3 — `common.wgsl`

Translate the single source of truth for struct layout and coordinate math
(`shared/shaders/common.glsl`, 425 lines). Everything else in the engine
`#include`s this, so it comes before any pass.

Structs, unchanged in size (verified in PORT_AUDIT §6):

| Struct | Members | Bytes |
|---|---|---|
| `FourierCenter` | 2 × vec4 | 32 |
| `Rule` | `array<FourierCenter,10>` | 320, stride 32 |
| `ConfigData` | `Rule` + 6 × vec4 | **416** |
| `WorldData` | 2 × vec4 | 32 |
| `Entity` | 2 × vec4 | 32 |

`Rule.centers[10]` is the only array and std430 stride 32 already equals the WGSL
`array<FourierCenter,10>` stride. **No stride divergence** — the case that
usually bites is clean here.

Known translations for this file:
- Rename one of the two `make_entity` overloads (`common.glsl:268,277`) — WGSL has
  no overloading.
- `world_bounce(inout vec2 p, inout vec2 v, ...)` (`:369`) → return a struct.
- `floatBitsToInt`/`intBitsToFloat` → `bitcast<i32>`/`bitcast<f32>` (12 sites).
- `mod(abs(x), 2.0)` in `edge_fold` (`:361`) — WGSL `%` is truncated where GLSL
  `mod` is floored. **Args are non-negative here so `%` is safe — verify, don't
  assume.**
- `#define` constants → `const`.

**The `ConfigData` lane comments must come across verbatim.** They are the only
record of which float means what, there are no spare lanes left in `sensor`/
`force`/`misc`/`force2`/`misc2`, and `misc3` has three.

---

## Step 4 — `entity_update` and the trail canvas

**DONE.** The engine runs in the browser at parity. See `web/README.md` for the
A/B results and the divergence list. Corrections to what this section said,
recorded because a later step would otherwise re-derive them:

- **`textureSize` is called 4-6×, not 4×**, and `:167` is `strafe_field_texture`
  — a *different* texture. The canvas sites are `:151` (twice, via the two
  sensor taps), `:232` (once or twice, via reset and the fence) and `:384`.
- **`#ifdef HARD_FENCE` is at `:552`, not `:551`** (`:551` is the commented-out
  `//#define`). It is defined nowhere in the repo, so the **`#else` soft fence
  is the live branch** and the `reset(); return;` variant is dead.
- **GLSL `==` on a vector returns a scalar bool; WGSL's returns `vec4<bool>`.**
  `:439` needs `all(...) && all(...)`. Not mentioned below; the compiler catches
  it, but it is a real semantic difference rather than a cast.
- **WGSL function parameters are immutable.** `calculate_entity_behavior`
  reassigns `L` and `R` (`:344-345`), which is legal in GLSL and not here.
- **THE Y FLIP, which this section does not mention and which cost the most.**
  OpenGL's framebuffer origin is bottom-left and WebGPU's is top-left, so every
  stage that rasterizes into the canvas needs a flip the GLSL does not have —
  `brush.wgsl` (negate NDC y) and `canvas.wgsl` (flip the quad's v). Getting
  either wrong is *not* an upside-down picture: the canvas is a feedback loop,
  so it reads the mirrored row and the physics quietly changes. Measured at ~3×
  less canvas energy by sub-step 3.
- **The three presets were replaced during Step 4.** `configs/` now holds
  `Starcrossedv8.json`, `9leafv8.json` and `hatmanv8.json`, all v8. `Angles` is
  gone. `particle_system.py:45` was updated to match — it pointed at the deleted
  `Starcrossed.json` and the desktop app would not start.
- **Step 4 needs a present pass**, since the camera is Step 5 and a black canvas
  is also a *successful* Step 1-3 build. `web/src/app/debugPresent.wgsl` is that
  throwaway; **Step 5 deletes it.**

The heart of the port, and where "faithful" is decided.

**`entity_update.glsl` (581 lines) → compute, workgroup 256.** Per entity: two
sensor taps off the canvas, evaluate the Fourier rule twice (once mirrored, to
cancel chirality), then integrate drag/force into velocity and
velocity/strafe/gravity/painted-field/shove into position, then cohort fences,
then boundary conditions. Also owns reset/spawn, the PCG hash family,
`generate_random_centers`, `mutate_rule`, `gravity_expand`.

Specific translations:
- `generate_random_centers` returns `FourierCenter[10]` (`:104-126`) → fill a
  `var<function>` array through a pointer.
- `mutate_rule(inout Rule)` → return the struct.
- `calculate_entity_behavior` has 3 `out` params (`:336`) → return a struct.
- `#ifdef HARD_FENCE` (`:551-560`) is the only conditional compilation in the
  codebase. WGSL has no preprocessor — resolve it at build time or delete the
  unused branch.
- `entities.length()` → `arrayLength(&entities)` (returns `u32`).
- `textureSize(canvas_texture, 0)` is called **4× per invocation** (`:151,167,232,384`).
  → `textureDimensions()`, but **hoist to the uniform** — at 600k entities × 30
  substeps this is not free.
- `texture()` in compute → `textureSampleLevel(t, s, uv, 0.0)`. Identical here
  (no mips).
- Implicit int↔float promotion is used liberally (`:68,85,235,269,287,389`).
  Every one needs an explicit cast. **This is where math changes silently** — the
  compiler finds the errors but not the mistakes.

**The canvas double-buffer.** `canvas.frag` (61 lines) is the decay/diffuse
pass: 5-tap cross blur with a boundary-aware fetch (`fract()` for wrap,
`clamp()` otherwise), × trail persistence, clamped to ±`CANVAS_VALUE_MAX` as fp16
inf-insurance. It reads neighbours, so it needs the ping-pong.
**`getCan(vec2 p, sampler2D sam)` (`:18`) passes a sampler as a function
parameter — WGSL forbids this outright.** Inline it or hoist the sampler to a
module-scope binding.

**`brush.vert`/`brush.frag` (45+38 lines)** — the trail splat, instanced,
additive `ONE,ONE`, no vertex buffer at all (reads the entity SSBO by
`instance_index`, builds the quad from `vertex_index`). Two catches:
`TRIANGLE_FAN` is **not a WebGPU topology** → triangle-strip with `0,1,3,2`
reordering or a 6-index list; and the vertex stage reads a storage buffer, so
that buffer needs `STORAGE` usage in a **vertex-visible** bind group.

**Frame 0 is a sentinel three shaders watch for.** `reset()` does nothing but set
`frame_count = 0`; `canvas.frag:39` writes zero (that *is* the trail clear) and
`brush.frag:24` discards. Preserve this — it's load-bearing, not incidental.

**Boundary mode → samplers.** `_apply_boundary_sampling` flips `repeat_x/repeat_y`
at runtime. WebGPU samplers are immutable: build a repeating and a clamping
sampler up front and **swap bind groups**. Four things must agree on the mode or
the boundary only half-exists (invariant 9): the entity update, the canvas
samplers, the diffusion stencil, and every sensor read.

**Verify:** the first real A/B. Load `Starcrossedv8.json` in both apps at world
size 1.0 and physics rate 30, reset both, watch them evolve. TRAIL mode only at
this point — no bloom, no tone curve, no overlays. This is the step that must be
right before anything else matters.

---

## Step 5 — The render pipeline

**DONE.** Both camera modes, motion blur, bloom, brightness and the tone curve
run in the browser. See `web/README.md` for the measurements and the divergence
list. Corrections to what this section said, recorded because a later step would
otherwise re-derive them:

- **Two compile-blockers this section does not mention, both the same rule.**
  WGSL forbids implicit-derivative sampling in **non-uniform control flow**, and
  two sites are exactly that: `camera.frag`'s letterbox early-out (`:40-43`) and
  `frame_assembly.frag`'s field sample (`:107`, guarded by the per-fragment
  `inside`). Both need `textureSampleLevel` — numerically identical, no mips.
  These are hard compile errors, not subtleties, and they surface **only in a
  browser**, so `npm test` cannot see them. That is why Step 5 added
  `web/tools/browserCheck.mjs`.
- **`fwidth` is legal, and the note below is right about why** — but the
  refactor that breaks it is specific and worth naming: `inside` is per-fragment
  and sits two lines above the reticle's guard. Hoisting it into that guard is a
  plausible-looking tidy-up that makes the shader fail to compile. Commented at
  the site and asserted structurally.
- **THE Y FLIP AGAIN, in the opposite direction.** `cam_brush` needs **no**
  flip, although `brush.wgsl` — which it otherwise mirrors — negates y. The
  difference is the *target*: `brush` writes into the canvas (read back y-up),
  `cam_brush` writes into the screen, whose partner is `camera.wgsl` walking the
  same transform backwards from an unflipped quad. The mode toggle is the test
  and it is free.
- **The bloom upsample must `loadOp: 'load'`.** No desktop analogue — moderngl
  simply does not clear. A `'clear'` gives a plausible, slightly-too-diffuse
  glow that reads as "the radius is too big".
- **The accumulator clear needs an encoder, which `beginFrame` has not got.** A
  zero-draw render pass rather than a `loadOp` branch, so `camera.py:150-153`'s
  "no first-sample special case" survives.
- **A pre-existing bug surfaced here.** The three per-sub-step uniform buffers
  were sized once from the initial `physicsSteps`, which is a *live* preference.
  Raising the rate overran them — an out-of-bounds dynamic offset, which
  invalidates the command buffer and freezes the screen. Fixed in
  `particleSystem.ts`; it would have hit Step 7 the moment the rate got a slider.
- **The performance suspicion did not hold.** Encode time is **under 0.4 ms in
  every configuration**, ~2% of the frame. The port is *not* encoder-bound, so
  the mitigations this plan lists in preference order are mostly spent: batching
  is already done, and merging the three `advance()` passes would buy almost
  nothing. See the open question at the end of this document, now answered.

The section as originally written follows.

Everything from "the simulation advanced" to "pixels on screen." Order is
load-bearing: **everything before the tone curve is linear**, and the curve runs
exactly once, at the end.

**Start by deleting `web/src/app/debugPresent.wgsl`** and the `presentPass`
helper in `main.ts`. Step 4 added them only so the engine could be seen at all;
they implement no camera, no letterbox, no bloom and no tone curve, and
`camera.frag`'s port replaces both. Note the canvas is stored **top-left-origin**
(see the Y-flip note in `web/README.md`), so the present pass samples it
straight — `debugPresent.wgsl` documents which way round that lands.

```
Camera                              Assembler
colorize   RG canvas → RGB          bloom       threshold, 5 mips down, tent up
accumulate acc += sample/N          brightness  linear exposure
                                    tone curve  asinh, linear → display
                                    overlays    field, reticle  (AFTER the curve)
```

- `camera.frag` (61) — TRAIL present, walks the **inverse** transform per pixel;
  that inverse is what places the letterbox bars.
- `cam_brush.vert/frag` (69+68) — PARTICLES mode (**the default**), instanced
  sprites transformed to screen NDC **in the vertex shader**, so the present pass
  must not apply the camera again. `flat out` → `@interpolate(flat)`.
- `accumulate.frag` (30) — motion blur. One line, but the weight must be
  `1/samples` (the achieved count) never `1/requested`, or brightness shifts at
  slider positions where they disagree. `blur_schedule()` in
  `orchestrator/orchestrator.py:71` derives both.
- `bloom_downsample/upsample.frag` (39+40) — 5 **separate textures with their own
  targets**, not GL mip levels, so there is no `generateMipmap` to port.
- `frame_assembly.frag` (156) — bloom add, brightness, `asinh` tone curve on the
  colour's **length** (not per channel), then the two overlays.
  **`asinh` is not a WGSL builtin** → `log(x + sqrt(x*x + 1.0))`.
  `fwidth` (`:124,141`) is legal here — both calls sit inside branches on
  *uniforms*, so control flow is uniform. **Comment that in the port** so a later
  refactor doesn't break it.

Two structural notes:
- **Blend state is per-pipeline in WebGPU.** Only two modes exist in the whole
  app (`ONE,ONE` and off), which is the easy case — but `strafe_draw` toggles
  blending at runtime between draw and erase, so it needs **two pipelines**.
- **Bind groups must be complete.** `assembler.py:102-109` relies on "intensity 0
  means the sampler is never fetched, so a stale binding is harmless." WebGPU
  validates regardless — bind a 1×1 dummy texture for the bloom and field slots.
- Re-fetch the canvas bind group **per camera sample**, not hoisted: the
  double-buffer swaps inside `advance()`.

**Verify:** A/B both camera modes, then bloom/tone/brightness sweeps. This is
where visual comparison is the *right* tool — these stages are perceptual, and
exactness doesn't matter.

---

## Step 6 — Picking, and deleting the mutation mirror

**DONE.** Picking works in the browser and the picked rule is derived on the
GPU; `mutation.py` is not ported. See `web/README.md`'s "Picking" section for
the design and the verification results. Corrections to what this section said,
recorded because a later step would otherwise re-derive them:

- **The shared-code assumption below is FALSE as written.** `:372-373` says both
  shaders `#include "common.wgsl"` "so this is shared code, not a second copy."
  They do — but `pcg_hash`, `hash`, `hash4`, `generate_random_centers`,
  `get_cohort` and `mutate_rule` all lived in `entityUpdate.wgsl`, not in
  `common.wgsl`, so there was nothing shared to inherit. They cannot simply move
  there either: `common.wgsl` is included by `brush.wgsl` and `camBrush.wgsl` in
  **vertex** stages, and its own rules 3 and 4 (`common.wgsl:38-52`) require it
  to stay pure and stage-agnostic. The shared home is a **sibling**,
  `rule.wgsl`, which the resolver finds from both includers (sibling-first
  lookup, `wgslInclude.ts:125-141`). Step 6 therefore begins with a refactor of
  the Step 4 physics shader, gated on a screenshot A/B before anything is built
  on it.
- **`get_cohort` needed a new signature.** It called `arrayLength(&entities)`,
  and the two shaders bind that array with different access qualifiers
  (`read_write` in the update, `read` in the picker), so a shared function may
  not name it. It takes the entity count as a third parameter; both call sites
  pass `arrayLength(&entities)`. Reverting compiles in `entityUpdate` and fails
  **only in a browser**, so `shaders.test.ts` asserts it.
- **The result buffer is 336 bytes, not the 324 at `:380`.** `Rule` is 16-byte
  aligned, so WGSL inserts 12 bytes of padding after the `u32` key regardless.
  The winner's position rides inside that padding and costs nothing — but only
  if it is stored as **two `f32`s**: a `vec2f` has alignment 8, cannot sit at
  offset 4, and pushes the struct to 352, at which point the driver rejects the
  336-byte buffer as too small. That one was found by the browser, not by
  reasoning.
- **`target` is a reserved keyword in WGSL.** `entity_pick.glsl:52` names the
  uniform exactly that, so the obvious translation does not compile. Renamed
  `pick_target`. Like the Y flips and the non-uniform-derivative rule, this
  surfaces only in a browser.
- **The two dispatches need two `beginComputePass` calls**, not two dispatches
  in one pass. WebGPU orders passes within a submission and inserts the barriers
  between them, but guarantees nothing between dispatches inside a single pass —
  so `derive` would race the reduction it reads.
- **`retrieve_pick` needs a third answer.** `null` ("not ready yet") must stay
  distinct from a miss ("nothing in range"): `mapAsync` means the result can
  simply not have arrived, and collapsing the two silently drops any click whose
  readback took longer than a frame. `picker.py` conflates them safely only
  because its `retrieve()` always answers.
- **The cohorts open question (`:668-673`) resolved as its stated default:**
  ported as-is. Nothing in Step 6 needed them changed.

The section as originally written follows.

Picking is already WebGPU-shaped: `request_pick()` dispatches, `retrieve_pick()`
reads on a **later** frame. `entity_pick.glsl` (87 lines) reduces with a single
`atomicMin` over a packed key — 8 bits of quantized distance in the high bits,
24 bits of entity index in the low, so minimizing the key minimizes distance and
breaks ties by lowest index (deterministic on purpose). Maps directly to WGSL
`atomicMin` on `atomic<u32>`; `retrieve()` becomes `mapAsync` on a staging buffer.

**The design decision: do not port `mutation.py` (236 lines).** On desktop, the
picked particle's derived rule is *recomputed host-side* in float32 to avoid a
readback. In JS that becomes a minefield — no float32 arithmetic (every
intermediate needs `Math.fround`), `Math.imul` + `>>>0` for the hash, and
`np.power(h0, 2.0)` at `mutation.py:149` where the comment records that `pow(h,2)`
and `h*h` differ by 1 ULP and the chaotic hash amplifies that ULP into a
completely different rule (measured seed 0.3088 vs 0.2605). A wrong adopted rule
looks like a legitimate result, which makes it the worst possible failure mode.

**Instead, read the rule back from the GPU.**

The cost below was raised and **accepted** — this is the agreed approach, not a
proposal.

The cost, stated plainly: **the rule isn't currently stored anywhere.** `Entity`
is 32 bytes (`pos_vel` + `misc`) and the derived rule is recomputed inside
`entity_update.glsl` every step and discarded. So this needs:

1. A **320-byte `Rule` output slot** in the pick result buffer (alongside the
   existing 4-byte key).
2. `entity_pick.wgsl` to *derive* the winner's rule — which means it must run the
   same `generate_random_centers` / `mutate_rule` path `entity_update` does. Both
   `#include "common.wgsl"`, so this is shared code, not a second copy.
   The winner is known only after the atomic resolves, so this is a **second tiny
   dispatch** (one invocation) that reads `best_key`, unpacks the index, derives
   that one entity's rule, and writes it. Do **not** try to write the rule from
   the losing threads — a thread that loses the atomic can still write afterwards,
   which is exactly why the current design keeps the index authoritative and
   nothing else in the result buffer.
3. `retrieve_pick()` maps 324 bytes instead of 4.

Net: one extra one-thread dispatch on click only, and `mutation.py`'s float32
discipline, the `pow` trap, and the GPU-vs-host probe test all cease to exist.
Selection latency stays one frame, which is already the design.

**Preserve the two ordering constraints** (they're why this works at all):
- The resolve runs at the **top of the frame, before** input can dispatch a new
  pick. Read-before-write.
- It runs in the **frame loop, not inside `advance()`** — `advance()` is skipped
  while paused, and clicking to select must still work when it is.
- A second click while one is pending **replaces** it, carrying its own click-time
  `before` state (last click wins).

Also update `docs/ARCHITECTURE.md`'s "Particle selection and history" section —
it currently documents the host-mirror approach as the design, and the deprecation
note on cohorts (`rule_seed` + `mutation_scale`) intersects this code.

---

## Step 7 — The command/status API and the thin UI

**DONE.** The engine is drivable from a browser UI. `Orchestrator` owns the
frame loop, the command bus and the status contract are typed, and a flat
Tweakpane dump of the registry drives all 35 settings. See `web/README.md`'s
"The Orchestrator" section for the design and the verification. Corrections to
what this section said, recorded because a later step would otherwise re-derive
them:

- **THE RETAINED-MODE FEEDBACK LOOP, which this section does not mention and
  which was the only real bug in the step.** Tweakpane fires `change` on every
  binding whose value moved when the app calls `pane.refresh()` — and it cannot
  distinguish a value the USER dragged from one the APP just pushed in. So
  loading a preset fed that preset's own values straight back through
  `edit_setting`: one `Next >` recorded **four** history entries (depth 1 → 5)
  and the undo stack read "edit Sensor Distance" instead of "load 9leafv8".
  Undo then stepped back through phantom edits rather than unloading the
  preset. **imgui cannot have this bug** — immediate mode reports a change only
  when the user moves something — so nothing in the desktop code or in this
  plan anticipates it. A `refreshing` flag guards every dispatching handler.
  **Step 10 inherits this the moment it binds anything retained.**
- **`_settings_dicts`'s closed-panel optimization is load-bearing here too, but
  for a different reason than the desktop's.** The desktop skips it to avoid
  `asdict` deep-copying the 80-float rule each frame. The port ALSO drops `rule`
  from the payload entirely, because no control binds to it — and the panel
  refreshes from that payload every frame, so carrying it would mean 80 floats
  compared per frame to decide nothing.
- **The status contract got stronger than "typed".** `Status` is a total
  interface with no optional members, so the compiler enforces at the one build
  site what `STATUS_KEYS` enforced by convention and a comment. Likewise the
  command `switch` has a `never` default arm, so adding a `Command` member
  without a handler is a build error rather than a silently ignored click.
- **Three commands are declared and answer honestly rather than being omitted.**
  `saveConfig` needs Step 9's storage, so it reports through `saveError` — which
  the panel already renders every frame — rather than pretending to succeed.
  Dropping it would have left Step 9 to discover the whole command path missing.
  `clearStrafeField` and the SHOVE/DRAW tools are the same case.
- **`sizingFor` returns a tuple, not a record.** Trivial, and worth a line
  because both call sites in the Orchestrator are `const [entityCount, dim] =`.
- **The desktop has no tests for `project.py` or `history.py`.** Python's
  `dataclasses.replace` always builds a new object, so the reference-identity
  contract cannot be violated there; TypeScript's spread has to be written
  correctly at each site. `project.test.ts` and `history.test.ts` are therefore
  new coverage, not ports — and they assert BOTH directions (a real edit must
  return a new object; a no-op must return the receiver), because each failure
  is silent and they look nothing alike.
- **`?nopanel` was added.** `browserCheck.mjs --shot` is how the visual A/B is
  taken, and a 320px panel over the right-hand third of the frame would change
  what those screenshots compare.
- **A known leak was left for Step 9, deliberately.** A disruptive preference
  change rebuilds the `ParticleSystem`, and the outgoing one's GPU buffers are
  never freed — `ParticleSystem` has no `destroy()` the way `Camera` does, and
  dropping a JS reference does not release GPU memory. ~19 MB per rebuild at
  600k entities, bounded because only World Size and Canvas Aspect reach that
  path and both are typed inputs committed on Enter. **Step 9 already touches
  this method** (the strafe field is canvas-sized, so a rebuild must resize it,
  which is why `_rebuild_system` calls `strafe_field.release()`), and the fix
  belongs in `ParticleSystem` rather than the Orchestrator. Fix it there.

The section as originally written follows.

The rewrite boundary is already an API. `ui/` imports **no** simulation module
(invariant 10 is enforced, not aspirational — `toolbar.py` mirrors `MouseMode` by
string value; `ui.py:384` duck-types to avoid importing `PickResult`). So:

- **Type the two untyped string interfaces.** The command dict (29 entries / 26
  handlers, `orchestrator.py:206-244`) and `STATUS_KEYS` (30 keys, `:518-539`)
  become discriminated unions. ARCHITECTURE.md already names this "the port's
  job."
- **Flatten the 7 orchestrator mixins into composition** — TS has no multiple
  inheritance. The MRO is currently load-bearing (`orchestrator.py:106-107`);
  make the cross-calls explicit dependencies instead.
- Port the frame loop (`orchestrator.py:256-365`) **exactly**, including the two
  ordering constraints in Step 6 and the fact that painting happens in
  `_apply_canvas_input` *above* the render because it binds its own target.
- Port `project/project.py` (141) and `history.py` (197) as-is — frozen
  dataclasses map cleanly to immutable JS updates. **`_record_history` guards on
  `before is not self.project` — reference identity.** `!==` works, but a spread
  copy anywhere in the chain silently breaks it. Coalescing (`(source, field)` key,
  0.5s window) and the two deliberate exclusions (hover-preview, undo/redo) come
  across unchanged.
- Port `preferences.py` (131) → `localStorage`. `load()` must never throw; drop
  unknown keys so a downgrade survives. Replace `_coerce`'s runtime dataclass
  field-type read with an explicit type map — `settings_spec`'s `kind` is already
  80% of one.
- **Thin UI:** a flat Tweakpane dump of `settings_spec` — bindings driven by
  `kind`/`lo`/`hi`/`options`, no tabs, no gates, no tooltips, no menus. Enough to
  drive the engine and nothing more.

**Milestone 1 ends here:** the engine runs in a browser at parity, drivable.

---

## Step 8 — Input, and the browser's opinions

`ui/input_state.py` (86 lines, 24 fields, frozen and rebuilt once per frame so
every consumer in a frame sees identical input) ports directly. What changes is
where capture is resolved.

**Keep the asymmetries — they were learned from how drags actually behave:**
- **Releases are never capture-filtered.** A button that went down on the canvas
  must be able to come up over a panel, or the drag never ends.
- **A drag belongs to whoever received the press.** `left_dragging` stays true
  while the cursor wanders over UI.
- Capture is resolved **once, at the event handler.** By the time input reaches
  `InputState`, plain fields already mean "meant for the canvas." **No consumer
  downstream checks a capture flag** — if you find yourself doing that, the
  filtering belongs upstream.

imgui gave capture arbitration free via `want_capture_mouse/keyboard`. The DOM's
model is genuinely different (hit-testing happens before your handler): use
`pointerdown` on the canvas + `document.activeElement` checks, and
`setPointerCapture` for drags.

**One-shot vs continuous stays split**, and for the original reason: `WASD` pan
and `Q/E` zoom read `keys_held` against `dt`, because routing them through the
hotkey table would make it one step per key-*repeat*, whose rate is an OS setting.

**Hotkey collisions — deferred by decision.** Build a **focus-aware rebindable
table** now; pick bindings later. The colliders on record:

| Desktop | Collides with |
|---|---|
| Ctrl+C / Ctrl+V (internal *checkpoint* stack, not the OS clipboard) | Browser copy/paste — `preventDefault` then breaks copying text out of Tweakpane fields |
| Ctrl+R (revert to saved) | Page reload |
| Ctrl+Z | Native undo inside any text input |
| Tab (camera mode) | DOM focus traversal — **worse than with imgui**, since Tweakpane is real focusable DOM |

The table must gate every app hotkey on "no editable element focused."

---

## Step 9 — Config storage and the Strafe Field

Two independent pieces of feature work.

**Storage (manifest + IndexedDB).** `persistence.discover()`
(`particle_system/persistence.py:339-367`) globs `configs/` for the "Core"
category and `iterdir()`s subfolders into their own categories. No browser can
enumerate a directory, so:
- A **build-time `manifest.json`** lists shipped presets and their categories,
  fetched read-only. Categories stay ordered Core-first then alphabetically.
- **IndexedDB** for user saves, under the same `(category, name)` key identity
  `ConfigEntry` already uses (`:331-334`) — that identity is already
  storage-agnostic, which is what makes this a swap rather than a redesign.
- Port the **v8 writer and reader only**. The `LEGACY COMPATIBILITY` v7 block is
  explicitly scoped for removal (`ARCHITECTURE.md` "Features scoped for removal")
  and **must not reach the port** — its spec is the v8 format alone.
  **All three shipped presets are v8** — re-saved during Step 4, and now named
  `Starcrossedv8.json`, `9leafv8.json` and `hatmanv8.json`. The port needs no
  conversion step and no temporary v7 reader. Step 4 reads them through
  `web/src/particleSystem/presets.generated.json`, emitted at build time by
  running the desktop's own `persistence.load()`; **Step 9 deletes that file,
  `defaultConfig.ts` and the generator's `build_presets` section** and replaces
  them with the manifest + IndexedDB path described here.
- Keep `sanitize_filename()` — it's still right for IndexedDB keys.
- **`snapshot_configs` returns a value synchronously** and `PreviewSession.begin()`
  depends on it (`ui.py:498-505` is the only path reading a command's return
  value). Under an async bus the session opens with a null snapshot and silently
  loses the restore. Small, contained — but it fails quietly, so handle it here.

**The Strafe Field** (`strafe_field/`, 233 lines + `strafe_draw.frag`, 98). One
RG16F texture at capped canvas shape (512² texels), painted by mouse, read every
physics step. Details that matter:
- **Painted once per rendered frame, never per sub-step** — inside the loop it
  would be `physics_steps`× stronger and stroke weight would track the physics
  rate.
- **Strokes are segments, not points** — distance-to-segment from last frame's
  cursor, or a fast drag breaks into dots. `_stroke_prev_uv` is that memory, and
  clearing it on release is what starts a fresh stroke.
- Erase disables blending and writes literal zero inside a hard radius,
  `discard` outside. Needs its **own pipeline** (Step 5).
- **Live-only**: never saved, never in history, `Clear Field` is the only reset.
- The Shove tool shares the brush but runs **inside** the physics loop, divided by
  `physics_steps` then multiplied by `steps/30` — the two factors cancel
  deliberately and must not be collapsed into a bare `/30`.

---

## Step 10 — Full UI/UX in Tweakpane

Now rebuild the interface properly on the proven engine. Tweakpane has folders,
tabs, bindings, blades, monitors and a plugin API — and critically, **nothing in
`ui/` uses immediate-mode drawing** (no `get_window_draw_list`, no `add_line`), so
its lack of a canvas costs us nothing.

`ui/settings_spec.py` (35 entries, 17 fields each) maps almost one-to-one onto
Tweakpane: `kind`/`lo`/`hi`/`options` → binding params, `group` → folders,
`tier` → visibility. **Adding a control stays a one-line registry entry.** Keep
`implemented=False` — currently zero entries use it, but it's the mechanism for
staging tab layout ahead of wiring.

The four custom widgets, in ascending difficulty:

**`hover_preview.py` (118) — ports verbatim.** Pure state machine, zero imgui.
The contract's tricky row is **click = commit** (drop the snapshot so closing
doesn't undo the selection); a naive implementation silently discards the user's
choice. `is_item_hovered()` per row → `mouseenter`/`mouseleave`. Keep **one
`PreviewSession` per surface** — a single shared snapshot slot was a real bug.
(Note `_preview_origin` is still one shared slot, safe today only because both
surfaces are submenus of the same menu bar; on the web, make it per-surface.)

**`curved_slider.py` (77) — easier in Tweakpane than in imgui.** It drives a
0..1 position slider and overrides the format string to display the real value —
a hack there, but idiomatic here as a bound proxy object with getter/setter doing
`value = lo + (hi-lo) * pos**curve`. **Only the position curves; the value never
does**, so what's stored, saved and shown is always the real number. One entry
uses it (`hazard_rate`, `curve=3.0`).

**`sensor_diagram.py` (174) — medium, and a whole bug class disappears.** The
shader-drawn diagram becomes an absolutely-positioned `<div>` with a canvas,
`pointer-events: none`. The desktop version needs an elaborate "a drag may sustain
but never summon" dance because imgui drops an active drag once its owner stops
being frontmost — **DOM z-order doesn't steal pointer capture, so the entire
`is_open` raise-order mechanism is unnecessary.** Work is mostly the WGSL port of
`tooltip_graphic.frag` (109 lines; note its `ANGLE_MODE`/`DISTANCE_MODE`/`time`
uniforms and `sd_arrow` are already dead — don't port them).

**`gated_controls.py` (226) — the hard one, and the one I want to talk about.**

This is the self-hiding checkbox/slider. Its load-bearing property: **on/off is
derived from the value itself, so nothing extra is stored** — which is what makes
save/load/undo/A-B-preview all work unchanged. That must survive. Six settings
use it, and two of them (`trail_diffusion`, base at `hi` **and** inverted;
`hazard_rate`, curved) exercise every composition.

The *visual* swap is easy in Tweakpane — keep both a checkbox blade and a slider
binding, toggle `.hidden`. The *session latch* is the problem: it currently rides
on `is_item_active()` / `is_item_deactivated()`, which have no Tweakpane
equivalent.

Good news: **retained mode actually makes this easier.** The desktop code needs
the fold-back to happen precisely at the closing edge because imgui drops a drag
whose widget stops being submitted; in the DOM, hiding a slider mid-drag doesn't
cancel anything (the element still exists, only `display` changed), so that whole
hazard mostly evaporates. Plan: `on('change', ev => ev.last)` for the drag edge
**plus** `pointerup`/`lostpointercapture` on the blade element — `ev.last` alone
is insufficient because a click that doesn't move the value fires no `change` at
all. Keep `position`/`value_at`/`is_off`/`nudged` verbatim; `gate_epsilon` in
**position** space is still the right definition (in value space, Hazard Rate's
cubed curve makes 0.01% of travel equal 1e-12).

**DECIDED: do not get stuck here.** If the latch fights Tweakpane, fall back to an
explicit disclosure triangle per gated setting — user-driven show/hide, with the
value-derived *default* state preserved. Slightly more clicking, none of the
inference. This is a UI-design concern that is cheaply reworked at a later stage;
it must not become a blocker. What is **not** negotiable is that on/off stays
derived from the value so nothing extra is stored — that property is what keeps
save/load/undo/preview working, and it is engine-adjacent, not cosmetic.

Also in this step: the menu bar and submenus → a menu component or Tweakpane
blades; the save dialog and delete modal → `<dialog>` (which gives
Escape-to-cancel free); the toolbar's 3 tool buttons; the Debug panel. Note the
save dialog's error handshake is **already async-safe** (it reads
`status['save_error']` every frame rather than once after dispatch) — don't
regress that. And the intended endpoint per ARCHITECTURE.md is that the active
tool **selects which controls are visible**, all in one panel — keep each window
body as a panel *section* function so that migration stays available.

---

## Verification

**Per-step, as noted above.** Steps 2 and 3 get unit tests (coordinate round-trips,
struct sizes/strides against the generated layout descriptor). Steps 4 and 5 get
the visual A/B.

**The A/B protocol** (per your decision — no numeric matching, no lockstep):

1. Run the desktop app: `Scratch.venv/Scripts/python.exe main.py`.
2. Load the same preset in both — start with `Starcrossedv8.json`, then
   `hatmanv8.json` and `9leafv8.json`. (All three are v8; the port reads v8
   only. `hatmanv8` is the one worth reaching for: 64 cohorts on a grid, so it
   exercises the cohort, spawn and per-cohort-mutation paths the other two
   leave untouched.)
3. Match world size, physics rate, camera mode, and display prefs. Reset both.
4. Run free and compare emergent character — structure, motion, how trails
   settle, how the population organizes.
5. Sweep the sliders that most change the result, Basic tier first (mutation scale
   leads it deliberately).

**Things worth A/B-ing specifically**, because they're where a plausible-looking
wrong answer hides:
- **Boundary modes.** Wrap / Bounce / Reset each need all four consumers to
  agree, and a half-implemented boundary looks like a physics quirk.
- **Non-square canvas aspect.** Verified working on desktop but with no runtime
  UI; a circle must stay a circle.
- **World size extremes** (0.25 and 4.0) — every force scales by
  `1/sqrt_world_size`, so the feel should survive the change.
- **Paused-state controls.** Color Sensitivity and Color By Cohort must re-colour
  a frozen frame with `frame_count` unchanged — that's why colour decisions live
  in the renderer, not in `entity_update`.
- **Motion blur brightness invariance.** Toggling blur or changing the sample
  count must not change overall brightness.

**Existing tests to carry across:** `tests/test_async_pick.py` (189 lines) asserts
the async pick chooses the same entity as the blocking one — port the *comparison*
even though `pick_blocking` itself doesn't port. `tests/test_pending_selection.py`
(160) covers the click-time-state and last-click-wins semantics. The GPU-vs-host
mutation probe becomes unnecessary once Step 6 lands.

**Done in Step 6**, with one correction: the *comparison* in `test_async_pick.py`
could not be ported, because it compares against `pick_blocking`, and there is
no second implementation on the web to disagree with. What ported is its
`check_key_packing()` (pure arithmetic → `pick.test.ts`, including the
`INDEX_MASK` bound against `sizingFor`, which exists for a real 20-bit bug).
Its GPU half is replaced by the browser cohort-identity check. All five groups
of `test_pending_selection.py` ported directly to `selection.test.ts`, plus two
the async readback makes necessary — "not ready yet" must not resolve, and
resolve must be a no-op when nothing is pending.

**Performance gate (Step 5 onward).** At default `physics_steps=30` each frame is
30 × 3 = **90 GPU passes** plus per-sample camera renders, 9 bloom passes and
assembly. WebGPU's per-pass encoder overhead is JS-side and meaningfully higher
than GL's — **this is the most likely place the port becomes slower than
desktop.** Measure early. Mitigations in preference order: batch sub-steps into
one encoder, then reduce the default rate, then consider merging the three
`advance()` passes. Note PARTICLES mode draws every entity with no culling.

---

## Settled decisions

Recorded so a later agent doesn't reopen them.

| Decision | Resolution |
|---|---|
| Fidelity verification | **Visual A/B**, no numeric golden vectors, no lockstep. The dynamics are sensitive enough to judge by eye |
| `mutation.py` float32 mirror | **Not ported — DONE in Step 6.** The picked entity's rule is read back from the GPU. The result slot is 336 bytes (not 324: alignment padding, which the position rides in for free) and the extra one-thread dispatch measured free |
| Config storage | **Build-time manifest + IndexedDB**, same `(category, name)` key identity |
| Milestone 1 scope | **Engine-first, thin UI** — flat Tweakpane dump of the registry, no tabs/gates/tooltips/menus. **DONE in Step 7**, exactly as scoped: Tweakpane 4, `group` as a plain folder, `tier` as one checkbox, and `revealsOn`/`gates`/`curve`/`inverted` carried in the registry but not rendered |
| Gated controls | Real latch preferred; **disclosure-triangle fallback is pre-approved** rather than a blocker (Step 10) |
| Shipped presets | **Done.** All three are v8 (`Starcrossedv8`, `9leafv8`, `hatmanv8`); the port reads v8 only, no legacy path |
| Hotkey collisions | **Deferred.** Build the focus-aware rebindable table (Step 8); choose bindings once the UI exists |

## Open questions

1. **Cohorts.** ~~`cohorts` + `rule_seed` + `mutation_scale` are marked a
   deprecation candidate in `ARCHITECTURE.md`...~~ **ANSWERED: ported as-is,**
   which was the stated default. Step 6 touched `get_cohort` (it takes the
   entity count as a parameter now, so `rule.wgsl` can be shared between the
   update and the pick shaders) but changed nothing about what a cohort *is*.
   Migrating to N pre-populated config slots remains separate work — and note
   that cohort identity is now the **verification handle** for GPU rule
   derivation: two entities in one cohort must derive bit-identical rules, two
   in different cohorts must not. See `web/README.md`.
2. **Physics rate default.** ~~If 90 passes/frame is the perf cliff, is a lower
   default rate on the web acceptable, or should sub-step batching be done
   properly first?~~ **ANSWERED by Step 5's measurement: neither is needed.**
   The default rate of 30 holds 54–56 fps in every configuration except
   PARTICLES with 10 blur samples (44 fps), and **encode time is under 0.4 ms
   throughout** — about 2% of the frame. The premise was that WebGPU's JS-side
   per-pass overhead would dominate; it does not. Sub-step batching is already
   done (`runFrame` opens one encoder for the whole frame), and merging the
   three `advance()` passes would target a cost that is not there. Keep 30.

   What to watch instead, if a cliff ever appears, is the **PARTICLES draw**:
   600k instances with no culling, times the blur sample count. That is the only
   row that leaves 60 fps and the only one whose cost scales with a user-facing
   slider. Measured on one machine at 1264×649 — a lower-end GPU or a 4K window
   would move these numbers, and the measurement protocol is in `web/README.md`
   so the comparison stays like-for-like.
