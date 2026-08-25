/**
 * Physics Rate, as a collapsible vertical slider at the right edge.
 *
 * A round fast-forward button with a vertical track folded out of it. The
 * button toggles the track, and both of them carry the band colour the FPS
 * counter is showing -- so the control that COSTS the frame rate and the
 * readout that REPORTS it say the same thing at the same time.
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
 * Hard against the RIGHT EDGE in both layouts. Which VERTICAL end it takes is
 * the one real difference between them, and the button always sits on the
 * anchored end so that folding the track cannot move it:
 *
 *   - DESKTOP: TOP-right, button above and track hanging below. It goes as far
 *     up as it can, stopping under whatever is already in that column -- see
 *     `physicsSliderTop`, which is measured per frame rather than fixed,
 *     because both of the things it stops under are optional and both move.
 *   - TOUCH: BOTTOM-right, track above and button below, lifted clear of the
 *     control bar by `--fluoddity-bar-height` -- the variable
 *     `MutationOverlay.publishHeight` maintains for exactly this kind of
 *     question. The bar's height changes with the hint row's contents and with
 *     the safe-area inset, so a literal would be wrong on most devices and
 *     would put this on top of the undo button. The fallback is generous rather
 *     than tight, for the reason `sideContainer` gives: too much clearance
 *     costs a little space, too little hides a control.
 *
 * **The bottom is right for a phone for the same reason the top is right for a
 * desktop**: the control bar already owns the bottom of a phone screen because
 * that is where thumbs reach, while on a desktop the bottom-right corner is
 * merely empty and the top-right is where this control's own readout -- the FPS
 * badge -- already lives.
 *
 * **ONLY THE DESKTOP NEEDS A RESIZE LISTENER.** The touch placement is a
 * `calc()` in the inline style, so it re-evaluates by itself whenever the
 * overlay republishes the variable, and the overlay already republishes on
 * resize, on rotation and on every reflow of its hint row. The desktop
 * placement is a measurement, and measurements go stale -- see `reposition`.
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
import { bindFocusRelease } from './focusRelease.ts';
import { PREFS, settingFor } from './settingsSpec.ts';
import { Tooltip } from './tooltip.ts';

export interface PhysicsSliderOptions {
  readonly send: (command: Command) => void;
  /** Build the touch layout. Defaults to false. See the header on placement. */
  readonly mobile?: boolean;
  /** Where to mount. Defaults to `document.body`. */
  readonly container?: HTMLElement;
  /**
   * Start (or stop) an auto-calibration run. The right-click.
   *
   * **A CALLBACK RATHER THAN A COMMAND**, unlike everything else this control
   * does. A run is not a value to edit: it is a multi-second, frame-driven
   * search that `Panel` owns outright -- it holds the `AutoCalibration`, feeds
   * it from the frame loop, and takes and restores the pause around it. There
   * is no command on the bus that starts one, and inventing one would put a
   * second driver beside the panel's.
   *
   * Toggles: called while a run is going, it stops it. That is what makes the
   * gesture safe to press twice, and it matches the Preferences button, which
   * is the same run started from the other end.
   *
   * Optional, so a `PhysicsSlider` built without a panel behind it -- the DOM
   * tests do exactly this -- simply has an inert right-click rather than
   * needing a stub.
   */
  readonly onCalibrate?: () => void;
}

export class PhysicsSlider {
  private readonly root: HTMLElement;
  /** The track's wrapper, shown and hidden by the button. Holds the readout. */
  private readonly trackGroup: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly readout: HTMLElement;
  private readonly button: HTMLButtonElement;
  /** The mark itself, so `paint` can tint the glyph rather than the plate. */
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

  /**
   * Teardown for the focus-release listeners. See where it is bound.
   *
   * The same field `MutationOverlay` keeps for its own binding, and for the
   * same reason: this control lives outside both panel containers, so the
   * panel's bindings cannot cover it and it owns its own.
   */
  private readonly releaseFocus: () => void;

  /** Teardown for the desktop resize listener. A no-op on touch. */
  private readonly releaseResize: () => void;

  /**
   * Whether this was built for touch. Fixed at construction.
   *
   * The layout branches happen ONCE in the constructor and need no field. This
   * exists for `reposition`, whose entire job is a desktop concern -- the same
   * reason `MutationOverlay` keeps its own `mobile`.
   */
  private readonly mobile: boolean;

  /**
   * The `top` last written, or `null` before the first placement.
   *
   * Guards the write the way every other per-frame guard in this file does:
   * `reposition` runs each frame, the answer changes only when the window is
   * resized or the bar reflows, and assigning an identical `style.top` sixty
   * times a second is waste. `null` so the first frame always paints.
   */
  private topShown: number | null = null;

  constructor(opts: PhysicsSliderOptions) {
    const mobile = opts.mobile ?? false;
    this.mobile = mobile;
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
    // The overlap, on whichever side faces the button -- see `TRACK_GROUP_CSS`.
    // Appended after the shared block so it wins, in the same way `ROOT_CSS`
    // takes its `display` override.
    this.trackGroup.style.cssText =
      TRACK_GROUP_CSS +
      (mobile
        ? `margin-bottom:-${String(OVERLAP_PX)}px;`
        : `margin-top:-${String(OVERLAP_PX)}px;`);
    this.trackGroup.append(this.readout, this.slider);

    // --- the fast-forward button ---------------------------------------------------------

    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.style.cssText = BUTTON_CSS;
    this.button.dataset['setting'] = 'prefs.physicsSliderOpen';
    this.icon = fastForwardIcon();
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

    // **ON BOTH HALVES, and that is the point of the overlap made verbal.** The
    // help hung off the button alone, so hovering the track -- the part someone
    // reaches for when they want to know what it does -- explained nothing. One
    // source object attached twice, so the two can never drift apart.
    //
    // A LIVE SOURCE, because which way the toggle goes changes under the user.
    // A fixed string would describe the state the control was built in.
    //
    // The help text is stated HERE rather than taken from `setting.help`: the
    // registry's copy has to make sense in a row of Preferences blades, where
    // there is no fast-forward icon to point at and no right-click to describe.
    // This one is about THIS widget. The `(Expensive)` prefix is kept in step
    // with the registry's by hand, which is the same bargain every other piece
    // of widget-specific copy in this interface makes.
    const help = (): { title: string; body: string } => ({
      title: '(Expensive) Global Simulation speed',
      body:
        'Determines how many physics updates occur per frame. ' +
        'Click the fastforward icon to hide this slider. ' +
        'Right click it to auto-calibrate physics speed.',
    });
    this.tooltip.attach(this.button, help);
    this.tooltip.attach(this.slider, help);

    // --- right-click to auto-calibrate ---------------------------------------
    //
    // **ON BOTH HALVES, like the tooltip that advertises it.** The tooltip names
    // the icon, because that is the unambiguous thing to point at in a sentence
    // -- but someone who has just read it with the cursor over the track should
    // not have to travel to act on it. Binding the pair costs one listener and
    // removes the only way to follow the instruction and have nothing happen.
    //
    // `preventDefault` on BOTH, unconditionally: this is the gesture's own
    // element, so the browser menu is never what the user wanted here. It is
    // called even when `onCalibrate` is absent, so a control built without a
    // panel behind it suppresses the menu rather than half-implementing the
    // gesture.
    //
    // **NOT `pointerdown` WITH `button === 2`.** `contextmenu` is the event that
    // survives the platform differences that matter -- it is what a Ctrl-click
    // raises on a Mac and what a long press raises on touch -- so one binding
    // covers all three gestures that mean "the other click".
    const onContextMenu = (ev: MouseEvent): void => {
      ev.preventDefault();
      opts.onCalibrate?.();
    };
    this.button.addEventListener('contextmenu', onContextMenu);
    this.slider.addEventListener('contextmenu', onContextMenu);

    // **THE BUTTON GOES ON THE ANCHORED END, and the two layouts anchor
    // opposite ends.** The button is the part that is always present, so
    // whichever edge is pinned must be its edge: then folding the track away
    // leaves the button exactly where it was, and the collapse reads as the
    // track folding INTO the button rather than as the whole control jumping
    // across the screen.
    //
    //   DESKTOP  pinned by `top`, so button first and the track hangs below.
    //   TOUCH    pinned by `bottom`, so the track is first and grows upward.
    if (mobile) {
      this.root.append(this.trackGroup, this.button);
    } else {
      this.root.append(this.button, this.trackGroup);
    }
    (opts.container ?? document.body).append(this.root);

    // **HANDS THE KEYBOARD BACK AFTER A DRAG.** A native `<input type=range>`
    // keeps focus once dragged, exactly as a Tweakpane track does, and would
    // then swallow every hotkey -- and worse than swallow them: the arrow keys
    // on a focused range MOVE THE SLIDER, so someone who dragged the rate and
    // then reached for a key would silently edit the rate again.
    //
    // Its OWN binding, because this control deliberately lives outside both
    // panel containers and the panel's two bindings cannot reach it. Exactly
    // what `mutationOverlay.ts` does with its own root, and for the same
    // reason -- the delegate stamps the container and tests membership at
    // event time, so the button below is covered by the same call.
    this.releaseFocus = bindFocusRelease(this.root);

    // Seeded from the same starting state the badge uses, so the mark has a
    // colour from its first painted frame rather than being a bare plate until
    // the first measurement lands.
    this.paint(startBand().band);

    // AFTER the mount, or it measures as a zero rect. Desktop only -- the touch
    // placement is a `calc()` that needs no measuring at all.
    //
    // The RESIZE listener is what the touch layout does not need: this one
    // depends on where the mutation bar ends up, and the bar re-centres itself
    // on every resize. `refresh` covers the ordinary case per frame; this
    // covers a resize that lands while the panels are shown, when `Panel` skips
    // this control's refresh entirely and the last measurement would otherwise
    // be the one from before the window changed.
    if (!mobile) {
      this.reposition();
      const onResize = (): void => {
        this.reposition();
      };
      window.addEventListener('resize', onResize);
      this.releaseResize = (): void => {
        window.removeEventListener('resize', onResize);
      };
    } else {
      this.releaseResize = (): void => {
        /* nothing bound: the touch placement is pure CSS */
      };
    }

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

    // Per frame, because what is above this moves: the badge appears and
    // disappears with its preference, and the mutation bar re-centres and
    // changes height as its own contents change. Guarded on the resulting `top`,
    // so the common frame writes nothing.
    this.reposition();

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
    this.releaseResize();
    this.releaseFocus();
    // Its element is on `document.body`, not inside `root`.
    this.tooltip.dispose();
    this.root.remove();
  }

  /** Tint the mark for `band`, skipping the write when nothing moved. */
  private paint(band: Band): void {
    if (band === this.bandShown) return;
    this.bandShown = band;

    // `BAND_COLOR`, the PALE ramp -- not `BAND_LABEL_COLOR`. This sits over the
    // artwork exactly as the badge does, and the saturated ramp exists for
    // labels in a panel beside a column of grey ones. See both constants.
    const color = BAND_COLOR[band];
    this.button.style.color = color;
    this.button.style.borderColor = `${color}66`;

    // **THE TRACK FOLLOWS THE BAND TOO**, so the whole control says one thing
    // rather than a coloured button attached to a neutral slider.
    //
    // `accent-color` rather than custom pseudo-element rules: it tints the
    // thumb AND the filled portion of the track in one property, it is what the
    // platform already uses for a native range, and it is settable INLINE --
    // `::-webkit-slider-runnable-track` is not, so the alternative is injecting
    // a stylesheet and keeping its rules in step with this palette. The empty
    // groove stays neutral, which is what keeps the fill legible as a level.
    this.slider.style.accentColor = color;
    this.writeLabel();
  }

  /**
   * Place the desktop control under whatever is above it in its column.
   *
   * A no-op on touch, where `TOUCH_ROOT_CSS`'s `calc()` is the whole answer and
   * there is nothing to measure. The geometry itself is `physicsSliderTop`,
   * which is pure and unit-tested; this is only the part that reads the DOM.
   *
   * **THE ELEMENTS ARE LOOKED UP BY ID EACH TIME rather than held.** Both are
   * owned by other components with their own lifetimes -- the badge follows a
   * preference and the bar outlives panel rebuilds -- so a cached reference
   * could point at a detached node and quietly place this against a rectangle
   * that is no longer on screen. Two `getElementById` calls per frame is the
   * cheaper mistake.
   *
   * The badge is skipped when `display:none`, because a hidden element still
   * reports a real-looking rect from `getBoundingClientRect` if it has ever
   * been laid out -- which would reserve a gap for a badge the user turned off.
   * That is exactly how `FpsCounter` hides itself, so this is the check that
   * makes "rise to the top when the badge is off" actually happen.
   */
  private reposition(): void {
    if (this.mobile) return;

    // **THE CONTROL ROW, NOT THE WHOLE OVERLAY.** `#fluoddity-mutation` holds
    // two rows -- the controls and the context hint beneath them -- so its rect
    // spans both, and measuring it would push this control down by the height
    // of a sentence. That sentence changes with the tool and the selection and
    // wraps on a narrow window, so the slider would visibly hop whenever the
    // hint grew a line.
    //
    // Dodging the hint buys nothing anyway: the hint row is centred and this is
    // pinned right, so on any window wide enough to be running the desktop
    // layout at all they do not meet. A window narrow enough for them to
    // collide is one the touch layout should be handling.
    //
    // Falls back to the ROOT when the bar cannot be found, rather than to null:
    // a missing id should cost the precision, not the collision avoidance.
    const bar =
      document.getElementById('fluoddity-mutation-bar') ??
      document.getElementById('fluoddity-mutation');
    const badge = document.getElementById('fluoddity-fps');
    const top = physicsSliderTop(
      this.root.getBoundingClientRect(),
      bar === null ? null : bar.getBoundingClientRect(),
      badge === null || badge.style.display === 'none'
        ? null
        : badge.getBoundingClientRect(),
    );

    if (this.topShown === top) return;
    this.topShown = top;
    this.root.style.top = `${String(top)}px`;
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

  /**
   * Write the number above the track, remembering it for the frame guard.
   *
   * **THE `x` IS WHAT MAKES IT A MULTIPLIER RATHER THAN A COUNT.** Bare, this
   * is a number in a plate directly below the FPS badge -- another number in a
   * plate, in the same column, in the same monospace face -- and nothing said
   * that one was a rate per second and this one a multiple of the frame. `20x`
   * reads as a speed the way `20` never did.
   */
  private writeReadout(value: number): void {
    this.valueShown = value;
    this.readout.textContent = `${String(Math.round(value))}x`;
  }
}

/**
 * A rectangle, as much of one as `physicsSliderTop` reads.
 *
 * Structurally compatible with `DOMRect`, so callers hand one straight in. Its
 * own type so the geometry can be tested under `node --test`, where `DOMRect`
 * does not exist -- exactly the bargain `mutationOverlay.ts`'s `Rect` makes,
 * and deliberately a separate declaration: that one reads `left`/`right` for a
 * horizontal-overlap test and this one reads `bottom` for a stacking test, so
 * sharing a type would over-specify both.
 */
export interface VerticalRect {
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
}

/** Breathing room under whatever this control is stacking beneath. */
const STACK_GAP_PX = 6;

/**
 * Where the desktop control's top edge goes, given what is above it.
 *
 * ## Why this is measured rather than a constant
 *
 * The brief is a priority list, and every rung of it depends on what is
 * actually on screen: go as far up as possible, but stop below the mutation bar
 * if that bar would be in the way, and stop below the FPS badge if it is
 * present. Both of those are optional and both move -- the badge follows a
 * preference, and the bar's height changes with its hint row -- so a literal
 * would be wrong in most configurations.
 *
 * ## The rules, in order
 *
 *   1. **The mutation bar's CONTROL ROW, and only if it OVERLAPS
 *      HORIZONTALLY.** The bar is centred and sized by its contents; this
 *      control is pinned to the right edge. On a wide window they do not
 *      overlap at all, and dropping below a bar that is nowhere near this
 *      column would spend vertical space to buy nothing -- the same reasoning,
 *      and the same test, that `overlayTop` uses for the bar against the menu
 *      bar.
 *
 *      **The CONTEXT HINT ROW beneath those controls is deliberately not
 *      dodged**, which is why `reposition` measures `#fluoddity-mutation-bar`
 *      rather than the overlay root that contains both. See it for why.
 *   2. **The FPS badge**, which is always in this column when it exists (both
 *      are pinned `right:8px`), so no overlap test is needed -- its presence is
 *      the whole condition.
 *   3. **Neither**: go to the top margin.
 *
 * Rule 1 wins over rule 2 when both apply, because the bar hangs lower than the
 * badge; taking the larger of the two candidates is what makes the order
 * irrelevant to the answer and the function total.
 *
 * ## Degrading
 *
 * A `null` rect means "not on screen", and a zero-width one (`right <= left`)
 * is what an unlaid-out or hidden element measures as. Both are treated as
 * absent rather than as an obstacle at the origin -- the failure that matters
 * is landing ON another control, and an absent element cannot be collided with.
 */
export function physicsSliderTop(
  self: VerticalRect,
  bar: VerticalRect | null,
  badge: VerticalRect | null,
): number {
  let top = TOP_MARGIN_PX;

  // Rule 1. `self` is allowed to be zero-width on the very first frame -- a
  // control with no width overlaps nothing, and the next frame corrects it.
  if (bar !== null && bar.right > bar.left) {
    // STRICT INEQUALITIES, so edges that merely touch are not an overlap.
    const overlaps = self.left < bar.right && bar.left < self.right;
    if (overlaps) top = Math.max(top, Math.round(bar.bottom) + STACK_GAP_PX);
  }

  // Rule 2. No overlap test: the badge shares this control's column by
  // construction, so if it is on screen it is above this.
  if (badge !== null && badge.right > badge.left) {
    top = Math.max(top, Math.round(badge.bottom) + STACK_GAP_PX);
  }

  return top;
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
 * How large the mark is drawn, in CSS pixels.
 *
 * **26, not `ICON_BOX`'s 20.** The overlay's gear and fences sit in 24px square
 * buttons where 20 nearly fills the plate; this one sits in a 44px circle,
 * where the same 20 leaves a wide ring of empty chrome and the animal reads as
 * an afterthought rather than as the button's subject. 26 fills the circle at
 * roughly the same ratio the gear fills its own.
 */
const ICON_PX = 26;

/**
 * The fast-forward mark: two triangles pointing right, as `⏩` draws it.
 *
 * Drawn rather than set as a glyph, for the reason the gear and the fences are:
 * `⏩` renders in the platform's own colours -- a full-colour emoji on most
 * systems -- and would defeat the whole point of a button whose COLOUR is the
 * signal. `currentColor` on each triangle means `paint` tints the whole mark by
 * setting one property on the button.
 *
 * ## The shape, and the version that was wrong
 *
 * **Each triangle has a VERTICAL BACK EDGE and its apex at the vertical
 * MIDPOINT** -- isosceles, symmetric top to bottom, which is what makes it read
 * as an arrowhead. The three vertices are `(x, top)`, `(x, bottom)` and
 * `(x + w, middle)`.
 *
 * A first version read "right triangle, right angle facing right" literally and
 * put the apex at the BOTTOM corner: `(x,top) -> (x+w,bottom) -> (x,bottom)`.
 * Geometrically that is a right triangle whose square corner is on the right,
 * and it is not a fast-forward mark at all -- with the point below the centre
 * line each shape reads as a lean or a flag rather than as something aimed
 * rightward, and three of them together looked like tally marks. The reference
 * image settles it: the arrowheads point along the horizontal axis.
 *
 * ## Two, not three
 *
 * Matching the reference and the emoji it comes from. Three fitted the 20-unit
 * box only by being thin, and thin arrowheads at 26px on a dark plate lose
 * their silhouette -- the shape has to survive being small more than it has to
 * carry a count.
 */
function fastForwardIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${String(ICON_BOX)} ${String(ICON_BOX)}`);
  // Drawn LARGER than the coordinate space -- see `ICON_PX`. The viewBox scales
  // to fit, so the shape coordinates below stay on a readable 20-unit grid.
  svg.setAttribute('width', String(ICON_PX));
  svg.setAttribute('height', String(ICON_PX));
  svg.style.display = 'block';

  /**
   * One arrowhead's width and height, and the pitch between the two.
   *
   * Wider than tall is what the reference shows: these are broad heads, not
   * narrow darts. The gap is small enough that the pair reads as one mark.
   */
  const TRI_W = 7.6;
  const TRI_H = 13.2;
  const GAP = 0.9;

  // Centred by construction rather than by a tuned literal: the two shapes plus
  // their gap are this wide, so half the remainder is the left edge. The mark
  // has to sit dead centre in a round button, where an off-centre glyph is far
  // more visible than it would be in a rectangle.
  const totalW = TRI_W * 2 + GAP;
  const startX = (ICON_BOX - totalW) / 2;
  const top = (ICON_BOX - TRI_H) / 2;
  const middle = ICON_BOX / 2;

  for (let i = 0; i < 2; i++) {
    const x = startX + i * (TRI_W + GAP);
    const tri = document.createElementNS(SVG_NS, 'polygon');
    // Back edge top -> apex on the centre line -> back edge bottom. The first
    // and last share an `x` (the vertical back edge); the apex sits halfway
    // between their two `y`s, which is what makes it symmetric.
    tri.setAttribute(
      'points',
      `${String(x)},${String(top)} ` +
        `${String(x + TRI_W)},${String(middle)} ` +
        `${String(x)},${String(top + TRI_H)}`,
    );
    tri.setAttribute('fill', 'currentColor');
    svg.append(tri);
  }

  return svg;
}

// -- styling ----------------------------------------------------------------
//
// ## The layer, and why it is NOT the FPS counter's
//
// **`z-index:35`, deliberately BELOW the splash at 40.** This started at 45 to
// match `FpsCounter`, which was the wrong neighbour to copy: that badge is
// pinned above everything because it is the route back to the settings for
// someone whose app is struggling, and it is a 46px plate in a corner. This is
// a ~350px column, and at 45 it drew straight over the Welcome, Guide and
// Controls overlays -- all three are the same `#fluoddity-splash` element
// (`splash.ts`, `Variant`), so one number covers them.
//
// The ordering this sits in:
//
//   20  the panels                  -- above, so the slider is not buried
//   30  the mutation bar            -- above, and they never overlap anyway
//   35  THIS
//   40  the splash, toasts, tooltips, the recording bar
//   50  the menu bar
//   60  its dropdowns
//
// Being under 40 costs nothing real: the splash is modal and dismisses on any
// click, and while a toast or tooltip is up there is nothing to drag here.
//
// **The modal DIALOGS need no number at all.** Save, Delete and Reset are
// native `<dialog showModal()>`, which renders in the browser's top layer above
// every `z-index` there is -- `toast.ts` documents at length why trying to
// out-`z-index` that is a losing game. They were never the problem.
//
// `align-items:center` keeps the narrow track centred on the wider button in
// both layouts. What differs is which END is anchored and therefore which order
// the two children go in -- see each block.

/**
 * The stacking level for both layouts. See the table above.
 *
 * One constant rather than the number written twice, because the whole point of
 * it is a RELATIONSHIP to the splash -- and two copies is how one of them gets
 * nudged and the control starts drawing over the Guide again.
 */
const Z_INDEX = 35;

/**
 * TOP-right on the desktop, with the track hanging BELOW the button.
 *
 * **The reverse of the touch layout, and the child order reverses with it.**
 * The anchored end has to be the one the button is on, or collapsing the track
 * would move the button: anchored at the top, folding away a child BELOW the
 * button leaves the button exactly where it was, which is what makes the toggle
 * feel like it folds rather than like the whole control jumps.
 *
 * **`top` HERE IS ONLY THE STARTING VALUE.** `reposition` overwrites it every
 * frame from `physicsSliderTop`. What this declaration is for is the frame
 * before the first measurement, and it starts at the SAFE end -- below where
 * the FPS badge sits -- so a control that somehow never gets measured is merely
 * lower than it needs to be rather than sitting on top of the badge.
 */
const ROOT_CSS =
  `position:fixed;right:8px;top:44px;z-index:${String(Z_INDEX)};` +
  'display:flex;flex-direction:column;align-items:center;gap:8px;';

/**
 * Touch: BOTTOM-right, lifted clear of the control bar, track ABOVE the button.
 *
 * **Unchanged, and deliberately not moved with the desktop.** The desktop's
 * move to the top is about a corner the panels leave free; on a phone the
 * bottom is where thumbs reach, which is the same argument that put the control
 * bar down there in the first place. A top-anchored slider on a phone would be
 * the hardest place on the screen to drag.
 *
 * See the header on `--fluoddity-bar-height`. The `+8px` matches the gap the
 * settings sheet leaves above the same bar, so the two clear it identically.
 */
const TOUCH_ROOT_CSS =
  `position:fixed;right:8px;z-index:${String(Z_INDEX)};` +
  'bottom:calc(var(--fluoddity-bar-height, 190px) + 8px);' +
  'display:flex;flex-direction:column;align-items:center;gap:8px;';

/**
 * Where the desktop control sits when nothing is above it.
 *
 * 2px, matching `mutationOverlay.ts`'s own `TOP_MARGIN_PX` -- the two are the
 * only things that go hard against the top edge, and they should agree about
 * what "hard against" means.
 */
const TOP_MARGIN_PX = 2;

/**
 * How far the track plate tucks UNDER the button, in CSS pixels.
 *
 * **THE TWO READ AS ONE CONTROL ONLY IF THEY TOUCH.** Separated by the column's
 * 8px gap they were a round button with an unrelated plate floating near it, and
 * nothing said that pressing the one folded the other -- which is the entire
 * relationship the control is built around.
 *
 * 14 of the button's 44px radius-worth, so the plate reaches roughly a third of
 * the way into the circle: far enough to be unmistakably attached, not so far
 * that the fast-forward glyph starts to sit on the readout. It also swallows the
 * 8px gap, which is why the effective travel is 14 rather than 22.
 */
const OVERLAP_PX = 14;

/**
 * The track and its number, as a plate matching the badge's chrome.
 *
 * **THE NEGATIVE MARGIN IS THE OVERLAP** -- see `OVERLAP_PX`. It is applied on
 * the side facing the button, which differs per layout: the desktop stacks
 * button-then-track so the track pulls UP, and touch stacks track-then-button so
 * it pulls DOWN. `PhysicsSlider` appends the matching one, since a rule that
 * named a single side would tuck the plate the wrong way round on a phone.
 *
 * The button is raised above the plate rather than the other way about: the
 * plate's own shadow would otherwise fall across the glyph, and the circle is
 * the part that has to stay legible -- it is the only half of the control that
 * is on screen when the track is folded away.
 */
const TRACK_GROUP_CSS =
  'display:flex;flex-direction:column;align-items:center;gap:6px;' +
  'padding:10px 6px;border-radius:8px;' +
  'background:rgba(28,28,30,0.92);border:1px solid rgba(255,255,255,0.12);' +
  'box-shadow:0 2px 10px rgba(0,0,0,0.4);position:relative;z-index:0;';

/**
 * The vertical track. See the header on why it is `writing-mode` rather than
 * the removed `-webkit-appearance:slider-vertical`.
 *
 * **30x256, up from 24x128**: 25% wider and twice as tall, as asked. The height
 * is what the precision is made of -- 60 steps across 128px gave barely two
 * pixels per step, so a finger could not reliably pick a rate and the drag felt
 * coarse. At 256 each step is a comfortable target on both layouts, and the
 * extra width is what makes the track easy to land on in the first place.
 *
 * **NO `accent-color` HERE, deliberately.** It is written by `paint` from the
 * band, so a value in this block would be a second answer that the first frame
 * overwrites -- and would go stale the moment the palette moved. See `paint`.
 */
const SLIDER_CSS =
  'writing-mode:vertical-lr;direction:rtl;' +
  'width:30px;height:256px;margin:0;cursor:pointer;touch-action:none;';

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
 * The fast-forward button.
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
  'box-shadow:0 2px 10px rgba(0,0,0,0.4);user-select:none;' +
  // ABOVE the track plate, which tucks under it -- see `OVERLAP_PX`. Both a
  // `position` and a `z-index` are needed: `z-index` is ignored on a statically
  // positioned box, so without the `relative` the plate would paint over the
  // glyph in DOM order on the desktop, where the button comes first.
  'position:relative;z-index:1;';
