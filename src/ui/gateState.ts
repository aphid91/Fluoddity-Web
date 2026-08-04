/**
 * Session state for the self-hiding controls.
 *
 * The port of `GateState` (`ui/gated_controls.py:98-140`). Two sets and an
 * identity, all **session-only and deliberately unsaved** -- a config with no
 * gravity in it should open with the box unticked, which is exactly what
 * deriving the state from the values gives you for free.
 *
 * ## The two sets answer different questions
 *
 * `forced` is 10c's, and it exists because a GATES checkbox stores nothing. Its
 * ticked state is derived from the fields it gates -- so ticking it, which
 * reveals sliders that are all still zero, would derive as "off" again on the
 * very next frame and the box would spring back under the cursor. `forced` holds
 * it open until the values speak for themselves.
 *
 * `sessions` is 10d's, and it holds a GATED slider on screen while a gesture is
 * in flight. Its value passes through the off zone during a drag -- drag to the
 * bottom and it is at zero long before you let go -- and folding the control
 * away at that moment would destroy the gesture that produced it.
 *
 * Both are here rather than in two files because `sync` retires them together
 * and for the same reason: a project or config change means the values came from
 * a LOAD rather than from the user, and whatever was loaded should speak for
 * itself.
 *
 * ## Keys are strings, not tuples
 *
 * The desktop keys `sessions` by `(source, field)` because a field name alone is
 * not unique across the three sources. JS has no tuple keys, so the pair is
 * flattened to `"source.field"` -- the same string `settingKey` builds for the
 * DOM hook, deliberately, so a session key and a `data-setting` attribute cannot
 * drift apart.
 */

import { type Setting, SETTINGS } from './settingsSpec.ts';

/** What the identity check compares. A change means "the values were loaded". */
export interface GateIdentity {
  readonly projectName: string;
  readonly selectedConfig: number;
}

export class GateState {
  /**
   * `source.field` of GATED sliders with a gesture in flight.
   *
   * Such a slider stays on screen whatever its value does, and this is the only
   * thing keeping it there once the value reaches base.
   */
  readonly sessions = new Set<string>();

  /**
   * LABELS of GATES checkboxes ticked while everything they gate is still zero.
   *
   * Labels rather than fields because a GATES entry has no field -- its label is
   * its identity, and is what `revealsOn` names it by.
   */
  readonly forced = new Set<string>();

  /**
   * LABELS of gates held open by a gesture on one of their members.
   *
   * **Separate from `forced` because it must survive `sync`.** A forced gate is
   * retired the moment its values go non-zero -- that is the whole point, the
   * derivation has taken over. A HELD gate must not be, because the reason it is
   * held is that the values are about to lie: a bipolar slider passes through
   * exactly zero between real values, and `gateOpen`'s deliberate `!== 0` test
   * reads that instant as "off".
   *
   * Retiring the hold on the frame the value went non-zero would therefore leave
   * nothing holding the gate at the moment it crosses back through zero, which
   * is exactly the bug: the box unticks mid-drag and takes the slider with it.
   *
   * Released by the gesture that opened it (`pointerup`/`lostpointercapture` in
   * `addDirect`), and by a project change like everything else here.
   */
  readonly held = new Set<string>();

  /** The identity the above belong to. `null` until the first `sync`. */
  private identity: GateIdentity | null = null;

  /** Drop everything -- nothing on screen, so no gesture can be live. */
  clear(): void {
    this.sessions.clear();
    this.forced.clear();
    this.held.clear();
  }

  /**
   * Retire state that no longer applies. Once per frame.
   *
   * A forced gate is redundant the moment its values go non-zero (the derivation
   * says "open" on its own), and everything is dropped when the project or
   * selected config changes -- that is the "value set outside of user
   * interaction" case.
   *
   * `gateIsOpen` is passed in rather than reached for, so this stays testable
   * without a Status or a payload.
   */
  sync(identity: GateIdentity, gateIsOpen: (gate: Setting) => boolean): void {
    if (
      this.identity === null ||
      this.identity.projectName !== identity.projectName ||
      this.identity.selectedConfig !== identity.selectedConfig
    ) {
      this.identity = identity;
      this.clear();
      return;
    }
    for (const label of [...this.forced]) {
      const gate = gateByLabel(label);
      if (gate === null || gateIsOpen(gate)) this.forced.delete(label);
    }
    // `held` is deliberately NOT retired here -- see its declaration. It is
    // released by the gesture that took it, and by the `clear()` above.
  }
}

/**
 * The GATES checkbox named by `label`, or `null` if it is a real bool field.
 *
 * This is the disambiguation `revealsOn` needs: it names EITHER a real BOOL
 * field on the same source (`bloomEnabled`) or the LABEL of a gate entry
 * (`Gravity`). Trying the label first and falling through is the desktop's
 * order (`settings_window.py:271-274`), and it is the right way round because a
 * gate's label is a display string that could in principle collide with a field
 * name, while the reverse cannot happen.
 */
export function gateByLabel(label: string): Setting | null {
  if (label === '') return null;
  return SETTINGS.find((s) => s.gates.length > 0 && s.label === label) ?? null;
}

/**
 * The registry entry owning `field` on `source`, or `null`.
 *
 * Keyed on both halves because a field name alone is not unique across the three
 * sources (`gated_controls.py:152-161`).
 */
export function settingFor(source: string, field: string): Setting | null {
  return SETTINGS.find((s) => s.source === source && s.field === field) ?? null;
}
