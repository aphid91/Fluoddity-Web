/**
 * The welcome splash: what Fluoddity is, and how to drive it.
 *
 * Shown once at startup, dismissed by a click anywhere. It is deliberately the
 * simplest thing in `ui/`: no command bus, no status, no refresh. It has one
 * piece of state (shown / not shown) and one transition, so it takes none of
 * the machinery the panel needs.
 *
 * ## Why it is not a `<dialog showModal()>`
 *
 * `dialogs.ts` uses native modals precisely because it wants focus trapping and
 * an inert backdrop -- a save dialog is a QUESTION, and the app should not
 * proceed until it is answered. This is the opposite: the simulation is running
 * underneath and is meant to be seen running. So it is an ordinary fixed
 * overlay whose backdrop IS the dismiss target, and the canvas keeps rendering
 * behind it.
 *
 * ## It mounts outside the panel container
 *
 * Same reason as the menu bar and the dialogs (`ui.py:274-289`): `X` toggles
 * the panel's `display`, and the splash is not the panel's business. It is
 * gone by the time anyone reaches for `X` anyway.
 *
 * ## The instance outlives any one showing
 *
 * `dismiss()` detaches the node and unbinds the key listener, but keeps both --
 * Help > Welcome / Controls re-shows the same instance. Building the DOM once
 * and reattaching it is what makes `show()` cheap enough to call from a menu,
 * and it keeps the scroll position resettable in one place.
 *
 * The keydown listener is bound only WHILE VISIBLE, so a dismissed splash costs
 * nothing per keystroke and can never swallow a key meant for the simulation.
 */

/** A `<divider>` in the source copy: a hairline rule between blocks. */
const DIVIDER = Symbol('divider');

/**
 * The copy, as blocks. A string is a paragraph; an array is a list, where a
 * leading `-` on an item marks it as nested one level (matching the `--` in the
 * source copy). Keeping it as data rather than an HTML string means the markup
 * decisions live in `render` and the words live here.
 */
type Block = string | readonly string[] | typeof DIVIDER;

const HEADING = 'Welcome to Fluoddity!';

const BODY: readonly Block[] = [
  'Think of it like an evolvable ant farm, or an interactive lava lamp. ' +
    'Thousands of particles interact through pheromone-like trails left behind ' +
    'as they move. There is no fixed particle behavior in Fluoddity. Instead, ' +
    'each particle has a simple neural-net like brain that it uses to process ' +
    'local trail conditions and decide how to behave. Groups of particles, ' +
    'called cohorts, all share the same behavior.',
  'Go to File → Load and thumb through the presets to see some possibilities!',
  DIVIDER,
  [
    'The panel on the right shows your editor and tool preferences.',
    'The panel on the left shows your current project. These values are stored ' +
      'and loaded by File → Save/Load, along with particle behavior and ' +
      'current mutations.',
  ],
  DIVIDER,
  'Controls',
  [
    'WASD: pan camera',
    'Q/E/Scroll wheel: zoom camera',
    'X: toggle hide UI',
  ],
  [
    'R: reset simulation',
    'Space: toggle pause simulation',
    'F: reroll mutations',
    'B: randomize particle behavior',
  ],
  [
    'Z: undo (changes to a project can be undone, including behavior ' +
      'selection and rerolls)',
    'Shift-Z: redo',
    'C: set project checkpoint',
    'V: restore most recent checkpoint',
  ],
  DIVIDER,
  'Mouse controls',
  'Tool: Select',
  'See something you like? Click on a particle and the rest will adopt its ' +
    'behavior. If mutation scale is nonzero, each cohort will take on a unique ' +
    'mutation. This process can be repeated, making it possible to explore the ' +
    'space of possible behaviors. When in select mode, right click is mapped ' +
    'to undo.',
  DIVIDER,
  'Tool: Shove',
  'Hold left mouse to push particles away from your cursor. Hold right mouse ' +
    'to pull them in.',
  DIVIDER,
  'Tool: Draw',
  'Left click to draw barriers that repel particles. Right click to erase.',
];

/** Blocks that are a bold sub-heading rather than body copy. */
const SUBHEADINGS: ReadonlySet<string> = new Set([
  'Controls',
  'Mouse controls',
  'Tool: Select',
  'Tool: Shove',
  'Tool: Draw',
]);

export interface SplashOptions {
  /** Where to mount. Defaults to `document.body`. */
  readonly container?: HTMLElement;
  /**
   * Whether to show it on construction. Defaults to true.
   *
   * False builds the DOM without attaching it, so `show()` still works -- the
   * Help menu needs the instance either way.
   */
  readonly showNow?: boolean;
}

export class Splash {
  private readonly container: HTMLElement;
  private readonly root: HTMLElement;
  private readonly card: HTMLElement;
  private readonly onKey: (ev: KeyboardEvent) => void;
  private shown = false;

  constructor(opts: SplashOptions = {}) {
    this.container = opts.container ?? document.body;

    this.root = document.createElement('div');
    this.root.id = 'fluoddity-splash';
    this.root.style.cssText =
      'position:fixed;inset:0;z-index:40;display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;gap:12px;padding:24px;' +
      'box-sizing:border-box;background:rgba(0,0,0,0.72);cursor:pointer;' +
      'font:13px/1.55 system-ui,sans-serif;color:#e8e8ea;';

    // `min-height:0` is what lets the card actually shrink and scroll: a flex
    // item's default `min-height:auto` is its content height, so without this
    // the card grows past the viewport and takes the hint below the fold with
    // it -- which is the one thing the hint must never do.
    this.card = document.createElement('div');
    this.card.style.cssText =
      'max-width:640px;min-height:0;overflow-y:auto;box-sizing:border-box;' +
      'padding:24px 28px;border:1px solid rgba(255,255,255,0.15);' +
      'border-radius:6px;background:rgba(28,28,30,0.98);cursor:auto;';
    this.card.append(...render());

    // OUTSIDE the card, so it stays visible no matter how far the copy scrolls.
    const hint = document.createElement('div');
    hint.textContent = 'Click anywhere to close';
    hint.style.cssText = 'flex:none;opacity:0.65;font-size:11px;';

    this.root.append(this.card, hint);

    // On `root`, so a click on the backdrop dismisses too -- the whole overlay
    // is the target, including the card.
    //
    // **`pointerdown`, not `click`.** The app itself binds `pointerdown`
    // (`inputBinding.ts:215`), and matching it matters for more than symmetry:
    // `click` only fires when press and release land on the same element, so a
    // press that drifts a few pixels would leave the splash up. The overlay
    // sits above the canvas, so this press is consumed here and the simulation
    // never sees it either way.
    this.root.addEventListener('pointerdown', (ev) => {
      if (this.onScrollbar(ev)) return;
      this.dismiss();
    });
    // A splash that eats the first keystroke would be worse than one that
    // lingers: `X`, `Space` and `R` are the things a new user reaches for after
    // reading it. Any key dismisses and the key itself falls through to the
    // window listeners in `inputBinding.ts` on the next press.
    this.onKey = (ev: KeyboardEvent): void => {
      if (ev.repeat) return;
      this.dismiss();
    };

    if (opts.showNow !== false) this.show();
  }

  /**
   * Whether this press landed on the card's scrollbar rather than its content.
   *
   * The scrollbar is drawn INSIDE the card's border box, so it is not a
   * separate element and `ev.target` is the card either way -- there is nothing
   * to test but the geometry. `clientWidth` excludes the scrollbar while
   * `getBoundingClientRect().width` includes it, so the difference is the
   * gutter's width.
   *
   * Without this, grabbing the scrollbar to read further dismisses the splash
   * on the way to the thumb -- the one gesture a long scrolling document most
   * invites.
   *
   * **The gutter is a BOUNDED STRIP, not a half-plane.** Testing only
   * `clientX >= contentEdge` also swallows every press out on the backdrop to
   * the right of the card, since those are further right still -- so the whole
   * right-hand side of the screen silently stopped dismissing. All four edges
   * are checked, and the vertical span matters as much as the horizontal one:
   * the backdrop directly above and below the card is inside the gutter's
   * column.
   *
   * Only the vertical bar is checked: `overflow-y:auto` with no `overflow-x`
   * means a horizontal bar never appears.
   */
  private onScrollbar(ev: PointerEvent): boolean {
    const rect = this.card.getBoundingClientRect();
    const gutter = rect.width - this.card.clientWidth;
    if (gutter <= 0) return false; // No scrollbar, or an overlay one that takes no space.

    // `clientLeft` is the left border width, which `clientWidth` also excludes;
    // without it the strip would be offset by the border and a press on the
    // card's right border would read as content.
    const gutterLeft = rect.left + this.card.clientLeft + this.card.clientWidth;
    return (
      ev.clientX >= gutterLeft &&
      ev.clientX < rect.right &&
      ev.clientY >= rect.top &&
      ev.clientY < rect.bottom
    );
  }

  /** Show it, or do nothing if it is already up. Scrolled back to the top. */
  show(): void {
    if (this.shown) return;
    this.shown = true;
    this.card.scrollTop = 0;
    this.container.append(this.root);
    // Bound only while visible, so a dismissed splash costs nothing per
    // keystroke and cannot swallow a key meant for the simulation.
    window.addEventListener('keydown', this.onKey);
  }

  /** Idempotent: dismissing an already-dismissed splash does nothing. */
  dismiss(): void {
    if (!this.shown) return;
    this.shown = false;
    window.removeEventListener('keydown', this.onKey);
    this.root.remove();
  }

  /** Whether the splash is currently on screen. */
  get visible(): boolean {
    return this.shown;
  }

  /**
   * Tear down for good. `dismiss` already removes the node and the listener,
   * so this is that plus the promise not to `show()` again.
   */
  dispose(): void {
    this.dismiss();
  }
}

/** `BODY` as elements, with `HEADING` in front. */
function render(): HTMLElement[] {
  const heading = document.createElement('h1');
  heading.textContent = HEADING;
  heading.style.cssText = 'margin:0 0 12px;font-size:18px;font-weight:600;';

  const out: HTMLElement[] = [heading];

  for (const block of BODY) {
    if (block === DIVIDER) {
      const hr = document.createElement('hr');
      hr.style.cssText =
        'margin:16px 0;border:0;border-top:1px solid rgba(255,255,255,0.12);';
      out.push(hr);
      continue;
    }

    if (typeof block === 'string') {
      const p = document.createElement('p');
      p.textContent = block;
      p.style.cssText = SUBHEADINGS.has(block)
        ? 'margin:12px 0 6px;font-weight:600;'
        : 'margin:0 0 10px;opacity:0.85;';
      out.push(p);
      continue;
    }

    const ul = document.createElement('ul');
    ul.style.cssText = 'margin:0 0 10px;padding-left:20px;opacity:0.85;';
    for (const item of block) {
      const li = document.createElement('li');
      li.textContent = item.startsWith('-') ? item.slice(1).trim() : item;
      li.style.cssText = item.startsWith('-')
        ? 'margin:2px 0 2px 16px;'
        : 'margin:2px 0;';
      ul.append(li);
    }
    out.push(ul);
  }

  return out;
}
