"""LRU cache for field texture PNG data loaded from disk.

Stores numpy float32 arrays in host memory, pre-resized to the target
GPU texture dimensions. Does NOT preload -- only loads from disk on
demand (when hovering over a config file in the Load menu).

Uses two separate caches:
- _data_cache (small, default 20): configs that HAVE field PNGs (heavy arrays)
- _miss_cache (large, default 2000): configs with NO field PNG (just None)
"""
from collections import OrderedDict
from pathlib import Path
import numpy as np

from utilities.field_texture_io import load_field_png, _bilinear_resize


class FieldTextureCache:
    """LRU cache mapping (filepath, target_dims) to decoded+resized field data."""

    def __init__(self, max_size: int = 20, max_miss_size: int = 2000):
        self._data_cache: OrderedDict[tuple, np.ndarray] = OrderedDict()
        self._miss_cache: OrderedDict[str, None] = OrderedDict()
        self._max_size = max_size
        self._max_miss_size = max_miss_size

    def get(self, json_filepath: Path, target_h: int, target_w: int) -> np.ndarray | None:
        """Get field data for a config file, resized to target dimensions.

        Derives the PNG path as ``{stem}_fields.png`` next to the JSON file.
        Returns None if no ``_fields.png`` exists (and caches that result).
        The returned array is guaranteed to match (target_h, target_w, 4).
        """
        path_str = str(json_filepath)

        # Check miss cache first (no field PNG exists for this config)
        if path_str in self._miss_cache:
            self._miss_cache.move_to_end(path_str)
            return None

        # Check data cache (has field data, already resized to target dims)
        data_key = (path_str, target_h, target_w)
        if data_key in self._data_cache:
            self._data_cache.move_to_end(data_key)
            return self._data_cache[data_key]

        # Cache miss -- load from disk
        fields_path = json_filepath.with_name(json_filepath.stem + "_fields.png")
        data = load_field_png(fields_path)

        if data is None:
            # No field PNG -- store in lightweight miss cache
            if len(self._miss_cache) >= self._max_miss_size:
                self._miss_cache.popitem(last=False)
            self._miss_cache[path_str] = None
            return None

        # Resize if needed
        data_h, data_w = data.shape[0], data.shape[1]
        if data_h != target_h or data_w != target_w:
            data = _bilinear_resize(data, target_h, target_w)

        # Store in data cache
        if len(self._data_cache) >= self._max_size:
            self._data_cache.popitem(last=False)
        self._data_cache[data_key] = data
        return data

    def invalidate(self, json_filepath: Path) -> None:
        """Remove all entries for a filepath (any target dimensions)."""
        path_str = str(json_filepath)
        self._miss_cache.pop(path_str, None)
        keys_to_remove = [k for k in self._data_cache if k[0] == path_str]
        for k in keys_to_remove:
            del self._data_cache[k]

    def clear(self) -> None:
        """Clear all cached entries."""
        self._data_cache.clear()
        self._miss_cache.clear()
