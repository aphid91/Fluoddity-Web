/**
 * The command and status API: the UI/simulation boundary, made typed.
 *
 * ## What this file is for
 *
 * `ARCHITECTURE.md` invariant 10 says `ui/` imports no simulation module, and on
 * the desktop that is enforced rather than aspirational: `toolbar.py` mirrors
 * `MouseMode` by string VALUE, and `ui.py:384` duck-types to avoid importing
 * `PickResult`. The price is that the boundary is two untyped dicts -- a
 * 29-entry command table (`orchestrator.py:206-244`) and a 30-key status dict
 * (`STATUS_KEYS`, `:518-539`), both keyed by bare strings.
 *
 * **The plan names typing them "the port's job" (Step 7), and this is it.** The
 * boundary stays exactly as narrow as it was; what changes is that a typo is
 * now a compile error instead of a `KeyError` at the moment a menu is opened.
 *
 * ## Why a discriminated union rather than an interface of methods
 *
 * A method-per-command interface would be the idiomatic TypeScript, and it is
 * the wrong shape here for one specific reason: the desktop's UI *holds* the
 * command table and dispatches by name, which is what lets `toolbar.py` build
 * itself from a list without knowing what any button does. A union preserves
 * that -- a UI can construct a `Command` value, pass it around, log it, or defer
 * it -- while the `switch` in `orchestrator.ts` gets exhaustiveness checking
 * that the Python's dict lookup never had.
 *
 * It also makes the ARGUMENTS typed, which the dict never did: `set_mouse_mode`
 * took a string OR a `MouseMode` (`selection_commands.py:162`) precisely because
 * nothing could check it.
 *
 * ## The status contract, and the guarantee that makes it usable
 *
 * `_report_status()` supplies EVERY key, every frame, before the UI builds a
 * single panel -- which is why desktop UI code indexes `self._status['key']`
 * rather than defending itself with `.get(key, fallback)`. A missing key means
 * the Orchestrator forgot one, which is a bug worth hearing about, not something
 * to paper over with a default that silently renders as '-' forever
 * (`orchestrator.py:508-517`; three keys once carried DIFFERENT defaults at
 * different call sites).
 *
 * `Status` below is a total interface with no optional members, so TypeScript
 * enforces that guarantee at the one place the object is built. That is
 * strictly stronger than the tuple of key names it replaces.
 */

import type { PickResult } from '../particleSystem/pick.ts';
import type { Setting } from '../ui/settingsSpec.ts';

/**
 * What the mouse does on the canvas. The active TOOL.
 *
 * Exists because several behaviours all want the left button -- without a mode,
 * every click would select a particle on the way down and paint on the way
 * across.
 *
 *   SELECT  click adopts a particle's rule, right-click undoes.
 *   SHOVE   drag pushes particles away from the cursor, right-drag pulls in.
 *   DRAW    drag paints the strafe field, right-drag erases.
 *
 * SHOVE and DRAW are easy to confuse and worth stating apart: Shove acts on the
 * PARTICLES, directly and only while the button is held. Draw paints the FIELD,
 * which then keeps pushing whatever crosses it until it is erased.
 *
 * THERE IS NO PAN TOOL. Navigation is on the keyboard (WASD/QE) and the scroll
 * wheel, which frees the mouse for tools entirely.
 *
 * **MEMBER ORDER IS THE TOOLBAR ORDER** and the 1/2/3 key order -- the toolbar
 * builds itself from this array, so adding a tool here adds a button. An
 * ordered array rather than an object for the same reason `CAMERA_MODES` is one:
 * the order is the semantics.
 *
 * Note SHOVE and DRAW have no effect until Step 9 builds the strafe field. They
 * are declared now because `MouseMode` is what arbitrates the left button, and
 * a Step 7 that shipped only SELECT would have no arbitration to extend.
 */
export const MOUSE_MODES = ['select', 'shove', 'draw'] as const;
export type MouseMode = (typeof MOUSE_MODES)[number];

/** Look up a mode by its string value, or `null` if unknown. */
export function mouseModeFromValue(value: string): MouseMode | null {
  return (MOUSE_MODES as readonly string[]).includes(value)
    ? (value as MouseMode)
    : null;
}

/**
 * An in-session snapshot of the whole project.
 *
 * Holds a `Project` rather than a bare config list, so restoring one restores
 * the name and selection too. `key` is an opaque id rather than the name, so
 * the hover-preview machinery keeps tracking the right entry even if two
 * checkpoints ever share a name (`clipboard_commands.py:20-33`).
 *
 * The `Project` import is deliberately absent here: a checkpoint crossing to
 * the UI carries only what the UI displays. `orchestrator.ts` holds the real
 * one. See `CheckpointView`.
 */
export interface CheckpointView {
  readonly name: string;
  readonly key: number;
}

/**
 * Every command the UI can issue.
 *
 * The 26 handlers behind `orchestrator.py:206-244`'s 29 entries. Three of the
 * Python's names are aliases (`clipboard_snapshot`/`clipboard_restore` share
 * handlers with `snapshot_configs`/`restore_configs`); those aliases are kept
 * as distinct members below for the reason the Python keeps them -- they are
 * the UI's vocabulary, and a future divergence should not need a UI change.
 *
 * ## What is NOT here yet, and why that is not a gap
 *
 * Save, load, delete and preview (`save_config`, `load_config`,
 * `delete_config`, `preview_config`) all need persistence, which is **Step 9**.
 * They are declared, and `orchestrator.ts` handles them by reporting through
 * `saveError` rather than by pretending to succeed -- so the UI wiring exists
 * and Step 9 fills in the storage behind it. Silently dropping them would leave
 * Step 9 to discover the whole command path is missing.
 */
export type Command =
  // --- simple ---
  | { readonly kind: 'reset' }
  | { readonly kind: 'togglePause' }
  | { readonly kind: 'toggleCameraMode' }
  | { readonly kind: 'resetCamera' }
  | { readonly kind: 'setMouseMode'; readonly mode: MouseMode }
  | { readonly kind: 'undo' }
  | { readonly kind: 'redo' }
  // --- presets (Step 9 replaces the shipped-preset list with the manifest) ---
  | { readonly kind: 'nextPreset' }
  | { readonly kind: 'prevPreset' }
  | { readonly kind: 'loadPreset'; readonly name: string }
  // --- save / load. Step 9 owns the storage behind these. ---
  | { readonly kind: 'saveConfig'; readonly name: string }
  | { readonly kind: 'clearSaveError' }
  // --- config clipboard: in-session checkpoints ---
  | { readonly kind: 'setCheckpoint' }
  | { readonly kind: 'deleteCheckpoint'; readonly key: number }
  | { readonly kind: 'loadCheckpoint'; readonly key: number }
  | { readonly kind: 'loadLatestCheckpoint' }
  | { readonly kind: 'clipboardApply'; readonly key: number }
  | { readonly kind: 'snapshotConfigs' }
  | { readonly kind: 'restoreConfigs' }
  // --- settings ---
  | {
      readonly kind: 'editSetting';
      readonly setting: Setting;
      readonly value: number | boolean;
      /**
       * False when the caller records the step itself, so a compound edit does
       * not leave two entries. `settings_commands.py:21`'s `record=True`.
       */
      readonly record?: boolean;
    }
  | { readonly kind: 'randomizeSeed' }
  | { readonly kind: 'randomizeBehavior' }
  // --- drawing (the field arrives in Step 9; the prefs are live now) ---
  | { readonly kind: 'editDrawPref'; readonly field: string; readonly value: number | boolean }
  | { readonly kind: 'clearStrafeField' };

/** Every `Command`'s `kind`, for exhaustiveness assertions in tests. */
export type CommandKind = Command['kind'];

/**
 * The Orchestrator -> UI data contract. The typed form of `STATUS_KEYS`.
 *
 * TOTAL BY CONSTRUCTION: no member is optional, so the compiler enforces what
 * the desktop enforces by convention and a comment. Rebuilt every frame, before
 * the UI reads it.
 *
 * Everything here is DISPLAY-ONLY and already flattened to primitives or plain
 * records -- the UI owns no simulation truth (invariant 10). `selected` is the
 * one exception and it is deliberate: `PickResult` is a plain readonly value
 * type with no methods and no GPU handles, so passing it is passing data. The
 * desktop duck-types around importing it (`ui.py:384`) only because Python has
 * no way to say "this is just a record".
 */
export interface Status {
  // --- camera / cursor ---
  readonly mouseWorld: readonly [number, number];
  readonly camMode: string;
  readonly camPan: readonly [number, number];
  readonly camZoom: number;
  readonly canvasSize: string;
  readonly windowSize: string;

  // --- simulation ---
  readonly mouseMode: MouseMode;
  readonly paused: boolean;
  readonly preset: string;
  readonly entityCount: number;
  readonly frameCount: number;

  // --- history ---
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel: string;
  readonly historyDepth: number;
  readonly historyCursor: number;

  /**
   * The last clicked entity, or `null` when nothing has been selected.
   *
   * There is deliberately NO `hovered` counterpart. One existed on the desktop,
   * was permanently MISS because nothing ever wrote it, and showed as an
   * always-empty debug row. Reinstating it would mean picking every frame,
   * which is precisely the per-frame cost the on-demand design avoids
   * (`orchestrator.py:158-165`).
   */
  readonly selected: PickResult | null;

  // --- project / configs ---
  /**
   * Shipped presets, grouped into load-menu categories. Step 9 replaces the
   * generated list with the manifest, and adds the user's IndexedDB saves as
   * further categories -- the SHAPE is what Step 9 inherits, so it is
   * `category -> names` now rather than a flat list.
   */
  readonly configCategories: Readonly<Record<string, readonly string[]>>;
  readonly projectName: string;
  readonly selectedConfig: number;
  readonly configCount: number;
  readonly checkpoints: readonly CheckpointView[];

  // --- transient messages ---
  readonly saveError: string;

  /**
   * The three settings sources, as plain records the panel reads by field name.
   *
   * SNAPSHOTS, NOT REFERENCES: the UI never holds live simulation objects. The
   * desktop builds these only when a window that reads them is open, because
   * `asdict` on a `SimulationConfig` deep-copies its 80-float rule tuple every
   * frame (`orchestrator.py:590-604`). The port keeps that optimization for the
   * same reason -- see `Orchestrator.settingsSources`.
   */
  readonly editConfig: Readonly<Record<string, number | boolean>>;
  readonly editWorld: Readonly<Record<string, number | boolean>>;
  readonly editPrefs: Readonly<Record<string, number | boolean>>;
}

/**
 * What a UI needs from the Orchestrator. The whole boundary, in two methods.
 *
 * A UI holds one of these and nothing else -- no `ParticleSystem`, no `Camera`,
 * no `Project`. That is invariant 10 expressed as a type rather than as a
 * convention, and it is what makes Step 10's real interface a swap of the
 * implementation behind `ui/thinPanel.ts` with no change here.
 */
export interface CommandBus {
  /** Issue a command. Synchronous, like the desktop's dict dispatch. */
  dispatch(command: Command): void;
  /** This frame's status. Rebuilt each frame; never held across frames. */
  status(): Status;
}
