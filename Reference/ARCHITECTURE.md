# Fluoddity Architecture

Fluoddity is a GPU-accelerated 2D particle simulation for generative art. Thousands of particles follow neural-net-like "Rules" that govern how they respond to trail density, producing emergent patterns ranging from flowing rivers to branching lightning. The physics engine is a generalization of [Sage Jenson's physarum transport model](https://cargocollective.com/sagejenson/physarum). Built with Python, ModernGL (OpenGL compute shaders), GLFW, and Dear ImGui.

## Core Architecture: Orchestrator Pattern

```
                        App (main.py)
                   ┌───────┼───────────┐
                   │       │           │
            CommandHandler  │   SimulationRunner
                   │       │           │
         ┌─────────┴───────┴───────────┴─────────┐
         │                                       │
    ┌────┴────┐   ┌─────┐   ┌────────┐   ┌──────┴──┐
    │   UI    │   │ Sim │   │ Camera │   │Services │
    │ (imgui) │   │(GPU)│   │(render)│   │         │
    └─────────┘   └─────┘   └────────┘   └─────────┘
```

**App** is a thin orchestrator. Each frame it:
1. Reads UI state via `ui.get_state()`
2. Delegates one-shot commands to `CommandHandler`
3. Delegates camera input to `process_camera_input()`
4. Manages recording/screenshot state machines
5. Applies state to Sim and Camera
6. Delegates physics + frame assembly to `SimulationRunner`
7. Renders camera view and UI

Components never talk to each other directly. All coordination flows through the orchestrator.

## Key Design Patterns

### Passive UI
The UI renders ImGui widgets and exposes state via `get_state()`. It does **not** run simulation logic, manage rules, or coordinate services. The orchestrator reads UI state and acts on it.

### One-Shot Flags
UI sets boolean flags (e.g., `request_reset`, `request_save_file`, `toggle_recording`) that the orchestrator reads and resets each frame. This keeps the UI stateless with respect to application behavior.

### State Containers
All mutable state lives in dataclasses in `state/`. The UI modifies these directly via widget bindings. The orchestrator reads them and applies to components.

### GPU Compute Pipeline
Physics runs entirely on the GPU via GLSL compute shaders. `Sim` manages shader programs, buffers, and textures. The CPU-side code just dispatches compute calls and reads back results when needed.

## File Map

### Orchestration Layer
| File | Lines | Description |
|------|-------|-------------|
| `main.py` | 357 | App orchestrator: init, frame loop, recording/screenshot state machines |
| `command_handler.py` | 417 | Processes one-shot UI commands (resets, config save/load, mouse clicks, history) |
| `simulation_runner.py` | 250 | Physics stepping + frame assembly (motion blur / non-motion blur) |
| `camera_input.py` | 89 | WASD/QE camera movement + scroll-to-zoom (standalone function) |

### UI Package (`ui/`)
Mixin-based architecture. The `UI` class in `core.py` inherits all mixins via multiple inheritance, so every method shares the same `self` for access to shared state. See [`ui/README.md`](ui/README.md) for details.

| File | Lines | Description |
|------|-------|-------------|
| `core.py` | 634 | UI class definition, `__init__`, GLFW callbacks, `get_state()`, render dispatch |
| `physics_window.py` | 728 | Physics settings panel: all slider groups, multi-load mode |
| `slider_widgets.py` | 386 | Slider with range menu, context menus, jitter, sweep/range buttons |
| `help_windows.py` | 355 | Controls, tutorial, parameter sweeps, performance, video recording windows |
| `menu_bar.py` | 282 | File/Reset/Help/Extras menus, load submenu with preview, auto-close |
| `history_window.py` | 245 | Rule history display, tooltip shader rendering |
| `preferences_window.py` | 232 | World size, physics frequency, mouse mode, view, appearance settings |
| `config_browser.py` | 230 | Config file scanning, caching, hierarchical load submenu rendering |
| `popup_modals.py` | 85 | Save/Overwrite/Delete confirmation dialogs |

### Simulation & Rendering
| File | Lines | Description |
|------|-------|-------------|
| `sim.py` | 869 | GPU particle simulation: shaders, buffers, physics dispatch, parameter sweeps |
| `camera.py` | 316 | Camera state, coordinate transforms, screen rendering |

### Services (`services/`)
Stateless or near-stateless helpers owned by the orchestrator.

| File | Lines | Description |
|------|-------|-------------|
| `config_saver.py` | 565 | Save/load physics configs (JSON + legacy binary formats) |
| `multi_load_service.py` | 150 | Mix up to 64 configs simultaneously, cohort assignment |
| `arrow_debug_service.py` | 93 | Debug overlay rendering trail flow vectors as arrows |
| `entity_picker.py` | 63 | Find nearest particle to mouse click (CPU readback) |
| `rule_manager.py` | 60 | Rule history stack with push/pop/undo |
| `video_recorder.py` | 45 | Thin facade over VidSaver for video recording |

### State (`state/`)
Plain dataclasses. No logic, just fields with defaults.

| File | Lines | Description |
|------|-------|-------------|
| `sim_state.py` | 113 | Physics parameters (ALL_CAPS), rule seed, view options, sweep config |
| `preferences_state.py` | 86 | User preferences: motion blur, recording, mouse mode, keybindings |
| `ui_state.py` | 72 | Combined state snapshot returned by `UI.get_state()` |
| `multi_load_state.py` | 24 | Multi-load toggle and config list |
| `camera_state.py` | 11 | Camera position + zoom |
| `recording_state.py` | 7 | Recording active flag |

### Utilities (`utilities/`)
| File | Lines | Description |
|------|-------|-------------|
| `ffmpeg_recorder.py` | 272 | FFmpeg pipe-based video encoder |
| `save_frame_gpu.py` | 248 | GPU-side screenshot with supersampling |
| `frame_assembler.py` | 195 | Temporal accumulation (motion blur) + final composite |
| `keybinding_management.py` | 146 | Rebindable keyboard shortcuts |
| `paths.py` | 117 | Platform-aware path resolution (app dir vs user Documents) |
| `gl_helpers.py` | 114 | OpenGL utilities (tryset, readback_rule, buffer helpers) |
| `vid_saver.py` | 75 | Frame-buffered video saver (wraps ffmpeg_recorder) |

### Shaders (`shaders/`)
| File | Description |
|------|-------------|
| `entity_update.glsl` | **Core physics** compute shader: particle movement, sensing, rule application |
| `fourier4_4.glsl` | Compute shader: trail diffusion via Fourier convolution |
| `canvas.vert/.frag` | Trail rendering to canvas texture |
| `camera.vert/.frag` | View texture generation from canvas (camera transform) |
| `frame_assembly.vert/.frag` | Final composite: gamma, emboss, sweep reticle, motion blur accumulation |
| `brush.vert/.frag` | Mouse drawing brush rendering |
| `cam_brush.vert/.frag` | Camera-space brush overlay (draw trail cursor) |
| `arrow_debug.vert/.frag` | Debug arrow overlay for trail flow vectors |
| `tooltip_graphic.frag` | Animated shader for physics tooltip visualization |

## Data Flow: Physics Parameter

```
SimState.SENSOR_GAIN                  # state/sim_state.py - dataclass field
    ↓ (UI widget binding)
imgui.slider_float(v=state.sim.SENSOR_GAIN)  # ui/physics_window.py
    ↓ (get_state returns combined state)
ui_state = ui.get_state()                     # main.py orchestrate_frame
    ↓ (apply state)
sim.apply_state(ui_state.sim)                 # main.py → sim.py
    ↓ (set uniform)
tryset(program, 'SENSOR_GAIN', state.SENSOR_GAIN)  # sim.py entity_update()
    ↓ (GPU)
uniform float SENSOR_GAIN;                    # shaders/entity_update.glsl
```

For a step-by-step guide to adding new parameters, see [`docs/adding_ui_shader_params.md`](docs/adding_ui_shader_params.md).

## Data Flow: One-Shot Command

```
User clicks "Reset" in menu
    ↓
UI sets self._request_reset = True            # ui/menu_bar.py
    ↓
get_state() packages it into UIState          # ui/core.py
    ↓
App reads ui_state.request_reset              # main.py
    ↓
CommandHandler.process_commands() handles it  # command_handler.py
    ↓
sim.reset() called                            # sim.py
```

## Data Flow: Config Save/Load

```
Save: UI → request_save_file flag → CommandHandler → ConfigSaver.create_config(SimState, rule) → JSON file
Load: UI → request_load_file flag → CommandHandler → ConfigSaver.load_from_file() → apply_config(SimState) → sim.apply_rule()
Preview: Hover in load menu → push rule to stack → unhover → pop rule from stack
```

## Key Subsystems

### Rule System
A "Rule" is a 10x8 float32 matrix that parameterizes each particle's neural-net-like behavior function. Rules are managed as a stack by `RuleManager`:
- **Left click** (Select Particle mode): Read back the clicked particle's mutated rule, push to stack
- **Right click**: Pop rule (undo)
- **Full reset (Z)**: Push a zero rule
- Config save/load pushes rules to the stack

### Parameter Sweeps
Physics parameters can vary spatially (X/Y sweep) or by particle cohort. When enabled, a reticle shows the current parameter values at its position. Left click samples parameters at that position; right click enters preview mode (temporarily disables sweeps).

### Motion Blur
Temporal accumulation: run N physics steps per display frame, render intermediate frames, and blend them. Controlled by `speedmult` (physics steps per frame) and `blur_quality` (render every Nth step). The `SimulationRunner` handles both motion-blur and non-motion-blur paths through shared helpers.

### Video Recording
State machine: idle → (optional pending wait for scheduled frame) → recording → finished. While recording, `speedmult` and `blur_quality` are locked to recording settings. The orchestrator saves and restores user settings around recording.

### Screenshot
2-frame state machine: pending → in_progress → save + restore. On the override frame, settings are temporarily maxed for quality (motion blur enabled, blur_quality=1, speedmult=motion_blur_samples).

## Technologies
- **Python 3.12** - Application logic
- **ModernGL** - OpenGL 4.3 compute shader dispatch + rendering
- **GLFW** - Window management, input
- **imgui_bundle** (Dear ImGui) - Immediate-mode GUI
- **NumPy** - CPU-side array operations
- **FFmpeg** - Video encoding (via subprocess pipe)
