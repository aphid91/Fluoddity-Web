"""Field texture I/O: save/load float32 RGBA field data as 16-bit PNG.

Uses per-channel range normalization stored in PNG tEXt metadata so that
the full dynamic range of the field is preserved to 16-bit precision.

Storage trick: since Pillow's native 16-bit RGBA support is limited, we
store 4 channels as a single-channel ``I;16`` image at 4x the width.
On load we reshape back to (h, w, 4).
"""
import numpy as np
from pathlib import Path
from PIL import Image
from PIL.PngImagePlugin import PngInfo


def readback_field_texture(field_tex) -> np.ndarray | None:
    """Read a ModernGL field texture from GPU to CPU.

    Returns:
        (height, width, 4) float32 numpy array, or None if texture is None.
    """
    if field_tex is None:
        return None
    data = np.frombuffer(field_tex.read(), dtype=np.float32)
    return data.reshape(field_tex.height, field_tex.width, 4).copy()


def is_field_nonzero(data: np.ndarray) -> bool:
    """Check if a field data array has any non-zero values."""
    return bool(np.any(data != 0))


def save_field_png(data: np.ndarray, filepath: Path) -> None:
    """Save float32 RGBA field data as a 16-bit PNG.

    Encoding: per-channel symmetric normalization.
    The max absolute value per channel is stored in PNG tEXt metadata
    so the mapping can be exactly reversed on load.
    """
    h, w, c = data.shape
    assert c == 4, f"Expected 4 channels, got {c}"

    # Compute per-channel max absolute value
    max_abs = np.empty(4, dtype=np.float64)
    for ch in range(4):
        max_abs[ch] = max(float(np.max(np.abs(data[:, :, ch]))), 1e-10)

    # Normalize: [-max_abs, +max_abs] -> [0, 1]
    normalized = np.empty((h, w, 4), dtype=np.float64)
    for ch in range(4):
        normalized[:, :, ch] = (data[:, :, ch].astype(np.float64) / max_abs[ch] + 1.0) / 2.0

    # Scale to uint16
    uint16_data = np.clip(normalized * 65535.0, 0, 65535).astype(np.uint16)

    # Store range metadata
    metadata = PngInfo()
    range_str = ",".join(f"{v:.15g}" for v in max_abs)
    metadata.add_text("field_range", range_str)

    # Save as single-channel 16-bit grayscale at 4x width (encodes all 4 RGBA channels)
    flat = uint16_data.reshape(h, w * 4)
    raw_bytes = flat.astype(np.uint16).tobytes()
    img = Image.frombytes("I;16", (w * 4, h), raw_bytes)
    img.save(str(filepath), pnginfo=metadata)


def load_field_png(filepath: Path) -> np.ndarray | None:
    """Load a 16-bit PNG field file and decode to float32 RGBA.

    Returns:
        (height, width, 4) float32 numpy array, or None if file doesn't exist.
    """
    if not filepath.exists():
        return None

    try:
        img = Image.open(str(filepath))
    except Exception as e:
        print(f"Warning: failed to open field PNG {filepath}: {e}")
        return None

    # Read range metadata
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

    # Read pixel data as uint16
    raw = np.array(img, dtype=np.uint16)
    h = raw.shape[0]
    w = raw.shape[1] // 4  # We stored 4 channels at 4x width
    uint16_data = raw.reshape(h, w, 4)

    # Reverse normalization: [0, 65535] -> [0, 1] -> [-1, 1] -> [-max_abs, max_abs]
    result = np.empty((h, w, 4), dtype=np.float32)
    for ch in range(4):
        normalized = uint16_data[:, :, ch].astype(np.float64) / 65535.0
        result[:, :, ch] = ((normalized * 2.0 - 1.0) * max_abs[ch]).astype(np.float32)

    return result


def write_field_to_gpu(field_tex, data: np.ndarray) -> None:
    """Write float32 RGBA data to a ModernGL field texture.

    If data dimensions don't match the texture, resizes via bilinear interpolation.
    """
    tex_h, tex_w = field_tex.height, field_tex.width
    data_h, data_w = data.shape[0], data.shape[1]

    if data_h != tex_h or data_w != tex_w:
        data = _bilinear_resize(data, tex_h, tex_w)

    field_tex.write(data.astype(np.float32).tobytes())


def load_image_as_polar_field(filepath: Path, target_h: int, target_w: int) -> np.ndarray | None:
    """Load a PNG/JPEG image and convert R/G channels from polar to cartesian.

    Polar mapping:
        R channel = magnitude [0, 1]
        G channel = theta mapped to [0, 2*pi]

    Cartesian output:
        x = magnitude * cos(theta)
        y = magnitude * sin(theta)

    The result is resized to (target_h, target_w) via bilinear interpolation
    to match the field texture dimensions.

    Returns:
        (target_h, target_w, 2) float32 numpy array of (x, y) values,
        or None if the image could not be loaded.
    """
    try:
        img = Image.open(str(filepath)).convert("RGB")
    except Exception as e:
        print(f"Warning: failed to open image {filepath}: {e}")
        return None

    img_array = np.array(img, dtype=np.float32) / 255.0
    img_array = img_array[::-1]  # flip vertically: image origin is top-left, texture origin is bottom-left
    magnitude = img_array[:, :, 0]  # R channel
    theta = img_array[:, :, 1] * (2.0 * np.pi)  # G channel -> [0, 2*pi]

    x = magnitude * np.cos(theta)
    y = magnitude * np.sin(theta)

    cartesian = np.stack([x, y], axis=-1)

    h, w = cartesian.shape[:2]
    if h != target_h or w != target_w:
        cartesian = _bilinear_resize(cartesian, target_h, target_w)

    return cartesian.astype(np.float32)


def _bilinear_resize(data: np.ndarray, new_h: int, new_w: int) -> np.ndarray:
    """Resize a (h, w, channels) float32 array using bilinear interpolation."""
    old_h, old_w, channels = data.shape
    result = np.empty((new_h, new_w, channels), dtype=np.float32)

    # Map new pixel centers to old pixel space
    row_coords = np.arange(new_h, dtype=np.float64) * (old_h / new_h)
    col_coords = np.arange(new_w, dtype=np.float64) * (old_w / new_w)

    r0 = np.clip(np.floor(row_coords).astype(int), 0, old_h - 1)
    r1 = np.clip(r0 + 1, 0, old_h - 1)
    c0 = np.clip(np.floor(col_coords).astype(int), 0, old_w - 1)
    c1 = np.clip(c0 + 1, 0, old_w - 1)

    dr = (row_coords - r0).astype(np.float32)
    dc = (col_coords - c0).astype(np.float32)

    for ch in range(channels):
        plane = data[:, :, ch]
        top = plane[r0][:, c0] * (1 - dc) + plane[r0][:, c1] * dc
        bot = plane[r1][:, c0] * (1 - dc) + plane[r1][:, c1] * dc
        result[:, :, ch] = top * (1 - dr[:, None]) + bot * dr[:, None]

    return result
