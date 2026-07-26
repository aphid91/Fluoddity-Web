"""Project: the state the save/load system stores and restores.

WHY THIS TYPE EXISTS

A project is what a save file contains, and its parts must always move
together:

    configs          the ConfigBuffer contents
    world            settings shared by every particle (trail decay)
    name             what the file is called
    selected_config  which config the Project window is editing

Before this type, they were separate attributes on the Orchestrator, and every
operation that touched the buffer had to remember all three:

    self.system.apply_configs(new_configs)
    self.project_name = wherever_they_came_from
    self.selected_config = min(self.selected_config, len(configs) - 1)

That triple appeared at seventeen call sites. Missing the clamp gives an
index past the end of the buffer; missing the rename leaves the window titled
after a project that is no longer loaded. Exactly that bug shipped once: the
clipboard restored configs without restoring the name.

Making it a value type moves those invariants into one place. A Project is
immutable -- every operation returns a new one -- so snapshotting for undo or
hover-preview is just holding a reference, with no risk that the thing you
captured mutates underneath you. That is what the coming history/undo system
needs.

WHAT IS *NOT* HERE
  - GPU state. A Project is plain data; ParticleSystem uploads it.
  - Preferences. Editor state is deliberately separate (see preferences/).
  - Camera. Saved alongside a project, but not part of one -- loading a v7
    file leaves the camera alone.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field, replace

from particle_system.config import SimulationConfig, WorldSettings

#: Name used before anything has been saved or loaded.
UNTITLED = "Untitled"


@dataclass(frozen=True)
class Project:
    """An immutable snapshot of everything a save file contains, plus which
    config is being edited."""

    configs: tuple[SimulationConfig, ...] = ()
    world: WorldSettings = field(default_factory=WorldSettings)
    name: str = UNTITLED
    selected: int = 0

    def __post_init__(self):
        # A project always has at least one config, and `selected` always
        # points at a real one. Enforcing it here means no caller has to.
        if not self.configs:
            raise ValueError("a Project must contain at least one config")
        clamped = max(0, min(self.selected, len(self.configs) - 1))
        if clamped != self.selected:
            object.__setattr__(self, 'selected', clamped)

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------

    @property
    def config(self) -> SimulationConfig:
        """The config currently being edited."""
        return self.configs[self.selected]

    @property
    def count(self) -> int:
        return len(self.configs)

    def world_for_upload(self, sqrt_world_size: float):
        """The GPU-facing WorldData: saved settings + runtime sizing."""
        return self.world.for_upload(sqrt_world_size, len(self.configs))

    # ------------------------------------------------------------------
    # Writes -- each returns a NEW Project
    # ------------------------------------------------------------------

    def with_configs(self, configs, name=None, world=None) -> "Project":
        """Replace the buffer, and optionally the world settings.

        `selected` is re-clamped automatically. This is the operation that used
        to need three hand-written lines.
        """
        return Project(configs=tuple(configs),
                       world=self.world if world is None else world,
                       name=self.name if name is None else name,
                       selected=self.selected)

    def renamed(self, name: str) -> "Project":
        return replace(self, name=name)

    def selecting(self, index: int) -> "Project":
        return replace(self, selected=index)

    def edited(self, index: int, field_name: str, value) -> "Project":
        """Change one field of one config."""
        if not (0 <= index < len(self.configs)):
            return self
        if not hasattr(self.configs[index], field_name):
            return self
        updated = list(self.configs)
        updated[index] = dataclasses.replace(updated[index],
                                             **{field_name: value})
        return replace(self, configs=tuple(updated))

    def edit_selected(self, field_name: str, value) -> "Project":
        return self.edited(self.selected, field_name, value)

    def adopt_rule(self, rule) -> "Project":
        """Make `rule` the selected config's base rule.

        What particle selection does: the picked particle's mutated rule
        becomes the rule the whole population now varies around.

        Only the rule changes. mutation_scale is deliberately left alone, so
        the population re-mutates around the adopted rule rather than locking
        to it -- and undo has exactly one field to restore.
        """
        return self.edit_selected('rule', tuple(rule))

    def edit_world(self, field_name: str, value) -> "Project":
        """Change one world setting.

        A real edit of the project's single WorldSettings -- not, as it once
        was, a disguised edit of config 0.
        """
        if not hasattr(self.world, field_name):
            return self
        return replace(self,
                       world=replace(self.world, **{field_name: value}))

    def appended(self, configs, limit: int):
        """Append configs up to `limit` slots.

        Returns (project, added, rejected) so the caller can report a partial
        append rather than silently dropping entries.
        """
        room = limit - len(self.configs)
        if room <= 0:
            return self, 0, len(configs)
        accepted = list(configs)[:room]
        rejected = len(configs) - len(accepted)
        if not accepted:
            return self, 0, rejected
        grown = replace(self, configs=self.configs + tuple(accepted))
        # Select the first appended config: the user just asked for it.
        return grown.selecting(len(self.configs)), len(accepted), rejected

    def duplicated(self, index: int, limit: int):
        """Append a copy of `index`. Returns (project, ok)."""
        if not (0 <= index < len(self.configs)) or len(self.configs) >= limit:
            return self, False
        grown = replace(self, configs=self.configs + (self.configs[index],))
        return grown.selecting(len(grown.configs) - 1), True

    def removed(self, index: int):
        """Drop a config. Refuses to empty the buffer. Returns (project, ok).

        Entities' config_index is NOT renumbered: the shader clamps, so removal
        degrades gracefully. Reassigning entities belongs with the feature that
        lets a user paint config assignments.
        """
        if len(self.configs) <= 1 or not (0 <= index < len(self.configs)):
            return self, False
        remaining = self.configs[:index] + self.configs[index + 1:]
        return replace(self, configs=remaining), True
