/**
 * A themed yes/no dialog -- Reset's "are you sure".
 *
 * `window.confirm` would do the job, but it is unstyled and freezes the page,
 * and the simulation behind it with it. This one is drawn from `sand.html`'s
 * `#confirm` in the current look and leaves the world running behind it.
 *
 * Enter (or the primary button) confirms; Escape, Cancel or a click on the
 * backdrop declines. While it is open `main.ts`'s hotkeys stand down -- see
 * `isOpen`.
 */

export interface ConfirmOptions {
  readonly title: string;
  readonly text: string;
  /** The primary button's label, e.g. "Reset". */
  readonly confirm: string;
}

export class ConfirmDialog {
  private readonly rootEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly yesEl: HTMLButtonElement;
  private readonly noEl: HTMLButtonElement;
  /** The open dialog's answer, or null when closed. */
  private settle: ((ok: boolean) => void) | null = null;

  constructor() {
    const byId = <T extends HTMLElement>(id: string): T => {
      const el = document.getElementById(id);
      if (el === null) throw new Error(`sand.html is missing #${id}`);
      return el as T;
    };
    this.rootEl = byId('confirm');
    this.titleEl = byId('confirm-title');
    this.textEl = byId('confirm-text');
    this.yesEl = byId<HTMLButtonElement>('confirm-yes');
    this.noEl = byId<HTMLButtonElement>('confirm-no');

    this.yesEl.addEventListener('click', () => this.close(true));
    this.noEl.addEventListener('click', () => this.close(false));
    // The backdrop only, so a click inside the panel does not count.
    this.rootEl.addEventListener('click', (e) => {
      if (e.target === this.rootEl) this.close(false);
    });
    // CAPTURE PHASE, so the answer keys never reach the app's hotkeys.
    window.addEventListener(
      'keydown',
      (e) => {
        if (this.settle === null) return;
        if (e.key === 'Escape') this.close(false);
        else if (e.key === 'Enter') this.close(true);
        else return;
        e.preventDefault();
        e.stopPropagation();
      },
      true,
    );
  }

  get isOpen(): boolean {
    return this.settle !== null;
  }

  /** Ask. Resolves true for yes. A second ask while open declines the first. */
  ask(options: ConfirmOptions): Promise<boolean> {
    this.close(false);
    this.titleEl.textContent = options.title;
    this.textEl.textContent = options.text;
    this.yesEl.textContent = options.confirm;
    this.rootEl.dataset['open'] = 'true';
    this.yesEl.focus();
    return new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  private close(ok: boolean): void {
    const settle = this.settle;
    if (settle === null) return;
    this.settle = null;
    this.rootEl.dataset['open'] = 'false';
    settle(ok);
  }
}
