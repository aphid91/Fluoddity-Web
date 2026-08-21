/**
 * The frame-rate button, top-right.
 *
 * A number on a button whose colour says how the GPU is coping, and whose click
 * brings up the three settings that decide it. `perf/fpsBand.ts` owns what it
 * says; this owns how it looks and what the click does.
 *
 * ## Why it lives outside both panel containers
 *
 * The `Toast`/`RecordingBar` pattern: attached to `document.body`, so `X` cannot
 * take it off screen. That is not incidental here, it is the whole point --
 * **this button is the way back to the controls for someone whose app is
 * struggling**, and the panels start hidden (`startHidden: true` in `main.ts`).
 * A counter that disappeared with the panels would vanish in exactly the state
 * it exists to serve.
 *
 * The `showFpsCounter` preference is the honest way to turn it off, and it is
 * a different gesture from `X`: one says "let me look at the picture for a
 * moment", the other says "I do not want this readout". Conflating them would
 * mean the only way to dismiss the counter permanently also dismissed the panel.
 *
 * ## Where it sits
 *
 * Top-right, which is the one free corner: the menu bar is pinned top-left, the
 * mutation overlay is centred and capped at 420px, and the right panel starts at
 * `PANEL_TOP_PX` (113). This sits above that, in the 8px..~40px band the panel
 * deliberately leaves clear.
 *
 * **It overlaps nothing even when the panels are shown**, because the right
 * panel's own top edge is below it. Verified against `sideContainer`'s geometry
 * rather than assumed -- if `PANEL_TOP_PX` ever drops below ~44 these two
 * collide, which is what the constant's own docstring is warning about.
 *
 * ## `pointer-events`
 *
 * The button is clickable, unlike the tooltip and the recording strip. That is
 * safe because `inputBinding.ts` decides canvas capture with
 * `event.target !== canvas` -- a click that lands here is meant for here, and a
 * click anywhere else still reaches the simulation. The button blurs itself
 * afterwards, like every other button in this interface, so the hotkeys keep
 * working.
 */

import {
  type Band,
  BAND_COLOR,
  BAND_DESCRIPTION,
  BAND_TOOLTIP,
  startBand,
} from '../perf/fpsBand.ts';

export interface FpsCounterOptions {
  /**
   * Bring up the performance-critical settings.
   *
   * A CALLBACK RATHER THAN A COMMAND, for the reason `MutationOverlay`'s
   * `onToggleUi` is one: revealing the panels and choosing a tab is the panel's
   * own business and deliberately never reaches the Orchestrator. This lands on
   * `Panel.showPerformanceSettings`, which is the same path Export Video's menu
   * item takes to its own tab.
   */
  readonly onClick: () => void;
  /** Where to mount. Defaults to `document.body`. */
  readonly container?: HTMLElement;
}

export class FpsCounter {
  private readonly root: HTMLButtonElement;

  /**
   * What was last written to the DOM, so `update` can skip the common case.
   *
   * This runs every frame, and rewriting a colour, a label and two attributes
   * sixty times a second to say what they already say is the waste every guard
   * in `mutationOverlay.ts` avoids. `null` before the first write, so the first
   * frame always paints.
   */
  private shown: string | null = null;

  /**
   * Whether the badge is currently displayed, or `null` before the first write.
   *
   * **`null` RATHER THAN `true`, and that is the whole bug this field once had.**
   * Seeding it to `true` is a claim about the DOM that nothing has written yet,
   * and the claim is only accidentally right: the first `update` of a session
   * arrives with `enabled: false` -- the readout is still in warmup, so
   * `Panel.refresh` passes a null `fps` -- which flips this to `false` and hides
   * the element. Turning the PREFERENCE off later then found `enabled` already
   * equal to `visible`, skipped the write, and left the badge on screen.
   *
   * A three-state field makes the first call always write, which is the same
   * bargain `shown` and `mutationOverlay.ts`'s `generatedShown` make and for the
   * same reason: a guard must never start out asserting something it has not
   * done.
   */
  private visible: boolean | null = null;

  constructor(opts: FpsCounterOptions) {
    this.root = document.createElement('button');
    this.root.type = 'button';
    this.root.id = 'fluoddity-fps';
    this.root.style.cssText = ROOT_CSS;
    // The stable hook, following `controls.ts`'s `data-setting` convention:
    // Tweakpane's own class names are minified, so every UI check in `tools/`
    // queries by these rather than guessing at a build artifact.
    this.root.dataset['setting'] = 'transport.fps';

    this.root.addEventListener('click', () => {
      opts.onClick();
      // Hands the keyboard straight back, exactly as the gear and the tool
      // select do -- a focused button would swallow Space and re-fire itself.
      this.root.blur();
    });

    // Seeded from the same starting state `startBand()` uses, so the badge has a
    // face from its first painted frame. Without this it would exist as an empty
    // plate for the warmup window -- `update` deliberately refuses to write an
    // empty readout, so nothing else would fill it.
    const initial = startBand();
    this.update(initial.band, initial.readout, true);

    (opts.container ?? document.body).append(this.root);
  }

  /**
   * Push this frame's band and readout in.
   *
   * `enabled` is the `showFpsCounter` preference. Hiding is `display:none`
   * rather than removal, so the element and its listener survive being turned
   * off and on again -- the same bargain `Panel.applyHidden` makes.
   */
  update(band: Band, readout: string, enabled: boolean): void {
    if (enabled !== this.visible) {
      this.visible = enabled;
      // `inline-flex` RESTATED rather than `''`, for the reason
      // `mutationOverlay.ts` spells out at its stepper: the layout lives in an
      // inline style set from `cssText`, and `''` would REMOVE the property
      // rather than revert it -- leaving a `<button>` at its default `inline`,
      // which collapses the centring this relies on.
      this.root.style.display = enabled ? 'inline-flex' : 'none';
    }
    if (!enabled) return;

    // An empty readout means there is no measurement to show -- a Panel built
    // with no frame loop behind it (the DOM tests) passes one. Keep whatever is
    // already there rather than blanking the badge into an empty plate, which
    // would look like a rendering fault rather than like "no data".
    if (readout === '') return;

    const key = `${band}:${readout}`;
    if (key === this.shown) return;
    this.shown = key;

    this.root.textContent = readout;
    this.root.style.color = BAND_COLOR[band];
    // The border follows the text at low alpha, so the whole badge reads as one
    // colour without the fill competing with the artwork behind it.
    this.root.style.borderColor = borderFor(band);

    // COLOUR IS NEVER THE ONLY SIGNAL. The number differs per band already, and
    // the state is stated in words here for a screen reader and for anyone who
    // cannot distinguish the four fills -- the rule the gear and the cohort
    // fences already follow in `mutationOverlay.ts`.
    this.root.title = BAND_TOOLTIP[band];
    this.root.setAttribute(
      'aria-label',
      `${readout} frames per second — ${BAND_DESCRIPTION[band]}. ` +
        'Show the performance settings.',
    );
  }

  dispose(): void {
    this.root.remove();
  }
}

/** The band colour at the alpha the border wants. */
function borderFor(band: Band): string {
  // The palette is `#rrggbb`, so an 8-digit hex is the shortest way to say
  // "this colour at 40%" without parsing it into components.
  return `${BAND_COLOR[band]}66`;
}

/**
 * Top-right, above where the right panel begins.
 *
 * `z-index:45` puts it over the panels (20) and the recording bar (40) but
 * under the menu bar's dropdowns (50/60), so an open menu is never obscured by
 * a readout.
 *
 * Tabular figures, because the width must not jitter: without them "111" and
 * "60" are different widths in a proportional face, and a badge that resizes
 * every time the number changes is exactly the distraction the debounce exists
 * to prevent.
 */
const ROOT_CSS =
  'position:fixed;top:8px;right:8px;z-index:45;' +
  'display:inline-flex;align-items:center;justify-content:center;' +
  'min-width:46px;padding:4px 9px;border-radius:5px;cursor:pointer;' +
  'background:rgba(28,28,30,0.92);border:1px solid rgba(255,255,255,0.12);' +
  'box-shadow:0 2px 10px rgba(0,0,0,0.4);' +
  'font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;' +
  'font-variant-numeric:tabular-nums;' +
  // Matches the tooltip and the recording bar: the readout changes on its own
  // schedule, and a text-selection highlight on a number nobody is trying to
  // copy is noise.
  'user-select:none;';
