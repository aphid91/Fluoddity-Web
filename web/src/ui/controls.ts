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
 * `null` rather than a no-op blade for the two cases that genuinely have no
 * widget of their own: a SEED (which is a button, built by the caller) and the
 * `field: ''` gate entry (which is a checkbox derived from other fields, 10c).
 * Returning null keeps "has a value to refresh" and "is on screen" the same
 * question.
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

  // A SEED is a Randomize button with the value beside it, never an editable
  // field: the seed is an opaque selector into rule-variation space, so it is
  // worth reading but never worth typing (`settings_window.py:410-419`).
  if (setting.kind === SEED) return null;

  const values = currentValues(status, setting.source);
  const initial = values[setting.field] ?? 0;
  const proxy = { value: initial };

  const blade = folder.addBinding(proxy, 'value', {
    label: setting.label,
    ...paramsFor(setting),
  });

  tagBlade(blade, setting);

  // The help text, such as a bare `title` attribute can carry it. 10b replaces
  // this with the real delayed tooltip; until then it is free and better than
  // dropping the text on the floor.
  if (setting.help !== '') {
    (blade.element as HTMLElement).title = setting.help;
  }

  // Registered but not yet wired: show the control disabled so the layout is
  // visible without implying the knob does something
  // (`settings_window.py:236-246`). Zero entries use this today; it is the
  // mechanism for staging a tier layout ahead of the feature.
  if (!setting.implemented) {
    blade.disabled = true;
  }

  blade.on('change', (ev) => {
    // Not a user edit: `refresh()` is pushing the authoritative value in. See
    // `panel.ts`'s `refreshing` for what happens without this.
    if (ctx.isRefreshing()) return;
    ctx.send({
      kind: 'editSetting',
      setting,
      value: ev.value as number | boolean,
    });
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
