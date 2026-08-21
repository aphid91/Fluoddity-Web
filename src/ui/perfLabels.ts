/**
 * Tint the labels of the three settings that decide the frame rate.
 *
 * World Size, Physics Rate and Motion Blur carry the same colour the FPS button
 * is showing, so the badge and the controls that cause it read as one statement:
 * a blue counter and three blue labels say "these are the knobs you have room to
 * turn up", without a sentence anywhere.
 *
 * ## Why the label and not the whole row
 *
 * The colour is a HINT about a control, not a state OF one. Tinting the slider
 * track or the value box would collide with the vocabulary Tweakpane already
 * uses for disabled and active, and -- for Motion Blur -- with the gated
 * checkbox that shares the row. The label is the one part of a blade that is
 * purely nominative, so recolouring it adds a signal instead of overloading one.
 *
 * **The Motion Blur CHECKBOX is deliberately left alone**, as asked. A gated
 * control owns two blades (`controls.ts`), and only the slider half is a
 * performance knob -- the checkbox is the on/off, and at one sample blur is off
 * and costs nothing. Tinting it would mark a control that is not currently
 * spending anything.
 *
 * ## Why `data-setting` rather than a class or a handle
 *
 * `controls.ts` stamps `data-setting="${source}.${field}"` on every blade for
 * exactly this reason: Tweakpane's own class names are minified, so a selector
 * built on them is a guess against a build artifact that breaks on a dependency
 * bump rather than on a real regression. Querying the stable attribute is what
 * every check in `tools/` already does.
 *
 * The label INSIDE a blade still has to be found by structure, since it carries
 * no hook of its own -- `labelOf` is where that risk is contained, and it fails
 * soft: no label found means no tint, never a crash.
 */

import { type Band, BAND_LABEL_COLOR } from '../perf/fpsBand.ts';

/**
 * The three controls, by their `data-setting` key.
 *
 * All three are `PREFS` fields. Written as literals rather than derived from the
 * registry because the SELECTION is a judgement -- these are the three the brief
 * names as performance-critical -- and a derived list would silently grow if
 * another expensive preference were added later without anyone deciding it
 * should be tinted.
 */
const TINTED: readonly string[] = Object.freeze([
  'prefs.worldSize',
  'prefs.physicsSteps',
  'prefs.motionBlurSamples',
]);

/**
 * The label colour a blade reverts to when the tint is off.
 *
 * Tweakpane's own label colour, restated rather than read: the tint is applied
 * as an inline style, so removing it means assigning something, and `''` would
 * fall back to a stylesheet this app does not have. Matches the `#e8e8ea` the
 * rest of the chrome uses at the alpha Tweakpane renders labels at.
 */
const IDLE_LABEL = 'rgba(232,232,234,0.7)';

/**
 * Paint the three labels for `band`, or clear the tint when `enabled` is false.
 *
 * Called once per frame from `Panel.refresh` and guarded on an actual change by
 * the caller, so the common frame does no DOM work at all.
 *
 * **Re-queried each time rather than cached.** A tier toggle or an Export Video
 * tick rebuilds both panes and replaces every element (`Panel.rebuild`), so a
 * held reference would point at a detached node and the tint would silently stop
 * applying. The query is three `querySelector` calls on a rebuild-rare path.
 *
 * `root` is the element to search within -- the panel container -- so this never
 * reaches across the whole document for elements that might belong to something
 * else.
 */
export function paintPerfLabels(
  root: ParentNode,
  band: Band,
  enabled: boolean,
): void {
  // `BAND_LABEL_COLOR`, NOT the badge's pale ramp: a label sits beside a column
  // of other labels in a light grey, and the pale colours are too close to that
  // grey to read as marked. See that constant for the full reasoning.
  const color = enabled ? BAND_LABEL_COLOR[band] : IDLE_LABEL;
  for (const key of TINTED) {
    // Every blade carrying this key. Motion Blur is GATED and so owns two --
    // a checkbox and a slider, both tagged identically by `tagBlade` -- and
    // `labelOf` is what keeps the checkbox out of it.
    for (const blade of root.querySelectorAll(`[data-setting="${key}"]`)) {
      const label = labelOf(blade, key);
      if (label !== null) label.style.color = color;
    }
  }
}

/**
 * The label element inside one blade, or null if this blade should not be
 * tinted.
 *
 * ## The Motion Blur exclusion lives here
 *
 * A gated control's two blades carry the SAME `data-setting`, so the query above
 * cannot tell them apart -- and only the slider half should be tinted. A blade
 * whose input is a checkbox is the on/off, and it is filtered out here rather
 * than at the call site so the rule sits next to the reason for it.
 *
 * ## Finding the label without a hook
 *
 * A blade is `<div class="tp-lblv"><div class="tp-lblv_l">Label</div><div
 * class="tp-lblv_v">…widget…</div></div>` -- so the label is a DIRECT CHILD of
 * the blade, beside the value cell, not nested inside a row of its own.
 *
 * **An earlier version assumed a wrapping row** (`blade.firstElementChild` as
 * the row, then a walk over ITS children) and found nothing at all: the first
 * child IS the label, and it has no element children to walk. The tint silently
 * never applied -- which is exactly the fail-soft this function promises, and
 * exactly why it needed a browser assertion rather than a unit test.
 *
 * So the walk is over the BLADE's own children, taking the first that holds no
 * form control and does have text. Class names are deliberately not matched on:
 * `controls.ts` explains at length why the tooling avoids minified Tweakpane
 * names, and structure plus "contains no control" is the stable version of the
 * same question.
 *
 * Fails soft by design. A Tweakpane internals change makes this return null,
 * which costs the tint and nothing else -- the same degradation `addMapped`
 * accepts when it cannot find a slider's number box.
 */
function labelOf(blade: Element, key: string): HTMLElement | null {
  // The gated checkbox: excluded, deliberately. See above.
  if (key === 'prefs.motionBlurSamples') {
    const input = blade.querySelector('input');
    if (input !== null && input.type === 'checkbox') return null;
  }

  for (const cell of blade.children) {
    if (!(cell instanceof HTMLElement)) continue;
    // The value cell, which holds the widget. Skipped so the tint lands on the
    // name rather than on the number beside it.
    if (cell.querySelector('input,select,button') !== null) continue;
    // A cell with no text is a spacer, not a label -- tinting it would be
    // invisible and would leave the real label untouched.
    if ((cell.textContent ?? '').trim() === '') continue;
    return cell;
  }
  return null;
}
