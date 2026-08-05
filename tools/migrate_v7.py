#!/usr/bin/env python3
"""
Migrate v7 desktop-Fluoddity physics_configs to the web port's v8 save format.

Usage:
    python tools/migrate_v7.py <input_dir> [output_dir]

Defaults `output_dir` to a sibling of the input named `<input_dir>_v8`.

Every file is handled independently: a file that cannot be migrated is REPORTED
AND SKIPPED, never fatal. A v7 folder in the wild has v6 files, half-written
files, `_Study` subfolders and PNGs mixed in, and stopping on the first one
would mean babysitting the run.

WHAT THIS SCRIPT IS CAREFUL ABOUT
---------------------------------
Three things in the v7 -> v8 conversion fail SILENTLY -- the migrated file loads
fine and just behaves like a different config -- so each is handled explicitly
and each has its source cited:

1. BOUNDARY CONDITIONS SWAP. v7 is 0=Bounce, 1=Reset, 2=Wrap (the branches in
   `shaders/entity_update.glsl:626-653`, and the dropdown in
   `ui/physics_window.py:79`). v8 is BC_BOUNCE=0, BC_WRAP=1, BC_RESET=2
   (`src/shaders/common.wgsl:108-110`). 1 and 2 SWAP. Copying the integer across
   turns every Wrap config into a Reset config.

2. INITIAL CONDITIONS SHIFT. v7 is 0=Grid, 1=Random, 2=Ring
   (`ui/physics_window.py:106`). v8 inserted IC_CENTER at 2 and pushed Ring to 3
   (`src/shaders/common.wgsl:114-121`). So 0->0, 1->1, 2->3.

3. JITTER REPARAMETERIZATION. See `convert_jitter` below. This is the only part
   of the migration that is arithmetic rather than a lookup.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# --------------------------------------------------------------------------
# Constants carried from the two codebases
# --------------------------------------------------------------------------

# Mirrors SENSOR_DISTANCE_SPAN in src/shaders/common.wgsl:251, which is itself
# the upper bound of the Sensor Distance slider in src/ui/settingsSpec.ts:378.
# A Sensor Distance Jitter of 1.0 spans exactly this much in each direction.
SENSOR_DISTANCE_SPAN = 5.0

# v7 boundary code -> v8 BC_* code. See note 1 in the module docstring.
BOUNDARY_V7_TO_V8 = {0: 0, 1: 2, 2: 1}  # Bounce->BOUNCE, Reset->RESET, Wrap->WRAP

# v7 reset-mode code -> v8 IC_* code. See note 2. v7 had no CENTER mode.
INITIAL_V7_TO_V8 = {0: 0, 1: 1, 2: 3}  # Grid->GRID, Random->RANDOM, Ring->RING

# Settings that exist in v7 and have no v8 equivalent. Dropped silently in the
# output, but WARNED ABOUT when they are non-default, because each one changes
# behavior and a migrated file that used them will not look like the original.
# Maps json key -> (containing block, default value, human description).
DROPPED_IF_SET = [
    ('settings', 'disable_symmetry', False, 'symmetry disabled'),
    ('settings', 'absolute_orientation', 0, 'absolute orientation mode'),
    ('appearance', 'watercolor_mode', False, 'watercolor mode'),
]

# The physics parameters v7 could jitter. Only the two sensor ones survive into
# v8; the rest are dropped per the port's scope, and warned about when set.
JITTER_KEYS_KEPT = {'SENSOR_ANGLE', 'SENSOR_DISTANCE'}


class MigrationError(Exception):
    """A file this script will not migrate. Reported, never fatal."""


# --------------------------------------------------------------------------
# The interesting conversion
# --------------------------------------------------------------------------

def convert_jitter(old_jitter: float, base_value: float, span: float,
                   warn) -> float:
    """
    v7's PROPORTIONAL jitter -> v8's ABSOLUTE jitter.

    v7 (`shaders/entity_update.glsl:220-223`):

        random = hash(...) * 2 - 1          # -1..1
        result += setting.jitter * result * random

    so the value swings over `base +/- jitter*|base|`. The jitter is keyed to the
    MAGNITUDE OF THE VALUE IT PERTURBS -- doubling the slider doubles the wobble.

    v8 (`src/particleSystem/shaders/entityUpdate.wgsl:478-489`) instead defines a
    FIXED range, scaled so 1.0 spans the whole slider:

        angle    += angle_jitter * (2*hash(...) - 1)                # span 1.0
        distance += SENSOR_DISTANCE_SPAN * distance_jitter * (...)  # span 5.0

    giving `base +/- span*jitter`. Both formulations are SYMMETRIC ABOUT THE
    BASE, which is what makes this a pure rescale: the base slider value carries
    across untouched and only the jitter number changes.

    Matching the two half-widths:

        span * new_jitter = old_jitter * |base|
        new_jitter = old_jitter * |base| / span

    `span` is 1.0 for angle (a -1..1 half-turn control that needs no scaling) and
    SENSOR_DISTANCE_SPAN for distance.

    CLAMPED TO [0,1] because that is the v8 slider's range. A clamp NARROWS the
    resulting wobble relative to v7, so it is warned about rather than absorbed:
    it happens when |base| is large enough that v7's proportional swing exceeds
    what v8's fixed range can express.
    """
    if old_jitter == 0.0:
        return 0.0
    new_jitter = old_jitter * abs(base_value) / span
    if new_jitter > 1.0:
        warn(f'jitter {old_jitter:.4g} on base {base_value:.4g} needs '
             f'{new_jitter:.4g} in v8 terms; clamped to 1.0 (wobble narrowed '
             f'from +/-{old_jitter * abs(base_value):.4g} to +/-{span:.4g})')
        return 1.0
    return new_jitter


# --------------------------------------------------------------------------
# Reading v7
# --------------------------------------------------------------------------

def require_block(doc: dict, key: str) -> dict:
    value = doc.get(key)
    if not isinstance(value, dict):
        raise MigrationError(f'missing or malformed "{key}" block')
    return value


def require_num(block: dict, key: str, where: str) -> float:
    value = block.get(key)
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise MigrationError(f'{where}.{key} is not a number ({value!r})')
    return float(value)


def num_or(block: dict, key: str, fallback: float) -> float:
    value = block.get(key)
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return fallback
    return float(value)


def bool_or(block: dict, key: str, fallback: bool) -> bool:
    value = block.get(key)
    return value if isinstance(value, bool) else fallback


def migrate_document(doc: dict, warn) -> dict:
    """One parsed v7 document -> one v8 document. Raises MigrationError."""
    version = doc.get('version')
    if version != 7:
        raise MigrationError(f'version {version!r}, expected 7')

    physics = require_block(doc, 'physics')
    settings = doc.get('settings') if isinstance(doc.get('settings'), dict) else {}
    appearance = doc.get('appearance') if isinstance(doc.get('appearance'), dict) else {}
    jitters = doc.get('jitters') if isinstance(doc.get('jitters'), dict) else {}

    rule = doc.get('rule')
    if not isinstance(rule, list) or not rule:
        raise MigrationError('"rule" is missing or not a non-empty array')
    if any(not isinstance(n, (int, float)) or isinstance(n, bool) for n in rule):
        raise MigrationError('"rule" contains non-numeric entries')
    if len(rule) != 80:
        # 10 FourierCenters x (frequency vec4 + amplitude vec4). A different
        # length means a different Rule struct, which is a v6-or-earlier file
        # wearing a v7 version number.
        raise MigrationError(f'"rule" has {len(rule)} floats, expected 80')

    # --- mode enums: the two silent-failure lookups ------------------------
    bc_v7 = int(num_or(settings, 'boundary_conditions', 0))
    if bc_v7 not in BOUNDARY_V7_TO_V8:
        raise MigrationError(f'boundary_conditions {bc_v7} is not a v7 mode (0-2)')
    boundary = BOUNDARY_V7_TO_V8[bc_v7]

    ic_v7 = int(num_or(settings, 'initial_conditions', 0))
    if ic_v7 not in INITIAL_V7_TO_V8:
        raise MigrationError(f'initial_conditions {ic_v7} is not a v7 mode (0-2)')
    initial = INITIAL_V7_TO_V8[ic_v7]

    # --- jitter: kept for the two sensors, warned about elsewhere ----------
    for key, value in jitters.items():
        if key in JITTER_KEYS_KEPT:
            continue
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value != 0.0:
            warn(f'dropped {key} jitter ({value:.4g}) -- v8 only jitters the sensors')

    sensor_angle = require_num(physics, 'sensor_angle', 'physics')
    sensor_distance = require_num(physics, 'sensor_distance', 'physics')

    angle_jitter = convert_jitter(
        num_or(jitters, 'SENSOR_ANGLE', 0.0), sensor_angle, 1.0, warn)
    distance_jitter = convert_jitter(
        num_or(jitters, 'SENSOR_DISTANCE', 0.0), sensor_distance,
        SENSOR_DISTANCE_SPAN, warn)

    # --- settings with no v8 home -----------------------------------------
    blocks = {'settings': settings, 'appearance': appearance}
    for block_name, key, default, description in DROPPED_IF_SET:
        value = blocks[block_name].get(key, default)
        if value != default:
            warn(f'dropped {description} ({key}={value!r}) -- no v8 equivalent')
    # orientation_mix only matters when absolute_orientation is on, which the
    # line above already warned about, so it is not warned about separately.

    if doc.get('parameter_sweeps_enabled'):
        warn('dropped parameter sweeps (they were ENABLED) -- no v8 equivalent')

    # Passed through unconverted: v7's soft-push radius (entity_update.glsl
    # :605-623) and v8's cohortFences are the same field by lineage but not
    # verified to share a scale. Non-zero values are rare, so this is logged and
    # handled case by case rather than guessed at.
    fences = num_or(settings, 'limited_extents', 0.0)
    if fences != 0.0:
        warn(f'limited_extents={fences:.4g} passed through as cohort_fences '
             f'unconverted -- verify this one by eye')

    config = {
        'rule': [float(n) for n in rule],
        'sensor': {
            'gain': require_num(physics, 'sensor_gain', 'physics'),
            'angle': sensor_angle,
            'distance': sensor_distance,
            'mutation_scale': require_num(physics, 'mutation_scale', 'physics'),
        },
        'force': {
            'global_mult': require_num(physics, 'global_force_mult', 'physics'),
            'drag': require_num(physics, 'drag', 'physics'),
            'strafe': require_num(physics, 'strafe_power', 'physics'),
            'axial': require_num(physics, 'axial_force', 'physics'),
        },
        'misc': {
            'lateral': require_num(physics, 'lateral_force', 'physics'),
            'hazard_rate': num_or(physics, 'hazard_rate', 0.0),
            'cohorts': int(num_or(settings, 'num_cohorts', 1)),
            'mutation_seed': num_or(settings, 'rule_seed', 0.0),
        },
        'force2': {
            # New in v8. 0 means "no pull", which is what every v7 file meant.
            'gravity_force': 0.0,
            'gravity_strafe': 0.0,
            'initial_conditions': initial,
            'cohort_fences': fences,
        },
        'misc2': {
            'color_sensitivity': num_or(appearance, 'hue_sensitivity', 0.5),
            'color_by_cohort': bool_or(appearance, 'color_by_cohort', False),
            'sensor_angle_jitter': angle_jitter,
            'sensor_distance_jitter': distance_jitter,
        },
        'misc3': {
            # v7 gravity did not exist, so it certainly was not radial.
            'radial_gravity': False,
        },
    }

    out = {
        'version': 8,
        'world': {
            'trail_persistence': require_num(physics, 'trail_persistence', 'physics'),
            # Additive even within v7: the oldest files predate the setting and
            # simply lack the key. 1.0 is what they ran, and it matches
            # WORLD_SETTINGS_DEFAULTS in src/particleSystem/config.ts.
            'trail_diffusion': num_or(physics, 'trail_diffusion', 1.0),
            'boundary_conditions': boundary,
        },
        # v7 held exactly one config per file; v8's list is how it carries more.
        'configs': [config],
    }

    notes = doc.get('notes')
    if isinstance(notes, str) and notes:
        out['notes'] = notes
    return out


# --------------------------------------------------------------------------
# Driving the folder
# --------------------------------------------------------------------------

def migrate_file(src: Path, dst: Path) -> tuple[bool, list[str]]:
    """Migrate one file. Returns (succeeded, warnings)."""
    warnings: list[str] = []
    try:
        with src.open('r', encoding='utf-8') as f:
            doc = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        raise MigrationError(f'unreadable: {exc}') from exc
    if not isinstance(doc, dict):
        raise MigrationError('not a JSON object')

    out = migrate_document(doc, warnings.append)

    dst.parent.mkdir(parents=True, exist_ok=True)
    with dst.open('w', encoding='utf-8') as f:
        json.dump(out, f, indent=2)
        f.write('\n')
    return True, warnings


def main(argv: list[str]) -> int:
    if not 2 <= len(argv) <= 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    src_dir = Path(argv[1])
    if not src_dir.is_dir():
        print(f'error: {src_dir} is not a directory', file=sys.stderr)
        return 2
    dst_dir = Path(argv[2]) if len(argv) == 3 else src_dir.parent / f'{src_dir.name}_v8'

    # Top level only. The v7 folder has `_Study` subfolders holding sweep output
    # rather than presets, and pulling those in would flood the output.
    sources = sorted(p for p in src_dir.glob('*.json') if p.is_file())
    if not sources:
        print(f'error: no .json files directly in {src_dir}', file=sys.stderr)
        return 2

    migrated = 0
    skipped: list[tuple[str, str]] = []
    flagged: list[tuple[str, list[str]]] = []

    for src in sources:
        try:
            _, warnings = migrate_file(src, dst_dir / src.name)
        except MigrationError as exc:
            skipped.append((src.name, str(exc)))
            print(f'SKIP  {src.name}: {exc}')
            continue
        migrated += 1
        if warnings:
            flagged.append((src.name, warnings))
            print(f'WARN  {src.name}')
            for w in warnings:
                print(f'        {w}')
        else:
            print(f'ok    {src.name}')

    print()
    print(f'{migrated} migrated, {len(skipped)} skipped -> {dst_dir}')
    if flagged:
        print(f'{len(flagged)} migrated with warnings -- these may not look like '
              f'the originals:')
        for name, warnings in flagged:
            print(f'  {name} ({len(warnings)})')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
