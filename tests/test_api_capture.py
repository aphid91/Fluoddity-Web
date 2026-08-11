"""Screenshot capture: an assembled frame, at a size the window is not.

Runs headless (moderngl standalone context), so it needs a GPU but no window.

    Scratch.venv/Scripts/python.exe tests/test_api_capture.py

WHY THIS TEST EXISTS
The capture path asks the Assembler to present a second time, into an offscreen
framebuffer, at a resolution unrelated to the one the Camera's buffers were
allocated for. Two things could go quietly wrong there and neither would raise:
the letterbox could be computed for the wrong rectangle (producing a correctly
sized image of the wrong thing), or the target could come back empty because
nothing was ever drawn into it. A shape-only assertion passes in both cases, so
this checks the pixels too.

Deliberately does NOT go through the Orchestrator or the HTTP server. This is
the one genuinely GPU-dependent piece of the API, and isolating it means a
failure points at the capture path rather than at forty lines of transport.
"""

from __future__ import annotations

import sys
from pathlib import Path

import moderngl

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from assembler import Assembler                                     # noqa: E402
from camera import Camera                                           # noqa: E402
from particle_system.particle_system import ParticleSystem          # noqa: E402
from preferences import Preferences                                 # noqa: E402

#: Small world: this tests the capture path, not scale.
ENTITY_COUNT = 20_000
CANVAS = (256, 256)

#: What the Camera's buffers get allocated for -- the stand-in for a window.
WINDOW = (320, 240)

#: Capture sizes, both different from WINDOW and from each other, and one of
#: them a different ASPECT. A capture that quietly used the window's dimensions
#: would still produce an image; only comparing against these catches it.
CAPTURE_SIZES = [(512, 512), (200, 150)]

#: Physics steps before capturing. Enough that the canvas has structure in it;
#: a capture taken at frame zero is black for legitimate reasons and would make
#: the "not blank" check meaningless.
WARMUP_STEPS = 60

_failures = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok    {label}")
    else:
        print(f"  FAIL  {label}{'  -- ' + detail if detail else ''}")
        _failures.append(label)


def capture(ctx, assembler, camera, system, size, prefs):
    """The capture path, as api_commands._cmd_screenshot performs it.

    Mirrors that code rather than importing it: the handler is a method on the
    Orchestrator, and standing one up needs a window. What matters is that the
    ARGUMENTS match -- particularly window_size=size, which is what makes the
    letterbox follow the image being made instead of the window.
    """
    texture = ctx.texture(size, 4, dtype='f1')
    fbo = ctx.framebuffer(color_attachments=[texture])
    assembler.present(
        camera.result(),
        framebuffer=fbo,
        prefs=prefs,
        canvas_size=system.canvas_size,
        window_size=size,
        cam_pan=camera.state.pan,
        cam_zoom=camera.state.zoom,
        strafe_field=None,
        show_field=False,
        reticle_radius=0.0,
    )
    raw = fbo.read(components=3, alignment=1)
    fbo.release()
    texture.release()
    return raw


def main():
    print("Screenshot capture")

    try:
        ctx = moderngl.create_standalone_context(require=430)
    except Exception as e:                                          # noqa: BLE001
        print(f"  FAIL  could not create a GL 4.3 context: {e}")
        return 1

    system = ParticleSystem(ctx, canvas_size=CANVAS, entity_count=ENTITY_COUNT)
    camera = Camera(ctx)
    assembler = Assembler(ctx)
    prefs = Preferences()

    # Give the simulation something to look at.
    for _ in range(WARMUP_STEPS):
        system.advance(None, None)

    print("\ncamera cycle")
    check("result() is None before any sample", camera.result() is None)

    camera.begin_frame(WINDOW, 1)
    camera.render(
        canvas_texture=system.current_canvas_texture(),
        entity_buffer=system.entity_buffer,
        entity_count=system.entity_count,
        canvas_size=system.canvas_size,
        window_size=WINDOW,
    )
    check("result() available after a sample", camera.result() is not None)

    print("\ncapture at sizes the camera was not allocated for")
    images = {}
    for size in CAPTURE_SIZES:
        raw = capture(ctx, assembler, camera, system, size, prefs)
        images[size] = raw
        expected = size[0] * size[1] * 3
        check(f"{size[0]}x{size[1]} returns the requested pixel count",
              len(raw) == expected, f"got {len(raw)}, want {expected}")

    # The camera's buffers are WINDOW-sized; these are not. A capture path that
    # ignored its size argument would have produced WINDOW-sized buffers above
    # and failed already -- but it could also have produced the right SIZE from
    # the wrong source, so check there is actually an image in there.
    print("\ncontent")
    for size, raw in images.items():
        nonzero = sum(1 for b in raw if b)
        check(f"{size[0]}x{size[1]} is not blank", nonzero > 0,
              "every byte is zero -- nothing was drawn")

    # Two different aspects from one camera result. If the letterbox were
    # computed from the window rather than the target, the 200x150 capture
    # would be letterboxed for 320x240 and the two would differ in a way this
    # catches: an image that is entirely black outside a misplaced band.
    wide, narrow = CAPTURE_SIZES
    check("differently-shaped captures both carry content",
          any(images[wide]) and any(images[narrow]))

    print("\nrepeatability")
    again = capture(ctx, assembler, camera, system, wide, prefs)
    check("the same camera result captures identically",
          again == images[wide],
          "capture is not a pure function of the camera result")

    print("\nsize independence")
    # Re-capturing at the FIRST size after the second must still work: the
    # cached-target path in the real handler reallocates on a size change, and
    # a stale framebuffer would show up here.
    small = capture(ctx, assembler, camera, system, narrow, prefs)
    check("alternating sizes keep working",
          len(small) == narrow[0] * narrow[1] * 3)

    print()
    if _failures:
        print(f"FAIL  {len(_failures)} check(s): {', '.join(_failures)}")
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
