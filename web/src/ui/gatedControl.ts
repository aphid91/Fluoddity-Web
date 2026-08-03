/**
 * The self-hiding slider: a checkbox while it sits at its base value.
 *
 * The port of `draw_gated` (`ui/gated_controls.py:183-226`). Six settings use
 * it, and its load-bearing property is stated in that file's header:
 *
 * > both derive their on/off state from the values themselves -- **nothing extra
 * > is stored**, so save, load, undo and A/B preview all keep working with no
 * > knowledge that any of this exists.
 *
 * That is not a nicety, it is the reason the feature is safe to have at all, and
 * it is why `thinPanel.ts` could render these as plain sliders without breaking
 * anything. **Do not add a stored flag here.**
 *
 * ## The session latch, and why it exists
 *
 *     show slider = value is off base  OR  a session is open on this control
 *
 * Testing the value alone cannot work: **the value passes through the off zone
 * during the gesture.** Drag a slider to the bottom and it is at zero long
 * before you let go, so a value-only test would fold the control away mid-drag.
 *
 * ## What is EASIER here than on the desktop, and what is harder
 *
 * imgui drops a drag whose widget stops being submitted, so the desktop's
 * fold-back has to happen at exactly the closing edge or it destroys the gesture
 * that produced it (`gated_controls.py:20-34`). **In the DOM that hazard does not
 * exist**: hiding an element changes `display` and nothing else -- the element
 * survives, and so does its pointer capture. So the web latch is a simpler
 * thing than the desktop's, not a harder one.
 *
 * What is harder is telling a user gesture from a programmatic refresh, which
 * imgui gets for free by being immediate-mode. See below.
 *
 * ## THE ORDERING THAT MUST NOT BE REVERSED
 *
 * Verified in `tweakpane/dist/tweakpane.js`:
 *
 *   - `pane.refresh()` -> `fetch()` -> the plain `rawValue` setter, which calls
 *     `setRawValue(v, {forceEmit: false, last: true})`  (`:175-179`)
 *   - a released drag -> `onPointerUp_` -> `setRawValue(v, {forceEmit: true,
 *     last: true})`  (`:3541-3546`)
 *   - a checkbox click -> `this.value.rawValue = checked`, i.e. `last: true`
 *     again  (`:3822`)
 *
 * **So `ev.last` cannot distinguish an app-pushed value from a user gesture.**
 * Every handler here tests `isRefreshing()` FIRST. If that check came second,
 * every `pane.refresh()` -- sixty a second -- would arrive as a closing edge and
 * fold an open slider away mid-drag. That failure is silent, intermittent, and
 * looks like a Tweakpane bug rather than an ordering mistake.
 *
 * What `ev.last` DOES distinguish, correctly, is mid-drag from end-of-drag:
 * `onPointerMove_` emits `last: false` (`:3529-3536`), and nothing else does.
 * A `last: false` can therefore only be a user dragging, which is what opens a
 * session.
 *
 * ## Closing a session needs more than `change`
 *
 * A click that produces no value change emits no `change` at all -- `setRawValue`
 * returns early when `!changed && !forceEmit` (`:187-190`). And an interrupted
 * gesture (alt-tab mid-drag, an OS `pointercancel`) never reaches `onPointerUp_`.
 * So `pointerup` and `lostpointercapture` on the blade element close the session
 * too. Without them a session leaks and holds a control open forever.
 */

import type { FolderApi } from 'tweakpane';
import type { Status } from '../orchestrator/commands.ts';
import {
  type ControlBinding,
  type ControlContext,
  currentValues,
  paramsFor,
  settingKey,
  tagBlade,
} from './controls.ts';
import { formatValue } from './formatValue.ts';
import { isOff, nudged, position, shown, stored, valueAt } from './gating.ts';
import { type Setting, GATED_INT } from './settingsSpec.ts';

/**
 * Build the checkbox/slider pair for one gated setting.
 *
 * Both blades exist for the control's whole life; `refresh` decides which is
 * visible. Building them once rather than swapping widgets is what keeps a drag
 * alive across the fold-back -- there is no moment at which the slider does not
 * exist.
 */
export function addGatedControl(
  folder: FolderApi,
  setting: Setting,
  status: Status,
  ctx: ControlContext,
): ControlBinding {
  const key = settingKey(setting);
  const curved = setting.curve !== 1 || setting.inverted;

  const initial = asNumber(currentValues(status, setting.source)[setting.field]);
  /** The value the slider last settled on, in STORED space. */
  let live = initial;

  // --- the checkbox, shown while the value is at base -----------------------
  const box = { value: false };
  const checkbox = folder.addBinding(box, 'value', { label: setting.label });
  (checkbox.element as HTMLElement).dataset['setting'] = `${key}.gate`;
  ctx.tooltip.attach(checkbox.element as HTMLElement, {
    title: setting.label,
    body: setting.help,
  });

  checkbox.on('change', (ev) => {
    if (ctx.isRefreshing()) return;
    if (!ev.value) return;
    // Open the session HERE as well as dispatching, so the control visibly
    // responds on this frame rather than waiting for the nudged value to come
    // back round through the next status (`gated_controls.py:199-203`).
    ctx.gates.sessions.add(key);
    const value = nudged(setting);
    live = value;
    ctx.send({ kind: 'editSetting', setting, value });
  });

  // --- the slider, shown otherwise -----------------------------------------
  // A curved or inverted gated control drives POSITION space, exactly as the
  // ungated one does; `gateBase` is a STORED value, so the two spaces compose
  // here the same way they do in `controls.ts` (`settings_window.py:383-408`).
  const handle = curved
    ? { value: position(setting, shown(setting, initial)) }
    : { value: initial };
  const slider = folder.addBinding(
    handle,
    'value',
    curved ? { label: setting.label, min: 0, max: 1 } : { label: setting.label, ...paramsFor(setting) },
  );
  tagBlade(slider, setting);
  ctx.tooltip.attach(slider.element as HTMLElement, {
    title: setting.label,
    body: setting.help,
  });

  const box2 = curved ? (slider.element as HTMLElement).querySelector('input') : null;
  if (box2 !== null) {
    box2.readOnly = true;
    box2.value = formatValue(setting, shown(setting, initial));
  }

  /** Translate what the widget holds into a stored value. */
  const storedFromWidget = (raw: number): number =>
    curved ? stored(setting, valueAt(setting, raw)) : raw;

  slider.on('change', (ev) => {
    // FIRST. ALWAYS. See the file header.
    if (ctx.isRefreshing()) return;

    const value = storedFromWidget(ev.value as number);
    live = value;
    if (box2 !== null) box2.value = formatValue(setting, shown(setting, value));

    // `last: false` can only be a user dragging, so it opens a session and
    // never closes one.
    if (!ev.last) {
      ctx.gates.sessions.add(key);
      ctx.send({ kind: 'editSetting', setting, value });
      return;
    }
    ctx.send({ kind: 'editSetting', setting, value });
    closeSession();
  });

  // The two events `change` cannot see: a click that moved nothing, and a
  // gesture the OS interrupted. See the file header.
  const element = slider.element as HTMLElement;
  element.addEventListener('pointerdown', () => {
    if (ctx.isRefreshing()) return;
    ctx.gates.sessions.add(key);
  });
  element.addEventListener('pointerup', () => {
    closeSession();
  });
  element.addEventListener('lostpointercapture', () => {
    closeSession();
  });

  /**
   * End the gesture, and fold the control away if it landed at base.
   *
   * **Snaps to EXACTLY base**, so "is it off?" stays unambiguous rather than
   * "within epsilon" -- which is also what makes a config carrying a stray 1e-9
   * come back as a clean unticked box (`gated_controls.py:222-226`).
   */
  function closeSession(): void {
    if (!ctx.gates.sessions.delete(key)) return;
    const base = setting.gateBase;
    if (live !== base && isOff(setting, live)) {
      const value = setting.kind === GATED_INT ? Math.round(base) : base;
      live = value;
      ctx.send({ kind: 'editSetting', setting, value });
    }
  }

  return {
    setting,
    blades: [checkbox, slider],
    refresh: (s) => {
      const authoritative = currentValues(s, setting.source)[setting.field];
      if (authoritative === undefined) return;
      const value = asNumber(authoritative);

      // **A control with a gesture in flight is not refreshed.** The user is
      // dragging it; writing the authoritative value into the widget would fight
      // the drag, and the value they are producing is already on its way through
      // the bus. `live` is what the fold-back tests, and it is set by the
      // gesture rather than by this.
      if (ctx.gates.sessions.has(key)) return;

      live = value;
      if (curved) {
        const display = shown(setting, value);
        handle.value = position(setting, display);
        if (box2 !== null) box2.value = formatValue(setting, display);
      } else {
        handle.value = value;
      }
      // Derived every frame from the value itself -- nothing stored. An
      // unticked box is what "at base" looks like.
      box.value = false;
    },
  };
}

/**
 * Whether a gated control should be showing its slider rather than its checkbox.
 *
 * Exported and pure so `panel.ts` can apply it alongside the reveal decision,
 * and so `gatedControl.test.ts` can assert the rule without a DOM.
 */
export function showsSlider(
  setting: Setting,
  value: number,
  sessions: ReadonlySet<string>,
): boolean {
  return !isOff(setting, value) || sessions.has(settingKey(setting));
}

function asNumber(value: number | boolean | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return 0;
}
