/**
 * What every panel section is, and what it is handed.
 *
 * ## The shape, and why it is this one
 *
 * `ARCHITECTURE.md`'s "Toolbar and the planned side-panel" asks for exactly one
 * property: "keep each `_*_window()` body as a panel-*section* function, and
 * have the panel call the sections the current tool asks for. Nothing in the
 * current design should assume a window owns its own `imgui.begin`/`end`
 * forever."
 *
 * So a section is a function that takes a `FolderApi` someone else created and
 * builds into it. It never creates its own container, never positions itself,
 * and never decides whether it should exist -- `panelModel.sectionsFor` decides
 * that. A section that obeyed those rules on the desktop would have been a
 * one-line migration; these are written that way from the start.
 *
 * `build` returns a `SectionHandle` rather than nothing, because the frame loop
 * needs a per-section `refresh` and the panel needs the section's control
 * bindings to apply visibility to (10c).
 */

import type { FolderApi } from 'tweakpane';
import type { Command, Status } from '../../orchestrator/commands.ts';
import type { ControlBinding } from '../controls.ts';

/** What a section needs from its host. */
export interface SectionContext {
  readonly send: (command: Command) => void;
  /** See `ControlContext.isRefreshing`. */
  readonly isRefreshing: () => boolean;
  /** Whether ADVANCED-tier settings are shown. */
  readonly advanced: boolean;
  /** Ask the panel to rebuild itself. Used by the tier toggle. */
  readonly requestRebuild: () => void;
}

/** One built section. */
export interface SectionHandle {
  /**
   * The registry-driven controls this section built.
   *
   * Empty for sections that render no `Setting` (Transport, Debug). The panel
   * collects these across sections so 10c can resolve reveals across the whole
   * registry rather than per folder -- `bloomEnabled` and its three children
   * happen to share a folder, but nothing in the registry requires that.
   */
  readonly bindings: readonly ControlBinding[];
  /** Push this frame's status into whatever the section shows. */
  refresh(status: Status): void;
}

/** A section builder. */
export type SectionBuilder = (
  folder: FolderApi,
  status: Status,
  ctx: SectionContext,
) => SectionHandle;

/** A section that shows nothing of its own beyond its controls. */
export function bindingsOnly(bindings: readonly ControlBinding[]): SectionHandle {
  return {
    bindings,
    refresh: (status) => {
      for (const binding of bindings) binding.refresh(status);
    },
  };
}
