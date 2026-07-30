# Fluoddity — WebGPU port

The TypeScript/WebGPU port of the Python app in the parent directory. The plan
is `docs/WEB_PORT_PLAN.md`; the design contract it must honour is
`docs/ARCHITECTURE.md`, whose 10 invariants are the spec.

**Status: Steps 1–4 of 10 complete.** Scaffold, device acquisition, canvas
sizing, the WGSL `#include` resolver, the pure-math leaves, `common.wgsl`, and
**the engine**: `entityUpdate.wgsl` (the physics), `canvas.wgsl` (trail decay
and diffusion) and `brush.wgsl` (the splat), driven by
`src/particleSystem/particleSystem.ts`.

**The simulation runs.** 600,000 entities, 30 sub-steps a frame, at parity with
the desktop app — verified by loading the same preset in both, running to the
same sub-step count, and comparing the canvas (see "Verification" below).

There is still no camera, no bloom, no tone curve and no overlays (Step 5); no
picking (Step 6); no UI and no input (Steps 7–10). What puts pixels on screen
today is `src/app/debugPresent.wgsl`, a deliberately minimal present pass that
Step 5 deletes.

## Running it

Requires Node 20+ (developed against v24.18.0) and a WebGPU-capable browser —
current Chrome or Edge, or Safari 26+.

```
npm install
npm run dev        # dev server at http://localhost:5173
npm run dev -- --open  # ...and open it
npm test           # unit tests
npm run typecheck  # tsc --noEmit, strict
npm run build      # typecheck + production build
```

Add `?debug` to the URL for a readout of frame count, entity count, canvas size,
ms/frame and per-pipeline compile status. Worth having open whenever you are
judging the simulation: a pipeline that failed to build leaves a black canvas,
which is also what a *correct* Step 1–3 build looks like.

### Switching presets

`?preset=<name>`, by filename stem — no rebuild, no code edit:

```
http://localhost:5173/?preset=hatmanv8
http://localhost:5173/?debug&preset=9leafv8
```

An unknown name falls back to the default and logs the available ones, so a typo
never looks like a broken engine. The default is `Starcrossedv8`, matching the
desktop's own default at `particle_system.py:45`, so both halves of an A/B start
on the same config without anyone having to pick it.

**Adding a preset that isn't shipped yet** takes two steps, because the browser
cannot read `configs/` — the presets are baked in at build time:

1. Put the `.json` in `configs/` (v8 only) and add its filename to
   `_PRESET_FILES` in `tools/generate_web_data.py`.
2. Regenerate: `../Scratch.venv/Scripts/python.exe tools/generate_web_data.py`

The generator loads each file through the desktop's own `persistence.load()`, so
a missing file or a v7 file fails there with a message rather than reaching the
browser. **This whole mechanism is temporary** — Step 9 replaces it with a
manifest plus IndexedDB and a real loader, at which point presets are picked in
the UI and none of the above applies.

### Checking that the shaders still compile

Nothing in `npm test` compiles WGSL — that needs a real device, and **headless
Chrome returns a null adapter**, so it cannot be automated in CI. What the suite
does cover is the class of error a compiler would not catch: binding numbers,
the workgroup size matching the host's dispatch, the `textureDimensions` hoist
still being hoisted, and the two Y flips (see below). See
`src/particleSystem/shaders/shaders.test.ts`.

For actual compilation, run `npm run dev`, open the page and read the console:
`compileModule` logs each module by name, and `main.ts` prints a summary line
listing any pipeline that failed. Four modules should report success.

## Layout

| Path | Role |
|---|---|
| `tools/wgslInclude.ts` | The `#include` resolver + its Vite plugin |
| `tools/generate_web_data.py` | Emits the generated JSON below |
| `src/gpu/` | Stateless GPU helpers — the `shared/` analogue (invariant 1) |
| `src/app/` | Canvas surface and sizing |
| `src/particleSystem/` | The simulation: the pure leaves (`coords`, `sizing`, `config`, `pack`, `layout`, `dispatch`), `uniforms`, and `particleSystem.ts` |
| `src/particleSystem/shaders/` | The engine — `entityUpdate.wgsl`, `canvas.wgsl`, `brush.wgsl` (invariant 6) |
| `src/camera/` | `cameraState` — pan/zoom/mode, no GPU |
| `src/testing/` | Test-only access to the parity goldens |
| `src/shaders/` | Shared shaders — `common.wgsl` |

## Generated data

Three JSON files are produced by Python and **committed to git**:

| File | Contents |
|---|---|
| `src/particleSystem/layout.generated.json` | Struct sizes, member offsets, float-lane indices, parsed out of `common.glsl` |
| `tools/parity.generated.json` | Golden values produced by *calling* the desktop Python functions |
| `src/particleSystem/presets.generated.json` | The shipped presets, as `persistence.load()` returns them. **Temporary** — Step 9 replaces it with a manifest plus IndexedDB and deletes it |

They are committed because a browser build cannot shell out to Python and
`npm run build` must work from a clean checkout with no venv. A committed
artifact also makes a struct change visible in the diff, next to the `.glsl`
edit that caused it.

Regenerate after editing `shared/shaders/common.glsl`:

```
../Scratch.venv/Scripts/python.exe tools/generate_web_data.py
npm run gen:web-data:check    # exits non-zero if the committed files are stale
```

The `npm run gen:web-data` script assumes a `python` with numpy on PATH; the
repo's only such environment is `Scratch.venv`, so the explicit interpreter path
above is the reliable form.

`particle_system/layout.py` is **not** ported to TypeScript. Shader hot-reload
is gone (invariant 5), so a runtime parser has no job, and a second
implementation of a strict parser is a second thing that can be subtly wrong.
`src/particleSystem/layout.ts` is a descriptor *reader* with assertions — most
importantly `assertLaneMap`, which fails loudly if a `vec4` is added to
`ConfigData` without the lane table in `config.ts` following. That failure would
otherwise be silent: every lane after the insertion point shifts by four floats
and the physics just goes subtly wrong.

## `common.wgsl` and the two-copy layout hazard

`src/shaders/common.wgsl` is the WGSL translation of
`shared/shaders/common.glsl` (Step 3). It holds the GPU structs, the `cfg_*` /
`world_*` / `e_*` accessors, and the coordinate math — and every shader from
Step 4 onward `#include`s it.

**Struct layout is now hand-authored in two files.** `common.glsl` is what the
Python parser reads to emit `layout.generated.json`, which is what the host
packs against; `common.wgsl` is what the GPU reads. A divergence between them
does not crash and does not error — the host packs 416 bytes to one plan and
the shader reads them to another, and the simulation is just subtly wrong.

`src/shaders/common.wgsl.test.ts` closes that loop. It scans the struct
declarations out of `common.wgsl` and asserts names, order, types, the
`array<FourierCenter, 10>` shape and the vec4-only rule against the descriptor.
It is the shader-side counterpart of `assertLaneMap`: that one guards host
packing against the descriptor, this one guards the shader against it. Its
scanner deliberately **throws on any member it cannot parse** rather than
skipping it — a scanner that quietly ignored a member would pass while the
layout drifted.

Three translation decisions worth knowing before editing the file:

- **`make_entity` was renamed on one overload.** WGSL has no function
  overloading, so the 4-arg colourless form is `make_entity_reset`. It still
  delegates to the 5-arg form with a zero colour.
- **`world_bounce` returns a `BounceResult`** instead of taking `inout`
  parameters. The velocity flips are decided against the *pre-fold* position;
  reordering that changes the exact-boundary case.
- **`edge_fold` uses `%`, `world_wrap` keeps `fract`.** GLSL's `mod` is floored
  and WGSL's `%` is truncated, so they are not interchangeable. `%` is safe in
  `edge_fold` because the dividend is `abs(x)` — non-negative by construction,
  not by caller convention. `world_wrap`'s argument is freely signed, so
  rewriting its `fract` as `%` would break wrap at the left and bottom edges.

## The engine, and the two Y flips

**OpenGL's framebuffer origin is bottom-left; WebGPU's is top-left.** The GLSL
therefore needs no flip anywhere, and the port needs one in *every* stage that
rasterizes into the canvas:

- `brush.wgsl` negates NDC y, because it writes through `world_to_ndc` while
  `get_can` reads through `world_to_uv` — the same mapping up to scale, and both
  Y-up. Without the negation the splat lands in the mirrored row from the one
  the sensor reads back.
- `canvas.wgsl`'s fullscreen quad flips v, because each fragment must read the
  texel it is about to write.

Both were originally wrong, and **neither looked like an upside-down picture.**
The canvas is a feedback loop, so reading the mirrored row makes the decay and
the 5-tap diffusion operate on a mirror of the trail field: measured as ~3×
less canvas energy by sub-step 3, and dynamics that settled into many small
curls instead of large sweeping arcs. It reads as "the physics is different",
which is the hardest kind of bug to attribute. `shaders.test.ts` asserts both.

`debugPresent.wgsl` deliberately has **no** flip — the canvas is already stored
top-left-origin, so sampling it straight puts world +y at the top of the screen.

### Expect divergence, not bit-exactness

WGSL permits the same FMA contraction GLSL does (`PORT_AUDIT.md:743`), and the
browser's compiler need not fuse the same multiply-adds the desktop driver does.
`hash()` is chaotic, so a 1-ULP difference in one generated rule coefficient
produces a *completely different rule* — the same trap
`entity_update.glsl:446-451` documents for the host-side mirror.

**So two runs of the same preset diverge into different-but-statistically-
identical behaviour, and that is expected.** It is exactly why the plan chose
visual A/B over golden vectors. Judge emergent character, not trajectory.

## Verification: the A/B against the desktop

Step 4's fidelity was checked by running both engines to the *same sub-step
count* and comparing, rather than by eye alone:

1. **The desktop, headless.** `ParticleSystem` runs standalone under
   `moderngl.create_context(standalone=True)`, so it can be advanced N steps and
   its canvas read with `current_canvas_texture().read()` — no window needed.
2. **The port, in a real browser** over CDP (headless returns a null adapter),
   importing `/src/particleSystem/particleSystem.ts` so it drives the real
   class, then reading the canvas back with `copyTextureToBuffer`.
3. Colorize both with `camera.frag`'s own formula and compare.

`currentCanvasTextureObject()` and `entityBufferForReadback()` exist for this;
nothing in the app calls them, and both textures/buffers carry `COPY_SRC` for
the same reason.

Results at the time of writing, all three presets, canvas |value| mean:

| Preset | Sub-steps | Desktop | Port |
|---|---|---|---|
| Starcrossedv8 | 5 | 0.00008291 | 0.000083 |
| Starcrossedv8 | 13230 | 0.000874 | 0.001049 |
| hatmanv8 | 3000 | 0.000937 | 0.000928 |
| 9leafv8 | 3000 | 0.000305 | 0.000330 |

Early sub-steps agree to 3–4 significant figures (the entity buffer matched at
sub-step 1 to 4 figures, before any sensor has data); later ones agree in
magnitude and character while diverging in placement, per the FMA note above.
`hatmanv8` is the valuable one — 64 cohorts on an 8×8 grid, so it exercises
`get_cohort`, `initial_position`'s GRID branch and the per-cohort mutation that
the two single-cohort presets leave untouched.

## Parity testing

Step 2's tests check against values generated by running the real Python, not
hand-copied ones. This is not in tension with the plan's "visual A/B, not golden
vectors" decision — that decision is about *the dynamics*, which are chaotic.
Step 2 is deterministic arithmetic, and the plan explicitly asks to check
`sizing.ts` against the Python's values.

The goldens catch what round-trip tests cannot: a round-trip checks the port
against itself, so an error made consistently in both directions still closes
perfectly. The strongest single assertion is a byte-exact hex comparison of a
packed 416-byte `ConfigData` record — one equality covering all 104 lanes, the
rule copy, the bit-punned int lanes and the reserved-lane zero-fill at once.

## The shader preprocessor

WGSL has no `#include`, so `tools/wgslInclude.ts` does the text substitution at
build time — a port of `shared/gl_utils.py:22-70`. This exists so `common.wgsl`
can stay a single hand-authored source of truth for struct layout (invariant 8);
the reference implementation duplicated its structs with a "SYNCHRONIZED"
comment and they drifted anyway.

Semantics match the Python: the include guard keys on the **resolved absolute
path** and is marked *before* recursing (which is what makes cycles terminate),
and lookup is **sibling-of-the-includer first, then `sharedDir`** — the rule
that will let each module keep its own shader directory as the port grows.

Two differences from the desktop, both deliberate:

- **A missing include fails the build.** In Python it is caught and downgraded
  to a printed message, because it happens at runtime where there is a previous
  program to keep. Here it happens at build time, where there is nothing to
  degrade into. Invariant 5's non-fatal rule still applies — to *compilation*,
  which on the web is a separate stage (`src/gpu/shaderModule.ts`).
- **WGSL compile errors are asynchronous**, via `compilationInfo()`, so the
  try/except becomes a promise chain, and a module that failed to compile is
  still returned as an object. Failure is decided by inspecting messages for
  `type === 'error'`, not by catching.

Error line numbers refer to the *expanded* source. The
`// ==== begin include: name ====` banners the resolver emits are what maps a
line number back to the file it came from.

## Naming

`window_size` and `canvas_size` are carried over verbatim from the Python and
mean what they mean there, which is mildly counterintuitive in a browser:

- `canvas_size` is the **simulation texture**, not the `<canvas>` element.
- `window_size` is the **framebuffer** in device pixels — `canvas.width/height`,
  not `clientWidth/clientHeight` and not the browser window.

They were not renamed because Steps 2–5 are mechanical translations of
`coords.py` and `common.glsl`, and diverging the vocabulary would break that
correspondence. See the header of `src/app/surface.ts`.

Field names are the one place the port deliberately breaks that correspondence:
Python's `snake_case` becomes `camelCase` (`sensor_gain` → `sensorGain`). The
persistence step will need an explicit mapping at the file boundary — but it
would have needed one anyway, since the saved format uses a *third* set of names
again (`sensor.gain`, `force.global_mult`).

## Known divergences from the desktop

Deliberate, and each is commented at the site:

- **`canvasDimensions` rounding.** Python's `round()` is half-to-even;
  `Math.round` is half-up. They differ only when `dim * sqrt(aspect)` lands
  exactly on `.5`, which `aspect = (1024.5/1024)²` does. Accepted rather than
  worked around: `CANVAS_ASPECT` is 1.0 with no runtime UI, so no tie is
  currently reachable. Revisit if aspect ever becomes a control.
- **`setZoom` rejects a non-finite zoom.** Python's `max`/`min` absorb NaN into
  `MAX_ZOOM` by accident; JavaScript's propagate it, which would break the
  camera permanently and silently. The port refuses the update instead — a third
  behaviour, chosen because clamping a NaN to maximum magnification is not
  obviously better than ignoring it.
- **`WorldConfig.as_uniform_value()` is not ported.** It exists only to feed
  moderngl's per-member `tryset`, which has no WebGPU analogue. `WorldData`
  becomes a real uniform buffer written from `packWorldConfig`.
- **The `HARD_FENCE` branch is not ported.** `entity_update.glsl:552-556` guards
  a "leaving the fence is fatal" variant behind an `#ifdef` whose `#define` is
  commented out at `:551` and set by no host path. WGSL has no preprocessor, so
  only the live `#else` soft fence was translated. The GLSL keeps the hard
  version deliberately — "a genuinely different look, not a fallback" — so the
  port comments where to find it rather than pretending it never existed.
- **`normalized_fourier_noise` and `random_fourier_noise` are not ported.**
  Neither has a caller; `generate_random_centers` is invoked directly.
- **`select()` is not used where GLSL used `?:` around a singularity.**
  `safenorm` and the radial-gravity direction stay `if`/`else`, because GLSL's
  ternary evaluates one branch while WGSL's `select()` is a function call that
  evaluates *both* — and the discarded branch is `normalize(vec2(0))` or a
  divide by zero. Discarding a NaN is fine on paper and a coin-flip once a
  compiler may contract around it.
- **Per-sub-step uniforms ride a dynamic offset.** `queue.writeBuffer` cannot be
  interleaved with an open encoder's passes, and `advance()` runs 30× inside one
  encoder, so all 30 sub-steps' uniforms are written up front into one buffer
  and each pass binds its own 256-byte-aligned slice. The desktop just sets a
  uniform per sub-step.
