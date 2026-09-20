/**
 * What a world IS, and the reader/writer for its JSON half.
 *
 * ## A world is three things
 *
 *   palette       which material sits in which slot, as v8 config documents
 *   preferences   world size, physics rate, brightness -- the Preferences window
 *   scene         the initial conditions, as a `.fwld` stamp
 *
 * The first two are JSON and live here. The third is binary and lives in
 * `stampCodec.ts`, which stays the only interpreter of those bytes. A world
 * record holds them side by side rather than nesting the stamp inside the JSON:
 * base64 would inflate a multi-megabyte scene by a third for no benefit, and
 * the two halves are written and read together anyway.
 *
 * ## THE PALETTE IS SLOT-INDEXED, NOT A DENSE LIST
 *
 * Every painted particle stores its swatch's index as `config_index`, and the
 * scene stamp stores those particles verbatim. So a world whose palette was
 * saved densely -- skipping the empty slots -- would renumber every material
 * the moment it was loaded, and every particle in the scene would point at the
 * wrong one.
 *
 * `slots` is therefore a sparse map from slot index to document, and the index
 * is load-bearing. `palette.ts` explains the same constraint for the live
 * array, and this is that constraint surviving a round trip through storage.
 *
 * ## WHICH PREFERENCES TRAVEL, AND WHY NOT ALL OF THEM
 *
 * A world states how the simulation should RUN -- its size, its rate, how
 * bright it is. It does not state how the editor should be ARRANGED: whether
 * the FPS counter is on, which panels are unfolded, whether the user prefers
 * the touch layout. Those are the reader's own settings and a downloaded world
 * has no business changing them.
 *
 * `WORLD_PREFERENCE_KEYS` draws that line. It is a subset of `Preferences` by
 * construction (`satisfies`), so a preference renamed upstream fails to compile
 * here rather than being silently dropped from every world that follows.
 *
 * ## A LEAF
 *
 * Imports only types and the preference key list. No GPU, no DOM, no storage --
 * so the format's tolerances are testable under `node --test`, which is the same
 * argument `persistence.ts` makes for the v8 config format.
 */

import {
  type PreferenceKey,
  type Preferences,
  DEFAULT_PREFERENCES,
  coerce,
  isPreferenceKey,
} from '../prefs/preferences.ts';
import { SLOT_COUNT } from '../sand/palette.ts';

/** The only version this reads or writes. */
export const WORLD_FORMAT_VERSION = 1;

/** Thrown for anything this reader will not accept. */
export class WorldFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorldFormatError';
  }
}

/**
 * The preferences a world carries.
 *
 * ## The line this draws
 *
 * SIMULATION properties, not editor ones. `worldSize` and `canvasAspect` define
 * the shape of the world itself; `physicsSteps` is how fast it runs; the rest
 * decide how it is tonemapped and bloomed on the way to the screen, which is
 * part of how a world LOOKS and therefore part of what its author chose.
 *
 * Deliberately ABSENT, and each for the same reason -- they describe the reader
 * rather than the world:
 *
 *   showFpsCounter, showPhysicsSlider, physicsSliderOpen, advanced*, mobileMode
 *                   how the editor is laid out
 *   calibrated      a fact about the reader's GPU
 *   strongLogging   a research switch
 *   resetOnBehaviorChange, oneClickSelection
 *                   studio interactions the sand modality does not have
 *
 * The drawing preferences (`drawSize`, `drawPower`, the field strengths) are
 * also absent, and that one is a judgement call rather than an obvious
 * exclusion: they are brush settings, and a world is a place rather than a
 * toolbox. A user who has tuned their brush should not have it retuned by
 * opening someone else's world.
 */
export const WORLD_PREFERENCE_KEYS = [
  'worldSize',
  'canvasAspect',
  'physicsSteps',
  'brightness',
  'tonemapSoftness',
  'bloomEnabled',
  'bloomThreshold',
  'bloomIntensity',
  'bloomRadius',
  'fieldOpacity',
  'fieldAlwaysShow',
  'trailsAlwaysShow',
  'showReticle',
] as const satisfies readonly PreferenceKey[];

export type WorldPreferenceKey = (typeof WORLD_PREFERENCE_KEYS)[number];

/** The preference subset a world states. Every key optional -- see `readWorld`. */
export type WorldPreferences = Partial<Pick<Preferences, WorldPreferenceKey>>;

/** One palette slot, as stored. */
export interface WorldSlot {
  /** WHICH SLOT. Load-bearing -- see the header. */
  readonly slot: number;
  /** Display name, for the swatch. */
  readonly name: string;
  /** A v8 config document, exactly as `toDocument` produces. */
  readonly document: unknown;
}

/** A world's JSON half. The scene rides alongside as `.fwld` bytes. */
export interface WorldDocument {
  readonly version: number;
  /** Free-text, shown nowhere yet. Here so a world can describe itself. */
  readonly notes: string;
  readonly slots: readonly WorldSlot[];
  readonly preferences: WorldPreferences;
  /**
   * How many swatches the tray shows for this world.
   *
   * THE WORLD'S PALETTE COUNT OVERRIDES THE DEV SLIDER, which is the requirement:
   * the dev slider governs Custom alone from here on. Stored rather than derived
   * from `slots.length` because a world may deliberately show empty swatches --
   * an author leaving room for the user to add a material is making a choice,
   * and deriving the count would silently overrule it.
   */
  readonly visibleCount: number;
}

/**
 * Build a world document from live state.
 *
 * `slots` is the full palette array; empty entries are DROPPED but the surviving
 * ones keep their index, which is what makes the sparse form safe. See the
 * header.
 */
export function makeWorldDocument(args: {
  slots: readonly { name: string; document: unknown | null }[];
  preferences: Preferences;
  visibleCount: number;
  notes?: string;
}): WorldDocument {
  const slots: WorldSlot[] = [];
  args.slots.forEach((entry, slot) => {
    if (entry.document === null || entry.document === undefined) return;
    slots.push({ slot, name: entry.name, document: entry.document });
  });

  const preferences: Record<string, unknown> = {};
  for (const key of WORLD_PREFERENCE_KEYS) preferences[key] = args.preferences[key];

  return {
    version: WORLD_FORMAT_VERSION,
    notes: args.notes ?? '',
    slots,
    preferences: preferences as WorldPreferences,
    visibleCount: args.visibleCount,
  };
}

/**
 * Parse a world document.
 *
 * ## Tolerant in one direction only
 *
 * A MISSING preference stays missing. The document records what the world
 * ACTUALLY SAYS and nothing more, so a world written before a preference existed
 * is silent about it rather than asserting a default -- and `applyWorldPreferences`
 * then leaves the reader's own value alone. Filling the gap here instead would
 * make every old world quietly reset that preference on load, undoing whatever
 * the user had chosen.
 *
 * That is why this takes no "current preferences" argument: merging is the
 * applier's job, and doing it here would produce a document that claims the
 * reader's settings were the world's.
 *
 * A PRESENT preference of the wrong type is DROPPED, not coerced into
 * nonsense -- `coerce` returns null and the key simply does not appear. A
 * hand-edited `"physicsSteps": "lots"` reaching a uniform lands as NaN and
 * freezes the simulation, which is the same failure `preferences.ts` validates
 * at its own boundary for the same reason.
 *
 * A malformed SLOT is skipped rather than failing the whole world: one bad
 * material should not cost the user the other thirty-nine, matching
 * `readSlotDocument`'s stance on a corrupt session entry.
 */
export function readWorld(data: unknown, where = 'world'): WorldDocument {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new WorldFormatError(`${where}: not a JSON object`);
  }
  const raw = data as Record<string, unknown>;

  const version = raw['version'];
  if (version !== WORLD_FORMAT_VERSION) {
    throw new WorldFormatError(
      `${where}: unrecognized world version ${String(version)}; expected ` +
        `${WORLD_FORMAT_VERSION}`,
    );
  }

  const slots: WorldSlot[] = [];
  const slotsRaw = raw['slots'];
  if (Array.isArray(slotsRaw)) {
    for (const item of slotsRaw) {
      if (typeof item !== 'object' || item === null) continue;
      const o = item as Record<string, unknown>;
      const slot = o['slot'];
      // THE INDEX IS REQUIRED AND IS BOUNDS-CHECKED. A slot past the palette
      // would be dropped by `Palette.set` anyway, but silently -- and the
      // particles pointing at it would then render as the fallback material,
      // which looks like a colour bug rather than a malformed save.
      if (
        typeof slot !== 'number' ||
        !Number.isInteger(slot) ||
        slot < 0 ||
        slot >= SLOT_COUNT
      ) {
        continue;
      }
      if (o['document'] === undefined || o['document'] === null) continue;
      slots.push({
        slot,
        name: typeof o['name'] === 'string' ? o['name'] : '',
        document: o['document'],
      });
    }
  }

  const preferences: Record<string, unknown> = {};
  const prefsRaw = raw['preferences'];
  if (typeof prefsRaw === 'object' && prefsRaw !== null) {
    for (const [key, value] of Object.entries(prefsRaw as Record<string, unknown>)) {
      // Unknown keys are dropped, so a downgrade survives a newer build's world.
      if (!isPreferenceKey(key)) continue;
      if (!isWorldPreferenceKey(key)) continue;
      const coerced = coerce(key, value);
      if (coerced === null) continue;
      preferences[key] = coerced;
    }
  }

  const count = raw['visibleCount'];
  const visibleCount =
    typeof count === 'number' && Number.isFinite(count) ? Math.trunc(count) : 0;

  return {
    version: WORLD_FORMAT_VERSION,
    notes: typeof raw['notes'] === 'string' ? raw['notes'] : '',
    slots,
    preferences: preferences as WorldPreferences,
    visibleCount,
  };
}

/** Whether a preference key is one a world is allowed to state. */
export function isWorldPreferenceKey(key: string): key is WorldPreferenceKey {
  return (WORLD_PREFERENCE_KEYS as readonly string[]).includes(key);
}

/**
 * The reader's preferences with a world's applied over them.
 *
 * ## APPLIED, NOT LOCKED
 *
 * The requirement is explicit: loading a world sets these but does not freeze
 * them, so the physics rate stays draggable afterwards. This produces a new
 * `Preferences` and nothing marks the fields as owned by the world -- the panel
 * behaves exactly as it did before.
 *
 * Anything the world does not state is left as the reader had it, which is what
 * makes an older world a partial statement rather than a full reset. See
 * `readWorld`.
 */
export function applyWorldPreferences(
  current: Preferences,
  world: WorldPreferences,
): Preferences {
  const next: Record<string, unknown> = { ...current };
  for (const key of WORLD_PREFERENCE_KEYS) {
    const value = world[key];
    if (value === undefined) continue;
    const coerced = coerce(key, value);
    if (coerced === null) continue;
    next[key] = coerced;
  }
  return Object.freeze(next as unknown as Preferences);
}

/**
 * The preference values a fresh world should record when none is stated.
 *
 * Exposed so a caller building a world from a partially-configured editor has
 * one place to get the defaults, rather than reaching into `DEFAULT_PREFERENCES`
 * and picking keys by hand.
 */
export function defaultWorldPreferences(): WorldPreferences {
  const out: Record<string, unknown> = {};
  for (const key of WORLD_PREFERENCE_KEYS) out[key] = DEFAULT_PREFERENCES[key];
  return out as WorldPreferences;
}
