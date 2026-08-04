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

/** Milliseconds of hover before the tooltip appears. imgui's `delay_normal`. */
const DELAY_MS = 500;

/** Wrap width, matching the desktop's `push_text_wrap_pos(320.0)`. */
const WRAP_PX = 320;

/** Gap between the tooltip and the control it describes. */
const GAP_PX = 8;

export interface TooltipContent {
  readonly title: string;
  readonly body: string;
}

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

  constructor(parent: HTMLElement = document.body) {
    this.parent = parent;
  }

  /**
   * Show `content` for `anchor` after the hover delay; hide on leave.
   *
   * Returns nothing to unbind: the listeners live as long as the element does,
   * and a rebuilt pane discards both together.
   */
  attach(anchor: HTMLElement, content: TooltipContent): void {
    if (content.body === '' && content.title === '') return;

    anchor.addEventListener('mouseenter', () => {
      this.cancel();
      this.timer = setTimeout(() => {
        this.show(anchor, content);
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

  private cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private show(anchor: HTMLElement, content: TooltipContent): void {
    const el = this.ensure();
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

    // Measured after filling, so the flip below sees the real height.
    el.style.visibility = 'hidden';
    el.style.display = 'block';
    const rect = anchor.getBoundingClientRect();
    const size = el.getBoundingClientRect();

    // The panel is on the RIGHT, so the tooltip goes to its left by default and
    // only crosses over if there is no room -- the opposite of the desktop,
    // whose Project window sits left of its diagram.
    let left = rect.left - size.width - GAP_PX;
    if (left < GAP_PX) left = rect.right + GAP_PX;

    // Keep it on screen vertically without covering the control it describes.
    let top = rect.top;
    const overflow = top + size.height - window.innerHeight + GAP_PX;
    if (overflow > 0) top -= overflow;
    if (top < GAP_PX) top = GAP_PX;

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.visibility = 'visible';
  }

  private hide(): void {
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
    this.element?.remove();
    this.element = null;
  }
}
