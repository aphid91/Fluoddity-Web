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
  /**
   * Auto-calibrate Physics Rate, and report on a run in flight.
   *
   * Supplied by the panel rather than reached for, the same shape as
   * `PanelOptions.recording`: the run has to be driven from the FRAME LOOP -- it
   * measures real frames as they arrive -- and a section has no access to that.
   * `main.ts` owns the loop, the panel owns the button, and this is the seam.
   *
   * Absent where there is nothing to drive (the DOM tests, which build a panel
   * with no frame loop behind it), in which case the button is not built at all
   * rather than built and inert.
   */
  readonly calibrateRate?: {
    /** Begin a run. No-op if one is already going. */
    readonly start: () => void;
    /** Abandon a run, restoring the rate it started from. */
    readonly cancel: () => void;
    /** The label for the button right now -- see `Panel.rateCalibrationLabel`. */
    readonly label: () => string;
    /** Whether a run is in flight, so the button can offer to cancel. */
    readonly running: () => boolean;
  };
  /**
   * Write the strong-logging archive to a file.
   *
   * OPTIONAL, and supplied the same way `calibrateRate` is and for the same
   * reason: it needs something a section cannot reach -- here the Orchestrator's
   * database rather than the frame loop. Absent in the DOM tests, where the
   * button is not built at all rather than built and inert.
   */
  readonly downloadArchive?: () => Promise<void>;
  /**
   * Ask to discard every archived state.
   *
   * **OPENS A CONFIRMATION, and does not itself destroy anything** -- which is
   * why it is synchronous where `downloadArchive` is not. A section builds a
   * button; what a destructive one costs the user is the dialog's business.
   */
  readonly clearArchive?: () => void;
  /**
   * Report that the Brush Size slider is or is not being dragged.
   *
   * Drives the centred reticle -- see `Orchestrator.setBrushSizePreview`. A
   * callback rather than a command for that method's reason: it says what the
   * EDITOR is showing, and a command would put a transient hover state into
   * history.
   *
   * Optional like `calibrateRate` and `downloadArchive` above, and absent in
   * the DOM tests, where the slider then simply drives no overlay rather than
   * reaching for an orchestrator that is not there.
   */
  readonly setBrushSizePreview?: (previewing: boolean) => void;
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
  /**
   * Release anything that outlives the folder, if the section has any.
   *
   * OPTIONAL, because almost nothing does. A section's blades and listeners
   * belong to the `FolderApi` it built into, and disposing the pane takes them
   * all -- which is why this did not exist until a section needed a listener
   * somewhere else. Recording Controls is that section: it watches the WINDOW
   * for the end of a slider drag (`commitSteps`), and the pane cannot reclaim
   * that.
   *
   * The panel rebuilds its sections on every tier toggle and every Export Video
   * toggle, so a section that skips this leaks one listener set per rebuild.
   */
  dispose?(): void;
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
