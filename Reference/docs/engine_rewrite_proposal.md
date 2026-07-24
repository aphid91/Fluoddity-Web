# Fluoddity Engine Rewrite: Systems Audit & Unified Architecture Proposal

## Context

Fluoddity's particle simulation has grown organically to support powerful features — parameter sweeps, multi-load, jitter, force/strafe fields, shader-driven fields — but each was added as its own interlocking system with bespoke data paths, duplicated code, and special-cased branching. The result: ~200 lines of boilerplate getter functions in the compute shader, 3 synchronized copies of `calculate_setting()`, 11 separate `PhysicsSetting` uniform uploads per frame, and an SSBO packing routine that manually mirrors the shader struct layout.

The core insight: **all these systems answer the same question** — "What is the effective value of parameter P for particle X at time T?" — but they each answer it differently, through separate mechanisms. A rewrite that unifies them into a single parameter-resolution framework would eliminate massive duplication, improve extensibility, and potentially improve GPU performance by replacing branchy per-system code with a tight, data-driven evaluation loop.

---

## Part 1: Current Systems Inventory

### 1. Entity Update (the simulation kernel)
- **Files**: `shaders/entity_update.glsl`, `sim.py`
- **Responsibility**: Per-particle physics step — sense canvas, evaluate rule, apply forces/strafe, enforce boundaries
- **Hot path per particle**:
  1. Resolve config index (multi-load or global)
  2. Get/generate rule (target_rule or procedural from seed + per-cohort mutation)
  3. Hazard rate random death check
  4. Sample canvas at left/right sensor positions
  5. Evaluate fourier_noise black-box (2 calls for symmetry)
  6. Apply forces (axial/lateral × global_force_mult, drag)
  7. Apply strafe (same calculation, added to position)
  8. Apply force/strafe field from drawing surface texture
  9. Enforce boundary conditions (bounce/reset/wrap)
- **Entity struct**: `{pos:vec2, vel:vec2, size:float, cohort:float, padding[2], color:vec4}` = 48 bytes

### 2. PhysicsSetting Struct
- **Files**: `entity_update.glsl:24-32`, `canvas.frag:36-44`, `sim.py:482-499`
- **Responsibility**: Encapsulate a parameter's base value + spatial/cohort variation + jitter
- **Structure**: 7 floats `{slider_value, min_value, max_value, x_sweep, y_sweep, cohort_sweep, jitter}`
- **Resolution function**: `calculate_setting()` — triplicated in entity_update.glsl, canvas.frag, sim.py
- **Used for**: 9 params in entity_update (DRAG through HAZARD_RATE), 2 in canvas.frag (TRAIL_PERSISTENCE, TRAIL_DIFFUSION)
- **Pain points**:
  - 3 synchronized copies of the resolution function with `// SYNCHRONIZED` comments
  - 11 separate uniform struct uploads per frame from Python
  - Sweep logic is linear-only, hardcoded to x/y/cohort axes
  - canvas.frag has `#define COHORTS 64` hack because it doesn't receive actual cohort count

### 3. Parameter Sweep System
- **Files**: `sim_state.py:51-113` (sweep/jitter dicts), `sim.py:482-499` (`_assign_physics_setting`), `entity_update.glsl:147-197`
- **Responsibility**: Spatial and cohort-based variation of physics parameters
- **Implementation**: Built into PhysicsSetting struct fields (x_sweep, y_sweep, cohort_sweep)
- **Resolution**: `mix(min, max, normalized_coordinate)` per active axis, then average
- **Limitation**: Only linear interpolation, only 3 fixed axes (x, y, cohort), mutual exclusivity within each axis

### 4. Jitter System
- **Files**: Same as PhysicsSetting (field within the struct)
- **Responsibility**: Per-frame random temporal variation of parameters
- **Implementation**: `result += jitter * result * hash(frame_count, pos)`
- **Limitation**: Only multiplicative/proportional jitter, no absolute jitter option

### 5. Multi-Load System
- **Files**: `services/multi_load_service.py`, `sim.py:615-708`, `entity_update.glsl:63-107,114-301`
- **Responsibility**: Multiple saved configs assigned to different particle groups
- **Data path**: Python packs PhysicsConfig → `struct.pack` → SSBO write (only when dirty) → shader reads per-particle
- **Config struct (GLSL)**: 10 PhysicsSetting structs (70 floats) + 6 ints + 3 floats = 316 bytes × 64 configs
- **Assignment**: Circular ring with configurable window (simultaneous_configs, current_progress)
- **Assignment modes**: Cohort-proportional or random hash
- **Pain points**:
  - ~200 lines of `get_particle_X()` boilerplate (12 nearly-identical getter functions)
  - Python-side SSBO packing manually mirrors GLSL struct layout (~70 lines of struct.pack)
  - MultiLoadConfig duplicates all PhysicsSetting fields verbatim
  - Weighted trail settings calculated on CPU (`_calculate_weighted_trail_settings`, ~60 lines)

### 6. Force/Strafe Field (Drawing Surface)
- **Files**: `canvas.frag:133-276` (painting), `entity_update.glsl:548-551` (application)
- **Responsibility**: User-painted vector field that adds to particle velocity/position
- **Texture format**: RGBA float32, `.xy = force vector, .zw = strafe vector`
- **Painting modes**: Mouse direction, inverse, fixed heading, attract, repel, fill
- **Application**: Simple additive: `vel += strength * field.xy`, `pos += strength * field.zw`
- **Independence**: Currently a completely separate code path from PhysicsSetting — applied AFTER all physics

### 7. Shader-Driven Field Override
- **Files**: `shaders/field_override/march.frag`
- **Responsibility**: Procedurally generate force/strafe field from raymarching
- **Output**: Same RGBA format as drawing surface (`vec4(-field, -field)`)
- **Integration**: Renders to the same field_texture, so feeds into the same application path as #6
- **Camera**: Uses its own `camera_pos`/`camera_dir` uniforms for 3D scene navigation

### 8. Rule/Behavior System (Fourier Feature Network)
- **Files**: `shaders/fourier4_4.glsl`, `entity_update.glsl:388-458`
- **Responsibility**: The "brain" — maps sensor inputs to force/strafe/color outputs
- **Structure**: 10 FourierCenter structs, each `{frequency:vec4, amplitude:vec4}` = 80 floats per rule
- **Evaluation**: `fourier_noise()` — dot product → sin/cos basis → weighted sum
- **Variation**: Per-cohort mutation via `mutate_rule()` (random amplitude/frequency perturbation)
- **Symmetry**: Double evaluation (base + mirror) to eliminate chirality, toggleable via DISABLE_SYMMETRY

### 9. Canvas System (Trail Accumulation)
- **Files**: `shaders/canvas.frag`, `shaders/canvas.vert`, `sim.py:237-328`
- **Responsibility**: Persist particle trails across frames with decay and diffusion
- **Pipeline**: `can_out = blur(old_canvas) * persistence + (1 - persistence) * brush`
- **Diffusion**: 5-tap cross kernel with configurable constant
- **Double buffering**: Optional (strong_determinism), ping-pong between two textures
- **Drawing**: Also handles Trail-based brush painting, erasure, fill — overloaded responsibility

### 10. Brush System (Per-Frame Particle Rendering)
- **Files**: `shaders/brush.vert`, `shaders/brush.frag`, `sim.py:223-235`
- **Responsibility**: Render current particle positions as velocity-encoded splats
- **Method**: Instanced quads (TRIANGLE_FAN), gaussian kernel, additive blending
- **Output**: `vec4(vel.xy, 0.01, 1.0) * gaussian` — velocity encoded in RG channels

### 11. Camera & Frame Assembly (Rendering Pipeline)
- **Files**: `camera.py`, `shaders/cam_brush.vert`, `shaders/cam_brush.frag`, `shaders/frame_assembly.frag`, `utilities/frame_assembler.py`
- **Responsibility**: Camera-space particle rendering, temporal accumulation, tone mapping, overlays
- **cam_brush**: Camera-transformed instanced particle rendering (with tiling, culling, particle shaping)
- **frame_assembly**: HSV→RGB, brightness, asinh tonemap, emboss, exposure blending, watercolor mode, sweep/draw reticle overlays, tiling seam blending, field overlay
- **Emboss**: Gradient-based fake normal lighting from canvas/brush texture

---

## Part 2: Cross-Cutting Issues & Refactor Opportunities

### A. Duplication / Synchronization Debt

| Issue | Locations | Lines |
|-------|-----------|-------|
| `calculate_setting()` triplicated | entity_update.glsl, canvas.frag, sim.py | ~150 total |
| `PhysicsSetting` struct duplicated | entity_update.glsl, canvas.frag | 14 |
| `Entity` struct triplicated | entity_update.glsl, brush.vert, cam_brush.vert | 21 |
| 12 identical `get_particle_X()` getters | entity_update.glsl:203-301 | ~100 |
| Physics param lists (name, range, default) | physics_params.py, sim.py, config_saver.py, _write_multi_load_ssbo | 4 copies |
| `hsv2rgb()` duplicated | brush.frag, cam_brush.frag, frame_assembly.frag | 12 |
| `gaussian()` duplicated | brush.frag, cam_brush.frag | 10 |
| Aspect ratio calculation | entity_update, brush.vert, cam_brush.vert, canvas.frag, frame_assembly.frag | 15+ |

### B. Performance-Relevant Issues (GPU)

1. **Per-frame uniform traffic**: 11 PhysicsSetting structs × 7 fields = 77 individual `tryset()` calls per frame just for physics params. Each is a separate OpenGL uniform upload. Should be a single SSBO write.

2. **Branch divergence in `calculate_setting()`**: Every parameter evaluation checks 4 conditions (3 sweeps + jitter). When sweeps are off (common case), the early return helps. But when ANY sweep is active, all 600K particles evaluate the full function 9× in entity_update alone. The branches are coherent (all particles take the same path) so this isn't catastrophic, but it's still instruction cache pressure.

3. **Multi-load config index computed 15+ times per particle**: `get_particle_config_index()` is called once per `get_particle_X()` getter. It recomputes the hash and ring position each time. Could be computed once and cached.

4. **Redundant texture lookups in canvas.frag**: For parameter sweeps, `calculate_setting()` is called twice (trail_persistence and trail_diffusion) with the same position but independently computed. Minor, but a pattern that grows with more params.

5. **Memory layout**: MultiLoadConfig SSBO is AoS (array of structs). For GPU compute workloads, SoA (struct of arrays) can improve coalesced memory access when all particles read the same field.

6. **Force field applied after physics**: The additive `vel += field.xy` happens at a fixed point in the pipeline (after all physics). This limits its expressiveness — it can't modulate other parameters.

### C. Extensibility Bottlenecks

1. **Adding a new "driven" parameter** requires touching: SimState, PhysicsSetting uniform declarations, `_assign_physics_setting()`, `get_particle_X()` getter, MultiLoadConfig struct, `_write_multi_load_ssbo()`, PhysicsConfig, config_saver — **8+ files**.

2. **Adding a new mapping source** (e.g., "sweep across radial distance") requires modifying the PhysicsSetting struct, `calculate_setting()` in 3 locations, and all Python code that packs/unpacks the struct.

3. **Force field can't drive arbitrary parameters** — it's hardcoded to add to vel/pos. Can't use a painted texture to modulate drag or sensor distance.

---

## Part 3: Unified Parameter Architecture Proposal

### Core Design: Parameter Binding Table

Replace all parameter-driving systems with a single SSBO-based **Parameter Table** where each parameter has up to N **mapping slots** describing how its value is determined.

```
┌─────────────────────────────────────────────────────┐
│ Parameter Table SSBO (binding N)                     │
│                                                      │
│ ParamDescriptor[0]: DRAG                             │
│   base_value: 0.504                                  │
│   mapping[0]: {type=LINEAR_SWEEP, dim=X, min=-1, max=1, strength=1.0} │
│   mapping[1]: {type=JITTER, strength=0.1}            │
│   mapping[2]: {type=NONE} ← sentinel, stop evaluating│
│                                                      │
│ ParamDescriptor[1]: SENSOR_GAIN                      │
│   base_value: 0.116                                  │
│   mapping[0]: {type=TEXTURE_READ, channel=0, strength=0.5, min=0, max=5} │
│   mapping[1]: {type=NONE}                            │
│                                                      │
│ ... (12 physics params + extensible)                 │
└─────────────────────────────────────────────────────┘
```

### GLSL Data Structures

```glsl
// Mapping source types
#define MAP_NONE           0
#define MAP_FIXED          1  // Just use base_value (no modulation)
#define MAP_SWEEP_X        2  // Linear sweep across X axis
#define MAP_SWEEP_Y        3  // Linear sweep across Y axis
#define MAP_SWEEP_COHORT   4  // Linear sweep across cohort
#define MAP_SWEEP_RADIAL   5  // Linear sweep by distance from center
#define MAP_MULTILOAD      6  // Value from multi-load config ring
#define MAP_TEXTURE_FORCE  7  // Read from field texture (.xy channel)
#define MAP_TEXTURE_STRAFE 8  // Read from field texture (.zw channel)
#define MAP_JITTER         9  // Temporal random noise

// Mapping combination modes
#define COMBINE_REPLACE    0  // mapping output replaces current value
#define COMBINE_ADD        1  // mapping output added to current value
#define COMBINE_MULTIPLY   2  // mapping output multiplied with current value

#define MAX_MAPPINGS_PER_PARAM 4
#define NUM_PARAMS 12  // Extensible

struct ParamMapping {
    uint source;      // MAP_* enum
    uint combine;     // COMBINE_* enum
    float strength;   // Modulation depth (0 = inactive)
    float range_min;  // Output range minimum
    float range_max;  // Output range maximum
    float _pad[3];    // Align to 32 bytes for clean access
};

struct ParamDescriptor {
    float base_value;     // Slider / fixed value
    float _pad[7];        // Align to 32 bytes
    ParamMapping mappings[MAX_MAPPINGS_PER_PARAM];
};

layout(std430, binding = PARAM_TABLE_BINDING) buffer ParameterTable {
    ParamDescriptor params[NUM_PARAMS];
};
```

### Single Resolution Function

```glsl
float resolve_param(uint param_id, vec2 pos, float cohort, uint particle_id) {
    ParamDescriptor desc = params[param_id];
    float value = desc.base_value;

    for (int i = 0; i < MAX_MAPPINGS_PER_PARAM; i++) {
        ParamMapping m = desc.mappings[i];
        if (m.source == MAP_NONE || m.strength == 0.0) break;

        float t = 0.0;  // Drive value in [0, 1]

        switch (m.source) {
            case MAP_SWEEP_X:
                t = (pos.x + 1.0) * 0.5;
                break;
            case MAP_SWEEP_Y:
                t = (pos.y + 1.0) * 0.5;
                break;
            case MAP_SWEEP_COHORT:
                t = floor(cohort) / float(num_cohorts);
                break;
            case MAP_SWEEP_RADIAL:
                t = length(pos);
                break;
            case MAP_MULTILOAD:
                t = get_multiload_blend(particle_id, param_id);
                break;
            case MAP_TEXTURE_FORCE:
                t = length(get_field(pos).xy);
                break;
            case MAP_TEXTURE_STRAFE:
                t = length(get_field(pos).zw);
                break;
            case MAP_JITTER:
                t = hash(vec2(float(frame_count) + value, pos.x + pos.y * 1000.0));
                break;
        }

        float mapped = mix(m.range_min, m.range_max, t) * m.strength;

        switch (m.combine) {
            case COMBINE_REPLACE: value = mapped; break;
            case COMBINE_ADD:     value += mapped; break;
            case COMBINE_MULTIPLY: value *= mapped; break;
        }
    }
    return value;
}
```

This **single function replaces**:
- All 12 `get_particle_X()` getters (~100 lines)
- `calculate_setting()` in entity_update.glsl (~50 lines)
- `calculate_setting()` in canvas.frag (~50 lines)
- `calculate_setting()` in sim.py (~40 lines)
- Force field application lines (entity_update.glsl:548-551)
- Multi-load config index calculation (shared across all params)

### Multi-Load Integration

Multi-load becomes just another mapping source type. Instead of a separate `MultiLoadConfig` struct that duplicates all PhysicsSetting fields, multi-load data is stored as:

```glsl
layout(std430, binding = MULTILOAD_BINDING) buffer MultiLoadValues {
    float config_values[64][NUM_PARAMS];  // Simple 2D array: config × param
};
```

The `MAP_MULTILOAD` source type reads from this buffer using the same ring/window logic currently in `get_particle_config_index()`, but computed once per particle and reused for all parameters.

### Rules as Part of the Table (Optional Extension)

The user specifically mentioned incorporating physics settings into the rule buffer. One approach:

```glsl
struct ParticleRule {
    FourierCenter centers[10];     // Behavioral rule (80 floats)
    float param_overrides[12];      // Per-rule parameter values
    uint  param_override_mask;      // Bitmask: which params this rule overrides
};
```

This way, when a particle adopts a rule (from clicking, from multi-load, etc.), it can optionally carry parameter overrides. This naturally extends the mutation system: `mutate_rule()` could also mutate parameter values.

### Python-Side Changes

**Before (per-frame, current)**:
```python
# 77 individual tryset() calls for physics settings
for each of 11 params:
    tryset(program, f'{name}.slider_value', value)
    tryset(program, f'{name}.min_value', min_val)
    tryset(program, f'{name}.max_value', max_val)
    tryset(program, f'{name}.x_sweep', ...)
    tryset(program, f'{name}.y_sweep', ...)
    tryset(program, f'{name}.cohort_sweep', ...)
    tryset(program, f'{name}.jitter', ...)
```

**After (only when parameters change)**:
```python
# Single SSBO write when any parameter or mapping changes
if self._param_table_dirty:
    self._param_table_buffer.write(self._pack_param_table())
    self._param_table_dirty = False
```

The `_pack_param_table()` function builds the buffer once from a Python-side parameter registry — no manual struct mirroring, no per-field packing.

---

## Part 4: Performance Optimization Opportunities

### A. Eliminate Per-Frame Uniform Spam (Immediate Win)

Even before the full rewrite, moving physics settings from uniforms to an SSBO that's only written when dirty would eliminate ~77 OpenGL calls per frame. The multi-load system already demonstrates this pattern.

### B. Compute Config Index Once Per Particle

Currently `get_particle_config_index()` is called 12-15 times per particle (once per getter). Cache it:

```glsl
void main() {
    // Compute once, use everywhere
    int config_idx = get_particle_config_index();
    float drag = resolve_param(PARAM_DRAG, e.pos, cohort, config_idx);
    float gain = resolve_param(PARAM_SENSOR_GAIN, e.pos, cohort, config_idx);
    // ...
}
```

### C. SSBO Memory Layout

For the parameter table, the current AoS layout is fine (each particle reads all fields of one descriptor sequentially). But for multi-load values, consider SoA:

```glsl
// SoA: all config values for one param are contiguous
// Better when many particles read the same param from different configs
float multiload_values[NUM_PARAMS][64];  // param-major
```

vs. current AoS where all params for one config are contiguous. The access pattern (all particles in a warp reading the same config index for different params) slightly favors AoS, so this may not help. Profile both.

### D. On-Demand Shader Specialization (Advanced)

For maximum performance, generate shader variants based on which mappings are active:

```python
# When user toggles an X sweep on DRAG:
active_mappings = {
    'DRAG': [('SWEEP_X', ...)],
    'SENSOR_GAIN': [],  # fixed
    # ...
}
shader_key = hash(active_mappings)
if shader_key not in self._shader_cache:
    source = generate_specialized_shader(active_mappings)
    self._shader_cache[shader_key] = ctx.compute_shader(source)
self.entity_update_program = self._shader_cache[shader_key]
```

The specialized shader would have `resolve_param()` inlined with only the active mapping code paths, eliminating all branches. Compilation takes ~50-200ms on most GPUs — acceptable for a parameter change event.

**Recommendation**: Implement the general SSBO-based system first. Profile. Add specialization only if the branch overhead is measurable (unlikely for <=4 mappings per param).

### E. Texture-Based Parameter Maps (Complementary to SSBO)

The force/strafe field is already a texture-encoded parameter map — the rewrite makes this pattern explicit. For texture-driven parameters, hardware texture filtering gives free bilinear interpolation. The `MAP_TEXTURE` source type in `resolve_param()` reads from the field texture and maps it to any parameter's range, giving us painted/procedural parameter fields for free.

For parameters that vary spatially in complex ways (e.g., "high drag in the center, low at edges"), a texture map is more expressive than a linear sweep. The shader-driven field override (march.frag) can generate these procedurally from 3D geometry.

---

## Part 5: Recommended Rewrite Strategy

### Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Python Side                           │
│                                                          │
│  ParameterRegistry                                       │
│    - List of ParamDef (name, default, range, group)      │
│    - Active mappings per param                           │
│    - Packs to SSBO on change                             │
│                                                          │
│  MappingSource (base class)                              │
│    ├─ FixedSource                                        │
│    ├─ LinearSweepSource(axis)                            │
│    ├─ MultiLoadSource(configs, ring_settings)            │
│    ├─ TextureSource(channel)                             │
│    ├─ JitterSource                                       │
│    └─ (extensible)                                       │
│                                                          │
│  SimKernel                                               │
│    - Owns compute shader + all SSBOs                     │
│    - param_table_ssbo, entity_ssbo, rule_ssbo            │
│    - multiload_values_ssbo (optional)                    │
│    - Single update() dispatches compute                  │
│                                                          │
└────────────────────┬────────────────────────────────────┘
                     │ SSBO writes (only on change)
                     ▼
┌─────────────────────────────────────────────────────────┐
│                    GPU Side                               │
│                                                          │
│  entity_update.glsl                                      │
│    - #include "param_resolve.glsl"                       │
│    - #include "fourier.glsl"                             │
│    - Clean main() that calls resolve_param() for each    │
│    - No getters, no PhysicsSetting struct                 │
│    - Force/strafe field = just another mapping source    │
│                                                          │
│  param_resolve.glsl (shared include)                     │
│    - ParamDescriptor / ParamMapping structs              │
│    - resolve_param() function                            │
│    - Used by entity_update.glsl AND canvas.frag          │
│                                                          │
│  canvas.frag                                             │
│    - #include "param_resolve.glsl"                       │
│    - Trail persistence/diffusion via resolve_param()     │
│    - No more duplicated calculate_setting()              │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### Phased Implementation Plan

#### Phase 0: Shared Shader Includes (prerequisite)
- Implement a `#include` mechanism in `read_shader()` / `shader_prepend()`
- Extract shared code: `Entity` struct, `PhysicsSetting`/future `ParamDescriptor`, `hash()`, `hsv2rgb()`, `gaussian()`, aspect ratio helpers
- **Benefit**: Eliminates all struct duplication immediately, makes future changes single-site
- **Risk**: Low — purely mechanical extraction
- **Files**: `utilities/gl_helpers.py`, new `shaders/includes/` directory

#### Phase 1: Parameter Table SSBO (core change)
- Define `ParamDescriptor` and `ParamMapping` structs in `shaders/includes/param_resolve.glsl`
- Implement `resolve_param()` in the shared include
- Replace all 11 `PhysicsSetting` uniforms with a single Parameter Table SSBO
- Replace all `get_particle_X()` getters with `resolve_param(PARAM_X, ...)`
- Replace `calculate_setting()` calls with `resolve_param()` calls in both shaders
- Python side: `ParameterRegistry` class that owns the SSBO and packs it
- **Benefit**: Eliminates ~300 lines of GLSL boilerplate, ~77 per-frame uniform calls, 3 copies of calculate_setting()
- **Risk**: Medium — changes the core data path. Must verify all parameter values match before/after.
- **Files**: `shaders/entity_update.glsl`, `shaders/canvas.frag`, `sim.py`, new `shaders/includes/param_resolve.glsl`

#### Phase 2: Absorb Multi-Load into Mapping Framework
- `MAP_MULTILOAD` source type reads from a simplified multi-load values SSBO
- Remove `MultiLoadConfig` struct from shader (replaced by flat value table)
- Remove `get_particle_config_index()` — compute ring index once in `resolve_param()` (or before, cached)
- Simplify `_write_multi_load_ssbo()` — just write a flat float array instead of manually packing structs
- **Benefit**: Eliminates MultiLoadConfig duplication, simplifies SSBO packing from ~70 lines to ~10
- **Files**: `shaders/entity_update.glsl`, `sim.py`, `services/multi_load_service.py`

#### Phase 3: Absorb Force/Strafe Field into Mapping Framework
- `MAP_TEXTURE` source types read from field_texture channels and can drive ANY parameter
- Force/strafe on velocity/position become `MAP_TEXTURE_FORCE`/`MAP_TEXTURE_STRAFE` mapped to dedicated pseudo-params "vel_offset" and "pos_offset"
- Any physics param (drag, sensor_gain, sensor_distance, etc.) can also be driven by texture channels
- Remove hardcoded `vel += field.xy` / `pos += field.zw` lines from entity_update
- **Benefit from day one**: Drawing surface can modulate ANY parameter. Paint a drag field, a sensor distance map, a region of high mutation. Combined with the shader-driven field override (march.frag), this means procedural 3D geometry can modulate arbitrary physics.
- **Files**: `shaders/entity_update.glsl`, `sim.py`, UI changes for texture-to-param binding

#### Phase 4: New Mapping Sources (extend the framework)
- `MAP_SWEEP_RADIAL` — distance from center
- `MAP_SWEEP_ANGULAR` — angle from center
- `MAP_NOISE` — spatial noise field (e.g., Perlin)
- `MAP_MULTILOAD_TEXTURE` — multi-load values blended by a shader-driven texture
- Each is just a new case in the switch statement + UI to enable it
- **Benefit**: Each new source is ~5-10 lines of GLSL + Python UI, instead of a new system
- **Files**: `shaders/includes/param_resolve.glsl`, UI files

#### Phase 5: Rule-Parameter Integration
- Extend rule struct to carry per-rule parameter overrides alongside fourier coefficients
- New struct: `ParticleRule { FourierCenter centers[10]; float param_overrides[NUM_PARAMS]; uint param_override_mask; }`
- `mutate_rule()` extended to also perturb parameter values (controlled by mutation_scale)
- Clicking a particle adopts its rule AND its effective parameter values
- `resolve_param()` checks rule override mask before evaluating mappings — if the rule overrides a param, that takes precedence (or blends, configurable)
- Multi-load configs naturally carry per-config rules with per-config param overrides
- **Benefit**: Rules become fully self-contained behavioral descriptions. A "species" of particle carries its own physics. Mutation explores parameter space alongside behavioral space.
- **Files**: `shaders/entity_update.glsl`, `shaders/includes/param_resolve.glsl`, `shaders/fourier4_4.glsl`, rule-related Python code, config_saver.py

### Key Design Principles for the Rewrite

1. **Single source of truth**: Parameter definitions live in ONE place (Python-side registry), are packed to ONE SSBO, and read by ONE GLSL function.

2. **Data-driven, not code-driven**: Adding a new parameter = adding a row to the registry. Adding a new mapping source = adding a case to the switch. No new structs, no new getters, no new uniform declarations.

3. **Dirty-flag updates**: SSBO writes only happen when state changes, never per-frame. The multi-load system already demonstrates this pattern works well.

4. **Shared includes over duplication**: `#include` mechanism for structs, utility functions, and the resolve function itself.

5. **Backward compatibility**: Config files (JSON v7) remain valid. Old sweep/jitter settings map 1:1 to the new mapping slots. No user-visible behavior change for existing features.

6. **Rules are self-contained organisms**: A rule carries both behavioral coefficients (fourier centers) AND parameter overrides. When you click a particle, you get its complete behavioral identity. Mutation explores both spaces simultaneously.

7. **Textures are first-class parameter sources**: Any parameter can be driven by a texture channel. The drawing surface and shader-driven field become general-purpose parameter maps, not special-case force applicators.

### Decisions Made
- **Shader specialization**: Skipped. The general `resolve_param()` with a tight switch/loop is sufficient. Avoids compilation pauses and keeps the system simple.
- **Texture-driven parameters**: Full generality from day one. Any parameter can be driven by field texture channels.
- **Rule-parameter fusion**: Included. Rules carry parameter overrides alongside fourier coefficients.

---

## Part 6: Summary of Estimated Impact

| Metric | Before | After |
|--------|--------|-------|
| `calculate_setting()` copies | 3 | 1 (shared include) |
| `get_particle_X()` getters | 12 | 0 (replaced by `resolve_param()`) |
| Per-frame uniform calls for physics | ~77 | 0 (SSBO, dirty-flag) |
| Lines to add a new driven parameter | ~80 across 8 files | ~5 (registry entry + GLSL enum) |
| Lines to add a new mapping source | N/A (new system) | ~10 (switch case + UI) |
| Multi-load SSBO packing code | ~70 lines manual struct.pack | ~10 lines flat array |
| Duplicated GLSL structs | 3 (Entity), 2 (PhysicsSetting) | 0 (shared includes) |
| Force field expressiveness | vel/pos only | Any parameter |
| Max parameter mappings per param | 3 (x+y+cohort sweep) + jitter | 4 (arbitrary, combinable) |
| Rule self-containedness | Coefficients only | Coefficients + param overrides |
| Phases in rewrite | N/A | 5 (no shader specialization) |

---

## Verification Plan

Since there are no automated tests, verification is manual:

1. **Phase 0**: Load any config, verify all sliders/sweeps/jitter work identically to before. Toggle multi-load, verify behavior matches. Compare screenshots.
2. **Phase 1**: A/B test — run old and new shader side by side with same params, verify identical canvas output after N frames. Use `WRITE_RULES` readback to verify rule values match.
3. **Phase 2**: Load multi-load configs, verify particle assignment and ring behavior matches. Test all assignment modes (Cohorts, Random).
4. **Phase 3**: Paint force/strafe field, verify particle behavior matches. Then test new capability: texture-driven drag or sensor_gain.
5. **Each phase**: Run `python main.py`, exercise all features in `docs/testing_checklist.md`.
