/**
 * Camera input: what the user has chosen, and what those choices mean in numbers.
 *
 * Pure -- no DOM beyond `localStorage`, no GPU -- so all of it is testable under
 * `node --test`. `webcamSource.ts` owns the MediaStream and `webcamField.ts` the
 * GPU passes; both read their instructions from a `WebcamSettings`.
 *
 * ## Editor state, not project state
 *
 * Nothing here travels with a config, a share link or a checkpoint. A camera is
 * a property of the machine and the room, not of the piece: a config that
 * carried "follow the camera's edges at gain 3" would mean something different
 * -- or nothing -- for everybody who opened it. So these persist the way the
 * Video and Link tabs do, in their own `localStorage` entry, and the studio and
 * sand keep separate entries for the same reason they keep separate
 * `Preferences` records.
 *
 * **THE CAMERA ITSELF NEVER PERSISTS AS ON.** Only the setup does. Starting a
 * camera raises a permission prompt and lights an indicator, and doing either
 * because a page was reloaded is not something anyone asked for -- so `running`
 * is not a field here at all, and every session starts with the camera off.
 */

/**
 * How the camera picture becomes a vector field.
 *
 * Every mapping produces a VECTOR, because both destinations consume one:
 * `get_walls` adds it to position and `get_can` adds it to the sensed trail.
 *
 * **THE ORDER IS THE SHADER'S NUMBERING** -- `mappingIndex` hands the position to
 * `cameraMap.wgsl`, and a config never stores it (only the name is persisted),
 * so appending is safe and reordering silently swaps two mappings' meanings.
 */
export const CAMERA_MAPPINGS = [
  'gradient',
  'curl',
  'edgesAcross',
  'edgesAlong',
  'motion',
] as const;
export type CameraMapping = (typeof CAMERA_MAPPINGS)[number];

export const CAMERA_MAPPING_LABELS: Record<CameraMapping, string> = {
  gradient: 'Gradient',
  curl: 'Curl (swirl)',
  edgesAcross: 'Edges (across)',
  edgesAlong: 'Edges (along)',
  motion: 'Motion',
};

export const CAMERA_MAPPING_HELP: Record<CameraMapping, string> = {
  gradient:
    'Points up the brightness slope, so particles gather on bright regions ' +
    '(or flee them, with Direction set to Away).',
  curl:
    'Points along the brightness contours, so particles circle bright regions ' +
    'instead of piling into them.',
  edgesAcross:
    'Pushes across the outlines in the picture, hardest where it changes ' +
    'fastest and not at all over flat areas.',
  edgesAlong:
    'Runs along the outlines in the picture, so particles trace them rather ' +
    'than crossing them.',
  motion:
    'Points toward whatever is moving, so a still scene does nothing and a ' +
    'waved hand draws particles in (or scatters them, with Direction set to Away).',
};

/** Which channel of the existing field machinery the camera feeds. */
export const CAMERA_DESTINATIONS = ['walls', 'trails'] as const;
export type CameraDestination = (typeof CAMERA_DESTINATIONS)[number];

export const CAMERA_DESTINATION_LABELS: Record<CameraDestination, string> = {
  walls: 'Walls',
  trails: 'Trails',
};

export const CAMERA_DESTINATION_HELP: Record<CameraDestination, string> = {
  walls:
    'Shoves particles directly, like painted Walls: no rule can resist it.',
  trails:
    'Adds to the trails the particles sense, like painted Trails: each ' +
    "config's rule decides what to do about it.",
};

/** Front (selfie) or back camera, in `getUserMedia`'s own vocabulary. */
export const CAMERA_FACINGS = ['user', 'environment'] as const;
export type CameraFacing = (typeof CAMERA_FACINGS)[number];

export const CAMERA_FACING_LABELS: Record<CameraFacing, string> = {
  user: 'Front',
  environment: 'Back',
};

export const CAMERA_DIRECTIONS = ['toward', 'away'] as const;
export type CameraDirection = (typeof CAMERA_DIRECTIONS)[number];

export const CAMERA_DIRECTION_LABELS: Record<CameraDirection, string> = {
  toward: 'Toward',
  away: 'Away',
};

export interface WebcamSettings {
  readonly mapping: CameraMapping;
  readonly destination: CameraDestination;
  /** 0..MAX_CAMERA_GAIN. Multiplies the destination's base gain. */
  readonly gain: number;
  /** 0..1: how much the picture is smoothed before it is read. */
  readonly blur: number;
  /** Flips every mapping's vector: toward bright/edges/motion, or away. */
  readonly direction: CameraDirection;
  readonly facing: CameraFacing;
  /**
   * Mirror the picture left to right.
   *
   * ONE FLAG, RESET WHEN THE FACING CHANGES (`withFacing`). The front camera is
   * mirrored by default because that is how everyone expects to see themselves
   * -- move your right hand and the particles on the right respond -- and the
   * back camera is not, because it looks AWAY from you and a mirrored world is
   * just wrong. Either can be overridden; the override lasts until the facing
   * changes, which is the moment the default it overrode stops applying.
   */
  readonly mirror: boolean;
  /** Show the field thumbnail in the Camera tab. */
  readonly preview: boolean;
}

export const MAX_CAMERA_GAIN = 8;

export const DEFAULT_WEBCAM_SETTINGS: WebcamSettings = Object.freeze({
  mapping: 'curl',
  destination: 'trails',
  gain: 1,
  blur: 0.3,
  direction: 'toward',
  facing: 'user',
  mirror: true,
  preview: true,
});

/** The mirror default for a facing. See `WebcamSettings.mirror`. */
export function mirrorDefaultFor(facing: CameraFacing): boolean {
  return facing === 'user';
}

/** Switch cameras, putting the mirror back to that camera's default. */
export function withFacing(settings: WebcamSettings, facing: CameraFacing): WebcamSettings {
  if (facing === settings.facing) return settings;
  return Object.freeze({ ...settings, facing, mirror: mirrorDefaultFor(facing) });
}

/** The shader's index for a mapping. See `CAMERA_MAPPINGS`. */
export function mappingIndex(mapping: CameraMapping): number {
  return CAMERA_MAPPINGS.indexOf(mapping);
}

// ---------------------------------------------------------------------------
// Gains
// ---------------------------------------------------------------------------

/**
 * What a camera Gain of 1.0 means on each destination.
 *
 * **TUNED BY EYE, like `TRAILS_FIELD_GAIN`**, and against the same thing: the
 * mapped field is O(1) at its strongest (a normalised edge, a full black-to-white
 * slope across the blur radius), so these say how far a particle sitting on the
 * strongest feature in the picture is pushed per physics sub-step (walls), or how
 * loud that feature is next to the swarm's own trails (trails).
 *
 * Trails sits well ABOVE its painted counterpart (`TRAILS_FIELD_GAIN`, 0.001)
 * because a painted field accumulates stroke on stroke to tens, while the
 * camera's is rebuilt every frame and rarely reaches 1. Walls matches
 * `WALLS_FIELD_GAIN` (0.01): at the default 5 sub-steps the strongest feature
 * moves a particle ~0.05 world units a frame, enough to read as a push without
 * emptying the world in a second. Named and separate for the reason those two
 * are: a retune of one must not silently move the other.
 */
export const CAMERA_WALLS_GAIN = 0.01;
export const CAMERA_TRAILS_GAIN = 0.05;

/**
 * The per-destination strengths the entity update reads.
 *
 * EXACTLY ONE IS NONZERO while the camera runs, and both are zero when it does
 * not -- which is the shader's off switch, so a stopped camera costs the
 * particles nothing (the texture is not even sampled). Same shape as
 * `fieldStrengthsFor`: the one place the gains are applied.
 */
export function cameraStrengths(
  settings: WebcamSettings,
  running: boolean,
): { readonly walls: number; readonly trails: number } {
  if (!running) return { walls: 0, trails: 0 };
  return settings.destination === 'walls'
    ? { walls: settings.gain * CAMERA_WALLS_GAIN, trails: 0 }
    : { walls: 0, trails: settings.gain * CAMERA_TRAILS_GAIN };
}

/**
 * The blur slider in FIELD TEXELS of gaussian sigma.
 *
 * Squared so the bottom of the slider is fine-grained: the useful range for
 * Edges is a texel or two, while Gradient and Motion want a blur wide enough to
 * turn a hand into one basin rather than a ridge of noise, and a linear slider
 * would spend most of its travel on the latter.
 */
export const MAX_BLUR_TEXELS = 16;
export function blurTexels(blur: number): number {
  const b = Math.min(1, Math.max(0, blur));
  return b * b * MAX_BLUR_TEXELS;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export const STUDIO_CAMERA_STORAGE_KEY = 'fluoddity.camera';
export const SAND_CAMERA_STORAGE_KEY = 'fluoddity.sand.camera';
/** Whether the studio's Camera tab is up. Sand's tab always exists. */
export const CAMERA_SHOWN_STORAGE_KEY = 'fluoddity.cameraShown';

type Readable = { getItem(key: string): string | null };
type Writable = { setItem(key: string, value: string): void };

/**
 * Read the saved setup, field by field.
 *
 * NEVER THROWS, and a field of the wrong type or out of range falls back to its
 * default on its own -- the rest of the record survives. A corrupt entry
 * outlives a reload, so an exception here would make the tab permanently
 * unbuildable; and dropping the WHOLE record over one bad field would throw away
 * a setup the user built for no reason they could see.
 */
export function loadWebcamSettings(
  key: string,
  storage: Readable | null = browserStorageOrNull(),
): WebcamSettings {
  if (storage === null) return DEFAULT_WEBCAM_SETTINGS;
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return DEFAULT_WEBCAM_SETTINGS;
  }
  if (raw === null) return DEFAULT_WEBCAM_SETTINGS;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('Could not read the camera settings; using the defaults.');
    return DEFAULT_WEBCAM_SETTINGS;
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_WEBCAM_SETTINGS;
  return sanitizeWebcamSettings(parsed as Record<string, unknown>);
}

/** Coerce an untrusted record to valid settings. See `loadWebcamSettings`. */
export function sanitizeWebcamSettings(record: Record<string, unknown>): WebcamSettings {
  const d = DEFAULT_WEBCAM_SETTINGS;
  const pick = <T extends string>(k: string, allowed: readonly T[], fallback: T): T => {
    const v = record[k];
    return typeof v === 'string' && (allowed as readonly string[]).includes(v)
      ? (v as T)
      : fallback;
  };
  const num = (k: string, lo: number, hi: number, fallback: number): number => {
    const v = record[k];
    return typeof v === 'number' && Number.isFinite(v)
      ? Math.min(hi, Math.max(lo, v))
      : fallback;
  };
  const bool = (k: string, fallback: boolean): boolean => {
    const v = record[k];
    return typeof v === 'boolean' ? v : fallback;
  };

  const facing = pick('facing', CAMERA_FACINGS, d.facing);
  return Object.freeze({
    mapping: pick('mapping', CAMERA_MAPPINGS, d.mapping),
    destination: pick('destination', CAMERA_DESTINATIONS, d.destination),
    gain: num('gain', 0, MAX_CAMERA_GAIN, d.gain),
    blur: num('blur', 0, 1, d.blur),
    direction: pick('direction', CAMERA_DIRECTIONS, d.direction),
    facing,
    // A missing mirror follows the facing it is paired with, not the default
    // facing's -- otherwise a record saved with the back camera and no mirror
    // field would come back mirrored.
    mirror: bool('mirror', mirrorDefaultFor(facing)),
    preview: bool('preview', d.preview),
  });
}

/** Persist the setup. Swallows a storage failure, like `savePreferences`. */
export function saveWebcamSettings(
  settings: WebcamSettings,
  key: string,
  storage: Writable | null = browserStorageOrNull(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(key, JSON.stringify(settings));
  } catch (e) {
    console.warn(`Could not write the camera settings: ${String(e)}`);
  }
}

/**
 * Whether the studio's Camera tab was left showing.
 *
 * FALSE on every failure path, matching `loadExportVideoShown`: an optional tab
 * that cannot prove it was wanted should not appear.
 */
export function loadCameraShown(storage: Readable | null = browserStorageOrNull()): boolean {
  if (storage === null) return false;
  try {
    return storage.getItem(CAMERA_SHOWN_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveCameraShown(
  shown: boolean,
  storage: Writable | null = browserStorageOrNull(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(CAMERA_SHOWN_STORAGE_KEY, String(shown));
  } catch (e) {
    console.warn(`Could not write camera-tab visibility: ${String(e)}`);
  }
}

function browserStorageOrNull(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
