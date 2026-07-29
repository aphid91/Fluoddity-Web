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

from .toolbar import TOOLS

from .hover_preview import PreviewSession

#: Highlight for the Show/Hide GUI button while the panels are hidden. Matches
#: the toolbar's active-tool colors, so "this control is currently doing
#: something" looks the same everywhere in the app.
_GUI_HIDDEN = imgui.ImVec4(0.16, 0.44, 0.75, 1.0)
_GUI_HIDDEN_HOVERED = imgui.ImVec4(0.22, 0.55, 0.9, 1.0)


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

        #: Hover-preview for the Load submenu. Its own session (and therefore
        #: its own snapshot), so the Config Clipboard's previewing cannot
        #: clobber it or vice versa.
        self._load_preview = PreviewSession(
            on_snapshot=lambda: self._dispatch_result('snapshot_configs'),
            on_restore=lambda snap: self._dispatch('restore_configs', snap),
            on_apply=lambda entry: self._dispatch('preview_config', entry),
        )

        #: Hover-preview for the Load Checkpoint submenu. A SECOND, independent
        #: session for the same reason: both submenus can be walked in one
        #: sitting, and sharing a snapshot would let one restore the other's
        #: state.
        self._checkpoint_preview = PreviewSession(
            on_snapshot=lambda: self._dispatch_result('clipboard_snapshot'),
            on_restore=lambda snap: self._dispatch('clipboard_restore', snap),
            on_apply=lambda cp: self._dispatch('clipboard_apply', cp),
        )

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

        if imgui.begin_menu("Edit"):
            # Enabled state comes from the Orchestrator; with no history the
            # entries grey out rather than silently doing nothing.
            can_undo = bool(self._status['can_undo'])
            can_redo = bool(self._status['can_redo'])
            label = self._status['undo_label'] or ''
            undo_text = f"Undo {label}" if label else "Undo"
            if imgui.menu_item_simple(undo_text, "Ctrl+Z", False, can_undo):
                self._dispatch('undo')
            if imgui.menu_item_simple("Redo", "Ctrl+Shift+Z", False, can_redo):
                self._dispatch('redo')
            imgui.separator()
            # The config clipboard, under the keys people already reach for.
            has_checkpoint = bool(self._status['checkpoints'])
            if imgui.menu_item_simple("Set Checkpoint", "Ctrl+C"):
                self._dispatch('set_checkpoint')
            if imgui.menu_item_simple("Load Latest Checkpoint", "Ctrl+V",
                                      False, has_checkpoint):
                self._dispatch('load_latest_checkpoint')
            self._checkpoint_menu()
            imgui.end_menu()

        if imgui.begin_menu("Tools"):
            active = self._status['mouse_mode']
            for value, tool_label, key in TOOLS:
                clicked, _ = imgui.menu_item(tool_label, key, value == active)
                if clicked:
                    self._dispatch('set_mouse_mode', value)
            imgui.end_menu()

        if imgui.begin_menu("View"):
            if imgui.menu_item_simple("Toggle Camera Mode", "TAB"):
                self._dispatch('toggle_camera_mode')
            if imgui.menu_item_simple("Reset View", "HOME"):
                self._dispatch('reset_camera')
            imgui.separator()
            _, self.gui_hidden = imgui.menu_item(
                "Hide GUI", "X", self.gui_hidden)
            imgui.separator()
            _, self.show_toolbar = imgui.menu_item(
                "Tools", "", self.show_toolbar)
            _, self.show_settings = imgui.menu_item(
                "Project", "", self.show_settings)
            _, self.show_drawing = imgui.menu_item(
                "Drawing Controls", "", self.show_drawing)
            _, self.show_preferences = imgui.menu_item(
                "Preferences", "", self.show_preferences)
            _, self.show_config_manager = imgui.menu_item(
                "Config Manager", "", self.show_config_manager)
            _, self.show_debug_panel = imgui.menu_item(
                "Debug Panel", "", self.show_debug_panel)
            imgui.end_menu()

        if imgui.begin_menu("Simulation"):
            paused = bool(self._status['paused'])
            if imgui.menu_item_simple("Resume" if paused else "Pause", "SPACE"):
                self._dispatch('toggle_pause')
            if imgui.menu_item_simple("Reset", "R"):
                self._dispatch('reset')
            imgui.separator()
            if imgui.menu_item_simple("Randomize Behavior", "B"):
                self._dispatch('randomize_behavior')
            if imgui.menu_item_simple("Randomize Mutation Seed", "F"):
                self._dispatch('randomize_seed')
            imgui.separator()
            if imgui.menu_item_simple("Reload Shaders", "U"):
                self._dispatch('reload')
            imgui.end_menu()

        self._gui_toggle_button()

        imgui.end_main_menu_bar()

    def _gui_toggle_button(self):
        """The Show/Hide GUI control, on the menu bar itself.

        On the BAR rather than only in the View menu because it is the one
        control that has to be reachable while everything else is hidden --
        putting it behind a menu the user has just hidden the rest of would be
        a small trap. It is highlighted while hiding, so the state is visible
        without opening anything.
        """
        # Captured BEFORE the button, because clicking it flips the flag:
        # testing self.gui_hidden again afterwards would pop a different number
        # of colors than were pushed, exactly on the frame of the click.
        highlighted = self.gui_hidden

        if highlighted:
            imgui.push_style_color(imgui.Col_.button.value, _GUI_HIDDEN)
            imgui.push_style_color(imgui.Col_.button_hovered.value,
                                   _GUI_HIDDEN_HOVERED)
            imgui.push_style_color(imgui.Col_.button_active.value,
                                   _GUI_HIDDEN_HOVERED)

        if imgui.button("Show/Hide GUI ('X')"):
            self.gui_hidden = not self.gui_hidden

        if highlighted:
            imgui.pop_style_color(3)

    # ------------------------------------------------------------------
    # Load
    # ------------------------------------------------------------------

    def _load_menu(self):
        """The Load submenu: categories, hover-preview, delete."""
        opened = imgui.begin_menu("Load")

        # Opening edge: snapshot what we may need to restore.
        if opened:
            self._load_preview.begin()
        else:
            # Closing edge: undo any preview, unless a click committed one.
            self._load_preview.end()
            return

        categories = self._status['config_categories'] or {}
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

        self._load_preview.sync(hovered_now, key_of=lambda e: e.key)
        imgui.end_menu()

    @staticmethod
    def _browser_entry(row_id: str, label: str):
        """One browsable row: a name to load, and an X to remove it.

        Returns (clicked, hovered, delete_clicked). It renders and reports; the
        CALLER decides what loading and deleting mean, because that is the only
        thing the two browsers disagree about -- File > Load confirms its delete
        (it destroys a file), Load Checkpoint does it immediately (session-only
        and cheap to retake).

        LAYOUT MATTERS HERE. A default imgui.selectable() spans the full width
        of the menu, so a button placed after it with same_line() sits ON TOP of
        the selectable's click area -- the selectable is submitted first, wins
        the click, and pressing X silently loads the entry instead of deleting
        it. The selectable is therefore given an explicit width that stops short
        of the button.
        """
        imgui.push_id(row_id)

        button_w = imgui.get_frame_height()      # square-ish X button
        spacing = imgui.get_style().item_spacing.x
        # Menus size to their content, so there is no meaningful "available
        # width" to subtract from. Derive a row width from the text instead, and
        # keep a floor so short names still leave a comfortable target.
        text_w = imgui.calc_text_size(label).x
        name_w = max(text_w + spacing * 2.0, 120.0)

        clicked = imgui.selectable(label, False, 0,
                                   imgui.ImVec2(name_w, 0.0))[0]
        hovered = imgui.is_item_hovered()

        imgui.same_line(0.0, spacing)
        imgui.push_style_color(imgui.Col_.button.value, imgui.ImVec4(0.6, 0.15, 0.15, 1.0))
        imgui.push_style_color(imgui.Col_.button_hovered.value, imgui.ImVec4(0.85, 0.2, 0.2, 1.0))
        delete_clicked = imgui.button("X", imgui.ImVec2(button_w, 0.0))
        imgui.pop_style_color(2)
        # The X is part of the row: hovering it must not read as unhovering the
        # row, or the preview would snap back as the cursor crossed to it.
        if imgui.is_item_hovered():
            hovered = True

        imgui.pop_id()
        return clicked, hovered, delete_clicked

    def _load_entry(self, entry) -> bool:
        """One config-file row. Returns True if hovered."""
        clicked, hovered, delete_clicked = self._browser_entry(
            f"{entry.category}/{entry.name}", entry.name)

        if delete_clicked:
            # Deleting is destructive and permanent, so it opens a confirmation
            # rather than firing on click. Confirmation is a top-level modal,
            # NOT a popup nested in this menu: a popup opened inside a menu dies
            # with the menu, so the dialog would vanish the moment the user
            # moved the cursor. The modal outlives the menu and is rendered by
            # _build_ui.
            self._pending_delete = entry
            # Deleting the previewed config must not leave it applied.
            self._load_preview.restore_now()
            self._load_preview.forget()

        if clicked:
            # Commit: drop the snapshot so closing does not undo this.
            # imgui closes the menu itself when a selectable is activated.
            self._load_preview.commit(entry.key)
            self._dispatch('load_config', entry)

        return hovered

    # ------------------------------------------------------------------
    # Load Checkpoint
    # ------------------------------------------------------------------

    def _checkpoint_menu(self):
        """Edit > Load Checkpoint...: the in-session config clipboard.

        Deliberately the SAME shape as File > Load above -- hover to audition,
        unhover to snap back, click to lock in -- because it is the same act on
        a different collection. This replaced a standalone Config Clipboard
        window, which needed its own open/close lifecycle, its own child-window
        scrolling and its own "Set Checkpoint" button duplicating the menu item
        two rows above it. As a submenu it needs none of that.

        Checkpoints are session-only and cheap to retake, so the X deletes
        immediately -- unlike File > Load's X, which destroys a file on disk and
        therefore asks first.

        Its own PreviewSession (and therefore its own snapshot), so previewing
        here cannot clobber a preview in progress in the Load menu.
        """
        opened = imgui.begin_menu("Load Checkpoint...",
                                  bool(self._status['checkpoints']))

        # Opening edge: snapshot what we may need to restore. Taken on open
        # rather than per-hover so it captures the state the user is leaving.
        if opened:
            self._checkpoint_preview.begin()
        else:
            # Closing edge: undo any preview, unless a click committed one.
            # Also runs on the frame the menu is disabled/absent, which is
            # exactly when a stranded preview would otherwise stick.
            self._checkpoint_preview.end()
            return

        checkpoints = self._status['checkpoints'] or []
        if not checkpoints:
            imgui.text_disabled("no checkpoints this session")
            imgui.end_menu()
            return

        imgui.text_disabled(f"{len(checkpoints)} checkpoint(s), newest first")
        imgui.separator()

        hovered_now = None
        deleted = None
        for cp in checkpoints:
            hit, remove = self._checkpoint_entry(cp)
            if hit:
                hovered_now = cp
            if remove:
                deleted = cp

        self._checkpoint_preview.sync(hovered_now, key_of=lambda c: c.key)

        if deleted is not None:
            # The snapshot may hold the deleted checkpoint's state; put the
            # pre-preview state back and drop it, so a later restore cannot
            # resurrect what was just discarded.
            self._checkpoint_preview.restore_now()
            self._checkpoint_preview.forget()
            self._dispatch('delete_checkpoint', deleted)

        imgui.end_menu()

    def _checkpoint_entry(self, cp):
        """One checkpoint row. Returns (hovered, delete_requested).

        Unlike _load_entry, the delete is reported straight back to the caller
        rather than confirmed: checkpoints are session-only and cheap to retake,
        so there is nothing to protect the user from.
        """
        clicked, hovered, remove = self._browser_entry(f"cp/{cp.key}", cp.name)

        if clicked:
            # Commit: drop the snapshot so closing does not undo this.
            self._checkpoint_preview.commit(cp.key)
            self._dispatch('load_checkpoint', cp)

        return hovered, remove

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
            self._save_name = self._status['project_name'] or 'Untitled'

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
        config_count = self._status['config_count']
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
                self._save_error = self._status['save_error']
                if not self._save_error:
                    self.show_save_dialog = False
        imgui.same_line()
        if imgui.button("Cancel"):
            self.show_save_dialog = False

        imgui.end()
