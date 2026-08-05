/**
 * The save dialog and the two confirmations: delete a config, reset preferences.
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
import { localHotkeyLabel } from './hotkeys.ts';

export interface DialogOptions {
  readonly send: (command: Command) => void;
  /**
   * Copy the live project as a share URL.
   *
   * A CALLBACK, not a `Command`, because the clipboard is the UI's and not the
   * Orchestrator's -- see `CommandBus.projectDocument`. It also keeps `window`
   * out of this file, which is what lets these dialogs stay readable as pure DOM
   * construction with one bus at the edge.
   */
  readonly onCopyShareLink: () => void;
}

export class Dialogs {
  private readonly send: (command: Command) => void;
  private readonly onCopyShareLink: () => void;

  private readonly saveEl: HTMLDialogElement;
  private readonly saveInput: HTMLInputElement;
  private readonly saveError: HTMLElement;
  /**
   * The share-link outcome. SEPARATE from `saveError`, for two reasons.
   *
   * It is red, and a copied link is not an error -- but that alone would only
   * be a styling complaint. The real one: `refresh()` rewrites
   * `saveError.textContent` from status EVERY FRAME, so a message written there
   * would survive exactly one frame and then vanish. This element is written
   * only here and cleared only by `openSave`.
   *
   * It exists at all because the toast cannot help while this dialog is up: a
   * native `<dialog showModal()>` renders in the browser's top layer, above
   * every `z-index`, so a `document.body` toast sits behind the backdrop.
   */
  private readonly shareNote: HTMLElement;
  /** PRE-DISPATCH validation only. See the file header. */
  private validation = '';
  /** True between clicking Save and the status reporting an outcome. */
  private savePending = false;

  private readonly deleteEl: HTMLDialogElement;
  private readonly deleteText: HTMLElement;
  private pendingDelete: { category: string; name: string } | null = null;

  private readonly resetPrefsEl: HTMLDialogElement;

  constructor(opts: DialogOptions) {
    this.send = opts.send;
    this.onCopyShareLink = opts.onCopyShareLink;

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

    this.shareNote = document.createElement('div');
    this.shareNote.style.cssText =
      'font-size:11px;margin-top:6px;min-height:14px;';
    save.append(this.shareNote);

    // LEFTMOST AND SECONDARY. `buttonRow` packs to the right, so the leftmost
    // slot is the one furthest from the two buttons that dismiss the dialog --
    // and this one dismisses nothing, which is worth signalling by position.
    //
    // Secondary because `primary` is what Enter visually promises, and Enter is
    // already bound to Save in the filename field. Two blue buttons would make
    // that promise ambiguous; the reset-preferences dialog above treats "which
    // one is primary" as a real decision for the same reason.
    //
    // The key comes from the hotkey table rather than being typed here, so a
    // rebind moves the label with it -- see `localHotkeyLabel`.
    save.append(
      buttonRow([
        button(`Copy as URL (${localHotkeyLabel('copyShareLink')})`, () => {
          this.onCopyShareLink();
        }),
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

    // --- reset preferences ---------------------------------------------------
    //
    // CONFIRMED BECAUSE IT CANNOT BE UNDONE. Preferences are deliberately
    // outside history (see `resetPreferences` in `commands.ts`), so unlike every
    // other menu item that changes state, there is no Undo to reach for. It also
    // sits directly under Reset View, whose click is harmless -- one row apart
    // from an action that discards every editor setting you have.
    //
    // SAYS WHAT IT DOES NOT TOUCH, not just what it does. The whole reason this
    // is offerable is that saved configs live in IndexedDB and preferences in
    // `localStorage`, and a user cannot be expected to know that -- without the
    // second line, "reset" reads as though it might take the saved work with it.
    const resetPrefs = dialog('fluoddity-reset-prefs');
    resetPrefs.append(heading('Reset Editor Preferences?'));
    const resetText = document.createElement('div');
    resetText.style.cssText = 'font-size:11px;opacity:0.75;line-height:1.5;';
    resetText.textContent =
      'Brightness, world size, physics rate, bloom, brush and panel settings ' +
      'all go back to their defaults. This cannot be undone.\n\n' +
      'Your saved configs are not affected, and neither is the project you ' +
      'currently have open.';
    // Preserves the blank line between the two paragraphs above.
    resetText.style.whiteSpace = 'pre-wrap';
    resetPrefs.append(resetText);
    resetPrefs.append(
      buttonRow([
        // **CANCEL IS THE PRIMARY**, inverting the save and delete dialogs. Those
        // confirm something the user came here to do; this one guards a row they
        // may have hit reaching for Reset View, so the default answer -- and the
        // one Enter picks -- should be the harmless one.
        button('Cancel', () => {
          this.resetPrefsEl.close();
        }, true),
        button('Reset Preferences', () => {
          this.send({ kind: 'resetPreferences' });
          this.resetPrefsEl.close();
        }),
      ]),
    );
    this.resetPrefsEl = resetPrefs;
  }

  // -- save -----------------------------------------------------------------

  /** Whether the save dialog is up, so a caller can pick a visible surface. */
  get saveDialogOpen(): boolean {
    return this.saveEl.open;
  }

  /**
   * Report a share-link copy inside the dialog.
   *
   * Green rather than red on success: this element carries both outcomes, and
   * the colour is the only thing distinguishing them at a glance.
   */
  showShareNote(text: string, ok: boolean): void {
    this.shareNote.textContent = text;
    this.shareNote.style.color = ok ? '#8fd48f' : '#ff6b6b';
  }

  openSave(defaultName: string): void {
    this.validation = '';
    this.savePending = false;
    // A copy from a previous opening would otherwise still be sitting there,
    // claiming a link was just copied when it was not -- the same staleness the
    // `clearSaveError` dispatch below exists to prevent.
    this.shareNote.textContent = '';
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

  // -- reset preferences ------------------------------------------------------

  /**
   * Ask before discarding every editor preference.
   *
   * No pending state to hold, unlike `openDelete`: there is nothing to name, so
   * the dialog's text is fixed at construction and the command carries nothing.
   */
  openResetPreferences(): void {
    this.resetPrefsEl.showModal();
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
    this.resetPrefsEl.remove();
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
