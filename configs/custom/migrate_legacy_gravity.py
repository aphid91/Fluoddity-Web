"""Migrate legacy texture-based gravity fields into GRAVITY_FORCE / GRAVITY_STRAFE.

Run this from a directory containing your legacy save files (cd there first).

Background
----------
Old configs stored an up/down "gravity" as a uniform force/strafe *field*: a
``<config>_fields.png`` texture plus per-config ``field_strengths`` in the JSON.
At runtime entity_update.glsl applied (see the retained comments there):

    e.vy += .01/CANVAS_SCALE * force_field_strength  * draw_sample.y
    e.py += .01/CANVAS_SCALE * strafe_field_strength * draw_sample.w

The new scalar path applies a *logarithmic* expansion of the -1..1 slider value
(see gravity_expand() in entity_update.glsl):

    e.vy += .01/CANVAS_SCALE * (-gravity_expand(GRAVITY_FORCE))
    e.py += .01/CANVAS_SCALE * (-gravity_expand(GRAVITY_STRAFE))

The fields were uniform in practice (fill-bucket only), so any texel equals the
whole field. Equating old and new (the .01/CANVAS_SCALE factor cancels), the
*physical* force we must reproduce is:

    force_phys  = force_field_strength  * sample.y   (channel index 1)
    strafe_phys = strafe_field_strength * sample.w   (channel index 3)

The new code applies -gravity_expand(control), so to reproduce force_phys we
store the control value that expands to -force_phys:

    GRAVITY_FORCE  = gravity_control(-force_phys)
    GRAVITY_STRAFE = gravity_control(-strafe_phys)

where gravity_control() is the exact inverse of the shader's gravity_expand().

Behavior
--------
- Scans the current directory for ``00*_fields.png`` files.
- For each, derives the config JSON by stripping ``_fields.png``.
- Reads the center texel of the decoded field and the JSON ``field_strengths``.
- Computes the -1..1 slider values GRAVITY_FORCE / GRAVITY_STRAFE and writes
  them into the JSON's ``settings`` block, overwriting the file IN PLACE.
- Skips (leaves untouched) any config with no paired JSON or no
  ``field_strengths`` block.
"""
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image


def load_field_png(filepath: Path) -> np.ndarray | None:
    """Decode a 16-bit field PNG to float32 RGBA.

    Standalone copy of advanced_drawing.field_texture_io.load_field_png so this
    script can run from any directory (e.g. your configs folder) without the
    project package on sys.path. The 4 RGBA channels are stored as a single
    I;16 image at 4x width, with per-channel max-abs range in tEXt metadata.

    Returns (height, width, 4) float32 array, or None if it can't be decoded.
    """
    if not filepath.exists():
        return None
    try:
        img = Image.open(str(filepath))
    except Exception as e:
        print(f"Warning: failed to open field PNG {filepath}: {e}")
        return None

    range_str = img.info.get("field_range")
    if range_str is None:
        print(f"Warning: field PNG {filepath} missing range metadata, skipping")
        return None
    try:
        max_abs = np.array([float(x) for x in range_str.split(",")], dtype=np.float64)
    except ValueError:
        print(f"Warning: field PNG {filepath} has unparseable range metadata, skipping")
        return None
    if len(max_abs) != 4:
        print(f"Warning: field PNG {filepath} has invalid range metadata, skipping")
        return None

    raw = np.array(img, dtype=np.uint16)
    h = raw.shape[0]
    w = raw.shape[1] // 4  # 4 channels stored at 4x width
    uint16_data = raw.reshape(h, w, 4)

    # Reverse normalization: [0, 65535] -> [0, 1] -> [-1, 1] -> [-max_abs, max_abs]
    result = np.empty((h, w, 4), dtype=np.float32)
    for ch in range(4):
        normalized = uint16_data[:, :, ch].astype(np.float64) / 65535.0
        result[:, :, ch] = ((normalized * 2.0 - 1.0) * max_abs[ch]).astype(np.float32)
    return result

# Channel indices in the decoded RGBA field (.xy = force, .zw = strafe).
# The gravity lines use draw_sample.y (force, index 1) and draw_sample.w
# (strafe, index 3).
FORCE_CHANNEL = 1
STRAFE_CHANNEL = 3

FIELDS_SUFFIX = "_fields.png"

# --- Gravity slider curve (MUST match gravity_expand() in entity_update.glsl) ---
# The shader expands a linear -1..1 control value to a logarithmic physical force.
# This is the inverse: physical force -> control value to store in the JSON.
GRAVITY_MAXV = 0.5       # physical value at |control| = 1
GRAVITY_DECADES = 4.0    # log span: MAXV .. MAXV/10^DECADES
GRAVITY_KNEE = 0.05      # |control| below this ramps linearly to 0
_V_KNEE = GRAVITY_MAXV * 10.0 ** (GRAVITY_DECADES * (GRAVITY_KNEE - 1.0))


def gravity_control(physical: float) -> float:
    """Inverse of the shader's gravity_expand(): physical force -> -1..1 control.

    Values at/below the knee magnitude map into the linear dead-zone (so field
    float-noise ~1e-15 collapses to ~0). Larger values invert the log branch.
    Result is clamped to [-1, 1].
    """
    a = abs(physical)
    s = 1.0 if physical >= 0 else -1.0
    if a <= _V_KNEE:
        return s * GRAVITY_KNEE * (a / _V_KNEE) if _V_KNEE > 0 else 0.0
    c = 1.0 + math.log10(a / GRAVITY_MAXV) / GRAVITY_DECADES
    return s * min(1.0, c)


def migrate_one(fields_png: Path) -> str:
    """Migrate a single <config>_fields.png. Returns a one-line status string."""
    json_path = fields_png.with_name(fields_png.name[: -len(FIELDS_SUFFIX)] + ".json")
    if not json_path.exists():
        return f"SKIP  {fields_png.name}: no paired {json_path.name}"

    try:
        config = json.loads(json_path.read_text())
    except Exception as e:
        return f"SKIP  {json_path.name}: unreadable JSON ({e})"

    field_strengths = config.get("field_strengths")
    if not field_strengths:
        return f"SKIP  {json_path.name}: no field_strengths block"

    force_strength = float(field_strengths.get("force", 0.0))
    strafe_strength = float(field_strengths.get("strafe", 0.0))

    data = load_field_png(fields_png)
    if data is None:
        return f"SKIP  {fields_png.name}: could not decode field PNG"

    # Any texel will do — the field is uniform. Use the center.
    h, w, _ = data.shape
    texel = data[h // 2, w // 2]
    sample_y = float(texel[FORCE_CHANNEL])
    sample_w = float(texel[STRAFE_CHANNEL])

    # Physical force the old field produced, then invert the log curve to get
    # the -1..1 slider value that reproduces it via gravity_expand() in-shader.
    force_phys = force_strength * sample_y
    strafe_phys = strafe_strength * sample_w
    gravity_force = gravity_control(-force_phys)
    gravity_strafe = gravity_control(-strafe_phys)

    # Write into the settings block (create it if somehow absent).
    settings = config.setdefault("settings", {})
    settings["gravity_force"] = gravity_force
    settings["gravity_strafe"] = gravity_strafe

    json_path.write_text(json.dumps(config, indent=2))
    return (f"OK    {json_path.name}: "
            f"GRAVITY_FORCE={gravity_force:+.6g}, GRAVITY_STRAFE={gravity_strafe:+.6g}")


def main() -> None:
    cwd = Path.cwd()
    fields_pngs = sorted(cwd.glob("00*" + FIELDS_SUFFIX))

    if not fields_pngs:
        print(f"No 00*{FIELDS_SUFFIX} files found in {cwd}")
        return

    print(f"Found {len(fields_pngs)} field file(s) in {cwd}\n")
    n_ok = 0
    for fields_png in fields_pngs:
        status = migrate_one(fields_png)
        print(status)
        if status.startswith("OK"):
            n_ok += 1

    print(f"\nDone. Updated {n_ok} of {len(fields_pngs)} config(s) in place.")


if __name__ == "__main__":
    main()
