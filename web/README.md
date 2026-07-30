# Fluoddity — WebGPU port

The TypeScript/WebGPU port of the Python app in the parent directory. The plan
is `docs/WEB_PORT_PLAN.md`; the design contract it must honour is
`docs/ARCHITECTURE.md`, whose 10 invariants are the spec.

**Status: Step 1 of 10 complete.** Scaffold, device acquisition, canvas sizing,
and the WGSL `#include` resolver. There is no simulation yet — the canvas is
black on purpose, and a black canvas is the expected successful output.

## Running it

Requires Node 20+ (developed against v24.18.0) and a WebGPU-capable browser —
current Chrome or Edge, or Safari 26+.

```
npm install
npm run dev        # dev server at http://localhost:5173
npm test           # resolver unit tests
npm run typecheck  # tsc --noEmit, strict
npm run build      # typecheck + production build
```

## Layout

| Path | Role |
|---|---|
| `tools/wgslInclude.ts` | The `#include` resolver + its Vite plugin |
| `src/gpu/` | Stateless GPU helpers — the `shared/` analogue (invariant 1) |
| `src/app/` | Canvas surface and sizing |
| `src/shaders/` | Shared shaders. Per-module `shaders/` dirs arrive in Steps 4–5 (invariant 6) |

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
