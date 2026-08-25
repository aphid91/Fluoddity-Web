/**
 * The per-panel Advanced checkbox.
 *
 * ## Three bifurcations, not one
 *
 * There used to be a single global Basic/Advanced tier, living in an "Editor"
 * sub-folder inside Preferences and governing every section at once. That is a
 * coarser instrument than it looks: wanting the advanced brush controls also
 * unfolded every advanced physics slider, and the two have nothing to do with
 * each other. Each panel now carries its own checkbox at the very top, above
 * the groups it governs, and answers only for itself.
 *
 * ## Why this is not a registry entry
 *
 * The same reason the old one was not: it configures the INTERFACE, not the
 * simulation. A `settingsSpec` entry would also render it as an ordinary row
 * INSIDE a group, and the whole point is that it sits above them -- a control
 * that governs the list cannot be an item in the list.
 *
 * ## Why it dispatches rather than setting a field
 *
 * The tier is a `Preferences` field now (it persists), and preferences live
 * behind the command bus like everything else the panel does not own. So this
 * sends `editViewPref` and lets the value come back through `status`, exactly
 * as a slider does -- the panel never holds a second copy of it.
 */

import type { FolderApi } from 'tweakpane';
import type { ViewPrefField } from '../orchestrator/commands.ts';
import type { ControlContext } from './controls.ts';
import type { SectionContext } from './sections/section.ts';

/**
 * The subset of `ViewPrefField` this file builds a checkbox for.
 *
 * **NARROWER THAN `ViewPrefField`, deliberately.** That set is every persisted
 * boolean that configures the interface, and not all of them are Advanced tiers
 * -- `physicsSliderOpen` is toggled by the rabbit button in `physicsSlider.ts`
 * and has no blade here at all. Keying `HELP` to the full set would demand help
 * text for a checkbox that does not exist, and taking the full set as the
 * parameter type would let a caller ask for one to be built.
 *
 * Derived by exclusion rather than listed, so a fourth tier is picked up
 * automatically while a non-tier member still has to be named here.
 */
type AdvancedField = Exclude<ViewPrefField, 'physicsSliderOpen'>;

/** Help text per panel, so each checkbox says what it actually reveals. */
const HELP: Record<AdvancedField, string> = {
  advancedProject: 'Show/Hide the advanced project settings',
  advancedPreferences: 'Show/Hide the advanced preferences settings',
  advancedDrawing: 'Show/Hide the advanced drawing controls settings',
};

/**
 * Add an Advanced checkbox as the first blade in `folder`.
 *
 * Call it BEFORE building the folder's groups: Tweakpane appends, so build
 * order is display order, and this has to come out on top.
 */
export function addAdvancedToggle(
  folder: FolderApi,
  field: AdvancedField,
  ctx: SectionContext,
): void {
  // Seeded from the live status rather than from a captured value: the panel is
  // rebuilt when this changes, and the rebuild reads the value that caused it.
  const view = { advanced: advancedValue(ctx, field) };

  const blade = folder.addBinding(view, 'advanced', { label: 'Advanced' });
  (blade.element as HTMLElement).dataset['setting'] = `view.${field}`;
  ctx.tooltip.attach(blade.element as HTMLElement, {
    title: 'Advanced',
    body: HELP[field],
  });

  blade.on('change', (ev) => {
    // A programmatic refresh must not read as the user asking for a different
    // tier -- that would dispatch, and therefore rebuild, every frame.
    if (ctx.isRefreshing()) return;
    const next = ev.value;
    if (next === advancedValue(ctx, field)) return;

    // BOTH, and in this order. The dispatch changes what the tier IS; the
    // rebuild changes which controls EXIST to reflect it -- and a tier is the
    // one thing `refresh()` cannot express, because per-frame refresh only ever
    // writes values into blades that are already built.
    //
    // Dispatching without rebuilding is a silent no-op that looks like a dead
    // checkbox: the preference flips and persists, and the panel goes on showing
    // the tier it was built with until something else happens to rebuild it.
    ctx.send({ kind: 'editViewPref', field, value: next });
    ctx.requestRebuild();
  });
}

/**
 * The current value of one tier flag, from the live status.
 *
 * The NAMED `Status` field, not `editPrefs[field]`: that payload is empty
 * whenever no panel is open, and these three decide what the panel builds
 * rather than what a control displays. See the `Status` field comments.
 */
export function advancedValue(ctx: ControlContext, field: ViewPrefField): boolean {
  return ctx.status()[field];
}
