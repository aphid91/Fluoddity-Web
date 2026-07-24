"""Config file browser: scanning, caching, and load submenu rendering."""
from imgui_bundle import imgui


class ConfigBrowserMixin:
    """Mixin for config file browsing. Combined into UI via multiple inheritance."""

    def _refresh_config_files(self):
        """Scan physics_configs directories for .json files, organized by category.

        Core and Advanced configs come from the app directory (bundled with app).
        Custom configs come from the user directory (Documents/Fluoddity/physics_configs).
        """
        self.config_files = []  # Keep for backward compatibility
        self.config_files_by_category = {
            "Core": [],
            "Custom": [],
            "Advanced": []
        }

        # Scan Core subfolder from app directory (bundled configs)
        if self.app_configs_dir.exists():
            core_dir = self.app_configs_dir / "Core"
            if core_dir.exists():
                for f in sorted(core_dir.glob("*.json")):
                    self.config_files_by_category["Core"].append(f.stem)

            # Scan Advanced subfolder from app directory (bundled configs)
            advanced_dir = self.app_configs_dir / "Advanced"
            if advanced_dir.exists():
                for f in sorted(advanced_dir.glob("*.json")):
                    self.config_files_by_category["Advanced"].append(f.stem)

        # Scan Custom configs from user directory (user-created configs)
        if self.user_configs_dir.exists():
            for f in sorted(self.user_configs_dir.glob("*.json")):
                self.config_files_by_category["Custom"].append(f.stem)
                self.config_files.append(f.stem)  # Maintain backward compat list

    def _cache_all_configs(self):
        """Load and cache all config files for preview."""
        self._refresh_config_files()
        self.cached_configs = {}

        # Load Core configs from app directory
        for filename in self.config_files_by_category["Core"]:
            filepath = self.app_configs_dir / "Core" / f"{filename}.json"
            config = self.config_saver.load_from_file(filepath)
            if config:
                self.cached_configs[f"Core/{filename}"] = config

        # Load Custom configs from user directory
        for filename in self.config_files_by_category["Custom"]:
            filepath = self.user_configs_dir / f"{filename}.json"
            config = self.config_saver.load_from_file(filepath)
            if config:
                self.cached_configs[f"Custom/{filename}"] = config

        # Load Advanced configs from app directory
        for filename in self.config_files_by_category["Advanced"]:
            filepath = self.app_configs_dir / "Advanced" / f"{filename}.json"
            config = self.config_saver.load_from_file(filepath)
            if config:
                self.cached_configs[f"Advanced/{filename}"] = config

    def _get_config_path(self, filename: str, category: str = ""):
        """Get the full path to a config file.

        Args:
            filename: Config filename without extension
            category: Optional category (Core, Custom, Advanced). If provided,
                     returns path directly without searching. If empty, searches
                     categories in order: Core, Advanced, Custom.

        Returns:
            Path to the config file
        """
        # If category is provided, return path directly
        if category == "Core":
            return self.app_configs_dir / "Core" / f"{filename}.json"
        elif category == "Advanced":
            return self.app_configs_dir / "Advanced" / f"{filename}.json"
        elif category == "Custom":
            return self.user_configs_dir / f"{filename}.json"

        # Fallback: search categories in order (for backward compatibility)
        if filename in self.config_files_by_category.get("Core", []):
            return self.app_configs_dir / "Core" / f"{filename}.json"

        if filename in self.config_files_by_category.get("Advanced", []):
            return self.app_configs_dir / "Advanced" / f"{filename}.json"

        # Default to Custom (user directory)
        return self.user_configs_dir / f"{filename}.json"

    def _render_load_submenu_content(self, menu_watercolor_mode: bool):
        """Render the content of a load submenu with hierarchical categories.

        Args:
            menu_watercolor_mode: The watercolor mode for this menu (False=standard, True=watercolor)

        Returns:
            Tuple of (filename, category) for the hovered item this frame, or None
        """
        # Check if we have any configs at all
        total_configs = sum(len(files) for files in self.config_files_by_category.values())
        if total_configs == 0:
            imgui.text_colored(imgui.ImVec4(1.0, 0.5, 0.5, 1.0), "No config files")
            return None

        # Calculate max filename width across all categories
        max_text_width = 0.0
        for category_files in self.config_files_by_category.values():
            for fn in category_files:
                text_size = imgui.calc_text_size(fn)
                if text_size.x > max_text_width:
                    max_text_width = text_size.x

        hovered_this_frame = None

        # Render each category with collapsible headers
        categories = [
            ("Core", self.config_files_by_category["Core"], "load_menu_core_open"),
            ("Custom", self.config_files_by_category["Custom"], "load_menu_custom_open"),
            ("Advanced", self.config_files_by_category["Advanced"], "load_menu_advanced_open")
        ]

        for category_name, category_files, pref_attr in categories:
            if len(category_files) == 0:
                continue  # Skip empty categories

            # Set collapse state from preferences
            imgui.set_next_item_open(getattr(self.state.preferences, pref_attr))
            category_open = imgui.collapsing_header(category_name)

            # Update preference to match actual header state (handles user clicks)
            if imgui.is_item_toggled_open():
                setattr(self.state.preferences, pref_attr, category_open)

            if category_open:
                # Render configs in this category
                for filename in category_files:
                    # Use category-qualified key for cached_configs lookup
                    cache_key = f"{category_name}/{filename}"

                    # Selectable for filename with calculated width
                    # Use ##category suffix to ensure unique IDs even with duplicate filenames
                    clicked, _ = imgui.selectable(
                        f"{filename}##{category_name}", False,
                        imgui.SelectableFlags_.no_auto_close_popups,
                        imgui.ImVec2(max_text_width + 10, 0)
                    )

                    # Check if filename is hovered
                    if imgui.is_item_hovered():
                        hovered_this_frame = (filename, category_name)

                    # N button for notes indicator (between filename and X button)
                    imgui.same_line()
                    config = self.cached_configs.get(cache_key)
                    has_notes = config is not None and config.notes and config.notes.strip()

                    if has_notes:
                        # Lit blue when notes exist
                        imgui.push_style_color(imgui.Col_.button, imgui.ImVec4(0.2, 0.4, 0.8, 1.0))
                        imgui.push_style_color(imgui.Col_.button_hovered, imgui.ImVec4(0.3, 0.5, 0.9, 1.0))
                    else:
                        # Dull gray when no notes
                        imgui.push_style_color(imgui.Col_.button, imgui.ImVec4(0.3, 0.3, 0.3, 0.5))
                        imgui.push_style_color(imgui.Col_.button_hovered, imgui.ImVec4(0.3, 0.3, 0.3, 0.5))

                    imgui.small_button(f"N##{category_name}_{filename}_notes")

                    # Show tooltip with notes content if notes exist, or hint if no notes
                    if imgui.is_item_hovered():
                        if has_notes:
                            # Wrap notes at ~50 characters for readable tooltip
                            import textwrap
                            wrapped = textwrap.fill(config.notes, width=50)
                            imgui.set_tooltip(wrapped)
                        else:
                            imgui.set_tooltip("N will be highlighted if there are any notes to display here")

                    imgui.pop_style_color(2)

                    # Also check hover on N button for preview
                    if imgui.is_item_hovered():
                        hovered_this_frame = (filename, category_name)

                    # X button on same line (after the N button)
                    imgui.same_line()
                    imgui.push_style_color(imgui.Col_.button, imgui.ImVec4(0.8, 0.2, 0.2, 1.0))
                    imgui.push_style_color(imgui.Col_.button_hovered, imgui.ImVec4(1.0, 0.3, 0.3, 1.0))
                    if imgui.small_button(f"X##{category_name}_{filename}"):
                        self.delete_confirm_filename = filename
                        self.delete_confirm_category = category_name
                    imgui.pop_style_color(2)

                    # Also check hover on X button for preview
                    if imgui.is_item_hovered():
                        hovered_this_frame = (filename, category_name)

                    if clicked:
                        # Multi-load mode: add to service directly without closing menu
                        if self.state.multi_load.multi_load_enabled:
                            # Get config from cache or load it
                            if cache_key in self.cached_configs:
                                config = self.cached_configs[cache_key]
                                if self.multi_load_service:
                                    success = self.multi_load_service.add_config(config, filename)
                                    if success:
                                        print(f"Config added to multi-load: {filename}")
                                    else:
                                        print(f"Failed to add config: multi-load list is full ({self.multi_load_service.get_config_count()}/64)")
                        # Normal mode: finalize selection (closes menu)
                        else:
                            self._load_filename = filename
                            self._load_category = category_name
                            self._request_load_file = True
                            self._load_watercolor_override = menu_watercolor_mode
                            self.currently_open_project = filename
                            # Clear everything to prevent hover code from re-applying
                            self.cached_config = None
                            self.cached_configs = {}
                            self.currently_previewing = None
                            self.currently_previewing_category = None
                            self.preview_rule_pushed = False
                            # Clear cached field strengths so menu-close doesn't overwrite
                            self._cached_field_strengths = None
                            imgui.close_current_popup()

        return hovered_this_frame
