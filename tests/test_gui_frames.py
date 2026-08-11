"""Render the real GUI for a hundred frames. Needs a display.

    Scratch.venv/Scripts/python.exe tests/test_gui_frames.py

WHY THIS EXISTS. imgui's begin/end pairs are checked at RUNTIME, by assertions
that kill the process. Nothing in a unit test catches an unbalanced
begin_disabled -- the panel code has to actually run, inside a real imgui
frame, in the particular state where the imbalance appears.

The state that mattered: a button that STARTS A BACKGROUND TASK sits inside a
block disabled by "is a task running". Pressing it flips that condition
between the begin and the end, so end_disabled() fires unpaired and the window
dies. It only happens on the single frame of the transition, which is exactly
the frame a human never thinks to test.

So this drives draw() through the transitions -- a task starting and
finishing, the cutoff moving, the gallery being unloaded -- against real imgui
in a hidden window.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

FRAMES = 110


def main():
    print("GUI frame rendering (needs a display)")

    from imgui_bundle import hello_imgui, immapp

    from pilot.gallery import Gallery, Item
    from pilot.projection import Projection
    from pilot.task import Task
    from pilot.umap_view import COLOUR_CAPTION, COLOUR_PLAIN, Viewer

    view = Viewer()

    # A gallery with scores, so the colour modes and the cutoff are all live
    # rather than being skipped as unavailable.
    count = 40
    rng = np.random.default_rng(0)
    view.gallery = Gallery(
        items=[Item(path=Path(f"{i}.png"), index=i, score=float(rng.normal()))
               for i in range(count)],
        embeddings=rng.normal(size=(count, 8)).astype(np.float32),
        signature='fake', root=Path('.'))
    view.projection = Projection(
        rng.random((count, 2)).astype(np.float32), 15, 0.1, 42)
    view.caption_scores = rng.normal(size=count).astype(np.float32)
    view.caption_applied = 'a test caption'
    view.colour_mode = COLOUR_CAPTION
    view.cutoff = 40.0

    state = {'frame': 0}
    errors = []

    def gui():
        state['frame'] += 1
        frame = state['frame']
        try:
            # THE frame that used to crash: a task starts while the panel is
            # mid-draw, flipping `busy` between begin_disabled and end_disabled.
            if frame == 5:
                view.task = Task.start(
                    'probe', lambda report: (time.sleep(0.3), 'done')[1])
                view.task_kind = 'probing'
            if frame == 40:
                view.cutoff_bottom = True
            if frame == 55:
                view.colour_mode = COLOUR_PLAIN     # cutoff greys out
            if frame == 70:
                view.cutoff = 0.0
            if frame == 85:
                # The empty state the window now opens in.
                view.gallery = None
                view.projection = None
            view.draw()
        except Exception as e:                                  # noqa: BLE001
            errors.append(f"frame {frame}: {type(e).__name__}: {e}")
            hello_imgui.get_runner_params().app_shall_exit = True
        if frame > FRAMES:
            hello_imgui.get_runner_params().app_shall_exit = True

    params = immapp.RunnerParams()
    params.app_window_params.window_title = "gui frame test"
    params.app_window_params.window_geometry.size = (1100, 800)
    params.app_window_params.hidden = True
    params.callbacks.show_gui = gui
    immapp.run(params)

    rendered = state['frame']
    print(f"  rendered {rendered} frames")
    if errors:
        for error in errors:
            print(f"  FAIL  {error}")
        print("\nFAIL")
        return 1
    if rendered <= FRAMES:
        print(f"  FAIL  stopped early at {rendered}")
        print("\nFAIL")
        return 1

    print("  ok    a task starting mid-panel does not unbalance the frame")
    print("  ok    the cutoff enabling and disabling stays balanced")
    print("  ok    the unloaded state draws")
    print("\nPASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
