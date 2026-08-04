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

import type { Command, MouseMode, Status } from '../orchestrator/commands.ts';
import { CONFIG, settingFor } from './settingsSpec.ts';

export interface MutationOverlayOptions {
  readonly send: (command: Command) => void;
  /** Where to mount. Defaults to `document.body`. */
  readonly container?: HTMLElement;
}

/** Human-readable tool names, for the indicator. */
const TOOL_LABELS: Record<MouseMode, string> = {
  select: 'Select',
  shove: 'Shove',
  draw: 'Draw',
};

export class MutationOverlay {
  private readonly root: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly readout: HTMLElement;
  private readonly reroll: HTMLButtonElement;
  private readonly toolLabel: HTMLElement;

  /** True between pointerdown and pointerup on the slider. See the header. */
  private dragging = false;

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
    this.reroll.textContent = 'Reroll Mutations';
    this.reroll.style.cssText = BUTTON_CSS;
    this.reroll.dataset['setting'] = 'config.mutationSeed.randomize';

    this.toolLabel = document.createElement('div');
    this.toolLabel.style.cssText = TOOL_CSS;
    this.toolLabel.dataset['tool'] = '';

    // The tool indicator goes INSIDE the bar, not below it. Floating on its own
    // it read as a stray tooltip over the canvas rather than as a readout, and
    // a status line that looks like an error message is worse than none.
    bar.append(label, this.slider, this.readout, this.reroll, this.toolLabel);
    this.root.append(bar);
    (opts.container ?? document.body).append(this.root);

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
      // Disabled at zero, re-evaluated every frame because it is a live
      // condition: with no mutation there is no variation for a seed to select,
      // so an active button would imply an effect it cannot have.
      this.reroll.disabled = !(scale > 0);
      this.reroll.style.opacity = scale > 0 ? '1' : '0.4';
      this.reroll.style.cursor = scale > 0 ? 'pointer' : 'default';
    }

    // The tool indicator. It lives here because the Transport section that used
    // to show the active tool is parked (`panelModel.ts`), and a modal tool with
    // no visible state is a trap -- pressing `2` has to show up somewhere.
    const tool = TOOL_LABELS[status.mouseMode];
    if (this.toolLabel.dataset['tool'] !== status.mouseMode) {
      this.toolLabel.dataset['tool'] = status.mouseMode;
      this.toolLabel.textContent = `${tool} tool`;
    }
  }

  setHidden(hidden: boolean): void {
    this.root.style.display = hidden ? 'none' : '';
  }

  dispose(): void {
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

const ROOT_CSS =
  'position:fixed;top:8px;left:0;right:0;z-index:30;' +
  'display:flex;flex-direction:column;align-items:center;gap:4px;' +
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

// Separated from the Reroll button by a rule rather than by distance, so it
// reads as a readout belonging to the bar and not as a second button.
const TOOL_CSS =
  'font:11px system-ui,sans-serif;color:rgba(232,232,234,0.7);' +
  'border-left:1px solid rgba(255,255,255,0.14);padding-left:10px;' +
  'white-space:nowrap;pointer-events:none;user-select:none;';
