"""Popup modal dialogs: Save, Overwrite, Delete confirmations."""
from imgui_bundle import imgui


class PopupModalsMixin:
    """Mixin for popup modal dialogs. Combined into UI via multiple inheritance."""

    def render_popup_modals(self):
        """Render popup modals (Save, Overwrite, Delete) - called regardless of sidebar visibility."""
        # Save popup modal
        if self.save_popup_open:
            imgui.open_popup("Save Config")

        if imgui.begin_popup_modal("Save Config", flags=imgui.WindowFlags_.always_auto_resize)[0]:
            imgui.text("Enter filename (without extension):")
            _, self.save_filename_buffer = imgui.input_text(
                "##filename",
                self.save_filename_buffer,
            )

            imgui.separator()
            if imgui.button("Save", imgui.ImVec2(120, 0)):
                if self.save_filename_buffer.strip():
                    filename = self.save_filename_buffer.strip()
                    filepath = self.user_configs_dir / f"{filename}.json"
                    if filepath.exists():
                        # File exists, need overwrite confirmation
                        # Close save popup first, then open overwrite popup
                        self.overwrite_confirm_filename = filename
                        self.save_popup_open = False
                        imgui.close_current_popup()
                    else:
                        # File doesn't exist, save directly
                        self._save_filename = filename
                        self._request_save_file = True
                        self.save_popup_open = False
                        imgui.close_current_popup()
            imgui.same_line()
            if imgui.button("Cancel", imgui.ImVec2(120, 0)):
                self.save_popup_open = False
                imgui.close_current_popup()
            imgui.end_popup()

        # Overwrite confirmation popup
        if self.overwrite_confirm_filename:
            imgui.open_popup("Overwrite?")

        if imgui.begin_popup_modal("Overwrite?", flags=imgui.WindowFlags_.always_auto_resize)[0]:
            imgui.text(f"File '{self.overwrite_confirm_filename}.json' already exists.")
            imgui.text("Do you want to overwrite it?")
            imgui.separator()
            if imgui.button("Overwrite", imgui.ImVec2(120, 0)):
                self._save_filename = self.overwrite_confirm_filename
                self._request_save_file = True
                self.overwrite_confirm_filename = None
                self.save_popup_open = False
                imgui.close_current_popup()
            imgui.same_line()
            if imgui.button("Cancel", imgui.ImVec2(120, 0)):
                self.overwrite_confirm_filename = None
                imgui.close_current_popup()
            imgui.end_popup()

        # Delete confirmation popup
        if self.delete_confirm_filename:
            imgui.open_popup("Delete Config?")

        if imgui.begin_popup_modal("Delete Config?", flags=imgui.WindowFlags_.always_auto_resize)[0]:
            # Show category in dialog if not Custom (to clarify which file will be deleted)
            category_hint = f" ({self.delete_confirm_category})" if self.delete_confirm_category and self.delete_confirm_category != "Custom" else ""
            imgui.text(f"Are you sure you want to delete '{self.delete_confirm_filename}.json'{category_hint}?")
            imgui.separator()
            if imgui.button("Delete", imgui.ImVec2(120, 0)):
                self._delete_filename = self.delete_confirm_filename
                self._delete_category = self.delete_confirm_category or ""
                self._request_delete_file = True
                self.delete_confirm_filename = None
                self.delete_confirm_category = None
                imgui.close_current_popup()
            imgui.same_line()
            if imgui.button("Cancel", imgui.ImVec2(120, 0)):
                self.delete_confirm_filename = None
                self.delete_confirm_category = None
                imgui.close_current_popup()
            imgui.end_popup()
