"""Config Clipboard window: in-session checkpoints of the whole ConfigBuffer.

A scratch space for experimenting. Hit "Set Checkpoint" before changing things
and you can get back, without committing anything to disk. Checkpoints capture
and restore the ENTIRE ConfigBuffer, not just the selected config.

Session-only by design: these vanish on quit. Anything worth keeping goes
through File > Save, which is what the on-disk format is for.

Browsing works exactly like the File > Load menu -- hover to audition, unhover
to snap back, click to lock in -- because that interaction is already familiar
from the load menu and there is no reason for two different idioms. The state
machine itself is shared code (PreviewSession), not a reimplementation, so the
two surfaces cannot drift apart. Each surface owns its own session, so hovering
here never disturbs a preview in progress in the Load menu.

Deleting has no confirmation: a checkpoint is a scratch copy, cheap to retake,
unlike a saved file.

Newest is shown on top, since the thing you just checkpointed is the thing you
are most likely to want back.
"""

from __future__ import annotations

from imgui_bundle import imgui

from .hover_preview import PreviewSession


class ConfigClipboardWindow:
    """Mixin providing the Config Clipboard. Host supplies `_dispatch`/`_status`."""

    def _init_config_clipboard(self):
        self.show_config_clipboard = False
        self._clipboard_preview = PreviewSession(
            on_snapshot=lambda: self._dispatch_result('clipboard_snapshot'),
            on_restore=lambda snap: self._dispatch('clipboard_restore', snap),
            on_apply=lambda item: self._dispatch('clipboard_apply', item),
        )
        #: True while the cursor is inside the checkpoint list.
        self._clipboard_list_active = False

    def _config_clipboard_window(self):
        if not self.show_config_clipboard:
            # A window that is closed cannot be hovered; end any live preview
            # so closing it mid-hover does not strand a previewed config.
            if self._clipboard_preview.is_open:
                self._clipboard_preview.end()
            return

        imgui.set_next_window_size(imgui.ImVec2(300, 340), imgui.Cond_.first_use_ever.value)
        expanded, self.show_config_clipboard = imgui.begin("Config Clipboard", True)
        if not expanded:
            imgui.end()
            if self._clipboard_preview.is_open:
                self._clipboard_preview.end()
            return

        checkpoints = self._status.get('checkpoints') or []

        if imgui.button("Set Checkpoint (Ctrl+C)"):
            self._dispatch('set_checkpoint')
        imgui.same_line()
        if not checkpoints:
            imgui.begin_disabled()
        if imgui.button("Load Most Recent (Ctrl+V)"):
            # Committing first means the hover machinery will not undo this
            # when the cursor later leaves the list.
            self._clipboard_preview.commit(checkpoints[0].key if checkpoints else None)
            self._dispatch('load_latest_checkpoint')
        if not checkpoints:
            imgui.end_disabled()

        imgui.separator()

        if not checkpoints:
            imgui.text_disabled("no checkpoints this session")
            imgui.text_disabled("press Ctrl+C to store one")
            imgui.end()
            return

        imgui.text_disabled(f"{len(checkpoints)} checkpoint(s), newest first")

        hovered_now = None
        deleted = None
        if imgui.begin_child("checkpoint_list", imgui.ImVec2(0, 0), True):
            # Opening the session on first hover (rather than on window open)
            # keeps the snapshot fresh: it captures the state the user is
            # actually leaving, not whatever was live when the window appeared.
            for cp in checkpoints:
                hit, remove = self._checkpoint_row(cp)
                if hit:
                    hovered_now = cp
                if remove:
                    deleted = cp
        # end_child() is UNCONDITIONAL -- unlike begin_menu/tree_node, a child
        # window must be closed even when begin_child() returns false (clipped
        # or collapsed), or imgui's window stack corrupts on the next frame.
        imgui.end_child()

        if hovered_now is not None and not self._clipboard_preview.is_open:
            self._clipboard_preview.begin()
        self._clipboard_preview.sync(hovered_now, key_of=lambda cp: cp.key)
        if hovered_now is None and self._clipboard_preview.is_open:
            self._clipboard_preview.end()

        if deleted is not None:
            # The snapshot may hold the deleted checkpoint's state; drop it so
            # a later restore cannot resurrect what was just discarded.
            if self._clipboard_preview.is_open:
                self._clipboard_preview.restore_now()
                self._clipboard_preview.end()
            self._dispatch('delete_checkpoint', deleted)

        imgui.end()

    def _checkpoint_row(self, cp):
        """One checkpoint row. Returns (hovered, delete_requested).

        Same layout discipline as the load menu: the selectable is given an
        explicit width so the X button is not sitting on top of its click area.
        """
        imgui.push_id(f"cp/{cp.key}")

        button_w = imgui.get_frame_height()
        spacing = imgui.get_style().item_spacing.x
        avail = imgui.get_content_region_avail().x
        name_w = max(avail - button_w - spacing, 80.0)

        clicked = imgui.selectable(cp.name, False, 0, imgui.ImVec2(name_w, 0.0))[0]
        hovered = imgui.is_item_hovered()

        imgui.same_line(0.0, spacing)
        imgui.push_style_color(imgui.Col_.button.value, imgui.ImVec4(0.6, 0.15, 0.15, 1.0))
        imgui.push_style_color(imgui.Col_.button_hovered.value, imgui.ImVec4(0.85, 0.2, 0.2, 1.0))
        remove = imgui.button("X", imgui.ImVec2(button_w, 0.0))
        imgui.pop_style_color(2)
        if imgui.is_item_hovered():
            hovered = True

        if clicked:
            self._clipboard_preview.commit(cp.key)
            self._dispatch('load_checkpoint', cp)

        imgui.pop_id()
        return hovered, remove
