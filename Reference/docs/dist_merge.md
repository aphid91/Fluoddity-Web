SimpleSplat → dist Merge Analysis
Context
SimpleSplat (f1882bdb) has diverged significantly from dist (65fdb467). Many features are desirable for dist, but SimpleSplat also contains experimental/abandoned work and a fundamental physics model change (velocity → atomic splatting / heading-based steering) that should stay on SimpleSplat only. The goal is to cherry-pick the good optimizations and new features while keeping dist's instanced-rendering + velocity physics model.

Bucket 1: Canvas Pipeline Optimization (THE BIG WIN)
Files: sim.py, shaders/canvas.frag, shaders/brush.frag, shaders/entity_update.glsl, shaders/frame_assembly.frag, camera.py, utilities/frame_assembler.py, simulation_runner.py

The core performance improvement: eliminating the brush texture middleman and reducing canvas from 4-channel RGBA to a single 2-channel RG32F texture. Instanced rendering (brush pipeline) writes directly to the canvas. No MRT needed.

#	Change	Merge?	Notes
1.1	Remove brush texture as middleman — brush pipeline renders directly to canvas instead of to a separate texture that canvas.frag later mixes in. self.brush_tex / self.brush removed. canvas.frag no longer reads brush_tex.	MERGE	The instanced brush render writes pre-scaled values directly to canvas. canvas.frag just applies can_color * trail_persistence (no more p*can + (1-p)*brush mixing). The brush render must pre-scale its output by (1-p)/p so that the *p in canvas.frag yields the correct (1-p)*splat contribution.
1.2	4-channel RGBA canvas → single RG32F texture — canvas only stores 2 velocity channels (R=X, G=Y). Single texture, not two R32F textures (the X/Y split was for atomics only). Double-buffered as before.	MERGE	Halves VRAM and bandwidth. No MRT needed — just a single 2-component texture per buffer.
1.3	canvas.frag rewritten for 2-channel — getCan() returns vec2, getBlur() returns vec2, output is vec2 (written to RG channels). Formula becomes just can_color * trail_persistence.	MERGE	Follows from 1.1 + 1.2.
1.4	brush.frag adapted for 2-channel + pre-scaling — output RG only (velocity), pre-scaled by (1-p)/p where p = trail_persistence.	MERGE	New behavior: brush writes scaled splats directly to canvas with additive blending.
1.5	frame_assembly.frag: canvas debug view uses RG texture — reads .rg from a single 2-channel texture instead of separate samplers. No input_frame_y needed.	MERGE	Simpler than SimpleSplat's approach since we have a single RG texture.
1.6	frame_assembler.py: minor adaptation for single RG canvas texture in debug view. No canvas_y_texture parameter needed.	MERGE	Follows from 1.5.
1.7	Remove self.can and self.canvas aliases — use can_textures[can_read_index] directly (as SimpleSplat does with can_x_textures).	MERGE	Cleaner API.
1.8	Atomic splatting code in entity_update.glsl (imageAtomicAdd, can_img_x, can_img_y, TRAIL_PERSISTENCE_SETTING for splat scaling).	NO	dist keeps instanced brush rendering.
1.9	GL_NV_shader_atomic_float extension in fourier4_4.glsl	NO	Only needed for atomic splatting.
Summary for Bucket 1
Replace RGBA canvas with RG32F. Remove brush-as-middleman: instanced brush renders pre-scaled (1-p)/p values directly to canvas with additive blending. canvas.frag simplifies to can_color * trail_persistence. No MRT, no separate X/Y textures.

Bucket 2: Entity Struct Optimization (PARTIAL MERGE)
Files: shaders/entity_update.glsl, shaders/cam_brush.vert, shaders/brush.vert, sim.py, services/entity_picker.py

#	Change	Merge?	Notes
2.1	Slim entity struct — from 48 bytes (pos:2, vel:2, size:1, cohort:1, padding:2, color:4) to 32 bytes: pos:2, vel:2, hue:1, size:1, padding:2. Remove cohort (compute from index) and color vec4 (compute from hue in shader).	MERGE	Good optimization. Cohort = num_cohorts * index / ACTIVE_COUNT. Color HSV built from hue field in cam_brush.vert.
2.2	SIZE_OF_ENTITY_STRUCT updated from 4*12 → 4*8 (32 bytes).	MERGE	Follows from 2.1.
2.3	entity_picker.py: cohort computed from index — no longer reads from entity struct. find_nearest_entity gains num_cohorts/active_count params.	MERGE	Follows from 2.1.
2.4	cam_brush.vert: compute color from hue — view_col = vec4(hue, 0.8, 1.0, 0.045) instead of reading entities[i].color.	MERGE	Follows from 2.1.
2.5	entity_update.glsl: reset() computes cohort from index — float(cohorts) * float(index) / float(ACTIVE_COUNT) instead of storing in struct.	MERGE	Follows from 2.1.
2.6	entity_update.glsl: color → hue — e.hue = hue_sensitivity * col_params.x instead of setting e.color vec4. color_by_cohort sets e.hue instead of e.color.x.	MERGE	Follows from 2.1.
2.7	Velocity replaced with heading (dir float) — ENTITY_VEL(e) macro, rotation-based steering, calculate_entity_behavior outputs rotate+trail.	NO	Core SimpleSplat physics departure. dist keeps vel vec2.
2.8	Boundary bounce rewired for heading	NO	Follows from 2.7.
2.9	Force/strafe field interaction commented out	NO	dist keeps force/strafe on velocity.
2.10	Reset mode changes — grid 2* scaling, random 64-iteration rejection sampling.	NO	Experimental SimpleSplat behavior.
Bucket 3: Recursive SDF / 3D Raymarching System (NO MERGE)
Files: controller_input.py, main.py, simulation_runner.py, utilities/advanced_drawing.py, shaders/field_override/march.frag, state/preferences_state.py, state/ui_state.py, ui/recursion_window.py, command_handler.py

#	Change	Merge?	Notes
3.1	ControllerCam rewritten — yaw/pitch → explicit pos/fwd/up vectors, Rodrigues rotation, teleportation	NO	Recursion-specific. dist's yaw/pitch controller is fine.
3.2	Vector helpers (_norm, _rodrigues, _axis_angle, etc.)	NO	Recursion infrastructure.
3.3	Recursive SDF teleportation loop in main.py	NO	Recursion logic.
3.4	march.frag massively expanded — bird/bulb scene, 3-cell recursive map, AO, soft shadows	NO	SimpleSplat-specific SDF art.
3.5	advanced_drawing.py: recursion uniforms	NO	Recursion infrastructure.
3.6	RecursionWindowMixin	NO	Recursion UI.
3.7	PreferencesState: recursion fields	NO	Recursion state.
3.8	request_recursion_recompile flag	NO	Recursion support.
3.9	simulation_runner.py: recursion override params	NO	Recursion plumbing.
Bucket 4: Generics (Live-Coding Scratch Uniforms) — MERGE
Files: ui/generics_window.py (new), ui/core.py, ui/menu_bar.py, state/preferences_state.py, simulation_runner.py, shaders/entity_update.glsl, utilities/advanced_drawing.py, sim.py

#	Change	Merge?	Notes
4.1	GenericsWindowMixin (ui/generics_window.py) — 8 float sliders (-1..1). Add helper text at top: "Live-Coding Scratch Uniforms" and list uniform names (generic03, generic47) and which shaders they appear in (entity_update.glsl, field override shaders).	MERGE	
4.2	PreferencesState: show_generics_window, generic0–generic7	MERGE	
4.3	Menu bar: Generics checkbox	MERGE	
4.4	UI core.py: GenericsWindowMixin added to mixin list	MERGE	
4.5	simulation_runner.py: builds generics tuple, passes to sim.update()	MERGE	
4.6	entity_update.glsl: uniform vec4 generic03, uniform vec4 generic47	MERGE	Declare both.
4.7	advanced_drawing.py: passes generics to override shader	MERGE	
4.8	sim.py entity_update(): accepts generics param	MERGE	
Bucket 5: Histogram Plotting System — MERGE
Files: plotting_manager.py (new), shaders/histogram_render.frag (new), shaders/histogram_render.vert (new), ui/plotting.py (new), ui/core.py, ui/menu_bar.py, state/preferences_state.py, main.py, simulation_runner.py, command_handler.py, shaders/entity_update.glsl

#	Change	Merge?	Notes
5.1	PlottingManager class (plotting_manager.py)	MERGE	
5.2	histogram_render.frag/vert	MERGE	
5.3	PlottingWindowMixin (ui/plotting.py)	MERGE	
5.4	entity_update.glsl: report() function + ReportsBuffer SSBO	MERGE	Adapt the hardcoded report(length(ltap-rtap), 0) call for dist's vec4 canvas taps (use .xy channels).
5.5	main.py: PlottingManager instantiation	MERGE	
5.6	simulation_runner.py: plotting lifecycle	MERGE	
5.7	command_handler.py: plotting_manager.reload_shader()	MERGE	
5.8	PreferencesState: show_plotting_window	MERGE	
5.9	Menu bar: Plotting checkbox	MERGE	
Bucket 6: Small Independent Improvements
Files: various

#	Change	Merge?	Notes
6.1	Remove emboss entirely — delete emboss combo box, emboss_mode field, emboss_intensity, emboss_smoothness, emboss texture handling in main.py / simulation_runner.py / frame_assembly.frag / frame_assembler.py. Ignore emboss fields in config_saver loads (don't crash on old saves, just discard).	MERGE	Full excision. No more emboss at all.
6.2	tryset_mat3() added to gl_helpers.py	MERGE	Generally useful.
6.3	shader_prepend() used in advanced_drawing.py for #define injection	MERGE	Useful for future define-based shader variants.
6.4	Remove Brush debug view option — keep only 'DEBUG - Canvas (Persistent particle trails)' and cam_brush. Remove the second view option that was "Brush".	MERGE	Brush is no longer a separate texture.
6.5	fourier4_4.glsl: GL_NV_shader_atomic_float extension	NO	Atomic splatting only.
6.6	camera.py: WORLD_SIZE uniform to cam_brush.vert	NO	dist keeps e.size from entity struct; no need for computed ENTITY_SIZE.
6.7	frame_assembly.frag: field overlay simplified	NO	dist keeps force/strafe HSV overlay.
6.8	Emboss uses cam_brush_target	NO	Emboss removed entirely (6.1).
6.9	Arrow debug uses can_textures / get_canvas_dimensions()	MERGE	Follows from Bucket 1 canvas refactor.
Bucket 7: Abandoned / Demo-Only Content (NO MERGE)
Files: demos/ (all files)

#	Change	Merge?	Notes
7.1	demos/mapping_ui/	NO	Standalone experiment.
7.2	demos/self_sim/	NO	Prototype for recursion system.
Recommended Merge Order
Phase A: Canvas Pipeline + Entity Struct (Buckets 1 + 2 partial)
The biggest perf wins, tightly coupled. Touch the same core files.

sim.py: Replace RGBA canvas with RG32F double-buffered textures. Remove self.can/self.canvas aliases. Remove self.brush_tex/self.brush. Brush renders directly to canvas FBO. Entity struct → 32 bytes.
brush.vert/.frag: Adapt to 2-channel output, pre-scale by (1-p)/p.
canvas.frag: 2-channel read/write. can_color * trail_persistence only.
entity_update.glsl: Entity struct change (keep vel, add hue, remove cohort/color). Cohort from index.
cam_brush.vert: Updated entity struct, color from hue.
frame_assembly.frag: 2-channel canvas debug view. Remove emboss sampling. Keep force/strafe overlay.
frame_assembler.py: Adapt for RG texture in debug view. Remove emboss params.
entity_picker.py: Cohort from index.
config_saver.py: Ignore emboss on load.
Phase B: Generics System (Bucket 4)
Clean, independent feature. Small touchpoints.

Add ui/generics_window.py (with helper text listing uniform names + shaders)
Add preferences fields, menu bar toggle
Wire through simulation_runner → sim.py → entity_update.glsl + advanced_drawing.py
Phase C: Plotting / Histogram System (Bucket 5)
Clean, independent feature.

Add plotting_manager.py, histogram shaders, ui/plotting.py
Wire through main.py, simulation_runner, command_handler
Adapt report() call in entity_update.glsl for dist's vec4 canvas taps
Phase D: Small Cleanups (Bucket 6)
tryset_mat3 helper
shader_prepend in advanced_drawing.py
Full emboss excision
Remove Brush debug view option
Arrow debug texture references
Items Explicitly NOT Merged
Heading-based physics (dir float, rotation steering, no velocity) — dist keeps vel vec2
Atomic splatting (imageAtomicAdd in entity_update) — dist keeps instanced brush rendering
GL_NV_shader_atomic_float — not needed
Recursive SDF system (controller rewrite, teleportation, recursion window, march.frag scene)
All demos/ content
Field overlay simplification (force/strafe HSV → scalar)
WORLD_SIZE-based entity size in cam_brush.vert — dist keeps e.size
User approved the plan
The plan is approved. The merge analysis document is complete at ancient-tinkering-cloud.md.

To summarize the deliverable — it covers 7 buckets of changes with per-item merge/no-merge flags:

Bucket 1 (Canvas Pipeline): MERGE — RG32F canvas, brush renders directly (pre-scaled by (1-p)/p), no more brush middleman
Bucket 2 (Entity Struct): PARTIAL MERGE — 32-byte struct (keep vel, add hue, remove cohort/color). No heading physics.
Bucket 3 (Recursive SDF): NO MERGE
Bucket 4 (Generics): MERGE — 8 scratch sliders with helper text
Bucket 5 (Plotting): MERGE — GPU histogram system
Bucket 6 (Cleanups): MERGE items 6.1–6.4, 6.9. Emboss fully excised. Brush view removed.
Bucket 7 (Demos): NO MERGE
The recommended merge order is Phase A (canvas + entity struct) → Phase B (generics) → Phase C (plotting) → Phase D (small cleanups), designed so each phase can be handed to a separate Claude session with manageable context.
