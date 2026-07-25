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

        #: Entry awaiting delete confirmation, or None. Held at UI level rather
        #: than inside the menu so the dialog survives the menu closing.
        self._pending_delete = None

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
        """One row: a name to load, and an X to delete. Returns True if hovered.

        LAYOUT MATTERS HERE. A default imgui.selectable() spans the full width
        of the menu, so a button placed after it with same_line() sits ON TOP of
        the selectable's click area -- the selectable is submitted first, wins
        the click, and pressing X silently loads the config instead of deleting
        it. The selectable is therefore given an explicit width that stops short
        of the button.
        """
        imgui.push_id(f"{entry.category}/{entry.name}")

        button_w = imgui.get_frame_height()      # square-ish X button
        spacing = imgui.get_style().item_spacing.x
        # Menus size to their content, so there is no meaningful "available
        # width" to subtract from. Derive a row width from the text instead, and
        # keep a floor so short names still leave a comfortable target.
        text_w = imgui.calc_text_size(entry.name).x
        name_w = max(text_w + spacing * 2.0, 120.0)

        clicked = imgui.selectable(entry.name, False, 0,
                                   imgui.ImVec2(name_w, 0.0))[0]
        hovered = imgui.is_item_hovered()

        imgui.same_line(0.0, spacing)
        # Deleting is destructive and permanent, so it opens a confirmation
        # popup rather than firing on click.
        imgui.push_style_color(imgui.Col_.button.value, imgui.ImVec4(0.6, 0.15, 0.15, 1.0))
        imgui.push_style_color(imgui.Col_.button_hovered.value, imgui.ImVec4(0.85, 0.2, 0.2, 1.0))
        delete_clicked = imgui.button("X", imgui.ImVec2(button_w, 0.0))
        imgui.pop_style_color(2)
        if imgui.is_item_hovered():
            hovered = True
        if delete_clicked:
            # Confirmation is a top-level modal, NOT a popup nested in this
            # menu: a popup opened inside a menu dies with the menu, so the
            # dialog would vanish the moment the user moved the cursor. The
            # modal outlives the menu and is rendered by _build_ui.
            self._pending_delete = entry
            # Deleting the previewed config must not leave it applied.
            self._restore_snapshot()
            self._previewing = None

        if clicked:
            # Commit: drop the snapshot so closing does not undo this.
            # imgui closes the menu itself when a selectable is activated.
            self._load_committed = True
            self._previewing = entry.key
            self._dispatch('load_config', entry)

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

    def _delete_dialog(self):
        """Confirm a deletion. Rendered at top level, outside the menu.

        Deleting is permanent and the X sits right beside the load target, so a
        misclick must not destroy a config.
        """
        if self._pending_delete is None:
            return
        entry = self._pending_delete

        imgui.open_popup("Delete Config?")
        # Centre on the viewport so it is never off-screen or under the cursor.
        center = imgui.get_main_viewport().get_center()
        imgui.set_next_window_pos(center, imgui.Cond_.appearing.value,
                                  imgui.ImVec2(0.5, 0.5))
        opened, _ = imgui.begin_popup_modal(
            "Delete Config?", None, imgui.WindowFlags_.always_auto_resize.value)
        if not opened:
            return

        imgui.text(f"Delete '{entry.name}'?")
        imgui.text_disabled(f"{entry.category}  --  this cannot be undone.")
        imgui.spacing()

        if imgui.button("Delete", imgui.ImVec2(110, 0)):
            self._dispatch('delete_config', entry)
            self._pending_delete = None
            imgui.close_current_popup()
        imgui.same_line()
        if imgui.button("Cancel", imgui.ImVec2(110, 0)) or imgui.is_key_pressed(
                imgui.Key.escape):
            self._pending_delete = None
            imgui.close_current_popup()
        imgui.end_popup()

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
