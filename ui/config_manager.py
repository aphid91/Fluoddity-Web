"""Config Manager window: pick which ConfigData the controls will edit.

The ConfigBuffer can hold several configs, and entities choose one via their
config_index. This window is where you select WHICH of them subsequent controls
(sliders, when they exist) will operate on. Config 0 is selected by default, so
with a single-config buffer -- the common case -- nothing needs touching.

Selection is state only today: it is reported to the debug panel and will be
consumed by the per-config controls when those land. It deliberately has no
visual effect on the canvas yet.

Three ways to grow the buffer:
  Duplicate Selected   append a copy of the current selection
  Load...              append every config from a saved file
  Remove               drop the selected config

The Load... browser here is deliberately PLAIN -- no hover-preview, no delete.
Those mechanics belong to File>Load, whose job is replacing the buffer.
This one appends, so previewing it would mean repeatedly growing and shrinking
the buffer under the cursor, which is confusing rather than helpful.

This module holds no simulation state; it reports named commands.
"""

from __future__ import annotations

from imgui_bundle import imgui


class ConfigManagerWindow:
    """Mixin providing the Config Manager. Host supplies `_dispatch`/`_status`."""

    def _init_config_manager(self):
        self.show_config_manager = False
        #: True while the embedded Load... browser is open.
        self._manager_browser_open = False
        self._manager_message = ""

    def _config_manager_window(self):
        if not self.show_config_manager:
            return

        imgui.set_next_window_size(imgui.ImVec2(320, 380), imgui.Cond_.first_use_ever.value)
        expanded, self.show_config_manager = imgui.begin("Config Manager", True)
        if not expanded:
            imgui.end()
            return

        configs = self._status.get('config_count', 1)
        selected = self._status.get('selected_config', 0)
        max_configs = self._status.get('max_configs', 64)

        imgui.text(f"ConfigBuffer: {configs} / {max_configs}")
        imgui.text_disabled("controls will edit the selected config")
        imgui.separator()

        # The list is capped for display; the buffer itself is capped at the
        # same number, so this cannot hide anything in practice.
        shown = min(configs, max_configs)
        # end_child() is UNCONDITIONAL -- unlike begin_menu/tree_node, a child
        # window must be closed even when begin_child() returns false (clipped
        # or collapsed), or imgui's window stack corrupts on the next frame.
        if imgui.begin_child("config_list", imgui.ImVec2(0, 200), True):
            for i in range(shown):
                label = f"Config {i}"
                if i == 0:
                    label += "  (default)"
                if imgui.selectable(label, i == selected)[0]:
                    self._dispatch('select_config', i)
        imgui.end_child()

        imgui.separator()

        full = configs >= max_configs
        if full:
            imgui.begin_disabled()
        if imgui.button("Duplicate Selected"):
            self._dispatch('duplicate_config', selected)
        imgui.same_line()
        if imgui.button("Load..."):
            self._manager_browser_open = not self._manager_browser_open
        if full:
            imgui.end_disabled()
            imgui.text_disabled("buffer is full")

        imgui.same_line()
        if configs <= 1:
            imgui.begin_disabled()
        imgui.push_style_color(imgui.Col_.button.value, imgui.ImVec4(0.6, 0.15, 0.15, 1.0))
        imgui.push_style_color(imgui.Col_.button_hovered.value, imgui.ImVec4(0.85, 0.2, 0.2, 1.0))
        if imgui.button("Remove"):
            self._dispatch('remove_config', selected)
        imgui.pop_style_color(2)
        if configs <= 1:
            imgui.end_disabled()

        message = self._status.get('manager_message', '')
        if message:
            imgui.push_style_color(imgui.Col_.text.value, imgui.ImVec4(1.0, 0.75, 0.35, 1.0))
            imgui.text_wrapped(message)
            imgui.pop_style_color()

        if self._manager_browser_open:
            self._manager_load_browser()

        imgui.end()

    def _manager_load_browser(self):
        """Append-from-file browser. Plain list: no preview, no delete."""
        imgui.separator()
        imgui.text("Append configs from a save")
        imgui.text_disabled("adds every config in the file")

        categories = self._status.get('config_categories') or {}
        if not categories:
            imgui.text_disabled("no configs found")
            return

        if imgui.begin_child("manager_browser", imgui.ImVec2(0, 160), True):
            for category, entries in categories.items():
                flags = (imgui.TreeNodeFlags_.default_open.value
                         if category == 'Core' else 0)
                if not imgui.tree_node_ex(f"{category} ({len(entries)})", flags):
                    continue
                for entry in entries:
                    imgui.push_id(f"mgr/{entry.category}/{entry.name}")
                    if imgui.selectable(entry.name, False)[0]:
                        self._dispatch('append_config_file', entry)
                        self._manager_browser_open = False
                    imgui.pop_id()
                imgui.tree_pop()
        imgui.end_child()   # unconditional -- see the note above

        if imgui.button("Close browser"):
            self._manager_browser_open = False
