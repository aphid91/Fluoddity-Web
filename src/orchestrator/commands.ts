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

import type { SavedConfig } from '../config/persistence.ts';
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
 * The five drawing preferences, as a closed set.
 *
 * `editDrawPref` carried a bare `string` field through Steps 7-9, which made it
 * **the one command in this file whose payload the compiler could not check** --
 * exactly the failure the header says this boundary exists to eliminate. A typo
 * routed to `withValue`, which returns its receiver unchanged for an unknown
 * field, so the slider moved and nothing happened, silently.
 *
 * Narrowed in Step 10 rather than earlier because Step 10 is the first caller
 * that builds these controls from a table (`ui/sections/drawingSection.ts`) and
 * so the first that could get a name wrong without a human reading the line.
 *
 * These are deliberately NOT registry entries: five widgets in a dedicated
 * section are not the registry's shape, and routing them through it would mean
 * fabricating `Setting` objects to satisfy a signature
 * (`ui/drawing_window.py:4-8`).
 */
export const DRAW_PREF_FIELDS = [
  'drawSize',
  'drawPower',
  'fieldOpacity',
  'fieldAlwaysShow',
  'showReticle',
] as const;
export type DrawPrefField = (typeof DRAW_PREF_FIELDS)[number];

/**
 * The three per-panel Advanced flags, as a closed set.
 *
 * A SEPARATE set from `DRAW_PREF_FIELDS` rather than a widening of it, for the
 * same reason that one was narrowed in the first place: each is a closed list
 * whose members share a meaning, and merging them would produce one list whose
 * members do not. A brush setting and a view mode are not interchangeable, and
 * a command that accepted either could carry `drawSize` where a tier belongs.
 *
 * Both land in the same `Preferences` record through the same `withValue` path;
 * the split is about what the compiler will let a caller say, not about storage.
 */
export const VIEW_PREF_FIELDS = [
  'advancedProject',
  'advancedPreferences',
  'advancedDrawing',
] as const;
export type ViewPrefField = (typeof VIEW_PREF_FIELDS)[number];

/**
 * Which hover-browsing surface a preview command belongs to.
 *
 * **Two surfaces browse config collections by hovering** -- the Load menu and
 * the checkpoint menu -- and both take a snapshot on open so unhovering can put
 * things back. With ONE shared snapshot slot, hovering a checkpoint while the
 * Load menu is also open overwrites the menu's snapshot, and unhovering restores
 * the wrong state. `ui/hover_preview.py:13-19` records that as a bug that
 * actually happened, and the fix there was to give each surface its own session.
 *
 * The desktop's Orchestrator nevertheless still keeps a single `_preview_origin`
 * (`orchestrator.py:198-201`), safe today "only because both surfaces are
 * submenus of the same menu bar". This token is what makes that safety
 * structural rather than incidental: the origin is a `Map` keyed by surface, so
 * two open browsers cannot see each other's snapshot at all.
 *
 * A token rather than two separate commands because `prePreviewProject` has to
 * know WHICH surface a committed load should record against -- with two
 * independent fields it would have to guess.
 */
export const PREVIEW_SURFACES = ['load', 'checkpoint'] as const;
export type PreviewSurface = (typeof PREVIEW_SURFACES)[number];

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
 * ## The storage commands name `(category, name)`, not an entry object
 *
 * `loadConfig`, `deleteConfig` and `previewConfig` take two strings rather than
 * a `ConfigEntry`. The UI holds a `CommandBus` and nothing else, and a
 * `ConfigEntry` would be a STORAGE type crossing into the panel -- it carries a
 * `source` discriminator and a manifest path, neither of which the UI has any
 * business knowing. Two strings are data. `ConfigStore.entry()` resolves them,
 * and an unknown pair reports through `saveError` rather than throwing: a preset
 * deleted in another tab must not crash the one you are in.
 *
 * ## These are asynchronous, and `dispatch` still returns void
 *
 * Storage is async and the bus is not. Handlers start the work, return
 * immediately, and report through `Status` -- which the panel reads every frame
 * anyway. Making `dispatch` async would turn every button click into a promise
 * the caller has to handle, for no gain. See `orchestrator.ts`'s storage cases.
 */
export type Command =
  // --- simple ---
  | { readonly kind: 'reset' }
  | { readonly kind: 'togglePause' }
  | { readonly kind: 'toggleCameraMode' }
  | { readonly kind: 'resetCamera' }
  | { readonly kind: 'setMouseMode'; readonly mode: MouseMode }
  /**
   * Move the highlight to `cohort` directly, without a pick.
   *
   * **RE-AIMS AN EXISTING HIGHLIGHT; IT DOES NOT ADOPT ANYTHING.** The rule a
   * cohort obeys is derived on the GPU (`rule.wgsl`'s `mutate_rule`) and
   * deliberately has no host mirror -- `pick.ts` explains why, and calls a
   * wrongly-adopted rule the worst failure mode available. So this changes what
   * is LIT and nothing else; committing still goes through a real pick.
   *
   * Out-of-range values WRAP rather than clamp, because the stepper's arrows are
   * for cycling and stopping dead at either end would make the last cohort feel
   * like a wall. The Orchestrator wraps, not the UI, so typing and clicking an
   * arrow cannot disagree about what 64 means with 64 cohorts.
   */
  | { readonly kind: 'setHighlightedCohort'; readonly cohort: number }
  /**
   * Move the highlight by `delta` cohorts, wrapping.
   *
   * The RELATIVE form of `setHighlightedCohort`, for the LEFT/RIGHT arrows. A
   * key cannot send the absolute form the stepper buttons do: those read the
   * current value out of their own input field, and a hotkey has no field to
   * read. Resolving the delta against the live highlight in the Orchestrator is
   * the only place that value is authoritative.
   *
   * Inherits the same two refusals as the absolute form -- nothing lit, or
   * highlighting off -- which is what makes the arrows inert rather than
   * surprising when no cohort is selected.
   */
  | { readonly kind: 'stepHighlightedCohort'; readonly delta: number }
  /**
   * Adopt the highlighted cohort's behaviour: the Enter key, and the hint
   * bar's button.
   *
   * **STILL GOES THROUGH A PICK**, because the rule it adopts is 80 floats
   * derived on the GPU and there is no host copy to read. What makes it work
   * without a cursor is the confirmation snap already in `entityPick.wgsl`:
   * every member of the highlighted cohort inside `CONFIRM_SNAP_FRACTION` of
   * the search radius is treated as a direct hit, so a search wide enough to
   * cover the world resolves to a member of that cohort wherever they are.
   *
   * Refused when nothing is lit AND the two-stage highlight is running -- there
   * is no cohort to confirm. With highlighting OFF (one-click selection, or a
   * single-cohort config) it commits the particle nearest the centre, which is
   * what one click would have done anyway.
   */
  | { readonly kind: 'confirmSelection' }
  /**
   * Put out the highlight without adopting anything: the hint bar's Cancel
   * Selection button.
   *
   * **THE AIM-CANCELLING HALF OF RIGHT-CLICK, AND ONLY THAT HALF.** A
   * right-click on the canvas cancels an aim when one is running and undoes
   * otherwise (`applyCanvasInput`); this command is the first branch alone. The
   * button that sends it is only ever on screen while a cohort is lit, so the
   * branch it would have taken is the only one it can mean -- and a button that
   * silently became Undo in some other state would be far worse than one that
   * does nothing there.
   *
   * Refused when nothing is lit, which makes it inert rather than surprising if
   * it is ever dispatched from a state the button does not appear in.
   */
  | { readonly kind: 'cancelSelection' }
  | { readonly kind: 'undo' }
  | { readonly kind: 'redo' }
  // --- presets: the LEFT/RIGHT cycle over the whole catalog ---
  | { readonly kind: 'nextPreset' }
  | { readonly kind: 'prevPreset' }
  | { readonly kind: 'loadPreset'; readonly name: string }
  // --- storage. See the header on why these carry (category, name). ---
  | { readonly kind: 'saveConfig'; readonly name: string }
  | { readonly kind: 'loadConfig'; readonly category: string; readonly name: string }
  | { readonly kind: 'deleteConfig'; readonly category: string; readonly name: string }
  /**
   * Apply a config for hover-preview: settings only, no camera, no history.
   *
   * Browsing forty configs must not leave forty undo entries
   * (`project_commands.py:161-165`), and it must not move the view either.
   */
  | {
      readonly kind: 'previewConfig';
      readonly category: string;
      readonly name: string;
      /** Which browser is hovering. See `PreviewSurface`. */
      readonly surface: PreviewSurface;
    }
  /**
   * Reload the project from wherever it was loaded or last saved.
   *
   * The desktop's Ctrl+R. NO KEY IS BOUND to it here: Step 8's table is
   * Ctrl-free so the browser keeps Ctrl+R for page reload, and picking a bare
   * key for it is a UI decision that belongs with Step 10's real interface. The
   * command exists so the path is built and testable meanwhile.
   */
  | { readonly kind: 'revertConfig' }
  /**
   * Adopt a project that arrived on a share link, mid-session.
   *
   * UNDOABLE, unlike the same project arriving in the URL at startup. The two
   * look alike and are not: at startup there is nothing to lose, so recording
   * history would only offer to "undo" into a default preset the user never
   * saw. Here it REPLACES whatever they were working on, which is exactly the
   * situation undo exists for.
   *
   * Carries a parsed `SavedConfig` rather than the URL text, so the Orchestrator
   * never has to know what a URL is -- decoding belongs to `shareLink.ts` and
   * validation to `persistence.ts`, both of which have run by the time this is
   * dispatched.
   */
  | { readonly kind: 'loadSharedConfig'; readonly saved: SavedConfig; readonly name: string }
  | { readonly kind: 'clearSaveError' }
  // --- config clipboard: in-session checkpoints ---
  | { readonly kind: 'setCheckpoint' }
  | { readonly kind: 'deleteCheckpoint'; readonly key: number }
  | { readonly kind: 'loadCheckpoint'; readonly key: number }
  | { readonly kind: 'loadLatestCheckpoint' }
  | { readonly kind: 'clipboardApply'; readonly key: number }
  | { readonly kind: 'snapshotConfigs'; readonly surface: PreviewSurface }
  | { readonly kind: 'restoreConfigs'; readonly surface: PreviewSurface }
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
  /**
   * Cohorts plus a grid layout, applied and reset as ONE act.
   *
   * Both fields move together for the same reason `randomizeBehavior` moves
   * two: "show me N groups laid out" is a single intent, and sending two
   * `editSetting`s would leave two entries in history for one click. The reset
   * rides along because a new initial-conditions mode is invisible until the
   * simulation restarts.
   */
  | { readonly kind: 'setPopulationLayout'; readonly cohorts: number }
  | { readonly kind: 'randomizeBehavior' }
  // --- drawing (the field arrives in Step 9; the prefs are live now) ---
  | {
      readonly kind: 'editDrawPref';
      /** Closed set, so a typo is a compile error. See `DrawPrefField`. */
      readonly field: DrawPrefField;
      readonly value: number | boolean;
    }
  | { readonly kind: 'clearStrafeField' }
  // --- view mode ------------------------------------------------------------
  // Its own command rather than a case of `editDrawPref`: see `ViewPrefField`.
  // Never recorded in history -- a tier is how you are LOOKING at the project,
  // not a change to it, and an undo that flipped a checkbox back would be
  // answering a question nobody asked.
  | {
      readonly kind: 'editViewPref';
      readonly field: ViewPrefField;
      readonly value: boolean;
    }
  /**
   * Put every editor preference back to its shipped default.
   *
   * **PREFERENCES ONLY.** Saved configs live in IndexedDB and the live project
   * lives in memory; this touches neither, which is what makes it safe to offer
   * as a single menu item beside Reset View. It is the in-app form of clearing
   * `localStorage`'s `fluoddity.preferences`.
   *
   * IT IS ALSO THE ONLY WAY BACK TO THE DEFAULTS once a blob has been stored:
   * `loadPreferences` seeds from `DEFAULT_PREFERENCES`, but a stored record
   * already holds every key, so changing a default never reaches a user who has
   * touched any preference.
   *
   * NOT RECORDED IN HISTORY, for the reason `editViewPref` is not: preferences
   * are how your editor is set up, not a change to the project, and an undo that
   * put your brightness back would be answering a question nobody asked. That
   * absence of an undo is exactly why the UI confirms it -- see `dialogs.ts`.
   */
  | { readonly kind: 'resetPreferences' };

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
  /**
   * Whether the selected config's rule is the all-zero sentinel -- i.e. its
   * behaviour is GENERATED from `mutationSeed` rather than mutated from an
   * authored rule (`entityUpdate.wgsl`).
   *
   * **A boolean, not the rule.** `rule` is excluded from `editConfig` because
   * copying 80 floats every frame is the cost `settingsSources` exists to
   * avoid, and it must stay excluded -- so the UI cannot derive this itself,
   * and asking it to would mean importing a project module (invariant 10).
   *
   * Lives HERE rather than in `settingsSources` because the mutation overlay
   * reads it and the overlay refreshes even while the panel is shut
   * (`panel.ts`), where those payloads are empty.
   */
  readonly ruleIsGenerated: boolean;

  /**
   * The highlighted cohort, or `NO_COHORT` when none is.
   *
   * Drives the context hint under the mutation slider and the cohort stepper in
   * it. Lives HERE rather than in `settingsSources` for the reason
   * `ruleIsGenerated` does: the overlay reads it, and the overlay refreshes even
   * while the panel is shut, where those payloads are empty.
   *
   * ALREADY GATED by `highlightEnabled`, so this is `NO_COHORT` whenever
   * highlighting is off (the `oneClickSelection` preference, or a single-cohort
   * config) as well as when nothing is lit. The UI therefore branches on this
   * one value instead of re-deriving the two exemptions and risking a hint that
   * disagrees with what the clicks actually do.
   */
  readonly highlightedCohort: number;

  /**
   * Whether the two-stage cohort highlight is running at all.
   *
   * SEPARATE FROM `highlightedCohort`, because "nothing is lit yet" and
   * "highlighting is switched off" want different words under the slider: the
   * first promises a cohort selection on the next click, the second promises an
   * immediate adoption. Collapsing them would make the hint lie about what the
   * next click does in one of the two cases.
   *
   * False for the `oneClickSelection` preference and for a single-cohort config
   * alike -- the UI has no business re-deriving those two exemptions, and a
   * second copy of that rule is exactly how a hint drifts from the behaviour it
   * describes.
   */
  readonly highlightEnabled: boolean;

  /**
   * How many cohorts the selected config has, for the stepper's range.
   *
   * The stepper wraps within `0..cohorts-1`, and the UI cannot read this from
   * `editConfig` -- that payload is empty while the panel is shut, which is
   * exactly when the overlay is still on screen.
   */
  readonly cohortCount: number;

  /**
   * A one-shot message for the toast, or empty.
   *
   * ## Why this crosses the boundary as DATA rather than as a call
   *
   * The Orchestrator holds no DOM and reaches no Web API -- the rule
   * `projectDocument` cites for keeping the clipboard out of it applies just as
   * well to a toast, which is an element with a timer. So it states WHAT
   * happened and the panel decides how to say it, exactly as every other field
   * here works.
   *
   * ## Why it is CONSUMED, not merely read
   *
   * This is an EVENT, and `Status` is otherwise a snapshot of levels. A level
   * would re-fire the same toast every frame for as long as it stayed set. The
   * Orchestrator therefore clears it as `status()` builds -- one reader, one
   * showing -- which is the same destructive-read shape `retrievePick` uses and
   * for the same reason.
   *
   * **`status()` IS CALLED MORE THAN ONCE PER FRAME IN SOME PATHS.** The panel
   * calls it, and so do menu items and dialogs through `bus.status()`. Draining
   * on read means whoever calls first gets the notice -- which is fine, because
   * they all funnel into the same `Panel.refresh`, but it is the reason this is
   * documented as one-shot rather than as "the panel's to read".
   */
  readonly notice: string;

  /**
   * Whether adopting a picked rule would change nothing, so clicks decline it.
   *
   * True at mutation scale 0 with an authored rule: every cohort obeys the same
   * rule there, so a selection would reset the simulation and push an undo entry
   * for a picture that did not move. The hint under the slider says so, because
   * a click that is deliberately refused and a click that is broken look
   * identical otherwise.
   */
  readonly selectionIsNoOp: boolean;

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
   * Every config the app can load, grouped into menu categories: the shipped
   * presets from the build-time manifest, plus the user's IndexedDB saves under
   * "Custom". Core first, then alphabetical.
   *
   * The SHAPE predates the storage behind it -- it was written as
   * `category -> names` in Step 7 precisely so that swapping a generated list
   * for real storage would not touch this interface, the panel, or `status()`.
   */
  readonly configCategories: Readonly<Record<string, readonly string[]>>;
  readonly projectName: string;
  readonly selectedConfig: number;
  readonly configCount: number;
  readonly checkpoints: readonly CheckpointView[];
  /**
   * Whether the project has a storage origin to revert to.
   *
   * False until something is loaded or saved -- there is nothing to revert TO
   * before that, which is exactly why Step 8 left the desktop's Ctrl+R unbound.
   */
  readonly canRevert: boolean;
  /**
   * Whether saving is possible at all.
   *
   * False when the browser denied IndexedDB (private browsing, blocked storage).
   * Shipped presets still load in that state, so the app works; only saving does
   * not. Surfaced so the UI can say so BEFORE a user types a name.
   */
  readonly canSave: boolean;

  // --- transient messages ---
  readonly saveError: string;
  /**
   * In-flight storage work, or `''` when idle.
   *
   * Storage is async and `dispatch` returns void, so this is how a load or a
   * save that has not landed yet reports itself. The panel renders it beside
   * `saveError`, which it already reads every frame.
   */
  readonly configBusy: string;

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

  /**
   * The three per-panel Advanced tiers.
   *
   * **Carried separately from `editPrefs`, even though they are preferences.**
   * That payload is EMPTY whenever no panel is open, which is a deliberate
   * optimization (`settingsSources`) and correct for the values a control
   * binds to -- nothing reads them while the panel is shut. These are
   * different: they decide which controls the panel BUILDS, and the panel
   * builds itself before `panelOpen` has been set. Reading them from the
   * payload would construct both panels in Basic on first run regardless of
   * what was saved, and nothing would correct it until the next rebuild.
   *
   * Three named booleans rather than a record, so a typo is a compile error --
   * the same reasoning as `ViewPrefField`.
   */
  readonly advancedProject: boolean;
  readonly advancedPreferences: boolean;
  readonly advancedDrawing: boolean;
}

/**
 * What a UI needs from the Orchestrator. The whole boundary, in three methods.
 *
 * A UI holds one of these and nothing else -- no `ParticleSystem`, no `Camera`,
 * no `Project`. That is invariant 10 expressed as a type rather than as a
 * convention, and it is what made Step 10's real interface very nearly a swap of
 * the implementation behind `ui/thinPanel.ts`.
 *
 * ## What Step 10 DID change here, and why
 *
 * This interface did not change. Two `Command` payloads did, and both were
 * type-narrowing rather than new capability -- no handler gained work, and
 * nothing crossed the boundary that was not already crossing it:
 *
 *   - **`editDrawPref.field`: `string` -> `DrawPrefField`.** It was the one
 *     payload the compiler could not check, which is the failure this file's
 *     header says the boundary exists to eliminate.
 *   - **The three preview commands gained a `surface` token.** One shared
 *     snapshot slot cannot serve two simultaneous hover-browsers; see
 *     `PreviewSurface` for the bug that makes concrete.
 *
 * The alternative to the second was the UI holding two `Project` snapshots
 * itself, which would put simulation state in `ui/` -- a far worse breach of
 * invariant 10 than a token that is a pair of string literals.
 */
export interface CommandBus {
  /** Issue a command. Synchronous, like the desktop's dict dispatch. */
  dispatch(command: Command): void;
  /** This frame's status. Rebuilt each frame; never held across frames. */
  status(): Status;
  /**
   * The live project as a v8 document, on demand. For the share link.
   *
   * A THIRD KIND OF THING, and the two it is not are both instructive:
   *
   *   - **Not a `Status` field.** `Status` is rebuilt EVERY FRAME, and turning
   *     the project into a document means copying an 80-float rule per config
   *     into fresh JSON. `settingsSources()` already goes to some trouble to
   *     skip exactly this class of work when no panel is reading it; adding an
   *     unconditional serialization beside it -- for a value read once per
   *     keystroke -- would undo that for nothing.
   *   - **Not a `Command`.** A command that copied to the clipboard would put
   *     `navigator.clipboard` inside the Orchestrator, which today contains no
   *     DOM or Web API call of any kind. `toggleUi` is a `LocalAction` rather
   *     than a command for the same reason; rule 10 cuts both ways.
   *
   * So it is a PULL, like `status()`, of a value too expensive to push. The UI
   * turns it into a URL and writes the clipboard. The Orchestrator hands over a
   * document and never learns that a clipboard exists.
   *
   * `unknown` rather than a document type, because `persistence.ts` owns what
   * these bytes mean and this is only the thing that carries them.
   */
  projectDocument(): unknown;
}
