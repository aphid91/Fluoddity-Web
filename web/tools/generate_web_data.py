"""Emit the build-time data files the TypeScript port needs.

Run this after editing `shared/shaders/common.glsl`:

    ..\\Scratch.venv\\Scripts\\python.exe web/tools/generate_web_data.py

or, from `web/`, `npm run gen:web-data`. `--check` regenerates in memory and
exits non-zero if the committed files are stale, without writing anything.

WHY THIS IS A PYTHON SCRIPT IN A TYPESCRIPT PROJECT
`particle_system/layout.py` parses `common.glsl` at import to build numpy dtypes,
so the host packing code can never drift from the shader's view of the layout.
The port does NOT reimplement that parser (see docs/WEB_PORT_PLAN.md step 2):
shader hot-reload is gone, so a *runtime* parser has no job, and a second
implementation of a strict parser is a second thing that can be subtly wrong.

Instead the existing parser runs at build time and ships its answer as JSON.
That keeps `common.glsl` the single authority while letting the browser -- which
cannot run Python and cannot read the repo -- see the same layout.

The outputs are COMMITTED to git. A browser build cannot shell out to Python,
`npm run build` must work from a clean checkout with no venv, and a committed
artifact makes a struct change visible in the diff beside the .glsl edit that
caused it.

THREE OUTPUTS
  layout.generated.json   struct sizes, member offsets, float-lane indices
  parity.generated.json   golden values from running the real Python functions
  presets.generated.json  the shipped configs, as the desktop's reader returns
                          them. TEMPORARY -- Step 9 replaces it with a manifest
                          plus IndexedDB and deletes it.

ON THE PARITY FILE AND THE PROJECT'S "NO GOLDEN VECTORS" DECISION
docs/WEB_PORT_PLAN.md decides that port fidelity is verified by visual A/B, not
numeric golden vectors. That decision is about THE DYNAMICS -- chaotic emergent
behaviour that cannot be compared frame to frame. Step 2 is deterministic
arithmetic with no chaos in it, and the same plan explicitly asks to "check
sizing.ts against the Python values". This file is that instruction, not a
contradiction of it.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

# web/tools -> web -> repo root. Computed from __file__ so the script runs from
# any working directory.
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))

import numpy as np  # noqa: E402  (must follow the sys.path insert)

from particle_system import coords  # noqa: E402
from particle_system.config import (  # noqa: E402
    BC_BOUNCE,
    BC_RESET,
    BC_WRAP,
    IC_CENTER,
    IC_GRID,
    IC_RANDOM,
    IC_RING,
    SimulationConfig,
    WorldConfig,
    pack_configs,
)
from particle_system.layout import LayoutError, load_layouts, parse_structs  # noqa: E402
from particle_system import sizing  # noqa: E402
from camera import camera_state  # noqa: E402
from orchestrator.orchestrator import blur_schedule  # noqa: E402
from preferences import Preferences  # noqa: E402

COMMON_GLSL = REPO_ROOT / 'shared' / 'shaders' / 'common.glsl'
LAYOUT_OUT = REPO_ROOT / 'web' / 'src' / 'particleSystem' / 'layout.generated.json'
PARITY_OUT = REPO_ROOT / 'web' / 'tools' / 'parity.generated.json'
PRESETS_OUT = REPO_ROOT / 'web' / 'src' / 'particleSystem' / 'presets.generated.json'

#: The shipped presets, exported for Step 4's A/B.
#:
#: TODO(Step 9): DELETE THIS AND ITS OUTPUT FILE. Step 9 builds the real
#: storage path -- a build-time manifest.json plus IndexedDB, with a v8 reader
#: in TypeScript. This exists only because Step 4 needs real config values to
#: compare against the desktop, and writing a reader in Step 4 would mean Step 9
#: inherits whatever shape that reader happened to take. Deleting this is a
#: clean subtraction: drop the constant, drop _build_presets, drop the entry in
#: main()'s `outputs`, and delete presets.generated.json and defaultConfig.ts.
_PRESET_FILES = ['Starcrossedv8.json', '9leafv8.json', 'hatmanv8.json','AALattice.json','AATopMembrane4.json','AATangle.json','AASegments.json']

#: Sizes the port hardcodes as strides. The vec4-only rule already guarantees
#: 16-byte alignment, so a struct can grow LEGALLY and still break every
#: hardcoded stride in the TypeScript. This is the executable form of the struct
#: table in docs/WEB_PORT_PLAN.md step 3.
EXPECTED_SIZES = {
    'FourierCenter': 32,
    'Rule': 320,
    'ConfigData': 416,
    'WorldData': 32,
    'Entity': 32,
}


# ---------------------------------------------------------------------------
# layout.generated.json
# ---------------------------------------------------------------------------

def _describe_struct(name: str, dtype: np.dtype) -> dict:
    """One struct as {size, float32Count, members[]}.

    Emits BOTH the nested type information and the flat float32 lane index.
    The nested form is what a human checks the port against; `floatIndex` is
    what the packing code actually uses. Emitting only the flat view would lose
    the ability to verify the flattening; emitting only the nested form would
    make TypeScript re-derive it, which is the drift this file exists to remove.
    """
    members = []
    for field_name in dtype.names:
        sub_dtype, offset = dtype.fields[field_name][:2]

        array_len = None
        stride = None

        if _is_vec4(sub_dtype):
            # A vec4 is ONE member, even though numpy models it as a 4-element
            # subarray of float32. Reporting it as an array of 4 floats would be
            # true of the bytes and false of the meaning -- `sensor` is a lane
            # quartet, not four independent members.
            type_name = 'vec4'
        elif sub_dtype.subdtype is not None:
            # A real array member: Rule.centers[10]. `.subdtype` is
            # (element_dtype, shape).
            element, shape = sub_dtype.subdtype
            if len(shape) != 1:
                raise SystemExit(
                    f'{name}.{field_name}: multi-dimensional members are not '
                    f'supported by this generator (shape {shape}).'
                )
            array_len = int(shape[0])
            stride = element.itemsize
            type_name = _type_name_for(element)
        else:
            type_name = _type_name_for(sub_dtype)

        if offset % 4 != 0:
            raise SystemExit(
                f'{name}.{field_name} is at byte offset {offset}, not a '
                f'multiple of 4 -- it has no float32 lane index.'
            )

        member = {
            'name': field_name,
            'offset': int(offset),
            'size': int(sub_dtype.itemsize),
            'type': type_name,
            'floatIndex': int(offset) // 4,
            'floatCount': int(sub_dtype.itemsize) // 4,
        }
        if array_len is not None:
            member['arrayLength'] = array_len
            member['stride'] = int(stride)
        members.append(member)

    return {
        'size': int(dtype.itemsize),
        'float32Count': int(dtype.itemsize) // 4,
        'members': members,
    }


def _is_vec4(dtype: np.dtype) -> bool:
    """True for layout.py's _VEC4_DTYPE: a 4-element float32 subarray."""
    return dtype.subdtype is not None and dtype.subdtype == (np.dtype('<f4'), (4,))


def _type_name_for(dtype: np.dtype) -> str:
    """The GLSL type name for a dtype: 'vec4', or the struct it matches."""
    if _is_vec4(dtype):
        return 'vec4'
    for struct_name, struct_dtype in LAYOUTS.items():
        if dtype == struct_dtype:
            return struct_name
    raise SystemExit(
        f'generator: dtype {dtype!r} matches no struct in common.glsl and is '
        f'not a vec4. The vec4-only rule should have made this unreachable.'
    )


def build_layout() -> dict:
    descriptor = {
        '_comment': (
            'GENERATED by web/tools/generate_web_data.py from '
            'shared/shaders/common.glsl. Do not edit by hand. '
            'Regenerate with: npm run gen:web-data'
        ),
        'source': 'shared/shaders/common.glsl',
        'sourceSha256': hashlib.sha256(COMMON_GLSL.read_bytes()).hexdigest(),
        'structs': {
            name: _describe_struct(name, dtype)
            for name, dtype in LAYOUTS.items()
        },
    }

    for name, expected in EXPECTED_SIZES.items():
        if name not in descriptor['structs']:
            raise SystemExit(
                f'common.glsl no longer declares struct {name}, which the port '
                f'depends on.'
            )
        actual = descriptor['structs'][name]['size']
        if actual != expected:
            raise SystemExit(
                f'struct {name} is {actual} bytes, expected {expected}.\n'
                f'  This is a LEGAL change (the vec4-only rule still holds), but '
                f'every hardcoded stride in web/src/particleSystem is now wrong.\n'
                f'  If the change is intended, update EXPECTED_SIZES here and the '
                f'struct table in docs/WEB_PORT_PLAN.md, then fix the LANE '
                f'constants in web/src/particleSystem/config.ts.'
            )

    return descriptor


# ---------------------------------------------------------------------------
# parity.generated.json
# ---------------------------------------------------------------------------

#: Canvas/window shapes used across the coords goldens. Square, wide and tall,
#: so the letterbox picks a different branch in each.
_CANVAS_SIZES = [(1024, 1024), (1448, 724), (724, 1448)]
_WINDOW_SIZES = [(1920, 1080), (800, 800), (600, 900)]
_CAMERAS = [((0.0, 0.0), 1.0), ((0.5, -0.3), 1.0), ((0.5, -0.3), 3.7), ((-1.25, 0.75), 0.5)]
_WORLD_POINTS = [(0.0, 0.0), (0.37, -0.62), (-0.9, 0.15), (1.4, -1.4)]


def build_parity() -> dict:
    return {
        '_comment': (
            'GENERATED by web/tools/generate_web_data.py by CALLING the desktop '
            "Python functions. These are the port's parity goldens. Do not edit "
            'by hand. Regenerate with: npm run gen:web-data'
        ),
        'sizing': _parity_sizing(),
        'coords': _parity_coords(),
        'camera': _parity_camera(),
        'blur': _parity_blur(),
        'packing': _parity_packing(),
    }


def _parity_sizing() -> dict:
    return {
        '_roundingNote': (
            "Python's round() is half-to-EVEN; JavaScript's Math.round is "
            'half-up. They differ only when dim*sqrt(aspect) lands exactly on '
            '.5, which aspect=(1024.5/1024)**2 does: Python returns 1024 where '
            'Math.round returns 1025. The port deliberately uses Math.round and '
            'accepts that divergence (see sizing.ts), so NO GOLDEN CASE AT A TIE '
            'IS EMITTED HERE -- such a case would fail by design. CANVAS_ASPECT '
            'is 1.0 and has no runtime UI, so no tie is currently reachable.'
        ),
        'constants': {
            'ENTITIES_PER_WORLD_UNIT': sizing.ENTITIES_PER_WORLD_UNIT,
            'BASE_CANVAS_DIM': sizing.BASE_CANVAS_DIM,
            'CANVAS_ASPECT': sizing.CANVAS_ASPECT,
            'ENTITY_COUNT': sizing.ENTITY_COUNT,
            'CANVAS_DIM': sizing.CANVAS_DIM,
        },
        'sizingFor': [
            # 1.0000015 is deliberate: 600000 * it is 600000.9, so int()'s
            # truncation and a round() would disagree. It pins Math.trunc.
            {'worldSize': ws, 'out': list(sizing.sizing_for(ws))}
            for ws in (0.0, 0.25, 0.5, 0.7, 1.0, 1.0000015, 1.5, 2.0, 4.0, 1e-6)
        ],
        'canvasDimensions': [
            {'aspect': a, 'dim': d, 'out': list(sizing.canvas_dimensions(a, d))}
            for a, d in [
                (1.0, None), (2.0, None), (0.5, None), (1.0, 512),
                (16 / 9, None), (9 / 16, None), (2.0, 2048), (1.0, 1),
            ]
        ],
    }


def _parity_coords() -> dict:
    return {
        'worldHalfExtent': [
            {'canvasSize': list(cs), 'out': list(coords.world_half_extent(cs))}
            for cs in _CANVAS_SIZES
        ],
        'letterboxScale': [
            {'canvasSize': list(cs), 'windowSize': list(ws),
             'out': list(coords.letterbox_scale(cs, ws))}
            for cs in _CANVAS_SIZES for ws in _WINDOW_SIZES
        ],
        'worldToUv': [
            {'p': list(p), 'canvasSize': list(cs),
             'out': list(coords.world_to_uv(p, cs))}
            for p in _WORLD_POINTS for cs in _CANVAS_SIZES
        ],
        'worldToNdc': [
            {'p': list(p), 'canvasSize': list(cs),
             'out': list(coords.world_to_ndc(p, cs))}
            for p in _WORLD_POINTS for cs in _CANVAS_SIZES
        ],
        'worldToScreenNdc': [
            {'p': list(p), 'canvasSize': list(cs), 'windowSize': list(ws),
             'pan': list(pan), 'zoom': zoom,
             'out': list(coords.world_to_screen_ndc(p, cs, ws, pan, zoom))}
            for p in _WORLD_POINTS
            for cs in _CANVAS_SIZES
            for ws in _WINDOW_SIZES
            for pan, zoom in _CAMERAS
        ],
        'screenToWorld': [
            # NOTE the argument order: pixel, WINDOW, CANVAS -- window before
            # canvas, the opposite of every other function here. Preserved in
            # the port; see the comment on screenToWorld in coords.ts.
            {'pixel': list(px), 'windowSize': list(ws), 'canvasSize': list(cs),
             'pan': list(pan), 'zoom': zoom,
             'out': list(coords.screen_to_world(px, ws, cs, pan, zoom))}
            for px in [(0.0, 0.0), (960.0, 540.0), (1919.0, 1079.0), (123.0, 456.0)]
            for ws in _WINDOW_SIZES
            for cs in _CANVAS_SIZES
            for pan, zoom in _CAMERAS
        ],
        'screenToNdc': [
            {'pixel': list(px), 'windowSize': list(ws),
             'out': list(coords.screen_to_ndc(px, ws))}
            for px in [(0.0, 0.0), (400.0, 400.0), (799.0, 799.0)]
            for ws in _WINDOW_SIZES
        ],
        'uvRadiusToWorld': [
            {'radius': r, 'out': coords.uv_radius_to_world(r)}
            for r in (0.0, 0.05, 0.25, 1.0)
        ],
    }


def _parity_camera() -> dict:
    """Golden zoom_at_pixel and pan_by_fraction transitions.

    zoom_at_pixel is the behavioural heart of camera_state.py -- it reads pan
    and zoom twice around a mutation, so a transcription error shows up as a
    drifting anchor rather than an obvious wrong number.
    """
    zoom_cases = []
    for pan, zoom in _CAMERAS:
        for notches in (1, -1, 3, -3, 0.5, 60):
            for pixel in [(960.0, 540.0), (100.0, 900.0), (0.0, 0.0)]:
                state = camera_state.CameraState(pan=pan, zoom=zoom)
                state.zoom_at_pixel(notches, pixel, (1920, 1080), (1448, 724))
                zoom_cases.append({
                    'start': {'pan': list(pan), 'zoom': zoom},
                    'notches': notches,
                    'pixel': list(pixel),
                    'windowSize': [1920, 1080],
                    'canvasSize': [1448, 724],
                    'end': {'pan': list(state.pan), 'zoom': state.zoom},
                })

    pan_cases = []
    for pan, zoom in _CAMERAS:
        for fraction in [(1.0, 0.0), (0.0, 1.0), (1.0, 1.0), (-0.5, 0.25)]:
            for cs in _CANVAS_SIZES:
                state = camera_state.CameraState(pan=pan, zoom=zoom)
                state.pan_by_fraction(fraction, cs)
                pan_cases.append({
                    'start': {'pan': list(pan), 'zoom': zoom},
                    'fraction': list(fraction),
                    'canvasSize': list(cs),
                    'end': {'pan': list(state.pan), 'zoom': state.zoom},
                })

    return {
        'constants': {
            'MIN_ZOOM': camera_state.MIN_ZOOM,
            'MAX_ZOOM': camera_state.MAX_ZOOM,
            'ZOOM_PER_NOTCH': camera_state.ZOOM_PER_NOTCH,
            'PAN_PER_SECOND': camera_state.PAN_PER_SECOND,
            'ZOOM_PER_SECOND': camera_state.ZOOM_PER_SECOND,
        },
        'zoomAtPixel': zoom_cases,
        'panByFraction': pan_cases,
    }


def _parity_blur() -> dict:
    """Golden blur_schedule() results.

    blur_schedule returns the ACHIEVED sample count, not the requested one --
    the two disagree whenever the request does not divide the physics rate, and
    weighting the accumulator by the request darkens the frame by the ratio
    between them at exactly those slider positions. That is the class of bug the
    visual A/B cannot catch (a few percent, and only sometimes), so it gets
    goldens even though the rest of the render pipeline deliberately does not.

    See orchestrator.py:71-103 and web/src/camera/blurSchedule.ts.
    """
    return {
        '_note': (
            'blur_schedule(prefs) -> (samples, stride). `samples` is the count '
            'that will ACTUALLY occur, which is what 1/N must be computed from.'
        ),
        'cases': [
            {
                'physicsSteps': steps,
                'motionBlurSamples': requested,
                'out': list(blur_schedule(Preferences(
                    physics_steps=steps, motion_blur_samples=requested))),
            }
            for steps in (1, 2, 7, 30, 60, 100, 120, 121)
            for requested in (1, 2, 3, 8, 10, 30, 31, 1000)
        ],
    }


#: A config whose every field is a DISTINCT, non-round value, so a lane swap
#: cannot accidentally produce a matching record. The rule is 80 distinct
#: values for the same reason.
_REFERENCE_CONFIG = SimulationConfig(
    cohorts=7,
    mutation_seed=0.3088,
    sensor_gain=1.37,
    sensor_angle=0.618,
    sensor_distance=0.0271,
    mutation_scale=0.1414,
    global_force_mult=2.718,
    drag=0.9315,
    strafe_power=-0.577,
    axial_force=1.202,
    lateral_force=-0.866,
    hazard_rate=0.0483,
    gravity_force=-0.321,
    gravity_strafe=0.159,
    initial_conditions=IC_RING,
    cohort_fences=0.7071,
    color_sensitivity=-0.4142,
    color_by_cohort=True,
    sensor_angle_jitter=0.2357,
    sensor_distance_jitter=0.8090,
    radial_gravity=True,
    rule=tuple(round(-1.0 + i * 0.0253, 6) for i in range(80)),
)

_REFERENCE_WORLD = WorldConfig(
    trail_persistence=0.9371,
    trail_diffusion=0.6180,
    sqrt_world_size=1.2599,
    config_count=5,
    boundary_conditions=BC_RESET,
)


def _config_as_camel(config: SimulationConfig) -> dict:
    """The reference config keyed the way config.ts names its fields.

    snake_case -> camelCase is the one place the port deliberately breaks 1:1
    correspondence with the Python. Emitting the camelCase form means the test
    can construct the config directly from this file rather than transcribing
    22 values by hand -- transcription being exactly what these goldens exist
    to eliminate.
    """
    def camel(s: str) -> str:
        head, *rest = s.split('_')
        return head + ''.join(word.title() for word in rest)

    out = {}
    for field_name in config.__dataclass_fields__:
        value = getattr(config, field_name)
        out[camel(field_name)] = list(value) if isinstance(value, tuple) else value
    return out


def _parity_packing() -> dict:
    """Byte-exact reference records.

    configRecordHex is the strongest single assertion in step 2: one comparison
    covers all 104 float lanes, the 80-float rule memcpy, the four int-bit lanes
    and the zero-fill of misc3.yzw simultaneously. Compare it EXACTLY -- both
    np.float32 assignment and JavaScript's Float32Array assignment round to
    nearest-even, so they agree bit for bit.
    """
    return {
        # What _int_lane() produces, as raw bytes plus -- where it is a real
        # number -- the float a naive port would store.
        #
        # Emitted as HEX, not as a float, because the bit patterns are not all
        # finite: _int_lane(-1) is 0xFFFFFFFF, which is a NaN. Python's
        # json.dumps writes bare `NaN`, which is not valid JSON and which no
        # JSON.parse accepts. Hex sidesteps that and is the more honest
        # representation anyway -- these lanes are bit patterns, not quantities.
        'intLaneBitPatterns': [
            {
                'int': v,
                'hex': np.int32(v).tobytes().hex(),
                'float': (
                    float(f) if math.isfinite(f := np.frombuffer(
                        np.int32(v).tobytes(), dtype=np.float32)[0]) else None
                ),
            }
            for v in (0, 1, 2, 3, 7, 255, -1)
        ],
        'referenceConfig': _config_as_camel(_REFERENCE_CONFIG),
        'configRecordHex': pack_configs([_REFERENCE_CONFIG]).hex(),
        'referenceWorld': {
            'trailPersistence': _REFERENCE_WORLD.trail_persistence,
            'trailDiffusion': _REFERENCE_WORLD.trail_diffusion,
            'sqrtWorldSize': _REFERENCE_WORLD.sqrt_world_size,
            'configCount': _REFERENCE_WORLD.config_count,
            'boundaryConditions': _REFERENCE_WORLD.boundary_conditions,
        },
        'worldRecordHex': _REFERENCE_WORLD.to_record().tobytes().hex(),
        'twoConfigHex': pack_configs(
            [_REFERENCE_CONFIG, _REFERENCE_CONFIG]).hex(),
        'enums': {
            'BC_BOUNCE': BC_BOUNCE, 'BC_WRAP': BC_WRAP, 'BC_RESET': BC_RESET,
            'IC_GRID': IC_GRID, 'IC_RANDOM': IC_RANDOM,
            'IC_CENTER': IC_CENTER, 'IC_RING': IC_RING,
        },
    }


# ---------------------------------------------------------------------------
# presets.generated.json -- TODO(Step 9): delete this whole section
# ---------------------------------------------------------------------------

def build_presets() -> dict:
    """The shipped presets, as the desktop's own reader returns them.

    WHY THE READER AND NOT THE FILE. The saved format uses a THIRD set of names
    again (`sensor.gain`, `force.global_mult`), and persistence.load() is what
    maps them onto SimulationConfig's fields and fills in the defaults for
    fields a given file predates. Emitting `_config_as_camel(saved.configs[0])`
    therefore ships what the desktop actually RUNS -- which is the other half of
    the A/B -- rather than a hand transcription of what the file says. That
    transcription is exactly the error class the parity goldens exist to delete.

    TODO(Step 9): delete. See the note on _PRESET_FILES.
    """
    from particle_system import persistence  # local: Step 9 deletes this whole section

    presets = {}
    for filename in _PRESET_FILES:
        path = REPO_ROOT / 'configs' / filename
        if not path.exists():
            raise SystemExit(
                f'generator: preset {filename} is missing from configs/.\n'
                f'  web/src/particleSystem/defaultConfig.ts reads these by name. '
                f'If a preset was renamed, update _PRESET_FILES.'
            )
        saved = persistence.load(str(path))
        presets[path.stem] = {
            # Only config 0. Every shipped preset has exactly one, and Step 4
            # runs a single population (assign_config_index returns 0).
            'config': _config_as_camel(saved.configs[0]),
            'world': {
                'trailPersistence': saved.world.trail_persistence,
                'trailDiffusion': saved.world.trail_diffusion,
                'boundaryConditions': saved.world.boundary_conditions,
            },
            'configCount': len(saved.configs),
        }

    return {
        '_comment': (
            'GENERATED by web/tools/generate_web_data.py by loading configs/*.json '
            'through the desktop reader. TEMPORARY: Step 9 replaces this with a '
            'build-time manifest plus IndexedDB and deletes this file. Do not edit '
            'by hand. Regenerate with: npm run gen:web-data'
        ),
        'presets': presets,
    }


# ---------------------------------------------------------------------------
# Self-test: prove the strictness checks actually fire
# ---------------------------------------------------------------------------

def self_test() -> None:
    """Confirm layout.py's strictness checks reject what they claim to.

    `particle_system/layout.py` has no test file of its own and its LayoutError
    is never caught anywhere -- it is purely a startup crash. Moving the parse
    to build time would leave those checks entirely unexercised, so this
    exercises them here, against synthetic sources rather than by editing
    common.glsl.
    """
    cases = [
        ('non-vec4 member', 'struct Bad { float x; };', 'not allowed'),
        ('unknown struct member', 'struct Bad { Nope x; };', 'not allowed'),
        ('unparseable declaration', 'struct Bad { vec4 a, b; };', 'cannot parse'),
        ('empty struct', 'struct Bad { };', 'no members'),
    ]
    for label, source, expected_fragment in cases:
        try:
            parse_structs(source, origin='<self-test>')
        except LayoutError as exc:
            if expected_fragment not in str(exc):
                raise SystemExit(
                    f'self-test: {label} raised LayoutError but the message did '
                    f'not mention "{expected_fragment}": {exc}'
                )
        else:
            raise SystemExit(
                f'self-test: {label} did NOT raise LayoutError. The vec4-only '
                f'rule is no longer being enforced, which means a bad layout '
                f'would silently reinterpret GPU memory.'
            )

    # A well-formed source must still parse, or the checks above prove nothing.
    ok = parse_structs('struct Good { vec4 a; vec4 b; };', origin='<self-test>')
    if ok['Good'].itemsize != 32:
        raise SystemExit('self-test: a valid vec4-only struct failed to parse.')


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _serialize(data: dict) -> str:
    """Stable JSON: sorted nowhere, indented, trailing newline.

    Key order follows insertion order deliberately -- it mirrors declaration
    order in common.glsl, which is the order a reader checks the port against.

    `allow_nan=False` matters more than it looks. Python's json.dumps happily
    writes bare `NaN` and `Infinity`, which are NOT valid JSON and which
    JSON.parse rejects outright -- so a non-finite golden would produce a file
    that every TypeScript test fails to even load, with a syntax error rather
    than a useful message. Float lanes holding bit-punned ints reach NaN
    patterns easily (_int_lane(-1) is 0xFFFFFFFF), so this is a live hazard.
    Fail here, at generation, where the message can say which value it was.
    """
    try:
        return json.dumps(data, indent=2, allow_nan=False) + '\n'
    except ValueError as exc:
        raise SystemExit(
            f'generator: refusing to emit non-finite JSON ({exc}).\n'
            f'  A golden value is NaN or Infinity. JSON has no literal for '
            f'either, so the file would not parse in the browser or in tests.\n'
            f'  Emit the value as a hex bit pattern instead -- see '
            f'intLaneBitPatterns for the pattern to follow.'
        ) from exc


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument(
        '--check', action='store_true',
        help='verify the committed files are current; write nothing',
    )
    args = parser.parse_args()

    self_test()

    outputs = [
        (LAYOUT_OUT, build_layout()),
        (PARITY_OUT, build_parity()),
        # TODO(Step 9): drop this entry with the rest of the preset export.
        (PRESETS_OUT, build_presets()),
    ]

    if args.check:
        stale = []
        for path, data in outputs:
            expected = _serialize(data)
            if not path.exists():
                stale.append(f'{path.relative_to(REPO_ROOT)} does not exist')
            elif path.read_text(encoding='utf-8') != expected:
                stale.append(f'{path.relative_to(REPO_ROOT)} is out of date')
        if stale:
            for message in stale:
                print(f'STALE: {message}', file=sys.stderr)
            print(
                '\nRegenerate with: npm run gen:web-data '
                '(from web/, with the venv python on PATH)',
                file=sys.stderr,
            )
            return 1
        print('Generated web data is current.')
        return 0

    for path, data in outputs:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(_serialize(data), encoding='utf-8')
        print(f'wrote {path.relative_to(REPO_ROOT)}')
    return 0


# Parsed once, after the self-test has had a chance to run against synthetic
# sources. A malformed common.glsl raises LayoutError here with layout.py's own
# message, which already explains the vec4 rule -- deliberately not caught and
# reformatted.
LAYOUTS = load_layouts()


if __name__ == '__main__':
    raise SystemExit(main())
