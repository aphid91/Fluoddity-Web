/**
 * Mutation Scale, as a wide slider centred above the canvas.
 *
 * ## Why this is not a Tweakpane control
 *
 * Mutation Scale is the single most consequential control in the app -- it was
 * the FIRST entry in the registry for exactly that reason, and being first in a
 * folder in a 320px column is still buried. What it wants is width and a
 * position that reads as primary, and Tweakpane has neither to give: its
 * layout is a fixed label/widget split inside a docked pane, which is the right
 * shape for forty settings and the wrong one for the setting.
 *
 * So this is plain DOM, following the precedent `menuBar.ts` and `dialogs.ts`
 * already set for UI that has outgrown the pane. It lives OUTSIDE both panel
 * containers, is owned by `Panel`, and is hidden along with everything else by
 * `X`.
 *
 * **It is not a second source of truth.** The registry entry still exists
 * (`panel: false`), and the label, bounds and help text are read from it rather
 * than restated here -- so the overlay and the config can never disagree about
 * what the range is. The value round-trips through the command bus exactly as a
 * Tweakpane slider's does.
 *
 * ## The drag guard is this file's `refreshing`
 *
 * `refresh()` runs every frame and writes the authoritative value into the
 * slider. A native `<input type=range>` under the mouse would fight that write:
 * the thumb would snap back to last frame's value mid-drag, every frame. The
 * `dragging` flag is the same idea as the panel's `refreshing` guard, in the
 * other direction -- the panel guards against a refresh being read as a user
 * edit; this guards against a refresh CLOBBERING one.
 */

import {
  type Command,
  type MouseMode,
  type Status,
  MOUSE_MODES,
  mouseModeFromValue,
} from '../orchestrator/commands.ts';
import { bindFocusRelease } from './focusRelease.ts';
import { hotkeyLabel } from './hotkeys.ts';
import { CONFIG, settingFor } from './settingsSpec.ts';

export interface MutationOverlayOptions {
  readonly send: (command: Command) => void;
  /** Where to mount. Defaults to `document.body`. */
  readonly container?: HTMLElement;
}

/** Human-readable tool names. Keyed so a new MOUSE_MODES member fails to compile. */
const TOOL_LABELS: Record<MouseMode, string> = {
  select: 'Select',
  shove: 'Shove',
  draw: 'Draw',
};

/** `Tool: Select (1)`, with the key read from the hotkey table. */
function toolOptionLabel(mode: MouseMode): string {
  const key = hotkeyLabel({ kind: 'setMouseMode', mode });
  return `Tool: ${TOOL_LABELS[mode]}${key === '' ? '' : ` (${key})`}`;
}

export class MutationOverlay {
  private readonly root: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly readout: HTMLElement;
  private readonly reroll: HTMLButtonElement;
  private readonly tool: HTMLSelectElement;

  /** True between pointerdown and pointerup on the slider. See the header. */
  private dragging = false;

  /**
   * Teardown for the focus-release listeners.
   *
   * The overlay needs its OWN binding because it deliberately lives outside
   * both panel containers (see the header), so the panel's two bindings cannot
   * reach it -- and a `<input type=range>` keeps focus after a drag exactly as
   * a Tweakpane track does, swallowing every hotkey until something else took
   * it. The tool `<select>` below still blurs itself on `change`; that predates
   * this and is left alone, since it is the same answer arrived at locally.
   */
  private readonly releaseFocus: () => void;

  constructor(opts: MutationOverlayOptions) {
    // Bounds from the registry, never restated. A renamed field degrades to the
    // 0..1 fallback rather than to a slider with no range at all.
    const setting = settingFor(CONFIG, 'mutationScale');
    const lo = setting?.lo ?? 0;
    const hi = setting?.hi ?? 1;

    this.root = document.createElement('div');
    this.root.id = 'fluoddity-mutation';
    this.root.style.cssText = ROOT_CSS;

    const bar = document.createElement('div');
    bar.style.cssText = BAR_CSS;

    const label = document.createElement('span');
    label.textContent = setting?.label ?? 'Mutation Scale';
    label.style.cssText = LABEL_CSS;
    if (setting !== null) label.title = setting.help;

    this.slider = document.createElement('input');
    this.slider.type = 'range';
    this.slider.min = String(lo);
    this.slider.max = String(hi);
    // Fine enough that the slider is not the limiting factor on a value the
    // shader reads as a continuous float.
    this.slider.step = '0.001';
    this.slider.style.cssText = SLIDER_CSS;
    this.slider.dataset['setting'] = 'config.mutationScale';

    this.readout = document.createElement('span');
    this.readout.style.cssText = READOUT_CSS;

    this.reroll = document.createElement('button');
    this.reroll.type = 'button';
    // The shortcut comes from the hotkey table, not from a literal here -- see
    // `hotkeyLabel`. A rebind moves this label with it.
    const rerollKey = hotkeyLabel({ kind: 'randomizeSeed' });
    this.reroll.textContent =
      rerollKey === '' ? 'Reroll Mutations' : `Reroll Mutations (${rerollKey})`;
    this.reroll.style.cssText = BUTTON_CSS;
    this.reroll.dataset['setting'] = 'config.mutationSeed.randomize';

    // A real <select>, not a readout: the tool was previously only reachable
    // from the Tools menu and the number keys, and a modal state you can see but
    // not change from where you see it is a worse affordance than either.
    this.tool = document.createElement('select');
    this.tool.style.cssText = TOOL_CSS;
    this.tool.dataset['setting'] = 'transport.tool';
    for (const mode of MOUSE_MODES) {
      const option = document.createElement('option');
      option.value = mode;
      option.textContent = toolOptionLabel(mode);
      // Set on each OPTION as well as on the select. An option does not reliably
      // inherit its parent's colours into the OS-drawn popup, which is how the
      // text ended up pale-on-white; stating both ends removes the guess.
      option.style.cssText = 'background:#ffffff;color:#000000;';
      this.tool.append(option);
    }

    // The tool control goes INSIDE the bar, not below it. Floating on its own
    // it read as a stray tooltip over the canvas rather than as part of the UI,
    // and a status line that looks like an error message is worse than none.
    bar.append(label, this.slider, this.readout, this.reroll, this.tool);
    this.root.append(bar);
    (opts.container ?? document.body).append(this.root);
    this.releaseFocus = bindFocusRelease(this.root);

    // --- events ------------------------------------------------------------

    // `input`, not `change`: `change` fires only on release, so the simulation
    // would not move until the drag ended -- and watching the result while
    // dragging is the entire reason this control is big and on the canvas.
    this.slider.addEventListener('input', () => {
      if (setting === null) return;
      this.readout.textContent = format(this.slider.valueAsNumber);
      opts.send({
        kind: 'editSetting',
        setting,
        value: this.slider.valueAsNumber,
      });
    });

    // See the header. `pointercancel` too: a drag interrupted by a context menu
    // or a window switch never gets its `pointerup`, and a stuck flag would
    // freeze the readout permanently.
    this.slider.addEventListener('pointerdown', () => {
      this.dragging = true;
    });
    const release = (): void => {
      this.dragging = false;
    };
    this.slider.addEventListener('pointerup', release);
    this.slider.addEventListener('pointercancel', release);
    // A keyboard drag has no pointer events at all, and arrow keys on a focused
    // range fire `input` -- so blur is what ends that gesture.
    this.slider.addEventListener('blur', release);

    this.reroll.addEventListener('click', () => {
      opts.send({ kind: 'randomizeSeed' });
    });

    this.tool.addEventListener('change', () => {
      const mode = mouseModeFromValue(this.tool.value);
      if (mode !== null) opts.send({ kind: 'setMouseMode', mode });
    });

    // A <select> keeps keyboard focus after a click, and the number keys would
    // then be swallowed by its own type-ahead instead of reaching the hotkey
    // table -- so picking "Tool: Shove (2)" would leave `2` dead until you
    // clicked elsewhere. Blurring hands the keys straight back.
    this.tool.addEventListener('change', () => {
      this.tool.blur();
    });
  }

  /**
   * Push this frame's state in.
   *
   * Called from `Panel.refresh`, so it is skipped for a hidden panel exactly as
   * the panes are.
   */
  refresh(status: Status): void {
    const scale = status.editConfig['mutationScale'];

    if (typeof scale === 'number') {
      // NOT while dragging -- see the header.
      if (!this.dragging) {
        this.slider.valueAsNumber = scale;
        this.readout.textContent = format(scale);
      }
      // DELIBERATELY NOT DISABLED AT ZERO. This used to grey out below a scale
      // of 0, on the reasoning that with no mutation there is no variation for a
      // seed to select. True of the picture at that instant, but not of the
      // state: the seed the button sets is what the picture uses the moment the
      // slider comes off zero, so rerolling first and then raising the scale is
      // a real gesture -- and the old gate made it unreachable in exactly the
      // order a user would try it.
    }

    // The tool selector. It lives here because the Transport section that used
    // to carry it is parked (`panelModel.ts`), and a modal tool with no visible
    // state is a trap -- pressing `2` has to show up somewhere.
    //
    // Written only on an actual change, and never while the select has focus:
    // assigning `value` to an open dropdown closes it, so a per-frame write
    // would make the menu impossible to use with the mouse.
    if (this.tool.value !== status.mouseMode && document.activeElement !== this.tool) {
      this.tool.value = status.mouseMode;
    }
  }

  /**
   * The overlay is deliberately NOT part of what `X` hides.
   *
   * `X` hides the PANELS so you can see the picture; this bar is the picture's
   * own controls -- the one slider worth reaching for while watching, plus the
   * tool you are watching it with. Hiding it would mean pressing `X` to get a
   * clean view and then having to press `X` again to change anything about it.
   *
   * Kept as a no-op method rather than deleted so `Panel.setHidden` reads as a
   * complete list of what it governs, with this one saying why it opts out.
   */
  setHidden(_hidden: boolean): void {
    // Intentionally empty. See above.
  }

  dispose(): void {
    this.releaseFocus();
    this.root.remove();
  }
}

/** Two decimals: enough to read, few enough not to jitter under a drag. */
function format(value: number): string {
  return value.toFixed(2);
}

// -- styling ----------------------------------------------------------------
//
// `pointer-events` is the load-bearing part. The root spans the full width so
// its contents can be centred, which would otherwise put an invisible input
// trap across the whole top of the canvas -- so the ROOT ignores the pointer
// and only the bar takes it back. Without this, a drag started near the top of
// the canvas would hit nothing.
//
// ## The geometry, and the two bugs it fixes
//
// **`top` clears the menu bar.** The bar is fixed at `top:0` and runs about
// 26px tall (`menuBar.ts`); at `top:8px` this overlay ran straight through it.
//
// MENU_BAR_CLEARANCE POSITIONS THIS OVERLAY ONLY. `panel.ts` does not import it
// -- its `PANEL_TOP_PX` is a hand-computed literal that has to clear the menu
// bar AND this bar's full height, and the two are related by intent rather than
// by code. So they CAN drift, and changing either alone is how they overlap.
// (A previous version of this comment claimed the opposite; it was never true.)
//
// **`transform`, not flex, does the centring.** With `left:0;right:0` and
// `align-items:center` the bar was centred in whatever width the root happened
// to have -- and `position:fixed` resolves that against the viewport, which
// changes when a scrollbar appears or disappears as the panels are toggled with
// `X`. The bar visibly jumped. Anchoring the LEFT EDGE at 50% and pulling back
// by half the bar's own width centres it against a fixed reference instead, so
// nothing about the panels can move it.
const MENU_BAR_CLEARANCE = 34;

const ROOT_CSS =
  `position:fixed;top:${MENU_BAR_CLEARANCE}px;left:50%;transform:translateX(-50%);` +
  'z-index:30;display:flex;flex-direction:column;align-items:center;gap:4px;' +
  'pointer-events:none;';

const BAR_CSS =
  'display:flex;align-items:center;gap:10px;pointer-events:auto;' +
  'background:rgba(28,28,30,0.92);border:1px solid rgba(255,255,255,0.12);' +
  'border-radius:6px;padding:7px 12px;box-shadow:0 4px 16px rgba(0,0,0,0.45);';

const LABEL_CSS =
  'font:12px system-ui,sans-serif;color:#e8e8ea;white-space:nowrap;' +
  'user-select:none;';

// Wide enough to be worth having left the pane for, capped so it does not run
// under either panel on a narrow window.
const SLIDER_CSS = 'width:min(46vw,420px);accent-color:#8ab4f8;cursor:pointer;';

// Tabular numerals and a fixed width, so the bar does not reflow as digits
// change under a drag.
const READOUT_CSS =
  'font:12px ui-monospace,monospace;color:#e8e8ea;width:3.2em;text-align:right;' +
  'font-variant-numeric:tabular-nums;user-select:none;';

const BUTTON_CSS =
  'background:rgba(255,255,255,0.10);border:1px solid rgba(255,255,255,0.14);' +
  'border-radius:4px;color:#e8e8ea;font:11px system-ui,sans-serif;' +
  'padding:5px 10px;cursor:pointer;white-space:nowrap;';

// The tool dropdown.
//
// **LIGHT, deliberately, while everything around it is dark.** The first attempt
// styled it to match the Reroll button -- pale text on a translucent dark
// background -- plus `color-scheme:dark` to carry that into the option list.
// That popup is drawn by the OS, and `color-scheme` is a HINT it does not always
// honour: where it was ignored the menu opened white and kept the pale text,
// which is nearly unreadable.
//
// So this does not rely on the hint at all. An opaque light background with
// black text is legible whether the popup follows the element's colours or the
// platform's default, which is the only version that cannot fail. The dark
// border keeps it visually seated in the bar.
//
// `color-scheme:light` is still worth stating: where it IS honoured it makes the
// popup match this element rather than merely tolerating it.
const TOOL_CSS =
  'background:#e8e8ea;border:1px solid rgba(255,255,255,0.24);' +
  'border-radius:4px;color:#000;font:11px system-ui,sans-serif;' +
  'padding:5px 8px;cursor:pointer;color-scheme:light;';
