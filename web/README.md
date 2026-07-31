# Fluoddity — WebGPU port

The TypeScript/WebGPU port of the Python app in the parent directory. The plan
is `docs/WEB_PORT_PLAN.md`; the design contract it must honour is
`docs/ARCHITECTURE.md`, whose 10 invariants are the spec.

**Status: Steps 1–5 of 10 complete.** Scaffold, device acquisition, canvas
sizing, the WGSL `#include` resolver, the pure-math leaves, `common.wgsl`,
**the engine** (`entityUpdate.wgsl`, `canvas.wgsl`, `brush.wgsl`, driven by
`src/particleSystem/particleSystem.ts`) and **the render pipeline**: both camera
modes, motion blur, bloom, brightness and the tone curve.

**The simulation runs, and it looks right.** 600,000 entities, 30 sub-steps a
frame, at parity with the desktop app — verified by loading the same preset in
both, running to the same sub-step count, and comparing the canvas (see
"Verification" below).

There is still no picking (Step 6); no UI, no input and no preferences UI
(Steps 7–10); no strafe field (Step 9). The overlays' shader code and uniform
lanes are in place but their state is hardcoded off — Step 8 supplies the
cursor, Step 9 the field texture.

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
the resolved blur schedule, ms/frame, encode time and per-pipeline compile
status. Worth having open whenever you are judging the simulation: a pipeline
that failed to build leaves a black canvas, which is also what a *correct*
Step 1–3 build looks like.

### URL parameters

Step 7 builds the real command/status API and Step 8 real input. Until then
these exist so every part of the render pipeline is reachable for an A/B
without a code edit. They are cheap to keep and cheap to delete.

| Parameter | Effect |
|---|---|
| `?preset=<stem>` | Load a shipped preset by filename stem |
| `?camera=trail\|particles` | Camera mode. **The mode toggle is a test** — see below |
| `?zoom=<z>`, `?pan=<x>,<y>` | Camera transform, since there is no input yet |
| `?physicsSteps=<n>` | Sub-steps per frame (the desktop's Physics Rate) |
| `?motionBlurSamples=<n>` | Target sample count. 1 is off |
| `?brightness=<b>`, `?tonemapSoftness=<s>` | Exposure and highlight compression |
| `?bloom=1`, `?bloomThreshold=`, `?bloomIntensity=`, `?bloomRadius=` | The bloom chain |
| `?colorByCohort=1`, `?colorSensitivity=<s>` | Palette, normally per-config |
| `?reticle=<radius>`, `&dashed` | Force the brush reticle on at canvas centre |

Two of these earn their keep beyond convenience:

- **`?camera` is the flip test.** The two modes walk the same transform in
  opposite directions, so switching between them must not shift or mirror the
  image (`camera.py:14-18`). If it does, a Y flip is wrong.
- **`?colorByCohort` and `?reticle` reach code nothing else does.** All three
  shipped presets set `colorByCohort` false, and there is no cursor until
  Step 8 — so without these, `col_params.y`, the flat interpolation and the
  dashed ring's arc arithmetic would ship unexercised until Step 10.

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
still being hoisted, the quad permutations, and the Y flips (see below). See
the three `shaders.test.ts` files under `src/*/shaders/`.

For actual compilation there is `tools/browserCheck.mjs`, which drives a real
headed Chrome over CDP, loads the page and reports the console:

```
node tools/browserCheck.mjs                                  # with npm run dev running
node tools/browserCheck.mjs --url "?debug&camera=particles"
node tools/browserCheck.mjs --url "?debug&bloom=1" --shot out.png
```

It exits non-zero if any pipeline failed or the page logged an error, and
`--shot` saves a screenshot — which is how the visual checks below were made.
It is a **development** tool, not part of `npm test`: it needs a real GPU, a
real Chrome and a dev server, none of which belong in CI. Eight modules should
report success.

**The two tools cover different halves and neither substitutes for the other.**
WGSL forbids implicit-derivative sampling (`textureSample`, `fwidth`) outside
uniform control flow, and Step 5 hit that twice — `camera.wgsl`'s letterbox
early-out and `frameAssembly.wgsl`'s field sample. Those are hard compile
errors, but only in a browser, so the Node suite would never have seen them.

## Layout

| Path | Role |
|---|---|
| `tools/wgslInclude.ts` | The `#include` resolver + its Vite plugin |
| `tools/generate_web_data.py` | Emits the generated JSON below |
| `tools/browserCheck.mjs` | Drives a real Chrome over CDP; the only thing that compiles WGSL |
| `src/gpu/` | Stateless GPU helpers — the `shared/` analogue (invariant 1) |
| `src/app/` | Canvas surface and sizing; `renderTargets` (the HDR and accumulation buffers) |
| `src/particleSystem/` | The simulation: the pure leaves (`coords`, `sizing`, `config`, `pack`, `layout`, `dispatch`), `uniforms`, and `particleSystem.ts` |
| `src/particleSystem/shaders/` | The engine — `entityUpdate.wgsl`, `canvas.wgsl`, `brush.wgsl` (invariant 6) |
| `src/camera/` | `cameraState` (pan/zoom/mode), `blurSchedule` and `cameraUniforms` (pure leaves), and `camera.ts` |
| `src/camera/shaders/` | `camera.wgsl` (TRAIL), `camBrush.wgsl` (PARTICLES), `accumulate.wgsl` |
| `src/assembler/` | `bloomChain` and `assemblerUniforms` (pure leaves), `bloom.ts`, `assembler.ts` |
| `src/assembler/shaders/` | `bloomDownsample.wgsl`, `bloomUpsample.wgsl`, `frameAssembly.wgsl` |
| `src/prefs/` | Display preferences. **Minimal** — Step 7 adds load/save |
| `src/testing/` | Test-only access to the parity goldens |
| `src/shaders/` | Shared shaders — `common.wgsl`, `fullscreenQuad.wgsl` |

Every module that imports a `.wgsl` file is untestable under `node --test`,
because `#include` resolution is a Vite plugin. That is why each has a pure leaf
beside it (`blurSchedule`, `bloomChain`, `dispatch`, the uniform packers): the
arithmetic stays testable without a browser.

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

**Nothing in the render pipeline flips.** The canvas is stored top-left-origin,
so sampling it straight puts world +y at the top of the screen. The rule is
worth stating as a rule, because it has bitten twice and the two halves sound
contradictory:

> **Rasterizing INTO the canvas → flip. Sampling the canvas TO the screen → no
> flip.**

`camBrush.wgsl` is the case that looks wrong and is not. It mirrors
`brush.wgsl` in almost every respect *and does not negate y*, because the
difference is the **target**, not the shader: `brush` writes into the canvas
texture (read back through y-up `world_to_uv`, hence the correction), while
`camBrush` writes into the HDR screen target, whose only correctness partner is
`camera.wgsl` walking the same transform backwards from an unflipped quad. The
two camera modes agree exactly when neither flips.

**That agreement is the test, and it is free:** switch `?camera=trail` to
`?camera=particles` and watch whether the structure jumps. It must not
(`camera.py:14-18`). `shaders.test.ts` asserts the absence of the flip too,
since the failure — PARTICLES mirrored relative to TRAIL — is easy to miss on a
roughly symmetric field.

### Expect divergence, not bit-exactness

WGSL permits the same FMA contraction GLSL does (`PORT_AUDIT.md:743`), and the
browser's compiler need not fuse the same multiply-adds the desktop driver does.
`hash()` is chaotic, so a 1-ULP difference in one generated rule coefficient
produces a *completely different rule* — the same trap
`entity_update.glsl:446-451` documents for the host-side mirror.

**So two runs of the same preset diverge into different-but-statistically-
identical behaviour, and that is expected.** It is exactly why the plan chose
visual A/B over golden vectors. Judge emergent character, not trajectory.

## The render pipeline

Everything from "the simulation advanced" to "pixels on screen". **Order is
load-bearing: everything before the tone curve is linear, and the curve runs
exactly once, at the end.**

```
Camera                                Assembler
  TRAIL      canvas -> RGB, colorized   bloom       threshold, 5 mips down, tent up
  PARTICLES  instanced sprites          brightness  linear exposure
  accumulate acc += sample/N            tone curve  asinh, linear -> display
                                        overlays    field, reticle  (AFTER the curve)
```

Three things about this are easy to get wrong and are worth knowing:

**The tone curve acts on the colour's LENGTH, not per channel.** Per-channel
would desaturate bright regions toward white as each channel compressed
independently; acting on the length preserves hue and saturation. `asinh` is not
a WGSL builtin — the helper is `log(x + sqrt(x*x + 1.0))`, which is only asinh
for non-negative input, so the *host* clamps `tonemapSoftness` to `>= 0`
(`preferences.py` enforces no lower bound).

**`inv_samples` must be the achieved sample count, never the requested one.**
`blurSchedule` returns both because they disagree whenever the request does not
divide the physics rate — at 100 steps a request of 8 yields 9 samples. Weighting
by the request darkens the frame by that ratio, at some slider positions and not
others. This is the one part of Step 5 that gets numeric goldens
(`_parity_blur`, 64 cases) precisely because the visual A/B cannot catch a few
percent of brightness.

**The bloom upsample must `loadOp: 'load'`.** moderngl simply does not clear, so
the GLSL has nothing to say about it; WebGPU makes the choice explicit. A
`'clear'` discards the entire down-chain and leaves only the smallest mip — not
a blank screen, but a plausible, slightly-too-diffuse glow that reads as "the
radius is too big".

### Performance

The port plan flags 90 GPU passes per frame as the likeliest place the web
becomes slower than the desktop, and names **JS-side encoder overhead** as the
suspected cause. Measured, at 1264×649, `Starcrossedv8`, `physicsSteps=30`,
after settling — the `?debug` readout reports both:

| Camera | Bloom | Samples | Frame | Encode |
|---|---|---|---|---|
| trail | off | 1 | 17.7 ms (56 fps) | 0.27 ms |
| trail | on | 1 | 18.6 ms (54 fps) | 0.29 ms |
| trail | on | 10 | 18.5 ms (54 fps) | 0.35 ms |
| particles | off | 1 | 18.3 ms (55 fps) | 0.32 ms |
| particles | on | 1 | 18.4 ms (54 fps) | 0.33 ms |
| particles | on | 10 | 22.7 ms (44 fps) | 0.38 ms |

**Encode time is under 0.4 ms in every configuration — about 2% of the frame.
The port is not encoder-bound, and the plan's suspicion does not hold here.**
The rest is GPU work. That changes which mitigations are worth anything:
batching sub-steps into one encoder is already done and merging the three
`advance()` passes would buy almost nothing, because pass *recording* is not
what costs. If the rate ever needs to come down it will be for GPU reasons.

Bloom costs ~1 ms. The worst row — PARTICLES with 10 blur samples, i.e. ten
600k-instance additive draws with no culling — is the only one to leave 60 fps,
and it is the row to watch if a cliff ever appears.

One measurement artefact worth recording, because it looked alarming: the first
bloom reading was **3 fps at frameCount 150**. That was startup transient — the
mip chain allocates lazily on the first `process()` and the pipelines were still
warming. Sweeping `physicsSteps` 1/10/20 all held 60 fps with bloom on, which is
what localised it to startup rather than to the chain. Measure after settling.

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

  The **camera's** uniforms deliberately do *not* do this. It looks like the
  same situation — `render()` is called N times inside one encoder — but nothing
  the camera reads varies per sample: `inv_samples` is fixed for the cycle, and
  pan, zoom and both resolutions cannot change mid-frame. One write in
  `beginFrame()`, before the encoder opens, covers the whole frame.
- **The accumulator is cleared by a zero-draw render pass.** Clearing needs an
  encoder and `beginFrame()` runs before one exists, so the desktop's
  "clear once per cycle" (`camera.py:150-153`) cannot happen there. The
  alternative — branching `loadOp` on the first sample — would reintroduce
  exactly the special case that comment is proud of having removed. One empty
  pass against 100+ is the better trade, and it keeps the clear and `result()`'s
  guard decided by the same variable in the same place.
- **`textureSampleLevel` everywhere in the fragment stages**, not just the
  compute one. WGSL forbids implicit-derivative sampling in non-uniform control
  flow, and two sites are exactly that: `camera.wgsl`'s letterbox early-out and
  `frameAssembly.wgsl`'s field sample (guarded by the per-fragment `inside`).
  No mips exist, so level 0 is numerically identical.
- **The per-sub-step uniform buffers grow with the physics rate.** They hold one
  slice per sub-step and `physicsSteps` is a live preference, so raising it past
  the allocated count would walk off the end — reported as an out-of-bounds
  dynamic offset, which invalidates the whole command buffer and freezes the
  screen rather than degrading. `ensureUniformCapacity` grows them and never
  shrinks, so dragging a slider across a threshold does not thrash. The desktop
  has no equivalent because it sets a uniform per sub-step and allocates nothing.
