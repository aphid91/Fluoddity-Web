/**
 * The menu bar: File, History, Tools, Editor, Simulation, Help.
 *
 * **The menu TITLES are load-bearing strings**, not just labels: `setOpenMenu`
 * gates each hover-preview session on the open menu's title, so renaming one
 * without renaming its comparison silently stops the snapshot from being taken
 * and unhovering restores nothing. That is why the two are within a screen of
 * each other rather than the titles living in a constant far away.
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
 *     entry instead of deleting it. Do not "tidy" this into an overlay.
 *
 *     `browserRow` DOES listen on the whole row, which sounds like the same
 *     shape and is not. The X is a real child element, so it is the click's
 *     target and handles it first; its `stopPropagation` is what keeps the
 *     event off the row. The imgui version had no such child -- the button was
 *     painted over a region that had already claimed the click. Deleting that
 *     one `stopPropagation` call is the way to bring the bug back.
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
import { ARCHIVE_CATEGORY, CORE_CATEGORY } from '../config/configStore.ts';
import { localHotkeyLabel } from './hotkeys.ts';
import { PreviewSession } from './previewSession.ts';
import { Tooltip } from './tooltip.ts';
import { MENU_HELP } from './menuHelp.ts';

export interface MenuBarOptions {
  readonly send: (command: Command) => void;
  readonly status: () => Status;
  /** Open the save dialog. Owned by the panel, since it outlives the menu. */
  readonly onSave: () => void;
  /**
   * Copy a link to the live project. Owned by the panel, like `onSave`.
   *
   * Not a `send`, because the clipboard is not the Orchestrator's -- see
   * `CommandBus.projectDocument`.
   */
  readonly onCopyShareLink: () => void;
  /**
   * Load a project from a share URL sitting on the clipboard. `onCopyShareLink`
   * inverted, and owned by the panel for the same reason.
   */
  readonly onPasteShareLink: () => void;
  /**
   * Write every user save into a folder the user picks. Owned by the panel.
   *
   * MUST REACH THE FOLDER PICKER WITHOUT AWAITING FIRST -- see
   * `ui/saveFolder.ts`. The menu calls this synchronously from the click so the
   * gesture is still live when the panel opens the picker.
   */
  readonly onExportSaves: () => void;
  /** Read a folder of v8 files into the save list. `onExportSaves` inverted. */
  readonly onImportSaves: () => void;
  /** Ask to delete a stored config. Opens the confirm dialog. */
  readonly onDeleteConfig: (category: string, name: string) => void;
  /**
   * Ask to reset every editor preference. Opens the confirm dialog.
   *
   * A callback rather than a `send` of `resetPreferences` directly, for the same
   * reason `onDeleteConfig` is one: the dialogs outlive the menu and are owned by
   * the panel, so the menu asks for the question to be put rather than issuing
   * the command itself. The command goes out only if the user says yes.
   */
  readonly onResetPreferences: () => void;
  /** Toggle the settings panel. The `X` key's action, as a menu item. */
  readonly onToggleUi: () => void;
  /** Whether the panel is currently hidden, for the checkmark. */
  readonly isUiHidden: () => boolean;
  /** Re-show the welcome splash. Owned by the panel, like the dialogs. */
  readonly onShowWelcome: () => void;
  /**
   * Show the in-depth guide -- the same overlay, another of its documents.
   *
   * A SEPARATE callback rather than an argument on `onShowWelcome`, so this menu
   * never learns that they share a surface. Which of them the panel puts
   * them on is the panel's business.
   */
  readonly onShowGuide: () => void;
  /** Show the key and mouse reference. Split from the guide, same reasoning. */
  readonly onShowControls: () => void;
  /**
   * Show or hide the Recording Controls tab.
   *
   * A TOGGLE, not a command that opens something: ticking it adds the tab and
   * un-ticking removes it, which is why the menu row carries a checkmark rather
   * than the `...` that marks the rows opening a dialog.
   */
  readonly onToggleExportVideo: () => void;
  /** Whether the Recording Controls tab is showing, for the checkmark. */
  readonly isExportVideoShown: () => boolean;
  /**
   * Build for touch. Defaults to false.
   *
   * Today this only reaches the tooltip, whose affordance is per instance --
   * hover on a mouse, long press on a finger. The menu's own hover-to-open
   * behaviour is deliberately left alone.
   */
  readonly mobile?: boolean;
}

/** One entry in the Load menu, flattened out of `configCategories`. */
interface ConfigRow {
  readonly category: string;
  readonly name: string;
}

const configKey = (row: ConfigRow): string => `${row.category}/${row.name}`;

/**
 * How much of the viewport a scrolling submenu may fill.
 *
 * Leaves room for the menu bar above it and a margin below, so a long Load list
 * scrolls inside the screen rather than running off the bottom of it.
 */
const SUBMENU_MAX_VIEWPORT_FRACTION = 0.7;

/** Breathing room between a submenu and the window edge. See `fitSubmenu`. */
const SUBMENU_MARGIN_PX = 8;

/**
 * Where a touch submenu sheet starts, in px from the top of the viewport.
 *
 * Clears the menu bar, which is `position:fixed` at the top-left and about 28px
 * tall. HAND-COMPUTED rather than measured, matching `PANEL_TOP_PX` in
 * `panel.ts`, and related to that constant by intent only: the sheet is opened
 * from the bar and should sit directly under it, where the panels deliberately
 * sit lower to clear the mutation overlay as well.
 */
const MOBILE_SUBMENU_TOP_PX = 30;

/**
 * How long a submenu stays open after the cursor leaves it.
 *
 * Long enough to cross the corner between the parent row and a flyout entry far
 * down the list, short enough that a menu the user has finished with does not
 * linger. Below roughly 150ms the diagonal is still a race; much above 400ms and
 * deliberately leaving feels unresponsive.
 */
const SUBMENU_CLOSE_DELAY_MS = 300;

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

  /**
   * Touch only: the config tapped for preview but not yet committed.
   *
   * Two fields for one fact because both forms are needed and neither derives
   * cheaply from the other: the KEY compares against the next tap (is this the
   * same row again?) and the ROW carries the category and name the commit
   * sends. Cleared together, always.
   *
   * `null` means nothing has been tapped this visit, so closing the menu commits
   * nothing and leaves the project where it was.
   */
  private pendingTouchPreview: string | null = null;
  private pendingTouchRow: ConfigRow | null = null;

  /** Whether this bar was built for touch. See the tap-preview in `browserRow`. */
  private readonly mobile: boolean;

  private readonly loadPreview: PreviewSession<ConfigRow, string>;
  private readonly checkpointPreview: PreviewSession<number, number>;

  /** Rebuilt whenever the catalog or the checkpoint list changes. */
  private catalogSignature = '';
  private checkpointSignature = '';
  private loadBody: HTMLElement | null = null;
  private checkpointBody: HTMLElement | null = null;

  /**
   * Which Load categories are folded shut.
   *
   * HELD ON THE INSTANCE, NOT IN THE DOM, because `syncLoadMenu` throws the
   * whole subtree away and rebuilds it whenever the catalog changes. State kept
   * on the elements would be destroyed by every save and every delete, and the
   * menu would spring open again at the least convenient moment.
   *
   * Session-only: not a preference, so it does not survive a reload. Folding a
   * category is a "get this out of my way while I look at the other one" move
   * rather than a setting, and it costs one click to redo.
   *
   * Starts holding ARCHIVE ONLY, and every File > Load open re-folds it (see
   * `setOpenMenu`). Core and Custom are open by default, so nothing a user works
   * with day to day is hidden from them; the 176-entry v8 backlog is folded
   * because it is a thing to go looking through occasionally, and unfolded it
   * would be the overwhelming majority of the menu.
   *
   * ARCHIVE IS RE-FOLDED PER VISIT rather than remembered, unlike the others:
   * expanding it is "let me dig through the backlog now", which does not imply
   * wanting to be dropped back into 176 rows on the next unrelated visit to
   * Save. Expanding Core or Custom, by contrast, is left exactly as the user put
   * it for the rest of the session.
   */
  private readonly collapsedCategories = new Set<string>([ARCHIVE_CATEGORY]);

  /**
   * One "shut this submenu now" per submenu, for `setOpenMenu` to call.
   *
   * The delayed close in `addSubmenu` is the only timer in this class, and it
   * outlives the state it was scheduled against: closing File while a close is
   * pending, then reopening it, would let the old timer fire and hide a flyout
   * the user had just reopened. Closing them all when the OPEN MENU changes
   * settles that -- the submenu of a menu that is no longer open should be shut
   * regardless of where the cursor went.
   */
  private readonly submenuClosers: (() => void)[] = [];

  /**
   * Per-category "re-apply your fold state to the DOM", keyed by category.
   *
   * Populated by `syncLoadMenu` and cleared by it, since each closure captures
   * that build's header and rows. Exists so `foldArchive` can fold a category
   * between rebuilds -- the signature guard means a rebuild is NOT guaranteed to
   * happen when the menu closes.
   */
  private readonly applyCollapsedFns = new Map<string, () => void>();

  /**
   * The pending "the cursor left this menu" close, or `null`.
   *
   * ONE TIMER FOR THE WHOLE BAR rather than one per menu, because at most one
   * dropdown is ever open -- so at most one can be pending, and a second
   * scheduled close means the first is already irrelevant. `scheduleMenuClose`
   * cancels before it schedules for exactly that reason.
   */
  private menuCloseTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The bar's own help tooltip.
   *
   * ITS OWN INSTANCE, not the panel's. `Tooltip` is documented as "one per
   * panel" and holds a single floating element it repositions per hover, so
   * sharing one between the bar and a panel would be fine mechanically -- but
   * the bar is constructed before any panel and outlives every rebuild of one,
   * and taking one as a constructor argument would make the menu depend on a
   * panel existing.
   *
   * Mounted on `document.body`, which is where the default puts it: the bar is
   * `position:fixed` at the top-left and its dropdowns hang below it, so the
   * tooltip has to be free to sit outside the menu's own subtree.
   */
  private readonly tooltip: Tooltip;

  constructor(opts: MenuBarOptions) {
    this.opts = opts;
    // On touch, menu-row help becomes long-press-to-show in a bottom strip
    // rather than hover -- which matters more here than anywhere else, because
    // a synthesized `mouseenter` fires on every menu row a finger touches on its
    // way to the one it wants. See `tooltip.ts`.
    this.mobile = opts.mobile ?? false;
    this.tooltip = new Tooltip(document.body, this.mobile);

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
    //
    // =====================================================================
    // THE DISMISSING PRESS MUST NOT ALSO REACH THE CANVAS
    // =====================================================================
    //
    // On a mouse this was already true by accident: the app binds `pointerdown`
    // on the canvas, so a click on the canvas to dismiss a menu DOES select a
    // particle -- which is a real wart, but a mouse user aims precisely and can
    // dismiss by clicking the menu title again instead.
    //
    // On touch it is not a wart, it is a trap. The menus cover a large share of
    // a 390px screen, "somewhere else" is almost always the canvas, and the
    // stray gesture is not a harmless click: in Draw it paints a stroke, and in
    // Select it re-aims the cohort. Closing a menu must not edit the project.
    //
    // **CAPTURE PHASE, AND `stopPropagation` ON THE WAY DOWN.** The canvas
    // listeners are on the canvas itself and on `window` at the BUBBLE phase, so
    // a capture-phase listener on `document` runs strictly before all of them
    // and can take the event out of play. Doing this at the bubble phase would
    // be too late -- the canvas would already have handled it.
    //
    // ONLY WHEN A MENU IS ACTUALLY OPEN, which is what keeps this from being a
    // document-wide input filter. With nothing open the branch falls through and
    // every press behaves exactly as it did before this existed.
    document.addEventListener(
      'pointerdown',
      (ev) => {
        // **AN OPEN TOUCH SHEET COUNTS AS AN OPEN MENU**, even though
        // `openMenu` is null while one is up: opening it deliberately clears
        // that field so the dropdown behind it goes away (see `addSubmenu`).
        // Without this second test the sheet would have no dismissal at all --
        // the top-level guard would return early and the tap would fall through
        // to the canvas, which is the exact edit-by-accident this listener
        // exists to prevent.
        const sheetOpen = this.mobile && this.openSubmenu();
        if (this.openMenu === null && !sheetOpen) return;
        if (this.root.contains(ev.target as Node)) return;
        this.closeMenus();
        // The press has done its job -- it dismissed the menu. Letting it
        // continue would spend the same gesture twice.
        ev.stopPropagation();
        // `preventDefault` too, so the browser does not synthesize the
        // `mousedown`/`click` pair that would otherwise follow this touch and
        // arrive at the canvas after the fact.
        ev.preventDefault();
      },
      { capture: true },
    );
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

    // A MENU OF ITS OWN, not two more rows under File.
    //
    // File is about this browser: Save writes to IndexedDB, Load reads the
    // shipped library back. Both of these cross a boundary to somebody else --
    // one puts the project on the clipboard for sending, the other takes one
    // that arrived. They are each other's inverse, and pairing them where the
    // symmetry is visible says more than filing them next to operations they
    // only superficially resemble.
    this.addMenu('Share', (body) => {
      this.addItem(
        body,
        'Copy Link to This Project',
        () => {
          this.closeMenus();
          this.opts.onCopyShareLink();
        },
        localHotkeyLabel('copyShareLink'),
      );
      this.addItem(
        body,
        'Load Project from Clipboard URL',
        () => {
          this.closeMenus();
          this.opts.onPasteShareLink();
        },
        localHotkeyLabel('pasteShareLink'),
      );
      // UNDER SHARE, with a separator. The two rows above put a project in
      // someone else's hands as a link; this puts it in their hands as a video.
      // That is the same intent -- getting the work OUT -- and a different
      // medium, which is what the separator marks.
      this.addSeparator(body);
      // Closes the menu on click, like every other row -- `addItem` does that
      // for all of them. That is right here even though this is a toggle: the
      // feedback is the Recording Controls TAB appearing in the panel behind the
      // menu, which is a far larger signal than a checkmark on a row that is
      // about to be dismissed. The checkmark is for the NEXT visit, to say
      // whether the tab is already up.
      this.addItem(
        body,
        'Video Export Controls',
        () => this.opts.onToggleExportVideo(),
        '',
        () => this.opts.isExportVideoShown(),
      );
      // A THIRD MEDIUM, and the separator marks it as the rows above do. A link
      // carries one project, a video carries what it looked like; these carry
      // the save library itself, as the v8 files it is already stored as -- which
      // is the form `configs/` takes, so an exported folder can be dropped
      // straight in as presets.
      this.addSeparator(body);
      this.addItem(body, 'Export Saves as JSON...', () => {
        this.closeMenus();
        this.opts.onExportSaves();
      });
      this.addItem(body, 'Import Saves from JSON...', () => {
        this.closeMenus();
        this.opts.onImportSaves();
      });
    });

    // "History" rather than "Edit". Every item under it moves along the undo
    // timeline -- undo, redo, checkpoints, revert -- and "Edit" sat one letter
    // away from "Editor" next door while describing something else entirely.
    this.addMenu('History', (body) => {
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
      //
      // NAMES THE FILE. "Revert to Saved" never said WHAT it would revert to,
      // which is a poor thing not to know about a destructive action. The name
      // comes from `status.preset`; that tracks `configOrigin` -- what
      // `revertConfig` actually reloads -- at every site that writes either one.
      // The single exception is DELETING the loaded config, which clears the
      // origin and leaves the name behind, and that is exactly the case
      // `canRevert` greys out. So the gating is what keeps the label honest.
      this.addItem(
        body,
        'Revert to Saved',
        () => this.opts.send({ kind: 'revertConfig' }),
        '',
        undefined,
        {
          label: () => {
            const status = this.opts.status();
            return status.canRevert
              ? `Revert to preset: ${status.preset}`
              : 'Revert to Saved';
          },
          enabled: () => this.opts.status().canRevert,
        },
      );
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

    // "Editor" rather than "View": the menu already held Hide Panel, which is
    // not a view at all, and it now holds the preferences reset -- so the thing
    // these items have in common is the editor, not the camera.
    this.addMenu('Editor', (body) => {
      // "Toggle Trail-Map View", not "Toggle Camera Mode". The old name
      // described the IMPLEMENTATION -- the camera has two modes -- and said
      // nothing about what the user would see. The command is unchanged.
      this.addItem(
        body,
        'Toggle Trail-Map View',
        () => this.opts.send({ kind: 'toggleCameraMode' }),
        'M',
      );
      this.addItem(body, 'Reset View', () => this.opts.send({ kind: 'resetCamera' }), 'Home');
      // Under Reset View because both discard editor state you did not save --
      // and SEPARATED from it, because Reset View is a keystroke you can take
      // back by moving the camera and this one is not undoable at all. The
      // dialog is the real guard (`dialogs.ts`); the rule is what stops the
      // click landing on the wrong row.
      this.addSeparator(body);
      this.addItem(body, 'Reset Editor Preferences...', () =>
        this.opts.onResetPreferences(),
      );
      this.addSeparator(body);
      // "Toggle UI Panels", not "Hide Panel": the panels start hidden now, so
      // for most of a session this item SHOWS them and the old label named the
      // wrong half of what it does. The checkmark still reports hidden-ness.
      this.addItem(body, 'Toggle UI Panels', () => this.opts.onToggleUi(), 'X', () =>
        this.opts.isUiHidden(),
      );
    });

    this.addMenu('Simulation', (body) => {
      this.addItem(body, 'Pause / Resume', () => this.opts.send({ kind: 'togglePause' }), 'Space');
      this.addItem(body, 'Reset', () => this.opts.send({ kind: 'reset' }), 'R');
      this.addSeparator(body);
      this.addItem(body, 'Randomize Behavior', () => this.opts.send({ kind: 'randomizeBehavior' }), 'B');
      // Greyed in the two states where the command cannot change the picture,
      // and greyed on EXACTLY the conditions the mutation overlay uses for its
      // own copy of this button (`refreshReroll`) -- the bar and this menu must
      // never disagree about whether an action is available.
      //
      //   - the all-zero sentinel: there is no authored behaviour to mutate,
      //     and `Reroll All Behavior` is the action that state supports;
      //   - Mutation Scale at 0: the seed still moves, but it is multiplied by
      //     zero, so nothing on screen changes.
      //
      // **`F` IS INERT IN BOTH, and that is a deliberate reversal.** The
      // sentinel case used to REDIRECT `F` to Randomize Behavior, on the
      // argument that the two collapse to one act there. They do -- but it
      // meant one key did different things in different states while its
      // on-screen twin was greyed, which is exactly the confusion the greying
      // is meant to remove. `B` is now the only key for Randomize Behavior and
      // `F` only ever rerolls mutations; when this row is greyed, `F` does
      // nothing. See `hotkeys.ts` and the `randomizeSeed` case.
      //
      // `mutationScale` is readable even with the panels hidden -- the
      // closed-panel payload keeps every config field but `rule` for the
      // always-visible bar (`Orchestrator.settingsSources`). A missing field
      // degrades to enabled, matching the overlay.
      this.addItem(
        body,
        'Reroll Mutations',
        () => this.opts.send({ kind: 'randomizeSeed' }),
        'F',
        undefined,
        {
          label: () => 'Reroll Mutations',
          enabled: () => {
            const status = this.opts.status();
            return !status.ruleIsGenerated && status.editConfig['mutationScale'] !== 0;
          },
        },
      );
      // PREVIOUS / NEXT PRESET WERE REMOVED HERE. They were the last callers of
      // the `prevPreset`/`nextPreset` commands, which still exist in the
      // Orchestrator and in `projectCommands.switchPreset` -- unreferenced, and
      // deliberately left that way, so re-exposing them is one `addItem` rather
      // than a re-implementation.
      //
      // What replaced them is File > Load, which browses the whole catalog by
      // name with hover-preview. Stepping blindly through 175 presets two rows
      // at a time was the worse half of that, and it had already lost its arrow
      // keys to the cohort stepper (`hotkeys.ts`).
    });

    // Last, where a Help menu goes. The title is NOT compared anywhere in
    // `setOpenMenu` -- only File and History gate hover-preview sessions -- so
    // this one is an ordinary menu with nothing to keep in sync.
    this.addMenu('Help', (body) => {
      // THREE ROWS, one overlay. The welcome is the five-line first-run screen;
      // the guide explains what the simulation is doing and the controls list
      // what to press. Splitting them is the whole point -- a returning user
      // wants one of the two references, not the pitch, and usually the keys.
      this.addItem(body, 'Welcome...', () => this.opts.onShowWelcome());
      // The shortcuts are READ FROM THE TABLE, so a rebind moves these labels
      // with them.
      this.addItem(
        body,
        'Guide...',
        () => this.opts.onShowGuide(),
        localHotkeyLabel('showGuide'),
      );
      this.addItem(
        body,
        'Controls...',
        () => this.opts.onShowControls(),
        localHotkeyLabel('showControls'),
      );
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

    // LEAVING THE MENU SHUTS IT, on the same delay the submenus use.
    //
    // Without this the only ways out of an open dropdown were back onto its own
    // button or a click on the canvas -- and the canvas click is not a neutral
    // dismissal: it is a real gesture that draws, shoves or selects depending on
    // the tool. Requiring a side effect to close a menu is the thing this fixes.
    //
    // ON THE WRAPPER, not the button or the body: the wrapper is the only node
    // that contains BOTH, so travelling from the title down into the rows never
    // leaves it. The submenu flyouts are descendants of the body, so they are
    // inside it too -- `Load`'s list keeps the parent menu open exactly as it did
    // when the only close was a click elsewhere.
    //
    // THE DELAY IS THE SUBMENUS' OWN CONSTANT, and shared on purpose. The
    // dropdown and its flyout are one surface to the user, so two different
    // grace periods would make the same diagonal forgiving in one direction and
    // not the other. It also covers the small gap between the bar and the body
    // that a fast diagonal can clip.
    wrap.addEventListener('mouseenter', () => {
      this.cancelMenuClose();
    });
    wrap.addEventListener('mouseleave', () => {
      // ONLY THIS MENU. Sliding along the bar fires this wrapper's `mouseleave`
      // before the next button's `mouseenter`, so an unconditional close here
      // would shut the menu the cursor is arriving at a moment later. Re-reading
      // `openMenu` when the timer fires is what settles that: by then the next
      // menu has opened and this closer no longer applies.
      this.scheduleMenuClose(title);
    });

    const body = document.createElement('div');
    body.dataset['menuBody'] = title;
    // Capped like the submenus, though these hang from the top of the screen and
    // only overflow if a menu grows very long. Cheap, and it means no menu can
    // become unreachable by growing.
    //
    // NOT `overflow-y:auto` here: these bodies HOST the submenu flyouts, which
    // are absolutely positioned outside their right edge, and any `overflow`
    // other than `visible` would clip them into a scrollbar instead. `Load`
    // does its own scrolling for exactly this reason.
    body.style.cssText = `${MENU_BODY_CSS}max-height:${Math.round(
      SUBMENU_MAX_VIEWPORT_FRACTION * 100,
    )}vh;`;
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
    live?: {
      /** Re-read each frame. The row's TEXT only -- `data-item` stays fixed. */
      readonly label: () => string;
      /** False greys the row and makes the click a no-op. */
      readonly enabled: () => boolean;
    },
  ): void {
    const row = document.createElement('div');
    row.style.cssText = MENU_ITEM_CSS;
    // THE STATIC LABEL, always -- this is what `uiCheck.mjs` and the tests select
    // on. A dynamic label must not move it, or the selector would depend on which
    // preset happens to be loaded.
    row.dataset['item'] = label;

    const text = document.createElement('span');
    text.textContent = label;
    const hint = document.createElement('span');
    hint.style.cssText = 'opacity:0.45;margin-left:24px;';
    row.append(text, hint);

    // KEYED ON THE STATIC LABEL, which is the same identity `data-item` carries
    // -- so a row that renames itself per frame (`Revert to Saved`) keeps one
    // stable help entry rather than losing it the moment the label changes.
    // A row with no entry in the table gets nothing: `attach` early-returns on
    // empty content, so this costs one lookup and adds no listeners.
    this.tooltip.attach(row, { title: label, body: MENU_HELP[label] ?? '' });

    row.addEventListener('click', () => {
      // A greyed row is inert. Without this the click would still fire and be
      // silently swallowed downstream, which is the state this replaces.
      if (live !== undefined && !live.enabled()) return;
      onClick();
      this.closeMenus();
    });
    row.addEventListener('mouseenter', () => {
      if (live !== undefined && !live.enabled()) return;
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

    // Same per-frame pump as the checkmark above. `disabledRow`'s values, so a
    // greyed item looks the same whether it was built dead or went dead.
    if (live !== undefined) {
      this.checks.push(() => {
        const on = live.enabled();
        text.textContent = live.label();
        row.style.opacity = on ? '1' : '0.45';
        row.style.cursor = on ? 'pointer' : 'default';
      });
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
    // SCROLLS RATHER THAN RUNNING OFF THE SCREEN. The Load list is as long as
    // the preset library, which is not a number this code gets to choose --
    // `max-height` against the viewport is what keeps it reachable at any size.
    //
    // `overscroll-behavior:contain` stops a wheel that reaches the end of this
    // list from continuing into the page behind it, which would scroll the app
    // out from under an open menu.
    //
    // `min-width:0` OVERRIDES the 180px floor in `MENU_BODY_CSS`, which is set
    // for top-level dropdowns and is far too wide here: rows are `nowrap`, so a
    // flyout shrink-wraps its longest preset name on its own. The declaration
    // has to come AFTER the base string -- this is one `cssText`, so the later
    // one wins.
    // =====================================================================
    // TOUCH: A LEFT-ANCHORED SHEET, NOT A FLYOUT
    // =====================================================================
    //
    // `left:100%` puts the list beside the row that opened it, which is the
    // right shape for a cursor -- it appears where the pointer already is and
    // the pointer travels into it. There is no pointer on a phone, so all that
    // geometry buys is a list starting a third of the way across a 390px screen
    // with its long preset names running off the right edge.
    //
    // On touch it becomes a panel pinned to the LEFT EDGE of the viewport
    // instead: `position:fixed` takes it out of the row's coordinate space
    // entirely, so it no longer inherits the offset that put it mid-screen.
    // Anchored under the menu bar and given the full height it can use, since a
    // phone has vertical room where it has no horizontal room.
    //
    // `min-width:0` on the desktop lets a flyout shrink-wrap its longest name.
    // Here the width is stated instead: a shrink-wrapped list on a narrow screen
    // is a ragged column whose width changes with whichever preset happens to
    // have the longest name.
    //
    // **NARROW ON PURPOSE.** An earlier version took 78vw, which fit the longest
    // preset name and covered most of the canvas to do it -- and the canvas is
    // what the list is FOR, since every tap previews onto it. At ~31vw the sheet
    // takes a strip down one side and leaves the artwork visible beside it, which
    // is what makes tap-to-preview worth having. The handful of names longer than
    // the column ellipsize (`MENU_ITEM_CSS` is `nowrap`), which costs the tail of
    // a name that is still identifiable from its head.
    inner.style.cssText = this.mobile
      ? `${MENU_BODY_CSS}position:fixed;left:0;top:${String(MOBILE_SUBMENU_TOP_PX)}px;` +
        'width:min(31vw,128px);min-width:0;border-radius:0 6px 6px 0;' +
        `max-height:calc(100dvh - ${String(MOBILE_SUBMENU_TOP_PX)}px - 12px);` +
        'overflow-y:auto;overscroll-behavior:contain;' +
        '-webkit-overflow-scrolling:touch;'
      : `${MENU_BODY_CSS}left:100%;top:0;min-width:0;` +
        `max-height:${Math.round(SUBMENU_MAX_VIEWPORT_FRACTION * 100)}vh;` +
        'overflow-y:auto;overscroll-behavior:contain;';

    // The pending close from `mouseleave`, or `null`. See `SUBMENU_CLOSE_DELAY_MS`.
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelClose = (): void => {
      if (closeTimer === null) return;
      clearTimeout(closeTimer);
      closeTimer = null;
    };
    const closeNow = (): void => {
      cancelClose();
      row.style.background = 'transparent';
      inner.style.display = 'none';
    };
    // Registered so `setOpenMenu` can drop a pending close: a timer that fires
    // after the whole menu reopened would hide a submenu the user just asked for.
    this.submenuClosers.push(closeNow);

    // TOUCH: THE ROW IS A BUTTON, and opening the list DISMISSES the dropdown it
    // came from. On the desktop the parent menu stays up because the flyout sits
    // beside it and the two read as one surface; on a phone the sheet covers most
    // of the screen, so leaving the dropdown behind it is a second layer nobody
    // can see or reach. Closing it also frees the whole viewport for the list.
    //
    // `setOpenMenu(null)` is NOT used here, and that is the subtle part: it runs
    // `submenuClosers`, which would shut this sheet a moment after opening it.
    // Only the top-level bodies are hidden, leaving the fixed-position sheet --
    // which is no longer a visual child of any of them -- on screen.
    if (this.mobile) {
      row.addEventListener('click', (ev) => {
        // The row is inside the dropdown being hidden; without this the click
        // continues to the document listener that closes menus on an outside
        // press, which would immediately shut the sheet as well.
        ev.stopPropagation();
        this.hideMenuBodies(null);
        this.openMenu = null;
        inner.style.display = 'block';
        inner.scrollTop = 0;
      });
    }

    row.addEventListener('mouseenter', () => {
      // TOUCH DOES NOT OPEN ON HOVER. A tap synthesizes `mouseenter`, so without
      // this the flyout would open here -- before the click handler above ran --
      // and then be hidden by `hideMenuBodies` a moment later.
      if (this.mobile) return;
      // BEFORE anything else: re-entering within the grace period means the
      // cursor never really left, and the half-open state must not be finished.
      cancelClose();
      row.style.background = MENU_HOVER_BG;
      // Already open and merely re-entered -- leave the scroll position alone.
      // Resetting here would yank a long list back to the top every time the
      // cursor clipped the edge, which is the very thing the delay prevents.
      if (inner.style.display === 'block') return;
      inner.style.display = 'block';
      // Opened fresh each time. A submenu left half-scrolled from a previous
      // visit reopens showing the middle of the list, which reads as the menu
      // having lost the top of itself.
      inner.scrollTop = 0;
      this.fitSubmenu(row, inner);
    });
    row.addEventListener('mouseleave', (ev) => {
      // TOUCH NEVER CLOSES ON LEAVE. The sheet is `position:fixed` and no longer
      // overlaps its own row, so a finger moving into it leaves the row -- which
      // under the desktop rule would schedule the close that this whole grace
      // period exists to avoid. The sheet is dismissed by a tap outside it
      // instead; see `armMobileSubmenuDismiss`.
      if (this.mobile) return;
      // NOT WHILE THE CURSOR IS ON THE SCROLLBAR. The bar sits inside `inner`'s
      // padding box but outside its content, and dragging it puts the pointer
      // over the scrollbar itself -- which fires `mouseleave` on the row and
      // would close the menu underneath the drag. `relatedTarget` is the element
      // being entered; when that is still inside this submenu, the cursor has
      // not actually left.
      const to = ev.relatedTarget as Node | null;
      if (to !== null && (inner.contains(to) || inner === to)) return;
      // ON A DELAY, not at once. The flyout opens at `left:100%` beside a row
      // near the top of a list that can be 175 rows long, so the natural move --
      // from `Load` diagonally down to a row far below -- cuts the corner and
      // leaves both elements for a few pixels. Closing on that instant makes the
      // menu impossible to reach without tracing an L. The grace period is in
      // TIME rather than space because the cursor is only ever outside briefly.
      cancelClose();
      closeTimer = setTimeout(closeNow, SUBMENU_CLOSE_DELAY_MS);
    });

    // **THE TOUCH SHEET IS REPARENTED OUT OF THE ROW**, and it has to be.
    // `position:fixed` escapes the row's COORDINATE space but not its
    // VISIBILITY: `display:none` on any ancestor hides every descendant however
    // it is positioned. Since opening the sheet also hides the dropdown the row
    // lives in, a sheet left inside that row rendered at 0x0 -- present in the
    // DOM, correctly styled, and invisible.
    //
    // Moved to `root` rather than to `document.body` so it stays inside the
    // element `contains` is tested against: the outside-tap dismissal asks
    // whether the press landed within the bar, and a sheet outside it would
    // dismiss itself on every tap on its own rows.
    if (this.mobile) {
      this.root.append(inner);
    } else {
      row.append(inner);
    }
    body.append(row);
    return inner;
  }

  /**
   * Nudge an opened submenu up so it ends on screen.
   *
   * `top:0` aligns a flyout with the row that opened it, which is right until
   * that row is near the bottom of the window -- then a tall list hangs off the
   * screen and its last entries are unreachable, `max-height` or not. Scrolling
   * alone does not fix that: the SCROLL CONTAINER itself has to be on screen.
   *
   * Measured at open time rather than set once, because the answer depends on
   * where the row is and how tall the list is, and both change -- the window
   * resizes and the catalog grows.
   *
   * Runs AFTER `display:block`, since a hidden element measures as zero.
   */
  private fitSubmenu(row: HTMLElement, inner: HTMLElement): void {
    inner.style.top = '0px';
    const rowTop = row.getBoundingClientRect().top;
    const height = inner.getBoundingClientRect().height;
    // How far past the bottom edge it would run, leaving a small margin.
    const overflow = rowTop + height - window.innerHeight + SUBMENU_MARGIN_PX;
    if (overflow <= 0) return;
    // Never past the top of the window: a list taller than the viewport should
    // start at the top and scroll, not be pushed up out of reach.
    inner.style.top = `${-Math.min(overflow, rowTop - SUBMENU_MARGIN_PX)}px`;
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
    // Cleared with the DOM it refers to: every closure in here captures elements
    // that are about to be discarded.
    this.applyCollapsedFns.clear();

    const categories = Object.entries(status.configCategories);
    if (categories.length === 0) {
      this.loadBody.append(disabledRow('no configs found'));
      return;
    }

    // NOTHING IS COLLAPSED BY DEFAULT. An earlier version folded any category
    // that would overflow the screen, which solved the wrong problem: the menu
    // now SCROLLS (see `addSubmenu`), so a long list is browsable as it stands
    // and there is nothing to rescue the user from. Folding is a convenience
    // they reach for, not a state they should have to undo to see their presets.

    for (const [category, names] of categories) {
      // COLLAPSIBLE, because "Core" is now 175 rows. The header was already a
      // separate element, so this is a click handler and a display toggle
      // rather than a restructuring.
      const header = document.createElement('div');
      header.style.cssText =
        'padding:4px 12px;font-size:10px;opacity:0.5;text-transform:uppercase;' +
        'letter-spacing:0.5px;cursor:pointer;user-select:none;';
      this.loadBody.append(header);

      // The rows this header governs, collected so the toggle can hide them
      // without needing a wrapper element -- a wrapper would nest the rows one
      // level deeper than `browserRow` expects and change how hover reads.
      const rows: HTMLElement[] = [];
      const applyCollapsed = () => {
        const collapsed = this.collapsedCategories.has(category);
        // `▸`/`▾` rather than a rotated glyph: the arrow IS the affordance, and
        // it has to read at 10px where a CSS transform on a triangle does not.
        header.textContent = `${collapsed ? '▸' : '▾'} ${category} (${names.length})`;
        for (const row of rows) row.style.display = collapsed ? 'none' : '';
      };
      // Registered so `foldArchive` can re-apply this category's fold without a
      // rebuild. Rebuilt with the subtree, so it never outlives its elements.
      this.applyCollapsedFns.set(category, applyCollapsed);
      header.addEventListener('click', () => {
        if (this.collapsedCategories.has(category)) {
          this.collapsedCategories.delete(category);
        } else {
          this.collapsedCategories.add(category);
          // A collapsed category cannot keep a hover preview alive: the row the
          // cursor was on is about to be `display:none`, which fires no
          // `mouseleave`, so the snapshot would never be restored and the
          // previewed config would stick.
          this.loadPreview.restoreNow();
          this.hoveredConfig = null;
        }
        applyCollapsed();
      });

      for (const name of names) {
        const row: ConfigRow = { category, name };
        const element = this.browserRow(
          name,
          () => {
            // =============================================================
            // TOUCH: A TAP PREVIEWS. CLOSING THE MENU COMMITS.
            // =============================================================
            //
            // Hover-preview has no touch equivalent -- there is no "hover
            // none", so there is nothing to restore ON, and a finger cannot
            // audition a row without also choosing it. Rather than drop the
            // feature on touch, the two gestures are re-split: TAPPING a row
            // previews it (exactly the same `previewConfig` the mouse uses,
            // so it costs no history), and the menu CLOSING is what commits
            // whatever was last tapped.
            //
            // What that gives up is "unhover to restore": once a row has been
            // tapped there is no way back to the original inside the menu.
            // What it costs to recover is ONE undo, because the whole browse
            // produces a single history entry at the commit -- which is the
            // trade the user asked for, and a good one: browsing twenty
            // presets on a phone leaves the stack exactly one deep.
            //
            // Tapping the SAME row twice is a deliberate second gesture on a
            // row already previewed, so it means "yes, this one" and closes.
            if (this.mobile) {
              if (this.pendingTouchPreview === configKey(row)) {
                // Second tap on the row already showing: commit and close.
                // `closeMenus` performs the commit -- see `setOpenMenu`.
                this.closeMenus();
                return;
              }
              this.pendingTouchPreview = configKey(row);
              this.pendingTouchRow = row;
              // The SAME preview command the hover path sends, so this stays
              // off the undo stack while browsing.
              this.opts.send({
                kind: 'previewConfig',
                category,
                name,
                surface: 'load',
              });
              return;
            }

            // Commit: drop the snapshot so closing does not undo this.
            this.loadPreview.commit(configKey(row));
            this.opts.send({ kind: 'loadConfig', category, name });
            this.closeMenus();
          },
          // NO X ON A SHIPPED PRESET. `ConfigStore.remove` refuses anything
          // whose source is the manifest, so the button could only ever lie --
          // and it lied loudly: it closed the menu, opened a confirm dialog
          // promising "this cannot be undone", and then failed into
          // `status.saveError`, which nothing but the Debug section renders. A
          // user pressing it saw a scary prompt followed by silence.
          //
          // Keyed off the CATEGORY because that is all the UI is given:
          // `catalog()` flattens `ConfigEntry.source` away, so `Core` is the
          // only signal that survives to here. `CORE_CATEGORY` is imported
          // rather than written as `'Core'` so the two cannot drift.
          category === CORE_CATEGORY
            ? null
            : () => {
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
        );
        rows.push(element);
        this.loadBody.append(element);
      }

      // AFTER the rows exist, so a category collapsed before a rebuild comes
      // back collapsed. The signature check rebuilds this whole subtree on any
      // catalog change -- a save, a delete -- and without this every such
      // change would silently expand all 175 Core rows again.
      applyCollapsed();
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
   * One browsable row: a name to load, and -- if it can be removed -- an X.
   *
   * THE WHOLE ROW OPENS, not just the text. The click used to sit on the name
   * span, which left the row's own `padding` gutters and the `gap` before the X
   * dead: a strip down each side that showed `cursor:pointer` (it comes from
   * `MENU_ITEM_CSS`, which styles the row) and then did nothing when clicked.
   * The row is what looks clickable, so the row is what listens.
   *
   * That does NOT reintroduce the imgui bug in the file header. There the delete
   * button was drawn ON TOP of a full-width selectable, so the selectable took
   * the click and X loaded the entry instead of deleting it. Here the X is a
   * real child element that receives its own click first and calls
   * `stopPropagation` -- so the row's listener is LOAD-BEARING BUT NEVER REACHED
   * from the X. Removing that `stopPropagation` would resurrect the bug exactly.
   *
   * `onDelete` is `null` for rows that cannot be deleted. See `syncLoadMenu`.
   */
  private browserRow(
    label: string,
    onOpen: () => void,
    onDelete: (() => void) | null,
    onHover: (hovered: boolean) => void,
  ): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText = `${MENU_ITEM_CSS}gap:8px;`;
    row.dataset['row'] = label;
    row.addEventListener('click', onOpen);

    const name = document.createElement('span');
    name.textContent = label;
    // No `min-width`: the row is the hit area now, so padding the name out to a
    // floor only widened the flyout without making anything easier to click.
    name.style.cssText = 'flex:1;';
    row.append(name);

    if (onDelete !== null) {
      const remove = document.createElement('button');
      remove.textContent = '×';
      remove.title = `Delete ${label}`;
      remove.style.cssText = DELETE_BUTTON_CSS;
      remove.addEventListener('click', (ev) => {
        // KEEPS THE X FROM LOADING THE ENTRY. See the note above.
        ev.stopPropagation();
        onDelete();
      });
      row.append(remove);
    }

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

    return row;
  }

  // -- lifecycle ------------------------------------------------------------

  private toggleMenu(title: string): void {
    this.setOpenMenu(this.openMenu === title ? null : title);
  }

  /**
   * Drop any pending hover-close.
   *
   * Called on re-entering a menu, and by `setOpenMenu` so that OPENING one can
   * never be undone a moment later by a timer scheduled against the last one --
   * the same argument `submenuClosers` makes for the flyouts.
   */
  private cancelMenuClose(): void {
    if (this.menuCloseTimer === null) return;
    clearTimeout(this.menuCloseTimer);
    this.menuCloseTimer = null;
  }

  /**
   * Shut `title` shortly, unless the cursor comes back or moves to another menu.
   *
   * GUARDED ON `openMenu` AT FIRE TIME, not at schedule time. Sliding from File
   * to Share fires File's `mouseleave` first and Share's `mouseenter` second, so
   * this timer is always scheduled against a menu that may no longer be the open
   * one by the time it runs. Re-reading the state is what makes the ordering not
   * matter: if something else is open, this closer has been overtaken and does
   * nothing.
   */
  private scheduleMenuClose(title: string): void {
    this.cancelMenuClose();
    this.menuCloseTimer = setTimeout(() => {
      this.menuCloseTimer = null;
      if (this.openMenu === title) this.closeMenus();
    }, SUBMENU_CLOSE_DELAY_MS);
  }

  /**
   * Show the dropdown named `title` and hide the rest. `null` hides them all.
   *
   * Split out of `setOpenMenu` because the touch submenu needs exactly this and
   * nothing else around it: `setOpenMenu(null)` also runs `submenuClosers`,
   * which would shut the sheet it is trying to open. Naming the narrow operation
   * is better than a flag on the broad one -- the caller wanting only half of a
   * method is a sign the half deserves a name.
   */
  /**
   * Whether any submenu sheet is currently showing. Touch only, in practice.
   *
   * Asked of the DOM rather than tracked in a field because the sheets are
   * opened and closed from several places -- the row's own click, the
   * `submenuClosers`, and `setOpenMenu` -- and a mirror field would be one more
   * thing each of them had to remember to update. The query runs on a handful of
   * elements and only on a press that has already passed the cheap tests.
   */
  private openSubmenu(): boolean {
    for (const body of this.root.querySelectorAll<HTMLElement>('[data-submenu-body]')) {
      if (body.style.display === 'block') return true;
    }
    return false;
  }

  private hideMenuBodies(title: string | null): void {
    for (const body of this.root.querySelectorAll<HTMLElement>('[data-menu-body]')) {
      body.style.display = body.dataset['menuBody'] === title ? 'block' : 'none';
    }
  }

  private setOpenMenu(title: string | null): void {
    this.openMenu = title;
    // The BAR's own pending close, for the same reason the submenu closers run
    // below: a click that opens a menu must not be undone by a timer scheduled
    // when the cursor left the previous one. Clicking File, sliding off, and
    // clicking it again inside the grace period is the case this covers.
    this.cancelMenuClose();
    // Cancels any pending delayed close along with hiding them -- see
    // `submenuClosers`. Must run whether opening or closing: a submenu left
    // showing under a dropdown that is now hidden would reappear with it.
    for (const close of this.submenuClosers) close();
    this.hideMenuBodies(title);
    // A closed menu is a closed browse: restore whatever was being previewed,
    // unless a click committed it. The sticky hover is cleared with it -- a
    // menu closed while the cursor sat on a row never receives that row's
    // `mouseleave`, so reopening would otherwise re-preview a stale entry.
    if (title !== 'File') {
      // **TOUCH: CLOSING IS THE COMMIT.** The tap that previewed a row left it
      // applied but unrecorded (`previewConfig` touches no history), so this is
      // where the browse turns into one real load and one undo entry. It runs
      // BEFORE `loadPreview.end()` deliberately -- `end` would restore the
      // snapshot and undo the very config being committed.
      //
      // Cleared before the send, not after: `loadConfig` can rebuild and
      // re-enter, and a pending row left set through that would commit twice.
      const pending = this.pendingTouchRow;
      this.pendingTouchPreview = null;
      this.pendingTouchRow = null;
      if (pending !== null) {
        this.loadPreview.commit(configKey(pending));
        this.opts.send({
          kind: 'loadConfig',
          category: pending.category,
          name: pending.name,
        });
      }

      this.hoveredConfig = null;
      this.loadPreview.end();
      // RE-FOLD THE ARCHIVE as File closes, so the next visit starts folded
      // however the user left it. Done on CLOSE rather than open because
      // `applyCollapsed` runs from `syncLoadMenu`, which only rebuilds when the
      // catalog changes -- folding on open would set the flag with no rebuild to
      // act on it, and the rows would stay visible until the next save.
      // `foldArchive` moves the DOM directly, so it works either way.
      this.foldArchive();
    }
    if (title !== 'History') {
      this.hoveredCheckpoint = null;
      this.checkpointPreview.end();
    }
    if (title === 'File') this.loadPreview.begin();
    if (title === 'History') this.checkpointPreview.begin();
  }

  /**
   * Fold the Archive back up, so the next File > Load starts collapsed.
   *
   * A no-op when it is already folded, which is the common case -- the flag and
   * the DOM are set together, so re-applying is idempotent.
   */
  private foldArchive(): void {
    if (this.collapsedCategories.has(ARCHIVE_CATEGORY)) return;
    this.collapsedCategories.add(ARCHIVE_CATEGORY);
    // The rows are about to be hidden, and `display:none` fires no `mouseleave`
    // -- the same trap the collapse click handler documents. The preview session
    // has already been ended by the caller, so only the sticky hover needs
    // clearing here, or reopening would re-preview a row that is now invisible.
    this.hoveredConfig = null;
    this.applyCollapsedFns.get(ARCHIVE_CATEGORY)?.();
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
    //
    // **SKIPPED ENTIRELY ON TOUCH, and it has to be.** `hoveredConfig` is only
    // ever written by `mouseenter`/`mouseleave`, which a finger does not
    // meaningfully produce -- so on touch it is permanently null, and
    // `sync(null)` means "nothing is hovered, restore the snapshot". That would
    // undo the tap-preview on the very next frame, every frame, and the tapped
    // config would flash and vanish.
    //
    // The touch path drives previews from the tap handler instead
    // (`browserRow`), so there is nothing for the per-frame reconciler to do.
    // The checkpoint list keeps hover on both layouts -- it has no tap-preview,
    // and passing null there is honest rather than destructive, since nothing
    // has been applied.
    if (!this.mobile) this.loadPreview.sync(this.hoveredConfig);
    this.checkpointPreview.sync(this.hoveredCheckpoint);
  }

  dispose(): void {
    // Before the DOM goes: a pending close would otherwise fire against a bar
    // that no longer exists and touch `openMenu` after teardown.
    this.cancelMenuClose();
    for (const close of this.submenuClosers) close();
    // Its element is on `document.body`, NOT inside `root` -- so removing the
    // bar would strand it, and a pending show timer would fire against an
    // anchor that is no longer in the document.
    this.tooltip.dispose();
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
