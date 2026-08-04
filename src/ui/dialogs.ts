/**
 * The save dialog and the delete confirmation.
 *
 * Native `<dialog showModal()>`, which gives Escape-to-cancel, focus trapping
 * and an inert backdrop for free -- all three of which the desktop's imgui modal
 * has to arrange by hand (`config_menu.py:377-410` wires Escape explicitly).
 *
 * ## Two error channels, and they mean different things
 *
 * `config_menu.py:453-462` is emphatic about this and it ports unchanged:
 *
 *   - **local validation** -- the UI DECLINING TO DISPATCH at all ("Enter a
 *     filename."). The Orchestrator never hears about it, because nothing was
 *     ever asked of it.
 *   - **`status.saveError`** -- the Orchestrator reporting an ATTEMPTED save
 *     that failed (a name that sanitizes to nothing, storage denied).
 *
 * The second is read from status **every frame**, never once after dispatch.
 * That is not defensive coding: storage is genuinely async here, so reading it
 * on the line after `send` would read the previous frame's value and close the
 * dialog on a save that had not landed yet.
 *
 * ## The dialogs live outside the panel container
 *
 * `setHidden` toggles the panel's `display`, and a modal that has taken input
 * must not vanish with it -- that would leave the app apparently frozen with no
 * way to answer the question. The desktop keeps its dialogs outside the
 * `gui_hidden` check for the same reason (`ui.py:274-289`).
 */

import type { Command, Status } from '../orchestrator/commands.ts';

export interface DialogOptions {
  readonly send: (command: Command) => void;
}

export class Dialogs {
  private readonly send: (command: Command) => void;

  private readonly saveEl: HTMLDialogElement;
  private readonly saveInput: HTMLInputElement;
  private readonly saveError: HTMLElement;
  /** PRE-DISPATCH validation only. See the file header. */
  private validation = '';
  /** True between clicking Save and the status reporting an outcome. */
  private savePending = false;

  private readonly deleteEl: HTMLDialogElement;
  private readonly deleteText: HTMLElement;
  private pendingDelete: { category: string; name: string } | null = null;

  constructor(opts: DialogOptions) {
    this.send = opts.send;

    // --- save --------------------------------------------------------------
    const save = dialog('fluoddity-save');
    save.append(heading('Save Config'));

    this.saveInput = document.createElement('input');
    this.saveInput.type = 'text';
    this.saveInput.placeholder = 'Filename';
    this.saveInput.style.cssText = INPUT_CSS;
    // Typing answers the validation complaint. It does NOT clear the
    // Orchestrator's error -- only another save attempt can.
    this.saveInput.addEventListener('input', () => {
      this.validation = '';
    });
    this.saveInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') this.attemptSave();
    });
    save.append(this.saveInput);

    const note = document.createElement('div');
    note.textContent = 'saves to Custom';
    note.style.cssText = 'opacity:0.5;font-size:10px;margin-top:6px;';
    save.append(note);

    this.saveError = document.createElement('div');
    this.saveError.style.cssText =
      'color:#ff6b6b;font-size:11px;margin-top:8px;min-height:14px;';
    save.append(this.saveError);

    save.append(
      buttonRow([
        button('Save', () => this.attemptSave(), true),
        button('Cancel', () => {
          this.closeSave();
        }),
      ]),
    );
    this.saveEl = save;

    // --- delete ------------------------------------------------------------
    const del = dialog('fluoddity-delete');
    del.append(heading('Delete Config?'));
    this.deleteText = document.createElement('div');
    this.deleteText.style.cssText = 'font-size:11px;opacity:0.75;';
    del.append(this.deleteText);
    del.append(
      buttonRow([
        button('Delete', () => {
          if (this.pendingDelete !== null) {
            this.send({ kind: 'deleteConfig', ...this.pendingDelete });
          }
          this.pendingDelete = null;
          this.deleteEl.close();
        }, true),
        button('Cancel', () => {
          this.pendingDelete = null;
          this.deleteEl.close();
        }),
      ]),
    );
    this.deleteEl = del;
  }

  // -- save -----------------------------------------------------------------

  openSave(defaultName: string): void {
    this.validation = '';
    this.savePending = false;
    // The Orchestrator's error outlives the dialog that produced it -- only a
    // save attempt rewrites it -- so a previous failure would otherwise greet
    // the user on a fresh dialog (`config_menu.py:416-423`).
    this.send({ kind: 'clearSaveError' });
    if (this.saveInput.value === '') this.saveInput.value = defaultName;
    this.saveEl.showModal();
    this.saveInput.select();
  }

  private attemptSave(): void {
    const name = this.saveInput.value.trim();
    if (name === '') {
      this.validation = 'Enter a filename.';
      return;
    }
    this.validation = '';
    this.savePending = true;
    this.send({ kind: 'saveConfig', name });
  }

  private closeSave(): void {
    this.savePending = false;
    this.saveEl.close();
  }

  // -- delete ---------------------------------------------------------------

  openDelete(category: string, name: string): void {
    this.pendingDelete = { category, name };
    this.deleteText.textContent = `Delete "${name}" from ${category}? This cannot be undone.`;
    this.deleteEl.showModal();
  }

  // -- per frame ------------------------------------------------------------

  /**
   * Read the outcome of an in-flight save.
   *
   * The dialog closes only once a save is actually reported clean, which under
   * an async bus means it may stay up one extra frame. That is correct
   * behaviour rather than a race: closing on dispatch would close it on a save
   * that then failed.
   */
  refresh(status: Status): void {
    this.saveError.textContent = this.validation || status.saveError;

    if (!this.savePending) return;
    // Still working: `configBusy` is non-empty while the write is in flight.
    if (status.configBusy !== '') return;
    if (status.saveError === '') this.closeSave();
    else this.savePending = false;
  }

  dispose(): void {
    this.saveEl.remove();
    this.deleteEl.remove();
  }
}

// -- construction helpers ---------------------------------------------------

const INPUT_CSS =
  'width:100%;box-sizing:border-box;padding:6px 8px;margin-top:4px;' +
  'background:rgba(0,0,0,0.35);border:1px solid rgba(255,255,255,0.18);' +
  'border-radius:3px;color:#e8e8ea;font:12px system-ui,sans-serif;';

function dialog(id: string): HTMLDialogElement {
  const el = document.createElement('dialog');
  el.id = id;
  el.style.cssText =
    'min-width:300px;padding:16px;border:1px solid rgba(255,255,255,0.15);' +
    'border-radius:6px;background:rgba(28,28,30,0.98);color:#e8e8ea;' +
    'font:12px system-ui,sans-serif;';
  // Outside the panel container, so `setHidden` cannot take a modal off screen.
  document.body.append(el);
  return el;
}

function heading(text: string): HTMLElement {
  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText = 'font-weight:600;margin-bottom:10px;';
  return el;
}

function button(label: string, onClick: () => void, primary = false): HTMLElement {
  const el = document.createElement('button');
  el.textContent = label;
  el.style.cssText =
    'padding:5px 14px;border-radius:3px;cursor:pointer;' +
    'font:11px system-ui,sans-serif;' +
    (primary
      ? 'background:#2a6cb0;border:1px solid #3a7cc0;color:#fff;'
      : 'background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);color:#e8e8ea;');
  el.addEventListener('click', onClick);
  return el;
}

function buttonRow(children: readonly HTMLElement[]): HTMLElement {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px;';
  row.append(...children);
  return row;
}
