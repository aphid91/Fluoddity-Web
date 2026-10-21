/**
 * Sand's shipped defaults: what a NEW visitor starts with.
 *
 * They live in `sandDefaults.json` beside this file, bundled into the build.
 * The Dev tab's "Export settings" button writes the current settings in the
 * same shape, so the workflow is: tinker, export, drop the file over
 * `src/sand/sandDefaults.json`, commit. Returning visitors keep their own.
 *
 * ## What is in it
 *
 * SETTINGS, not content: every preference, and the session-level choices --
 * look, Custom's swatch count, colour mode, the armed tool, per-tool brush
 * sizes and strengths, the eraser's mode, Max Particles, the compaction
 * switches, whether Reset asks first. NOT the Custom palette or the world
 * buttons: those are content, and ship in the default world pack instead
 * (`worlds/worldPack.ts`).
 *
 * ## Tolerant
 *
 * A hand-edited file is expected. A missing key keeps the built-in default, a
 * key of the wrong type is dropped (and reported), and an unknown key is
 * ignored -- the same rules `preferences.ts` and `session.ts` apply to storage,
 * because they do the parsing.
 *
 * A LEAF over those two modules, testable under `node --test`.
 */

import {
  DEFAULT_PREFERENCES,
  type Preferences,
  coerce,
  isPreferenceKey,
} from '../prefs/preferences.ts';
import { EMPTY_SESSION, type SandSession, parseSession } from './session.ts';
import type { WorldPack } from '../worlds/worldPack.ts';

/** Bumped only if the file's shape changes incompatibly. */
export const SAND_DEFAULTS_VERSION = 1;

/**
 * The target world size when the file does not say. Deliberately small: sand
 * has no first-run calibration, and here the user controls the particle
 * count, so a slow world is one they can see the cause of.
 */
export const FALLBACK_SAND_WORLD_SIZE = 0.15;

/**
 * The session fields the file carries. See the header on why these.
 *
 * Also what the Prefs tab's "Restore preference defaults" puts back, beside
 * the preferences themselves.
 */
export const SESSION_KEYS = [
  'theme',
  'visibleCount',
  'colorMode',
  'brushSizes',
  'tool',
  'strengths',
  'eraseMode',
  'maxParticles',
  'autoCompact',
  'compactionPaused',
  'auditAfterSweep',
  'confirmReset',
] as const satisfies readonly (keyof SandSession)[];

/**
 * THE OTHER HALF OF A SESSION: the fields the default world pack decides for a
 * new visitor (`newVisitorSession`), and so what the World menu's "Reset
 * worlds to defaults" puts back. `selected` and `wallsSelected` point into
 * Custom's palette, so they go with it.
 *
 * The two lists are DISJOINT AND COVER THE SESSION -- `sandDefaults.test.ts`
 * holds them to it -- so the two resets together are a new visitor's start:
 * a private window, less the saved worlds and configs neither touches.
 */
export const WORLD_SESSION_KEYS = [
  'slots',
  'selected',
  'wallsSelected',
  'worldRefs',
  'selectedWorld',
  'worldIcon',
] as const satisfies readonly (keyof SandSession)[];

/**
 * A new visitor's session: the shipped defaults, on the pack's start world
 * with its Custom palette. Without a pack, the defaults alone.
 */
export function newVisitorSession(
  defaults: SandSession,
  pack: Pick<WorldPack, 'customSlots' | 'selectedWorld' | 'customIcon'> | null,
): SandSession {
  if (pack === null) return defaults;
  return {
    ...defaults,
    slots: pack.customSlots,
    selectedWorld: pack.selectedWorld,
    worldIcon: pack.customIcon,
  };
}

/** `current`, with the fields named in `keys` taken from `fresh`. */
export function restoreSessionKeys(
  current: SandSession,
  fresh: SandSession,
  keys: readonly (keyof SandSession)[],
): SandSession {
  const out: Record<string, unknown> = { ...current };
  for (const key of keys) out[key] = fresh[key];
  return out as unknown as SandSession;
}

export interface SandDefaults {
  readonly preferences: Preferences;
  /** A whole session: the file's fields over `EMPTY_SESSION`. */
  readonly session: SandSession;
}

/** Parse the file. Never throws; anything unusable falls back field by field. */
export function readSandDefaults(raw: unknown): SandDefaults {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};

  const preferences: Record<string, unknown> = {
    ...DEFAULT_PREFERENCES,
    worldSize: FALLBACK_SAND_WORLD_SIZE,
  };
  const rejected: string[] = [];
  const prefsRaw = o['preferences'];
  if (typeof prefsRaw === 'object' && prefsRaw !== null) {
    for (const [key, value] of Object.entries(prefsRaw as Record<string, unknown>)) {
      if (!isPreferenceKey(key)) continue;
      const coerced = coerce(key, value);
      if (coerced === null) rejected.push(key);
      else preferences[key] = coerced;
    }
  }
  if (rejected.length > 0) {
    console.warn(`sandDefaults.json: ignoring unusable preferences: ${rejected.join(', ')}`);
  }

  // The session parser is the authority on what a valid session is, so the
  // file's fields go through it rather than being checked twice.
  const sessionRaw = o['session'];
  const picked: Record<string, unknown> = {};
  if (typeof sessionRaw === 'object' && sessionRaw !== null) {
    for (const key of SESSION_KEYS) {
      const value = (sessionRaw as Record<string, unknown>)[key];
      if (value !== undefined) picked[key] = value;
    }
  }
  // A FILE FROM BEFORE SIZES WERE PER TOOL carries one `brushSize`. The parser
  // seeds every tool from it, but only if `brushSizes` is absent -- so the base
  // drops its own rather than letting the defaults outvote the file.
  const base: Record<string, unknown> = { ...EMPTY_SESSION };
  if (typeof sessionRaw === 'object' && sessionRaw !== null && picked['brushSizes'] === undefined) {
    const legacySize = (sessionRaw as Record<string, unknown>)['brushSize'];
    if (legacySize !== undefined) {
      delete base['brushSizes'];
      picked['brushSize'] = legacySize;
    }
  }
  const session = parseSession(JSON.stringify({ ...base, ...picked }));

  return { preferences: Object.freeze(preferences) as unknown as Preferences, session };
}

/** The current settings, as the file's text. */
export function writeSandDefaults(preferences: Preferences, session: SandSession): string {
  const picked: Record<string, unknown> = {};
  for (const key of SESSION_KEYS) picked[key] = session[key];
  return (
    JSON.stringify(
      { version: SAND_DEFAULTS_VERSION, preferences, session: picked },
      null,
      2,
    ) + '\n'
  );
}
