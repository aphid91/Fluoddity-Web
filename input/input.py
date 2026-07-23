"""Input / interaction module.

Owns GLFW keyboard event handling and translates raw key events into named
commands. It does NOT reach into Camera or ParticleSystem directly: the
Orchestrator supplies a `commands` mapping (name -> callable), and Input just
invokes the appropriate command. This keeps interaction decoupled from what the
commands actually do.

Current bindings (the hot-reload / preset workflow the README anticipates):
  R            -> reload   (recompile all shaders from disk)
  SPACE        -> reset    (reset simulation frame counter)
  LEFT / RIGHT -> prev/next preset config
"""

import glfw


class Input:
    def __init__(self, window, commands):
        """
        window:   the GLFW window handle (from AppWindow).
        commands: dict[str, callable] of named command handlers, supplied by the
                  Orchestrator. Recognized keys: 'reload', 'reset',
                  'next_preset', 'prev_preset'. Missing keys are simply ignored.
        """
        self.window = window
        self.commands = commands
        glfw.set_key_callback(window, self._on_key)

    def _on_key(self, window, key, scancode, action, mods):
        if action != glfw.PRESS:
            return

        if key == glfw.KEY_R:
            self._dispatch('reload')
        elif key == glfw.KEY_SPACE:
            self._dispatch('reset')
        elif key == glfw.KEY_RIGHT:
            self._dispatch('next_preset')
        elif key == glfw.KEY_LEFT:
            self._dispatch('prev_preset')

    def _dispatch(self, name):
        handler = self.commands.get(name)
        if handler is not None:
            handler()
