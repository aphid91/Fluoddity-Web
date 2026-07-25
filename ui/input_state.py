"""InputState: an immutable snapshot of input for one frame.

The UI module accumulates raw GLFW events as they arrive (asynchronously, via
callbacks) and freezes them into one of these at the top of each frame. Everything
downstream reads the snapshot rather than polling GLFW, so every consumer in a
frame sees exactly the same input -- no mid-frame tearing where the physics step
and the UI disagree about where the mouse is.

CAPTURE IS ALREADY RESOLVED IN HERE. The `*_captured` fields record what imgui
claimed, and the plain fields (`left_pressed`, `scroll`, `keys_pressed`, ...) are
already filtered: they describe input meant for the CANVAS. A consumer that wants
canvas input just reads the plain field and does not think about imgui at all.
The unfiltered variants exist for the rare case that needs them (e.g. dismissing
a transient overlay on any click, wherever it landed).
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class InputState:
    """One frame's input. Frozen: consumers read, never mutate."""

    # --- pointer ---------------------------------------------------------
    # Screen pixels, GLFW convention (origin top-left, y down).
    mouse_pos: tuple[float, float] = (0.0, 0.0)
    mouse_prev: tuple[float, float] = (0.0, 0.0)
    #: Movement since last frame. Zero on the frame the mouse enters the window,
    #: so a re-entering cursor cannot produce a huge phantom drag.
    mouse_delta: tuple[float, float] = (0.0, 0.0)

    #: Held state, filtered by imgui capture.
    left_held: bool = False
    right_held: bool = False
    middle_held: bool = False

    #: One-shot: went down this frame (canvas only).
    left_pressed: bool = False
    right_pressed: bool = False
    middle_pressed: bool = False

    #: One-shot: came up this frame. NOT capture-filtered -- a release must
    #: always be delivered to whoever saw the press, or a drag that ends over
    #: an imgui window would never terminate and the canvas would stay "grabbed".
    left_released: bool = False
    right_released: bool = False
    middle_released: bool = False

    #: True while a canvas drag is in progress: the press landed on the canvas
    #: and the button has not come up yet. Stays true even if the cursor moves
    #: over an imgui window mid-drag, which is what makes dragging feel right.
    left_dragging: bool = False
    right_dragging: bool = False

    #: Accumulated wheel movement this frame (canvas only).
    scroll: float = 0.0

    # --- keyboard --------------------------------------------------------
    #: GLFW key codes currently held (canvas only).
    keys_held: frozenset[int] = frozenset()
    #: Went down this frame, including auto-repeat (canvas only).
    keys_pressed: frozenset[int] = frozenset()
    #: Came up this frame. Not capture-filtered, for the same reason as
    #: mouse releases.
    keys_released: frozenset[int] = frozenset()
    #: GLFW modifier bitmask from the most recent key event.
    mods: int = 0

    # --- imgui capture ---------------------------------------------------
    #: imgui wants the pointer (cursor is over a window/control).
    mouse_captured: bool = False
    #: imgui wants the keyboard (a text field has focus).
    keyboard_captured: bool = False

    #: Unfiltered one-shots: true even when imgui captured the click.
    any_left_pressed: bool = False
    any_right_pressed: bool = False

    # --- frame -----------------------------------------------------------
    #: Seconds since the previous frame.
    dt: float = 0.0

    def key_held(self, key: int) -> bool:
        return key in self.keys_held

    def key_pressed(self, key: int) -> bool:
        return key in self.keys_pressed
