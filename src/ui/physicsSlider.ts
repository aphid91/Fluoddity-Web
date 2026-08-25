/**
 * Physics Rate, as a collapsible vertical slider at the right edge.
 *
 * A rabbit button with a track above it. The button toggles the track; its
 * colour is the band the FPS counter is showing, so the control that costs the
 * frame rate and the readout that reports it say the same thing at the same
 * time.
 *
 * ## Why this exists when Preferences already has the setting
 *
 * **It is the hidden-panels configuration, and nothing else.** Physics Rate is
 * one of the three settings that decide the frame rate (`perfLabels.ts`), and
 * the panels start hidden -- so the app's DEFAULT state has no way to reach the
 * most-reached-for performance knob without opening a panel, reading a column
 * of settings, and closing it again. That is a long way round for a control
 * someone adjusts while watching the artwork respond.
 *
 * So this is a second WIDGET for one field, not a second source of truth. The
 * bounds and label come from the registry entry (`prefs.physicsSteps`) rather
 * than being restated, and the value round-trips through the command bus, so
 * the two controls cannot disagree about the range or drift out of step. It is
 * the same bargain `mutationOverlay.ts` makes for Mutation Scale -- with the
 * difference that Mutation Scale is `panel: false` and has no panel row at all,
 * whereas this deliberately keeps its Preferences entry.
 *
 * ## Why it disappears when the panels appear
 *
 * The panels occupy this space, and Preferences carries the same setting as a
 * dedicated slider a few rows down. Leaving this on screen would put two live
 * controls for one field within an inch of each other -- which is not merely
 * redundant but actively confusing, since a drag on one silently moves the
 * other. `Panel.applyHidden` is the single chokepoint every hide route passes
 * through, so this is told there, INVERTED: shown when the panels are hidden.
 *
 * That is the opposite polarity from `FpsCounter`, which is deliberately NOT
 * hidden by `X` because it is the route back to the settings. This one is not a
 * route back to anything -- it IS one of those settings -- so it has no reason
 * to survive a state that displays it properly.
 *
 * ## Where it sits
 *
 * Bottom-right on both layouts, and the two differ only in how far up:
 *
 *   - DESKTOP: `bottom:8px`, the free corner. The right panel is gone whenever
 *     this is visible, so nothing competes for it.
 *   - TOUCH: above the control bar, read from `--fluoddity-bar-height` -- the
 *     variable `MutationOverlay.publishHeight` maintains for exactly this kind
 *     of question. The bar's height changes with the hint row's contents and
 *     with the safe-area inset, so a literal would be wrong on most devices and
 *     would put this on top of the undo button. The fallback is generous rather
 *     than tight, for the reason `sideContainer` gives: too much clearance
 *     costs a little space, too little hides a control.
 *
 * **THE TOUCH PLACEMENT NEEDS NO RESIZE LISTENER**, which is worth stating
 * because every other floating element here has one. The `calc()` lives in the
 * inline style rather than being resolved in JavaScript, so it re-evaluates by
 * itself whenever the overlay republishes the variable -- and the overlay
 * already republishes on resize, on rotation and on every reflow of its hint
 * row. Reading the variable here instead would mean re-reading it on all three,
 * which is a listener to duplicate a job CSS does for free.
 *
 * ## The vertical track
 *
 * `writing-mode:vertical-lr` plus `direction:rtl`, which is the standardised
 * way to turn a range input vertical -- and deliberately NOT the older
 * `-webkit-appearance:slider-vertical`, which is removed in Chrome 121+ and
 * would silently render a horizontal slider in a column-shaped box. `direction`
 * is what puts the maximum at the TOP; without it the track runs upside down,
 * which no vertical rate control should.
 */

import { type Command, type Status } from '../orchestrator/commands.ts';
import { type Band, BAND_COLOR, BAND_DESCRIPTION, startBand } from '../perf/fpsBand.ts';
import { PREFS, settingFor } from './settingsSpec.ts';
import { Tooltip } from './tooltip.ts';

export interface PhysicsSliderOptions {
  readonly send: (command: Command) => void;
  /** Build the touch layout. Defaults to false. See the header on placement. */
  readonly mobile?: boolean;
  /** Where to mount. Defaults to `document.body`. */
  readonly container?: HTMLElement;
}

export class PhysicsSlider {
  private readonly root: HTMLElement;
  /** The track's wrapper, shown and hidden by the rabbit. Holds the readout. */
  private readonly trackGroup: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly readout: HTMLElement;
  private readonly button: HTMLButtonElement;
  /** The rabbit itself, so `paint` can tint the glyph rather than the plate. */
  private readonly icon: SVGSVGElement;

  private readonly tooltip: Tooltip;

  /**
   * The band last painted, or `null` before the first write.
   *
   * The same three-state guard `FpsCounter.visible` documents at length: a
   * guard must never start out asserting something it has not done. Seeded from
   * `startBand()` in the constructor via a real `paint` call, so the button has
   * a face from its first frame rather than being an untinted plate for the
   * warmup window.
   */
  private bandShown: Band | null = null;

  /** What the readout last said, so the per-frame refresh can skip the common case. */
  private valueShown: number | null = null;

  /** Whether the track is expanded. Mirrors the preference; see `setOpen`. */
  private open = true;

  /**
   * Whether the PANELS are hidden, or `null` before the first write.
   *
   * **`null` RATHER THAN `false`, and it is the same bug `FpsCounter.visible`
   * documents.** `false` would be a claim about the DOM that nothing has
   * written -- and here it is a claim that contradicts the stylesheet, since
   * `ROOT_CSS` mounts the element visible while `false` means "the panels are
   * showing, so I am hidden". Worse, `Panel` calls `applyHidden` at
   * construction ONLY when it starts hidden, so on an un-hidden start the first
   * real call would find `false === false`, skip the write, and leave a slider
   * on screen next to the panel it is meant to yield to.
   *
   * Three states make the first call always write, whichever way it goes.
   */
  private uiHidden: boolean | null = null;

  /**
   * True between pointerdown and pointerup on the track.
   *
   * `refresh` runs every frame and writes the authoritative value in, which
   * would fight a thumb under the finger -- the slider would snap back to last
   * frame's value mid-drag. The same guard, for the same reason, that
   * `mutationOverlay.ts` calls `dragging`.
   */
  private dragging = false;

  constructor(opts: PhysicsSliderOptions) {
    const mobile = opts.mobile ?? false;
    this.tooltip = new Tooltip(document.body, mobile);

    // Bounds from the registry, never restated -- so this and the Preferences
    // row cannot disagree about the range. Degrades to the declared 1..60
    // rather than to a slider with no range, for the reason `mutationOverlay`
    // falls back to 0..1: a renamed field should cost the bounds, not the
    // control.
    //
    // **`PREFS`, NOT `CONFIG`, and getting that wrong is nearly invisible.**
    // `settingFor` matches on BOTH source and field, so the wrong source
    // returns `null` -- and this file then degrades on it twice over: the
    // bounds fall back to exactly what the entry says anyway, so the slider
    // still LOOKS right, while the `input` handler's null guard silently drops
    // every edit. The result is a control that renders perfectly and moves
    // nothing, which no unit test and no screenshot would catch.
    const setting = settingFor(PREFS, 'physicsSteps');
    const lo = setting?.lo ?? 1;
    const hi = setting?.hi ?? 60;

    this.root = document.createElement('div');
    this.root.id = 'fluoddity-physics';
    // **MOUNTED HIDDEN.** The element only belongs on screen once something has
    // told it the panels are hidden, so starting visible would flash a slider
    // beside an open panel for the frames before the first call. Starting
    // hidden fails the safe way round: the worst case is a control that appears
    // a frame late. `Panel` seeds it unconditionally right after construction.
    //
    // `display` is appended AFTER the shared block so it wins, and `setUiHidden`
    // overwrites just that one property -- the flex column, the anchoring and
    // the z-index all stay where `cssText` put them.
    this.root.style.cssText = `${mobile ? TOUCH_ROOT_CSS : ROOT_CSS}display:none;`;

    // --- the readout, above the track ---------------------------------------
    //
    // The one thing a slider POSITION genuinely cannot tell you. It is here
    // rather than on the button because the button is a 44px circle that
    // already carries a glyph and a colour, and a number crammed beside those
    // would compete with the FPS badge -- which is itself a number in a
    // coloured plate a few hundred pixels up the same edge.
    this.readout = document.createElement('div');
    this.readout.style.cssText = READOUT_CSS;

    this.slider = document.createElement('input');
    this.slider.type = 'range';
    this.slider.min = String(lo);
    this.slider.max = String(hi);
    // INTEGER STEPS, because the field is `kind: INT` in the registry and the
    // shader runs a whole number of substeps. A fractional value here would be
    // coerced on the way through `editSetting` and the thumb would then jump to
    // somewhere the user did not put it.
    this.slider.step = '1';
    this.slider.style.cssText = SLIDER_CSS;
    // The stable hook, following `controls.ts`'s convention. **It is the same
    // key the Preferences blade carries, and that is load-bearing rather than
    // incidental**: `watchPerfDrag` tests this attribute at event time to decide
    // whether to suspend the band's dwell, so tagging it identically is what
    // makes a drag here feel like a drag there.
    this.slider.dataset['setting'] = 'prefs.physicsSteps';
    this.slider.setAttribute('aria-label', setting?.label ?? 'Physics Rate');

    this.trackGroup = document.createElement('div');
    this.trackGroup.style.cssText = TRACK_GROUP_CSS;
    this.trackGroup.append(this.readout, this.slider);

    // --- the rabbit ---------------------------------------------------------

    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.style.cssText = BUTTON_CSS;
    this.button.dataset['setting'] = 'prefs.physicsSliderOpen';
    this.icon = rabbitIcon();
    this.button.append(this.icon);

    this.button.addEventListener('click', () => {
      const next = !this.open;
      // BOTH, and in this order -- the same pairing `advancedToggle.ts` makes.
      // `setOpen` moves what is on screen; the command persists it. Dispatching
      // alone would leave the fold to arrive a frame later via `refresh`, and
      // folding alone would forget the choice on reload.
      this.setOpen(next);
      opts.send({ kind: 'editViewPref', field: 'physicsSliderOpen', value: next });
      // Hands the keyboard straight back, like every other button in this
      // interface -- a focused button would swallow Space and re-fire itself.
      this.button.blur();
    });

    // A LIVE SOURCE, because both halves of what this says change under the
    // user: which way the toggle goes, and what the rate currently is. A fixed
    // string would describe the state the control was built in.
    this.tooltip.attach(this.button, () => ({
      title: setting?.label ?? 'Physics Rate',
      body:
        `${setting?.help ?? ''}\n\n` +
        `${this.open ? 'Hide' : 'Show'} the rate slider. The colour matches the ` +
        'frame-rate counter, so a red rabbit means this is a good setting to ' +
        'turn down.',
    }));

    // TRACK ABOVE, BUTTON BELOW, as asked. The button is the part that is
    // always present, so it takes the anchored position and the track grows
    // upward out of it -- which is what makes the collapse read as folding into
    // the button rather than as the whole control jumping down the screen.
    this.root.append(this.trackGroup, this.button);
    (opts.container ?? document.body).append(this.root);

    // Seeded from the same starting state the badge uses, so the rabbit has a
    // colour from its first painted frame rather than being a bare plate until
    // the first measurement lands.
    this.paint(startBand().band);

    // --- events -------------------------------------------------------------

    // `input`, not `change`: `change` fires only on release, so the simulation
    // would not move until the drag ended -- and watching the result while
    // dragging is the entire reason this control is on the canvas.
    this.slider.addEventListener('input', () => {
      if (setting === null) return;
      const value = this.slider.valueAsNumber;
      this.writeReadout(value);
      opts.send({ kind: 'editSetting', setting, value });
    });

    this.slider.addEventListener('pointerdown', () => {
      this.dragging = true;
    });
    const release = (): void => {
      this.dragging = false;
    };
    this.slider.addEventListener('pointerup', release);
    // A drag interrupted by a context menu or a window switch never gets its
    // `pointerup`, and a stuck flag would freeze the readout permanently.
    this.slider.addEventListener('pointercancel', release);
    // A keyboard drag has no pointer events at all, and arrow keys on a focused
    // range fire `input` -- so blur is what ends that gesture.
    this.slider.addEventListener('blur', release);

  }

  /**
   * Push this frame's band and value in.
   *
   * Called from `Panel.refresh` ABOVE its hidden-panel early return, because
   * this control is visible precisely when the panels are not -- refreshing it
   * only while they show would freeze it in the one state it exists for.
   */
  refresh(status: Status, band: Band): void {
    this.paint(band);

    // **THE FOLD FOLLOWS THE PREFERENCE, not just the click.** The click
    // already called `setOpen`, so this is a no-op in the common case -- but it
    // is what carries the STORED state in at startup, and what puts the slider
    // back when `resetPreferences` returns the field to its default. Without
    // it, a reset would clear the preference while leaving the control folded,
    // and nothing would correct it until the next press.
    if (status.physicsSliderOpen !== this.open) this.setOpen(status.physicsSliderOpen);

    // NOT while dragging -- see the field. The readout is written by the drag
    // itself, so it stays live throughout.
    if (this.dragging) return;
    const value = status.physicsSteps;
    if (!Number.isFinite(value) || value === this.valueShown) return;
    this.slider.valueAsNumber = value;
    this.writeReadout(value);
  }

  /**
   * Fold or unfold the track, WITHOUT persisting the change.
   *
   * Split from the click handler for the reason `Panel.applyHidden` is split
   * from `setHidden`: `refresh` calls this to adopt the stored preference, and
   * a version that dispatched would write back the value it had just read --
   * once per frame, forever.
   */
  private setOpen(open: boolean): void {
    this.open = open;
    // `flex` RESTATED rather than `''`, for the reason `fpsCounter.ts` spells
    // out: the layout lives in an inline style set from `cssText`, and `''`
    // would REMOVE the property rather than revert it -- collapsing the column
    // this relies on.
    this.trackGroup.style.display = open ? 'flex' : 'none';
    this.button.setAttribute('aria-expanded', String(open));
    // The label names which way the toggle goes, so it has to be rewritten
    // here as well as in `paint` -- that one is guarded on the BAND and would
    // skip every fold that did not happen to coincide with a colour change.
    this.writeLabel();
  }

  /**
   * Show or hide the whole control, inverted against the panels.
   *
   * `hidden` is the PANELS' state, not this control's -- so it is deliberately
   * the same argument `Panel.applyHidden` receives, passed straight through.
   * See the header for why the polarity is opposite to `FpsCounter`'s.
   */
  setUiHidden(hidden: boolean): void {
    if (hidden === this.uiHidden) return;
    this.uiHidden = hidden;
    this.root.style.display = hidden ? 'flex' : 'none';
  }

  /**
   * The root element, for `watchPerfDrag` to bind to.
   *
   * Exposed for exactly one caller and deliberately read-only. The band's dwell
   * is suspended while a performance slider is being dragged (`perfLabels.ts`),
   * and that watcher binds to a CONTAINER rather than to blades so it survives
   * rebuilds -- this control lives outside both panel containers, so it has to
   * offer its own or the rule would simply not reach it.
   */
  get element(): HTMLElement {
    return this.root;
  }

  dispose(): void {
    // Its element is on `document.body`, not inside `root`.
    this.tooltip.dispose();
    this.root.remove();
  }

  /** Tint the rabbit for `band`, skipping the write when nothing moved. */
  private paint(band: Band): void {
    if (band === this.bandShown) return;
    this.bandShown = band;

    // `BAND_COLOR`, the PALE ramp -- not `BAND_LABEL_COLOR`. This sits over the
    // artwork exactly as the badge does, and the saturated ramp exists for
    // labels in a panel beside a column of grey ones. See both constants.
    const color = BAND_COLOR[band];
    this.button.style.color = color;
    this.button.style.borderColor = `${color}66`;
    this.writeLabel();
  }

  /**
   * Restate the button's accessible name, from the band and the fold.
   *
   * **COLOUR IS NEVER THE ONLY SIGNAL** -- the rule the badge and the mutation
   * overlay's fences already follow. The band is put into words for a screen
   * reader and for anyone who cannot distinguish the three fills, and the fold
   * is named because the button's own glyph does not change with it.
   *
   * One method rather than two writes, because both of its inputs change on
   * their own schedule and each caller guards on only one of them.
   */
  private writeLabel(): void {
    const band = this.bandShown;
    const state = band === null ? '' : ` — ${BAND_DESCRIPTION[band]}`;
    this.button.setAttribute(
      'aria-label',
      `Physics rate slider${state}. ${this.open ? 'Hide' : 'Show'} the slider.`,
    );
  }

  /** Write the number above the track, remembering it for the frame guard. */
  private writeReadout(value: number): void {
    this.valueShown = value;
    this.readout.textContent = String(Math.round(value));
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/**
 * The icon's coordinate space -- 20 units, as the overlay's own icons use.
 *
 * The DRAWN size is `ICON_PX`, which is larger: this is the grid the shapes are
 * placed on, not how big the glyph is on screen.
 */
const ICON_BOX = 20;

/**
 * How large the rabbit is drawn, in CSS pixels.
 *
 * **26, not `ICON_BOX`'s 20.** The overlay's gear and fences sit in 24px square
 * buttons where 20 nearly fills the plate; this one sits in a 44px circle,
 * where the same 20 leaves a wide ring of empty chrome and the animal reads as
 * an afterthought rather than as the button's subject. 26 fills the circle at
 * roughly the same ratio the gear fills its own.
 */
const ICON_PX = 26;

/**
 * A rabbit, in profile: two ears, a head, a body and a tail.
 *
 * Drawn rather than set as a glyph, for the reason the gear and the fences are:
 * an emoji renders in the platform's own colours and would defeat the whole
 * point of a button whose COLOUR is the signal. `currentColor` throughout means
 * `paint` tints the whole animal by setting one property on the button.
 *
 * Deliberately simple shapes at 20px. Anything more detailed reads as noise at
 * this size, and the silhouette -- long ears, round body -- is what carries the
 * meaning of "speed" here.
 *
 * **THE COORDINATES ARE TUNED AGAINST THE VISUAL CENTRE, not the viewBox one.**
 * A first pass placed the shapes by arithmetic around 10,10 and rendered
 * noticeably high and to the left in the 44px circle: the ears occupy the top
 * third but are NARROW, so the animal's centre of mass sits well below and
 * right of its bounding box's middle. That is only visible by looking at it
 * magnified, which is what `rabbit-zoom.png` in the check tooling is for.
 */
function rabbitIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${String(ICON_BOX)} ${String(ICON_BOX)}`);
  // Drawn LARGER than the coordinate space -- see `ICON_PX`. The viewBox scales
  // to fit, so the shape coordinates below stay on a readable 20-unit grid.
  svg.setAttribute('width', String(ICON_PX));
  svg.setAttribute('height', String(ICON_PX));
  svg.style.display = 'block';

  // The two ears, as rotated ellipses springing from the head. Drawn FIRST so
  // the head overlaps their base, which is what makes them read as attached
  // rather than as two shapes floating above a circle.
  for (const [cx, cy, angle] of [
    [6.6, 5.0, -13],
    [9.7, 4.7, 11],
  ] as const) {
    const ear = document.createElementNS(SVG_NS, 'ellipse');
    ear.setAttribute('cx', String(cx));
    ear.setAttribute('cy', String(cy));
    ear.setAttribute('rx', '1.45');
    ear.setAttribute('ry', '4.1');
    ear.setAttribute('fill', 'currentColor');
    ear.setAttribute(
      'transform',
      `rotate(${String(angle)} ${String(cx)} ${String(cy)})`,
    );
    svg.append(ear);
  }

  // The head.
  const head = document.createElementNS(SVG_NS, 'circle');
  head.setAttribute('cx', '8.0');
  head.setAttribute('cy', '10.7');
  head.setAttribute('r', '3.15');
  head.setAttribute('fill', 'currentColor');
  svg.append(head);

  // The body, an ellipse tilted back from the head so the whole animal leans
  // forward -- which is what suggests motion in a static silhouette.
  const body = document.createElementNS(SVG_NS, 'ellipse');
  body.setAttribute('cx', '12.0');
  body.setAttribute('cy', '13.8');
  body.setAttribute('rx', '4.7');
  body.setAttribute('ry', '3.7');
  body.setAttribute('fill', 'currentColor');
  body.setAttribute('transform', 'rotate(-12 12.0 13.8)');
  svg.append(body);

  // The tail, a small puff at the rear.
  const tail = document.createElementNS(SVG_NS, 'circle');
  tail.setAttribute('cx', '16.4');
  tail.setAttribute('cy', '12.3');
  tail.setAttribute('r', '1.65');
  tail.setAttribute('fill', 'currentColor');
  svg.append(tail);

  return svg;
}

// -- styling ----------------------------------------------------------------
//
// `z-index:45` matches the FPS counter: over the panels (20) and the recording
// bar (40), under the menu bar's dropdowns (50/60), so an open menu is never
// obscured. The two never overlap -- one is pinned to the top edge and this to
// the bottom -- so they can share a layer safely.
//
// The root is a COLUMN with the button last, so the track grows upward out of
// it. `align-items:center` keeps the narrow track centred on the wider button.

/** Bottom-right on the desktop: the free corner while the panels are hidden. */
const ROOT_CSS =
  'position:fixed;right:8px;bottom:8px;z-index:45;' +
  'display:flex;flex-direction:column;align-items:center;gap:8px;';

/**
 * Touch: the same corner, lifted clear of the control bar.
 *
 * See the header on `--fluoddity-bar-height`. The `+8px` matches the gap the
 * settings sheet leaves above the same bar, so the two clear it identically.
 */
const TOUCH_ROOT_CSS =
  'position:fixed;right:8px;z-index:45;' +
  'bottom:calc(var(--fluoddity-bar-height, 190px) + 8px);' +
  'display:flex;flex-direction:column;align-items:center;gap:8px;';

/** The track and its number, as a plate matching the badge's chrome. */
const TRACK_GROUP_CSS =
  'display:flex;flex-direction:column;align-items:center;gap:6px;' +
  'padding:10px 6px;border-radius:8px;' +
  'background:rgba(28,28,30,0.92);border:1px solid rgba(255,255,255,0.12);' +
  'box-shadow:0 2px 10px rgba(0,0,0,0.4);';

/**
 * The vertical track. See the header on why it is `writing-mode` rather than
 * the removed `-webkit-appearance:slider-vertical`.
 *
 * 128px is long enough to place a value in a 1..60 range with a finger and
 * short enough to leave the artwork visible on a phone in landscape.
 */
const SLIDER_CSS =
  'writing-mode:vertical-lr;direction:rtl;' +
  'width:24px;height:128px;margin:0;cursor:pointer;' +
  'accent-color:#a8dcb0;touch-action:none;';

/**
 * The number above the track.
 *
 * Tabular figures for the reason the badge uses them: without them the plate
 * would change width between "7" and "60", and a control that resizes as you
 * drag it is exactly the distraction to avoid.
 */
const READOUT_CSS =
  'min-width:20px;text-align:center;color:rgba(232,232,234,0.9);' +
  'font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;' +
  'font-variant-numeric:tabular-nums;user-select:none;';

/**
 * The rabbit button.
 *
 * **44px, which is the touch target minimum** `mutationOverlay.ts` settled on
 * for the two controls a touch session presses most -- and it is the same size
 * on the desktop, because "large-ish and round" is what the brief asks for and
 * a mouse loses nothing by being given a comfortable target.
 *
 * The FILL stays the dark chrome and only the GLYPH takes the band colour, so
 * the three states differ in a way that reads against the artwork without the
 * button becoming a saturated disc competing with the picture. The border
 * follows at low alpha, exactly as the badge's does.
 */
const BUTTON_CSS =
  'display:flex;align-items:center;justify-content:center;' +
  'width:44px;height:44px;padding:0;border-radius:50%;cursor:pointer;' +
  'background:rgba(28,28,30,0.92);border:1px solid rgba(255,255,255,0.12);' +
  'box-shadow:0 2px 10px rgba(0,0,0,0.4);user-select:none;';
