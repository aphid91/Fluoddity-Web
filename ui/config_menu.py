"""The File menu: saving configs, and the browse-by-hover load menu.

THE LOAD MENU'S CONTRACT (the interesting part)

Hovering an entry applies it immediately, so browsing the list auditions each
config live on the running simulation. That means the menu must be able to put
things back:

  - opening the menu     snapshots the current configs
  - hovering an entry    applies that config (previewing)
  - hovering elsewhere   restores the snapshot
  - closing without a
    click                restores the snapshot
  - CLICKING an entry    commits: the snapshot is dropped, so the closing
                         restore does NOT undo the choice

That last rule is what makes clicking feel decisive rather than accidental, and
it is the case that is easy to get wrong -- a naive implementation restores on
close and silently throws away the user's selection.

Preview applies configs and world settings only. The camera and the particles
are left alone, so unhovering is instantaneous and never jumps the view.

This module holds no simulation state. It reports intent through the same named
commands the rest of the UI uses; the Orchestrator does the work.
"""

from __future__ import annotations

from imgui_bundle import imgui


class ConfigMenu:
    """Mixin providing the File menu. Expects the host to supply `_dispatch`."""

    def _init_config_menu(self):
        self.show_save_dialog = False
        self._save_name = ""
        self._save_all_configs = False
        self._save_error = ""

        #: (category, name) currently being previewed, or None.
        self._previewing = None
        #: True while the load submenu is open, so open/close edges are visible.
        self._load_menu_open = False
        #: Set when a click commits a load, suppressing the close-restore.
        self._load_committed = False

    # ------------------------------------------------------------------
    # Menu bar
    # ------------------------------------------------------------------

    def _menu_bar(self):
        if not imgui.begin_main_menu_bar():
            return
        if imgui.begin_menu("File"):
            if imgui.menu_item_simple("Save..."):
                self._open_save_dialog()
            self._load_menu()
            imgui.separator()
            if imgui.menu_item_simple("Quit"):
                self._dispatch('quit')
            imgui.end_menu()

        if imgui.begin_menu("View"):
            if imgui.menu_item_simple("Toggle Camera Mode", "TAB"):
                self._dispatch('toggle_camera_mode')
            if imgui.menu_item_simple("Reset View", "HOME"):
                self._dispatch('reset_camera')
            imgui.separator()
            _, self.show_debug_panel = imgui.menu_item(
                "Debug Panel", "", self.show_debug_panel)
            imgui.end_menu()

        if imgui.begin_menu("Simulation"):
            if imgui.menu_item_simple("Reset", "SPACE"):
                self._dispatch('reset')
            if imgui.menu_item_simple("Reload Shaders", "R"):
                self._dispatch('reload')
            imgui.end_menu()

        imgui.end_main_menu_bar()

    # ------------------------------------------------------------------
    # Load
    # ------------------------------------------------------------------

    def _load_menu(self):
        """The Load submenu: categories, hover-preview, delete."""
        opened = imgui.begin_menu("Load")

        # Opening edge: snapshot what we may need to restore.
        if opened and not self._load_menu_open:
            self._load_menu_open = True
            self._load_committed = False
            self._dispatch('snapshot_configs')

        if not opened:
            # Closing edge: undo any preview, unless a click committed one.
            if self._load_menu_open:
                self._load_menu_open = False
                if not self._load_committed:
                    self._restore_snapshot()
                self._previewing = None
            return

        categories = self._status.get('config_categories') or {}
        if not categories:
            imgui.text_disabled("no configs found")
            imgui.end_menu()
            return

        hovered_now = None
        for category, entries in categories.items():
            # Core expanded by default; user folders collapsed, so the list
            # stays short as saves accumulate.
            flags = (imgui.TreeNodeFlags_.default_open.value
                     if category == 'Core' else 0)
            if not imgui.tree_node_ex(f"{category} ({len(entries)})", flags):
                continue
            for entry in entries:
                if self._load_entry(entry):
                    hovered_now = entry
            imgui.tree_pop()

        self._sync_preview(hovered_now)
        imgui.end_menu()

    def _load_entry(self, entry) -> bool:
        """One row. Returns True if it is hovered."""
        imgui.push_id(f"{entry.category}/{entry.name}")

        clicked = imgui.selectable(entry.name, False)[0]
        hovered = imgui.is_item_hovered()

        imgui.same_line()
        # Red X, right-aligned-ish. Deleting is destructive and permanent, so
        # it is guarded by a confirmation popup rather than firing on click.
        imgui.push_style_color(imgui.Col_.button.value, imgui.ImVec4(0.6, 0.15, 0.15, 1.0))
        if imgui.small_button("X"):
            imgui.open_popup("confirm_delete")
        imgui.pop_style_color()
        if imgui.is_item_hovered():
            hovered = True

        if imgui.begin_popup("confirm_delete"):
            imgui.text(f"Delete '{entry.name}'?")
            imgui.text_disabled("This cannot be undone.")
            if imgui.button("Delete"):
                # Restore first: the previewed config may be the one being
                # deleted, and we must not leave it applied afterwards.
                self._restore_snapshot()
                self._previewing = None
                self._dispatch('delete_config', entry)
                imgui.close_current_popup()
            imgui.same_line()
            if imgui.button("Cancel"):
                imgui.close_current_popup()
            imgui.end_popup()
            hovered = True   # the popup counts as still being on this entry

        if clicked:
            # Commit: drop the snapshot so closing does not undo this.
            self._load_committed = True
            self._previewing = entry.key
            self._dispatch('load_config', entry)
            imgui.close_current_popup()

        imgui.pop_id()
        return hovered

    def _sync_preview(self, hovered):
        """Apply/undo previews as the hovered entry changes."""
        key = hovered.key if hovered is not None else None
        if key == self._previewing:
            return
        if hovered is None:
            self._restore_snapshot()
        else:
            self._dispatch('preview_config', hovered)
        self._previewing = key

    def _restore_snapshot(self):
        self._dispatch('restore_configs')

    # ------------------------------------------------------------------
    # Save
    # ------------------------------------------------------------------

    def _open_save_dialog(self):
        self.show_save_dialog = True
        self._save_error = ""
        if not self._save_name:
            self._save_name = self._status.get('preset', 'Untitled') or 'Untitled'

    def _save_dialog(self):
        if not self.show_save_dialog:
            return

        imgui.set_next_window_size(imgui.ImVec2(360, 0), imgui.Cond_.appearing.value)
        expanded, self.show_save_dialog = imgui.begin(
            "Save Config", True, imgui.WindowFlags_.no_collapse.value)
        if not expanded:
            imgui.end()
            return

        imgui.text("Filename")
        changed, self._save_name = imgui.input_text("##name", self._save_name)
        if changed:
            self._save_error = ""

        imgui.spacing()
        config_count = self._status.get('config_count', 1)
        if imgui.radio_button("Save Config 0 only", not self._save_all_configs):
            self._save_all_configs = False
        if imgui.radio_button(f"Save entire ConfigBuffer ({config_count})",
                              self._save_all_configs):
            self._save_all_configs = True
        if config_count == 1:
            imgui.text_disabled("(only one config exists; both are equivalent)")

        imgui.spacing()
        imgui.text_disabled(f"saves to configs/custom/")

        if self._save_error:
            imgui.push_style_color(imgui.Col_.text.value, imgui.ImVec4(1.0, 0.4, 0.4, 1.0))
            imgui.text_wrapped(self._save_error)
            imgui.pop_style_color()

        imgui.spacing()
        if imgui.button("Save"):
            name = self._save_name.strip()
            if not name:
                self._save_error = "Enter a filename."
            else:
                self._dispatch('save_config', name, self._save_all_configs)
                # The handler reports failure by setting save_error in status;
                # only close when it stayed clear.
                self._save_error = self._status.get('save_error', '')
                if not self._save_error:
                    self.show_save_dialog = False
        imgui.same_line()
        if imgui.button("Cancel"):
            self.show_save_dialog = False

        imgui.end()
