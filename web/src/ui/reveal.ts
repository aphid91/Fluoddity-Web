/**
 * Which controls are on screen: `revealsOn`, and the GATES checkbox.
 *
 * The port of `settings_window.py:_revealed` / `_gate_checked` / `_gate_open` /
 * `_clear_gated` (`:258-296`).
 *
 * ## Why controls are HIDDEN rather than greyed
 *
 * "Effects like bloom carry three or four parameters that are meaningless when
 * the effect is switched off, and showing them anyway is how a preferences panel
 * turns into a wall" (`settings_spec.py:43-48`). Greying them out keeps the wall
 * and adds noise; hiding them is the point.
 *
 * ## `revealsOn` names two different things, and both are real
 *
 * Six entries use it, split between the two forms:
 *
 *   `bloomThreshold/Intensity/Radius` -> `'bloomEnabled'`   a real BOOL field
 *   `gravityStrafe/Force`, `radialGravity` -> `'Gravity'`   a GATES entry's LABEL
 *
 * The second form exists because the Gravity checkbox **owns no field**: it
 * stores nothing and reads as ticked whenever either gravity value is non-zero.
 * So its members cannot name a field, and name its label instead.
 *
 * **Resolved eagerly, at module load.** That buys a guarantee a lazy lookup
 * cannot: `reveal.test.ts` asserts that every non-empty `revealsOn` resolves to
 * one arm or the other, so a typo is a test failure rather than a control that
 * renders once, never appears, and is never noticed. It is the same class of
 * protection `settingsSpec.test.ts` already gives `field`.
 *
 * ## Why the gravity sliders are a GATES checkbox and not two GATED ones
 *
 * They are **bipolar**: they pass through zero on the way between real values.
 * A self-hiding slider would fold itself away mid-drag every time the user
 * crossed zero (`settings_spec.py:262`). Hence a plain gate in front of them,
 * and hence `gateOpen`'s exact `!== 0` test -- a tolerance there would collapse
 * the control around a deliberate hair's-breadth setting.
 */

import { type Setting, SETTINGS, type Source } from './settingsSpec.ts';
import { GateState, gateByLabel, settingFor } from './gateState.ts';

/** What a control's `revealsOn` turned out to mean. */
export type Reveal =
  | { readonly kind: 'none' }
  | { readonly kind: 'gate'; readonly gate: Setting }
  | { readonly kind: 'field'; readonly field: string };

const NONE: Reveal = { kind: 'none' };

/**
 * Every entry's reveal, resolved once.
 *
 * A `Map` keyed by the `Setting` object itself: the registry is frozen module
 * state, so object identity is stable and there is no need to key by a string
 * that could collide across sources.
 */
const RESOLVED: ReadonlyMap<Setting, Reveal> = new Map(
  SETTINGS.map((setting) => [setting, resolve(setting)] as const),
);

function resolve(setting: Setting): Reveal {
  if (setting.revealsOn === '') return NONE;
  const gate = gateByLabel(setting.revealsOn);
  if (gate !== null) return { kind: 'gate', gate };
  return { kind: 'field', field: setting.revealsOn };
}

/** What `setting` hangs off, if anything. */
export function revealOf(setting: Setting): Reveal {
  return RESOLVED.get(setting) ?? resolve(setting);
}

/** The values a source currently holds, as the panel sees them. */
export type SourceValues = (source: Source) => Readonly<Record<string, number | boolean>>;

/**
 * Whether a GATES checkbox reads as ticked: derived, or forced open.
 *
 * The forced half is not optional. Ticking the box is exactly the case where
 * every field it gates is still zero, so the raw derivation would say "off" on
 * the next frame and the box would spring back under the cursor.
 */
export function gateChecked(
  gate: Setting,
  values: SourceValues,
  state: GateState,
): boolean {
  return gateOpen(gate, values) || state.forced.has(gate.label);
}

/**
 * Whether any field a GATES checkbox covers is non-zero.
 *
 * **EXACTLY zero, deliberately** -- see the file header on bipolar sliders.
 */
export function gateOpen(gate: Setting, values: SourceValues): boolean {
  const source = values(gate.source);
  return gate.gates.some((field) => numeric(source[field]) !== 0);
}

/**
 * Whether a control's governing checkbox is on.
 *
 * **A missing governing value counts as OFF.** The settings payload is only
 * built while the panel is open (`settingsSources`'s optimization), so revealing
 * controls against a value we cannot see would be worse than hiding them
 * (`settings_window.py:261-263`).
 */
export function isRevealed(
  setting: Setting,
  values: SourceValues,
  state: GateState,
): boolean {
  const reveal = revealOf(setting);
  switch (reveal.kind) {
    case 'none':
      return true;
    case 'gate':
      // Asked the same question the box itself answers, overrides included --
      // otherwise ticking Gravity would leave a ticked box with nothing under it.
      return gateChecked(reveal.gate, values, state);
    case 'field':
      return Boolean(values(setting.source)[reveal.field]);
    default: {
      const unreachable: never = reveal;
      throw new Error(`Unhandled reveal ${String(unreachable)}`);
    }
  }
}

/**
 * The settings a GATES checkbox should zero when it is unticked.
 *
 * Only the ones that are actually non-zero, so unticking an already-empty gate
 * dispatches nothing and cannot record a history entry. **Unticking must zero
 * them**: a hidden slider still pulling every particle down is the worst outcome
 * a checkbox could have (`gated_controls.py:169-171`).
 */
export function fieldsToClear(gate: Setting, values: SourceValues): readonly Setting[] {
  const source = values(gate.source);
  const out: Setting[] = [];
  for (const field of gate.gates) {
    if (numeric(source[field]) === 0) continue;
    const member = settingFor(gate.source, field);
    if (member !== null) out.push(member);
  }
  return out;
}

/** Every GATES entry in the registry. */
export function gateSettings(): readonly Setting[] {
  return SETTINGS.filter((s) => s.gates.length > 0);
}

function numeric(value: number | boolean | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return 0;
}
