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
import type { Status, ViewPrefField } from '../../orchestrator/commands.ts';
import type { ControlBinding, ControlContext } from '../controls.ts';
import type { InputState } from '../inputState.ts';

/**
 * What a section needs from its host.
 *
 * Extends `ControlContext` rather than restating it, so a section can hand
 * itself straight to `addControl` -- and so a new control-level dependency
 * reaches every section without threading a parameter through each one.
 */
export interface SectionContext extends ControlContext {
  /**
   * Whether ADVANCED-tier settings are shown IN THIS PANEL.
   *
   * Baked in per panel by `Panel.context`, which is what makes the three
   * Advanced checkboxes independent: a section reads this exactly as it did
   * when there was one global tier, and cannot see another panel's answer.
   */
  readonly advanced: boolean;
  /**
   * Another panel's tier, by name.
   *
   * The escape hatch for the one case `advanced` cannot serve: the right panel
   * is a single section list holding TWO tabs with two tiers, so its Drawing
   * tab asks for `advancedDrawing` by name rather than taking the baked-in
   * Preferences value. Nothing else should need this -- if a second caller
   * appears, the per-panel baking is the thing that is wrong.
   */
  readonly advancedFor: (field: ViewPrefField) => boolean;
  /** Ask the panel to rebuild itself. Used by the tier toggles. */
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
  /**
   * Push this frame's state into whatever the section shows.
   *
   * `input` is here for the Debug section alone, and is a plain frozen value
   * type rather than anything that leads to simulation state -- the same
   * precedent `PickResult` sets on `Status` (`commands.ts:200-203`). Every other
   * section ignores it.
   */
  refresh(status: Status, input: InputState): void;
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
