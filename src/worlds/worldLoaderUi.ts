/**
 * The world library modal: pick one to load, or delete one.
 *
 * ## Its own module rather than a method on `SandUi`
 *
 * `SandUi` owns the painting shell -- the tool rail, the swatch tray, the
 * canvas fit. This is a dev affordance for managing saved worlds, opened from
 * the Dev tab, and it shares nothing with that except a visual language. Folding
 * it in would put a second modal and a second list-building path into a class
 * that is already the largest thing in the modality.
 *
 * ## THE X MUST NOT LOAD THE ROW IT DELETES
 *
 * `menuBar.ts` records this trap at length and it is worth restating, because
 * the shape that causes it looks tidier than the shape that avoids it: the
 * desktop drew its delete button ON TOP of a full-width selectable, so the
 * selectable took the click and pressing X silently LOADED the entry instead of
 * removing it.
 *
 * Here the row listens and the X is a real child that calls `stopPropagation`.
 * The row is what looks clickable so the row is what listens -- padding gutters
 * that show `cursor: pointer` and do nothing are the other half of that bug --
 * and removing the `stopPropagation` would resurrect the original exactly.
 *
 * ## Deleting asks first
 *
 * Unlike the studio's checkpoint list, which deletes immediately because a
 * checkpoint is a cheap session-only copy. A world is minutes of arranging plus
 * a megabyte of scene, and there is no undo -- so it gets a confirm, which is
 * what the requirement asked for.
 */

import type { WorldStore } from './worldStore.ts';

export interface WorldLoaderCallbacks {
  /** A world was chosen. */
  onLoad(name: string): void;
  /** A world was deleted, after the user confirmed. */
  onDelete(name: string): void;
}

export class WorldLoaderUi {
  private readonly store: WorldStore;
  private readonly callbacks: WorldLoaderCallbacks;

  private readonly rootEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly listEl: HTMLElement;

  private open = false;

  constructor(store: WorldStore, callbacks: WorldLoaderCallbacks) {
    this.store = store;
    this.callbacks = callbacks;

    const byId = (id: string): HTMLElement => {
      const el = document.getElementById(id);
      if (el === null) throw new Error(`sand.html is missing #${id}`);
      return el;
    };
    this.rootEl = byId('world-loader');
    this.titleEl = byId('world-loader-title');
    this.listEl = byId('world-loader-list');

    // Clicking the backdrop closes. Scoped to the backdrop itself so a click
    // inside the panel does not -- the same guard `SandUi` uses for its loader.
    this.rootEl.addEventListener('click', (e) => {
      if (e.target === this.rootEl) this.close();
    });
  }

  get isOpen(): boolean {
    return this.open;
  }

  /**
   * Show the library.
   *
   * REBUILDS THE LIST ON EVERY OPEN rather than caching it. The store's name
   * cache is refreshed by every save and delete, and a list built once would go
   * stale the first time a world was saved from the Dev tab while this was
   * closed -- which is the ordinary workflow.
   */
  show(title = 'Load world'): void {
    this.open = true;
    this.titleEl.textContent = title;
    this.rootEl.dataset['open'] = 'true';
    this.fill();
  }

  close(): void {
    this.open = false;
    this.rootEl.dataset['open'] = 'false';
  }

  private fill(): void {
    this.listEl.replaceChildren();
    const names = this.store.names();

    if (names.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'world-empty';
      // Says what to do about it, rather than only that there is nothing --
      // this list is empty for every user until they save their first world.
      empty.textContent = this.store.writable
        ? 'No saved worlds yet. Use "Save world as…" on the Dev tab.'
        : 'Worlds are unavailable: this browser denied local storage.';
      this.listEl.append(empty);
      return;
    }

    for (const name of names) {
      this.listEl.append(this.buildRow(name));
    }
  }

  /**
   * One row: a name that loads, and an X that deletes.
   *
   * See the module header on why the row listens and the X stops propagation.
   */
  private buildRow(name: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'world-row';
    row.title = `Load ${name}`;

    const label = document.createElement('span');
    label.className = 'world-row-name';
    label.textContent = name;
    row.append(label);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'world-row-delete';
    remove.textContent = '×';
    remove.title = `Delete ${name}`;
    remove.addEventListener('click', (e) => {
      // KEEPS THE X FROM LOADING THE ENTRY. See the module header -- removing
      // this resurrects the imgui bug the desktop shipped.
      e.stopPropagation();
      // A world is minutes of arranging and there is no undo, so it asks.
      if (!window.confirm(`Delete the world "${name}"? This cannot be undone.`)) {
        return;
      }
      this.callbacks.onDelete(name);
      // Rebuilt rather than closed: deleting is usually one of several tidying
      // acts, and closing the dialog after each would make a cleanup session
      // four times as many clicks.
      this.fill();
    });
    row.append(remove);

    row.addEventListener('click', () => {
      this.close();
      this.callbacks.onLoad(name);
    });

    return row;
  }
}
