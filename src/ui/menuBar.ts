/**
 * The menu bar: File, Edit, Tools, View, Simulation.
 *
 * The port of `ui/config_menu.py:_menu_bar` (`:82-160`) and the two
 * browse-by-hover submenus under it.
 *
 * ## Why plain DOM rather than Tweakpane blades
 *
 * Tweakpane has no menu concept, and the Load menu needs three things folders
 * and buttons cannot give: **per-row `mouseenter`/`mouseleave`** (hovering a row
 * auditions that config live), a row that is a name PLUS a delete button, and
 * categories as collapsible groups. Expressing that as folders-of-buttons would
 * fight the framework and still not give per-row hover.
 *
 * Two things this gets for free:
 *
 *   - **Capture filtering.** `inputBinding.ts` decides canvas capture with
 *     `event.target !== canvas`, so real DOM is filtered with no new code. The
 *     trap is the opposite one: a `pointer-events: none` overlay never BECOMES a
 *     target, which is why the tooltip and the sensor diagram must stay
 *     non-interactive and this must not.
 *   - **The row-layout bug cannot recur.** `config_menu.py:236-243` records that
 *     an imgui `selectable()` spans the full menu width, so a delete button
 *     placed after it with `same_line()` sits ON TOP of the selectable's click
 *     area -- the selectable wins the click, and pressing X silently LOADS the
 *     entry instead of deleting it. A flex row has two disjoint hit areas, so
 *     the bug is structurally impossible. Do not "tidy" this into an overlay.
 *
 * ## Hover-preview is driven per frame, not per event
 *
 * `mouseenter`/`mouseleave` only record which row is under the cursor;
 * `PreviewSession.sync` is called once per frame from `refresh`. Reacting to the
 * events directly would fire leave-then-enter on a row-to-row move and restore
 * the snapshot between two previews -- a visible flicker back to the original
 * config on every row the cursor crosses.
 */

import type { Command, Status } from '../orchestrator/commands.ts';
import { MOUSE_MODES } from '../orchestrator/commands.ts';
import { PreviewSession } from './previewSession.ts';

export interface MenuBarOptions {
  readonly send: (command: Command) => void;
  readonly status: () => Status;
  /** Open the save dialog. Owned by the panel, since it outlives the menu. */
  readonly onSave: () => void;
  /** Ask to delete a stored config. Opens the confirm dialog. */
  readonly onDeleteConfig: (category: string, name: string) => void;
  /** Toggle the settings panel. The `X` key's action, as a menu item. */
  readonly onToggleUi: () => void;
  /** Whether the panel is currently hidden, for the checkmark. */
  readonly isUiHidden: () => boolean;
}

/** One entry in the Load menu, flattened out of `configCategories`. */
interface ConfigRow {
  readonly category: string;
  readonly name: string;
}

const configKey = (row: ConfigRow): string => `${row.category}/${row.name}`;

export class MenuBar {
  private readonly root: HTMLElement;
  private readonly opts: MenuBarOptions;
  /** The menu whose dropdown is open, or `null`. */
  private openMenu: string | null = null;

  /**
   * The row under the cursor, one per surface.
   *
   * **STICKY, not a per-frame pulse.** `mouseenter` fires ONCE when the cursor
   * arrives and nothing fires again while it sits there, so a flag cleared every
   * frame would read as "hovering nothing" on the very next one -- the preview
   * would apply and immediately restore, and hovering would look like it did
   * nothing at all. `mouseleave` is what clears it, which is exactly the event
   * that means the cursor left.
   */
  private hoveredConfig: ConfigRow | null = null;
  private hoveredCheckpoint: number | null = null;

  private readonly loadPreview: PreviewSession<ConfigRow, string>;
  private readonly checkpointPreview: PreviewSession<number, number>;

  /** Rebuilt whenever the catalog or the checkpoint list changes. */
  private catalogSignature = '';
  private checkpointSignature = '';
  private loadBody: HTMLElement | null = null;
  private checkpointBody: HTMLElement | null = null;

  constructor(opts: MenuBarOptions) {
    this.opts = opts;

    // Each surface has its OWN session, so browsing one cannot clobber the
    // other's snapshot. The `surface` token on the commands is what carries that
    // separation through to the Orchestrator.
    this.loadPreview = new PreviewSession<ConfigRow, string>(
      {
        onSnapshot: () => opts.send({ kind: 'snapshotConfigs', surface: 'load' }),
        onRestore: () => opts.send({ kind: 'restoreConfigs', surface: 'load' }),
        onApply: (row) =>
          opts.send({
            kind: 'previewConfig',
            category: row.category,
            name: row.name,
            surface: 'load',
          }),
      },
      configKey,
    );

    this.checkpointPreview = new PreviewSession<number, number>(
      {
        onSnapshot: () => opts.send({ kind: 'snapshotConfigs', surface: 'checkpoint' }),
        onRestore: () => opts.send({ kind: 'restoreConfigs', surface: 'checkpoint' }),
        onApply: (key) => opts.send({ kind: 'clipboardApply', key }),
      },
      (key) => key,
    );

    this.root = buildRoot();
    this.build();

    // Clicking anywhere else closes the open menu, the way a real menu bar does.
    document.addEventListener('pointerdown', (ev) => {
      if (!this.root.contains(ev.target as Node)) this.closeMenus();
    });
  }

  // -- structure ------------------------------------------------------------

  private build(): void {
    this.addMenu('File', (body) => {
      this.addItem(body, 'Save...', () => {
        this.closeMenus();
        this.opts.onSave();
      });
      this.loadBody = this.addSubmenu(body, 'Load');
    });

    this.addMenu('Edit', (body) => {
      this.addItem(body, 'Undo', () => this.opts.send({ kind: 'undo' }), 'Z');
      this.addItem(body, 'Redo', () => this.opts.send({ kind: 'redo' }), 'Shift+Z');
      this.addSeparator(body);
      this.addItem(body, 'Set Checkpoint', () => this.opts.send({ kind: 'setCheckpoint' }), 'C');
      this.addItem(
        body,
        'Load Latest Checkpoint',
        () => this.opts.send({ kind: 'loadLatestCheckpoint' }),
        'V',
      );
      this.checkpointBody = this.addSubmenu(body, 'Load Checkpoint...');
      this.addSeparator(body);
      // Ships with NO KEY BOUND: Step 8's table is Ctrl-free so the browser
      // keeps Ctrl+R, and a bare key for revert would lose the mnemonic that
      // made Ctrl+R worth having (it sits beside bare R for Reset).
      this.addItem(body, 'Revert to Saved', () => this.opts.send({ kind: 'revertConfig' }));
    });

    this.addMenu('Tools', (body) => {
      for (const [index, mode] of MOUSE_MODES.entries()) {
        const label = `${mode[0]!.toUpperCase()}${mode.slice(1)}`;
        this.addItem(
          body,
          label,
          () => this.opts.send({ kind: 'setMouseMode', mode }),
          String(index + 1),
          () => this.opts.status().mouseMode === mode,
        );
      }
    });

    this.addMenu('View', (body) => {
      this.addItem(body, 'Toggle Camera Mode', () => this.opts.send({ kind: 'toggleCameraMode' }), 'M');
      this.addItem(body, 'Reset View', () => this.opts.send({ kind: 'resetCamera' }), 'Home');
      this.addSeparator(body);
      this.addItem(body, 'Hide Panel', () => this.opts.onToggleUi(), 'X', () =>
        this.opts.isUiHidden(),
      );
    });

    this.addMenu('Simulation', (body) => {
      this.addItem(body, 'Pause / Resume', () => this.opts.send({ kind: 'togglePause' }), 'Space');
      this.addItem(body, 'Reset', () => this.opts.send({ kind: 'reset' }), 'R');
      this.addSeparator(body);
      this.addItem(body, 'Randomize Behavior', () => this.opts.send({ kind: 'randomizeBehavior' }), 'B');
      this.addItem(body, 'Randomize Seed', () => this.opts.send({ kind: 'randomizeSeed' }), 'F');
      this.addSeparator(body);
      this.addItem(body, 'Previous Preset', () => this.opts.send({ kind: 'prevPreset' }), '←');
      this.addItem(body, 'Next Preset', () => this.opts.send({ kind: 'nextPreset' }), '→');
    });
  }

  private addMenu(title: string, fill: (body: HTMLElement) => void): void {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;';

    const button = document.createElement('button');
    button.textContent = title;
    button.dataset['menu'] = title;
    button.style.cssText = MENU_BUTTON_CSS;
    button.addEventListener('click', () => {
      this.toggleMenu(title);
    });
    // Once one menu is open, sliding across the bar opens the others -- which is
    // how every menu bar behaves, and is what makes browsing them feel right.
    button.addEventListener('mouseenter', () => {
      if (this.openMenu !== null && this.openMenu !== title) this.setOpenMenu(title);
    });

    const body = document.createElement('div');
    body.dataset['menuBody'] = title;
    body.style.cssText = MENU_BODY_CSS;
    fill(body);

    wrap.append(button, body);
    this.root.append(wrap);
  }

  private addItem(
    body: HTMLElement,
    label: string,
    onClick: () => void,
    shortcut = '',
    checked?: () => boolean,
  ): void {
    const row = document.createElement('div');
    row.style.cssText = MENU_ITEM_CSS;
    row.dataset['item'] = label;

    const text = document.createElement('span');
    text.textContent = label;
    const hint = document.createElement('span');
    hint.style.cssText = 'opacity:0.45;margin-left:24px;';
    row.append(text, hint);

    row.addEventListener('click', () => {
      onClick();
      this.closeMenus();
    });
    row.addEventListener('mouseenter', () => {
      row.style.background = MENU_HOVER_BG;
    });
    row.addEventListener('mouseleave', () => {
      row.style.background = 'transparent';
    });

    // The checkmark and the shortcut are re-read each frame rather than fixed at
    // build time: the active tool and the panel's hidden state both change.
    row.dataset['shortcut'] = shortcut;
    if (checked !== undefined) {
      this.checks.push(() => {
        hint.textContent = (checked() ? '✓  ' : '') + shortcut;
      });
    } else {
      hint.textContent = shortcut;
    }

    body.append(row);
  }

  /** Per-frame updaters for menu items whose label depends on state. */
  private readonly checks: (() => void)[] = [];

  private addSeparator(body: HTMLElement): void {
    const rule = document.createElement('div');
    rule.style.cssText =
      'height:1px;margin:4px 0;background:rgba(255,255,255,0.12);';
    body.append(rule);
  }

  /** A nested body that opens on hover, for the two browsable collections. */
  private addSubmenu(body: HTMLElement, label: string): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText = `${MENU_ITEM_CSS}position:relative;`;
    row.dataset['submenu'] = label;

    const text = document.createElement('span');
    text.textContent = label;
    const arrow = document.createElement('span');
    arrow.textContent = '›';
    arrow.style.cssText = 'opacity:0.45;margin-left:24px;';
    row.append(text, arrow);

    const inner = document.createElement('div');
    inner.dataset['submenuBody'] = label;
    inner.style.cssText = `${MENU_BODY_CSS}left:100%;top:0;`;

    row.addEventListener('mouseenter', () => {
      row.style.background = MENU_HOVER_BG;
      inner.style.display = 'block';
    });
    row.addEventListener('mouseleave', () => {
      row.style.background = 'transparent';
      inner.style.display = 'none';
    });

    row.append(inner);
    body.append(row);
    return inner;
  }

  // -- the two browsable collections ----------------------------------------

  /**
   * Rebuild the Load submenu, but only when the catalog actually changed.
   *
   * The signature check is not an optimization: rebuilding every frame would
   * replace the row under the cursor sixty times a second, and `mouseenter`
   * would never fire on a node that survives long enough to be hovered.
   */
  private syncLoadMenu(status: Status): void {
    const signature = JSON.stringify(status.configCategories);
    if (signature === this.catalogSignature || this.loadBody === null) return;
    this.catalogSignature = signature;
    this.loadBody.textContent = '';

    const categories = Object.entries(status.configCategories);
    if (categories.length === 0) {
      this.loadBody.append(disabledRow('no configs found'));
      return;
    }

    for (const [category, names] of categories) {
      const header = document.createElement('div');
      header.textContent = `${category} (${names.length})`;
      header.style.cssText =
        'padding:4px 12px;font-size:10px;opacity:0.5;text-transform:uppercase;' +
        'letter-spacing:0.5px;';
      this.loadBody.append(header);

      for (const name of names) {
        const row: ConfigRow = { category, name };
        this.loadBody.append(
          this.browserRow(
            name,
            () => {
              // Commit: drop the snapshot so closing does not undo this.
              this.loadPreview.commit(configKey(row));
              this.opts.send({ kind: 'loadConfig', category, name });
              this.closeMenus();
            },
            () => {
              // Deleting the previewed config must not leave it applied.
              this.loadPreview.restoreNow();
              this.loadPreview.forget();
              this.opts.onDeleteConfig(category, name);
              this.closeMenus();
            },
            (hovered) => {
              // Only clear if THIS row is the one recorded: a row-to-row move
              // fires the new row's `mouseenter` before the old row's
              // `mouseleave`, and clearing unconditionally would wipe the row
              // the cursor just arrived on.
              if (hovered) this.hoveredConfig = row;
              else if (this.hoveredConfig === row) this.hoveredConfig = null;
            },
          ),
        );
      }
    }
  }

  private syncCheckpointMenu(status: Status): void {
    const signature = status.checkpoints.map((c) => `${c.key}:${c.name}`).join(',');
    if (signature === this.checkpointSignature || this.checkpointBody === null) return;
    this.checkpointSignature = signature;
    this.checkpointBody.textContent = '';

    if (status.checkpoints.length === 0) {
      this.checkpointBody.append(disabledRow('no checkpoints this session'));
      return;
    }

    const header = document.createElement('div');
    header.textContent = `${status.checkpoints.length} checkpoint(s), newest first`;
    header.style.cssText = 'padding:4px 12px;font-size:10px;opacity:0.5;';
    this.checkpointBody.append(header);

    for (const checkpoint of status.checkpoints) {
      this.checkpointBody.append(
        this.browserRow(
          checkpoint.name,
          () => {
            this.checkpointPreview.commit(checkpoint.key);
            this.opts.send({ kind: 'loadCheckpoint', key: checkpoint.key });
            this.closeMenus();
          },
          () => {
            // Deleted immediately, with no confirmation: a checkpoint is a cheap
            // session-only scratch copy, unlike File > Load's X which destroys a
            // stored config (`config_menu.py:310-313`).
            this.checkpointPreview.restoreNow();
            this.checkpointPreview.forget();
            this.opts.send({ kind: 'deleteCheckpoint', key: checkpoint.key });
          },
          (hovered) => {
            if (hovered) this.hoveredCheckpoint = checkpoint.key;
            else if (this.hoveredCheckpoint === checkpoint.key) {
              this.hoveredCheckpoint = null;
            }
          },
        ),
      );
    }
  }

  /**
   * One browsable row: a name to load, and an X to remove it.
   *
   * The name and the X are SEPARATE flex children with disjoint hit areas -- see
   * the file header for the imgui bug that made this worth stating.
   */
  private browserRow(
    label: string,
    onOpen: () => void,
    onDelete: () => void,
    onHover: (hovered: boolean) => void,
  ): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText = `${MENU_ITEM_CSS}gap:8px;`;
    row.dataset['row'] = label;

    const name = document.createElement('span');
    name.textContent = label;
    name.style.cssText = 'flex:1;min-width:110px;';
    name.addEventListener('click', onOpen);

    const remove = document.createElement('button');
    remove.textContent = '×';
    remove.title = `Delete ${label}`;
    remove.style.cssText = DELETE_BUTTON_CSS;
    remove.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onDelete();
    });

    // Hovering the X counts as hovering the row, or the preview would snap back
    // as the cursor crossed to it (`config_menu.py:263-267`).
    row.addEventListener('mouseenter', () => {
      row.style.background = MENU_HOVER_BG;
      onHover(true);
    });
    row.addEventListener('mouseleave', () => {
      row.style.background = 'transparent';
      onHover(false);
    });

    row.append(name, remove);
    return row;
  }

  // -- lifecycle ------------------------------------------------------------

  private toggleMenu(title: string): void {
    this.setOpenMenu(this.openMenu === title ? null : title);
  }

  private setOpenMenu(title: string | null): void {
    this.openMenu = title;
    for (const body of this.root.querySelectorAll<HTMLElement>('[data-menu-body]')) {
      body.style.display = body.dataset['menuBody'] === title ? 'block' : 'none';
    }
    // A closed menu is a closed browse: restore whatever was being previewed,
    // unless a click committed it. The sticky hover is cleared with it -- a
    // menu closed while the cursor sat on a row never receives that row's
    // `mouseleave`, so reopening would otherwise re-preview a stale entry.
    if (title !== 'File') {
      this.hoveredConfig = null;
      this.loadPreview.end();
    }
    if (title !== 'Edit') {
      this.hoveredCheckpoint = null;
      this.checkpointPreview.end();
    }
    if (title === 'File') this.loadPreview.begin();
    if (title === 'Edit') this.checkpointPreview.begin();
  }

  private closeMenus(): void {
    this.setOpenMenu(null);
  }

  /**
   * Once per frame: rebuild the browsable lists if they changed, apply the
   * hover previews, and update the state-dependent labels.
   */
  refresh(status: Status): void {
    this.syncLoadMenu(status);
    this.syncCheckpointMenu(status);
    for (const check of this.checks) check();

    // NOT cleared afterwards -- see `hoveredConfig`. `mouseleave` clears it.
    this.loadPreview.sync(this.hoveredConfig);
    this.checkpointPreview.sync(this.hoveredCheckpoint);
  }

  dispose(): void {
    this.root.remove();
  }
}

// -- styling ----------------------------------------------------------------

const MENU_HOVER_BG = 'rgba(255,255,255,0.10)';

const MENU_BUTTON_CSS =
  'background:transparent;border:0;color:#e8e8ea;font:11px system-ui,sans-serif;' +
  'padding:6px 10px;cursor:pointer;';

const MENU_BODY_CSS =
  'display:none;position:absolute;top:100%;left:0;min-width:180px;z-index:60;' +
  'background:rgba(28,28,30,0.98);border:1px solid rgba(255,255,255,0.12);' +
  'border-radius:4px;padding:4px 0;box-shadow:0 6px 20px rgba(0,0,0,0.5);';

const MENU_ITEM_CSS =
  'display:flex;align-items:center;justify-content:space-between;' +
  'padding:5px 12px;cursor:pointer;white-space:nowrap;' +
  'font:11px system-ui,sans-serif;color:#e8e8ea;';

const DELETE_BUTTON_CSS =
  'background:transparent;border:0;color:#d06060;cursor:pointer;' +
  'font:12px system-ui,sans-serif;padding:0 4px;line-height:1;';

function disabledRow(text: string): HTMLElement {
  const row = document.createElement('div');
  row.textContent = text;
  row.style.cssText = `${MENU_ITEM_CSS}opacity:0.45;cursor:default;`;
  return row;
}

/** The bar itself: a strip along the top, left of the panel. */
function buildRoot(): HTMLElement {
  const el = document.createElement('nav');
  el.id = 'fluoddity-menubar';
  el.style.cssText =
    'position:fixed;top:0;left:0;display:flex;z-index:50;' +
    'background:rgba(28,28,30,0.92);border-bottom-right-radius:4px;' +
    'border-right:1px solid rgba(255,255,255,0.10);' +
    'border-bottom:1px solid rgba(255,255,255,0.10);';
  document.body.append(el);
  return el;
}
