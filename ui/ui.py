"""UI module: imgui lifecycle, all input handling, and the interface panels.

This module replaces the old `input/` module. One module owns every GLFW
callback, so there is never a question about which handler sees a click first,
and no callback chaining between two of our own modules.

RESPONSIBILITIES
  - Own the imgui context, the GLFW backend, and the docking space.
  - Accumulate raw GLFW events and freeze them into an `InputState` per frame.
  - Decide what imgui captures vs what reaches the canvas.
  - Draw the interface, and report user intent as NAMED COMMANDS.

WHAT THIS MODULE MUST NOT DO (ARCHITECTURE.md rule 10)
  It owns no simulation truth. It does not hold a copy of the config, does not
  reach into ParticleSystem, and does not decide what a command means. It reads
  values handed to it and reports named intents; the Orchestrator does the rest.
  Where UI state and sim state diverge, every question about what the app is
  doing acquires two answers and neither can be trusted.

FRAME LIFECYCLE
  The imgui frame must open before anything wants input and close after all GL
  drawing, so the interface composites on top of the simulation:

      ui.begin_frame()      # poll, snapshot input, imgui.new_frame()
      ...physics + GL rendering...
      ui.end_frame()        # build panels, imgui.render(), draw
      window.swap()
"""

from __future__ import annotations

import glfw
from imgui_bundle import imgui
from imgui_bundle.python_backends import glfw_backend

from .config_manager import ConfigManagerWindow
from .config_menu import ConfigMenu
from .drawing_window import DrawingWindow
from .input_state import InputState
from .preferences_window import PreferencesWindow
from .settings_window import SettingsWindow
from .toolbar import Toolbar, TOOLS

_MOUSE_BUTTONS = (glfw.MOUSE_BUTTON_LEFT, glfw.MOUSE_BUTTON_RIGHT,
                  glfw.MOUSE_BUTTON_MIDDLE)


class UI(ConfigMenu, ConfigManagerWindow, SettingsWindow,
         PreferencesWindow, Toolbar, DrawingWindow):
    def __init__(self, window, commands=None):
        """
        window:   the GLFW window handle (from AppWindow).
        commands: dict[str, callable] of named handlers, supplied by the
                  Orchestrator. The command dict in orchestrator.py is the
                  authoritative list -- it is enumerated there, once, and any
                  count repeated here would rot. Missing keys are ignored, so
                  the UI can offer a control the Orchestrator has not wired up
                  yet without crashing.
        """
        self.window = window
        self.commands = commands or {}

        imgui.create_context()
        io = imgui.get_io()
        io.config_flags |= imgui.ConfigFlags_.docking_enable.value

        # The backend installs its own GLFW callbacks in its constructor, so it
        # must be built BEFORE ours. We then keep its bound methods and forward
        # to them from our handlers -- imgui still sees every event, and we get
        # to inspect each one after it has updated its capture state.
        self.renderer = glfw_backend.GlfwRenderer(window)
        self._imgui_key_cb = self.renderer.keyboard_callback
        self._imgui_char_cb = self.renderer.char_callback
        self._imgui_mouse_cb = self.renderer.mouse_callback
        self._imgui_button_cb = self.renderer.mouse_button_callback
        self._imgui_scroll_cb = self.renderer.scroll_callback

        glfw.set_key_callback(window, self._on_key)
        glfw.set_char_callback(window, self._on_char)
        glfw.set_cursor_pos_callback(window, self._on_cursor_pos)
        glfw.set_mouse_button_callback(window, self._on_mouse_button)
        glfw.set_scroll_callback(window, self._on_scroll)

        # --- accumulators: written by callbacks, drained by begin_frame ---
        self._mouse_pos = glfw.get_cursor_pos(window)
        self._mouse_prev = self._mouse_pos
        self._have_prev_pos = False   # suppress a phantom delta on first move
        self._scroll = 0.0
        self._mods = 0

        self._held = {b: False for b in _MOUSE_BUTTONS}
        self._dragging = {b: False for b in _MOUSE_BUTTONS}
        self._pressed = set()
        self._released = set()
        self._any_pressed = set()

        self._keys_held = set()
        self._keys_pressed = set()
        self._keys_released = set()

        self._last_time = glfw.get_time()
        self.state = InputState()

        # Panel-owned display values, refreshed each frame by the Orchestrator
        # via set_status(). The UI renders these; it does not source them.
        #
        # Panels read these by INDEXING (self._status['key']), not .get() with a
        # local default: the Orchestrator guarantees every key of its
        # STATUS_KEYS interface, every frame, before any panel builds. A
        # KeyError here is a real bug -- a key the Orchestrator forgot -- and
        # should be heard rather than smoothed over into a permanent '-'.
        self._status = {}
        self.show_debug_panel = True

        #: Hides every panel, leaving only the menu bar. A VIEW of the windows,
        #: not a replacement for their individual toggles: unhiding restores
        #: exactly what was open, so this is safe to use for a quick look at
        #: the canvas mid-session.
        self.gui_hidden = False

        #: Settings tier, SHARED BY TWO WINDOWS: the Preferences window's
        #: Basic/Advanced radio owns it, and both Preferences and Project filter
        #: their controls by it -- switching there reveals advanced controls in
        #: both. It lives here, above both mixins, because a value two of them
        #: share belongs to neither. It used to be declared inside
        #: _init_settings_window(), which worked only because that _init_ runs
        #: before _init_preferences_window() below -- a silent ordering
        #: dependency with nothing to announce it if the order ever changed.
        self.show_advanced = False

        self._init_config_menu()
        self._init_config_manager()
        self._init_settings_window()
        self._init_preferences_window()
        self._init_toolbar()
        self._init_drawing_window()

    # ------------------------------------------------------------------
    # GLFW callbacks. Each forwards to imgui first, then records what the
    # canvas should see. Capture is decided HERE, once, so that no consumer
    # downstream has to think about it.
    # ------------------------------------------------------------------

    def _on_key(self, window, key, scancode, action, mods):
        self._imgui_key_cb(window, key, scancode, action, mods)
        self._mods = mods
        captured = imgui.get_io().want_capture_keyboard

        if action == glfw.RELEASE:
            # Releases are never filtered: a key that went down on the canvas
            # must be able to come up even if a text field grabbed focus
            # meanwhile, or it would stay stuck in keys_held forever.
            self._keys_released.add(key)
            self._keys_held.discard(key)
            return

        if captured:
            return
        self._keys_pressed.add(key)      # includes auto-repeat
        self._keys_held.add(key)

    def _on_char(self, window, char):
        self._imgui_char_cb(window, char)

    def _on_cursor_pos(self, window, x, y):
        self._imgui_mouse_cb(window, x, y)
        self._mouse_pos = (x, y)

    def _on_mouse_button(self, window, button, action, mods):
        self._imgui_button_cb(window, button, action, mods)
        self._mods = mods
        if button not in _MOUSE_BUTTONS:
            return
        captured = imgui.get_io().want_capture_mouse

        if action == glfw.PRESS:
            self._any_pressed.add(button)
            if captured:
                return
            self._pressed.add(button)
            self._held[button] = True
            # A drag is owned by whoever received the press. Recording it here
            # means the drag survives the cursor passing over an imgui window.
            self._dragging[button] = True
        elif action == glfw.RELEASE:
            self._released.add(button)
            self._held[button] = False
            self._dragging[button] = False

    def _on_scroll(self, window, x_offset, y_offset):
        self._imgui_scroll_cb(window, x_offset, y_offset)
        if not imgui.get_io().want_capture_mouse:
            self._scroll += y_offset

    # ------------------------------------------------------------------
    # Frame lifecycle
    # ------------------------------------------------------------------

    def begin_frame(self) -> InputState:
        """Poll events, freeze this frame's InputState, open the imgui frame.

        Call at the TOP of the frame so the physics and rendering that follow
        act on input from this frame rather than the previous one.
        """
        glfw.poll_events()
        self.renderer.process_inputs()

        now = glfw.get_time()
        dt = now - self._last_time
        self._last_time = now

        if self._have_prev_pos:
            delta = (self._mouse_pos[0] - self._mouse_prev[0],
                     self._mouse_pos[1] - self._mouse_prev[1])
        else:
            delta = (0.0, 0.0)
            self._have_prev_pos = True

        io = imgui.get_io()
        self.state = InputState(
            mouse_pos=self._mouse_pos,
            mouse_prev=self._mouse_prev,
            mouse_delta=delta,
            left_held=self._held[glfw.MOUSE_BUTTON_LEFT],
            right_held=self._held[glfw.MOUSE_BUTTON_RIGHT],
            middle_held=self._held[glfw.MOUSE_BUTTON_MIDDLE],
            left_pressed=glfw.MOUSE_BUTTON_LEFT in self._pressed,
            right_pressed=glfw.MOUSE_BUTTON_RIGHT in self._pressed,
            middle_pressed=glfw.MOUSE_BUTTON_MIDDLE in self._pressed,
            left_released=glfw.MOUSE_BUTTON_LEFT in self._released,
            right_released=glfw.MOUSE_BUTTON_RIGHT in self._released,
            middle_released=glfw.MOUSE_BUTTON_MIDDLE in self._released,
            left_dragging=self._dragging[glfw.MOUSE_BUTTON_LEFT],
            right_dragging=self._dragging[glfw.MOUSE_BUTTON_RIGHT],
            scroll=self._scroll,
            keys_held=frozenset(self._keys_held),
            keys_pressed=frozenset(self._keys_pressed),
            keys_released=frozenset(self._keys_released),
            mods=self._mods,
            mouse_captured=io.want_capture_mouse,
            keyboard_captured=io.want_capture_keyboard,
            any_left_pressed=glfw.MOUSE_BUTTON_LEFT in self._any_pressed,
            any_right_pressed=glfw.MOUSE_BUTTON_RIGHT in self._any_pressed,
            dt=dt,
        )

        # Drain one-shots; held/dragging state persists across frames.
        self._mouse_prev = self._mouse_pos
        self._scroll = 0.0
        self._pressed.clear()
        self._released.clear()
        self._any_pressed.clear()
        self._keys_pressed.clear()
        self._keys_released.clear()

        imgui.new_frame()
        self._dispatch_hotkeys(self.state)
        return self.state

    def end_frame(self):
        """Build the interface and draw it. Call after all GL rendering."""
        self._build_ui()
        imgui.render()
        self.renderer.render(imgui.get_draw_data())

    def shutdown(self):
        self.renderer.shutdown()

    # ------------------------------------------------------------------
    # Interface
    # ------------------------------------------------------------------

    def set_status(self, **values):
        """Hand the UI display-only values to render (rule 10: it owns none)."""
        self._status.update(values)

    def _build_ui(self):
        self._menu_bar()
        # After the menu bar: the delete confirmation is a top-level modal so it
        # survives the menu closing (a popup nested in a menu dies with it).
        #
        # The dialogs stay OUTSIDE the hide check. A modal that is open has
        # taken over input, and hiding it would leave the app apparently frozen
        # with no way to answer it.
        self._delete_dialog()
        self._save_dialog()

        # X hides every panel and leaves the menu bar, so the canvas can be
        # seen whole. Individual window toggles are untouched, so unhiding
        # brings back exactly what was open.
        if self.gui_hidden:
            return

        self._sync_input_buffers()
        self._toolbar_window()
        self._settings_window()
        self._preferences_window()
        self._drawing_window()
        self._config_manager_window()
        if self.show_debug_panel:
            self._debug_panel()

    def _debug_panel(self):
        """Minimal panel proving the input layer works end to end.

        Deliberately not a physics editor: sliders, detail tiers and tooltips
        are their own design conversation (see the roadmap). This exists so the
        plumbing is verifiable by looking at it.
        """
        s = self.state
        expanded, self.show_debug_panel = imgui.begin("Debug", True)
        if not expanded:
            imgui.end()
            return

        imgui.text(f"FPS   {1.0 / s.dt if s.dt > 0 else 0.0:6.1f}   ({s.dt * 1000:.1f} ms)")
        imgui.separator()

        imgui.text(f"mouse px    ({s.mouse_pos[0]:7.1f}, {s.mouse_pos[1]:7.1f})")
        world = self._status['mouse_world']
        if world is not None:
            imgui.text(f"mouse world ({world[0]:7.3f}, {world[1]:7.3f})")
        imgui.text(f"delta       ({s.mouse_delta[0]:7.1f}, {s.mouse_delta[1]:7.1f})")
        imgui.text(f"scroll      {s.scroll:+.1f}")
        imgui.separator()

        # The point of the panel: hover it and `capture` flips to yes, while
        # buttons/keys stop reaching the canvas.
        imgui.text(f"capture     mouse:{'yes' if s.mouse_captured else 'no ':3}"
                   f"  kb:{'yes' if s.keyboard_captured else 'no'}")
        buttons = [n for n, h in (("L", s.left_held), ("R", s.right_held),
                                  ("M", s.middle_held)) if h]
        imgui.text(f"buttons     {' '.join(buttons) if buttons else '-'}")
        drags = [n for n, d in (("L", s.left_dragging), ("R", s.right_dragging)) if d]
        imgui.text(f"dragging    {' '.join(drags) if drags else '-'}")
        imgui.text(f"keys held   {self._describe_keys(s.keys_held)}")
        imgui.separator()

        pan = self._status['cam_pan']
        imgui.text(f"cam mode    {self._status['cam_mode']}")
        imgui.text(f"tool        {self._status['mouse_mode']}"
                   f"   (1/2/3)")
        imgui.text(f"cam pan     ({pan[0]:7.3f}, {pan[1]:7.3f})")
        imgui.text(f"cam zoom    {self._status['cam_zoom']:.3f}x")
        imgui.text(f"canvas      {self._status['canvas_size']}")
        imgui.text(f"window      {self._status['window_size']}")
        imgui.separator()

        # No "hovered" row: hover-picking would cost a full-buffer dispatch
        # every frame, so the app only picks on click. The row that used to be
        # here was permanently empty.
        imgui.text(f"selected    {self._describe_pick(self._status['selected'])}")
        imgui.separator()

        imgui.text(f"preset      {self._status['preset']}")
        imgui.text(f"entities    {self._status['entity_count']}")
        imgui.text(f"configs     {self._status['config_count']}"
                   f"  (sel {self._status['selected_config']})")
        imgui.text(f"checkpoints {len(self._status['checkpoints'] or [])}")
        imgui.text(f"history     {self._status['history_cursor'] + 1}"
                   f"/{self._status['history_depth']}")
        # Two different clocks, deliberately shown together: `frame` counts
        # physics sub-steps and returns to zero on a reset, `app` counts drawn
        # frames and never does. The API schedules against the second one.
        imgui.text(f"frame       {self._status['frame_count']}")
        imgui.text(f"app frame   {self._status['app_frame']}")
        imgui.separator()

        if imgui.button("Resume" if self._status['paused'] else "Pause"):
            self._dispatch('toggle_pause')
        imgui.same_line()
        if imgui.button("Reload"):
            self._dispatch('reload')
        imgui.same_line()
        if imgui.button("Reset"):
            self._dispatch('reset')
        imgui.same_line()
        if imgui.button("< Prev"):
            self._dispatch('prev_preset')
        imgui.same_line()
        if imgui.button("Next >"):
            self._dispatch('next_preset')

        if imgui.button("Toggle View"):
            self._dispatch('toggle_camera_mode')
        imgui.same_line()
        if imgui.button("Reset View"):
            self._dispatch('reset_camera')

        imgui.text_disabled("WASD: pan   Q/E: zoom   scroll: zoom")
        imgui.text_disabled("SPACE: pause   R: reset   U: reload shaders")
        imgui.text_disabled("B: randomize behavior   F: randomize seed")
        imgui.text_disabled("X: hide GUI")
        imgui.text_disabled("TAB: view   HOME: reset view")
        imgui.text_disabled("1/2/3: tool   ctrl+Z/ctrl+shift+Z: undo/redo")
        imgui.end()

    @staticmethod
    def _describe_pick(result) -> str:
        """Format a PickResult. Structural duck-typing rather than importing
        the type, so the UI stays free of simulation modules (rule 10)."""
        if result is None or not getattr(result, 'hit', False):
            return "-"
        return (f"#{result.index}  ({result.pos[0]:.3f}, {result.pos[1]:.3f})"
                f"  d={result.distance:.4f}")

    @staticmethod
    def _describe_keys(keys) -> str:
        if not keys:
            return "-"
        names = []
        for k in sorted(keys):
            name = glfw.get_key_name(k, 0)
            if name:
                names.append(name.upper())
            elif k == glfw.KEY_SPACE:
                names.append("SPACE")
            elif k == glfw.KEY_LEFT_SHIFT or k == glfw.KEY_RIGHT_SHIFT:
                names.append("SHIFT")
            elif k == glfw.KEY_LEFT_CONTROL or k == glfw.KEY_RIGHT_CONTROL:
                names.append("CTRL")
            elif k == glfw.KEY_LEFT_ALT or k == glfw.KEY_RIGHT_ALT:
                names.append("ALT")
            elif k == glfw.KEY_LEFT:
                names.append("LEFT")
            elif k == glfw.KEY_RIGHT:
                names.append("RIGHT")
            else:
                names.append(str(k))
        return " ".join(names)

    # ------------------------------------------------------------------
    # Commands
    # ------------------------------------------------------------------

    def _dispatch_hotkeys(self, state: InputState):
        """Keyboard shortcuts. Already capture-filtered by the callback, so
        typing 'r' into a text field will not reload the shaders -- and Ctrl+Z
        in a filename box edits the text rather than undoing a selection."""
        ctrl = bool(state.mods & glfw.MOD_CONTROL)
        shift = bool(state.mods & glfw.MOD_SHIFT)

        # Ctrl-modified first: plain 'z' must not also fire when Ctrl is held.
        if ctrl and glfw.KEY_Z in state.keys_pressed:
            self._dispatch('redo' if shift else 'undo')
            return
        if ctrl and glfw.KEY_Y in state.keys_pressed:
            self._dispatch('redo')
            return
        # Copy/paste, mapped to the config clipboard: Ctrl+C checkpoints the
        # whole project, Ctrl+V restores the newest checkpoint. The familiar
        # keys for the familiar idea -- this IS the app's copy/paste, there is
        # no other clipboard to conflict with.
        if ctrl and glfw.KEY_C in state.keys_pressed:
            self._dispatch('set_checkpoint')
            return
        if ctrl and glfw.KEY_V in state.keys_pressed:
            self._dispatch('load_latest_checkpoint')
            return
        # Revert: reload the project's own file. Deliberately Ctrl+R next to
        # bare R for Reset -- both put things back, one the simulation and one
        # the settings. Resolved through the same helper the Project window's
        # button uses, so a project with no file on disk does nothing here
        # rather than dispatching a load of nothing.
        if ctrl and glfw.KEY_R in state.keys_pressed:
            entry = self._revert_entry()
            if entry is not None:
                self._dispatch('load_config', entry)
            return
        # Every other Ctrl combination is left alone, so Ctrl+<key> can never
        # trigger a bare-key shortcut below.
        if ctrl:
            return

        # Tool selection. Number keys pick a tool DIRECTLY, paint-program style:
        # there is no sensible "next" tool, and cycling to reach the one you
        # want gets tedious fast while drawing. Zipped against TOOLS, so the
        # keys follow the toolbar's order and adding a tool needs one more key
        # here and nothing else.
        for key, (value, _label, _shortcut) in zip(
                (glfw.KEY_1, glfw.KEY_2, glfw.KEY_3, glfw.KEY_4), TOOLS):
            if key in state.keys_pressed:
                self._dispatch('set_mouse_mode', value)

        # X is handled HERE rather than dispatched, because hiding the panels is
        # the UI's own business -- no simulation state changes, so there is
        # nothing for the Orchestrator to broker (rule 10 cuts both ways).
        if glfw.KEY_X in state.keys_pressed:
            self.gui_hidden = not self.gui_hidden

        # One-shots only. WASD/QE navigation is CONTINUOUS and lives in the
        # Orchestrator, which reads keys_held against dt -- routing it through
        # here would make it one step per key-repeat.
        for key, command in (
            (glfw.KEY_SPACE, 'toggle_pause'),
            (glfw.KEY_R, 'reset'),
            (glfw.KEY_U, 'reload'),
            (glfw.KEY_F, 'randomize_seed'),
            (glfw.KEY_B, 'randomize_behavior'),
            (glfw.KEY_RIGHT, 'next_preset'),
            (glfw.KEY_LEFT, 'prev_preset'),
            (glfw.KEY_TAB, 'toggle_camera_mode'),
            (glfw.KEY_HOME, 'reset_camera'),
        ):
            if key in state.keys_pressed:
                self._dispatch(command)

    def _dispatch(self, name, *args):
        handler = self.commands.get(name)
        if handler is not None:
            handler(*args)

    def _dispatch_result(self, name, *args):
        """Dispatch and return the handler's value.

        Most commands are fire-and-forget, but a few (taking a snapshot) need
        an answer back. Returns None when the command is not wired up.
        """
        handler = self.commands.get(name)
        return handler(*args) if handler is not None else None
