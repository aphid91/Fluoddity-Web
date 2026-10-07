/**
 * What the sand modality remembers between visits.
 *
 * ## What is saved, and why it is saved BY VALUE
 *
 * The palette squares are written as full config DOCUMENTS -- the same shape
 * `toDocument` produces for a file on disk -- not as references to the configs
 * they were loaded from. That is the whole point: a square's settings can be
 * edited on the Config tab after it is loaded, and a reference would restore the
 * file's values and silently discard those edits. Saving the live values makes
 * the palette come back exactly as it was left, edits included.
 *
 * The cost is size: twenty configs at ~400 floats each. That is tens of
 * kilobytes of JSON, comfortably inside a localStorage quota, and it buys a
 * palette that does not lie about its own contents.
 *
 * ## What is NOT saved
 *
 * THE INITIAL CONDITIONS. They are four GPU resources -- the entity buffer, the
 * free list, the canvas and the field -- measured in tens of megabytes at the
 * default world size. localStorage holds a few megabytes of TEXT, so this is not
 * a tuning question but a category error; persisting a scene needs IndexedDB and
 * a deliberate format, which is its own feature. `session.ts` restores the
 * palette and the tools so a scene can be rebuilt quickly, and says so.
 *
 * ## Failure is never fatal
 *
 * Every read is defensive and falls back to a fresh session, matching
 * `preferences.ts`: a corrupt or partial entry, a quota-exceeded write, or a
 * browser denying storage entirely all degrade to "start clean" rather than
 * stopping the app.
 */

import { type SavedConfig, fromDocument, toDocument } from '../config/persistence.ts';
import {
  type EraseMode,
  type SandTool,
  DEFAULT_ERASE_MODE,
  DEFAULT_TOOL,
  TOOL_CONFIG,
  TOOL_LABELS,
  asEraseMode,
} from './tool.ts';
import {
  ASSIGNABLE_WORLDS,
  DEFAULT_VISIBLE_COUNT,
  SLOT_COUNT,
  clampVisibleCount,
} from './palette.ts';
import {
  type SizedTool,
  type ToolSizes,
  type ToolStrengths,
  defaultSizes,
  defaultStrengths,
  isBrushSizeIndex,
} from './brushInput.ts';
import { type SwatchColor, readSwatchColor } from './swatchColor.ts';
import { type ColorMode, DEFAULT_COLOR_MODE, asColorMode } from './colorMode.ts';

export const SESSION_KEY = 'fluoddity.sand.session';

/**
 * One swatch, as stored. `document` is null for an empty swatch.
 *
 * `tool` is retained for backward compatibility ONLY -- see `asSlot`. Swatches
 * are config-only now; a stored one naming a field tool comes from a session
 * written before the tool rail existed and migrates to empty.
 */
export interface StoredSlot {
  readonly name: string;
  /** A v8 config document -- the swatch's LIVE values, edits included. */
  readonly document: unknown | null;
  /**
   * The swatch's render colour, for Color By Swatch.
   *
   * STORED EVEN FOR AN EMPTY SWATCH, unlike the world format's. A session is
   * Custom's working state rather than a published artifact, and an author part
   * way through colouring a palette they have not filled yet would otherwise
   * lose that work on every reload. The world format drops empty slots because
   * its sparse form has no way to express one; this array is dense.
   *
   * Optional, so a session written before colours existed restores with the
   * spaced defaults rather than failing to parse.
   */
  readonly color?: SwatchColor;
}

export interface SandSession {
  readonly slots: readonly StoredSlot[];
  readonly selected: number;
  /** Brush size per tool -- see `ToolSizes`. Stamp has none. */
  readonly brushSizes: ToolSizes;
  /** Which tool the left rail has armed. */
  readonly tool: SandTool;
  /** Strength per tool -- see `ToolStrengths`. */
  readonly strengths: ToolStrengths;
  /** What the eraser takes -- see `EraseMode`. */
  readonly eraseMode: EraseMode;
  /** How many swatches the bar draws. Capacity is fixed; see `palette.ts`. */
  readonly visibleCount: number;
  /** An explicit particle cap, or null to follow World Size. */
  readonly maxParticles: number | null;
  /** Which of the UI comps is active. A dev control -- see `theme.ts`. */
  readonly theme: string;

  /**
   * Which world each button loads, as a `worldRef.ts` string.
   *
   * NULL MEANS "FOLLOW THE PACK": the button loads whatever the default world
   * pack assigns it (`worldPack.ts`), so a visitor picks up new default worlds
   * without doing anything. Only the Dev tab's dropdowns write a non-null
   * value -- a reference, or '' for a button deliberately left empty.
   */
  readonly worldRefs: readonly (string | null)[];

  /**
   * Which world button is active, or `CUSTOM_WORLD` for the editable one.
   *
   * Remembered between sessions per the requirement. Stored as an INDEX rather
   * than a name so that renaming a save does not orphan the selection, and so
   * "which button is lit" stays answerable without consulting the library.
   */
  readonly selectedWorld: number;

  /**
   * THE COMPACTION SWITCHES, which used to be deliberately session-only.
   *
   * ## The argument that was here, and why it lost
   *
   * These three were held back on the grounds that a pause surviving a reload
   * would be "compaction silently off weeks later with no sign why". That is a
   * real failure mode, but it is the wrong trade for a panel whose whole
   * audience is the person authoring the app: the Dev tab is a workbench, and a
   * workbench that resets every visit costs a setup ritual on every reload
   * forever to protect against a confusion that the panel itself displays the
   * answer to. Auto compact in particular was being re-ticked every session.
   *
   * The mitigation is that all three are VISIBLE in the same folder that
   * controls them -- `setCompactionStats` writes them back every frame -- so
   * "why is compaction off" is answered by looking at the switch that says so.
   *
   * `auditAfterSweep` persists with the others despite costing a pipeline stall
   * per sweep. It is the one most likely to be left on and forgotten, and that
   * is precisely the argument for it being visibly ON in the panel rather than
   * quietly reset behind the user's back mid-investigation.
   */
  readonly autoCompact: boolean;
  readonly compactionPaused: boolean;
  readonly auditAfterSweep: boolean;

  /**
   * How the particle camera assigns hue. The Dev tab's dropdown.
   *
   * Persisted like the rest of that tab. A world states its own and overrides
   * this while it is loaded, the same relationship `visibleCount` has -- see
   * `worldFormat.ts`.
   */
  readonly colorMode: ColorMode;
}

/**
 * The index meaning "the Custom world" -- the freely editable one.
 *
 * -1 rather than 5, so the five assignable buttons are 0..4 and the sentinel
 * cannot be confused with a real index by arithmetic that forgets to check.
 */
export const CUSTOM_WORLD = -1;

export const EMPTY_SESSION: SandSession = {
  slots: [],
  selected: 0,
  brushSizes: defaultSizes(),
  tool: DEFAULT_TOOL,
  strengths: defaultStrengths(),
  eraseMode: DEFAULT_ERASE_MODE,
  visibleCount: DEFAULT_VISIBLE_COUNT,
  maxParticles: null,
  theme: '',
  worldRefs: [],
  // CUSTOM for a fresh session. The requirement asks for world 1 by default,
  // and that is a decision for the SHIPPING build -- which will have worlds
  // assigned. In the editor nothing is assigned yet, so defaulting to world 1
  // would open on an empty button.
  selectedWorld: CUSTOM_WORLD,
  // OFF for a fresh install, matching `SandOrchestrator`'s own defaults: a pass
  // that rewrites both pool buffers unsupervised is worth opting into, and the
  // audit costs a stall. Persisted once the user has opted in -- see the type.
  autoCompact: false,
  compactionPaused: false,
  auditAfterSweep: false,
  // The original look, so a fresh install renders as it always did.
  colorMode: DEFAULT_COLOR_MODE,
};

/** The subset of `localStorage` this needs, so tests can supply their own. */
export interface SessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** `localStorage`, or null when the browser denies it (private mode, policy). */
export function browserSessionStorage(): SessionStorage | null {
  try {
    const storage = globalThis.localStorage;
    // Presence is not permission: some browsers expose the object and throw on
    // use. A probe write is the only reliable test.
    const probe = '__fluoddity_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

/** A square's configs as a storable document, or null if it holds none. */
export function slotDocument(
  config: SavedConfig['configs'][number] | null,
  world: SavedConfig['world'] | null,
): unknown | null {
  if (config === null || world === null) return null;
  // The LIVE values, which is what makes an edited square restore as edited.
  return toDocument([config], world);
}

/** Read a stored document back, or null if it is missing or malformed. */
export function readSlotDocument(document: unknown): SavedConfig | null {
  if (document === null || document === undefined) return null;
  try {
    const saved = fromDocument(document, 'session');
    return saved.configs[0] === undefined ? null : saved;
  } catch {
    // A format change or a hand-edited entry. One bad square should not cost
    // the user the other nineteen.
    return null;
  }
}

const EMPTY_STORED: StoredSlot = { name: '', document: null };

/**
 * One stored swatch, migrating the pre-rail shape.
 *
 * ## THE MIGRATION: a swatch that used to hold a field tool becomes empty
 *
 * Before the tool rail, a square could BE Shove, Walls or Trails -- one
 * selection answered both "what does the mouse do" and "what does it paint".
 * Those squares carry `tool: 'walls'` and no document. There is nothing to
 * convert them into: the verb they held now lives in the left rail, and the
 * swatch they occupied is a noun slot with no noun in it.
 *
 * So they come back EMPTY rather than as a config. The alternative -- keeping a
 * tool in a swatch -- would resurrect the two-selectors-armed ambiguity that the
 * split exists to remove, for the sake of a square the user can refill with one
 * right-click.
 */
export function asSlot(raw: unknown): StoredSlot {
  if (typeof raw !== 'object' || raw === null) return EMPTY_STORED;
  const o = raw as Record<string, unknown>;

  // A pre-rail tool square. Its name is the tool's label, which would be a lie
  // on an empty swatch, so the whole entry is dropped rather than half-kept.
  const tool = o['tool'];
  if (typeof tool === 'string' && tool !== TOOL_CONFIG) return EMPTY_STORED;

  // A malformed colour is dropped and the caller substitutes the spaced
  // default -- see `readSwatchColor`.
  const color = readSwatchColor(o['color']);
  return {
    name: typeof o['name'] === 'string' ? o['name'] : '',
    document: o['document'] ?? null,
    ...(color === null ? {} : { color }),
  };
}

/** A stored tool name, or the default if it is absent or unrecognised. */
function asTool(raw: unknown): SandTool {
  return typeof raw === 'string' && raw in TOOL_LABELS ? (raw as SandTool) : DEFAULT_TOOL;
}

/**
 * Stored strengths, filling anything missing from the defaults.
 *
 * A session written before the split carries a single `weight`. It is adopted
 * as the BRUSH's strength and the others start at their defaults -- the old
 * number was tuned against whatever tool the user last touched, and Brush is
 * both the likeliest and the only one where a wrong guess is immediately
 * visible rather than subtly off.
 */
function asStrengths(raw: unknown, legacyWeight: number | null): ToolStrengths {
  const out = defaultStrengths() as Record<SandTool, number>;
  if (legacyWeight !== null) out.brush = legacyWeight;
  if (typeof raw === 'object' && raw !== null) {
    for (const [tool, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!(tool in TOOL_LABELS)) continue;
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        out[tool as SandTool] = value;
      }
    }
  }
  return out;
}

/**
 * Stored brush sizes, filling anything missing.
 *
 * A session written before sizes were per tool carries one `brushSize`. It
 * seeds EVERY tool, unlike the legacy strength: one size was in use for all of
 * them, so each tool picking up where it was is exactly right.
 */
function asSizes(raw: unknown, legacySize: unknown): ToolSizes {
  const out = defaultSizes() as Record<SizedTool, number>;
  if (isBrushSizeIndex(legacySize)) {
    for (const tool of Object.keys(out) as SizedTool[]) out[tool] = legacySize;
  }
  if (typeof raw === 'object' && raw !== null) {
    for (const [tool, value] of Object.entries(raw as Record<string, unknown>)) {
      if (tool in out && isBrushSizeIndex(value)) out[tool as SizedTool] = value;
    }
  }
  return out;
}

/**
 * Parse a stored session, filling anything missing from `EMPTY_SESSION`.
 *
 * UNKNOWN KEYS ARE IGNORED and absent ones defaulted, so a downgrade does not
 * break on a field a newer build wrote -- the same contract `preferences.ts`
 * keeps.
 */
export function parseSession(raw: string): SandSession {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return EMPTY_SESSION;
  }
  if (typeof data !== 'object' || data === null) return EMPTY_SESSION;
  const o = data as Record<string, unknown>;

  const slotsRaw = Array.isArray(o['slots']) ? o['slots'] : [];
  const slots = slotsRaw.slice(0, SLOT_COUNT).map(asSlot);

  const num = (key: string, fallback: number): number => {
    const v = o[key];
    // Non-finite is rejected rather than stored: a NaN brush size is not a
    // visible mistake, it is a control that silently stops working.
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };

  const max = o['maxParticles'];
  // The pre-split single Strength, adopted as the Brush's -- see `asStrengths`.
  const legacy = o['weight'];
  const legacyWeight =
    typeof legacy === 'number' && Number.isFinite(legacy) && legacy > 0 ? legacy : null;

  return {
    slots,
    selected: Math.max(0, Math.min(SLOT_COUNT - 1, Math.trunc(num('selected', 0)))),
    brushSizes: asSizes(o['brushSizes'], o['brushSize']),
    tool: asTool(o['tool']),
    strengths: asStrengths(o['strengths'], legacyWeight),
    eraseMode: asEraseMode(o['eraseMode']),
    visibleCount: clampVisibleCount(num('visibleCount', DEFAULT_VISIBLE_COUNT)),
    maxParticles:
      typeof max === 'number' && Number.isFinite(max) && max >= 1
        ? Math.trunc(max)
        : null,
    theme: typeof o['theme'] === 'string' ? o['theme'] : '',
    // Strings only, and unassigned for anything else -- a stored entry of the
    // wrong type would otherwise reach a dropdown as a value with no matching
    // option, which Tweakpane renders as a blank selection.
    worldRefs: asWorldRefs(o),
    // Clamped to the legal range, treating anything unrecognised as Custom. A
    // stored index past the four buttons would light nothing and leave the
    // panel looking broken.
    selectedWorld: asSelectedWorld(o['selectedWorld']),
    // STRICTLY BOOLEAN, defaulting to off. A truthy non-boolean (`"false"`, 1)
    // is rejected rather than coerced: these three govern a pass that rewrites
    // both pool buffers, and a hand-edited entry should fall back to the safe
    // default rather than being interpreted generously.
    autoCompact: asBool(o['autoCompact'], EMPTY_SESSION.autoCompact),
    compactionPaused: asBool(o['compactionPaused'], EMPTY_SESSION.compactionPaused),
    auditAfterSweep: asBool(o['auditAfterSweep'], EMPTY_SESSION.auditAfterSweep),
    // Anything unrecognised is the original look -- a session from a build with
    // a mode this one does not have should render rather than fail.
    colorMode: asColorMode(o['colorMode']),
  };
}

/**
 * Stored world references, migrating the pre-pack `worlds` array.
 *
 * Before world packs, '' meant "nothing chosen yet" -- there was nothing else
 * a button could do -- so it migrates to null, following the pack. A name is
 * a library world, which a bare string still means.
 */
function asWorldRefs(o: Record<string, unknown>): (string | null)[] {
  const refs = o['worldRefs'];
  if (Array.isArray(refs)) {
    return refs.slice(0, ASSIGNABLE_WORLDS).map((r) => (typeof r === 'string' ? r : null));
  }
  const legacy = o['worlds'];
  if (Array.isArray(legacy)) {
    return legacy
      .slice(0, ASSIGNABLE_WORLDS)
      .map((w) => (typeof w === 'string' && w !== '' ? w : null));
  }
  return [];
}

/** A stored boolean, or the fallback for anything that is not one. */
function asBool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback;
}

/** A stored world selection, or Custom for anything out of range. */
function asSelectedWorld(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return CUSTOM_WORLD;
  const index = Math.trunc(raw);
  if (index < 0) return CUSTOM_WORLD;
  return index < ASSIGNABLE_WORLDS ? index : CUSTOM_WORLD;
}

/** Whether this browser has a stored session -- false for a new visitor. */
export function hasStoredSession(
  storage: SessionStorage | null = browserSessionStorage(),
): boolean {
  if (storage === null) return false;
  try {
    return storage.getItem(SESSION_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * The stored session, or `fallback` for a visitor with none -- the shipped
 * defaults (`sandDefaults.ts`), where the caller has them.
 */
export function loadSession(
  storage: SessionStorage | null = browserSessionStorage(),
  fallback: SandSession = EMPTY_SESSION,
): SandSession {
  if (storage === null) return fallback;
  try {
    const raw = storage.getItem(SESSION_KEY);
    return raw === null ? fallback : parseSession(raw);
  } catch {
    return fallback;
  }
}

export function saveSession(
  session: SandSession,
  storage: SessionStorage | null = browserSessionStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Quota exceeded, most likely -- twenty configs is not small. Losing the
    // session is survivable; taking the app down over it is not.
  }
}
