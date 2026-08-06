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
      'mutations.',
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
  [
    'Shift-C: copy a shareable url link to this project to your clipboard',
    'Shift-V: load a project from a share link in your clipboard',
  ],
  DIVIDER,
  'Mouse controls',
  'Tool: Select',
  'See something you like? Click on a particle and the rest will adopt its ' +
    'behavior. If mutation scale is nonzero, each cohort will take on a unique ' +
    'mutation. This process can be repeated, making it possible to explore the ' +
    'space of possible behaviors. When in select mode, right click is mapped ' +
    'to undo.',
  
  'Tool: Shove',
  'Hold left mouse to push particles away from your cursor. Hold right mouse ' +
    'to pull them in.',
  
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

/**
 * The dismiss hint, in its two states.
 *
 * The locked one has to REPLACE the invitation, not sit beside it: a splash
 * that says "click anywhere to close" and then ignores the click reads as
 * broken, which is a worse first impression than the wait it is covering.
 */
const HINT_FREE = 'Click anywhere to close';
const HINT_LOCKED = 'One moment — measuring what your hardware can handle…';

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
  /**
   * Called on each transition, with the new visibility.
   *
   * Fires only on an ACTUAL change -- `show()` on a visible splash and
   * `dismiss()` on a hidden one both early-return before reaching it, so a
   * listener that pauses on true and resumes on false cannot be driven out of
   * balance by a redundant call.
   */
  readonly onVisibilityChange?: (visible: boolean) => void;
}

export class Splash {
  private readonly container: HTMLElement;
  private readonly root: HTMLElement;
  private readonly card: HTMLElement;
  /** The calibration progress line. Empty and hidden unless something sets it. */
  private readonly status: HTMLElement;
  /** The dismiss hint, which changes while locked -- see `setLocked`. */
  private readonly hint: HTMLElement;
  private readonly onKey: (ev: KeyboardEvent) => void;
  private readonly onVisibilityChange: (visible: boolean) => void;
  private shown = false;

  /**
   * Whether dismissal is refused. See `setLocked`.
   *
   * NOT a reason to skip `show()`/`dispose()` -- only the two USER dismissal
   * paths consult it, so the app can always take the splash down regardless.
   */
  private locked = false;

  constructor(opts: SplashOptions = {}) {
    this.container = opts.container ?? document.body;
    this.onVisibilityChange = opts.onVisibilityChange ?? ((): void => {});

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
    hint.textContent = HINT_FREE;
    hint.style.cssText = 'flex:none;opacity:0.65;font-size:11px;';
    this.hint = hint;

    // Also outside the card, and for a second reason beyond the hint's: this
    // updates while the user reads, and text that reflows inside a scrolling
    // region can move the line someone is mid-sentence on.
    //
    // Hidden until `setStatus` is given something. Calibration is the only
    // caller, it does not run for a returning visitor, and an empty reserved
    // strip would be a permanent gap under the card in the common case.
    this.status = document.createElement('div');
    this.status.style.cssText =
      'flex:none;display:none;opacity:0.75;font-size:11px;' +
      'font-variant-numeric:tabular-nums;';

    this.root.append(this.card, this.status, this.hint);

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
    // LAST, after the state is settled: a listener that calls back into
    // `visible` must not see a half-applied transition.
    this.onVisibilityChange(true);
  }

  /**
   * Idempotent: dismissing an already-dismissed splash does nothing.
   *
   * REFUSED WHILE LOCKED. Calibration rebuilds the simulation underneath the
   * user several times, and letting them out into an app that is still
   * reshaping itself -- panel values jumping, the picture restarting -- is
   * worse than a two-second wait behind a screen that explains itself.
   */
  dismiss(): void {
    if (!this.shown || this.locked) return;
    this.shown = false;
    window.removeEventListener('keydown', this.onKey);
    this.root.remove();
    this.onVisibilityChange(false);
  }

  /**
   * Hold the splash up, or release it.
   *
   * Guards only the two USER paths (`pointerdown`, `keydown`), both of which go
   * through `dismiss`. `show`, `dispose` and the pause coupling are unaffected,
   * so the app can always take the splash down even if a lock leaked -- a
   * calibration that threw must not strand someone behind a screen forever,
   * which is why `main.ts` releases in a `finally`-equivalent position rather
   * than only on success.
   */
  setLocked(locked: boolean): void {
    this.locked = locked;
    this.hint.textContent = locked ? HINT_LOCKED : HINT_FREE;
    // `default` rather than `pointer` while locked: the cursor should not
    // promise a click that will not work.
    this.root.style.cursor = locked ? 'default' : 'pointer';
  }

  /** Whether the splash is currently on screen. */
  get visible(): boolean {
    return this.shown;
  }

  /**
   * Set the line under the card. Empty hides it.
   *
   * Safe to call on a dismissed splash: the node stays in the tree the splash
   * built either way, so calibration finishing after the user clicked through
   * writes to something detached rather than having to know it was dismissed.
   */
  setStatus(text: string): void {
    this.status.textContent = text;
    this.status.style.display = text === '' ? 'none' : '';
  }

  /**
   * Tear down for good: the node and the listener go, and `show()` is not
   * coming back.
   *
   * **Deliberately NOT `dismiss()`.** Dispose is teardown, not a user closing
   * the splash, so it must not fire `onVisibilityChange` -- a listener that
   * resumes the simulation on dismissal would otherwise resume it as the panel
   * is being destroyed, on its way out.
   */
  dispose(): void {
    if (!this.shown) return;
    this.shown = false;
    window.removeEventListener('keydown', this.onKey);
    this.root.remove();
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
