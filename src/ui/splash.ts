/**
 * The welcome splash and the guide: what Fluoddity is, and how to drive it.
 *
 * Shown once at startup, dismissed by a click anywhere. It is deliberately the
 * simplest thing in `ui/`: no command bus, no status, no refresh. It has one
 * piece of state (shown / not shown) and one transition, so it takes none of
 * the machinery the panel needs.
 *
 * ## Three documents, ONE overlay
 *
 * The screen a first-time visitor meets and the references they come back to
 * are different documents with different jobs. The welcome has to be read in
 * full by someone who has not decided yet whether to care, so it is five lines
 * and ends by pointing at the rest; the `guide` explains what the thing is
 * doing and the `controls` lists what to press, and nobody reaches either
 * without asking.
 *
 * Splitting the reference in two is worth the extra variant because the keys
 * are what people come BACK for -- a returning user hunting for "which key
 * redoes" should not scroll past the algorithm to find it. `H` opens the prose,
 * `?` the keys.
 *
 * They are still ONE class, because everything around the copy is shared and
 * none of it is trivial: the pause coupling, the calibration lock, the
 * scrollbar-aware dismiss. Three instances would mean three of each, and a
 * `pausedBySplash` that three overlays could all claim. So `Variant` selects
 * which block list `render` walks, and `show(variant)` swaps the card's
 * children -- the only thing that actually differs.
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
 * Help > Welcome, Help > Guide and Help > Controls re-show the same instance. Building
 * the chrome once and reattaching it is what makes `show()` cheap enough to
 * call from a menu or a keystroke, and it keeps the scroll position resettable
 * in one place. Only the card's CHILDREN are rebuilt, and only when the variant
 * actually changes.
 *
 * The keydown listener is bound only WHILE VISIBLE, so a dismissed splash costs
 * nothing per keystroke and can never swallow a key meant for the simulation.
 */

// The one threshold that says what counts as "held still", shared with the
// canvas gestures and the tooltips rather than restated -- see the dismiss
// handler below.
import { TAP_SLOP_PX } from './touchGestures.ts';

/** A `<divider>` in the source copy: a hairline rule between blocks. */
const DIVIDER = Symbol('divider');

/**
 * The copy, as blocks. A string is a paragraph; an array is a list, where a
 * leading `-` on an item marks it as nested one level (matching the `--` in the
 * source copy). Keeping it as data rather than an HTML string means the markup
 * decisions live in `render` and the words live here.
 *
 * Bare `http(s)://` runs inside any string become real links -- see `linkify`.
 */
type Block = string | readonly string[] | typeof DIVIDER;

/**
 * Which document the overlay is showing.
 *
 * `welcome` is the first-run screen; `guide` is the prose reference (Help →
 * Guide, `H`); `controls` is the key and mouse reference (Help → Controls,
 * `?`/`/`).
 *
 * **The reference is TWO documents, not one.** They answer different questions
 * -- "what is this thing doing" versus "which key does that" -- and the second
 * is the one people come back for, so burying it under a scroll of prose made
 * the common case the expensive one.
 */
export type Variant = 'welcome' | 'guide' | 'controls';

const WELCOME_HEADING = 'Welcome to Fluoddity!';

/**
 * The first-run copy. FIVE LINES, and it should stay that way.
 *
 * Its whole job is to say what this is and hand off; anything a user needs only
 * once they have decided to stay belongs in `GUIDE_BODY`, which is one keypress
 * away and says so on the last line.
 */
const WELCOME_BODY: readonly Block[] = [
  'Part interactive lava lamp, part evolvable ant farm — in Fluoddity ' +
    'thousands of particles interact through pheromone-like trails they leave ' +
    'behind as they move.',
  [
    'See something you like? Click on it and you can generate children with ' +
      'similar behaviors.',
    'Try thumbing through the presets with File → Load to see some ' +
      'possibilities!',
    'Press (H) or go to Help → Guide for details; press (?) or Help → ' +
      'Controls for the list of keys.',
  ],
];

const GUIDE_HEADING = 'Guide';

const GUIDE_BODY: readonly Block[] = [
  'Basics',
  [
  'There is no fixed particle behavior in Fluoddity. Instead, each particle ' +
    'has a simple brain that it uses to process local trail ' +
    'conditions and decide how to behave.' ,
    'Groups of particles, called cohorts, all share the same behavior.',
  ],  "There's a lot to explore in Fluoddity! But most of the time, all you'll need is File->Save/Load "+
  "and the main control bar at the top of the screen."+
  ' Most actions have hotkeys indicated by parentheses and any action that'+
  ' changes a project can be undone with (Z).',
  'Press ? or go to Help → Controls for the full list of keys and mouse tools.',
  DIVIDER,
  "Getting Started:",
  "Go to File->Load and select a preset that appeals to you. Diversity and Medley can be good places to start exploring. Click on a cohort that you want to see more of, or reroll all the current mutations with (F). In Fluoddity, there is always current set of brain parameters that act as the 'parent'. If you reduce mutation scale to 0, all the particles will behave exactly as the parent did. Selecting a cohort and generating children allows you to set a new parent and see a new crop mutations of it.",
  DIVIDER,
  "Tips:",
  ["I like to start at 16 or 4 cohorts (press the buttons to the far left of the mutation slider) and reduce down to 1 once I've found something I like.",
    "Set/Load checkpoints with (C)/(V) so that you can explore without losing your place.",
    "Enable cohort fences if you want to keep the cohorts from mixing together (Click the dotted circle button to the left of the mutation bar).",
    "File->Save your favorite creations or turn them into shareable urls with Share->Copy Link to this Project"
  ],
  DIVIDER,
  'Understanding the algorithm:',
  "Particles in Fluoddity have no direct interactions with each-other. Instead, they leave trails as they move. These trails decay and diffuse over time. Particles respond to the density and direction of trails around them. There is no fixed rule that determines how particles respond to their senses: Each particle has a simple neural-net like brain which determines how the particle responds to stimuli.",
  "Those responses take the form of:",
  ["A force which cause the the particle to accelerate/brake/turn.",
    "A so called 'strafe', like a little hop, which direcltly shifts particle position without changing it's velocity."
  ],
  "Each cohort has a unique mutation of the current parent brain, causing their behaviors to diverge for nonzero Mutation scale.",
  "Learn More:",
  [
  "Fluoddity is an extension of the classic Physarum model which you can read about in this excellent Sage Jenson blog post: https://cargocollective.com/sagejenson/physarum",
  "This github readme page contains many more details on how this system expands on traditional Physarum simulations:"+
  " https://github.com/aphid91/Fluoddity",
  "This website was written almost entirely by Claude 5 Opus. It is open source at https://github.com/aphid91/Fluoddity-Web"
  ]

];

const CONTROLS_HEADING = 'Controls';

/**
 * The key and mouse reference. Split out of `GUIDE_BODY` because it is the one
 * people come BACK for, and a reader hunting for "which key redoes" should not
 * have to scroll past the algorithm to reach it.
 */
const CONTROLS_BODY: readonly Block[] = [
  'Press X or click the gear icon to toggle the control panels:',
  [
    'The panel on the right shows your editor and tool preferences.',
    'The panel on the left shows your current project. These values are stored ' +
      'and loaded by File → Save/Load, along with particle behavior and ' +
      'mutations.',
  ],
  DIVIDER,
  'Keyboard controls',
  [
    'WASD: pan camera',
    'Q/E/Scroll wheel: zoom camera',
    'X: toggle hide UI',
    '? or /: Display this window',
    'H: Display the guide',
  ],
  [
    'R: reset simulation',
    'Space: toggle pause simulation',
    'Enter (when something is selected): Generate children from selected cohort.',
    'Left/Right arrow: Select Next/Prev cohort.',
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
    'Shift-V: load a project from your clipboard — either a share link or a ' +
      'screenshot with a QR code in it (Ctrl-V does the same)',
    'P: copy a screenshot of any part of the screen to your clipboard',
    'Shift-P: the same, with a QR code stamped in the corner that carries the ' +
      'whole project — post the picture and anyone can load what made it',
  ],
  DIVIDER,
  'Mouse controls',
  'Tool: Select',
  'See something you like? Click on a particle to select its cohort: all the ' +
    'particles with which it shares behavior. Click it again, press enter, or use '+
    'the yellow button on the hint bar to confirm selection and set the chosen cohort '+
    'as the new parent. Each cohort will take on a unique mutation of that parent. ' +
    'This process can be repeated, making it possible to explore the ' +
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
  'Basics:',
  'Keyboard controls',
  'Mouse controls',
  'Tool: Select',
  'Tool: Shove',
  'Tool: Draw',
  'Getting Started:',
  'Tips:',
  'Understanding the algorithm:'
]);

/**
 * The dismiss hint, in its two states.
 *
 * The locked one has to REPLACE the invitation, not sit beside it: a splash
 * that says "click anywhere to close" and then ignores the click reads as
 * broken, which is a worse first impression than the wait it is covering.
 */
/**
 * The dismiss hint, in its mouse and touch wordings.
 *
 * **THE TOUCH ONE IS NOT JUST "TAP" FOR "CLICK".** It also has to say that
 * dragging is safe, because on touch dragging is how you read past the fold and
 * a hint promising that any contact closes the overlay would make scrolling look
 * like a risk. The mouse wording stays exactly as it was: there a drag on the
 * copy is not a scroll, and mentioning it would describe a gesture that does
 * nothing.
 */
const HINT_FREE = 'Click anywhere to close';
const HINT_FREE_TOUCH = 'Drag to scroll · tap anywhere to close';
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
  /** Which document to open on construction. Defaults to `welcome`. */
  readonly variant?: Variant;
  /**
   * Called on each transition, with the new visibility.
   *
   * Fires only on an ACTUAL change -- `show()` on a visible splash and
   * `dismiss()` on a hidden one both early-return before reaching it, so a
   * listener that pauses on true and resumes on false cannot be driven out of
   * balance by a redundant call.
   */
  readonly onVisibilityChange?: (visible: boolean) => void;
  /**
   * Word the dismiss hint for touch. Defaults to false.
   *
   * Only the WORDING: the dismiss rule itself branches on `pointerType` at the
   * event, so a mouse plugged into a touch device still dismisses on press. This
   * is about which sentence is more useful to the person most likely to be
   * reading it, not about which input is possible.
   */
  readonly mobile?: boolean;
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
   * Which document the card is currently holding.
   *
   * Tracked so `show()` can skip rebuilding when the same one is asked for
   * twice -- and, more importantly, so a `show('guide')` on an already-visible
   * welcome still SWAPS rather than silently doing nothing. Pressing `H` while
   * the first-run splash is up is the obvious way to reach the guide, and it
   * has to work.
   */
  private variant: Variant;

  /**
   * Whether dismissal is refused. See `setLocked`.
   *
   * NOT a reason to skip `show()`/`dispose()` -- only the two USER dismissal
   * paths consult it, so the app can always take the splash down regardless.
   */
  private locked = false;

  /**
   * The unlocked hint's wording, chosen once from `opts.mobile`.
   *
   * A FIELD RATHER THAN A CONSTANT read at each site, because `setLocked` also
   * writes this text -- and two places picking the wording independently is how
   * one of them ends up saying "click" on a phone after a calibration finishes.
   */
  private readonly hintFree: string;

  constructor(opts: SplashOptions = {}) {
    this.hintFree = opts.mobile === true ? HINT_FREE_TOUCH : HINT_FREE;
    this.container = opts.container ?? document.body;
    this.onVisibilityChange = opts.onVisibilityChange ?? ((): void => {});
    this.variant = opts.variant ?? 'welcome';

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
      'border-radius:6px;background:rgba(28,28,30,0.98);cursor:auto;' +
      // TOUCH SCROLLING, and harmless on a mouse. `touch-action:pan-y` tells the
      // browser this element owns vertical drags -- without it the drag can be
      // claimed as a page gesture and arrive as a `pointercancel` partway
      // through, which reads as the copy sticking. `overscroll-behavior:contain`
      // stops a flick past the end continuing into the canvas underneath, which
      // has `touch-action:none` and would swallow the rest of the gesture.
      'touch-action:pan-y;overscroll-behavior:contain;' +
      '-webkit-overflow-scrolling:touch;';
    this.card.append(...render(this.variant));

    // OUTSIDE the card, so it stays visible no matter how far the copy scrolls.
    const hint = document.createElement('div');
    hint.textContent = this.hintFree;
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
    //
    // Links in the copy exempt themselves at their own node (`linkify`), which
    // is why this only has the scrollbar to test: an anchor is a real element
    // and can stop the event before it bubbles here, where the scrollbar is
    // drawn inside the card and has no node to bind to.
    // =====================================================================
    // A TOUCH DISMISS IS DECIDED ON THE LIFT, NOT THE PRESS
    // =====================================================================
    //
    // The `pointerdown` rule above is right for a mouse and unusable with a
    // finger. A mouse scrolls this card with a wheel or the scrollbar -- neither
    // of which is a press on the content -- so "any press dismisses" never
    // collides with reading. A finger scrolls by DRAGGING THE TEXT ITSELF, which
    // is a press on the content, so under the same rule the overlay closes the
    // instant anyone tries to read past the fold. That is requirement 6.
    //
    // `onScrollbar` is the desktop's version of this same problem -- grabbing
    // the scrollbar must not dismiss -- and it does not help here, because a
    // touch scroll never goes near a scrollbar.
    //
    // So on touch: remember where the finger went down, and dismiss on lift ONLY
    // if it stayed within the tap slop. A drag scrolls and closes nothing.
    // `TAP_SLOP_PX` is shared with `touchGestures.ts` so that "a tap" means one
    // thing everywhere.
    //
    // **THE MOUSE PATH IS UNTOUCHED**, deliberately, rather than moved to the
    // same lift-based rule for symmetry. `pointerdown` is what the app binds and
    // what this file's own comment above defends: `click` would not fire when a
    // press drifts a few pixels, leaving the splash up. Touch needs the drift
    // test precisely because a drift is meaningful there; on a mouse it is noise.
    let touchOrigin: { x: number; y: number } | null = null;

    this.root.addEventListener('pointerdown', (ev) => {
      if (this.onScrollbar(ev)) return;
      if (ev.pointerType === 'touch') {
        touchOrigin = { x: ev.clientX, y: ev.clientY };
        return;
      }
      this.dismiss();
    });

    this.root.addEventListener('pointerup', (ev) => {
      if (ev.pointerType !== 'touch') return;
      const origin = touchOrigin;
      touchOrigin = null;
      if (origin === null) return;
      const moved = Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y);
      if (moved <= TAP_SLOP_PX) this.dismiss();
    });

    // The browser can take the pointer away mid-scroll (a gesture becoming a
    // system one). That is not a tap and must not dismiss, so the origin is
    // dropped rather than left to be measured against a later, unrelated lift.
    this.root.addEventListener('pointercancel', () => {
      touchOrigin = null;
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

  /**
   * Show `variant`, scrolled back to the top.
   *
   * **NOT a no-op on an already-visible overlay when the variant differs.** The
   * card is re-filled and re-scrolled either way, so `H` while the welcome is
   * up switches documents in place; only a request for the document already on
   * screen returns early. Omitting the argument keeps whatever is loaded, which
   * is what `calibrate()` wants -- it re-shows the splash to hide a rebuild and
   * has no opinion about the copy.
   *
   * `onVisibilityChange` fires only on an ACTUAL show, never on a swap, so the
   * pause coupling in `panel.ts` still sees one true per one false.
   */
  show(variant?: Variant): void {
    const next = variant ?? this.variant;
    if (this.shown && next === this.variant) return;
    if (next !== this.variant) {
      this.variant = next;
      this.card.replaceChildren(...render(next));
    }
    this.card.scrollTop = 0;
    if (this.shown) return;
    this.shown = true;
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
    this.hint.textContent = locked ? HINT_LOCKED : this.hintFree;
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

/**
 * The three documents, by variant. One table rather than a chain of ternaries
 * in `render`, which is what a third variant turned from tidy into unreadable.
 */
const DOCUMENTS: Readonly<Record<Variant, { heading: string; body: readonly Block[] }>> = {
  welcome: { heading: WELCOME_HEADING, body: WELCOME_BODY },
  guide: { heading: GUIDE_HEADING, body: GUIDE_BODY },
  controls: { heading: CONTROLS_HEADING, body: CONTROLS_BODY },
};

/**
 * A bare `http(s)://` run in the copy. Stops at whitespace, and trims trailing
 * `.,;:` so a URL ending a sentence does not swallow the full stop.
 */
const URL_RE = /https?:\/\/[^\s]+/g;

/**
 * Fill `el` with `text`, turning any bare URL in it into a real link.
 *
 * The copy stays plain strings -- no markup, no `[label](href)` micro-syntax to
 * learn -- and the one thing it actually contains, a URL sitting in the middle
 * of a sentence under "Learn More", becomes clickable. Everything else goes in
 * as a text node, so the copy can never inject markup.
 */
function linkify(el: HTMLElement, text: string): void {
  URL_RE.lastIndex = 0;
  let at = 0;
  for (let m = URL_RE.exec(text); m !== null; m = URL_RE.exec(text)) {
    // Trailing sentence punctuation belongs to the prose, not the href.
    const raw = m[0].replace(/[.,;:]+$/, '');
    const start = m.index;
    if (start > at) el.append(text.slice(at, start));

    const a = document.createElement('a');
    a.href = raw;
    a.textContent = raw;
    // `noopener` because `_blank` otherwise hands the new tab a live
    // `window.opener` back into the running simulation.
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.style.cssText = 'color:#7fb2ff;text-decoration:underline;cursor:pointer;';
    // **The overlay's backdrop IS its dismiss target**, and this link is inside
    // it -- so without this the splash would tear itself down on the way to
    // opening the tab. Same exemption the scrollbar gets in `onScrollbar`, and
    // for the same reason: a press that means something else is not a dismiss.
    //
    // `stopPropagation` on `pointerdown` specifically, because that is the
    // event the root listens on; the `click` that follows still reaches the
    // anchor and navigates as normal.
    a.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
    });
    el.append(a);

    at = start + raw.length;
  }
  if (at < text.length) el.append(text.slice(at));
}

/** One variant's body as elements, with its heading in front. */
function render(variant: Variant): HTMLElement[] {
  const welcome = variant === 'welcome';
  const doc = DOCUMENTS[variant];

  // CENTRED ON THE WELCOME ONLY. It is a title above four lines and reads as
  // one, where the reference documents' is a section label at the top of a long
  // scrolling document -- centring that one would leave it floating away from
  // the copy it heads. `text-align` rather than a flex change, so it centres
  // within the card's content box and stays put as the card resizes.
  const heading = document.createElement('h1');
  heading.textContent = doc.heading;
  heading.style.cssText =
    'margin:0 0 12px;font-size:18px;font-weight:600;' +
    (welcome ? 'text-align:center;' : '');

  const out: HTMLElement[] = [heading];

  for (const block of doc.body) {
    if (block === DIVIDER) {
      const hr = document.createElement('hr');
      hr.style.cssText =
        'margin:16px 0;border:0;border-top:1px solid rgba(255,255,255,0.12);';
      out.push(hr);
      continue;
    }

    if (typeof block === 'string') {
      const p = document.createElement('p');
      linkify(p, block);
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
      const nested = item.startsWith('-');
      linkify(li, nested ? item.slice(1).trim() : item);
      li.style.cssText = nested ? 'margin:2px 0 2px 16px;' : 'margin:2px 0;';
      ul.append(li);
    }
    out.push(ul);
  }

  return out;
}
