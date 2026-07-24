"""
Keybinding Management System

Loads keyboard controls from keyboard_controls.json and provides mapping
from human-readable key names to GLFW key codes.
"""

import json
import glfw
from pathlib import Path
from typing import Dict
from utilities.paths import get_user_keyboard_controls_path, get_default_keyboard_controls_path


class KeybindingManager:
    """Manages keyboard bindings loaded from JSON configuration."""

    # Mapping from single character/name strings to GLFW key codes
    KEY_NAME_TO_GLFW = {
        # Letters
        'A': glfw.KEY_A, 'B': glfw.KEY_B, 'C': glfw.KEY_C, 'D': glfw.KEY_D,
        'E': glfw.KEY_E, 'F': glfw.KEY_F, 'G': glfw.KEY_G, 'H': glfw.KEY_H,
        'I': glfw.KEY_I, 'J': glfw.KEY_J, 'K': glfw.KEY_K, 'L': glfw.KEY_L,
        'M': glfw.KEY_M, 'N': glfw.KEY_N, 'O': glfw.KEY_O, 'P': glfw.KEY_P,
        'Q': glfw.KEY_Q, 'R': glfw.KEY_R, 'S': glfw.KEY_S, 'T': glfw.KEY_T,
        'U': glfw.KEY_U, 'V': glfw.KEY_V, 'W': glfw.KEY_W, 'X': glfw.KEY_X,
        'Y': glfw.KEY_Y, 'Z': glfw.KEY_Z,

        # Numbers
        '0': glfw.KEY_0, '1': glfw.KEY_1, '2': glfw.KEY_2, '3': glfw.KEY_3,
        '4': glfw.KEY_4, '5': glfw.KEY_5, '6': glfw.KEY_6, '7': glfw.KEY_7,
        '8': glfw.KEY_8, '9': glfw.KEY_9,

        # Special keys
        'SPACE': glfw.KEY_SPACE,
        'ESCAPE': glfw.KEY_ESCAPE,
        'ESC': glfw.KEY_ESCAPE,
        'ENTER': glfw.KEY_ENTER,
        'TAB': glfw.KEY_TAB,
        'BACKSPACE': glfw.KEY_BACKSPACE,
        'DELETE': glfw.KEY_DELETE,

        # Function keys
        'F1': glfw.KEY_F1, 'F2': glfw.KEY_F2, 'F3': glfw.KEY_F3, 'F4': glfw.KEY_F4,
        'F5': glfw.KEY_F5, 'F6': glfw.KEY_F6, 'F7': glfw.KEY_F7, 'F8': glfw.KEY_F8,
        'F9': glfw.KEY_F9, 'F10': glfw.KEY_F10, 'F11': glfw.KEY_F11, 'F12': glfw.KEY_F12,

        # Arrow keys
        'UP': glfw.KEY_UP, 'DOWN': glfw.KEY_DOWN,
        'LEFT': glfw.KEY_LEFT, 'RIGHT': glfw.KEY_RIGHT,

        # Common punctuation
        'COMMA': glfw.KEY_COMMA, 'PERIOD': glfw.KEY_PERIOD,
        'SLASH': glfw.KEY_SLASH, 'SEMICOLON': glfw.KEY_SEMICOLON,
        'APOSTROPHE': glfw.KEY_APOSTROPHE, 'LEFT_BRACKET': glfw.KEY_LEFT_BRACKET,
        'RIGHT_BRACKET': glfw.KEY_RIGHT_BRACKET, 'BACKSLASH': glfw.KEY_BACKSLASH,
        'MINUS': glfw.KEY_MINUS, 'EQUAL': glfw.KEY_EQUAL,
    }

    def __init__(self, config_path: str = None,
                 default_config_path: str = None):
        """
        Initialize the keybinding manager.

        Args:
            config_path: Path to the active keyboard controls JSON file (default: Documents/Fluoddity/)
            default_config_path: Path to the default keyboard controls JSON file (default: app directory)
        """
        if config_path is None:
            self.config_path = get_user_keyboard_controls_path()
        else:
            self.config_path = Path(config_path)

        if default_config_path is None:
            self.default_config_path = get_default_keyboard_controls_path()
        else:
            self.default_config_path = Path(default_config_path)

        self.bindings: Dict[str, int] = {}

        self._load_bindings()

    def _load_bindings(self):
        """Load keybindings from JSON file, creating from default if needed."""
        # If keyboard_controls.json doesn't exist, copy from default
        if not self.config_path.exists():
            if self.default_config_path.exists():
                import shutil
                shutil.copy(self.default_config_path, self.config_path)
                print(f"Created {self.config_path} from {self.default_config_path}")
            else:
                print(f"Warning: Neither {self.config_path} nor {self.default_config_path} found!")
                return

        # Load the JSON file
        try:
            with open(self.config_path, 'r') as f:
                config = json.load(f)

            # Convert each binding from string to GLFW key code
            for action, key_name in config.items():
                key_name_upper = key_name.upper()
                if key_name_upper in self.KEY_NAME_TO_GLFW:
                    self.bindings[action] = self.KEY_NAME_TO_GLFW[key_name_upper]
                else:
                    print(f"Warning: Unknown key name '{key_name}' for action '{action}'")

            print(f"Loaded {len(self.bindings)} keybindings from {self.config_path}")

        except Exception as e:
            print(f"Error loading keybindings from {self.config_path}: {e}")

    def get_key(self, action: str) -> int | None:
        """
        Get the GLFW key code for a given action.

        Args:
            action: The action name (e.g., "camera_forward", "record_screen")

        Returns:
            The GLFW key code, or None if the action is not bound
        """
        return self.bindings.get(action)

    def get_key_display_name(self, action: str) -> str:
        """
        Get the human-readable key name for a given action.

        Args:
            action: The action name (e.g., "camera_forward", "record_screen")

        Returns:
            The key name as a string (e.g., "W", "SPACE"), or "?" if not bound
        """
        # Load the raw config to get the original key name
        try:
            with open(self.config_path, 'r') as f:
                config = json.load(f)
                return config.get(action, "?").upper()
        except Exception:
            return "?"

    def reload(self):
        """Reload keybindings from the JSON file."""
        self.bindings.clear()
        self._load_bindings()
