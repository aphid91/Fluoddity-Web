"""Field loader window: file picker for loading force/strafe fields from images."""
from imgui_bundle import imgui
from utilities.paths import get_user_data_dir


class FieldLoaderWindowMixin:
    """Mixin for field image loader window. Combined into UI via multiple inheritance."""

    def _init_field_loader_state(self):
        """Initialize field loader state. Called from UI.__init__."""
        self._show_field_loader_window = False
        self._field_loader_target = ""  # "force" or "strafe"
        self._field_loader_files: list[str] = []

    def _open_field_loader(self, target: str):
        """Open the field loader window for the given target ("force" or "strafe")."""
        self._field_loader_target = target
        self._field_loader_files = self._scan_image_files()
        self._show_field_loader_window = True

    def _scan_image_files(self) -> list[str]:
        """Scan ~/Documents/Fluoddity for PNG and JPEG files."""
        user_dir = get_user_data_dir()
        if not user_dir.exists():
            return []
        extensions = {'.png', '.jpg', '.jpeg'}
        files = []
        for f in sorted(user_dir.iterdir()):
            if f.is_file() and f.suffix.lower() in extensions:
                files.append(f.name)
        return files

    def render_field_loader_window(self):
        """Render the field loader file picker window."""
        if not self._show_field_loader_window:
            return

        target_label = "Force" if self._field_loader_target == "force" else "Strafe"
        title = f"Load {target_label} Field Image"

        imgui.set_next_window_size(imgui.ImVec2(350, 400), imgui.Cond_.first_use_ever)
        expanded, opened = imgui.begin(title, True)

        if not opened:
            self._show_field_loader_window = False
            imgui.end()
            return

        if expanded:
            imgui.text_disabled("Select a PNG/JPEG from ~/Documents/Fluoddity")
            imgui.text_disabled("Vector field should be in polar form\nin the red and green channels:\nR=magnitude [0,1], G=angle [0,2pi]")
            imgui.separator()

            if len(self._field_loader_files) == 0:
                imgui.text_colored(imgui.ImVec4(1.0, 0.5, 0.5, 1.0), "No PNG/JPEG files found")
            else:
                for filename in self._field_loader_files:
                    clicked, _ = imgui.selectable(filename, False)
                    if clicked:
                        user_dir = get_user_data_dir()
                        filepath = str(user_dir / filename)
                        if self._field_loader_target == "force":
                            self._request_load_force_field_image = True
                        else:
                            self._request_load_strafe_field_image = True
                        self._field_load_image_path = filepath
                        self._show_field_loader_window = False

        imgui.end()
