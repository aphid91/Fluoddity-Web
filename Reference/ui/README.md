# UI Package

The `ui/` package implements the ImGui-based user interface for Fluoddity. It uses a **mixin architecture**: each file defines a mixin class with related rendering methods, and the main `UI` class in `core.py` inherits them all via multiple inheritance.

## Why Mixins?

ImGui is immediate-mode: every frame, all widgets are re-rendered by calling functions that read/write shared state. Each rendering method needs access to ~10+ shared attributes (`self.state`, `self.ctx`, `self.keybindings`, etc.). Mixins keep files short while preserving simple `self.*` access without passing context bundles.

## Module Responsibilities

| File | Mixin Class | What It Renders |
|------|-------------|-----------------|
| `core.py` | `UI` (inherits all) | `__init__`, GLFW callbacks, `get_state()`, render dispatch, cleanup |
| `menu_bar.py` | `MenuBarMixin` | File/Reset/Help/Extras menus, load submenu with live preview, auto-close |
| `physics_window.py` | `PhysicsWindowMixin` | Physics settings: Basics/Forces/Advanced slider groups, multi-load mode |
| `slider_widgets.py` | `SliderWidgetsMixin` | `slider_float_with_range_menu()`, context menus, jitter, sweep/range buttons |
| `preferences_window.py` | `PreferencesWindowMixin` | World size, physics frequency, mouse mode, view options, appearance |
| `help_windows.py` | `HelpWindowsMixin` | Controls, tutorial, parameter sweeps, performance, video recording windows |
| `history_window.py` | `HistoryWindowMixin` | Rule history list, tooltip shader rendering |
| `config_browser.py` | `ConfigBrowserMixin` | Config file scanning/caching, hierarchical load submenu |
| `popup_modals.py` | `PopupModalsMixin` | Save/Overwrite/Delete confirmation dialogs |

## Import Path

External code imports the UI class the same way as before:

```python
from ui import UI  # Works via ui/__init__.py re-export
```

## How to Add a New Window

1. Create `ui/my_window.py` with a mixin class:
   ```python
   class MyWindowMixin:
       def render_my_window(self):
           imgui.begin("My Window")
           # ... widgets that read/write self.state ...
           imgui.end()
   ```

2. Add the mixin to the `UI` class inheritance in `core.py`:
   ```python
   from .my_window import MyWindowMixin

   class UI(
       MenuBarMixin,
       # ... existing mixins ...
       MyWindowMixin,
   ):
   ```

3. Call `self.render_my_window()` from the `render()` method in `core.py`.

4. If the window needs new state, add fields to `__init__` in `core.py`.

## How to Add a New Physics Slider

See the existing sliders in `physics_window.py` and the helper method `slider_float_with_range_menu()` in `slider_widgets.py`. The full pipeline from slider to GPU is documented in [`docs/adding_ui_shader_params.md`](../docs/adding_ui_shader_params.md).
