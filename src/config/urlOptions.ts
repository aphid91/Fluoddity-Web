/**
 * The URL options a link can carry: which splash to open, what to call the
 * project, and which editor preferences to propose.
 *
 * PURE, in the way `shareLink.ts` is pure -- it takes a query string rather
 * than reading `window.location`, so every case here runs under `node --test`
 * with no browser. `main.ts` is the only place that supplies a real one.
 *
 * ## These values are UNTRUSTED
 *
 * Everything here arrives in a URL someone else can write. That is the whole
 * reason the settings half exists as a PROPOSAL rather than an application:
 * `preferences.ts` already refuses to let a loaded config change your
 * brightness or canvas size, and a query parameter must not be the back door
 * that does what a config file is forbidden to do. So this module's job is to
 * parse and CLAMP; deciding is the dialog's, and applying is the caller's.
 *
 * Two consequences worth stating, because both are easy to undo by accident:
 *
 *   - **Out-of-range values are dropped, not clamped into range.** A link
 *     asking for `worldSize=99` is not a request for the maximum, it is a
 *     malformed request, and silently rewriting it to 4.0 would show the user
 *     a checkbox they never would have agreed to. `settingsSpec.ts` owns the
 *     bounds and is read here rather than restated.
 *   - **`name` is TEXT, never markup.** It is rendered wherever the project
 *     name is rendered, so it is length-capped here and inserted with
 *     `textContent` at the far end.
 *
 * ## Why the settings are a separate type from the rest
 *
 * `?splash` and `?name` take effect unconditionally -- they change what you
 * look at, not how the editor is configured, and neither survives a reload or
 * touches `localStorage`. The five settings DO persist once applied, which is
 * what makes them worth asking about. Keeping them in their own record is what
 * lets `main.ts` apply the first two immediately and hold the third until the
 * user has answered.
 */

import { type Preferences } from '../prefs/preferences.ts';
import { type CameraMode } from '../camera/cameraState.ts';
import { PREFS, settingFor } from '../ui/settingsSpec.ts';

/**
 * How long a `?name` may be.
 *
 * The panel's title and the save dialog both render this, and neither has a
 * sensible answer for a kilobyte of text arriving from a stranger's link. 64
 * is comfortably longer than any shipped preset name and short enough that it
 * cannot push a layout around.
 */
export const MAX_NAME_LENGTH = 64;

/**
 * The prefix `?name` gets when a link is copied without one.
 *
 * Exported because `panel.ts` builds the default from it and the collapse rule
 * below has to recognise what it built -- two places spelling this
 * independently is how `Shared-Shared-Tangle` happens.
 */
export const SHARED_NAME_PREFIX = 'Shared-';

/** The three splash documents a link may force open. */
export const SPLASH_VARIANTS = ['welcome', 'guide', 'controls'] as const;

export type SplashVariant = (typeof SPLASH_VARIANTS)[number];

/**
 * The preferences a link may propose, all optional.
 *
 * `cameraMode` is here and not in `Preferences` because Trail-Map View is not
 * a preference at all -- it is `CameraState.mode`, which resets to
 * `'particles'` on every load. It rides along anyway because to the user it is
 * the same kind of thing: a switch the link is asking to flip. See
 * `describeChanges` for what that costs.
 */
export interface ProposedSettings {
  readonly worldSize?: number;
  readonly canvasAspect?: number;
  readonly brightness?: number;
  readonly tonemapSoftness?: number;
  readonly cameraMode?: CameraMode;
}

/** Everything a URL asked for, after parsing. */
export interface UrlOptions {
  /** Which splash to force, or null for the default first-run behaviour. */
  readonly splash: SplashVariant | null;
  /** What to call the project, or null to leave the name alone. */
  readonly name: string | null;
  /** The proposed preferences. Empty when the link asked for none. */
  readonly settings: ProposedSettings;
}

/**
 * The four numeric settings, and where their bounds come from.
 *
 * READ OFF `settingsSpec.ts` rather than written down again. Those bounds are
 * already the definition of what the user could dial in by hand, and a second
 * copy here would drift the moment a slider's range is retuned -- leaving a
 * link able to propose a value the panel itself refuses to show.
 */
const NUMERIC_FIELDS = [
  'worldSize',
  'canvasAspect',
  'brightness',
  'tonemapSoftness',
] as const satisfies readonly (keyof Preferences)[];

type NumericField = (typeof NUMERIC_FIELDS)[number];

/**
 * A finite number inside its setting's declared bounds, or `null`.
 *
 * `null` covers all three failures deliberately -- absent, unparseable, and
 * out of range -- because the caller does the same thing with each: leave the
 * setting out of the proposal entirely. See the header on why the third is not
 * a clamp.
 */
function boundedNumber(raw: string | null, field: NumericField): number | null {
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;

  // All four are `PREFS` settings; a link cannot propose a project value, which
  // is what share links are for.
  const spec = settingFor(PREFS, field);
  if (spec === null) return null;
  if (value < spec.lo || value > spec.hi) {
    console.warn(
      `Ignoring ?${field}=${raw}: outside the allowed range ` +
        `${String(spec.lo)}..${String(spec.hi)}.`,
    );
    return null;
  }
  return value;
}

/**
 * Read a boolean-ish parameter: `1`/`true`/`on` and `0`/`false`/`off`.
 *
 * Anything else is `null` and the caller leaves the setting alone, which is
 * the same rule the numbers follow. Deliberately NOT presence-based like
 * `?debug`: this one has to express "off" as well as "on", because a link
 * turning the trail map OFF is as reasonable as one turning it on.
 */
function booleanParam(raw: string | null): boolean | null {
  if (raw === null) return null;
  const value = raw.trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'off') return false;
  return null;
}

/**
 * Strip any number of leading `Shared-` prefixes.
 *
 * Someone who opens a shared link and shares it onward would otherwise hand
 * out `Shared-Shared-Tangle`, and the chain grows by one every hop. Collapsing
 * on the way IN means the prefix is applied exactly once no matter how many
 * times a link has been passed around.
 *
 * A loop rather than a single check because a link may already carry a name
 * that was built before this collapse existed.
 */
export function collapseSharedPrefix(name: string): string {
  let out = name;
  while (out.startsWith(SHARED_NAME_PREFIX)) {
    out = out.slice(SHARED_NAME_PREFIX.length);
  }
  return out;
}

/**
 * The default `?name` for a link copied from a project called `current`.
 *
 * `Shared-<name>`, with the prefix collapsed so re-sharing does not stack it.
 * Length-capped like a parsed one, because the cap exists to protect the
 * layout and a name built here lands in exactly the same places.
 */
export function sharedNameFor(current: string): string {
  return `${SHARED_NAME_PREFIX}${collapseSharedPrefix(current)}`.slice(
    0,
    MAX_NAME_LENGTH,
  );
}

/**
 * What the Project Link Settings tab has been asked to put in a link.
 *
 * **BOOLEANS, NOT VALUES, AND THAT IS THE WHOLE DESIGN.** Every entry here
 * means "match what I have open right now", so the tab offers no inputs to get
 * wrong and no second copy of a number to drift from the real one. The values
 * are read off the live state at the moment a link is built (`buildLinkQuery`),
 * which is also what makes the tab's answer stay correct as the user keeps
 * editing after ticking a box.
 *
 * `projectName` is the one exception and the one text field, because there is
 * no "current" to match -- a name for the recipient is genuinely new
 * information. Empty means the default, `Shared-<current>`.
 */
export interface LinkSettings {
  // --- prompted: the recipient is asked before any of these apply ---
  readonly worldSize: boolean;
  readonly canvasAspect: boolean;
  readonly brightness: boolean;
  readonly tonemapSoftness: boolean;
  readonly trailMap: boolean;
  // --- unprompted: these just happen ---
  readonly splash: SplashVariant | null;
  /** Empty for the `Shared-<current>` default. */
  readonly projectName: string;
}

/** Nothing requested: the link a plain `Copy Link` produces. */
export const DEFAULT_LINK_SETTINGS: LinkSettings = Object.freeze({
  worldSize: false,
  canvasAspect: false,
  brightness: false,
  tonemapSoftness: false,
  trailMap: false,
  splash: null,
  projectName: '',
});

/** Where the tab's choices live between sessions. Namespaced like the rest. */
export const LINK_SETTINGS_STORAGE_KEY = 'fluoddity.linkSettings';

/**
 * The live values a link is built against.
 *
 * Passed in rather than read, so this module stays pure and every case below
 * runs under `node --test`.
 */
export interface LinkSource {
  readonly prefs: Preferences;
  readonly cameraMode: CameraMode;
  readonly projectName: string;
}

/**
 * Turn the tab's choices into the query string a share link should carry.
 *
 * **BUILT FROM THE LIVE STATE, NOT FROM STORED NUMBERS.** A ticked box is a
 * standing instruction ("whatever my world size is when I copy"), so the value
 * is read here at copy time. Ticking Brightness, then dragging the slider, then
 * copying produces the NEW brightness -- which is what "match current" means
 * and what a stored value would get wrong.
 *
 * `existing` carries any parameters already in the address bar so they survive,
 * for the reason `buildShareUrl` preserves the query string at all: a link
 * copied from `?nopanel` should still open without a panel. Any parameter this
 * function owns is REPLACED rather than added to, so repeated copies cannot
 * accumulate duplicates.
 */
export function buildLinkQuery(
  settings: LinkSettings,
  source: LinkSource,
  existing = '',
): string {
  const params = new URLSearchParams(existing);

  // Every parameter this function owns is cleared first, so a box the user has
  // just UNTICKED leaves no trace of a previous copy behind.
  for (const key of [...NUMERIC_FIELDS, 'trailmap', 'splash', 'name']) {
    params.delete(key);
  }

  if (settings.worldSize) params.set('worldSize', String(source.prefs.worldSize));
  if (settings.canvasAspect) {
    params.set('canvasAspect', String(source.prefs.canvasAspect));
  }
  if (settings.brightness) params.set('brightness', String(source.prefs.brightness));
  if (settings.tonemapSoftness) {
    params.set('tonemapSoftness', String(source.prefs.tonemapSoftness));
  }
  // BOTH DIRECTIONS. "Match current" means the recipient ends up where the
  // sender is, and that includes matching a trail map that is currently OFF --
  // omitting it when off would silently mean "no opinion" instead.
  if (settings.trailMap) {
    params.set('trailmap', source.cameraMode === 'trail' ? '1' : '0');
  }

  if (settings.splash !== null) params.set('splash', settings.splash);

  // The name always rides along, defaulting to `Shared-<current>` -- which is
  // what `copyShareLink` did before this tab existed, so an untouched field
  // reproduces the old behaviour exactly.
  const name =
    settings.projectName.trim() === ''
      ? sharedNameFor(source.projectName)
      : settings.projectName.trim().slice(0, MAX_NAME_LENGTH);
  params.set('name', name);

  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

/**
 * A location whose query string carries `?name=Shared-<current>`.
 *
 * PURE, and shaped to feed straight into `buildShareUrl` -- it takes and
 * returns the same three-field location that function does, so the two compose
 * without either knowing about `window`.
 *
 * **AN EXISTING `?name` IS REPLACED, NOT APPENDED.** Someone who opened a named
 * link and then copies their own would otherwise emit two `name` parameters,
 * and `URLSearchParams.get` returns the first -- so the stale one would win and
 * the link would be named after whatever the previous sender had open.
 *
 * Every other parameter is preserved, for the reason `buildShareUrl` preserves
 * the query string at all: a link copied from `?nopanel` should still open
 * without a panel. That deliberately includes any settings parameters, so a
 * link that proposed settings passes them on -- the recipient is asked about
 * them by the same dialog the sender saw.
 */
export function withSharedName(
  loc: { readonly origin: string; readonly pathname: string; readonly search: string },
  projectName: string,
): { origin: string; pathname: string; search: string } {
  const params = new URLSearchParams(loc.search);
  params.set('name', sharedNameFor(projectName));
  return {
    origin: loc.origin,
    pathname: loc.pathname,
    search: `?${params.toString()}`,
  };
}

/**
 * Parse every option a URL carries.
 *
 * NEVER THROWS. A malformed parameter is dropped with a warning and the rest
 * of the link still works -- the same rule `loadPreferences` follows, and for
 * the same reason: a link is not a thing the user can debug, so the app has to
 * do something reasonable with a broken one rather than refuse to start.
 */
export function parseUrlOptions(search: string): UrlOptions {
  const params = new URLSearchParams(search);

  const rawSplash = params.get('splash');
  let splash: SplashVariant | null = null;
  if (rawSplash !== null) {
    const candidate = rawSplash.trim().toLowerCase();
    if ((SPLASH_VARIANTS as readonly string[]).includes(candidate)) {
      splash = candidate as SplashVariant;
    } else {
      console.warn(
        `No splash "${rawSplash}". Available: ${SPLASH_VARIANTS.join(', ')}.`,
      );
    }
  }

  // Trimmed, capped, and collapsed. An all-whitespace name is treated as
  // absent rather than as a request for a blank title.
  const rawName = params.get('name');
  const trimmed = rawName === null ? '' : rawName.trim().slice(0, MAX_NAME_LENGTH);
  const name = trimmed === '' ? null : trimmed;

  const settings: {
    -readonly [K in keyof ProposedSettings]: ProposedSettings[K];
  } = {};
  for (const field of NUMERIC_FIELDS) {
    const value = boundedNumber(params.get(field), field);
    if (value !== null) settings[field] = value;
  }

  // `?trailmap=1` rather than reusing `?camera=trail`. The existing parameter
  // sets the mode SILENTLY at startup and predates all of this; keeping them
  // separate is what lets the consent dialog cover one without changing what
  // the other has always done. See `main.ts` for which wins.
  const trailMap = booleanParam(params.get('trailmap'));
  if (trailMap !== null) settings.cameraMode = trailMap ? 'trail' : 'particles';

  return { splash, name, settings };
}

/**
 * The proposed value for one of the four numeric settings.
 *
 * `undefined` for `cameraMode`, which is not a number and not a preference --
 * the caller dispatches a camera toggle for that one instead. Narrowing here
 * rather than at the call site is what keeps `editSetting`'s `value` honestly
 * typed as a number.
 */
export function numericProposal(
  settings: ProposedSettings,
  key: keyof ProposedSettings,
): number | undefined {
  if (key === 'cameraMode') return undefined;
  return settings[key];
}

/**
 * Read the tab's stored choices, falling back to none requested.
 *
 * NEVER THROWS, and drops anything of the wrong type -- `preferences.ts`'s
 * contract, for the same reason: a corrupt entry outlives a reload, so an
 * exception here would make the panel permanently unbuildable until the user
 * cleared site data by hand.
 */
export function loadLinkSettings(
  storage: { getItem(key: string): string | null } | null = browserStorageOrNull(),
): LinkSettings {
  if (storage === null) return DEFAULT_LINK_SETTINGS;
  let raw: string | null;
  try {
    raw = storage.getItem(LINK_SETTINGS_STORAGE_KEY);
  } catch {
    return DEFAULT_LINK_SETTINGS;
  }
  if (raw === null) return DEFAULT_LINK_SETTINGS;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('Could not read the link settings; using the defaults.');
    return DEFAULT_LINK_SETTINGS;
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_LINK_SETTINGS;

  const record = parsed as Record<string, unknown>;
  const bool = (key: keyof LinkSettings): boolean =>
    typeof record[key] === 'boolean' ? (record[key] as boolean) : false;

  const splash = record['splash'];
  const name = record['projectName'];
  return Object.freeze({
    worldSize: bool('worldSize'),
    canvasAspect: bool('canvasAspect'),
    brightness: bool('brightness'),
    tonemapSoftness: bool('tonemapSoftness'),
    trailMap: bool('trailMap'),
    splash:
      typeof splash === 'string' && (SPLASH_VARIANTS as readonly string[]).includes(splash)
        ? (splash as SplashVariant)
        : null,
    projectName:
      typeof name === 'string' ? name.slice(0, MAX_NAME_LENGTH) : '',
  });
}

/** Persist the tab's choices. Swallows a storage failure, like `savePreferences`. */
export function saveLinkSettings(
  settings: LinkSettings,
  storage: { setItem(key: string, value: string): void } | null = browserStorageOrNull(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(LINK_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn(`Could not write the link settings: ${String(e)}`);
  }
}

/** Where the tab's VISIBILITY lives. Separate from its contents, like recording. */
export const LINK_SHOWN_STORAGE_KEY = 'fluoddity.linkSettingsShown';

/**
 * Whether the Project Link Settings tab was left showing.
 *
 * Defaults to FALSE on every failure path, matching `loadExportVideoShown`: an
 * optional tab that cannot prove it was wanted should not appear.
 */
export function loadLinkSettingsShown(
  storage: { getItem(key: string): string | null } | null = browserStorageOrNull(),
): boolean {
  if (storage === null) return false;
  try {
    return storage.getItem(LINK_SHOWN_STORAGE_KEY) === 'true';
  } catch (e) {
    console.warn(`Could not read link-tab visibility (${String(e)}); hiding`);
    return false;
  }
}

/** Store the tab's visibility. Failure is reported, never thrown. */
export function saveLinkSettingsShown(
  shown: boolean,
  storage: { setItem(key: string, value: string): void } | null = browserStorageOrNull(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(LINK_SHOWN_STORAGE_KEY, String(shown));
  } catch (e) {
    console.warn(`Could not write link-tab visibility: ${String(e)}`);
  }
}

/**
 * `localStorage`, or null where there is none.
 *
 * Its own tiny copy rather than an import of `preferences.browserStorage`,
 * because that one's type demands BOTH `getItem` and `setItem` and the two
 * functions above each want only one. Merely TOUCHING `localStorage` can throw
 * in a sandboxed iframe, which is why the access is inside the try.
 */
function browserStorageOrNull(): (Storage & object) | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** True when a link proposed nothing at all. */
export function hasProposedSettings(settings: ProposedSettings): boolean {
  return Object.keys(settings).length > 0;
}

/** One row in the consent dialog: what changes, and from what to what. */
export interface SettingChange {
  /** The `ProposedSettings` key, used to apply the change if accepted. */
  readonly key: keyof ProposedSettings;
  /** The label the dialog shows, from `settingsSpec.ts` where there is one. */
  readonly label: string;
  readonly from: string;
  readonly to: string;
}

/** Format a number the way the settings controls do: short, and not `1`. */
function formatNumber(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, '') || '0';
}

/**
 * Turn a proposal into the rows the dialog should offer.
 *
 * **SETTINGS THAT ALREADY MATCH ARE OMITTED**, which is the rule that keeps
 * the dialog honest: a row reading "Brightness: 1 -> 1" asks the user to
 * approve nothing, and a dialog full of them trains people to click Yes
 * without reading. A link whose every value already matches produces no rows
 * at all, and the caller shows no dialog.
 *
 * `current` is the preferences to compare against. On a first visit that must
 * be the POST-CALIBRATION values, not the defaults -- otherwise the dialog
 * offers to change a world size the ladder is about to overwrite. See the
 * calibration ordering in `main.ts`.
 *
 * `cameraMode` is passed in rather than assumed, even though every load starts
 * in `'particles'`. `?camera=trail` can have already moved it by the time this
 * runs, and a row offering to turn on a view that is already on is exactly the
 * kind of no-op change the omission rule above exists to prevent.
 */
export function describeChanges(
  settings: ProposedSettings,
  current: Preferences,
  cameraMode: CameraMode,
): readonly SettingChange[] {
  const rows: SettingChange[] = [];

  for (const field of NUMERIC_FIELDS) {
    const proposed = settings[field];
    if (proposed === undefined) continue;
    const existing = current[field];
    // Exact equality is right here despite these being floats: both sides
    // came from the same bounded, rounded space -- one parsed from a URL, one
    // written by a slider -- and an epsilon would only hide a change the user
    // could legitimately want to see.
    if (proposed === existing) continue;
    rows.push({
      key: field,
      label: settingFor(PREFS, field)?.label ?? field,
      from: formatNumber(existing),
      to: formatNumber(proposed),
    });
  }

  if (settings.cameraMode !== undefined && settings.cameraMode !== cameraMode) {
    rows.push({
      key: 'cameraMode',
      label: 'Trail Map View',
      // Named for what the user sees rather than for the mode: "Trail Map View:
      // Off -> On" is the switch they recognise, and `'particles' -> 'trail'`
      // describes the implementation instead. `menuBar.ts` made the same call
      // for the same reason.
      from: cameraMode === 'trail' ? 'On' : 'Off',
      to: settings.cameraMode === 'trail' ? 'On' : 'Off',
    });
  }

  return rows;
}
