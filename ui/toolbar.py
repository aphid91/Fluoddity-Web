"""Toolbar: the tool selector.

A horizontal strip of buttons, exactly one highlighted -- radio semantics, but
shaped like a paint program's tool palette rather than a list of radio dots.

WHAT A TOOL MEANS TODAY
Only which behaviour the mouse has on the canvas. The Orchestrator reads its
`mouse_mode` in _apply_canvas_input and dispatches accordingly.

WHAT IT WILL MEAN LATER
The active tool is also intended to select which CONTROLS are on screen --
physics sliders while selecting, drawing controls while drawing -- inside one
docked side-panel. See the "Toolbar and the planned side-panel" section in
docs/ARCHITECTURE.md before building that; this window is deliberately shaped so
that migration does not have to unpick it.

This window stores no mode of its own (rule 10). It renders the value the
Orchestrator reports and dispatches an intent; the Orchestrator owns the truth.
"""

from __future__ import annotations

from imgui_bundle import imgui

#: (mode value, button label, shortcut key label). The mode values mirror
#: MouseMode's members BY VALUE -- the UI must not import a simulation module,
#: so the strings are the contract between the two.
TOOLS = (
    ('select', 'Select', '1'),
    ('shove', 'Shove', '2'),
    ('draw', 'Draw', '3'),
)

#: Highlight for the active tool. Bright enough to read at a glance across the
#: strip, which is the entire job of a toolbar.
_ACTIVE = imgui.ImVec4(0.16, 0.44, 0.75, 1.0)
_ACTIVE_HOVERED = imgui.ImVec4(0.22, 0.55, 0.9, 1.0)

_BUTTON_SIZE = imgui.ImVec2(58, 42)


class Toolbar:
    def _init_toolbar(self):
        self.show_toolbar = True

    def _toolbar_window(self):
        if not self.show_toolbar:
            return

        imgui.set_next_window_size(imgui.ImVec2(0, 0), imgui.Cond_.first_use_ever.value)
        expanded, self.show_toolbar = imgui.begin(
            "Tools", True, imgui.WindowFlags_.always_auto_resize.value)
        if not expanded:
            imgui.end()
            return

        current = self._status.get('mouse_mode')

        for index, (value, label, key) in enumerate(TOOLS):
            if index:
                imgui.same_line()

            active = value == current
            if active:
                imgui.push_style_color(imgui.Col_.button.value, _ACTIVE)
                imgui.push_style_color(imgui.Col_.button_hovered.value, _ACTIVE_HOVERED)
                imgui.push_style_color(imgui.Col_.button_active.value, _ACTIVE_HOVERED)

            if imgui.button(f"{label}\n[{key}]", _BUTTON_SIZE):
                self._dispatch('set_mouse_mode', value)

            # Popped on the same iteration that pushed, so the counts balance on
            # every path. An unbalanced push corrupts imgui's style stack and
            # asserts on some later frame, far from the line that caused it.
            if active:
                imgui.pop_style_color(3)

        imgui.end()
