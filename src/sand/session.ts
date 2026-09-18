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
import { type SandTool, TOOL_CONFIG } from './tool.ts';
import { SLOT_COUNT } from './palette.ts';

export const SESSION_KEY = 'fluoddity.sand.session';

/** One square, as stored. `document` is null for tools and empty squares. */
export interface StoredSlot {
  readonly tool: SandTool;
  readonly name: string;
  /** A v8 config document -- the square's LIVE values, edits included. */
  readonly document: unknown | null;
}

export interface SandSession {
  readonly slots: readonly StoredSlot[];
  readonly selected: number;
  readonly topRowActive: boolean;
  readonly brushSize: number;
  readonly weight: number;
  /** An explicit particle cap, or null to follow World Size. */
  readonly maxParticles: number | null;
}

export const EMPTY_SESSION: SandSession = {
  slots: [],
  selected: 0,
  topRowActive: true,
  brushSize: 2,
  weight: 1,
  maxParticles: null,
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

function asSlot(raw: unknown): StoredSlot {
  if (typeof raw !== 'object' || raw === null) {
    return { tool: TOOL_CONFIG, name: '', document: null };
  }
  const o = raw as Record<string, unknown>;
  const tool = o['tool'];
  return {
    tool:
      tool === 'shove' || tool === 'walls' || tool === 'trails' || tool === TOOL_CONFIG
        ? tool
        : TOOL_CONFIG,
    name: typeof o['name'] === 'string' ? o['name'] : '',
    document: o['document'] ?? null,
  };
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
  return {
    slots,
    selected: Math.max(0, Math.min(SLOT_COUNT - 1, Math.trunc(num('selected', 0)))),
    topRowActive: typeof o['topRowActive'] === 'boolean' ? o['topRowActive'] : true,
    brushSize: Math.trunc(num('brushSize', EMPTY_SESSION.brushSize)),
    weight: num('weight', EMPTY_SESSION.weight),
    maxParticles:
      typeof max === 'number' && Number.isFinite(max) && max >= 1
        ? Math.trunc(max)
        : null,
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
