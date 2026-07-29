"""The hot-reload contract survives a broken shader.

WHY THIS TEST EXISTS
CLAUDE_README.md's contract is the one thing E1's consolidation could quietly
break: a failed compile must keep the LAST WORKING program rather than crashing
or leaving a null. Eight hand-written try/except blocks became two helpers, so
the contract now has one implementation -- worth proving rather than assuming.

For each GPU module it: reloads clean, corrupts the shader on disk, reloads,
and checks the module still holds its old working program; then restores the
file and checks it recovers.

Runs headless (moderngl standalone context), so it needs a GPU but no window.

    Scratch.venv/Scripts/python.exe tests/test_hot_reload.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import moderngl

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from assembler.assembler import Assembler          # noqa: E402
from camera.camera import Camera                    # noqa: E402
from particle_system.particle_system import ParticleSystem  # noqa: E402
from strafe_field.strafe_field import StrafeField   # noqa: E402

#: Garbage that no GLSL compiler will accept, appended to a shader to break it.
POISON = "\n#error deliberately broken by test_hot_reload\n"


class Corrupt:
    """Temporarily append POISON to a shader file, restoring on exit."""

    def __init__(self, path):
        self.path = REPO / path

    def __enter__(self):
        self.original = self.path.read_bytes()
        self.path.write_bytes(self.original + POISON.encode())
        return self

    def __exit__(self, *exc):
        self.path.write_bytes(self.original)
        return False


def check(name, cond, fails):
    print(f"  {'OK  ' if cond else 'FAIL'} {name}")
    return fails + (0 if cond else 1)


def probe(label, obj, attrs, shader, fails):
    """Reload clean, break the shader, reload, restore, reload.

    `attrs` are the program attributes that must survive a failed compile.
    """
    print(f"\n{label}")
    obj.reload()
    before = {a: getattr(obj, a) for a in attrs}
    fails = check("compiles clean", all(v is not None for v in before.values()), fails)

    with Corrupt(shader):
        obj.reload()          # must not raise
        after = {a: getattr(obj, a) for a in attrs}
    fails = check("survives a broken shader (no exception)", True, fails)
    fails = check("keeps the OLD program, not None",
                  all(after[a] is not None for a in attrs), fails)
    fails = check("the kept program is the SAME object as before",
                  all(after[a] is before[a] for a in attrs), fails)

    obj.reload()              # file restored by the context manager
    recovered = {a: getattr(obj, a) for a in attrs}
    fails = check("recovers after the shader is fixed",
                  all(recovered[a] is not None for a in attrs), fails)
    fails = check("recovery installs a NEW program",
                  all(recovered[a] is not before[a] for a in attrs), fails)
    return fails


def main() -> int:
    ctx = moderngl.create_standalone_context(require=430)
    config = sorted((REPO / 'configs').glob('*.json'))[0]
    fails = 0

    system = ParticleSystem(ctx, canvas_size=(128, 128), config_path=config,
                            entity_count=4096)
    fails = probe("ParticleSystem: entity update (COMPUTE)", system,
                  ['entity_update_program'],
                  'particle_system/shaders/entity_update.glsl', fails)
    fails = probe("ParticleSystem: brush splat (empty VAO)", system,
                  ['brush_splat_program', 'brush_vao'],
                  'particle_system/shaders/brush.frag', fails)
    fails = probe("ParticleSystem: canvas update (quad VAO)", system,
                  ['canvas_update_program', 'canvas_vao'],
                  'particle_system/shaders/canvas.frag', fails)
    fails = probe("EntityPicker (COMPUTE)", system.picker, ['program'],
                  'particle_system/shaders/entity_pick.glsl', fails)

    camera = Camera(ctx)
    fails = probe("Camera: present (quad VAO)", camera,
                  ['present_program', 'present_vao'],
                  'camera/shaders/camera.frag', fails)
    fails = probe("Camera: particles (empty VAO)", camera,
                  ['particle_program', 'particle_vao'],
                  'camera/shaders/cam_brush.frag', fails)
    fails = probe("Camera: accumulate (quad VAO)", camera,
                  ['accumulate_program', 'accumulate_vao'],
                  'camera/shaders/accumulate.frag', fails)

    assembler = Assembler(ctx)
    fails = probe("Assembler: frame assembly", assembler, ['program', 'vao'],
                  'assembler/shaders/frame_assembly.frag', fails)
    fails = probe("Bloom: downsample", assembler.bloom,
                  ['downsample_program', 'downsample_vao'],
                  'assembler/shaders/bloom_downsample.frag', fails)
    fails = probe("Bloom: upsample", assembler.bloom,
                  ['upsample_program', 'upsample_vao'],
                  'assembler/shaders/bloom_upsample.frag', fails)

    field = StrafeField(ctx, (128, 128))
    fails = probe("StrafeField: draw", field, ['program', 'vao'],
                  'strafe_field/shaders/strafe_draw.frag', fails)

    # One half of bloom breaking must not take the other half with it -- they
    # are separate reload_program calls for exactly this reason.
    print("\nBloom: one half breaking spares the other")
    assembler.bloom.reload()
    kept = assembler.bloom.upsample_program
    with Corrupt('assembler/shaders/bloom_downsample.frag'):
        assembler.bloom.reload()
    fails = check("upsample still compiled while downsample was broken",
                  assembler.bloom.upsample_program is not None, fails)
    fails = check("upsample was itself reloaded (not the stale one)",
                  assembler.bloom.upsample_program is not kept, fails)

    print("\nPASS: hot-reload contract holds" if not fails
          else f"\nFAIL: {fails} check(s)")
    return 1 if fails else 0


if __name__ == '__main__':
    raise SystemExit(main())
