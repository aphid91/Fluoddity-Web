# Pre-Port Cleanup Plan

**Date:** 2026-07-28 · **Branch:** `reorg-modular-structure` · **Status:** not started

This is the executable work plan derived from `docs/PORT_AUDIT.md`. It exists so an
implementing agent (or human) can do the cleanup without the conversation that produced
it. Scope was decided by the user on 2026-07-28: **Full Cleanup**, plus two
port-readiness code changes (**canvas/field → fp16** and **async particle selection**).

## Before you start

- Read `docs/ARCHITECTURE.md` in full, then `docs/PORT_AUDIT.md`. This plan cites both.
- **Preserve the hot-reload contract** (`CLAUDE_README.md`): shader setup in isolated
  reload helpers; failed compiles never crash — keep the last working program; `tryset()`
  for all uniforms.
- After any shader-adjacent change: run the app, press `U` (hot reload), click-select a
  particle, and run the mutation probe test (the GPU-vs-host comparison referenced at
  `mutation.py:21-23` / `selection_commands.py:10-11`).
- **Commit granularity: one commit per lettered item** (A1, A2, B1, …). Phase D items
  must be their own commits, separate from cleanups, so each can be reverted
  independently.
- Update `docs/ARCHITECTURE.md` in the same commit as the change it describes (the
  specific amendments are listed per item and collected in Phase F).
- File:line references were verified 2026-07-28; line numbers will drift as phases land.
  Anchor on the quoted names, not the numbers.

---

## Phase A — Bugs (user-visible; do first)

### A1. Fix the TooltipGraphic reload crash

**Where:** `ui/tooltip_graphic.py:71-87`; caller `orchestrator/orchestrator.py:576-584`.
**Problem:** `_build_program()` compiles unguarded and `reload()` re-raises into
`_cmd_reload`, which has no try/except — a typo in `tooltip_graphic.frag` + pressing `U`
terminates the app. The docstring ("costs the tooltip's appearance rather than the
session") describes behaviour the code does not have.
**Fix:** match the pattern of the other six modules: wrap compilation in try/except,
assign `self._program`/`self._vao` only on success, print the error on failure. Fix the
docstring to match the (now true) behaviour.
**Verify:** put a syntax error in `tooltip_graphic.frag`, press `U` → app lives, error
printed, diagram keeps its old appearance. Fix the shader, press `U` → recovers.

### A2. Fix the tool numbers in the drawing window help text

**Where:** `ui/drawing_window.py:82,87` — says "Shove tool [3]" and "Draw tool [4]".
**Fix:** Shove is `[2]`, Draw is `[3]` (see `ui/toolbar.py:28-32`; keys are `1`/`2`/`3`).
**Verify:** open the Drawing window, read the text; press `2`/`3` and confirm they match.

---

## Phase B — Design-rule violations & duplication

### B1. Deduplicate `aspect_correct_uv` (rule 9)

**Where:** verbatim copies at `strafe_field/shaders/strafe_draw.frag:29-32` and
`assembler/shaders/frame_assembly.frag:74-77`.
**Fix:** move the function into `shared/shaders/common.glsl` beside `world_half_extent`
(it is that function applied as a scale — say so in a comment). Delete the copy in
`frame_assembly.frag` (it already includes `common.glsl`). Add `#include "common.glsl"`
to `strafe_draw.frag` — `read_shader`'s resolver looks in the sibling dir then
`shared/shaders` (`shared/gl_utils.py:62-70`), so no path work is needed.
**Watch out:** including `common.glsl` pulls its struct declarations and helpers into
`strafe_draw.frag`; that is harmless (they compile unused) but confirm the shader still
compiles via `U`.
**Verify:** set a non-square canvas aspect in Preferences; brush stroke and reticle stay
circular; erase radius still matches the ring.

### B2. Deduplicate the sizing constants

**Where:** `particle_system/particle_system.py:12-15` (dead constant chain
`WORLD_SIZE`/`SQRT_WORLD_SIZE`/`ENTITY_COUNT`/`CANVAS_DIM`) vs `sizing_for()` at
`:36-43`, which independently hardcodes the same `600000` and `1024`.
**Fix:** delete the four dead constants. Name the two magic numbers once —
`ENTITIES_PER_WORLD_UNIT = 600_000`, `BASE_CANVAS_DIM = 1024` — and have `sizing_for()`
use them. If B6's relocation happens, these constants move with `sizing_for`.
**Verify:** grep shows each literal exactly once; app starts; World Size change still
rebuilds at the same entity/canvas counts as before.

### B3. Single pick-parameter builder; delete dead `_update_pick`

**Where:** `orchestrator/orchestrator.py:485-506` (`_update_pick`, **zero callers** —
`self.hovered` is permanently MISS) duplicates
`orchestrator/selection_commands.py:76-91` (`_pick_at`).
**Fix:** executed as part of D2. Extract one helper that builds the pick inputs
(screen→world target via `coords.screen_to_world`, pixel radius via
`radius_px_to_world`) and delete `_update_pick`. Decide the `hovered` status/debug
readout honestly: delete it, or drive it from the async retrieve (meaningful only on
click frames). Do not leave a readout that can never populate.
**Verify:** debug panel no longer shows a permanently-empty `hovered` row (or shows a
live one); selection still works.

### B4. Collapse the duplicate snapshot commands

**Where:** `orchestrator/project_commands.py:165-175` and
`orchestrator/clipboard_commands.py:79-87` — byte-identical bodies; both write the
**same** `self._preview_origin` slot, so the per-surface isolation the split implies
does not actually hold at the Orchestrator level (it holds only because both hover
surfaces are submenus that cannot be open at once).
**Fix (preferred):** move the preview-origin into `ui/hover_preview.py`'s
`PreviewSession` so each surface structurally owns its own origin — this is what that
file's design notes already intend ("snapshot_configs returns the snapshot rather than
storing it"). The commit path then records history against the origin carried by the
session that committed. Collapse the two commands into one handler wired to both names.
**Fix (minimal fallback):** keep one method wired to both command names, with a comment
stating `_preview_origin` is shared and why that is safe today.
**Verify:** hover-preview in File > Load and Edit > Load Checkpoint… both still restore
on unhover/close and commit on click; a committed load records ONE history entry whose
undo returns to the pre-browsing state (ARCHITECTURE "Recording against the right
state").

### B5. Extract the shared browser-row widget

**Where:** `ui/config_menu.py:229-279` (`_load_entry`) vs `:346-377`
(`_checkpoint_entry`) — same layout discipline, same width computation, same style
push/pop; diverge only in delete semantics (confirm-dialog vs immediate).
**Fix:** one `_browser_entry(...)` helper parameterized on the delete behaviour (e.g. a
`confirm_delete: bool` or a delete-callback).
**Verify:** both submenus render identically to before; delete flows unchanged (file
delete still confirms, checkpoint delete still doesn't).

### B6. Make the cross-module import policy honest

**Where:** three imports contradict ARCHITECTURE's "modules never reference each other":
`camera/camera_state.py:21` (coords), `strafe_field/strafe_field.py:32`
(`canvas_dimensions` from `particle_system.particle_system` — the *implementation*
module, dragging `layout.py`'s common.glsl parse into strafe_field's import graph),
`project/project.py:43` (config value types).
**Fix, two moves:**
1. Relocate `canvas_dimensions` + `sizing_for` (+ the B2 constants) into a leaf module —
   `particle_system/sizing.py` (new) or into `coords.py`. `strafe_field` then imports
   the leaf. `particle_system.py` imports it too (no behaviour change).
2. Amend `docs/ARCHITECTURE.md`: the rule becomes "modules never reference each other's
   *stateful* classes; `particle_system`'s leaf modules (`coords`, `config`, `sizing`)
   are sanctioned pure/value imports". Do NOT move these to `shared/` — they are domain
   code, and ARCHITECTURE already names `coords.py` as one of the two homes of the view
   math.
**Verify:** `python -c "import strafe_field"` no longer triggers the layout parser;
app runs; grep confirms no module imports `particle_system.particle_system` except
orchestrator.

### B7. One source of truth for status defaults

**Where:** ~60 `self._status.get(...)` sites re-declare defaults;
`ui/config_manager.py:51` hardcodes `64` (duplicating `MAX_CONFIGS` from
`particle_system.py:52`); `ui/drawing_window.py:38-68` duplicates the defaults in
`preferences/preferences.py:65-79`.
**Fix:** make `_report_status()` (`orchestrator.py:508-550`) the single guarantor: it
always supplies every key. UI sites switch from `.get('key', default)` to
`self._status['key']` — a KeyError then means a real bug (a key the Orchestrator forgot),
not a silent default. Declare the key set once beside `_report_status` (a `STATUS_KEYS`
tuple or a documenting comment block) so the 27-key interface is enumerable. Keep
`.get()` only where a key is legitimately optional, and say why inline.
**Watch out:** the first frame — `set_status` must have run before any window reads.
`_report_status()` is called every frame before `UI.end_frame()` builds panels
(ARCHITECTURE "Control & data flow"), so this holds; confirm rather than assume.
**Verify:** grep for `_status.get` leaves only the documented-optional cases; open every
window; app runs a full session without KeyError.

---

## Phase C — Dead code removal

One commit. Each item verified zero-caller on 2026-07-28 — re-verify with grep before
deleting (later phases may have changed things).

**Delete:**
- `particle_system/coords.py`: `world_wrap`, `world_to_screen`, `visible_world_bounds`.
  Keep the internal composition steps of `screen_to_world` (`uv_to_world`,
  `world_to_ndc`, `ndc_to_world`, `letterbox_scale`, `world_to_screen_ndc`,
  `screen_ndc_to_world`, `screen_to_ndc`, `ndc_to_screen`) — they are load-bearing.
  Check `IDENTITY_PAN`/`IDENTITY_ZOOM` for callers before deciding.
- `project/project.py:81` `world_for_upload` (superseded by
  `ParticleSystem.current_world_config()`).
- `ui/input_state.py:85-89` `key_held()` / `key_pressed()`.
- `ui/hover_preview.py:48-54` `is_open` / `previewing` properties.
- `project/history.py:199-201` `clear()`.
- `ui/config_manager.py:37` the dead UI-local `self._manager_message`.
- `particle_system/persistence.py:35` the unused `replace` import.
- `shared/__init__.py` the unused `MUTED_TRYSET_WARNINGS` re-export.

**Repo hygiene (same commit):**
- Delete the vestigial `input/` directory (contains only `__pycache__/`) and the stale
  root `__pycache__/`.
- Add `__pycache__/` and `imgui.ini` to `.gitignore`; `git rm --cached imgui.ini`.
  Rationale: imgui rewrites it every session; `preferences.json` is already ignored and
  the two persistence files should be consistent. (If a canonical default layout is
  wanted later, ship it as `default_imgui.ini` the way `Reference/` does — out of scope
  here.)

**Deliberately KEPT — do not "clean" these:**
- The `implemented=False` machinery in `ui/settings_spec.py` (~8 lines, documented
  scaffolding at `:50-52`).
- The `KEY_4` headroom in the tool-hotkey zip (`ui/ui.py:456-457`) — deliberate, `zip`
  truncates.
- The LEGACY v7 block in `persistence.py:213-242` + its two marked call sites — its
  removal is a pre-port *revert* per ARCHITECTURE ("Legacy config support"), not
  cleanup. Note `persistence.py:128` carries a second, unrelated "LEGACY" marker (a
  v8-internal rename) that is NOT part of the v7 block.

---

## Phase D — Port-readiness changes (own commits; revertible independently)

### D1. Canvas + strafe field → RG16F

**Why:** base WebGPU can neither filter nor blend `rg32float` (PORT_AUDIT §1a); both
would need optional device features, and `float32-blendable` support is thin.
`rg16float` is filterable, renderable, and blendable in base WebGPU, keeps the
2-channel shape (no shader `out vec2` widening, unlike rgba16float), and halves
bandwidth. Decision made 2026-07-28: the chassis switches now, so the spec *is* what
the port builds.

**Change:**
- `particle_system/particle_system.py:95,100` — canvas + back buffer: `dtype='f4'` →
  `dtype='f2'` (still 2 components).
- `strafe_field/strafe_field.py:87` — same.
- Untouched: camera accumulator/bloom (already fp16), tooltip (rgba8).
- Update the RG32F mentions in `docs/ARCHITECTURE.md` ("Strafe Field" §, "Resolution:
  capped" § — the 8-bytes/texel arithmetic there halves) and add a companion note to
  rule 7 that texture formats, like struct layouts, are chosen to be
  base-WebGPU-compatible.

**Precision verification (this is the real work):** `brush.frag:30-33` deposits
`velocity * premult` where `premult = (1-P)/P` spans ~1e-3 (P=0.999) to ~1e4 (P=1e-4).
fp16: max 65504, min normal ~6.1e-5, subnormals to ~6e-8, 11-bit mantissa.
Protocol:
1. A/B run (`'f2'` vs `'f4'`) across the shipped presets in `configs/` — especially
   extreme trail-persistence ones — plus a selection of `configs/custom/`.
2. Look for: trail banding/quantization, overall dimming or brightening, hot-spot
   saturation (values clipping at 65504), behavioural drift in the *simulation* (the
   sensors READ this texture — precision loss feeds back into physics, it is not just
   cosmetic).
3. Let each run sit several minutes; accumulation artifacts appear over time.
4. **Record the verdict in `docs/PORT_AUDIT.md` §1a either way.**
**Fallback if degraded:** a fixed scale factor on the deposit/read pair (shift the
range into fp16's sweet spot), or revert to RG32F and record that the port must require
`float32-filterable` + `float32-blendable`.

### D2. Async particle selection (retire `pick_blocking` from the live path)

**Why:** `pick_blocking()` (`particle_system/particle_system.py:314-325`) stalls on
`ctx.finish()` — no WebGPU equivalent — and despite its docstring it is on the primary
click path: `selection_commands.py:76-91` `_pick_at` → `_cmd_select_particle` (`:106`)
→ every SELECT-mode left-click (`orchestrator.py:394-397`). The async two-phase shape
already exists and is the documented design (`picker.py` request/retrieve, one-frame-old
result; ARCHITECTURE "Entity picking") — it is just unused (see B3).

**Change:**
- Extract the shared pick-parameter builder (B3).
- On SELECT-click: build params, call `system.pick()` (dispatches the compute
  reduction), and stash a pending-selection record capturing **`before = self.project`
  at click time** — history must record against the pre-click project
  (`selection_commands.py:115-117`; ARCHITECTURE "Recording against the right state").
- Next frame, early (before `advance()`, same slot where picking already sits in the
  frame order): if a pending selection exists, `retrieve()` the result; on hit → adopt
  the rule and record history against the captured `before`; on MISS → drop it silently.
- A second click while one is pending: simplest correct rule is to replace the pending
  record (last click wins); its `before` should then be the project state at *that*
  click. State the chosen rule in a comment.
- `pick_blocking()` retreats to tests/tooling only — its docstring becomes true. Keep
  it; do not delete (the probe/test tooling wants it).
- Delete `_update_pick` and resolve the `hovered` readout (B3).
- Update ARCHITECTURE "Entity picking": the "must not be used in the render loop"
  sentence now describes reality; note the pending-selection mechanism.

**Verify:**
- Click-select adopts the same particle a `pick_blocking` call would (write a
  test/assertion comparing the two on the same frame).
- History: click-select then Ctrl+Z returns exactly to the pre-click project; rapid
  successive clicks don't cross-wire `before` states.
- Feel: the ~1-frame (~16ms) added latency is imperceptible.
- Pause interaction: clicking while paused should still select (the pick reads the
  entity buffer; `advance()` being skipped must not starve the retrieve — confirm the
  retrieve happens in the frame loop, not inside `advance()`).

---

## Phase E — Structural refactors (Full-Cleanup items)

### E1. Consolidate the eight shader-reload blocks

**Where:** the same try/compile/keep-old/print shape at `camera/camera.py:108-151`
(×3), `assembler/assembler.py:58-78`, `strafe_field/strafe_field.py:104-132`,
`assembler/bloom.py:66-97` (×2), `particle_system/particle_system.py:240-259` — plus
`tooltip_graphic` after A1. ~70 duplicated lines.
**Fix:** one helper in `shared/gl_utils.py` (the sanctioned home), shaped like:
`reload_program(ctx, vert_path, frag_path, label, old_program, old_vao, vbo) -> (program, vao)`
— returns the new pair on success (printing the success line), the old pair on failure
(printing the error). Callers assign the result unconditionally. Compute-shader reloads
(`particle_system.py`, `picker.py`) need a compute variant or a small parallel helper.
**Also unify the constant-uniform convention:** every module re-sets its
lifetime-constant uniforms in a `_set_constant_uniforms()` called after reload (pattern:
`particle_system.py:144-156`); `strafe_field.py:128` currently inlines this inside
`reload()` — move it to match.
**Constraint:** the hot-reload contract must hold exactly — failure keeps the last
working program; a fresh program starts with uniforms unset, so constants are re-set
after every successful reload.
**Verify:** `U` with all shaders valid → everything reloads; `U` with a typo in each of
several shaders → app lives, old visuals persist, error names the file; fix → recovers.

### E2. Split `ui/settings_window.py` (681 lines, four jobs)

**Where:** (1) registry renderer `_render_setting`/`_draw_widget`/`_shown`/`_stored`
(lines 240-392) — stays; (2) `_draw_curved_slider` (394-449) — extract to
`ui/curved_slider.py`; (3) Revert button + tooltip + entry resolution (154-224) —
stays; (4) the sensor diagram panel + drag state machine (531-659, incl.
`_diagram_hovered`/`_diagram_open`/`_diagram_anchor`, cleared at four exit paths) —
extract to `ui/sensor_diagram.py`.
**Precedent:** `ui/gated_controls.py` is exactly this kind of extraction.
**Fix:** pure mechanical move; the mixin keeps thin delegating calls or imports the
functions. No behaviour change.
**Verify:** curved sliders (Hazard Rate) still bend and read out correctly; the sensor
diagram still opens on hover, pins, drags both handles, and closes at all four exit
paths.

### E3. Give `show_advanced` one home

**Where:** declared by `SettingsWindow._init_settings_window`
(`ui/settings_window.py:72`), written by PreferencesWindow
(`ui/preferences_window.py:58-62`), read by both; works only via the shared mixin
namespace and the silent init-order requirement at `ui/ui.py:115-116`.
**Fix:** declare it in `UI.__init__` (`ui/ui.py`) as shared cross-window view state,
with a comment naming both consumers; the mixin `_init_*` methods stop declaring it.
**Verify:** tier radio in Preferences still governs both windows; no attribute errors
regardless of which window opens first.

### E4. Move `tooltip_graphic` out of `ui/`

**Where:** `ui/tooltip_graphic.py` is a moderngl-owning module inside a package that
must not touch GL; the orchestrator constructs it (`orchestrator.py:131`) by importing
past the package `__init__` (`orchestrator.py:54`).
**Fix:** promote to its own top-level module folder `tooltip_graphic/` (with
`__init__.py` re-exporting the class and its `shaders/` folder holding
`tooltip_graphic.frag`), matching every other GPU module. Orchestrator owns one and
hands the texture ref to the UI exactly as today. Update the ARCHITECTURE module table
with a row for it.
**Verify:** sensor tooltip diagram still renders and animates; `U` reloads its shader
(after A1, safely).

### E5. One save-error channel

**Where:** `ui/config_menu.py:467` reads the Orchestrator's `save_error` from status
*synchronously right after dispatch* — a call-stack-synchrony coupling that breaks under
any async command bus (the port's, for one). The UI-local `_save_error` also carries
pre-dispatch validation ("Enter a filename.", `:462`) the Orchestrator never sees — two
overlapping channels.
**Fix:** render the save-dialog error from `self._status` **every frame** (no
read-after-dispatch); keep a separately-named UI-local field (`_save_validation`) for
pre-dispatch validation only, cleared on dispatch. Comment why the two channels are
distinct (one is the Orchestrator reporting an attempted save; one is the UI declining
to dispatch at all).
**Verify:** attempt to save with an empty name → validation message; save to an invalid
path (e.g. illegal characters surviving sanitize, or a read-only dir) → orchestrator
error appears and persists across frames; successful save clears both.

### E6. Stop assigning `ParticleSystem.config_path` from outside

**Where:** `orchestrator/project_commands.py:59,116,134,210` (and `_rebuild_system`)
do `self.system.config_path = str(path)` — the only cross-module attribute assignment
in the codebase.
**Fix:** fold the path into `apply_project()` (preferred if it is truly project-coupled
— it names where the project came from) or add a narrow `set_config_path()` setter.
Pick one; note the choice in ARCHITECTURE rule 2's discussion of accessors.
**Verify:** save/load/revert (Ctrl+R) still target the right file; window title still
tracks the loaded config.

### E7. One access convention on ParticleSystem

**Where:** `entity_count()` is a method; `frame_count`/`canvas_size` are bare attribute
reads; `entity_buffer` is handed out raw (`orchestrator.py:312,314,549`).
**Fix:** unify — recommend plain attributes/properties for all cross-boundary reads
(the codebase already reads attributes elsewhere), so `entity_count()` becomes a
property or attribute. State the convention in ARCHITECTURE rule 2 ("public data via
typed values; GPU resources via narrow accessors" — add: "simple scalar state via
read-only attributes").
**Verify:** grep for `entity_count(` call sites updated; app runs.

### E8. Rename `StrafeField.canvas_size`

**Where:** `strafe_field/strafe_field.py:82` — it is the **field's** resolution, which
diverges from the canvas once `MAX_FIELD_DIM` bites, while
`ParticleSystem.canvas_size` genuinely is the canvas. The name invites passing the
wrong one (skewed strokes at large world sizes).
**Fix:** rename to `field_size`. Call sites: `orchestrator/drawing_commands.py:53` and
any others grep finds. The shader side uses `textureSize` — unaffected. Keep the
comment at `:78-81` ("everything downstream must read this, never the canvas size"),
which becomes even clearer under the new name.
**Verify:** draw at a world size large enough that the cap engages (canvas > 512²
equivalent); strokes land under the cursor and stay circular.

---

## Phase F — Doc & comment corrections

Small, and several belong inside earlier commits (noted there). The rest:

- `shared/shaders/common.glsl:229` — "`.y` is written but not yet consumed" is false;
  it is consumed at `camera/shaders/cam_brush.frag:63` (Color By Cohort). Rewrite to
  say `.y` carries the cohort index for the renderer.
- `orchestrator/orchestrator.py:18` — remove the stale self-metrics ("24 handlers in
  574 lines"; now 29/599). Describe the shape, not the count — counts rot.
- `ui/ui.py:55` — the docstring enumerates 4 commands; 29 are wired. Point at the
  command dict (`orchestrator.py:196-235`) instead of enumerating.
- `particle_system/particle_system.py` `reset()` — document that `frame_count = 0` IS
  the reset: it is the GPU-side sentinel that regenerates entities and clears the
  canvas (`entity_update.glsl:384`, `canvas.frag:39`, `brush.frag:24`).
- `docs/ARCHITECTURE.md` amendments (each in its item's commit where possible):
  - B6: the import policy for `particle_system` leaf modules.
  - D1: RG32F → RG16F in the Strafe Field and resolution sections; rule-7 companion
    note on formats.
  - D2: "Entity picking" reflects the async click path; `pick_blocking` note becomes
    true.
  - E4: module table row for `tooltip_graphic/`.
  - Strike resolved "Deferred / known follow-ups" entries (`_update_pick`/hovered,
    the pick duplication) and add any new ones this work creates.

---

## Deliberately out of scope (do not re-litigate)

Recorded so a future cleanup pass doesn't reopen them:

- **Mediator → event bus.** ARCHITECTURE explicitly defers this until the wiring is
  unwieldy. The audit's finding is that the pressure point is the two untyped string
  interfaces (29-command dict, 27-key status dict), and B7 addresses the worst of it.
  Typing those interfaces fully is the *port's* job (they become the TS API).
- **`print()` → logging framework.** Fine for a live-coding teaching tool; a framework
  is weight the project ethos rejects.
- **`tryset`'s silent-miss behaviour.** It IS the hot-reload affordance. The port loses
  it anyway (WebGPU UBOs have no "optimized-out uniform" concept — PORT_AUDIT §5).
- **Per-frame `_settings_dicts` cost.** Already guarded behind "a settings window is
  open" (`orchestrator.py:554-561`).
- **LEGACY v7 removal and multi-config editing removal.** Pre-port *reverts*, staged by
  design (ARCHITECTURE "Features scoped for removal"), executed when the port begins —
  not cleanup.

## Completion checklist

- [ ] A1, A2 — bugs
- [ ] B1–B7 — rule violations & duplication
- [ ] C — dead code + repo hygiene
- [ ] D1 — RG16F switch, **with recorded precision verdict in PORT_AUDIT.md**
- [ ] D2 — async selection
- [ ] E1–E8 — structural refactors
- [ ] F — doc corrections; ARCHITECTURE.md consistent with the code again
- [ ] Full manual pass: every preset loads; save/load/delete; undo/redo; checkpoints;
      all three tools; pause; camera modes; hot reload with and without shader errors;
      mutation probe test green
