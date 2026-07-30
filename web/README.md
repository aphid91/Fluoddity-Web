# Fluoddity — WebGPU port

The TypeScript/WebGPU port of the Python app in the parent directory. The plan
is `docs/WEB_PORT_PLAN.md`; the design contract it must honour is
`docs/ARCHITECTURE.md`, whose 10 invariants are the spec.

**Status: Steps 1–3 of 10 complete.** Scaffold, device acquisition, canvas
sizing, the WGSL `#include` resolver, the pure-math leaves (coordinates,
sizing, camera state, config packing), and `src/shaders/common.wgsl` — the
struct layout and coordinate math every later shader includes. There is no
simulation yet — the canvas is black on purpose, and a black canvas is the
expected successful output. Nothing from Steps 2–3 is wired into the render
loop yet; it is the arithmetic and the shared shader code Steps 4–5 build on.

Step 3 retired Step 1's `hello.wgsl` and `common_stub.wgsl`, so `main.ts`
compiles no shader at present. `common.wgsl` is pure declarations and pure
functions with no entry point and cannot form a pipeline on its own; Step 4's
`entity_update.wgsl` is its first consumer.

## Running it

Requires Node 20+ (developed against v24.18.0) and a WebGPU-capable browser —
current Chrome or Edge, or Safari 26+.

```
npm install
npm run dev        # dev server at http://localhost:5173
npm test           # unit tests
npm run typecheck  # tsc --noEmit, strict
npm run build      # typecheck + production build
```

### Checking that `common.wgsl` still compiles

`npm test` checks its struct *layout*, but nothing in the suite compiles WGSL —
that needs a real device, and with `hello.wgsl` retired nothing in the app
compiles a shader until Step 4. Until then, verify by hand after editing it:
run `npm run dev`, open the page, and in the browser console:

```js
const src = (await import('/src/shaders/common.wgsl')).default;
const dev = await (await navigator.gpu.requestAdapter()).requestDevice();
const info = await dev.createShaderModule({ code: src }).getCompilationInfo();
console.table(info.messages);   // expect zero rows of type 'error'
```

Importing it (rather than fetching it) is what runs the `#include` resolver, so
this checks the same text a real consumer would get. Note **headless Chrome
returns a null adapter**, so this cannot currently be automated in CI — it needs
a real browser window.

## Layout

| Path | Role |
|---|---|
| `tools/wgslInclude.ts` | The `#include` resolver + its Vite plugin |
| `tools/generate_web_data.py` | Emits the generated JSON below |
| `src/gpu/` | Stateless GPU helpers — the `shared/` analogue (invariant 1) |
| `src/app/` | Canvas surface and sizing |
| `src/particleSystem/` | `coords`, `sizing`, `config`, `pack`, `layout` — the pure leaves |
| `src/camera/` | `cameraState` — pan/zoom/mode, no GPU |
| `src/testing/` | Test-only access to the parity goldens |
| `src/shaders/` | Shared shaders — `common.wgsl`. Per-module `shaders/` dirs arrive in Steps 4–5 (invariant 6) |

## Generated data

Two JSON files are produced by Python and **committed to git**:

| File | Contents |
|---|---|
| `src/particleSystem/layout.generated.json` | Struct sizes, member offsets, float-lane indices, parsed out of `common.glsl` |
| `tools/parity.generated.json` | Golden values produced by *calling* the desktop Python functions |

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
