# Fluoddity

A GPU particle simulation in TypeScript and WebGPU: 600,000 entities driven by a
Fourier Feature Network, painted into a trail field, with a bloom and tone-curve
pipeline over the top.

> **History.** This began as a port of a Python/moderngl desktop app, which
> served as its executable spec. The port is complete and the Python app has
> been removed — this is now the whole project. Comments throughout cite Python
> files (`persistence.py:128`, `camera.py:14-18`); see
> [Reading the Python citations](#reading-the-python-citations) below.

## What is here

Scaffold, device acquisition, canvas sizing,
the WGSL `#include` resolver, the pure-math leaves, `common.wgsl`, **the
engine** (`entityUpdate.wgsl`, `canvas.wgsl`, `brush.wgsl`, driven by
`src/particleSystem/particleSystem.ts`), **the render pipeline** (both camera
modes, motion blur, bloom, brightness and the tone curve), **picking**
(`entityPick.wgsl`, with the rule derived on the GPU), **the Orchestrator**
— the frame loop, a typed command/status API, project/history/preferences —
**input**: pointer, wheel and keyboard, with capture resolved at the handler and
a focus-aware hotkey table — **the Strafe Field and config storage**: a painted
vector field with its Shove counterpart, and shipped presets fetched from a
build-time manifest with user saves in IndexedDB — and **the full UI**
(`src/ui/panel.ts`): sections and collapsible groups, curved and inverted
sliders, self-hiding gated controls, reveal gating, a menu bar with
browse-by-hover load and checkpoint lists, and native `<dialog>` save and delete
modals.

600,000 entities at 30 sub-steps a frame. This was verified against the
reference implementation while it existed, by loading the same preset in both,
running to the same sub-step count and comparing the canvas (see "Verification"
below).

**One feature the reference had and this does not: the pinned sensor diagram.**
The desktop drew a small animated picture of a particle and its two sensors
while you hovered Sensor Angle or Sensor Distance (`ui/sensor_diagram.py`); here
those two sliders get the same rich text tooltip every other setting gets.
Nothing depends on it, and the decisions for building it later — Canvas2D rather
than WGSL, and the `sensorTooltipDiagram` preference it would need — are
recorded in `docs/history/WEB_PORT_PLAN.md` under Step 10.

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

**Step 7 deleted most of these**, and that is the point: every display
preference is now a real control in the panel, so a query parameter that sets
one is a second way to do the same thing. What survives is the set
`browserCheck.mjs` needs — its only lever is the URL, so anything an automated
check must reach before the first frame has to be here.

| Parameter | Effect |
|---|---|
| `?debug` | The timing/pipeline readout overlay |
| `?preset=<stem>` | Load a shipped preset by filename stem |
| `?camera=trail\|particles` | Camera mode. **The mode toggle is a test** — see below |
| `?zoom=<z>`, `?pan=<x>,<y>` | Camera transform, set before the first frame |
| `?nopanel` | Suppress the Tweakpane panel |

- **`?camera` is the flip test.** The two modes walk the same transform in
  opposite directions, so switching between them must not shift or mirror the
  image (`camera.py:14-18`). If it does, a Y flip is wrong. Also reachable from
  the panel's Toggle Camera Mode button; kept here because a screenshot
  comparison wants the mode set *before* the first frame, not after a click.
- **`?nopanel` exists for the visual A/B.** `--shot` is how the comparisons in
  this file were made, and a 320px panel over the right-hand third of the frame
  would change what those screenshots compare.
- **`?zoom` and `?pan` survived Step 8** rather than being made redundant by it.
  The wheel and WASD now move the view, but `browserCheck.mjs` drives the page
  by URL alone and cannot synthesize input, so these remain the only way to
  place the camera for a screenshot.

Gone, and where each went: `?physicsSteps`, `?motionBlurSamples`,
`?brightness`, `?tonemapSoftness` and the four `?bloom*` are panel controls
(Simulation and Display groups). `?colorByCohort` and `?colorSensitivity` are
panel controls in the Appearance group. `?reticle`/`&dashed` is now what
selecting the Shove or Draw tool does — dashed for Shove, solid for Draw, which
is the real behaviour rather than a forced one. **`?pick` is gone entirely**:
it existed because Step 6 had no other way to dispatch a pick, and the plan
said Step 8 would delete it. Step 7 removed it early because `SelectionController`
is now wired into the frame loop, and leaving it would be a second dispatch path
for Step 8 to reconcile.

### Switching presets

`?preset=<name>`, by filename stem — no rebuild, no code edit:

```
http://localhost:5173/?preset=hatmanv8
http://localhost:5173/?debug&preset=9leafv8
```

An unknown name falls back to the default and logs the available ones, so a typo
never looks like a broken engine. The default is `Starcrossedv8`.

**Adding a preset** is a file drop plus a sync, because presets are data rather
than code. Drop the `.json` into `configs/` (v8 only) and run:

```
npm run sync:configs
```

`tools/syncConfigs.ts` walks `configs/`, copies every file verbatim into
`public/configs/`, and writes the `manifest.json` the app fetches. There is no
list of filenames to maintain and no `.ts` module to rebuild — that is the point
of the manifest.

It does two things a `cp -r` would not:

- **Every preset is parsed through `src/config/persistence.ts`** — the app's own
  reader — and discarded. A malformed or wrong-version file fails **here**, with
  the real error message, rather than in a browser as a menu entry that does
  nothing.
- **The output directory is a mirror, not an overlay.** Anything in
  `public/configs/` that is no longer in `configs/` is deleted. Without this a
  removed preset stays shipped, unreferenced by the manifest and invisible in
  review.

`npm run build` runs `sync:configs:check` first, so a stale `public/configs/`
fails the build instead of shipping quietly.

`configs/custom/` is skipped deliberately: it is local working state — where the
retired desktop app put user saves, and where scratch presets accumulate. The
browser's equivalent is IndexedDB, which is per-user by construction.

**Saving** writes to IndexedDB under `Custom`, through the Save folder in the
panel. Saves survive a reload; shipped presets cannot be deleted (they are part
of the build, so a delete would appear to work and reappear). If a browser
denies storage — private browsing, blocked permissions — shipped presets still
load and only saving is unavailable, reported through `status().canSave`.

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
real Chrome and a dev server, none of which belong in CI. **Eleven** modules
should report success, and the `?debug` overlay lists **thirteen** pipelines —
`entityPick.wgsl` and `strafeDraw.wgsl` each build two (reduce/derive and
draw/erase), which is why the counts differ.

Two further browser tools cover what the URL alone cannot reach, because they
need synthetic input and a page reload respectively:

```
node tools/fieldCheck.mjs --keep-shots ../field   # the Strafe Field, and the Y flip
node tools/configCheck.mjs                        # storage, across a reload
node tools/uiCheck.mjs                            # the gated latch, and the reveal toggle
```

`uiCheck.mjs` is Step 10's, and it exists for the same reason the other two do:
its assertions need a real pointer gesture against real Tweakpane DOM, which
`node --test` has no way to produce. It presses a gated slider, drags it to its
base value, and asserts the control is **still visible while the button is
down** — the failure a value-only latch produces is folding the control away
mid-drag, and no unit test can see it. It also asserts that revealing a control
leaves **the same DOM node** in place, which is how "this used `blade.hidden`
rather than rebuilding the pane" is verified; a rebuild looks identical in a
screenshot.

**The tools cover different halves and none substitutes for another.**
WGSL forbids implicit-derivative sampling (`textureSample`, `fwidth`) outside
uniform control flow, and Step 5 hit that twice — `camera.wgsl`'s letterbox
early-out and `frameAssembly.wgsl`'s field sample. Those are hard compile
errors, but only in a browser, so the Node suite would never have seen them.

## Layout

| Path | Role |
|---|---|
| `tools/wgslInclude.ts` | The `#include` resolver + its Vite plugin |
| `tools/syncConfigs.ts` | Copies `configs/` into `public/` and writes the manifest |
| `tools/browserCheck.mjs` | Drives a real Chrome over CDP; the only thing that compiles WGSL |
| `src/gpu/` | Stateless GPU helpers — the `shared/` analogue (invariant 1) |
| `src/app/` | Canvas surface and sizing; `renderTargets` (the HDR and accumulation buffers) |
| `src/particleSystem/` | The simulation: the pure leaves (`coords`, `sizing`, `config`, `pack`, `layout`, `dispatch`, `pick`), `uniforms`, and `particleSystem.ts` |
| `src/particleSystem/shaders/` | The engine — `entityUpdate.wgsl`, `canvas.wgsl`, `brush.wgsl`, `entityPick.wgsl`, and `rule.wgsl` shared by two of them (invariant 6) |
| `src/selection/` | The click-to-adopt ordering, with no GPU and no Project type |
| `src/camera/` | `cameraState` (pan/zoom/mode), `blurSchedule` and `cameraUniforms` (pure leaves), and `camera.ts` |
| `src/camera/shaders/` | `camera.wgsl` (TRAIL), `camBrush.wgsl` (PARTICLES), `accumulate.wgsl` |
| `src/assembler/` | `bloomChain` and `assemblerUniforms` (pure leaves), `bloom.ts`, `assembler.ts` |
| `src/assembler/shaders/` | `bloomDownsample.wgsl`, `bloomUpsample.wgsl`, `frameAssembly.wgsl` |
| `src/orchestrator/` | `orchestrator.ts` (the frame loop and the wiring), `commands.ts` (the typed boundary), and the three command modules the desktop's mixins became |
| `src/project/` | `project.ts` (the immutable save-file value) and `history.ts` (undo/redo with coalescing) |
| `src/prefs/` | `preferences.ts` — the full editor-preference set, `localStorage`-backed |
| `src/ui/` | `settingsSpec.ts` (the 35-entry registry); the panel — `panel.ts` (the shell), `sections/` (one per panel section), `controls.ts` + `gatedControl.ts` (registry entry → widget), `menuBar.ts`, `dialogs.ts`, `tooltip.ts`; its pure leaves — `gating.ts`, `reveal.ts`, `gateState.ts`, `previewSession.ts`, `panelModel.ts`, `formatValue.ts`; and the input layer — `inputState.ts` (the snapshot), `inputTracker.ts` (pure accumulator), `hotkeys.ts` (the table), `inputBinding.ts` (the DOM listeners) |
| `src/testing/` | Test-only access to the parity goldens |
| `src/shaders/` | Shared shaders — `common.wgsl`, `fullscreenQuad.wgsl` |

Every module that imports a `.wgsl` file is untestable under `node --test`,
because `#include` resolution is a Vite plugin. That is why each has a pure leaf
beside it (`blurSchedule`, `bloomChain`, `dispatch`, the uniform packers): the
arithmetic stays testable without a browser.

## Committed data files

| File | Contents | Maintained by |
|---|---|---|
| `src/particleSystem/layout.fixture.json` | Struct sizes, member offsets, float-lane indices | By hand, alongside `common.wgsl` |
| `src/testing/parity.fixture.json` | Golden values from the retired Python reference | Frozen — see below |
| `src/config/presets.fixture.json` | What the reference reader parsed each shipped preset into | Frozen — see below |
| `public/configs/manifest.json` | The preset index: categories and names, in menu order | `npm run sync:configs` |
| `public/configs/<category>/*.json` | Every shipped preset, copied verbatim from `configs/` | `npm run sync:configs` |

The presets are **fetched, not imported**. `public/` is copied to the build root
untouched, which is what makes adding one a file drop rather than a rebuild.

### The fixtures are no longer generated

All three were originally produced by the Python app — `layout.fixture.json` by
`layout.py`'s GLSL parser, `parity.fixture.json` by calling the reference
`coords` / `sizing` / `camera_state` / `pack_configs` functions directly, and
`presets.fixture.json` by loading `configs/*.json` through the reference reader.
That app is gone, so none is regenerable, and **none should be regenerated from
the TypeScript.**

For `parity.fixture.json` and `presets.fixture.json` that is the entire point. A
round-trip test checks the
port against *itself*: if `worldHalfExtent` returned `[1/s, s]` instead of
`[s, 1/s]`, every round-trip would still close perfectly, because forward and
inverse would be wrong in cancelling directions. Only independently-sourced
values catch a symmetric error like that, which is why these outlived the
implementation that produced them. Recomputing them here would turn a real check
into a tautology. A failure means the port changed, not that the fixture is
stale.

`layout.fixture.json` is now one of **two hand-authored statements of the GPU
struct layout**, the other being `src/shaders/common.wgsl`. Change a struct and
you must edit both, in the same commit. Nothing generates either from the other,
but two checks compare them on every `npm test`: `common.wgsl.test.ts` scans the
WGSL declarations against the descriptor, and `assertLaneMap` (called from
`config.ts`) checks the hand-written lane constants against it. Between them a
mismatch is caught in either direction — which matters because the failure is
otherwise silent: every lane after an inserted `vec4` shifts by four floats and
the physics just goes subtly wrong.

There is deliberately **no WGSL parser** to replace `layout.py`. Shader
hot-reload is gone (invariant 5), so a runtime parser has no job, and a parser
written to re-derive a file that changes about once a year would be more code to
get subtly wrong than the thing it checks.

## Reading the Python citations

Comments throughout cite the reference implementation by file and line —
`persistence.py:128-129`, `camera.py:14-18`, `project_commands.py:241-253`.
Those files no longer exist in the working tree.

**They are kept on purpose.** Each one marks a place where this code does
something non-obvious *because the reference did*, and the citation is the
evidence for a decision that would otherwise look arbitrary — a fallback for
files written before a rename, an argument order that differs from every
neighbouring function, a default someone would otherwise "clean up."

To resolve one, read it out of history:

```
git show 901c714^:particle_system/persistence.py | sed -n '120,135p'
```

`901c714` is the commit that removed the Python app, so `901c714^` — its parent
— is the last tree that still contains those files. Find it again later with
`git log --diff-filter=D -- particle_system/persistence.py`.

## `common.wgsl` and the two-copy layout hazard

`src/shaders/common.wgsl` holds the GPU structs, the `cfg_*` / `world_*` /
`e_*` accessors, and the coordinate math — and every shader `#include`s it.

**Struct layout is hand-authored in two files.** `layout.fixture.json` is what
the host packs against; `common.wgsl` is what the GPU reads. A divergence
between them does not crash and does not error — the host packs 416 bytes to one
plan and the shader reads them to another, and the simulation is just subtly
wrong.

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

## Picking, and why the rule is derived on the GPU

Clicking a particle adopts its rule as the config's base rule — "that variant,
do more of that." The catch is that **the rule is not stored anywhere**: an
`Entity` is 32 bytes (`pos_vel` + `misc`), and `entityUpdate.wgsl` re-derives
the rule every step and discards it.

The desktop solves that by recomputing the rule host-side in float32
(`particle_system/mutation.py`, 236 lines), avoiding a readback entirely. **That
file is deliberately not ported.** JavaScript has no float32 arithmetic — every
intermediate would need `Math.fround`, the hash would need `Math.imul` — and
`mutation.py:149`'s `pow(h, 2.0)` has no reliable JS equivalent: `pow(h,2)` and
`h*h` differ by one ULP, and the chaotic hash amplifies that into a *completely
different rule* (measured on the desktop as internal seed 0.3088 vs 0.2605). A
wrong adopted rule looks like a legitimate result, which makes it the worst
failure mode available.

So the GPU derives it and the host reads it back — 336 bytes instead of 4.

**`rule.wgsl` is what makes this safe.** The generate-or-mutate branch, the hash
family, `generate_random_centers`, `mutate_rule` and `get_cohort` live in one
file included by *both* `entityUpdate.wgsl` and `entityPick.wgsl`, so the rule a
click adopts is derived by the same `derive_entity_rule()` that decides what the
particle obeys. Not a copy — the same function. (The plan assumed they would
share this through `common.wgsl`; they cannot, because that file is included by
two vertex stages and its own rules forbid it. A sibling include resolves for
both.) `ARCHITECTURE.md:715-718` records what happened the one time the two
copies drifted: selection adopted near-zero coefficients and the simulation
appeared to die.

**Two passes, not one.** `reduce` (`@workgroup_size(256)`) atomicMins a packed
key — 8 bits of quantized distance in the high bits, 24 of entity index in the
low — over every entity. `derive` (`@workgroup_size(1)`) then reads the settled
key and writes the winner's rule and position. They must be separate because a
thread that *loses* the atomic still runs its next instruction, so a rule
written from the reduce pass could be a loser's: the index right, the rule
someone else's, and nothing downstream able to tell. They must also be separate
*compute passes*, not two dispatches in one — WebGPU orders passes within a
submission but guarantees nothing between dispatches inside a single pass.

**The phase machine.** `picker.py` needs one boolean; the port needs four
states (`idle`/`dispatched`/`mapping`/`ready`), because a buffer that is mapped
or mid-`mapAsync` is not a legal copy target. `mapAsync` must also be called
after `submit()`, never while the encoder is open — hence `beginPickReadback()`
as its own step. A second click while one is in flight abandons the first
through a generation counter rather than corrupting the staging buffer;
last-click-wins is enforced above it, in `SelectionController`.

**The ordering constraints, which Step 7 must preserve.** `retrievePick()` is
the first thing `frame()` does, *before* anything can dispatch a new pick —
there is one result slot, so a new dispatch clobbers the answer being read. And
the resolve lives in the frame loop, **not** inside `runFrame()`: that is what a
paused frame skips, and clicking to select has to keep working while paused,
which is precisely when you want it.

### Verifying it

The claim that matters — that the derived rule is the one the entity is actually
obeying — can only be checked live. The discriminating test is cohort identity,
on `hatmanv8` (64 cohorts on a grid):

```
node tools/browserCheck.mjs --url "?debug&preset=hatmanv8&pick=509,275"
node tools/browserCheck.mjs --url "?debug&preset=hatmanv8&pick=517,285"
```

Two entities in the **same** cohort ring must return **bit-identical** rules
(measured: #401548 and #394380 both `[1.4390, -0.3923, 0.2611, -1.7674]`), and
entities in **different** cohorts must return different ones (`1.4274` /
`1.4304` / `1.4393` at three other rings). Both directions are needed: a broken
`get_cohort` fails one or the other. Also worth checking, and all confirmed:
the position round-trips (dispatch world → hit within `d=0.00000`), a click in
empty space records no history, and at `zoom=0.35` the world radius grows
0.1233 → 0.3522 so the 40-pixel tolerance stays constant on screen.

## The Orchestrator, and the boundary that is now typed

`orchestrator/orchestrator.ts` owns the frame loop, the wiring and the state —
**not the handlers.** "Sole broker" means it routes, not that it implements,
which is the same split the desktop draws.

### The mixins became composition

The desktop flattens six command mixins into one class through Python's MRO, and
**the MRO is load-bearing**: the mixins own no state, they read and replace
attributes defined on the Orchestrator, and they call each other's methods
freely. TypeScript has no multiple inheritance, so each group became a module:

| Desktop mixin | Port |
|---|---|
| `project_commands.py` | `projectCommands.ts` — the preset catalog and cycling. Save/load/delete are **Step 9**, which owns storage |
| `clipboard_commands.py` | `clipboardCommands.ts` — a `CheckpointStore` that owns its own invariants |
| `settings_commands.py` | `settingsCommands.ts` — pure functions returning the new project or preferences |
| `selection_commands.py` | already ported in Step 6 (`selection/selection.ts`) |
| `drawing_commands.py`, `shove_commands.py` | **Step 9**, with the strafe field |

**What that mechanically prevents:** on the desktop, `ShoveCommands` reaching
`self.prefs` is invisible in its signature, so nothing stops a mixin growing a
dependency on state it has no business seeing. Here every dependency is an
argument, and adding one shows up in the diff.

The settings modules are pure — they take the current values and return the new
ones — which keeps "the Orchestrator is the one place project state changes"
true, and makes the routing testable with no GPU and no device.

### The two untyped dicts are now discriminated unions

`ARCHITECTURE.md` invariant 10 is enforced rather than aspirational on the
desktop, and the price is that the boundary is two untyped string dicts: a
29-entry command table and a 30-key `STATUS_KEYS`. `orchestrator/commands.ts`
types both, and gains two things a dict cannot have:

- **The command `switch` has a `never` default arm**, so adding a `Command`
  member without a handler is a build error rather than a silently ignored
  click. The Python's dict can only fail at dispatch, on a key the UI typed.
- **`Status` is a total interface with no optional members**, so the compiler
  enforces at the one build site what `STATUS_KEYS` enforced by convention and a
  comment. That guarantee is why UI code reads `status.preset` directly instead
  of defending itself with a fallback — a missing key is a bug worth hearing
  about, and three keys once carried *different* defaults at different call
  sites, which is the failure this replaces.

A union rather than an interface of methods, deliberately: the desktop's UI
*holds* the command table and dispatches by name, which is what lets a toolbar
build itself from a list without knowing what any button does. A union preserves
that while making the arguments typed.

### THE RETAINED-MODE FEEDBACK LOOP

**The one real bug in Step 7, and the one Step 10 will meet again.**

Tweakpane is retained-mode: writing a proxy and calling `pane.refresh()` makes
it fire `change` on every binding whose value moved — and **it cannot
distinguish a value the user dragged from one the app just pushed in.** So
loading a preset fed that preset's own values straight back through
`editSetting`. Measured: one `Next >` recorded **four** history entries (depth
1 → 5), and the top of the undo stack read `"edit Sensor Distance"` instead of
`"load 9leafv8"`. Undo then stepped back through phantom edits rather than
unloading the preset, which reads as "undo is broken" and is not.

**imgui cannot have this bug** — immediate mode reports a change only when the
user moves something — so nothing in the desktop code or in the port plan
anticipates it. A `refreshing` flag guards every dispatching handler, set around
the refresh in a `try`/`finally` so a throw inside a handler cannot wedge the
panel permanently read-only.

This is a real difference between the two UI models, not a Tweakpane quirk.
**Every retained-mode binding in the panel needs the same guard**, and the gated
latch needs it in a specific ORDER — see below.

### The panel

`ui/panel.ts` builds one docked side-panel from sections
(`ui/sections/`), which is the endpoint `ARCHITECTURE.md`'s "Toolbar and the
planned side-panel" asks for. `panelModel.sectionsFor` is the seam where the
active tool will eventually select which sections are visible; today it returns
all of them, and `panelModel.test.ts` pins that so the change is deliberate.

Everything decidable lives in a pure leaf, because `node --test` has no DOM:
`gating.ts` (position/value mapping, the off-zone), `reveal.ts` (the `revealsOn`
resolver), `gateState.ts` (sessions and forced gates), `previewSession.ts`
(hover/commit), `formatValue.ts`. The DOM wiring is thin by comparison.

Three things are worth knowing before editing it:

- **`ev.last` does NOT distinguish a user gesture from a programmatic refresh.**
  `pane.refresh()` reaches the plain `rawValue` setter, which emits
  `{forceEmit: false, last: true}` — identical to a released drag. Only
  `onPointerMove_` emits `last: false`. So every handler tests `isRefreshing()`
  **first**; reversing that folds an open gated slider away on the next frame's
  refresh, silently.
- **Visibility is `blade.hidden`, never a rebuild.** A rebuild drops folder
  expansion state and replaces every DOM node, and looks identical in a
  screenshot. `uiCheck.mjs` asserts the blade element survives a toggle.
- **Nothing about a gate is stored.** On/off is derived from the value itself,
  which is what makes save, load, undo and A/B preview all work with no
  knowledge that gating exists. Do not add a flag.

The panel holds a `CommandBus` and nothing else — no `Orchestrator`, no
`ParticleSystem`, no `Project`. That is invariant 10 expressed as a type: the
file *cannot* reach simulation state, because it holds nothing that leads there.
The one exception is the Debug section's input rows, which take the frozen
`InputState` — a plain readonly value, the same precedent `PickResult` sets.

### Verifying it

`settingsSpec.test.ts` is the one worth knowing about. A `Setting`'s `field` is
a plain string in a data table, so **the compiler cannot check it**, and an
entry naming a field that does not exist produces a control that renders, drags,
and does nothing — silently, because `editSelected` and `withValue` both return
the receiver unchanged for an unknown field (which is the right behaviour, and
exactly what makes the failure quiet). The test asserts all 35 entries against
the real interfaces, and `settingsCommands.test.ts` asserts the same 35 end to
end through the routing.

It also pins the two dropdown orders against `BC` and `IC` themselves. **Order
is the enum**: each label's index is the value uploaded, so reordering a tuple
silently changes what every saved config means.

The command path itself was verified by driving the real panel over CDP —
clicking actual Tweakpane buttons and reading the resulting status back. Reset
restarts `frameCount`, the camera toggle round-trips, preset cycling works in
both directions (including the negative-modulo wrap that plain `%` gets wrong in
JavaScript where Python's does not), a slider edit reaches the config and
survives the refresh cycle, and undo restores the pre-load values. That is what
caught the feedback loop above; `npm test` could not have, and neither could
`browserCheck.mjs`, whose only lever is the URL.

## Input, and how capture is resolved

The port of `ui/input_state.py` and `ui.py`'s five GLFW callbacks. Split across
three files, and **the split is the design**:

| File | Role | Testable headless? |
|---|---|---|
| `ui/inputState.ts` | The frozen per-frame snapshot. The type half, written in Step 7 | — |
| `ui/inputTracker.ts` | Accumulates events, freezes one `InputState` per frame | **Yes** — imports no DOM |
| `ui/hotkeys.ts` | The binding table, `matchHotkey`, the focus gate | **Yes** — pure |
| `ui/inputBinding.ts` | The DOM listeners. Translates events into tracker calls | No |

`npm test` runs under `node --test` with no DOM, so everything that *decides*
anything lives in the two pure files and the listener layer holds no state. That
is not tidiness: the asymmetries below all fail silently, and a tracker that
touched `document` could not be tested at all.

### Capture, which the browser makes genuinely different

The desktop gets arbitration free. `ui.py:66-80` installs its GLFW callbacks
*after* imgui's and keeps imgui's bound methods, so every handler forwards the
event and then reads `want_capture_mouse` — already updated, synchronously,
mid-callback.

The DOM hit-tests *before* dispatching, so there is no such flag to read. Capture
is instead reconstructed from the browser's own decision: `event.target === canvas`.
Same answer, arrived at from the opposite direction. Anything not on the canvas
belongs to the UI, which covers the Tweakpane panel without this code having to
know the panel exists.

**The three asymmetries carry across unchanged**, each implemented at its site in
`inputTracker.ts`:

- **A captured press is dropped entirely** — it sets neither held nor dragging,
  so a press landing on the panel can never open a canvas drag.
- **A release is never capture-filtered.** `onPointerUp` deliberately *has no*
  `capturedByUi` parameter, so a filtered release is not expressible through the
  API. A button that went down on the canvas must come up over the panel or the
  canvas stays grabbed forever.
- **A drag belongs to whoever received the press**, and survives the cursor
  wandering over the UI.

`onFocusLost()` has **no desktop analogue and is genuinely needed**: a browser
tab that loses focus stops delivering `keyup`, so a held `KeyW` at alt-tab time
would still be in `keysHeld` on return and the view would pan by itself with the
keyboard untouched. GLFW keeps delivering to an unfocused window, so `ui.py`
never had to think about it.

### Two conversions that are easy to get subtly wrong

**CSS pixels → framebuffer pixels.** `clientX/Y` are CSS pixels; `zoomAtPixel`
and `screenToWorld` take device pixels. The scale is the ratio of `surface.size()`
to `getBoundingClientRect()` — **not** `devicePixelRatio`, which agrees at 100%
browser zoom and drifts at fractional zoom, for the same reason `surface.ts`
prefers `devicePixelContentBoxSize`. Getting this wrong puts picks
near-but-not-on the cursor with an error that grows across the frame, which reads
as "picking is a bit imprecise" rather than as a bug.

**`deltaY` → notches.** Negated, because `deltaY` is positive-down and
`InputState.scroll` is notches positive-up. Normalised by `deltaMode`: Firefox
reports LINE for a real wheel where Chrome reports PIXEL, so without it one
browser would zoom ~100× faster than the other. Accumulated within the frame
(`+=`), because `zoomAtPixel` takes notches as an exponent and a fast flick
should be worth proportionally more.

### The hotkey table, and its deliberate divergence

A **table** rather than `ui.py:422-491`'s straight-line `if` chain, because the
plan asks for something rebindable and only data can be rebound.

**The table is deliberately Ctrl-free**, which is the one place Step 8 diverges
from the desktop on purpose. The plan deferred four colliding bindings to
whoever built the table; the choice made was to move every collider to a bare key
rather than intercept a browser combination:

| Key | Command | Desktop was |
|---|---|---|
| `C` | Set checkpoint | Ctrl+C |
| `V` | Load latest checkpoint | Ctrl+V |
| `M` | Toggle camera mode | Tab |
| `Z` / `Shift+Z` | Undo / redo | Ctrl+Z / Ctrl+Shift+Z |

The payoff: **no app hotkey ever calls `preventDefault` on a Ctrl combination**,
so the browser keeps Ctrl+C, Ctrl+V, Ctrl+R and Ctrl+Z unconditionally. The
failure the plan warns about — "`preventDefault` then breaks copying text out of
Tweakpane fields" — cannot occur, because there is nothing to prevent.

Two are absent rather than moved. **Ctrl+R (revert to saved)** is unbound: it
needs Step 9's storage to have anything to revert to, and the browser reloads the
page. **Tab** is left to DOM focus traversal — the plan calls that collision
"worse than with imgui, since Tweakpane is real focusable DOM", and that cuts
both ways: keyboard traversal of a real panel is worth more than a second
binding for a command that now has `M`.

Everything uncollided keeps its desktop key: `1`/`2`/`3` tool, `X` hide UI,
`Space` pause, `R` reset, `B` behaviour, `F` seed, `Home` reset camera. `←`/`→`
have since MOVED off presets and onto the cohort stepper, with `Enter` to commit
the selection — presets are menu-only now, because loading one replaces every
particle's behaviour and that is too large an act for a stray arrow key.

One binding is web-only: **`H` / `?` opens the guide** (Help → Controls/Guide).
The desktop has no equivalent because it has no Help menu to mirror. Two rows
carry it, `KeyH` first so `localHotkeyLabel` returns a key a user can press;
the `Slash` row leaves `shift` open, since `?` and `/` are one physical key and
`code` cannot separate them.

**Every hotkey is gated on "no editable element focused"** (`isEditableTarget`,
tested against the *event target* rather than `document.activeElement` — the two
disagree during focus transitions, and the target is what actually received the
keystroke). Without it, typing `Starcrossed` into a save dialog would reset the
simulation on the `r` and checkpoint on the `c`.

**WASD and Q/E are not in the table**, and must not be. They read `keysHeld`
against `dt` in `applyCameraKeys`; routing them through a one-shot table would
make each one step per key-*repeat*, whose rate is an OS setting.

### `dt` is the raw delta, not `frameMs`

`main.ts` keeps two clocks and they are not interchangeable. `frameMs` is
exponentially smoothed because a raw per-frame delta is unreadable in the
overlay; `dt` must be raw because panning is `speed * dt` and a smoothed dt lags
the real clock — a pan would keep accelerating for several frames after the key
went down and coast after it came up. The first frame's `dt` is forced to zero:
its `elapsed` measures however long device acquisition and pipeline compilation
took, which would otherwise land as one enormous camera step.

### How it was verified

`inputTracker.test.ts` and `hotkeys.test.ts` cover the logic headless — the
asymmetries, the one-shot drain, scroll accumulation, focus loss, table
ambiguity and the focus gate. The DOM wiring was then driven over CDP with
`Input.dispatchMouseEvent`/`dispatchKeyEvent`, since `browserCheck.mjs` cannot
synthesize input:

- a canvas click selects (entity `#15285` at world `(-0.343, -0.187)`), and the
  click landing at the right world point is what confirms the device-pixel
  conversion
- a click on the panel does **not** select
- `M`, `Space`, `Digit1`/`Digit3` and `X` all fire; `X` round-trips the panel
- typing `M` into a focused Tweakpane input does **not** toggle the camera

The camera checks were run **against a paused frame**, so the simulation itself
could not change the picture and every difference was the camera's doing:
average-luminance stable at 6.01 across a second; wheel zoom moved it to 13.02;
`Home` restored it to exactly 6.01; holding `W` panned to 2.04; and releasing `W`
left it at 2.05 — that last one being the check that `keysHeld` actually drains,
which is the difference between a pan that stops and a view that drifts forever.

## The Strafe Field, and the third Y flip

`src/strafeField/` is a painted `rg16float` vector field whose texels are added
straight to particle positions every physics step. That makes it **advection,
not force**: it bypasses velocity, so drag never damps it and nothing can swim
upstream against it.

Not ping-ponged, unlike the canvas: the brush shader never *reads* the field, and
each fragment writes only its own texel, so there is no read-write hazard to
double-buffer away.

### THE FLIP, AND WHY IT IS THE MOST DANGEROUS ONE IN THE PORT

`strafeDraw.wgsl` rasterizes **into** a texture that `entityUpdate.wgsl` samples
through `world_to_uv_bc` — the same Y-up mapping `get_can` uses for the canvas.
So it falls on the same side of the rule as `canvas.wgsl` and `brush.wgsl`, and
carries the same v flip. It deliberately does **not** use `fullscreenQuad.wgsl`,
whose header excludes exactly this case.

What makes it worse than the two Step 4 flips: **without it the overlay confirms
the bug.** `frameAssembly.wgsl` samples the field with the same unflipped canvas
uv the mouse produced, so a mirrored field would still *draw* the stroke exactly
where you painted it, while the physics pushed particles the other way. There is
no screenshot of the app that catches that — the debug view agrees with the
error. Hence `tools/fieldCheck.mjs`, which checks the overlay path and the
physics path separately (see "Verifying it" below).

### The rest of it, briefly

- **Two pipelines, one shader module.** Blend state is per-pipeline in WebGPU:
  draw accumulates `(ONE, ONE)`, erase runs unblended so it can write literal
  zero. `erase_mode` stays a uniform *as well*, because the shader branch differs
  in what it writes and where it discards — the pipelines differ only in blending.
- **`loadOp: 'load'` on both.** A `'clear'` wipes the field every stroke frame,
  which reads as "the brush only paints while I'm moving". Same trap as the bloom
  upsample.
- **The size cap is on TOTAL TEXELS**, not per edge: `w*h <= 512²`, so a 700×300
  canvas runs at full resolution. Reading it as `min(w,512)` changes the field's
  *shape*, and since world↔uv is normalized that is a silent skew, not an error.
- **`setWrap` issues no GPU work,** and that is worth saying rather than hiding.
  Wrap is a *sampler* property here, and the field owns no sampler: its readers
  bind it alongside the canvas, in a bind group already built per address mode.
  The call stays in `setProject` because invariant 9 wants four things to agree
  on the boundary mode and this is the accounting for the fourth.
- **Painting happens once per rendered frame, above the physics loop.** Inside
  it, a stroke would be `physicsSteps`× stronger and brush weight would track the
  physics rate. `applyCanvasInput` records the stroke; `frame()` encodes it.
- **Shove is the opposite** — per sub-step, because it has nothing to persist in.
  Its strength is `gain * power / steps * (steps / 30)`, which equals
  `gain * power / 30` and is **deliberately not collapsed**: the two factors mean
  different things, and `shoveCommands.test.ts` pins it at three rates.

### Verifying it

`node tools/fieldCheck.mjs --keep-shots ../field` (with `npm run dev` running).
Three passes: the overlay path, the physics path, and the eraser. It loads
**hatmanv8**, not the default — Starcrossed concentrates into a small structure
and leaves most of the frame black, against which every quadrant statistic tried
here measured noise.

**Pass 2 is advisory and does not vote.** Three scalar proxies for "the trails
changed *here*" were tried (mean luma, fraction-empty, largest empty square) and
all three moved less than the run-to-run variation of a chaotic simulation; the
last separated cleanly on one run and inverted on the next with no code change.
The evidence for the physics path is the **screenshots**, which answer it
instantly: a correct build shows a clean disc in the upper-left of `2-painted`
and nothing there in `2-control`. That is what was actually used to verify the
flip, and dressing it up as a threshold would be worse than saying so.

Passes 1 and 3 do vote, and separate by two orders of magnitude (+117 vs +0.06
on the overlay) because they measure a painted overlay rather than an emergent
simulation.

## Config storage: a manifest and IndexedDB

`persistence.discover()` globs `configs/` and iterates its subfolders. **No
browser can enumerate a directory**, so the enumeration moved to build time and
the runtime became two sources merged into one catalog.

| Module | Job |
|---|---|
| `src/config/persistence.ts` | The v8 reader and writer, and `sanitizeName`. Pure — no fetch, no IDB, no DOM |
| `src/config/manifest.ts` | Fetch and validate `public/configs/manifest.json` |
| `src/config/idb.ts` | One IndexedDB object store, four operations, no library |
| `src/config/configStore.ts` | Merges both into `category → ordered names` |

- **`(category, name)` is the identity**, as it already was on the desktop
  (`ConfigEntry.key` is the pair, not the path). That is what makes this a swap
  rather than a redesign: `path` becomes a manifest implementation detail that
  nothing outside `configStore.ts` reads, and `Status.configCategories` — written
  in Step 7 as `category → names` — did not change at all.
- **v7 is absent by construction.** There is no `version <= 7` arm, not even one
  that throws a nicer message: that would be a v7 code path carrying v7
  assumptions. A version that is not 8 is unrecognized, full stop.
- **The reader's tolerances all ported**, each with its Python line cited,
  because each fails silently. `mutation_seed` → `rule_seed` → `0.0` is the worst:
  a missing fallback loads seed 0.0, and the chaotic hash turns that into a
  completely different rule that still looks legitimate.
- **The failure modes are deliberately asymmetric.** A missing manifest
  **throws** into the same banner a missing GPU adapter uses — an app with no
  presets is not usable, and the likeliest cause is a build that did not copy
  `public/`. A denied IndexedDB does **not**: shipped presets still load and only
  saving is unavailable. This one will not reproduce on a dev machine.
- **Async, with `dispatch` still `void`.** Handlers start work and report through
  `Status.configBusy` and `Status.saveError`, which the panel already reads every
  frame. Loads carry a generation counter — the same last-request-wins idiom
  `SelectionController` uses — so a load resolving after a newer one cannot
  clobber it. `configBusy` clears in **both** arms; a rejected promise leaving
  "Saving…" up forever is the failure mode.
- **The camera is restored on a committed load only** — not on hover-preview
  (settings only) and not on the LEFT/RIGHT cycle, where a view that jumped on
  every keypress would make browsing unusable. Via `setZoom`, never
  `state.zoom =`: the setter rejects a non-finite value, and a hand-edited file
  is exactly where a NaN comes from.

### Verifying it

`node tools/configCheck.mjs` (with `npm run dev` running). Thirteen checks, of
which one is the point: **a save survives a full page reload.** Everything before
that passes just as well against an in-memory `Map`.

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
- **`mutation.py` is not ported; the picked rule is derived on the GPU.** The
  biggest deliberate divergence in the port, and the reason Step 6 exists in the
  shape it does. See "Picking" above.
- **`retrievePick()` returns `null` as well as a miss, and they are different.**
  `picker.py`'s `retrieve()` answers immediately, so "nothing pending" and
  "nothing in range" can both be `MISS`. `mapAsync` means the answer can simply
  not have arrived; `null` says so, and the pending click survives to the next
  frame. Treating `null` as a miss would silently drop any click whose readback
  took longer than one frame — which reads as "clicks sometimes don't register."
- **The pick result's position is two `f32`s, not a `vec2f`.** `vec2f` has
  alignment 8 and so cannot sit at offset 4, in the padding that `Rule`'s
  16-byte alignment already forces; WGSL would push it to 8, the rule to 32, and
  the struct to 352 bytes, at which point the driver rejects the 336-byte buffer
  as too small for the binding. Two `f32`s align to 4 and fit, so the position
  costs nothing. Asserted in `shaders.test.ts` because `vec2f` is the tidier
  spelling and an obvious "cleanup".
- **`pick_blocking` is not ported.** It exists on the desktop for
  `tests/test_async_pick.py` only, and it works by stalling the pipeline —
  which WebGPU cannot do at all. The Python's key-packing check ports (it is
  pure arithmetic, now `pick.test.ts`); its GPU half is replaced by the browser
  verification above.
- **Preferences validate on the way in; the desktop's do not.** `json.loads`
  there feeds a dataclass that never checks types, so a hand-edited
  `"physics_steps": "lots"` reaches the GPU as a string. In JavaScript that
  lands as `NaN` in a uniform and freezes the simulation, so `coerce` rejects
  the key and keeps the default. Unknown keys are dropped in both (a downgrade
  must survive a newer version's file); wrong-typed known keys are the port's
  addition. It matters more here for a second reason: a corrupt entry in
  `localStorage` **outlives a page reload**, where a bad `preferences.json` can
  be deleted with a file manager.
- **`History` measures its coalescing window in MILLISECONDS.**
  `performance.now()` where the Python has `time.monotonic()`, so
  `COALESCE_WINDOW` is 500 rather than 0.5. Getting the conversion wrong does
  not error — it makes every edit coalesce forever, or none of them, and both
  read as "undo is behaving oddly". `now` is injectable so `history.test.ts`
  drives the boundary from both sides instead of sleeping.
- **The panel guards against its own refresh.** See "THE RETAINED-MODE FEEDBACK
  LOOP" above — the largest behavioural difference Step 7 introduced, and one
  the desktop's immediate-mode UI cannot have.
- **`asRecord` drops non-primitive fields, where `dataclasses.asdict` deep-copies
  them.** The only one that matters is `rule`: 80 floats no control binds to,
  compared every frame by the panel refresh if they were carried. The desktop's
  closed-panel early-out exists to avoid that copy; the port keeps the early-out
  *and* drops the field.
- **`Orchestrator.rebuildSystem` builds the replacement before dropping the old
  one.** Pipeline compilation is async here and synchronous there, so a failed
  compile mid-rebuild would otherwise leave the app with no simulation at all.
  The desktop's `_rebuild_system` can assign directly because its
  `ParticleSystem(...)` either returns or raises.

  **It also destroys the outgoing system and its field**, which the desktop has
  no need to do: dropping a JS reference does not free GPU memory, so without
  `ParticleSystem.destroy()` each rebuild leaked ~19 MB of entity buffer at 600k
  entities. The system and the field are replaced *together*, because the field
  is sized from the canvas, and destroyed last so nothing above can throw between
  the swap and the free. `destroy()` unmaps `pickStaging` and bumps the pick
  generation first: a rebuild landing inside a click's readback window would
  otherwise destroy a buffer with a `mapAsync` in flight.
- **The hotkey table is Ctrl-free, so five bindings differ from the desktop.**
  `C`, `V`, `M`, `Z` and `Shift+Z` where the desktop has Ctrl+C, Ctrl+V, Tab,
  Ctrl+Z and Ctrl+Shift+Z; Ctrl+R and Tab are unbound entirely. **This is a
  decision, not an oversight** — it is what lets the browser keep Ctrl+C/V/R/Z
  unconditionally, so copying text out of a Tweakpane field never breaks. See
  "The hotkey table" above before "restoring" any of them.
- **`InputState` carries 10 fields where the desktop's carries 24.** The
  missing 14 have no consumer on the desktop either: `mouse_prev`,
  `mouse_delta`, the middle button, every `*_released`, `keys_released`,
  `any_*_pressed` and both `*_captured` flags are read only by `ui.py`'s debug
  panel. `held` and `dragging` are merged for the same reason — nothing reads
  `held`, and two flags always written together and read by nobody is worse
  than one. The desktop's `mods` bitmask narrows to a single `shift`, which is
  all a Ctrl-free table can discriminate on.
- **`onFocusLost()` has no desktop analogue.** A browser tab that loses focus
  stops delivering `keyup`; GLFW keeps delivering to an unfocused window. See
  "Input" above.
- **A hidden panel refreshes nothing.** `X` sets `display: none` and `refresh()`
  early-outs, so Tweakpane does not walk every binding to update widgets nobody
  can see. `isOpen` follows it, which also stops the Orchestrator building
  settings payloads. The desktop's `gui_hidden` skips the draw calls for the
  same reason.
- **`snapshot_configs`'s synchronous return was never a problem here.** The plan
  (`docs/history/WEB_PORT_PLAN.md:668-671`) flags it as a hazard: `PreviewSession.begin()`
  assigns the handler's return value, so an async bus would silently lose the
  restore. In the port that value never crosses the boundary — `snapshotConfigs`
  stores `previewOrigin` on the Orchestrator and `restoreConfigs` reads it back,
  so there is nothing for an async bus to drop. Recorded because it is the kind
  of thing a later reader will go looking for and not find.
- **Shipped presets cannot be deleted; on the desktop they can.** There the X
  button unlinks a real file on the user's own disk. Here they are part of the
  build, so a delete would appear to work and reappear on the next reload —
  `ConfigStore.remove` refuses, and the message goes to `saveError`.
- **IndexedDB may be unavailable, and the app must survive it.** Private
  browsing or denied storage permissions make it absent or unopenable. Shipped
  presets still load and only saving is lost, reported through `canSave`. There
  is no desktop analogue: a filesystem is always there. **This will not reproduce
  on a development machine**, which is why it is handled by construction rather
  than left to be discovered.
- **`canvasDimensions` now has a second caller, and it is the first to pass a
  real aspect ratio.** `fieldDimensions` composes it when the field is over
  budget. Its documented half-to-even rounding divergence from Python's `round()`
  therefore becomes reachable in a second place — still accepted, since a
  one-texel difference in a linearly-sampled field is invisible.
- **The panel's Presets folder is built once and goes stale within a session.** A
  config saved now appears in the catalog (`status().configCategories`) and in
  the LEFT/RIGHT cycle immediately, but not in the folder's buttons until a
  reload. Rebuilding a Tweakpane folder mid-session belongs with Step 10's real
  load menu; the thin panel is not the place to solve it.
