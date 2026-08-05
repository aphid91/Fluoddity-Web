/**
 * Preferences: editor state that is NOT part of a saved config.
 * The port of `preferences/preferences.py` (131 lines).
 *
 * The three-way split the desktop draws (`preferences.py:1-14`) is the whole
 * point of the file, and it holds here unchanged:
 *
 *   ConfigData   per-particle behaviour. SAVED. Loading someone else's config
 *                should change these -- that IS the config.
 *   WorldData    global simulation properties (trail decay). Saved, for the
 *                same reason: they define how the piece looks.
 *   Preferences  how YOUR editor is set up: brightness, physics rate, canvas
 *                size. NOT saved with a config, because loading a config you
 *                downloaded should not dim your screen or resize your canvas.
 *
 * ## Storage: localStorage, not a file
 *
 * The desktop writes `preferences.json` at the repo root. There is no
 * filesystem here, and the plan (Step 7) names `localStorage` as the
 * replacement. The two differences that follow are both deliberate:
 *
 *   - **Storage may be absent or throw.** Safari in private mode throws from
 *     `localStorage.setItem`, and an embedded context may have no `localStorage`
 *     at all. `load()` NEVER THROWS (the Python's contract) and `save()`
 *     swallows the failure with a console warning, the way the Python swallows
 *     `OSError`. An editor that cannot persist preferences must still run.
 *   - **`load()` is synchronous**, matching the Python, because
 *     `localStorage` is. Step 9's IndexedDB config storage will not be, but
 *     preferences are small and the synchronous API is what keeps startup from
 *     needing an await before the first frame.
 *
 * Unknown keys are DROPPED on load, so a downgrade survives a newer version's
 * file -- `preferences.py:112-113` filters against the known field set for
 * exactly that reason. Keys of the wrong TYPE are dropped too, which the Python
 * does not do: `json.loads` there feeds a dataclass that never validates, so a
 * hand-edited `"physics_steps": "lots"` would reach the GPU as a string. In
 * JavaScript that lands as `NaN` in a uniform and freezes the simulation, so
 * the port validates at the boundary. See `coerce`.
 */

/**
 * Editor preferences. Immutable; edits produce a new object via `withValue`,
 * which is the port of the Python's `dataclasses.replace` on a frozen class.
 */
export interface Preferences {
  // --- live ---
  /**
   * Output brightness multiplier. Applied by the assembler, ONCE, for both
   * camera modes -- so TRAIL and PARTICLES respond to it identically.
   */
  readonly brightness: number;
  /** Physics sub-steps per rendered frame. Higher = faster simulation time. */
  readonly physicsSteps: number;

  // --- display: the frame assembly pipeline ---
  /**
   * Highlight compression for the asinh tone curve. Low is more linear
   * (brighter highlights); high is more logarithmic (reveals faint detail).
   *
   * The desktop enforces no lower bound. `asinh_f32` in `frameAssembly.wgsl`
   * assumes a non-negative argument, so the PACKER clamps this to >= 0 rather
   * than the shader carrying a sign-preserving form.
   */
  readonly tonemapSoftness: number;

  /**
   * Temporal supersampling. TARGET samples per displayed frame -- the achieved
   * count is the nearest one that divides `physicsSteps`, so this is a target
   * rather than a promise. See `camera/blurSchedule.ts`.
   *
   * 1 IS THE OFF SWITCH -- one render per frame is what "no blur" means, so
   * there is no separate enable flag to disagree with it.
   */
  readonly motionBlurSamples: number;

  readonly bloomEnabled: boolean;
  /** Brightness cutoff for bloom extraction. Lower glows more widely. */
  readonly bloomThreshold: number;
  readonly bloomIntensity: number;
  /** Spread of the blur kernel, in source-texel units. */
  readonly bloomRadius: number;

  // --- drawing (the Draw tool; the field itself arrives in Step 9) ---
  /** Airbrush gaussian sigma, in aspect-corrected canvas uv. */
  readonly drawSize: number;
  /**
   * How hard a stroke paints. THE ONLY strength control for drawing: how far
   * the painted field then moves a particle is a fixed constant
   * (`STRAFE_FIELD_GAIN` in `common.wgsl`), so there is no second multiplier
   * interacting with this one.
   */
  readonly drawPower: number;

  /**
   * Opacity of the strafe field overlay. EXACTLY zero is the off switch: the
   * assembler does not sample the field texture at all below it.
   */
  readonly fieldOpacity: number;
  /** When false the field overlay appears only while Draw is the active tool. */
  readonly fieldAlwaysShow: boolean;
  /**
   * The brush reticle. Only ever drawn while a BRUSH tool is active, so this
   * gates it within those tools rather than across all of them.
   */
  readonly showReticle: boolean;

  // --- disruptive: changing these reallocates and resets the simulation ---
  /** Scales entity count and canvas resolution together. */
  readonly worldSize: number;
  /** Canvas width:height. Reshapes world space (see `coords.ts`). */
  readonly canvasAspect: number;

  // --- view mode: which controls each panel shows ---------------------------
  /**
   * Per-panel Basic/Advanced tier.
   *
   * **THREE FLAGS, NOT ONE.** There used to be a single global tier governing
   * every section at once, which meant wanting the advanced brush controls also
   * unfolded every advanced physics slider. Each panel now bifurcates on its
   * own, so the Advanced checkbox at the top of a panel is about that panel and
   * nothing else.
   *
   * These configure the INTERFACE, not the simulation, so they never reach a
   * config, a preset or history -- the same reason the drawing prefs do not.
   * They live here rather than on `Panel` only because they PERSIST: the old
   * global tier reset each session deliberately, but a per-panel choice is a
   * lasting statement about how you work rather than a temporary peek, and
   * re-ticking three boxes every reload is worse than starting where you left
   * off. They still default to Basic for a first-run user.
   *
   * Deliberately NOT `settingsSpec` entries: a registry entry would render them
   * as ordinary rows inside a group, and these have to be the first blade in
   * their panel, above the group they govern. `ui/advancedToggle.ts` builds
   * them.
   */
  readonly advancedProject: boolean;
  readonly advancedPreferences: boolean;
  readonly advancedDrawing: boolean;

  // --- calibration ----------------------------------------------------------
  /**
   * Whether first-run GPU calibration has already run.
   *
   * **THIS IS THE ONLY FIRST-VISIT SIGNAL THE APP HAS.** `load()` seeds from
   * `DEFAULT_PREFERENCES` and overlays whatever `localStorage` held, so "no
   * stored record" and "a stored record" collapse into the same `Preferences`
   * value and are otherwise indistinguishable downstream. A visitor with no
   * record gets the default `false` here; anyone who has calibrated once carries
   * `true` forward and is never probed again.
   *
   * SET EVEN WHEN CALIBRATION FAILS OR IS CUT SHORT. A probe that threw, or a
   * splash the user clicked through after two rungs, still counts as done --
   * otherwise every subsequent load would re-run a calibration that has already
   * shown it cannot finish, and the cost would recur forever.
   *
   * `resetPreferences` adopts `DEFAULT_PREFERENCES` wholesale, so this returns
   * to `false` and the next load re-calibrates. That is deliberate: a reset is
   * exactly when the settings should be re-derived rather than left where a
   * since-changed machine last put them.
   *
   * Deliberately NOT a `settingsSpec` entry, for the reason the three
   * `advanced*` flags above are not: it is bookkeeping, not a control. There is
   * nothing here a user would meaningfully drag.
   */
  readonly calibrated: boolean;
}

/** `preferences.py:35-92`'s dataclass defaults, verbatim. */
export const DEFAULT_PREFERENCES: Preferences = Object.freeze({
  brightness: 1.0,
  physicsSteps: 30,
  tonemapSoftness: 2.5,
  motionBlurSamples: 1,
  bloomEnabled: false,
  bloomThreshold: 0.11,
  bloomIntensity: 0.23,
  bloomRadius: 1.0,
  drawSize: 0.031,
  drawPower: 1.0,
  fieldOpacity: 0.0,
  fieldAlwaysShow: false,
  showReticle: true,
  worldSize: 1.0,
  canvasAspect: 1.0,
  // Basic for a first-run user. Persisted thereafter -- see the interface.
  advancedProject: false,
  advancedPreferences: false,
  advancedDrawing: false,
  // False is what MAKES someone a first-run user -- see the interface.
  calibrated: false,
});

/**
 * The declared type of every preference.
 *
 * THE PLAN ASKS FOR THIS EXPLICITLY (Step 7): "Replace `_coerce`'s runtime
 * dataclass field-type read with an explicit type map." The desktop reads
 * `dataclasses.fields(prefs)` at runtime to learn whether a field is a bool, an
 * int or a float (`drawing_commands.py:119-131`); TypeScript's types are erased,
 * so there is nothing to read at runtime and the map has to be written down.
 *
 * IT EARNS ITS KEEP BEYOND THE PORT. `drawing_commands.py:110` records why the
 * desktop needs it: a blanket `float()` lands `1.0` in the file where `true`
 * belongs. Here it does the same job AND validates what comes back out of
 * `localStorage`, which is untyped JSON that a user can hand-edit.
 *
 * `satisfies` ties it to `Preferences`, so adding a preference without adding
 * its type is a compile error rather than a field that silently stops being
 * coerced.
 */
export const PREFERENCE_KINDS = {
  brightness: 'float',
  physicsSteps: 'int',
  tonemapSoftness: 'float',
  motionBlurSamples: 'int',
  bloomEnabled: 'bool',
  bloomThreshold: 'float',
  bloomIntensity: 'float',
  bloomRadius: 'float',
  drawSize: 'float',
  drawPower: 'float',
  fieldOpacity: 'float',
  fieldAlwaysShow: 'bool',
  showReticle: 'bool',
  worldSize: 'float',
  canvasAspect: 'float',
  advancedProject: 'bool',
  advancedPreferences: 'bool',
  advancedDrawing: 'bool',
  calibrated: 'bool',
} as const satisfies Record<keyof Preferences, 'float' | 'int' | 'bool'>;

export type PreferenceKey = keyof Preferences;

/** Every preference name, for iteration and for filtering unknown keys. */
export const PREFERENCE_KEYS = Object.keys(PREFERENCE_KINDS) as readonly PreferenceKey[];

export function isPreferenceKey(name: string): name is PreferenceKey {
  return Object.prototype.hasOwnProperty.call(PREFERENCE_KINDS, name);
}

/**
 * `value` as whatever type `key` is declared to hold, or `null` if it cannot be.
 *
 * The port of `_coerce` (`drawing_commands.py:119-131`) plus the validation the
 * Python does not do. Returning `null` rather than a fallback is what lets both
 * callers do the right and DIFFERENT thing: `load` drops the key and keeps the
 * default, while `withValue` leaves the preferences untouched.
 *
 * NON-FINITE IS REJECTED. A `NaN` brightness is not a visible mistake -- it
 * propagates through the assembler into a black screen with no error anywhere,
 * the same failure mode `cameraState.setZoom` refuses for the same reason.
 */
export function coerce(key: PreferenceKey, value: unknown): number | boolean | null {
  const kind = PREFERENCE_KINDS[key];
  if (kind === 'bool') {
    return typeof value === 'boolean' ? value : null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return kind === 'int' ? Math.trunc(value) : value;
}

/** Where preferences live. Namespaced so it cannot collide on a shared origin. */
export const STORAGE_KEY = 'fluoddity.preferences';

/**
 * The `localStorage`-shaped slice this module needs.
 *
 * Injectable so `preferences.test.ts` can run under `node --test`, where there
 * is no `localStorage` at all -- and so the "storage throws" path is testable
 * rather than merely asserted.
 */
export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The browser's `localStorage`, or `null` where there is none.
 *
 * MERELY TOUCHING `localStorage` CAN THROW -- a sandboxed iframe raises a
 * SecurityError on property access, before any method is called. Hence the
 * try/catch around the read itself rather than around a later `getItem`.
 */
export function browserStorage(): PreferenceStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Read stored preferences, falling back to the defaults.
 *
 * NEVER THROWS -- the Python's contract (`preferences.py:97-101`), and more
 * important here than there: a corrupt entry in `localStorage` outlives a page
 * reload, so an exception would make the app permanently unstartable until the
 * user cleared site data by hand.
 *
 * Unknown keys are dropped (downgrade survives), and so are values of the wrong
 * type (see `coerce`). Each bad key is reported once rather than silently
 * ignored, because a preference that keeps reverting is otherwise a mystery.
 */
export function loadPreferences(
  storage: PreferenceStorage | null = browserStorage(),
): Preferences {
  if (storage === null) return DEFAULT_PREFERENCES;

  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch (e) {
    console.warn(`Could not read preferences (${String(e)}); using defaults`);
    return DEFAULT_PREFERENCES;
  }
  if (raw === null) return DEFAULT_PREFERENCES;

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.warn(`Could not parse preferences (${String(e)}); using defaults`);
    return DEFAULT_PREFERENCES;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return DEFAULT_PREFERENCES;
  }

  const parsed: Record<string, unknown> = data as Record<string, unknown>;
  const result: Record<string, unknown> = { ...DEFAULT_PREFERENCES };
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (!isPreferenceKey(key)) continue; // a newer version's field; drop it
    const coerced = coerce(key, value);
    if (coerced === null) {
      rejected.push(key);
      continue;
    }
    result[key] = coerced;
  }
  if (rejected.length > 0) {
    console.warn(
      `Ignoring stored preferences with unusable values: ${rejected.join(', ')}`,
    );
  }
  return Object.freeze(result as unknown as Preferences);
}

/**
 * Write preferences. Failure is reported, never thrown.
 *
 * `setItem` throws on a full or disabled store (Safari private mode being the
 * usual case), and losing the ability to PERSIST a preference must not lose the
 * ability to SET one -- the in-memory value has already been adopted by the
 * time this is called.
 */
export function savePreferences(
  prefs: Preferences,
  storage: PreferenceStorage | null = browserStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch (e) {
    console.warn(`Could not write preferences: ${String(e)}`);
  }
}

/**
 * A copy with one field changed, coerced to the field's declared type.
 *
 * Returns the RECEIVER UNCHANGED when the name is unknown, the value is
 * unusable, or the value already equals what is stored. That last case is not
 * an optimization: `_cmd_edit_draw_pref` records why the desktop needs it
 * (`drawing_commands.py:107-110`) -- a slider reports "changed" on frames where
 * the value did not move, and each of those would otherwise be a write. Here
 * the same guard also keeps reference identity meaningful, so a caller can use
 * `next !== prev` to decide whether to save.
 */
export function withValue(
  prefs: Preferences,
  name: string,
  value: unknown,
): Preferences {
  if (!isPreferenceKey(name)) return prefs;
  const coerced = coerce(name, value);
  if (coerced === null) return prefs;
  if (prefs[name] === coerced) return prefs;
  return Object.freeze({ ...prefs, [name]: coerced });
}

/**
 * True if moving to `other` needs the simulation rebuilt.
 *
 * World size and canvas aspect determine the GPU allocation (entity count and
 * canvas resolution), so changing either means building a new `ParticleSystem`
 * rather than adjusting this one. This is why those two controls are typed
 * INPUTs rather than sliders -- dragging would rebuild on every frame of the
 * drag.
 */
export function requiresRestart(prefs: Preferences, other: Preferences): boolean {
  return (
    prefs.worldSize !== other.worldSize || prefs.canvasAspect !== other.canvasAspect
  );
}

/**
 * The display subset the camera and assembler read.
 *
 * Step 5's `DisplayPreferences` was this whole interface's stand-in. Keeping
 * the alias means `assembler.present(...)` and `camera` keep their narrow
 * parameter type -- they have no business reading `worldSize` -- while there is
 * now exactly ONE Preferences object in the app rather than two that can drift.
 */
export type DisplayPreferences = Pick<
  Preferences,
  | 'brightness'
  | 'physicsSteps'
  | 'tonemapSoftness'
  | 'motionBlurSamples'
  | 'bloomEnabled'
  | 'bloomThreshold'
  | 'bloomIntensity'
  | 'bloomRadius'
  | 'fieldOpacity'
>;
