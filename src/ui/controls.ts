/**
 * One registry entry -> one Tweakpane control.
 *
 * The port of `settings_window.py`'s `_render_setting` / `_draw_widget` pair
 * (`:218-346`), which is the desktop's single dispatch point from a `Setting` to
 * a widget. Keeping it single matters for the same reason there: adding a
 * control is a registry entry, and the only place that has to understand a new
 * `kind` is this file.
 *
 * ## The proxy, and why every control needs one
 *
 * **Tweakpane binds to a mutable property**, and the app's state is immutable
 * and lives behind the command bus. So each control gets a one-property object
 * that Tweakpane writes into, and an `on('change')` that turns the write into a
 * command. `refresh()` then pushes the authoritative value back in, which is
 * what makes undo, preset loads and randomize show up in the panel without the
 * panel knowing any of them happened.
 *
 * The alternative -- binding straight to a mutable settings object -- would make
 * the panel a second source of truth, and the first divergence would be silent.
 *
 * ## `data-setting`, and why it is not decoration
 *
 * Every control's blade element carries `data-setting="${source}.${field}"`.
 * Tweakpane's own class names are minified (`cn('sld')` and friends), so without
 * a stable hook every CDP selector in `tools/uiCheck.mjs` would be a guess
 * against a build artifact -- and would break on a dependency bump rather than
 * on a real regression. One attribute at build time makes every later check an
 * exact query. It is also what lets a test assert blade IDENTITY across a
 * visibility toggle, which is how "this did not rebuild" is verified.
 */

// `BladeApi` rather than `BindingApi`, deliberately. `addBinding` returns the
// latter, but it is exported only from `@tweakpane/core` -- a devDependency, and
// reaching into one from app code makes the runtime import graph depend on
// something the package manifest says is build-time only. `BindingApi extends
// BladeApi`, and `BladeApi` carries every member anything here touches
// (`element`, `hidden`, `disabled`), so the base type is both sufficient and the
// one the public entry point actually exports.
import type { BladeApi, FolderApi } from 'tweakpane';
import type { Command, Status } from '../orchestrator/commands.ts';
import {
  type Setting,
  type Source,
  BOOL,
  CHOICE,
  CONFIG,
  GATED,
  GATED_INT,
  INPUT,
  INT,
  PREFS,
  SEED,
  SLIDER,
  WORLD,
} from './settingsSpec.ts';
import { isGated, position, shown, stored, valueAt } from './gating.ts';
import { formatSeed, formatValue, parseInput } from './formatValue.ts';
import { type GateState, gateByLabel } from './gateState.ts';
// A DELIBERATE CYCLE, and a safe one: `gatedControl.ts` imports this file's
// helpers (`currentValues`, `paramsFor`, `tagBlade`) and this file imports its
// builder. Both are function declarations, hoisted and only called after both
// modules have evaluated, so neither reads a half-initialised binding. The
// alternative -- a third module holding the shared helpers -- would split
// `controls.ts` for no reason other than to avoid an edge in the graph.
import { addGatedControl } from './gatedControl.ts';
import { fieldsToClear, gateChecked } from './reveal.ts';
import type { Tooltip } from './tooltip.ts';

/**
 * Which status payload a source's current value comes from.
 *
 * The three payloads are separate because their SAVE semantics differ, not
 * because their contents do -- so reading them is one lookup keyed by source.
 */
export function currentValues(
  status: Status,
  source: Source,
): Readonly<Record<string, number | boolean>> {
  if (source === CONFIG) return status.editConfig;
  if (source === WORLD) return status.editWorld;
  return status.editPrefs;
}

/** The stable DOM hook. Also the session key for gated controls (10d). */
export function settingKey(setting: Setting): string {
  return `${setting.source}.${setting.field}`;
}

/** What a control needs from its host. Passed in rather than reached for. */
export interface ControlContext {
  /** Issue a command. */
  readonly send: (command: Command) => void;
  /**
   * True while `refresh()` is writing authoritative values into the proxies.
   *
   * A function rather than a boolean because the flag flips during the panel's
   * lifetime and a captured copy would be stale forever. See `panel.ts`.
   */
  readonly isRefreshing: () => boolean;
  /** The shared delayed help tooltip. One per panel. */
  readonly tooltip: Tooltip;
  /** Session state for the gates and (10d) the self-hiding sliders. */
  readonly gates: GateState;
  /**
   * This frame's status, for handlers that need it at CLICK time.
   *
   * A handler cannot close over the `status` passed to its builder: that is the
   * value from the frame the panel was constructed on, and by the time anyone
   * clicks it is arbitrarily stale. Everything that reads state during an event
   * goes through here.
   */
  readonly status: () => Status;
  /**
   * Whether this panel was built for touch. Defaults to false.
   *
   * ONE CONTROL READS IT TODAY: `addInput`, where leaving the field commits on
   * touch instead of discarding. See the reasoning there -- a phone's numeric
   * keyboard frequently has no Enter key to commit with, and dismissing the
   * keyboard is not a cancel gesture.
   */
  readonly mobile?: boolean;
}

/**
 * One built control, from the panel's point of view.
 *
 * `refresh` is the only thing the frame loop calls. `blades` exists so later
 * sub-steps can toggle `.hidden` (10c) without this interface growing a method
 * per feature.
 */
export interface ControlBinding {
  readonly setting: Setting;
  /** Every blade this control owns. One today; two for a gated control (10d). */
  readonly blades: readonly BladeApi[];
  /** Push the authoritative value back into the proxy. */
  refresh(status: Status): void;
}

/**
 * Build the control for one registry entry.
 *
 * Every entry now produces something: a GATES entry becomes the derived
 * checkbox, and everything else becomes a widget for its own value.
 */
export function addControl(
  folder: FolderApi,
  setting: Setting,
  status: Status,
  ctx: ControlContext,
): ControlBinding {
  // A GATES entry "is not itself a saved setting" and stores nothing
  // (`settings_spec.py:263`), so it is built from the fields it gates rather
  // than from a value of its own.
  if (setting.gates.length > 0) return addGate(folder, setting, status, ctx);

  if (setting.kind === SEED) return addSeed(folder, setting, status, ctx);
  if (setting.kind === INPUT) return addInput(folder, setting, status, ctx);
  // Before the curve/inverted test: a gated control can be either of those too
  // (Hazard Rate is curved, Trail Stiffness is inverted), and it composes them
  // itself rather than being a special case of `addMapped`.
  if (isGated(setting)) return addGatedControl(folder, setting, status, ctx);
  if (setting.curve !== 1 || setting.inverted) {
    return addMapped(folder, setting, status, ctx);
  }
  return addDirect(folder, setting, status, ctx);
}

/**
 * The GATES checkbox: a control in front of other sliders, storing nothing.
 *
 * The port of `draw_gate` (`gated_controls.py:164-180`). **Ticking writes no
 * flag** -- it just reveals the sliders, which are already at zero, and
 * `GateState.forced` holds the box open until they are given a value.
 * **Unticking zeroes them**, because a hidden slider still pulling every
 * particle down is the worst outcome a checkbox could have.
 *
 * The checked state is derived every frame from those same values, which is what
 * makes save, load, undo and A/B preview all work with no knowledge that any of
 * this exists -- nothing about a gate is stored.
 *
 * ## The clear is ONE undoable step, not two
 *
 * Unticking Gravity can zero both sliders, and the desktop dispatches an
 * `edit_setting` per field -- which on this side would record two history
 * entries for one click, so undo would take two presses to put back what one
 * press removed. The edits share a coalesce key instead, which `History` already
 * merges (`editSetting`'s `record` flag exists for exactly this).
 */
function addGate(
  folder: FolderApi,
  setting: Setting,
  status: Status,
  ctx: ControlContext,
): ControlBinding {
  const values = (source: Source) => currentValues(ctx.status(), source);
  const box = {
    value: gateChecked(setting, (source) => currentValues(status, source), ctx.gates),
  };

  const blade = folder.addBinding(box, 'value', { label: setting.label });
  // A gate has no field, so its DOM hook is its label -- the same identity
  // `revealsOn` names it by.
  (blade.element as HTMLElement).dataset['setting'] = `${setting.source}.gate.${setting.label}`;
  ctx.tooltip.attach(blade.element as HTMLElement, {
    title: setting.label,
    body: setting.help,
  });

  blade.on('change', (ev) => {
    if (ctx.isRefreshing()) return;
    if (ev.value) {
      ctx.gates.forced.add(setting.label);
      return;
    }
    ctx.gates.forced.delete(setting.label);
    const toClear = fieldsToClear(setting, values);
    toClear.forEach((member, index) => {
      ctx.send({
        kind: 'editSetting',
        setting: member,
        value: 0,
        // One act, one undo step: every field in the clear shares the first
        // one's coalesce identity. `record` stays true so the step exists at
        // all; it is the coalescing that merges them.
        record: index === 0 ? true : false,
      });
    });
  });

  return {
    setting,
    blades: [blade],
    refresh: (s) => {
      box.value = gateChecked(setting, (source) => currentValues(s, source), ctx.gates);
    },
  };
}

/**
 * The plain case: the stored value IS what the widget shows and produces.
 *
 * Everything without a `curve` or an `inverted` -- which is 33 of the 35
 * entries, and every BOOL, INT and CHOICE.
 */
function addDirect(
  folder: FolderApi,
  setting: Setting,
  status: Status,
  ctx: ControlContext,
): ControlBinding {
  const proxy = { value: currentValues(status, setting.source)[setting.field] ?? 0 };

  const blade = folder.addBinding(proxy, 'value', {
    label: setting.label,
    ...paramsFor(setting),
  });
  decorate(blade, setting, ctx);

  const holdsGate = holdsGateOpen(setting);

  blade.on('change', (ev) => {
    // Not a user edit: `refresh()` is pushing the authoritative value in. See
    // `panel.ts`'s `refreshing` for what happens without this.
    if (ctx.isRefreshing()) return;

    // Hold the governing gate open for the duration of the drag, and release it
    // at the end. See `holdsGateOpen` -- a bipolar slider passes through EXACTLY
    // zero on its way between real values, and that is the moment the gate would
    // otherwise derive as "off" and hide the slider being dragged.
    //
    // **`ev.last` is the release signal, not `pointerup`.** Tweakpane emits
    // `last: false` from `onPointerMove_` and `last: true` from `onPointerUp_`
    // -- the same discriminator `gatedControl.ts` relies on, and the reason the
    // `isRefreshing()` guard above it must come first. Listening for a DOM
    // `pointerup` on the blade instead looked equivalent and was not: the event
    // fires on the element that captured the pointer, so a release that landed
    // outside the blade never reached the handler and the hold leaked, pinning
    // the gate open with every value at zero.
    //
    // Releasing hands the answer back to the derivation, which is right in both
    // directions: a drag that ended non-zero keeps the gate open on its own, and
    // one that ended at zero means the gate genuinely IS off.
    if (holdsGate) {
      if (ev.last) ctx.gates.held.delete(setting.revealsOn);
      else ctx.gates.held.add(setting.revealsOn);
    }
    ctx.send({ kind: 'editSetting', setting, value: ev.value as number | boolean });
  });

  // The gesture `change` cannot see the end of: one the OS interrupted, and one
  // that finished on the value it started from (`setRawValue` returns early when
  // nothing moved, so no final `last: true` arrives). Either would leak the hold.
  if (holdsGate) {
    const element = blade.element as HTMLElement;
    const release = (): void => {
      ctx.gates.held.delete(setting.revealsOn);
    };
    element.addEventListener('pointerup', release);
    element.addEventListener('lostpointercapture', release);
  }

  return {
    setting,
    blades: [blade],
    refresh: (s) => {
      const values = currentValues(s, setting.source);
      const authoritative = values[setting.field];
      if (authoritative !== undefined) proxy.value = authoritative;
      // A live precondition, re-read every frame -- the same shape as the
      // Randomize button's dependence on Mutation Scale. Only Cohort Fences
      // declares one today; `requires: null` leaves the blade alone, so this
      // costs the other entries nothing.
      if (setting.requires !== null) blade.disabled = !meetsRequirement(setting, values);
    },
  };
}

/** Whether a `requires` precondition currently holds. @see `Setting.requires` */
export function meetsRequirement(
  setting: Setting,
  values: Readonly<Record<string, number | boolean>>,
): boolean {
  if (setting.requires === null) return true;
  const [field, expected] = setting.requires;
  // Compared through `asNumber` so a boolean precondition and a 0/1 payload
  // agree: the settings payload carries CHOICE values as numbers and BOOL
  // values as booleans, and `requires` may name either kind of field.
  return asNumber(values[field]) === asNumber(expected);
}

/**
 * Whether dragging this control must hold its governing gate open.
 *
 * **The bipolar-slider problem, one level up.** `gatedControl.ts` solves it for
 * a slider that hides ITSELF at base; this is the same hazard for a slider
 * hidden by a GATES CHECKBOX in front of it. Gravity (Strafe) and Gravity
 * (Force) run -1..1 and pass through exactly zero between real values, and
 * `gateOpen`'s deliberate `!== 0` test means that instant reads as "every gated
 * field is zero, so the gate is off". Without this the box unticked itself
 * mid-drag and took the slider with it -- which looks like the drag was
 * cancelled, and leaves the value wherever the pointer happened to be.
 *
 * A gate-revealed BOOL (Radial Gravity) does not need it: a checkbox has no
 * intermediate states to pass through.
 *
 * Note this reuses `forced` rather than adding a third set. `forced` already
 * means exactly "hold this gate open even though its values say otherwise",
 * which is the same claim a drag through zero is making.
 */
function holdsGateOpen(setting: Setting): boolean {
  return (
    setting.revealsOn !== '' &&
    setting.kind !== BOOL &&
    gateByLabel(setting.revealsOn) !== null
  );
}

/**
 * A slider whose travel is bent, or whose display is the complement of storage.
 *
 * **The widget is driven in 0..1 POSITION space and the real value is mapped in
 * and out around it**, which is the same trick the desktop plays for the same
 * reason: neither imgui nor Tweakpane has a power-scaled slider
 * (`curved_slider.py:20-26`). The readout carries the real number, formatted at
 * a precision that suits the range -- with a bent handle the position no longer
 * suggests the magnitude, so the number has to be legible.
 *
 * ## The composition, which is where this gets subtle
 *
 * Trail Stiffness is inverted; Hazard Rate is curved. Nothing today is both, but
 * the order still has to be right and stated, because a third entry gaining the
 * other field must not need this reasoning redone:
 *
 *     stored --[shown]--> display --[position]--> handle
 *     handle --[valueAt]--> display --[stored]--> stored
 *
 * `position`/`valueAt` work in DISPLAY space -- they are bounded by `lo`/`hi`,
 * which is what the label promises, not what the field holds. Applying the curve
 * to the stored value instead would bend Trail Stiffness's travel around the
 * wrong end of its range.
 *
 * A second proxy, `readout`, carries the number, because a Tweakpane slider
 * bound to 0..1 would otherwise display "0.46" where the user needs "0.001".
 */
function addMapped(
  folder: FolderApi,
  setting: Setting,
  status: Status,
  ctx: ControlContext,
): ControlBinding {
  const initial = asNumber(currentValues(status, setting.source)[setting.field]);
  const handle = { pos: position(setting, shown(setting, initial)) };
  // **THE READOUT SHOWS DISPLAY SPACE, NOT STORED SPACE**, and that is the whole
  // point of an `inverted` entry: the label says "Trail Stiffness", so the
  // number beside it has to be the stiffness. Printing the stored diffusion
  // there would put a readout of 1.0 under a handle sitting at 0.0 -- the
  // control would look broken while behaving correctly, which is worse than
  // either. The stored value is still what is dispatched and saved; only this
  // string is flipped.
  const readout = { value: formatValue(setting, shown(setting, initial)) };

  const blade = folder.addBinding(handle, 'pos', {
    label: setting.label,
    min: 0,
    max: 1,
    // A step would quantize the POSITION, which on a cubed curve is a wildly
    // uneven quantization of the value. Left continuous deliberately.
  });
  decorate(blade, setting, ctx);

  // **The readout goes INSIDE the slider's own number box, not in a blade of
  // its own.** A second blade costs a whole row and lands under the handle
  // rather than beside it, so a curved control would be the one row in the panel
  // whose number is not where every other row's number is -- which reads as a
  // rendering fault. Tweakpane has no "custom format" hook on a binding, so the
  // box's text is written directly and made read-only: it is a readout, and the
  // handle is the control.
  //
  // Falls back to a separate blade if the input cannot be found, so a Tweakpane
  // internals change degrades to the ugly layout rather than to no number.
  const box = (blade.element as HTMLElement).querySelector('input');
  let fallback: ReturnType<FolderApi['addBinding']> | null = null;
  if (box !== null) {
    box.readOnly = true;
    box.value = readout.value;
  } else {
    fallback = folder.addBinding(readout, 'value', { label: ' ', readonly: true });
    (fallback.element as HTMLElement).dataset['setting'] =
      `${settingKey(setting)}.readout`;
  }

  /** Put the display value in whichever readout this control ended up with. */
  const writeReadout = (display: number): void => {
    readout.value = formatValue(setting, display);
    if (box !== null) box.value = readout.value;
  };

  blade.on('change', (ev) => {
    if (ctx.isRefreshing()) return;
    const display = valueAt(setting, ev.value as number);
    writeReadout(display);
    ctx.send({ kind: 'editSetting', setting, value: stored(setting, display) });
  });

  return {
    setting,
    blades: fallback === null ? [blade] : [blade, fallback],
    refresh: (s) => {
      const authoritative = currentValues(s, setting.source)[setting.field];
      if (authoritative === undefined) return;
      const display = shown(setting, asNumber(authoritative));
      handle.pos = position(setting, display);
      writeReadout(display);
    },
  };
}

/**
 * A typed value committed on Enter, for the settings that reset the simulation.
 *
 * **DISRUPTIVE settings are typed inputs, not sliders**: World Size and Canvas
 * Aspect reallocate GPU buffers and reset the simulation, so a slider would
 * rebuild the whole system on every frame of a drag
 * (`ARCHITECTURE.md`, "Settings, and the three kinds of state").
 *
 * Tweakpane's string binding fires `change` on every keystroke, so the commit is
 * gated on Enter at the DOM level instead -- the text field is found through the
 * blade's own element rather than through a class name, since it is the only
 * `input` a string binding owns.
 *
 * A rejected parse restores the live value silently rather than reporting an
 * error: a typo should cost nothing, and the number it replaced is right there
 * (`settings_window.py:448-455`).
 */
function addInput(
  folder: FolderApi,
  setting: Setting,
  status: Status,
  ctx: ControlContext,
): ControlBinding {
  const initial = asNumber(currentValues(status, setting.source)[setting.field]);
  const text = { value: formatCompact(initial) };
  /** The live value, so a rejected parse has something to restore to. */
  let live = initial;

  const blade = folder.addBinding(text, 'value', { label: setting.label });
  decorate(blade, setting, ctx);

  const field = (blade.element as HTMLElement).querySelector('input');
  if (field !== null) {
    /**
     * Take what is typed, or put the live value back if it will not parse.
     *
     * Extracted when the second caller arrived (see `commitOnBlur` below), and
     * returns whether it committed so the blur path can tell the two apart.
     */
    const commit = (): boolean => {
      const parsed = parseInput(setting, field.value);
      if (parsed === null) {
        // Reject silently by restoring the live value: a typo must not reset
        // the simulation.
        text.value = formatCompact(live);
        field.value = text.value;
        return false;
      }
      text.value = formatCompact(parsed);
      field.value = text.value;
      // **`live` moves with the commit**, before the dispatch. It is otherwise
      // only assigned in `refresh` from authoritative status, so between here
      // and the next frame it still holds the OLD number -- and the blur
      // handler below would restore that stale value the instant focus left.
      // `focusRelease.ts` blurs on Enter precisely to hand the keyboard back,
      // which puts it inside that window: the field would visibly snap back to
      // the old number and then forward again, indistinguishable from the
      // silent rejection above.
      live = parsed;
      ctx.send({ kind: 'editSetting', setting, value: parsed });
      return true;
    };

    field.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key !== 'Enter') return;
      commit();
    });

    // =====================================================================
    // ON TOUCH, LEAVING THE FIELD **COMMITS** RATHER THAN DISCARDING
    // =====================================================================
    //
    // On a desktop the commit gesture is Enter and anything else is an
    // abandonment, which is a real distinction: the keyboard is always there,
    // Enter costs nothing, and clicking away to cancel an edit is a gesture
    // people expect to work.
    //
    // A phone has neither half of that. The on-screen keyboard's action key is
    // labelled Go/Done/Search depending on the platform and the `inputmode`,
    // and for `inputmode=decimal` -- which is what a numeric field asks for --
    // several keyboards show a plain decimal pad with NO action key at all. So
    // there is frequently no way to produce the `Enter` this listener waits
    // for. And "click away" is not a deliberate cancel on a phone; it is how
    // the keyboard gets dismissed, which is a thing users do constantly.
    //
    // Together those made World Size and Canvas Aspect impossible to change on
    // a phone: every edit reverted the instant the keyboard closed, which is
    // exactly the report this fixes.
    //
    // **THE DESKTOP KEEPS DISCARD-ON-BLUR**, unchanged. These two behaviours
    // are genuinely right for their own input, and unifying them would take
    // away a working cancel gesture from the desktop to fix a phone.
    const commitOnBlur = ctx.mobile === true;

    field.addEventListener('blur', () => {
      if (commitOnBlur) {
        // `commit` restores the live value itself when the text will not parse,
        // so an abandoned or garbled edit still ends up showing the truth.
        commit();
        return;
      }
      text.value = formatCompact(live);
      field.value = text.value;
    });
  }

  return {
    setting,
    blades: [blade],
    refresh: (s) => {
      const authoritative = currentValues(s, setting.source)[setting.field];
      if (authoritative === undefined) return;
      live = asNumber(authoritative);
      // **Only while the user is not typing.** Tweakpane owns focus here, and
      // clobbering the text mid-type would be hostile -- the desktop leaves
      // buffers being edited alone for the same reason
      // (`settings_window.py:521-527`).
      if (field !== null && document.activeElement === field) return;
      text.value = formatCompact(live);
    },
  };
}

/**
 * A Randomize button with the current value shown beside it.
 *
 * **Not an editable field**: the seed is an opaque selector into the space of
 * rule variations, so a specific value is only ever worth reading -- to note it
 * down or compare -- never worth typing (`settings_window.py:410-419`).
 *
 * Disabled when Mutation Scale is zero: with no mutation there is no variation
 * for a seed to select, so an active control would imply an effect it cannot
 * have. That is a live condition, so it is re-evaluated every frame rather than
 * decided at build time.
 */
function addSeed(
  folder: FolderApi,
  setting: Setting,
  status: Status,
  ctx: ControlContext,
): ControlBinding {
  const readout = {
    value: formatSeed(asNumber(currentValues(status, setting.source)[setting.field])),
  };

  const blade = folder.addBinding(readout, 'value', {
    label: setting.label,
    readonly: true,
  });
  decorate(blade, setting, ctx);

  const button = folder.addButton({ title: 'Randomize', label: ' ' });
  (button.element as HTMLElement).dataset['setting'] = `${settingKey(setting)}.randomize`;
  // No `refreshing` guard: a button's click is always the user's. The guard
  // exists for BINDINGS, whose `change` fires on a programmatic refresh too.
  button.on('click', () => {
    ctx.send({ kind: 'randomizeSeed' });
  });

  return {
    setting,
    // **The button is in here too.** `blades` means everything this control
    // owns, and visibility is applied across the whole list -- so leaving the
    // button out would hide a revealed seed's readout while its Randomize button
    // stayed on screen, orphaned. The seed has no `revealsOn` today, which is
    // exactly why this is worth getting right now rather than discovering later.
    blades: [blade, button],
    refresh: (s) => {
      const authoritative = currentValues(s, setting.source)[setting.field];
      if (authoritative !== undefined) readout.value = formatSeed(asNumber(authoritative));
      // `mutationScale` is a CONFIG field and the seed is too, so this reads
      // the same payload the seed does.
      const scale = asNumber(s.editConfig['mutationScale']);
      button.disabled = !(scale > 0);
    },
  };
}

/** Indent for a revealed control, in px. The desktop's `_REVEAL_INDENT`. */
const REVEAL_INDENT_PX = 12;

/** The `data-setting` hook, the tooltip, the indent, and the disabled state. */
function decorate(blade: BladeApi, setting: Setting, ctx: ControlContext): void {
  tagBlade(blade, setting);
  ctx.tooltip.attach(blade.element as HTMLElement, {
    title: setting.label,
    body: setting.help + (setting.implemented ? '' : '\n\n(not implemented yet)'),
  });
  // Indented so the group reads as belonging to its checkbox
  // (`settings_window.py:248-256`). Applied ONCE at build rather than per frame:
  // whether a control is revealed changes, but what it hangs off does not.
  if (setting.revealsOn !== '') {
    (blade.element as HTMLElement).style.paddingLeft = `${REVEAL_INDENT_PX}px`;
  }
  // Registered but not yet wired: show the control disabled so the layout is
  // visible without implying the knob does something
  // (`settings_window.py:236-246`). Zero entries use this today; it is the
  // mechanism for staging a tier layout ahead of the feature.
  if (!setting.implemented) blade.disabled = true;
}

/** Status payloads are `number | boolean`; the numeric paths want a number. */
function asNumber(value: number | boolean | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return 0;
}

/**
 * The shortest exact-looking form, for a typed field.
 *
 * `%g`-ish, matching `settings_window.py:440`: a World Size of 1 should read
 * "1" in a box you are about to type into, not "1.0000".
 */
function formatCompact(value: number): string {
  return String(Number(value.toPrecision(6)));
}

/** Stamp the stable `data-setting` hook onto a blade's element. */
export function tagBlade(blade: BladeApi, setting: Setting): void {
  (blade.element as HTMLElement).dataset['setting'] = settingKey(setting);
}

/**
 * Tweakpane binding params for one registry entry.
 *
 * GATED and GATED_INT still fall through to their ungated equivalents here;
 * 10d gives them their checkbox. That degradation is safe for one specific
 * reason: **on/off is derived from the value itself, so nothing extra is
 * stored** (`gated_controls.py`). The stored value, the save format, undo and
 * preview are identical either way -- only the widget differs.
 *
 * CHOICE builds its options from the registry tuple, **indexed by position**,
 * because the index IS the stored value and must stay in lockstep with the
 * `BC_*`/`IC_*` constants.
 */
export function paramsFor(setting: Setting): Record<string, unknown> {
  switch (setting.kind) {
    case BOOL:
      return {};

    case CHOICE:
      return {
        options: Object.fromEntries(
          setting.options.map((label, index) => [label, index]),
        ),
      };

    case INT:
    case GATED_INT:
      return { min: setting.lo, max: setting.hi, step: 1 };

    case INPUT:
      // A DISRUPTIVE setting: it reallocates GPU resources and resets the
      // simulation, so it must not be a slider -- dragging would rebuild on
      // every frame of the drag. A bare number input commits on Enter/blur.
      return { min: setting.lo, max: setting.hi };

    case SLIDER:
    case GATED:
    default:
      return { min: setting.lo, max: setting.hi };
  }
}

/** Re-exported so sections do not each import the registry constants. */
export { CONFIG, PREFS, WORLD };
