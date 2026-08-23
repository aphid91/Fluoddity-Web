/**
 * The delayed help tooltip.
 *
 * The port of `settings_window.py:_tooltip` (`:463-509`): a label, a rule, and
 * the setting's `help` text, shown after a hover delay and wrapped at a readable
 * width.
 *
 * Step 7 hung `help` off the DOM `title` attribute, which was free and better
 * than dropping it -- but a native `title` cannot be styled, cannot wrap where
 * we want, takes ~1s to appear with no control over the delay, and shows the raw
 * `\n\n` paragraph breaks as literal blank space in a single-line strip. The
 * help text is written in paragraphs and deserves to render as paragraphs.
 *
 * ## One element, not one per control
 *
 * Thirty-five controls with thirty-five hidden divs is thirty-five nodes doing
 * nothing. The DOM analogue of imgui's immediate-mode tooltip is a single
 * floating element that is repositioned and refilled on each hover, which is
 * what this is.
 *
 * ## `pointer-events: none` is load-bearing, not cosmetic
 *
 * `inputBinding.ts` decides canvas capture with `event.target !== canvas`, so
 * any element that can BE a target eats canvas input. The tooltip sits directly
 * under the cursor's path off a slider, and it has nothing clickable in it, so
 * it must never become a target. The desktop reaches the same conclusion through
 * imgui's `no_inputs` flag (`sensor_diagram.py:160-164`).
 *
 * It also means the tooltip cannot interfere with a drag in progress -- which is
 * what lets it stay up during one, unlike the desktop's, where a window
 * appearing mid-drag steals focus and imgui drops the drag.
 */

import { TAP_SLOP_PX } from './touchGestures.ts';

/**
 * Milliseconds of hover before the tooltip appears. imgui's `delay_normal`.
 *
 * DOUBLES AS THE LONG-PRESS DURATION on touch, deliberately: that gesture is
 * what REPLACES hover there, so the wait before help arrives should be the same
 * either way. `touchGestures.LONG_PRESS_MS` is the same number for the same
 * reason, and the two are independent only because one is about a UI affordance
 * and the other about a canvas gesture.
 */
const DELAY_MS = 500;

/**
 * The touch presentation: a fixed strip across the bottom of the screen.
 *
 * **NOT NEAR THE ANCHOR, WHICH IS THE WHOLE POINT.** A hover tooltip sits beside
 * the control because the cursor is there and the control is small. A
 * long-pressed one cannot: the finger is ON the control, and a box beside it
 * would be under the hand -- or under the palm, which is worse because the user
 * cannot tell it appeared at all.
 *
 * A fixed position also means it is always in the same place, so a user who has
 * done this once knows where to look, and it can be full-width rather than
 * capped at `WRAP_PX`, which matters because these help strings were written for
 * a 320px desktop column and read better across a phone.
 *
 * `bottom` CLEARS THE CONTROL BAR via the same variable the settings sheet uses
 * (`--fluoddity-bar-height`, published by `mutationOverlay.reposition`), so help
 * about a bar control never covers the control it describes.
 *
 * `pointer-events:none` is as load-bearing here as in the hover case -- see the
 * file header -- and additionally makes the dismiss listener simple: the tooltip
 * can never be the target of the tap that closes it.
 */
const TOUCH_TOOLTIP_CSS =
  'position:fixed;display:none;z-index:40;pointer-events:none;' +
  'left:8px;right:8px;bottom:calc(var(--fluoddity-bar-height, 190px) + 16px);' +
  'max-height:40vh;overflow:hidden;' +
  'padding:12px 14px;border-radius:8px;' +
  'background:rgba(28,28,30,0.97);color:#e8e8ea;' +
  'font:13px/1.5 system-ui,sans-serif;' +
  'box-shadow:0 4px 16px rgba(0,0,0,0.5);' +
  'border:1px solid rgba(255,255,255,0.12);';

/** Wrap width, matching the desktop's `push_text_wrap_pos(320.0)`. */
const WRAP_PX = 320;

/** Gap between the tooltip and the control it describes. */
const GAP_PX = 8;

export interface TooltipContent {
  readonly title: string;
  readonly body: string;
}

/**
 * Content, or a function returning it.
 *
 * **The function form exists for controls whose help depends on live state.**
 * The Reroll button explains WHY it is greyed and names the control that
 * un-greys it, and the Cohort Fences button reports whether the fences are
 * currently holding -- both change under the user without the element being
 * rebuilt. Fixed content captured at `attach` time would freeze the first
 * frame's wording and then describe the wrong state for the rest of the
 * session.
 *
 * Evaluated at SHOW time, not per frame: the tooltip is only ever read while it
 * is on screen, so there is nothing to gain from recomputing it sixty times a
 * second into an element nobody is looking at. That also means a caller can
 * build the string freely here without a per-frame guard, unlike everything
 * `refresh` touches.
 */
export type TooltipSource = TooltipContent | (() => TooltipContent);

/**
 * Which side of its anchor a tooltip prefers.
 *
 * **`'side'` IS THE DEFAULT AND STAYS THAT WAY.** It is right for the ~35 panel
 * controls this class was written for: they are narrow rows stacked in a 320px
 * column against the right edge, so the free space is horizontal and a tooltip
 * below a row would cover the rows under it -- the ones a user comparing
 * settings is reading.
 *
 * `'below'` is for WIDE anchors, where that reasoning inverts. A bar button
 * spanning several hundred pixels has its free space vertically, and a tooltip
 * beside it starts far from the label it explains and runs toward the screen
 * edge. Under the button it sits against the thing it describes.
 *
 * Both are PREFERENCES, not commands: each falls back to the other when the
 * preferred side does not fit, so neither can push the tooltip off screen.
 */
export type TooltipPlacement = 'side' | 'below';

/**
 * The shared tooltip element and its hover timer.
 *
 * One per panel. `attach` wires a control's element to it; the element is
 * created lazily so a panel that never shows a tooltip never adds a node.
 */
export class Tooltip {
  private element: HTMLElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly parent: HTMLElement;

  /**
   * Whether to use the touch affordance: long press to show, tap to dismiss.
   *
   * =====================================================================
   * WHY HOVER CANNOT SIMPLY BE LEFT ALONE ON TOUCH
   * =====================================================================
   *
   * A touchscreen browser synthesizes `mouseenter` on tap, so the hover path
   * does not merely fail to fire -- it fires on every press, which is how the
   * tooltips came to "frequently show up and block the screen". And because
   * there is no cursor to move away, no `mouseleave` follows: the tooltip
   * appears over the control you just pressed and stays there.
   *
   * So on touch this becomes a DELIBERATE gesture with a DELIBERATE dismissal.
   * A long press asks for help; a tap anywhere puts it away.
   *
   * The position changes with the trigger. A hover tooltip belongs beside its
   * anchor, because the cursor is there and the anchor is small. A long-pressed
   * one must NOT be near the anchor: the finger is on top of the anchor and
   * would cover the very text it just asked for. It goes to a fixed strip at
   * the bottom instead, which is always in the same place, never under the
   * hand, and can be as wide as the screen.
   */
  private readonly touch: boolean;

  /**
   * Cleanup for the document-level dismiss listener, or `null` when hidden.
   *
   * Bound only WHILE A TOOLTIP IS UP, rather than once for the object's life:
   * a listener on `document` that runs on every tap for the whole session, to
   * do nothing in almost all of them, is exactly the kind of thing that makes a
   * touch UI feel heavy. It also cannot then race with a press that is opening
   * a tooltip, since it is attached after that press has finished.
   */
  private releaseDismiss: (() => void) | null = null;

  constructor(parent: HTMLElement = document.body, touch = false) {
    this.parent = parent;
    this.touch = touch;
  }

  /**
   * Show `content` for `anchor` after the hover delay; hide on leave.
   *
   * Returns nothing to unbind: the listeners live as long as the element does,
   * and a rebuilt pane discards both together.
   */
  attach(
    anchor: HTMLElement,
    content: TooltipSource,
    placement: TooltipPlacement = 'side',
  ): void {
    // ONLY the fixed form can be rejected up front. A function is not called
    // here -- it would be answering about the wrong frame, and a control that
    // has nothing to say on its first frame may well have something to say
    // later. `show` re-checks, so an empty result still displays nothing.
    if (typeof content !== 'function' && content.body === '' && content.title === '') {
      return;
    }

    if (this.touch) {
      this.attachTouch(anchor, content);
      return;
    }

    anchor.addEventListener('mouseenter', () => {
      this.cancel();
      this.timer = setTimeout(() => {
        this.show(anchor, content, placement);
      }, DELAY_MS);
    });

    // `mouseleave` rather than `mouseout`: the latter fires when the cursor
    // crosses onto a CHILD element, so a tooltip on a blade would flicker every
    // time the cursor moved between its label and its slider.
    anchor.addEventListener('mouseleave', () => {
      this.cancel();
      this.hide();
    });

    // A press is the user doing something deliberate; a help panel appearing
    // over it is in the way. The desktop keeps its diagram up through a drag,
    // but that is a diagram of the value being dragged -- prose is not.
    anchor.addEventListener('pointerdown', () => {
      this.cancel();
      this.hide();
    });
  }

  /**
   * The touch affordance: long press to show, tap anywhere to dismiss.
   *
   * **THE MOVEMENT CANCEL IS NOT OPTIONAL.** Without it every drag that starts
   * on a control -- every slider adjustment, every scroll of the settings sheet
   * that happens to begin on a row -- raises a tooltip mid-gesture, over the
   * thing being dragged. `TAP_SLOP_PX` is the same threshold `touchGestures.ts`
   * uses to promote a press to a drag, imported rather than restated so a
   * finger that is "still holding" means one thing across the app.
   *
   * `pointerup` cancels too: a press shorter than the delay was a tap, and a tap
   * on a control is a press of that control, not a request for help.
   */
  private attachTouch(anchor: HTMLElement, content: TooltipSource): void {
    let origin: { x: number; y: number } | null = null;

    anchor.addEventListener('pointerdown', (ev) => {
      // TOUCH ONLY, even here. A hybrid device with both a mouse and a
      // touchscreen resolves to the touch LAYOUT, and a mouse user on that
      // device should not have every click arm a long-press timer.
      if (ev.pointerType !== 'touch') return;
      origin = { x: ev.clientX, y: ev.clientY };
      this.cancel();
      this.timer = setTimeout(() => {
        this.showAtBottom(content);
      }, DELAY_MS);
    });

    anchor.addEventListener('pointermove', (ev) => {
      if (origin === null) return;
      if (Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) <= TAP_SLOP_PX) {
        return;
      }
      // Travelled: this is a drag, not a hold.
      origin = null;
      this.cancel();
    });

    const finish = (): void => {
      origin = null;
      this.cancel();
    };
    anchor.addEventListener('pointerup', finish);
    anchor.addEventListener('pointercancel', finish);
  }

  /**
   * Show `source` in the fixed bottom strip. The touch presentation.
   *
   * Positioned by CSS rather than measured, unlike `show`: there is no anchor to
   * sit beside, which is the point -- see the `touch` field. That also means no
   * `getBoundingClientRect` and no flip logic, so this cannot put itself off
   * screen.
   */
  private showAtBottom(source: TooltipSource): void {
    const content = typeof source === 'function' ? source() : source;
    if (content.body === '' && content.title === '') {
      this.hide();
      return;
    }

    const el = this.ensure();
    this.fill(el, content);
    el.style.cssText = TOUCH_TOOLTIP_CSS;
    el.style.display = 'block';

    // ARMED ONLY NOW, and on the NEXT tap rather than this one. The gesture that
    // opened this is still in progress -- the finger has not lifted -- and a
    // listener bound synchronously here would receive that same finger's
    // `pointerup` and close the tooltip before it had been read.
    this.armDismiss();
  }

  /**
   * Dismiss on the next tap anywhere. Touch only.
   *
   * ON `document`, IN THE CAPTURE PHASE, so a tap on any control puts the
   * tooltip away even if that control stops propagation -- the tooltip is
   * `pointer-events:none` and can never be the target itself, so there is no tap
   * that should leave it up.
   *
   * **IT DOES NOT SWALLOW THE TAP.** The press that dismisses also does whatever
   * it was going to do, which is right: the tooltip is an overlay the user has
   * finished with, not a modal they must close first. Making the first tap after
   * help "free" would mean pressing a button twice for no visible reason.
   */
  private armDismiss(): void {
    this.releaseDismiss?.();
    const onDown = (): void => {
      this.hide();
    };
    document.addEventListener('pointerdown', onDown, { capture: true });
    this.releaseDismiss = (): void => {
      document.removeEventListener('pointerdown', onDown, { capture: true });
      this.releaseDismiss = null;
    };
  }

  private cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Render `content` into `el`, replacing whatever was there.
   *
   * Shared by the hover and touch presentations, which differ in WHERE the box
   * goes and not in what is in it. Extracted when the second caller arrived
   * rather than duplicated: the paragraph splitting below is the whole reason
   * this is not a `title` attribute, and two copies of it would be two places
   * for the help text to start rendering differently.
   */
  private fill(el: HTMLElement, content: TooltipContent): void {
    el.textContent = '';

    const title = document.createElement('div');
    title.textContent = content.title;
    title.style.cssText =
      'font-weight:600;opacity:0.75;margin-bottom:4px;' +
      'border-bottom:1px solid rgba(255,255,255,0.15);padding-bottom:4px;';
    el.append(title);

    // The help strings use blank lines as paragraph breaks. Rendering them as
    // real paragraphs is the whole reason this is not a `title` attribute.
    for (const paragraph of content.body.split('\n\n')) {
      if (paragraph === '') continue;
      const p = document.createElement('div');
      p.textContent = paragraph;
      p.style.marginTop = '6px';
      el.append(p);
    }
  }

  private show(
    anchor: HTMLElement,
    source: TooltipSource,
    placement: TooltipPlacement = 'side',
  ): void {
    // Resolved HERE rather than at attach time, so a live control describes the
    // state it is in right now. See `TooltipSource`.
    const content = typeof source === 'function' ? source() : source;
    // A live source can legitimately have nothing to say this frame -- the
    // fixed form was already filtered in `attach`, but this one cannot be.
    // Showing an empty bordered box would read as a rendering fault.
    if (content.body === '' && content.title === '') {
      this.hide();
      return;
    }

    const el = this.ensure();
    this.fill(el, content);

    // Measured after filling, so the flip below sees the real height.
    el.style.visibility = 'hidden';
    el.style.display = 'block';
    const rect = anchor.getBoundingClientRect();
    const size = el.getBoundingClientRect();

    const { left, top } =
      placement === 'below' ? below(rect, size) : beside(rect, size);

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.visibility = 'visible';
  }

  private hide(): void {
    // BEFORE the display change, and unconditionally: the listener outlives the
    // element's visibility and would otherwise keep running on every tap for
    // the rest of the session, hiding something already hidden.
    this.releaseDismiss?.();
    if (this.element !== null) this.element.style.display = 'none';
  }

  private ensure(): HTMLElement {
    if (this.element !== null) return this.element;
    const el = document.createElement('div');
    el.id = 'fluoddity-tooltip';
    el.style.cssText =
      'position:fixed;display:none;z-index:40;pointer-events:none;' +
      `max-width:${WRAP_PX}px;padding:8px 10px;border-radius:4px;` +
      'background:rgba(28,28,30,0.97);color:#e8e8ea;' +
      'font:11px/1.45 system-ui,sans-serif;' +
      'box-shadow:0 4px 16px rgba(0,0,0,0.5);' +
      'border:1px solid rgba(255,255,255,0.12);';
    this.parent.append(el);
    this.element = el;
    return el;
  }

  dispose(): void {
    this.cancel();
    // The dismiss listener is on `document`, so removing the element does not
    // take it with it -- a tap after teardown would call `hide` on a tooltip
    // that has left the page.
    this.releaseDismiss?.();
    this.element?.remove();
    this.element = null;
  }
}

/** A viewport-space position for the tooltip's top-left corner. */
interface Position {
  readonly left: number;
  readonly top: number;
}

/**
 * Beside the anchor. The panel default -- see `TooltipPlacement`.
 *
 * The panel is on the RIGHT, so this goes to the anchor's left and only crosses
 * over when there is no room -- the opposite of the desktop, whose Project
 * window sits left of its diagram.
 */
function beside(rect: DOMRect, size: DOMRect): Position {
  let left = rect.left - size.width - GAP_PX;
  if (left < GAP_PX) left = rect.right + GAP_PX;

  // Keep it on screen vertically without covering the control it describes.
  let top = rect.top;
  const overflow = top + size.height - window.innerHeight + GAP_PX;
  if (overflow > 0) top -= overflow;
  if (top < GAP_PX) top = GAP_PX;

  return { left, top };
}

/**
 * Under the anchor, left edges aligned. For wide controls.
 *
 * LEFT-ALIGNED RATHER THAN CENTRED. The anchors this serves are buttons whose
 * label starts at their left edge, so an aligned tooltip starts under the words
 * it explains. Centring a 320px box under a 500px button would leave it floating
 * between the label and nothing.
 *
 * FLIPS ABOVE when there is no room below, which is the case that matters on
 * this bar: it sits near the top of the window in its usual position, but the
 * hint row can carry two lines of buttons and a short window puts the bottom of
 * it close to the edge. Falling back upward keeps the tooltip fully visible
 * rather than clipping it against the viewport.
 *
 * The horizontal clamp is what stops a button near the right edge -- the hint
 * bar's buttons are laid out from the centre and can sit anywhere -- pushing a
 * 320px tooltip off screen.
 */
function below(rect: DOMRect, size: DOMRect): Position {
  let top = rect.bottom + GAP_PX;
  if (top + size.height > window.innerHeight - GAP_PX) {
    const above = rect.top - size.height - GAP_PX;
    // Only flip if ABOVE actually fits. When neither side does, staying below
    // and letting the clamp handle it keeps the top of the text -- the title and
    // first line -- on screen, which is the half worth seeing.
    if (above >= GAP_PX) top = above;
  }
  if (top < GAP_PX) top = GAP_PX;

  let left = rect.left;
  const overflow = left + size.width - window.innerWidth + GAP_PX;
  if (overflow > 0) left -= overflow;
  if (left < GAP_PX) left = GAP_PX;

  return { left, top };
}
