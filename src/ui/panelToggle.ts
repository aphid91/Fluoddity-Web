/**
 * The gear that shows and hides the side panels.
 *
 * ## Why it is not on the mutation bar
 *
 * It was, briefly, tucked in with the cohort-layout presets. That grouped it
 * with the wrong things: everything else on that bar acts on the SIMULATION --
 * how many cohorts, how much mutation, which tool -- and this acts on the
 * editor's own chrome. It also put a control you press when the panels are
 * hidden inside the one strip that is always visible, which made the bar the
 * answer to two unrelated questions.
 *
 * On its own in a corner it reads as what it is: the way back to the interface.
 * Bottom LEFT specifically, because the panels open at the top of both sides and
 * the mutation bar owns the top centre -- the bottom-left corner is the one
 * region of the canvas nothing else claims.
 *
 * ## Why a callback rather than a command
 *
 * Hiding the panels is the panel's own business and deliberately does not go
 * through the command bus (`main.ts` routes `X` the same way, citing
 * `ui.py:471-473`). Routing the gear differently would give the app two answers
 * to "is the UI hidden". It calls `Panel.setHidden` exactly as the key and the
 * Editor menu item do, so all three share one flag and one notification.
 */

/** The viewBox and rendered size of the icon. Square, so one constant. */
const ICON_BOX = 20;

/**
 * The button's outer size.
 *
 * 25% larger than the 24px icon buttons on the mutation bar. It is not one of a
 * row -- it stands alone against the picture, with no neighbours to be measured
 * against -- and it is the only way back to the interface once the panels are
 * hidden, so it wants to be findable rather than tidy.
 */
const BUTTON_PX = 30;

const SVG_NS = 'http://www.w3.org/2000/svg';

const ROOT_CSS =
  `position:fixed;left:12px;bottom:12px;z-index:30;` +
  `width:${String(BUTTON_PX)}px;height:${String(BUTTON_PX)}px;padding:0;` +
  'display:flex;align-items:center;justify-content:center;' +
  'background:rgba(28,28,30,0.92);border:1px solid rgba(255,255,255,0.14);' +
  'border-radius:6px;color:#e8e8ea;cursor:pointer;' +
  'box-shadow:0 4px 16px rgba(0,0,0,0.45);';

export interface PanelToggleOptions {
  /** Show or hide the panels. See the header for why this is not a command. */
  readonly onToggle: () => void;
  /** Where to mount. Defaults to `document.body`. */
  readonly container?: HTMLElement;
}

/** The gear button, mounted on construction. */
export class PanelToggle {
  private readonly root: HTMLButtonElement;

  constructor(opts: PanelToggleOptions) {
    this.root = document.createElement('button');
    this.root.type = 'button';
    this.root.style.cssText = ROOT_CSS;
    // The key is named in the tooltip rather than only in the menu: this button
    // exists for people who cannot see the menu, because the panels that carry
    // it are hidden.
    const label = 'Show/Hide control panels | Hotkey (X)';
    this.root.title = label;
    // The icon is the only content, so without this the button is unnamed to a
    // screen reader.
    this.root.setAttribute('aria-label', label);
    this.root.dataset['setting'] = 'transport.toggleUi';
    this.root.append(gearIcon());
    this.root.addEventListener('click', () => {
      opts.onToggle();
      // A click leaves the button focused, and `X` would then be swallowed by
      // nothing in particular while Space and Enter would re-fire this button --
      // so the key that does the same job stops working right after you use its
      // on-screen twin. Blurring hands the keys straight back, the same answer
      // `mutationOverlay`'s tool `<select>` arrives at.
      this.root.blur();
    });
    (opts.container ?? document.body).append(this.root);
  }

  /**
   * Deliberately NOT hidden with the panels.
   *
   * It is the way back: hiding it with them would leave `X` and the menu -- and
   * the menu is inside what just disappeared. Kept as a method so `Panel`'s
   * `setHidden` reads as a complete list of what it governs, with this one
   * saying why it opts out.
   */
  setHidden(_hidden: boolean): void {
    // Intentionally empty. See above.
  }

  dispose(): void {
    this.root.remove();
  }
}

/**
 * A gear.
 *
 * Eight teeth as rotated rectangles plus a stroked hub, rather than a `<path>`
 * traced from a design tool: at this size the silhouette is all that survives,
 * and generating it keeps the file free of an opaque coordinate blob nobody can
 * adjust.
 *
 * `fill`/`stroke` of `currentColor` so the icon follows the button's `color` --
 * which is what lets a hover or disabled state recolour it without this function
 * knowing either exists.
 */
function gearIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${String(ICON_BOX)} ${String(ICON_BOX)}`);
  svg.setAttribute('width', String(ICON_BOX));
  svg.setAttribute('height', String(ICON_BOX));
  svg.style.display = 'block';

  const c = ICON_BOX / 2;
  const teeth = 8;
  for (let i = 0; i < teeth; i++) {
    const tooth = document.createElementNS(SVG_NS, 'rect');
    tooth.setAttribute('x', String(c - 1.4));
    tooth.setAttribute('y', String(c - 9.0));
    tooth.setAttribute('width', '2.8');
    tooth.setAttribute('height', '5.2');
    tooth.setAttribute('rx', '0.9');
    tooth.setAttribute('fill', 'currentColor');
    // Rotated about the centre rather than placed by trigonometry here: the
    // transform is what makes "eight evenly spaced" obvious at a glance.
    tooth.setAttribute(
      'transform',
      `rotate(${String((360 / teeth) * i)} ${String(c)} ${String(c)})`,
    );
    svg.append(tooth);
  }

  // The body and its hole, drawn as ONE stroked ring rather than two filled
  // circles -- so the hole stays transparent over any background instead of
  // being painted in a colour that has to match one.
  const ring = document.createElementNS(SVG_NS, 'circle');
  ring.setAttribute('cx', String(c));
  ring.setAttribute('cy', String(c));
  ring.setAttribute('r', '4.3');
  ring.setAttribute('fill', 'none');
  ring.setAttribute('stroke', 'currentColor');
  ring.setAttribute('stroke-width', '3.2');
  svg.append(ring);

  return svg;
}
