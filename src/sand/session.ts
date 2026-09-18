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
import { type SandTool, DEFAULT_TOOL, TOOL_CONFIG, TOOL_LABELS } from './tool.ts';
import { DEFAULT_VISIBLE_COUNT, SLOT_COUNT, clampVisibleCount } from './palette.ts';
import { type ToolStrengths, defaultStrengths } from './brushInput.ts';

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
}

export interface SandSession {
  readonly slots: readonly StoredSlot[];
  readonly selected: number;
  readonly brushSize: number;
  /** Which tool the left rail has armed. */
  readonly tool: SandTool;
  /** Strength per tool -- see `ToolStrengths`. */
  readonly strengths: ToolStrengths;
  /** How many swatches the bar draws. Capacity is fixed; see `palette.ts`. */
  readonly visibleCount: number;
  /** An explicit particle cap, or null to follow World Size. */
  readonly maxParticles: number | null;
  /** Which of the UI comps is active. A dev control -- see `theme.ts`. */
  readonly theme: string;
}

export const EMPTY_SESSION: SandSession = {
  slots: [],
  selected: 0,
  brushSize: 2,
  tool: DEFAULT_TOOL,
  strengths: defaultStrengths(),
  visibleCount: DEFAULT_VISIBLE_COUNT,
  maxParticles: null,
  theme: '',
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
function asSlot(raw: unknown): StoredSlot {
  if (typeof raw !== 'object' || raw === null) return EMPTY_STORED;
  const o = raw as Record<string, unknown>;

  // A pre-rail tool square. Its name is the tool's label, which would be a lie
  // on an empty swatch, so the whole entry is dropped rather than half-kept.
  const tool = o['tool'];
  if (typeof tool === 'string' && tool !== TOOL_CONFIG) return EMPTY_STORED;

  return {
    name: typeof o['name'] === 'string' ? o['name'] : '',
    document: o['document'] ?? null,
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
    brushSize: Math.trunc(num('brushSize', EMPTY_SESSION.brushSize)),
    tool: asTool(o['tool']),
    strengths: asStrengths(o['strengths'], legacyWeight),
    visibleCount: clampVisibleCount(num('visibleCount', DEFAULT_VISIBLE_COUNT)),
    maxParticles:
      typeof max === 'number' && Number.isFinite(max) && max >= 1
        ? Math.trunc(max)
        : null,
    theme: typeof o['theme'] === 'string' ? o['theme'] : '',
  };
}

export function loadSession(
  storage: SessionStorage | null = browserSessionStorage(),
): SandSession {
  if (storage === null) return EMPTY_SESSION;
  try {
    const raw = storage.getItem(SESSION_KEY);
    return raw === null ? EMPTY_SESSION : parseSession(raw);
  } catch {
    return EMPTY_SESSION;
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
