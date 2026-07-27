"""Generic, stateless OpenGL helpers shared across modules.

This module is the sanctioned "shared util" exception to the module-per-folder
rule: it holds no domain state. The only mutable module-level state is
MUTED_TRYSET_WARNINGS, a purely diagnostic warning-suppression counter that does
not interface with any other part of the program.
"""

import re
from pathlib import Path

import moderngl
import numpy as np

# Shared includes (e.g. common.glsl) live here. `#include "name"` resolves
# relative to the including file first, then falls back to this directory.
_SHARED_SHADER_DIR = Path(__file__).parent / "shaders"

_INCLUDE_RE = re.compile(r'^\s*#include\s+"([^"]+)"\s*$')


def read_shader(path: str) -> str:
    """Read a shader, resolving `#include "file.glsl"` directives.

    GLSL has no preprocessor include and moderngl does not add one, so we do the
    text substitution here. Without this, shared structs would have to be
    copy-pasted into every shader that uses them -- which is exactly how the
    reference implementation's struct definitions drifted out of sync.

    Each file is included at most once per compilation unit (include-guard
    semantics), so a diamond include does not produce duplicate definitions.
    """
    return _read_with_includes(Path(path), already_included=set())


def _read_with_includes(path: Path, already_included: set) -> str:
    path = path.resolve()
    source = path.read_text()

    out_lines = []
    for line_no, line in enumerate(source.splitlines(), start=1):
        match = _INCLUDE_RE.match(line)
        if match is None:
            out_lines.append(line)
            continue

        target = _resolve_include(match.group(1), path, line_no)
        if target in already_included:
            # Already pulled in by another include; emit nothing.
            continue
        already_included.add(target)

        # #line 1 would be nice here, but GLSL's line directive numbering is
        # driver-inconsistent; a comment banner keeps errors traceable instead.
        out_lines.append(f'// ==== begin include: {target.name} ====')
        out_lines.append(_read_with_includes(target, already_included))
        out_lines.append(f'// ==== end include: {target.name} ====')

    return '\n'.join(out_lines)


def _resolve_include(name: str, including_file: Path, line_no: int) -> Path:
    """Find an included file: sibling of the includer first, then shared/shaders."""
    for candidate in (including_file.parent / name, _SHARED_SHADER_DIR / name):
        if candidate.is_file():
            return candidate.resolve()
    raise FileNotFoundError(
        f'{including_file}:{line_no}: #include "{name}" not found '
        f'(looked in {including_file.parent} and {_SHARED_SHADER_DIR})'
    )


#: The fullscreen quad, as two triangles in clip space. Paired with
#: shared/shaders/fullscreen_quad.vert, which is the vertex shader for every
#: fullscreen pass in the app.
_QUAD_VERTICES = np.array([
    -1, -1,  1, -1,  1,  1,
    -1, -1,  1,  1, -1,  1,
], dtype=np.float32)


def quad_vbo(ctx: moderngl.Context) -> moderngl.Buffer:
    """A fullscreen-quad vertex buffer.

    Every fullscreen pass wants the same six vertices, and before this existed
    three modules each built their own copy. Callers still hold the buffer they
    are given: a VBO outlives the program it is bound through, so it is created
    once per module and reused across hot-reloads.
    """
    return ctx.buffer(_QUAD_VERTICES.tobytes())


def quad_vao(ctx: moderngl.Context, program: moderngl.Program,
             vbo: moderngl.Buffer) -> moderngl.VertexArray:
    """Bind `program` to a fullscreen-quad VBO.

    Separate from quad_vbo() because the two have different lifetimes: a VAO
    binds a program, so it must be rebuilt on every reload, while the VBO it
    references does not.
    """
    return ctx.vertex_array(program, [(vbo, '2f', 'in_position')])


MUTED_TRYSET_WARNINGS = {}


def tryset(program: moderngl.Program, uniform, value):
    """
    Gracefully handle a uniform that doesn't appear in program.
    Uniforms are frequently optimized out if they are not used in the current version of the shader.
    """
    if uniform in program:
        program[uniform] = value
    else:
        global MUTED_TRYSET_WARNINGS
        if uniform not in MUTED_TRYSET_WARNINGS:
            MUTED_TRYSET_WARNINGS[uniform] = 0
        MUTED_TRYSET_WARNINGS[uniform] += 1
        if MUTED_TRYSET_WARNINGS[uniform] < 10:
            print('Warning: ', uniform, ' not present in ', program)
