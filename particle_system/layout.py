"""Parse GPU struct layouts out of common.glsl into numpy dtypes.

`shared/shaders/common.glsl` is the single source of truth for the layout of
every struct that crosses the host/GPU boundary. This module reads those
declarations and produces the matching numpy dtype, so the host packing code
can never drift out of sync with the shader.

Why parse the GLSL instead of generating it from Python? Because this is a
teaching tool where users hand-edit shaders live (see the hot-reload contract
in CLAUDE_README.md). Machine-generated GLSL would be hostile to that. Making
the .glsl file the authority keeps it hand-authorable; the cost is this parser,
and that cost is kept small by the vec4-only rule.

THE PARSER IS DELIBERATELY STRICT. It accepts only vec4, fixed-size arrays,
and previously-declared structs. Anything else raises LayoutError naming the
offending line. This is not pedantry: a struct layout mismatch does not crash
or error at runtime -- it silently reinterprets memory, and the simulation just
behaves subtly wrong. Failing loudly at startup is the entire point.
"""

from __future__ import annotations

import re
from pathlib import Path

import numpy as np

_COMMON_GLSL = Path(__file__).parent.parent / "shared" / "shaders" / "common.glsl"

# The only scalar type the vec4-only rule permits.
_VEC4 = 'vec4'
_VEC4_DTYPE = np.dtype('<4f4')  # 16 bytes, little-endian float32

_STRUCT_RE = re.compile(r'\bstruct\s+(\w+)\s*\{(.*?)\}\s*;', re.DOTALL)
_MEMBER_RE = re.compile(r'^(\w+)\s+(\w+)\s*(?:\[\s*(\d+)\s*\])?$')
_LINE_COMMENT_RE = re.compile(r'//.*?$', re.MULTILINE)
_BLOCK_COMMENT_RE = re.compile(r'/\*.*?\*/', re.DOTALL)


class LayoutError(Exception):
    """Raised when common.glsl contains a layout the vec4-only rule forbids."""


def _strip_comments(source: str) -> str:
    source = _BLOCK_COMMENT_RE.sub('', source)
    return _LINE_COMMENT_RE.sub('', source)


def parse_structs(source: str, origin: str = '<string>') -> dict[str, np.dtype]:
    """Parse every struct declaration in `source` into a numpy dtype.

    Structs must be declared before use (as GLSL itself requires), so a single
    forward pass resolves nested types.
    """
    structs: dict[str, np.dtype] = {}
    clean = _strip_comments(source)

    for match in _STRUCT_RE.finditer(clean):
        name = match.group(1)
        body = match.group(2)
        # Line number in the *stripped* text still matches the original, since
        # comment removal preserves newlines everywhere except block comments.
        line_no = clean.count('\n', 0, match.start()) + 1
        structs[name] = _parse_struct_body(name, body, structs, origin, line_no)

    return structs


def _parse_struct_body(name, body, known_structs, origin, struct_line) -> np.dtype:
    fields: list[tuple[str, np.dtype] | tuple[str, np.dtype, int]] = []

    for raw in body.split(';'):
        decl = ' '.join(raw.split())
        if not decl:
            continue

        member = _MEMBER_RE.match(decl)
        if member is None:
            raise LayoutError(
                f'{origin}: struct {name} (near line {struct_line}): '
                f'cannot parse member declaration "{decl}". '
                f'Only simple declarations like "vec4 name;" or '
                f'"StructName name[10];" are supported.'
            )

        type_name, field_name, array_len = member.groups()
        base = _dtype_for_type(type_name, name, field_name, known_structs,
                               origin, struct_line)

        if array_len is None:
            fields.append((field_name, base))
        else:
            fields.append((field_name, base, int(array_len)))

    if not fields:
        raise LayoutError(
            f'{origin}: struct {name} (near line {struct_line}) has no members.'
        )

    dtype = np.dtype(fields)
    _assert_vec4_aligned(name, dtype, origin, struct_line)
    return dtype


def _dtype_for_type(type_name, struct_name, field_name, known_structs,
                    origin, struct_line) -> np.dtype:
    if type_name == _VEC4:
        return _VEC4_DTYPE
    if type_name in known_structs:
        return known_structs[type_name]

    raise LayoutError(
        f'{origin}: struct {struct_name} (near line {struct_line}): '
        f'member "{type_name} {field_name}" uses type "{type_name}", which is '
        f'not allowed.\n'
        f'  common.glsl is vec4-only: every member must be a vec4, a fixed-size '
        f'array of vec4, or a struct declared earlier in the file.\n'
        f'  Scalars ride in vec4 lanes (add an accessor); ints ride in float '
        f'lanes via intBitsToFloat/floatBitsToInt.\n'
        f'  This rule exists so std430 and WGSL agree on the layout -- see the '
        f'header comment in common.glsl.'
    )


def _assert_vec4_aligned(name: str, dtype: np.dtype, origin: str, line: int):
    """Belt-and-braces: confirm the resulting dtype really is 16-byte regular.

    Given vec4-only members this cannot fail, which is exactly why it is worth
    asserting -- if it ever does fail, an assumption upstream has broken.
    """
    if dtype.itemsize % 16 != 0:
        raise LayoutError(
            f'{origin}: struct {name} (near line {line}) is {dtype.itemsize} '
            f'bytes, not a multiple of 16.'
        )
    for field_name in dtype.names:
        offset = dtype.fields[field_name][1]
        if offset % 16 != 0:
            raise LayoutError(
                f'{origin}: struct {name} (near line {line}): member '
                f'"{field_name}" is at offset {offset}, not 16-byte aligned.'
            )


def load_layouts(path: Path | None = None) -> dict[str, np.dtype]:
    """Parse the project's common.glsl. Raises LayoutError if it is malformed."""
    path = path or _COMMON_GLSL
    return parse_structs(path.read_text(), origin=str(path))


# Parsed once at import: a bad common.glsl should fail immediately and loudly
# at startup, not at the first buffer upload.
LAYOUTS = load_layouts()

ENTITY_DTYPE = LAYOUTS['Entity']
CONFIG_DATA_DTYPE = LAYOUTS['ConfigData']
WORLD_DATA_DTYPE = LAYOUTS['WorldData']

SIZE_OF_ENTITY_STRUCT = ENTITY_DTYPE.itemsize
SIZE_OF_CONFIG_DATA = CONFIG_DATA_DTYPE.itemsize
