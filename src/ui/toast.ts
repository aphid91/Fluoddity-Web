/**
 * The transient message strip.
 *
 * Built for the share link, which is the first thing this app does that
 * SUCCEEDS SILENTLY. Every other action shows its own result -- a preset loads
 * and the screen changes, a save closes its dialog, a reroll redraws. Copying to
 * the clipboard changes nothing on screen, so without a word from somewhere the
 * only way to know whether Shift+C worked is to go and paste it.
 *
 * ## WHY NOT `Status.saveError`
 *
 * It is where the save dialog reports failures, and it was the obvious host.
 * Two things rule it out, and the second is not a matter of taste:
 *
 *   - It is only rendered INSIDE the save dialog (`dialogs.ts:221`), and the
 *     share link is normally used with no dialog open. The message would go
 *     nowhere in the case it exists for.
 *   - `Dialogs.refresh` rewrites that element from status every frame, so
 *     anything written there survives exactly one frame.
 *
 * ## WHY NOT A `Status` FIELD
 *
 * A message with a lifetime is UI chrome: the Orchestrator would have to hold a
 * string it has no use for and count down its expiry, which is a timer in the
 * simulation loop for a cosmetic effect. `toggleUi` is a `LocalAction` for the
 * same reason.
 *
 * ## ONE ELEMENT, CREATED LAZILY
 *
 * The `Tooltip` pattern, and for the same reasons: a single floating element
 * refilled per use rather than one per message, `pointer-events: none` so it can
 * never become an `event.target` and eat canvas input (`inputBinding.ts` decides
 * capture by target identity), and attached to `document.body` so `setHidden`
 * cannot take it off screen mid-message.
 *
 * ## WHAT IT DELIBERATELY CANNOT DO
 *
 * Cover a modal. A native `<dialog showModal()>` renders in the browser's TOP
 * LAYER, which is above every `z-index` there is -- so while the save dialog is
 * up, this element is behind its backdrop no matter what we set here. That is
 * not worked around: the dialog reports share results in its own message line,
 * and `Panel` picks between the two. Trying to out-`z-index` the top layer is
 * the trap, and it fails silently in exactly the case a user is most likely to
 * be watching for feedback.
 */

/** How long a message stays up. Long enough to read twice, short enough to ignore. */
const LIFETIME_MS = 2600;

/** Fade duration, matched by the element's `transition`. */
const FADE_MS = 180;

export type ToastTone = 'ok' | 'error';

export class Toast {
  private element: HTMLElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly parent: HTMLElement;

  constructor(parent: HTMLElement = document.body) {
    this.parent = parent;
  }

  /**
   * Show `text` until it expires, replacing whatever is up.
   *
   * REPLACES rather than queues. Two share links copied in quick succession
   * should leave the second message showing, not make the user wait out the
   * first -- the message describes the latest action, and a queue would make it
   * describe a stale one.
   */
  show(text: string, tone: ToastTone = 'ok'): void {
    const el = this.ensure();
    el.textContent = text;
    // Red reads as failure anywhere in this UI (`dialogs.ts:81`); the success
    // tone is deliberately not green-on-black neon, just legible.
    el.style.color = tone === 'error' ? '#ff6b6b' : '#e8e8ea';
    el.style.borderColor =
      tone === 'error' ? 'rgba(255,107,107,0.4)' : 'rgba(255,255,255,0.12)';

    if (this.timer !== null) clearTimeout(this.timer);
    el.style.opacity = '1';
    this.timer = setTimeout(() => {
      el.style.opacity = '0';
      this.timer = null;
    }, LIFETIME_MS);
  }

  private ensure(): HTMLElement {
    if (this.element !== null) return this.element;
    const el = document.createElement('div');
    el.id = 'fluoddity-toast';
    // BOTTOM CENTRE: the panel owns the right edge, the menu bar the top, and
    // the mutation overlay the bottom left. This is the one place a strip can
    // appear without covering something a user might be reading.
    el.style.cssText =
      'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);' +
      'z-index:40;pointer-events:none;opacity:0;' +
      `transition:opacity ${FADE_MS}ms ease;` +
      'max-width:min(560px,calc(100vw - 32px));padding:8px 14px;' +
      'border-radius:4px;background:rgba(28,28,30,0.97);' +
      'border:1px solid rgba(255,255,255,0.12);' +
      'box-shadow:0 4px 16px rgba(0,0,0,0.5);' +
      'font:11px/1.45 system-ui,sans-serif;text-align:center;';
    this.parent.append(el);
    this.element = el;
    return el;
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.element?.remove();
    this.element = null;
  }
}
