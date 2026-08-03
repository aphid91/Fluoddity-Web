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
import { position, shown, stored, valueAt } from './gating.ts';
import { formatSeed, formatValue, parseInput } from './formatValue.ts';
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
 * Build the control for one registry entry, or `null` if it has none.
 *
 * `null` rather than a no-op blade for the one case that genuinely has no widget
 * of its own: the `field: ''` gate entry, which is a checkbox derived from other
 * fields (10c). Returning null keeps "has a value to refresh" and "is on screen"
 * the same question.
 */
export function addControl(
  folder: FolderApi,
  setting: Setting,
  status: Status,
  ctx: ControlContext,
): ControlBinding | null {
  // The Gravity entry is a pure gate: it "is not itself a saved setting" and
  // stores nothing (`settings_spec.py:263`). It has no field to bind, so it
  // cannot be built here -- 10c builds it from the fields it gates.
  if (setting.field === '') return null;

  if (setting.kind === SEED) return addSeed(folder, setting, status, ctx);
  if (setting.kind === INPUT) return addInput(folder, setting, status, ctx);
  if (setting.curve !== 1 || setting.inverted) {
    return addMapped(folder, setting, status, ctx);
  }
  return addDirect(folder, setting, status, ctx);
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

  blade.on('change', (ev) => {
    // Not a user edit: `refresh()` is pushing the authoritative value in. See
    // `panel.ts`'s `refreshing` for what happens without this.
    if (ctx.isRefreshing()) return;
    ctx.send({ kind: 'editSetting', setting, value: ev.value as number | boolean });
  });

  return {
    setting,
    blades: [blade],
    refresh: (s) => {
      const authoritative = currentValues(s, setting.source)[setting.field];
      if (authoritative !== undefined) proxy.value = authoritative;
    },
  };
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
    field.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key !== 'Enter') return;
      const parsed = parseInput(setting, field.value);
      if (parsed === null) {
        // Reject silently by restoring the live value: a typo must not reset
        // the simulation.
        text.value = formatCompact(live);
        field.value = text.value;
        return;
      }
      text.value = formatCompact(parsed);
      field.value = text.value;
      ctx.send({ kind: 'editSetting', setting, value: parsed });
    });

    // Leaving the field without committing discards the edit, for the same
    // reason: the commit gesture is Enter, and anything else is an abandonment.
    field.addEventListener('blur', () => {
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
    blades: [blade],
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

/** The `data-setting` hook, the tooltip, and the not-implemented state. */
function decorate(blade: BladeApi, setting: Setting, ctx: ControlContext): void {
  tagBlade(blade, setting);
  ctx.tooltip.attach(blade.element as HTMLElement, {
    title: setting.label,
    body: setting.help + (setting.implemented ? '' : '\n\n(not implemented yet)'),
  });
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
